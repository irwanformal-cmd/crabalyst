/** Local re-export shim so plugin code imports intelligence types from one place. */
export type {
  Analyst,
  AnalystContext,
  AnalystOutput,
  DataTable,
  DataSource,
  EvidenceItem,
  Finding,
  Anomaly,
  ImportantLevel,
} from '../../src/intelligence/types.js';
export type { PluginIntelligence } from '../../src/types/plugin.js';
export type { WorkflowRule } from '../../src/intelligence/planner.js';
