/**
 * WD-012 visits feature entry point.
 *
 * Exports the mountable FR-046/FR-049 surfaces plus the mount descriptor so
 * a later slice can register them without importing internals. WD-012 does
 * not touch the shell's App.tsx: the wiring is exactly one pending line,
 * documented in README.md.
 */
import VisitForm from './VisitForm';
import VisitHistoryPanel from './VisitHistoryPanel';

export { VisitForm, VisitHistoryPanel };
export default VisitHistoryPanel;
export type { VisitFormProps } from './VisitForm';
export type { VisitHistoryPanelProps } from './VisitHistoryPanel';

export {
  ATTACHMENT_CATEGORIES,
  ATTACHMENT_VISIBILITIES,
  EMPTY_VISIT_FORM,
  UTC_OFFSETS,
  VISIT_ACTIONS,
  VISIT_TYPES,
  actionLabel,
  composeInstant,
  composeSubmitBody,
  initialVisitDraft,
  isWiringNote,
  newAttachmentRow,
  notInspectedSince,
  projectHistoryVisits,
  submitVisitDraft,
  summarizeHistory,
  validateVisitForm,
  visitDraftReducer,
} from './visitModel';
export type {
  AttachmentCategory,
  AttachmentDraft,
  AttachmentVisibility,
  FormFieldErrors,
  HistoryAttachment,
  HistorySummary,
  HistoryVisit,
  VisitDraftEvent,
  VisitDraftState,
  VisitDraftStatus,
  VisitFormValues,
  VisitSubmitBody,
  VisitTransport,
  VisitTransportResult,
  VisitType,
} from './visitModel';

/** Registration descriptor for the shell's feature registry (site detail, visits tab). */
export const visitsMount = {
  id: 'visits',
  label: 'Visits and attachments',
  mountPath: 'site-detail/visits',
  component: VisitHistoryPanel,
} as const;

/** Registration descriptor for the field-entry surface (assigned engineer workspace). */
export const visitEntryMount = {
  id: 'visit-entry',
  label: 'Record a site visit',
  mountPath: 'operations/visit-entry',
  component: VisitForm,
} as const;
