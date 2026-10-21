/**
 * WD-016 developer-access feature entry point.
 *
 * Exports the mountable FR-064 panel plus its mount descriptor so a later
 * slice can register it without importing internals. WD-016 does not touch
 * persona_ui's apps/web/src/shell/App.tsx: the shell wiring is exactly one
 * pending line, documented in README.md.
 */
import DeveloperAccessPanel from './DeveloperAccessPanel';

export { DeveloperAccessPanel };
export default DeveloperAccessPanel;
export type { DeveloperAccessPanelProps, IssuedSecret } from './DeveloperAccessPanel';

export {
  ACTION_LABELS,
  DEFAULT_DRAFT,
  EXPIRING_WINDOW_DAYS,
  PROCESSING_LEVELS,
  TOKEN_ACTIONS,
  buildScopeChoices,
  deriveTokenRow,
  deriveTokenRows,
  draftToScopes,
  summarizeScopes,
  validateDraft,
} from './derivation';
export type {
  AccountAuthority,
  CreateDraft,
  DerivedTokenRow,
  DerivedTokenStatus,
  DraftField,
  ProcessingLevel,
  ScopeChoices,
  TokenAction,
  TokenRecordView,
  TokenScopes,
} from './derivation';

/** Registration descriptor for the shell's feature registry (account area). */
export const developerAccessMount = {
  id: 'developer-access',
  label: 'Developer access',
  mountPath: 'account/developer-access',
  component: DeveloperAccessPanel,
} as const;
