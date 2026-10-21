/**
 * WD-010 data-entry feature entry point (FR-020 manual measurement entry,
 * FR-021 large batch paste and import).
 *
 * Exports the mountable panels plus the pure paste/form models. WD-010
 * does not touch apps/web/src/shell/App.tsx: the shell wiring is exactly
 * one pending block, documented in README.md.
 */
import ManualEntryForm from './ManualEntryForm';
import BulkPastePanel from './BulkPastePanel';

export { ManualEntryForm, BulkPastePanel };
export type { ManualEntryFormProps, ManualSubmitPort, ManualSubmitResult } from './ManualEntryForm';
export type { BulkPastePanelProps, CommitPort, CommitPortResult, ValidatePort, ValidatePortResult } from './BulkPastePanel';

export {
  bulkFlowReducer,
  composedObservedAt,
  denverLocalToUtc,
  denverOffsetMinutesAt,
  detectDelimiter,
  DENVER_OFFSETS,
  EMPTY_MANUAL_FORM,
  ENTRY_STREAMS,
  ENTRY_UNITS,
  INITIAL_BULK_FLOW,
  INITIAL_MANUAL_FORM,
  isoHasExplicitOffset,
  KNOWN_COLUMN_KEYS,
  manualFormReducer,
  mapHeader,
  parseDateCell,
  parseDateTimeWithOffset,
  parseOffsetCell,
  parsePastePreview,
  parseTimeCell,
  pasteLines,
  splitLine,
  streamDisplayName,
  validateManualForm,
} from './entryModel';
export type {
  BulkFlowEvent,
  BulkFlowPhase,
  BulkFlowState,
  CellError,
  ColumnKey,
  DenverLocalToUtc,
  ImportModeChoice,
  ManualFormEvent,
  ManualFormState,
  ManualFormValues,
  ParsedPreview,
  PreviewMapping,
  PreviewParseOptions,
  PreviewRowVerdict,
  PreviewStream,
  ResolvedTime,
  TimeOfDay,
} from './entryModel';

/** Registration descriptor for the shell's feature registry (data entry surface). */
export const dataEntryMount = {
  id: 'data-entry',
  label: 'Enter readings',
  mountPath: 'data-entry',
  components: {
    manualEntry: ManualEntryForm,
    bulkPaste: BulkPastePanel,
  },
} as const;
