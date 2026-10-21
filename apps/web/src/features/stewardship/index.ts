/**
 * WD-014 stewardship feature entry point (FR-011 user lifecycle and scoped
 * assignments, FR-012 authoritative vocabulary, FR-013 provider and
 * ingestion setup, FR-014 connection health and digest, FR-017 usage
 * analytics).
 *
 * Exports the mountable console panel plus the pure view models so a later
 * slice can register them without importing internals. WD-014 does not
 * touch apps/web/src/shell: the shell wiring is exactly one pending line,
 * documented in README.md.
 */
import StewardConsole from './StewardConsole';

export { StewardConsole };
export default StewardConsole;
export type { StewardConsoleActions, StewardConsoleProps, StewardConsoleTab } from './StewardConsole';

export {
  assembleDigestPreview,
  assignmentRows,
  CONSOLE_GATE_OBJECT,
  DIGEST_RULES,
  FR017_EXCLUSION_NOTE,
  healthRollup,
  healthStatusText,
  connectionTestLabel,
  ingestionQueue,
  stewardConsoleAccess,
  termStatusBadge,
  usageTables,
  vocabularyChangeList,
  vocabularyRows,
  weekdayLabel,
} from './consoleModel';
export type {
  AssignmentRow,
  ConsoleAccess,
  ConnectionStatusView,
  DigestConnectionEntryView,
  DigestPreviewLine,
  DigestTaskEntryView,
  GovernedTermView,
  HealthRollup,
  HealthRowView,
  IngestionConfigView,
  IngestionQueueSummary,
  PolicyAssignmentMirror,
  PolicyDecisionMirror,
  PolicyEvaluatorMirror,
  PolicyObjectMirror,
  PolicyPrincipalMirror,
  PolicyWorldMirror,
  ProviderDefinitionView,
  StewardConsoleData,
  TermStatusView,
  UsageAggregateView,
  UsageReportView,
  UsageTableRow,
  UsageTables,
  VocabularyChangeEventView,
  VocabularyKindView,
  WeekdayDigestView,
} from './consoleModel';

export { demoConsoleData, demoPolicyPort, demoPolicyEvaluator, demoPolicyWorld } from './demoData';

/** Registration descriptor for the shell's feature registry (manage tab). */
export const stewardshipMount = {
  id: 'stewardship',
  label: 'Steward console',
  mountPath: 'stewardship',
  component: StewardConsole,
} as const;
