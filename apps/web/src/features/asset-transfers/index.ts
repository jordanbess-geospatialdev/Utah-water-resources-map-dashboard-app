/**
 * WD-012-R2 asset-transfers feature entry point.
 *
 * Exports the mountable FR-048 surface plus the mount descriptor so a
 * later slice can register it without importing internals. This task does
 * not touch the shell: the wiring is exactly one pending line, documented
 * in README.md.
 */
import AssetTransferPanel from './AssetTransferPanel';

export { AssetTransferPanel };
export default AssetTransferPanel;
export type { AssetTransferPanelProps } from './AssetTransferPanel';

export {
  associationPeriodsOf,
  composeTransferBody,
  currentPeriodOf,
  DEMO_ASSOCIATIONS,
  DEMO_EQUIPMENT,
  DEMO_SITES,
  DEMO_VISITS,
  EMPTY_TRANSFER_FORM,
  evidenceLabel,
  formatPeriod,
  periodAt,
  periodsAtSite,
  siteOfAt,
  sitesEverOf,
  validateTransferForm,
  visitsOfSite,
} from './transferModel';
export type {
  AssociationPeriod,
  EquipmentView,
  SiteOption,
  TransferFieldError,
  TransferFormValues,
  VisitRow,
} from './transferModel';

/** Registration descriptor for the shell's feature registry (operations workspace). */
export const assetTransfersMount = {
  id: 'asset-transfers',
  label: 'Asset inventory and transfers',
  mountPath: 'operations/asset-transfers',
  component: AssetTransferPanel,
} as const;
