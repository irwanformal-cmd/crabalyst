/* Universal Analysis Engine — workspace controller.
 * Consumes structured AnalysisResult over WebSocket; no raw LLM text parsing.
 */
(function () {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  let ws = null; // assigned by connect()

  const $ = (id) => document.getElementById(id);
  const els = {
    status: $('status'),
    prompt: $('prompt'),
    send: $('send'),
    subject: $('active-subject'),
    conclusion: $('conclusion-body'),
    liveChart: $('live-chart'),
    liveSymbol: $('live-symbol'),
    news: $('news-list'),
    history: $('history-list'),
    canvasEmpty: $('canvas-empty'),
    canvasViz: $('canvas-viz'),
    canvasSub: $('canvas-sub'),
    evidenceGraph: $('evidence-graph'),
    evidenceDetail: $('evidence-detail'),
    evidenceSub: $('evidence-sub'),
    movers: $('movers-list'),
    moversSub: $('movers-sub'),
    analysts: $('analyst-cards'),
    activityToggle: $('activity-toggle'),
    activityLog: $('activity-log'),
    verdictTitle: $('verdict-title'),
    verdictBody: $('verdict-body'),
    chatLog: $('chat-log'),
  };

  const liveChart = new window.CandleChart(els.liveChart);
  // The office scene must never take the app down with it.
  let office;
  try {
    office = new window.AnalystOffice(els.analysts);
  } catch (err) {
    console.error('analyst office failed to init', err);
    office = { upsert() {}, clear() {}, idleAll() {}, setRegistry() {}, setStep() {}, setPlan() {}, celebrate() {}, destroy() {}, intervene() {}, whaleAlert() {} };
  }
  // Whale radar: real Binance trades as particles (guarded like the office).
  let radar;
  try {
    radar = new window.WhaleRadar($('whale-radar'), $('trade-tape'), $('radar-mock'));
  } catch (err) {
    console.error('whale radar failed to init', err);
    radar = { ingest() {}, destroy() {} };
  }
  let currentSessionId;
  let radarSymbol = '';
  let currentChartRange = '24h'; // mirrored with the tf buttons + gateway
  let currentAnalysis = null;
  let vizInstances = [];
  let evidenceInstance = null;
  let activitySteps = [];

  // ------------------------------------------------------------------
  // helpers
  // ------------------------------------------------------------------
  function esc(s) {
    return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }
  function pct(x) { return x === undefined || x === null ? '—' : `${Math.round(x * 100)}%`; }
  function timeAgo(iso) {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return '';
    const mins = Math.max(0, Math.round((Date.now() - t) / 60000));
    if (mins < 1) return 'baru saja';
    if (mins < 60) return `${mins}m lalu`;
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return `${hrs}j lalu`;
    return `${Math.round(hrs / 24)}h lalu`;
  }

  function chatMsg(text, cls) {
    const div = document.createElement('div');
    div.className = `msg ${cls || ''}`;
    div.textContent = text;
    els.chatLog.appendChild(div);
    els.chatLog.scrollTop = els.chatLog.scrollHeight;
  }

  // ------------------------------------------------------------------
  // analysis lifecycle
  // ------------------------------------------------------------------
  function startAnalysis(query) {
    currentAnalysis = null;
    activitySteps = [];
    els.activityLog.innerHTML = '';
    // New run: staff stays employed — selected analysts get re-activated.
    office.idleAll();
    els.send.disabled = true;
    els.canvasSub.textContent = `analyzing: ${query.raw}`;
  }

  function logStep(step) {
    const idx = activitySteps.findIndex((s) => s.id === step.id);
    if (idx >= 0) activitySteps[idx] = step;
    else activitySteps.push(step);
    const div = document.createElement('div');
    div.className = `step ${step.status}`;
    const mark = { done: '✓', failed: '✗', running: '…', pending: '·', skipped: '—' }[step.status] || '·';
    div.textContent = `${mark} ${step.label}${step.detail ? ` — ${step.detail}` : ''}${step.durationMs !== undefined ? ` (${step.durationMs}ms)` : ''}`;
    // Replace previous line for the same step id.
    const existing = els.activityLog.querySelector(`[data-step="${step.id}"]`);
    div.dataset.step = step.id;
    if (existing) existing.replaceWith(div);
    else els.activityLog.appendChild(div);
    els.activityLog.scrollTop = els.activityLog.scrollHeight;
  }

  function upsertAnalystCard(analystId, status, headline, confidence, evidenceCount, durationMs, evidenceLabels) {
    office.upsert({ id: analystId, status, headline, confidence, evidenceCount, durationMs, evidenceLabels });
  }

  // ------------------------------------------------------------------
  // full AnalysisResult rendering
  // ------------------------------------------------------------------
  function renderAnalysis(result) {
    currentAnalysis = result;
    els.send.disabled = false;
    els.canvasEmpty.classList.add('hidden');
    els.canvasSub.textContent = `${result.query.raw} · ${result.status}`;
    els.subject.textContent = result.subjectLabel ? `${result.subjectLabel} (${result.subject})` : '';
    els.subject.classList.toggle('hidden', !result.subjectLabel);

    renderCanvas(result);
    renderVerdict(result);
    renderIntelligence(result);
    renderEvidenceGraph(result);
    renderAnalystCards(result);
    renderConclusion(result);
    refreshHistory(result.id);
  }

  function renderCanvas(result) {
    for (const v of vizInstances) v.destroy();
    vizInstances = [];
    els.canvasViz.innerHTML = '';

    if (!result.visualizations.length) {
      els.canvasViz.innerHTML = '<p class="dim" style="padding:12px">No visualization available for this dataset.</p>';
      return;
    }

    for (const spec of result.visualizations) {
      const card = document.createElement('div');
      card.className = 'viz-card';
      const head = document.createElement('div');
      head.className = 'viz-title';
      head.innerHTML = `<span>${esc(spec.title)}</span><span class="viz-type">${esc(spec.type)}</span>`;
      const body = document.createElement('div');
      body.className = 'viz-body' + (spec.type === 'candlestick' || spec.type === 'network' ? ' tall' : '');
      card.appendChild(head);
      card.appendChild(body);
      els.canvasViz.appendChild(card);

      // DOM-rendered types.
      if (spec.type === 'kpi') {
        body.classList.add('short');
        const row = document.createElement('div');
        row.className = 'kpi-row';
        for (const item of (spec.data.items || [])) {
          const chip = document.createElement('div');
          chip.className = 'kpi-chip' + (item.evidenceId ? ' clickable' : '');
          chip.innerHTML = `<div class="kpi-label">${esc(item.label)}</div><div class="kpi-value">${esc(item.value)}</div>`;
          if (item.evidenceId) {
            chip.title = 'show evidence';
            chip.onclick = () => showEvidenceById(item.evidenceId);
          }
          row.appendChild(chip);
        }
        body.appendChild(row);
        continue;
      }

      // Inject levels + forecast overlays into the primary time chart.
      if ((spec.type === 'candlestick' || spec.type === 'line' || spec.type === 'area') && result.importantLevels.length && !spec.data.levels) {
        spec.data.levels = result.importantLevels.map((l) => ({ value: l.value, label: l.label, kind: l.kind }));
      }

      try {
        vizInstances.push(window.Viz.render(body, spec, {
          onSelect: (item) => {
            if (item && item.id) showEvidenceById(item.id);
          },
        }));
      } catch (err) {
        body.innerHTML = `<p class="dim" style="padding:10px">renderer error: ${esc(err.message)}</p>`;
      }
    }

    // Forecast overlay as its own chart when present.
    if (result.forecast && result.forecast.points.length) {
      const card = document.createElement('div');
      card.className = 'viz-card';
      const head = document.createElement('div');
      head.className = 'viz-title';
      head.innerHTML = `<span>Forecast (${esc(result.forecast.method)}) · ${esc(result.forecast.horizon)}</span><span class="viz-type">forecast</span>`;
      const body = document.createElement('div');
      body.className = 'viz-body';
      card.appendChild(head);
      card.appendChild(body);
      els.canvasViz.appendChild(card);
      const pts = result.forecast.points;
      const spec = {
        id: 'forecast-viz',
        type: 'line',
        title: 'forecast',
        xType: typeof pts[0].x === 'number' && pts[0].x > 1e12 ? 'time' : 'number',
        data: {
          series: [
            { id: 'mid', label: 'forecast', color: '#d2a8ff', points: pts.map((p) => [Number(p.x), p.y]) },
            { id: 'upper', label: 'upper', color: '#3a3f4d', points: pts.filter((p) => p.upper !== undefined).map((p) => [Number(p.x), p.upper]) },
            { id: 'lower', label: 'lower', color: '#3a3f4d', points: pts.filter((p) => p.lower !== undefined).map((p) => [Number(p.x), p.lower]) },
          ],
        },
      };
      try {
        vizInstances.push(window.Viz.render(body, spec, {}));
      } catch { /* renderer guard */ }
    }
  }

  function renderVerdict(result) {
    const d = result.decision;
    if (!d) {
      els.verdictBody.innerHTML = '<p class="dim">no decision for this analysis</p>';
      return;
    }
    els.verdictTitle.textContent = result.domain === 'crypto' || result.domain === 'finance' ? 'Market Verdict' : 'Decision';
    const confRows = [
      ['Confidence', d.confidence !== undefined ? pct(d.confidence) : '—'],
      ['Evidence strength', d.breakdown.evidenceStrength],
      ['Data quality', d.breakdown.dataQuality],
    ];
    if (d.breakdown.model !== undefined) confRows.push(['Model confidence', pct(d.breakdown.model)]);
    els.verdictBody.innerHTML = `
      <div class="verdict-class ${esc(d.classification)}">${esc(d.classification)}</div>
      <div class="verdict-decision">${esc(d.decision)}</div>
      ${d.confidence !== undefined ? `<div class="confidence-bar"><div style="width:${Math.round(d.confidence * 100)}%"></div></div>` : ''}
      ${confRows.map(([k, v]) => `<div class="conf-row"><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('')}
      ${d.rationale.length ? `<h4 style="margin:8px 0 2px;font-size:10px;color:var(--purple);text-transform:uppercase">Rationale</h4><ul>${d.rationale.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}
      ${d.recommendations.length ? `<h4 style="margin:8px 0 2px;font-size:10px;color:var(--purple);text-transform:uppercase">Recommendations</h4><ul>${d.recommendations.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}
      ${d.invalidation.length ? `<h4 style="margin:8px 0 2px;font-size:10px;color:var(--purple);text-transform:uppercase">Invalidation</h4><ul>${d.invalidation.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}`;
  }

  function renderIntelligence(result) {
    const sec = (id, title, html) => {
      const el = $(id);
      el.innerHTML = html ? `<h4>${esc(title)}</h4>${html}` : '';
    };

    // Primary finding.
    const primary = result.findings[0];
    sec('intel-primary', 'Primary finding', primary
      ? `<div class="finding" data-finding="${primary.id}">${esc(primary.title)}${primary.confidence !== undefined ? ` <span class="f-conf">${pct(primary.confidence)}</span>` : ''}</div>`
      : '');

    // Patterns / findings.
    const rest = result.findings.slice(1);
    sec('intel-patterns', 'Findings', rest.length
      ? rest.map((f) => `<div class="finding" data-finding="${f.id}">${esc(f.title)}${f.detail ? `<div class="f-detail">${esc(f.detail)}</div>` : ''}</div>`).join('')
      : '');

    // Anomalies.
    sec('intel-anomalies', result.anomalies.length ? `Anomalies (${result.anomalies.length})` : '', result.anomalies.length
      ? result.anomalies.map((a) => `<span class="anomaly-chip ${a.severity}" data-anomaly="${a.id}" title="${esc(a.metric)}: ${a.value} vs baseline ${a.baseline} (${a.deviation}σ)">${esc(a.metric)} ${a.deviation}σ</span>`).join('')
      : '');

    // Relationships.
    sec('intel-relationships', 'Relationships', result.relationships.length
      ? result.relationships.slice(0, 6).map((r) => `<div class="finding">${esc(r.a)} ${r.kind === 'correlation' ? '⟷' : '→'} ${esc(r.b)}${r.strength !== undefined ? ` <span class="f-conf">${r.strength}</span>` : ''}</div>`).join('')
      : '');

    // Forecast.
    sec('intel-forecast', 'Forecast', result.forecast
      ? `<div class="forecast-note">${esc(result.forecast.method)} · horizon ${esc(result.forecast.horizon)}${result.forecast.confidence !== undefined ? ` · ${pct(result.forecast.confidence)}` : ''}</div>${result.forecast.notes.map((n) => `<div class="forecast-note">· ${esc(n)}</div>`).join('')}`
      : '');

    // Important levels.
    sec('intel-levels', 'Important levels', result.importantLevels.length
      ? result.importantLevels.map((l) => `<div class="level-row" data-level="${l.id}" title="${esc(l.reason || '')}"><span>${esc(l.label)}</span><b>${esc(l.value)}</b><span class="lvl-kind">${esc(l.kind)}</span></div>`).join('')
      : '');

    // Regimes.
    sec('intel-regimes', 'Regime', result.regimes.length
      ? `<div class="regime-grid">${result.regimes.map((r) => `<div class="regime"><b>${esc(r.dimension)}</b>${esc(r.state)}${r.value !== undefined ? ` (${r.value})` : ''}</div>`).join('')}</div>`
      : '');

    // Multi-period matrix.
    if (result.multiPeriod) {
      const mp = result.multiPeriod;
      const arrow = { up: '↑', down: '↓', flat: '→', na: '·' };
      const rows = mp.dimensions.map((dim, di) =>
        `<tr><th>${esc(dim)}</th>${mp.periods.map((_, pi) => {
          const cell = mp.cells[di]?.[pi] ?? { state: 'na' };
          return `<td class="cell-${cell.state}" title="${cell.value !== undefined ? cell.value : ''}">${arrow[cell.state] ?? '·'}</td>`;
        }).join('')}</tr>`,
      ).join('');
      sec('intel-matrix', 'Multi-period', `<table class="matrix"><tr><th></th>${mp.periods.map((p) => `<th>${esc(p)}</th>`).join('')}</tr>${rows}</table>${mp.confluence !== undefined ? `<div class="confluence">confluence ${pct(mp.confluence)}</div>` : ''}`);
    } else {
      sec('intel-matrix', '', '');
    }

    // Uncertainty / assumptions / limitations.
    const notes = [...result.uncertainty, ...result.assumptions, ...result.limitations];
    sec('intel-uncertainty', 'Uncertainty & limitations', notes.length
      ? notes.map((n) => `<div class="forecast-note">· ${esc(n)}</div>`).join('')
      : '');

    // Finding click → linked evidence.
    els.verdictBody.querySelectorAll('.finding');
    document.querySelectorAll('#intel-body .finding[data-finding]').forEach((el) => {
      el.addEventListener('click', () => {
        const f = result.findings.find((x) => x.id === el.dataset.finding);
        if (f) showFindingEvidence(result, f);
      });
    });
  }

  function renderEvidenceGraph(result) {
    if (evidenceInstance) evidenceInstance.destroy();
    evidenceInstance = null;
    els.evidenceDetail.innerHTML = '<p class="dim">click a node…</p>';
    if (!result.evidenceGraph || !result.evidenceGraph.nodes.length) {
      els.evidenceSub.textContent = 'none';
      return;
    }
    els.evidenceSub.textContent = `${result.evidenceGraph.nodes.length} nodes · ${result.evidenceGraph.edges.length} edges`;
    evidenceInstance = window.EvidenceGraph.render(els.evidenceGraph, result.evidenceGraph, {
      onSelect: (node) => {
        els.evidenceDetail.innerHTML = `
          <h4>${esc(node.kind)}</h4>
          <div>${esc(node.label)}</div>
          ${node.detail ? `<div class="kv">${esc(node.detail)}</div>` : ''}`;
      },
    });
  }

  // -- Market movers (24h bubbles) + ticker tape ------------------------------
  function renderTicker(movers) {
    const track = $('ticker-track');
    if (!track || !movers.length) return;
    track.innerHTML = '';
    const build = (hidden) => {
      const frag = document.createDocumentFragment();
      for (const m of movers) {
        const up = m.changePct >= 0;
        const item = document.createElement('span');
        item.className = 'ticker-item';
        item.innerHTML =
          `<span class="tk-sym">${esc(m.symbol.replace(/USDT$/, ''))}</span> ` +
          `$${Number(m.price).toLocaleString('en-US', { maximumFractionDigits: 4 })} ` +
          `<span class="${up ? 'tk-up' : 'tk-down'}">${up ? '▲' : '▼'} ${Math.abs(m.changePct).toFixed(2)}%</span>`;
        if (hidden) item.setAttribute('aria-hidden', 'true');
        else {
          item.title = `${m.symbol} · click to analyze`;
          item.onclick = () => submit(`analisis teknikal ${m.symbol.replace(/USDT$/, '')}`);
        }
        frag.appendChild(item);
      }
      return frag;
    };
    // Two identical copies -> translateX(-50%) loops seamlessly with no gap.
    track.appendChild(build(false));
    track.appendChild(build(true));
    track.style.setProperty('--tk-speed', `${Math.max(24, movers.length * 4)}s`);
  }

  function renderMovers(snapshot) {
    if (!snapshot || !snapshot.movers) return;
    lastMovers = {};
    for (const m of snapshot.movers) lastMovers[m.symbol] = m;
    renderWatchlist();
    els.moversSub.textContent = snapshot.mock ? 'MOCK · 24h' : '24h';
    els.moversSub.style.color = snapshot.mock ? 'var(--amber)' : '';
    renderTicker(snapshot.movers);
    const sorted = [...snapshot.movers].sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct));
    els.movers.innerHTML = '';
    for (const m of sorted) {
      const up = m.changePct >= 0;
      const bubble = document.createElement('button');
      bubble.type = 'button';
      // Bubble size scales with the magnitude of the move.
      const mag = Math.min(2, Math.max(0.7, Math.abs(m.changePct) / 6));
      bubble.className = `mover-bubble ${up ? 'up' : 'down'}`;
      bubble.style.fontSize = `${Math.round(11 * mag)}px`;
      bubble.style.padding = `${Math.round(7 * mag)}px ${Math.round(12 * mag)}px`;
      bubble.textContent = `${m.symbol.replace(/USDT$/, '')} ${up ? '+' : ''}${m.changePct.toFixed(2)}%`;
      bubble.title = `${m.symbol} · $${m.price} · click to analyze`;
      bubble.onclick = () => submit(`analisis teknikal ${m.symbol.replace(/USDT$/, '')}`);
      els.movers.appendChild(bubble);
    }
  }

  function renderAnalystCards(result) {
    // Finalize cards from actual outputs (replaces live placeholders).
    for (const out of result.analysts) {
      upsertAnalystCard(out.analystId, out.ok ? 'ok' : 'fail', out.headline ?? out.error, out.confidence, out.evidence.length, out.durationMs);
    }
  }

  // Narrative English phrasing for each classification.
  const CLASS_NARRATIVE = {
    improving: 'is strengthening',
    declining: 'is weakening',
    stable: 'is holding stable',
    anomalous: 'is showing anomalous behavior',
    compare: 'compared in this analysis',
    'insufficient-evidence': 'cannot be concluded yet',
  };
  const CLASS_DISPLAY = {
    'insufficient-evidence': 'INSUFFICIENT EVIDENCE',
  };
  const EVIDENCE_NARRATIVE = {
    high: 'backed by strong evidence',
    medium: 'backed by sufficient evidence',
    low: 'backed only by limited evidence',
    insufficient: 'lacks adequate evidence',
  };
  const QUALITY_NARRATIVE = {
    good: 'good',
    partial: 'partial',
    poor: 'poor',
    unknown: 'unknown',
  };
  const tidy = (s) => String(s ?? '').trim().replace(/[.\s]+$/, '');

  function buildNarrative(result) {
    const d = result.decision;
    const subj = result.subjectLabel || result.subject;

    // Honest dead-end: a dedicated, well-formed narrative instead of fragments.
    if (d.classification === 'insufficient-evidence') {
      const reason = d.rationale.length ? tidy(d.rationale[0]) : 'no analyst could work with the available data';
      return (
        `${subj ? `For ${subj}: ` : ''}the available evidence is not enough to draw a conclusion — ${reason}. ` +
        `The engine will not invent answers. Try clarifying the subject, extending the data range, or picking another data source.`
      );
    }

    const parts = [];
    parts.push(
      `${subj ?? 'This analysis'} ${CLASS_NARRATIVE[d.classification] ?? d.classification}.` +
      (d.confidence !== undefined ? ` Model confidence: ${pct(d.confidence)}.` : '')
    );
    parts.push(tidy(d.decision) + '.');
    if (d.rationale.length) parts.push(`Main driver: ${tidy(d.rationale[0])}.`);
    parts.push(
      `This conclusion is ${EVIDENCE_NARRATIVE[d.breakdown.evidenceStrength] ?? d.breakdown.evidenceStrength}` +
      ` with data quality ${QUALITY_NARRATIVE[d.breakdown.dataQuality] ?? d.breakdown.dataQuality}.`
    );
    if (d.invalidation.length) parts.push(`Conclusion breaks if: ${tidy(d.invalidation[0])}.`);
    return parts.join(' ');
  }

  function renderConclusion(result) {
    const d = result.decision;
    if (!d) {
      els.conclusion.innerHTML = '<p class="dim">no conclusion for this analysis</p>';
      return;
    }
    const conf = d.confidence !== undefined ? ` <span class="concl-conf">${pct(d.confidence)}</span>` : '';
    const rec = d.recommendations[0];
    els.conclusion.innerHTML = `
      <div class="concl-class verdict-class ${esc(d.classification)}">${esc(CLASS_DISPLAY[d.classification] ?? d.classification)}${conf}</div>
      <p class="concl-text concl-narrative">${esc(buildNarrative(result))}</p>
      ${rec ? `<p class="concl-rec">→ ${esc(rec)}</p>` : ''}`;
  }

  function showFindingEvidence(result, finding) {
    const items = finding.evidenceIds
      .map((id) => result.evidence.find((e) => e.id === id))
      .filter(Boolean);
    els.evidenceDetail.innerHTML = `
      <h4>finding</h4>
      <div>${esc(finding.title)}</div>
      ${finding.detail ? `<div class="kv">${esc(finding.detail)}</div>` : ''}
      <h4>supporting evidence (${items.length})</h4>
      ${items.map((e) => `<div class="kv">• ${esc(e.label)} <span class="dim">[${esc(e.reliability)}]</span></div>`).join('') || '<p class="dim">no linked evidence</p>'}`;
    document.getElementById('panel-evidence').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function showEvidenceById(id) {
    if (!currentAnalysis) return;
    const ev = currentAnalysis.evidence.find((e) => e.id === id);
    if (ev) {
      els.evidenceDetail.innerHTML = `<h4>evidence</h4><div>${esc(ev.label)}</div><div class="kv">metric=${esc(ev.metric)} value=${esc(JSON.stringify(ev.value))} reliability=${esc(ev.reliability)}</div>`;
      return;
    }
    const finding = currentAnalysis.findings.find((f) => f.id === id);
    if (finding) showFindingEvidence(currentAnalysis, finding);
  }

  function refreshHistory(activeId) {
    ws.send(JSON.stringify({ type: 'analysis_list' }));
    void activeId;
  }

  function renderHistoryList(analyses) {
    els.history.innerHTML = '';
    for (const a of analyses) {
      const li = document.createElement('li');
      if (currentAnalysis && a.id === currentAnalysis.id) li.className = 'active';
      li.innerHTML = `${esc(a.query.slice(0, 60))}<span class="h-meta">${esc(a.subject ?? '')} · ${esc(a.classification ?? a.status ?? '')} · ${timeAgo(a.timestamp)}</span>`;
      li.onclick = () => ws.send(JSON.stringify({ type: 'analysis_get', analysisId: a.id, sessionId: currentSessionId }));
      els.history.appendChild(li);
    }
    if (!analyses.length) els.history.innerHTML = '<li class="dim">no analyses yet</li>';
  }

  // ------------------------------------------------------------------
  // websocket — resilient connect with auto-reconnect
  // ------------------------------------------------------------------
  function connect() {
    els.status.textContent = 'connecting…';
    els.status.classList.remove('connected');
    ws = new WebSocket(`${protocol}//${location.host}/ws`);
    ws.onopen = () => {
      els.status.textContent = 'connected';
      els.status.classList.add('connected');
    };
    ws.onclose = () => {
      els.status.textContent = 'reconnecting…';
      els.status.classList.remove('connected');
      setTimeout(connect, 3000);
    };
    ws.onerror = () => {
      try { ws.close(); } catch { /* already closed */ }
    };
    ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    switch (msg.type) {
      case 'boot':
        renderBoot(msg);
        renderHistoryList(msg.analyses || []);
        if (msg.movers) renderMovers(msg.movers);
        office.setRegistry(msg.analysts || []);
        break;
      case 'movers':
        renderMovers(msg);
        break;
      case 'event':
        handleEvent(msg.event);
        break;
      case 'result':
        if (msg.sessionId) currentSessionId = msg.sessionId;
        els.send.disabled = false;
        chatMsg(msg.ok ? msg.summary : `error: ${msg.summary}`, msg.ok ? '' : 'error');
        break;
      case 'followup':
        if (msg.kind === 'explain') chatMsg(msg.summary, '');
        if (msg.kind === 'evidence') document.getElementById('panel-evidence').scrollIntoView({ behavior: 'smooth' });
        break;
      case 'analysis_list':
        renderHistoryList(msg.analyses || []);
        break;
      case 'market_subscribed':
        els.liveSymbol.textContent = `${msg.symbol} · ${msg.interval || '1m'}`;
        radarSymbol = msg.symbol;
        $('radar-sub').textContent = msg.symbol;
        liveChart.setSymbol(msg.symbol);
        liveChart.draw();
        break;
      case 'trades':
        if (msg.symbol === radarSymbol) {
          radar.ingest(msg.trades || [], msg.mock);
          // Whale moment: a genuinely large trade slows the office down.
          if (!msg.mock) {
            const whale = (msg.trades || []).find((t) => t.v >= 500000);
            if (whale) office.whaleAlert(whale.v >= 1e6 ? `$${(whale.v / 1e6).toFixed(1)}M` : `$${Math.round(whale.v / 1e3)}k`);
          }
        }
        break;
      case 'news':
        renderNews(msg.headlines || []);
        break;
      case 'candles':
        // Multiple symbols may stream at once (auto BTC + analyzed symbol) —
        // only the chart's current symbol may touch it.
        if (msg.symbol === liveChart.symbol && (!msg.range || msg.range === currentChartRange)) liveChart.setCandles(msg.candles || []);
        const hint = `menampilkan ${liveChart.candles.length} candle ${liveChart.rangeLabel || ''} untuk ${liveChart.symbol}`;
        if ($('range-hint') && liveChart.symbol) $('range-hint').textContent = hint;
        break;
      case 'candle': {
        if (msg.symbol !== liveChart.symbol) break;
        // Live tick 1m diagregasi ke bucket interval chart saat ini
        // (1H/24H/7D/14D/30D), jadi candle terakhir di semua range tetap bergerak.
        liveChart.pushTick(msg.candle);
        const price = Number(msg.candle?.c);
        if (Number.isFinite(price)) {
          els.liveSymbol.textContent = `${liveChart.symbol} · ${liveChart.interval || '1m'} · ${price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 8 })}`;
          checkAlerts(msg.symbol, price);
        }
        break;
      }
      case 'permission_request': {
        const detail = `${msg.request.permission}\n${msg.request.description || ''}\n(tool: ${msg.request.toolName || '?'})`;
        const ok = window.confirm(`Allow this permission?\n\n${detail}`);
        ws.send(JSON.stringify({ type: 'permission_response', id: msg.id, allowed: ok }));
        break;
      }
      case 'error':
        els.send.disabled = false;
        chatMsg(`error: ${msg.message}`, 'error');
        break;
    }
    };
  }
  connect();

  function handleEvent(ev) {
    switch (ev.type) {
      case 'analysis_start':
        startAnalysis(ev.query);
        break;
      case 'analysis_plan':
        office.setPlan(ev.steps || []);
        break;
      case 'analysis_step':
        logStep(ev.step);
        office.setStep(ev.step.label, ev.step.detail, ev.step.status);
        if (ev.step.label && ev.step.label.startsWith('Run analyst: ')) {
          const name = ev.step.label.slice('Run analyst: '.length);
          if (ev.step.status === 'running') upsertAnalystCard(name, 'running');
        }
        break;
      case 'analyst_result':
        upsertAnalystCard(ev.analystId, ev.ok ? 'ok' : 'fail', ev.headline, ev.confidence, undefined, undefined, ev.evidenceLabels);
        break;
      case 'analysis_result':
        if (ev.sessionId) currentSessionId = ev.sessionId;
        renderAnalysis(ev.result);
        office.celebrate(ev.result.decision?.decision, ev.result.decision?.classification);
        break;
      case 'tool_call':
        logStep({ id: `tool-${ev.toolCallId}`, label: `tool: ${ev.name}`, status: 'running', detail: JSON.stringify(ev.input).slice(0, 120) });
        break;
      case 'tool_result':
        logStep({ id: `tool-${ev.toolCallId}`, label: `tool: ${ev.name}`, status: ev.ok ? 'done' : 'failed' });
        break;
      case 'error':
        chatMsg(`error: ${ev.message}`, 'error');
        break;
      // planning/text/reflection/completion: raw agent chatter stays out of the workspace.
    }
  }

  function renderBoot(msg) {
    renderList('providers', (msg.providers || []).map((p) => (p.active ? `* ${p.id} (${p.model})` : `${p.id} (${p.model})`)));
    renderList('plugins', (msg.plugins || []).map((p) => `${p.id}@${p.version}`));
    renderList('tools', msg.tools || []);
    renderList('sessions', (msg.sessions || []).map((s) => `${s.id} ${s.title}`));
    renderList('analyst-registry', (msg.analysts || []).map((a) => `${a.id}${a.pluginId ? ` (${a.pluginId})` : ''}`));
  }

  function renderList(id, items) {
    const el = $(id);
    el.innerHTML = '';
    for (const item of items) {
      const li = document.createElement('li');
      li.textContent = item;
      if (item.startsWith('* ')) li.className = 'active';
      el.appendChild(li);
    }
  }

  function renderNews(headlines) {
    els.news.innerHTML = '';
    if (!headlines.length) {
      els.news.innerHTML = '<li class="dim">tidak ada berita…</li>';
      return;
    }
    for (const h of headlines.slice(0, 8)) {
      const li = document.createElement('li');
      li.innerHTML = `<div>${esc(h.title)}</div><div class="news-meta">${esc(h.source)}${h.published ? ' · ' + timeAgo(h.published) : ''}</div>`;
      els.news.appendChild(li);
    }
  }

  // ------------------------------------------------------------------
  // input
  // ------------------------------------------------------------------
  function submit(text) {
    const q = (text ?? els.prompt.value).trim();
    if (!q) return;
    chatMsg(`> ${q}`, 'user');
    els.send.disabled = true;
    ws.send(JSON.stringify({ type: 'prompt', text: q, sessionId: currentSessionId }));
    els.prompt.value = '';
  }

  els.send.onclick = () => submit();
  els.prompt.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submit();
  });

  // Intervention: gather the office into the meeting room, then steer the engine.
  const interveneInput = $('intervene-input');
  const interveneBtn = $('intervene-btn');
  function intervene() {
    const text = interveneInput.value.trim();
    if (!text) return;
    interveneInput.value = '';
    office.intervene(text);
    chatMsg(`> 📢 ${text}`, 'user');
    // Let the meeting be seen before the new run re-activates the office.
    setTimeout(() => ws.send(JSON.stringify({ type: 'prompt', text, sessionId: currentSessionId })), 8500);
  }
  interveneBtn.onclick = intervene;
  interveneInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') intervene();
  });
  document.querySelectorAll('.hint').forEach((btn) => {
    btn.addEventListener('click', () => submit(btn.dataset.q));
  });

  // Activity collapse.
  els.activityToggle.onclick = () => {
    const open = els.activityLog.classList.toggle('hidden');
    els.activityToggle.textContent = `${open ? '▸' : '▾'} Activity / Execution`;
  };

  // Timeframe buttons (1H / 24H / 7D / 14D / 30D): re-request history for the
  // active symbol at the new interval; live 1m ticks aggregate into buckets.
  const tfButtons = [...document.querySelectorAll('.tf-btn')];
  const ivButtons = [...document.querySelectorAll('.iv-btn')];
  function selectRange(range) {
    currentChartRange = range;
    tfButtons.forEach((b) => b.classList.toggle('active', b.dataset.range === range));
    ivButtons.forEach((b) => b.classList.remove('active'));
    if (!liveChart.symbol) return;
    liveChart.setRange(range);
    liveChart.draw();
    if ($('range-hint')) $('range-hint').textContent = `memuat ${range.toUpperCase()} untuk ${liveChart.symbol}…`;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'market_unsubscribe', symbol: liveChart.symbol }));
      ws.send(JSON.stringify({ type: 'market_subscribe', symbol: liveChart.symbol, range }));
    }
  }
  tfButtons.forEach((b) => b.addEventListener('click', () => selectRange(b.dataset.range)));

  // Custom TradingView-style intervals: fetch history at that interval directly.
  const IV_LIMIT = { '1m': 120, '5m': 144, '15m': 144, '1h': 168, '4h': 180, '1d': 180 };
  function selectInterval(iv) {
    currentChartRange = `custom:${iv}`;
    ivButtons.forEach((b) => b.classList.toggle('active', b.dataset.iv === iv));
    tfButtons.forEach((b) => b.classList.remove('active'));
    if (!liveChart.symbol) return;
    liveChart.setCustomInterval(iv, IV_LIMIT[iv] || 144);
    if ($('range-hint')) $('range-hint').textContent = `memuat interval ${iv.toUpperCase()} untuk ${liveChart.symbol}…`;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'market_unsubscribe', symbol: liveChart.symbol }));
      ws.send(JSON.stringify({ type: 'market_subscribe', symbol: liveChart.symbol, interval: iv, limit: IV_LIMIT[iv] || 144 }));
    }
  }
  ivButtons.forEach((b) => b.addEventListener('click', () => selectInterval(b.dataset.iv)));

  // Indicator toggles.
  $('ind-vol').addEventListener('change', (e) => liveChart.toggleVolume(e.target.checked));
  $('ind-ema20').addEventListener('change', (e) => liveChart.toggleEMA20(e.target.checked));
  $('ind-ema50').addEventListener('change', (e) => liveChart.toggleEMA50(e.target.checked));

  // ------------------------------------------------------------------
  // watchlist — click a symbol to switch chart + radar + news instantly
  // ------------------------------------------------------------------
  const WATCHLIST = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT'];
  function switchSymbol(symbol) {
    if (!symbol || symbol === liveChart.symbol) return;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'market_unsubscribe', symbol: liveChart.symbol }));
    }
    // Reset current range to 1h default for the new symbol (keeps buttons in sync).
    currentChartRange = '1h';
    tfButtons.forEach((b) => b.classList.toggle('active', b.dataset.range === '1h'));
    ivButtons.forEach((b) => b.classList.remove('active'));
    liveChart.setRange('1h');
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'market_subscribe', symbol, range: '1h' }));
    }
    renderWatchlist();
  }
  function renderWatchlist() {
    const row = $('watch-row');
    if (!row) return;
    row.innerHTML = '';
    for (const sym of WATCHLIST) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `watch-btn${sym === liveChart.symbol ? ' active' : ''}`;
      const short = sym.replace(/USDT$/, '');
      const info = (lastMovers[sym] ? ` <small>$${fmtPrice(lastMovers[sym].price)}</small>` : '');
      btn.innerHTML = `${esc(short)}${info}`;
      btn.title = `${sym} · klik untuk pindah chart`;
      btn.onclick = () => switchSymbol(sym);
      row.appendChild(btn);
    }
  }
  let lastMovers = {};
  function fmtPrice(p) {
    const n = Number(p);
    if (!Number.isFinite(n)) return '—';
    return n >= 1000 ? n.toLocaleString('en-US', { maximumFractionDigits: 1 }) : n.toLocaleString('en-US', { maximumFractionDigits: 4 });
  }

  // ------------------------------------------------------------------
  // price alerts — persisted in localStorage, checked on every live tick
  // ------------------------------------------------------------------
  let alerts = [];
  try { alerts = JSON.parse(localStorage.getItem('price-alerts') || '[]'); } catch { alerts = []; }
  function saveAlerts() {
    try { localStorage.setItem('price-alerts', JSON.stringify(alerts)); } catch { /* private mode */ }
  }
  function renderAlerts() {
    const ul = $('alert-list');
    if (!ul) return;
    ul.innerHTML = '';
    for (const a of alerts) {
      const li = document.createElement('li');
      if (a.fired) li.className = 'fired';
      const dirTxt = a.dir === 'above' ? '≥' : '≤';
      li.innerHTML = `<span>${esc(a.symbol)} ${dirTxt} ${esc(String(a.price))}${a.fired ? ' ✓' : ''}</span>`;
      const del = document.createElement('button');
      del.className = 'alert-del';
      del.textContent = '×';
      del.title = 'Hapus alert';
      del.onclick = () => { alerts = alerts.filter((x) => x.id !== a.id); saveAlerts(); renderAlerts(); };
      li.appendChild(del);
      ul.appendChild(li);
    }
  }
  function addAlert() {
    const price = Number(($('alert-price') || {}).value);
    const dir = ($('alert-dir') || {}).value === 'below' ? 'below' : 'above';
    if (!liveChart.symbol) { chatMsg('pilih simbol dulu (klik watchlist atau kirim analisis)', 'error'); return; }
    if (!Number.isFinite(price) || price <= 0) { chatMsg('masukkan harga alert yang valid', 'error'); return; }
    alerts.push({ id: `a${Date.now()}`, symbol: liveChart.symbol, price, dir, fired: false });
    saveAlerts();
    renderAlerts();
    $('alert-price').value = '';
    chatMsg(`alert dipasang: ${liveChart.symbol} ${dir === 'above' ? '≥' : '≤'} ${price}`, '');
  }
  function fireAlert(a, price) {
    a.fired = true;
    saveAlerts();
    renderAlerts();
    const msg = `🔔 ALERT: ${a.symbol} ${a.dir === 'above' ? 'menyentuh ≥' : 'menyentuh ≤'} ${a.price} (sekarang ${price})`;
    chatMsg(msg, '');
    try { office.whaleAlert(`ALERT ${a.symbol.replace(/USDT$/, '')} ${a.dir === 'above' ? '≥' : '≤'}${a.price}`); } catch { /* office guarded */ }
    // Beep (WebAudio, no asset needed).
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) {
        const ac = new AC();
        for (let i = 0; i < 3; i++) {
          const osc = ac.createOscillator();
          const gain = ac.createGain();
          osc.connect(gain); gain.connect(ac.destination);
          osc.frequency.value = 880;
          const t0 = ac.currentTime + i * 0.22;
          gain.gain.setValueAtTime(0.001, t0);
          gain.gain.exponentialRampToValueAtTime(0.4, t0 + 0.03);
          gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.18);
          osc.start(t0); osc.stop(t0 + 0.2);
        }
      }
    } catch { /* audio blocked */ }
    // Browser notification (needs permission; best-effort).
    try {
      if ('Notification' in window && Notification.permission === 'granted') {
        new Notification('Price Alert', { body: msg });
      } else if ('Notification' in window && Notification.permission !== 'denied') {
        Notification.requestPermission().then((p) => {
          if (p === 'granted') new Notification('Price Alert', { body: msg });
        });
      }
    } catch { /* notifications unsupported */ }
  }
  function checkAlerts(symbol, price) {
    let changed = false;
    for (const a of alerts) {
      if (a.fired || a.symbol !== symbol) continue;
      if ((a.dir === 'above' && price >= a.price) || (a.dir === 'below' && price <= a.price)) {
        fireAlert(a, price);
        changed = true;
      }
    }
    if (changed) renderAlerts();
  }
  if ($('alert-add')) $('alert-add').onclick = addAlert;
  if ($('alert-price')) $('alert-price').addEventListener('keydown', (e) => { if (e.key === 'Enter') addAlert(); });
  renderAlerts();
  renderWatchlist();

  // Settings drawer.
  const drawer = $('settings-drawer');
  $('history-refresh').onclick = () => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'analysis_list' }));
  };
  const overlay = $('settings-overlay');
  const toggleSettings = (open) => {
    const show = open !== undefined ? open : !drawer.classList.contains('open');
    drawer.classList.toggle('open', show);
    overlay.classList.toggle('hidden', !show);
  };
  $('settings-btn').onclick = () => toggleSettings();
  $('settings-close').onclick = () => toggleSettings(false);
  overlay.onclick = () => toggleSettings(false);
})();
