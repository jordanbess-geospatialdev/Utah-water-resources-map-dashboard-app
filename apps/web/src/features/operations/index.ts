/**
 * WD-009 operations feature entry point (FR-019 assigned workspace,
 * FR-036 engineer diagnostics, FR-038 known issues).
 *
 * Exports the mountable workspace panel plus the pure derivation modules so
 * a later slice can register them without importing internals. WD-009 does
 * not touch apps/web/src/shell/App.tsx: the shell wiring is exactly one
 * pending line, documented in README.md.
 */
import OperationsWorkspace from './OperationsWorkspace';

export { OperationsWorkspace };
export default OperationsWorkspace;
export type { OperationsWorkspaceProps } from './OperationsWorkspace';

export {
  deriveAssignedScope,
  isReadableForPrincipal,
  publicBrowseRows,
} from './assignedScope';
export type {
  AssignedScope,
  AssignedScopeInput,
  AssignedSiteRow,
  AssignedStreamVerdict,
  AssignedSystemGroup,
  AssignedEmptyReason,
  AssignedDelegationNotice,
  PolicyAssignmentMirror,
  PolicyDecisionMirror,
  PolicyDelegationMirror,
  PolicyEvaluator,
  PolicyFieldClass,
  PolicyObjectMirror,
  PolicyPrincipalMirror,
  PolicyRequestMirror,
  PolicyScopeKind,
  PolicyScopeMirror,
  PolicyWorldMirror,
  PolicyPort,
  PublicBrowseRow,
} from './assignedScope';

export { fixturePolicyEvaluate, fixturePolicyPort, fixtureWorld } from './fixturePolicy';
export type { FixturePolicyPort } from './fixturePolicy';

export {
  issueStatusText,
  knownIssuesForViewer,
  KNOWN_ISSUES,
  statusFromHistory,
} from './knownIssues';
export type {
  IssueResolutionEvent,
  KnownIssueRecord,
  KnownIssueStatus,
  KnownIssueVisibility,
  KnownIssuesForViewer,
  KnownIssuesInput,
  ResolutionOutcome,
  VisibleKnownIssue,
} from './knownIssues';

/** Registration descriptor for the shell's feature registry (manage tab). */
export const operationsMount = {
  id: 'operations',
  label: 'Assigned work',
  mountPath: 'operations',
  component: OperationsWorkspace,
} as const;
