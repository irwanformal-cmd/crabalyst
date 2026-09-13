import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRuntime, collectEvents } from './helpers.js';
import type { Analyst, DataSource } from '../src/intelligence/types.js';

// Deterministic fixture data source: a rising series with one spike.
function fixtureSource(): DataSource {
  return {
    id: 'fixture-series',
    label: 'Fixture series',
    kind: 'test',
    domains: ['test'],
    provides: { kinds: ['timeseries'] },
    async fetch() {
      const rows = Array.from({ length: 60 }, (_, i) => ({ i, value: 100 + i * 0.5 + (i === 45 ? 25 : 0) }));
      return [{
        id: 'fixture-1',
        sourceId: 'fixture-series',
        label: 'fixture metric',
        kind: 'timeseries',
        entity: 'TESTSERIES',
        columns: [
          { key: 'i', label: 'index', type: 'number' },
          { key: 'value', label: 'value', type: 'number' },
        ],
        rows,
        provenance: 'test fixture',
        quality: { completeness: 1 },
      }];
    },
  };
}

async function makeIntelRuntime() {
  const rt = await makeRuntime();
  rt.entityResolvers.register({
    id: 'test-entities',
    domain: 'test',
    resolve: (text) => (/\bTESTSERIES\b/i.test(text) ? [{ id: 'TESTSERIES', label: 'Test Series', kind: 'dataset', domain: 'test', resolverId: 'test-entities', mention: 'TESTSERIES' }] : []),
  });
  rt.dataSources.register(fixtureSource());
  return rt;
}

test('planner selects only matching analysts (workflow isolation)', async () => {
  const rt = await makeIntelRuntime();
  const { QueryUnderstanding } = await import('../src/intelligence/query.js');
  const qu = new QueryUnderstanding({ intents: rt.intentEngine, entities: rt.entityResolvers });

  // Anomaly query → should include anomaly analyst, NOT forecasting.
  const anomalyPlan = rt.planner.plan(qu.understand('cari anomali pada TESTSERIES'));
  assert.ok(anomalyPlan.analystIds.includes('anomaly'), anomalyPlan.analystIds.join(','));
  assert.ok(!anomalyPlan.analystIds.includes('forecasting'), anomalyPlan.analystIds.join(','));
  assert.equal(anomalyPlan.workflow, 'discovery');

  // Forecast query → forecasting analyst present, whale/macro absent.
  const forecastPlan = rt.planner.plan(qu.understand('predict TESTSERIES next week'));
  assert.ok(forecastPlan.analystIds.includes('forecasting'), forecastPlan.analystIds.join(','));
  assert.ok(!forecastPlan.analystIds.includes('comparative'), forecastPlan.analystIds.join(','));
  assert.equal(forecastPlan.workflow, 'forecast');

  // Compare query with two entities → comparison workflow + comparative analyst.
  rt.entityResolvers.register({
    id: 'test-entities-2',
    domain: 'test',
    resolve: (text) => (/\bOTHER\b/i.test(text) ? [{ id: 'OTHER', label: 'Other', kind: 'dataset', domain: 'test', resolverId: 'test-entities-2', mention: 'OTHER' }] : []),
  });
  const cmpPlan = rt.planner.plan(qu.understand('compare TESTSERIES with OTHER'));
  assert.equal(cmpPlan.workflow, 'comparison');
  assert.ok(cmpPlan.analystIds.includes('comparative'), cmpPlan.analystIds.join(','));

  await rt.shutdown();
});

test('plugin analyst registration via module intelligence block', async () => {
  const rt = await makeIntelRuntime();
  const custom: Analyst = {
    id: 'custom-test-analyst',
    name: 'Custom Test Analyst',
    description: 'test',
    supportedIntents: ['analyze'],
    analysisTypes: ['custom-signal'],
    run: () => ({ analystId: 'custom-test-analyst', ok: true, findings: [], evidence: [], headline: 'custom ran' }),
  };
  rt.analystRegistry.register(custom);
  assert.ok(rt.analystRegistry.get('custom-test-analyst'));

  // A query carrying the custom analysis type selects the custom analyst.
  const { QueryUnderstanding } = await import('../src/intelligence/query.js');
  const qu = new QueryUnderstanding({ intents: rt.intentEngine, entities: rt.entityResolvers });
  const q = qu.understand('analyze TESTSERIES');
  q.analysisTypes.push('custom-signal');
  const plan = rt.planner.plan(q);
  assert.ok(plan.analystIds.includes('custom-test-analyst'));
  await rt.shutdown();
});

test('engine produces a structured AnalysisResult end-to-end (offline)', async () => {
  const rt = await makeIntelRuntime();
  const events = collectEvents(rt);

  const result = await rt.analyze('trend analysis TESTSERIES', {});
  assert.equal(result.subject, 'TESTSERIES');
  assert.equal(result.status, 'success');
  assert.ok(result.findings.length > 0, 'expected findings');
  assert.ok(result.evidence.length > 0, 'expected evidence');
  assert.ok(result.decision, 'expected a decision');
  assert.notEqual(result.decision?.classification, 'insufficient-evidence');
  assert.ok(result.visualizations.length > 0, 'expected visualizations');
  assert.ok(result.visualizations.some((v) => v.type === 'line'), JSON.stringify(result.visualizations.map((v) => v.type)));
  assert.ok(result.evidenceGraph && result.evidenceGraph.nodes.length > 0);
  assert.ok(result.executionTrace.length > 0);

  // Structured events streamed.
  const types = events.map((e) => e.type);
  assert.ok(types.includes('analysis_start'));
  assert.ok(types.includes('analysis_step'));
  assert.ok(types.includes('analysis_result'));

  // Persisted.
  const stored = await rt.repository.getAnalysis(result.id);
  assert.ok(stored);
  assert.equal(stored?.id, result.id);
  const listed = await rt.repository.listAnalyses();
  assert.ok(listed.some((a) => a.id === result.id));

  await rt.shutdown();
});

test('insufficient evidence yields an honest status, not fabricated confidence', async () => {
  const rt = await makeRuntime(); // no fixture source registered
  const result = await rt.analyze('analyze ZZZUNKNOWN', {});
  assert.equal(result.status, 'insufficient-evidence');
  assert.equal(result.decision?.classification, 'insufficient-evidence');
  assert.equal(result.decision?.confidence, undefined);
  await rt.shutdown();
});

test('follow-up detection: "why?" refers to the last analysis', async () => {
  const rt = await makeIntelRuntime();
  const res = await rt.analyze('trend analysis TESTSERIES', {});
  const follow = rt.intelligence.detectFollowUp('why?', res.id ? undefined : undefined);
  // Without session id there is no memory.
  assert.equal(follow, undefined);
  const withSession = await rt.analyze('trend analysis TESTSERIES', { sessionId: 's-follow' });
  const follow2 = rt.intelligence.detectFollowUp('why?', 's-follow');
  assert.ok(follow2);
  assert.equal(follow2.result.id, withSession.id);
  await rt.shutdown();
});

test('intervention without subject inherits the session context', async () => {
  const rt = await makeIntelRuntime();
  // First analysis establishes the subject.
  const first = await rt.analyze('trend analysis TESTSERIES', { sessionId: 'sess-ctx' });
  assert.equal(first.subject, 'TESTSERIES');
  // Intervention-style query with no subject inherits it.
  const second = await rt.analyze('fokus ke anomali saja', { sessionId: 'sess-ctx' });
  assert.equal(second.subject, 'TESTSERIES');
  assert.equal(second.status, 'success');
  assert.notEqual(second.decision?.classification, 'insufficient-evidence');
  // A different session does NOT inherit.
  const third = await rt.analyze('fokus ke anomali saja', { sessionId: 'sess-other' });
  assert.notEqual(third.subject, 'TESTSERIES');
  await rt.shutdown();
});
