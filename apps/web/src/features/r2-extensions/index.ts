/**
 * WD-023-R2 extensions feature entry point (FR-044 as-of, FR-047 voice).
 *
 * Exports the two mountable panels, the pure view models and their demo
 * constants, plus the mount descriptors a later slice registers in the
 * shell. WD-023-R2 must not edit apps/web/src/shell/App.tsx: the shell
 * wiring is exactly the pending lines documented in README.md.
 *
 * The server counterparts live in services/integrations/r2/ (asof, voice,
 * wcat). The WCAT adapter seam has no panel: it is an integration contract
 * with fixture tests only until the external WCAT contract is agreed.
 */
import AsOfPanel from './AsOfPanel';
import VoiceDraftPanel from './VoiceDraftPanel';

export { AsOfPanel, VoiceDraftPanel };
export type { AsOfPanelProps } from './AsOfPanel';
export type { VoiceDraftPanelProps } from './VoiceDraftPanel';

export {
  DEMO_CORINNE_OBSERVATIONS,
  DEMO_CORINNE_REVISIONS,
  DEMO_HYRUM_OBSERVATIONS,
  DEMO_PERSONAS,
  DEMO_STREAMS,
  DEMO_VOICE_DRAFT,
  assembleTView,
  asOfBasisLabel,
  asOfRows,
  demoAsOfAuthorize,
  demoAsOfLoad,
  excludedLaterNote,
  formatInstantUtc,
  providerPendingLabel,
  voiceReviewBlockers,
  voiceStateBadge,
} from './extensionsModel';
export type {
  AsOfBasisView,
  AsOfDecisionView,
  AsOfDeniedView,
  AsOfRowModel,
  AsOfSeriesPointView,
  AsOfSeriesView,
  DemoObservation,
  DemoPersona,
  DemoRevision,
  DemoStream,
  VoiceBadgeModel,
  VoiceDraftState,
  VoiceDraftView,
  VoiceReviewStatus,
} from './extensionsModel';

/** Registration descriptor for the shell's feature registry (as-of tab). */
export const asOfPanelMount = {
  id: 'r2-as-of',
  label: 'As-of reconstruction',
  mountPath: 'r2/as-of',
  component: AsOfPanel,
} as const;

/** Registration descriptor for the shell's feature registry (voice drafts tab). */
export const voiceDraftPanelMount = {
  id: 'r2-voice-drafts',
  label: 'Voice note drafts',
  mountPath: 'r2/voice-drafts',
  component: VoiceDraftPanel,
} as const;
