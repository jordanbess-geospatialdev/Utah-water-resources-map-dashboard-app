/**
 * WD-013 quality feature entry point.
 *
 * Exports the four mountable panels (FR-015 rule console, FR-016 violation
 * digest + subscriptions, FR-036/FR-034 engineering diagnostics, FR-038
 * known issues) plus their mount descriptors and the pure view models, so a
 * later slice can register them without importing internals. WD-013 does
 * not touch persona_ui's apps/web/src/shell/App.tsx: the shell wiring is
 * exactly the pending lines documented in README.md.
 */
import QcRulesPanel from './QcRulesPanel';
import ViolationsPanel from './ViolationsPanel';
import DiagnosticsPanel from './DiagnosticsPanel';
import KnownIssuesPanel from './KnownIssuesPanel';

export { QcRulesPanel, ViolationsPanel, DiagnosticsPanel, KnownIssuesPanel };
export type { QcRulesPanelProps } from './QcRulesPanel';
export type { ViolationsPanelProps } from './ViolationsPanel';
export type { DiagnosticsPanelProps } from './DiagnosticsPanel';
export type { KnownIssuesPanelProps } from './KnownIssuesPanel';

export {
  CADENCES,
  CADENCE_LABELS,
  FAMILY_LABELS,
  FAMILY_ORDER,
  SEVERITY_LABELS,
  contextLink,
  diagnosticsRows,
  formatInstantUtc,
  formatIntervalUtc,
  indicatorBadges,
  issueStatusBadge,
  knownIssueRows,
  latestRunByRuleVersion,
  promoteBlockedReason,
  ruleRows,
  ruleStatusBadge,
  runStatusBadge,
  runSummary,
  scopeLabel,
  subscriptionRows,
  violationRows,
} from './qualityModel';
export type {
  DigestCadence,
  DigestCountsView,
  DiagnosticStreamView,
  IndicatorBadgeModel,
  IndicatorView,
  KnownIssueRowModel,
  KnownIssueStatus,
  KnownIssueView,
  KnownIssueVisibility,
  ResolutionEventView,
  RuleRowModel,
  RuleVersionView,
  RunResultView,
  SubscriptionRowModel,
  SubscriptionScopeView,
  SubscriptionView,
  ThresholdSeverity,
  ViolationEntryView,
  ViolationRowModel,
  QcRuleFamily,
  QcRuleStatus,
} from './qualityModel';
export {
  DEMO_DIAGNOSTIC_STREAMS,
  DEMO_DIGEST_COUNTS,
  DEMO_DIGEST_ENTRIES,
  DEMO_KNOWN_ISSUES,
  DEMO_RULES,
  DEMO_RUN_RESULTS,
  DEMO_SUBSCRIPTIONS,
} from './qualityModel';

/** Registration descriptors for the shell's feature registry (quality tab). */
export const qcRulesMount = {
  id: 'quality-rules',
  label: 'QC rules',
  mountPath: 'quality/rules',
  component: QcRulesPanel,
} as const;

export const violationsMount = {
  id: 'quality-violations',
  label: 'Violation digest',
  mountPath: 'quality/violations',
  component: ViolationsPanel,
} as const;

export const diagnosticsMount = {
  id: 'quality-diagnostics',
  label: 'Engineering diagnostics',
  mountPath: 'quality/diagnostics',
  component: DiagnosticsPanel,
} as const;

export const knownIssuesMount = {
  id: 'quality-issues',
  label: 'Known issues',
  mountPath: 'quality/issues',
  component: KnownIssuesPanel,
} as const;
