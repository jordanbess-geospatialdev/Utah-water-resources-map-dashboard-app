/**
 * WD-015 notifications feature entry point (FR-025 site and system event
 * alerts; FR-052 personal subscriptions).
 *
 * Exports the mountable NotificationPrefsPanel, the pure digest view models,
 * and the demo notifications port. WD-015 does not touch
 * apps/web/src/shell/App.tsx: the shell wiring is exactly one pending line,
 * documented in README.md.
 */
import NotificationPrefsPanel from './NotificationPrefsPanel';

export { NotificationPrefsPanel };
export default NotificationPrefsPanel;
export type { NotificationPrefsPanelProps } from './NotificationPrefsPanel';
export type { NotificationsPort, SaveOutcome, SaveSubscriptionInput, TestDispatchRow, TestEventInput } from './NotificationPrefsPanel';
export { createDemoNotificationsPort } from './NotificationPrefsPanel';

export {
  CADENCES,
  CADENCE_LABELS,
  DEMO_DIGEST,
  DEMO_SUBSCRIPTIONS,
  EVENT_TYPES,
  EVENT_TYPE_LABELS,
  EVENT_TYPE_ORDER,
  PROGRAM_TIME_ZONE,
  dedupeNote,
  denverInstantLabel,
  digestHeaderView,
  entryRows,
  groupedEntries,
  scopeLabel,
  subscriptionRows,
  thresholdSummary,
  windowLabel,
} from './digestModel';
export type {
  DigestCountsView,
  DigestEntryView,
  DigestHeaderView,
  DigestView,
  EntryGroupModel,
  EntryRowModel,
  NotificationCadence,
  NotificationEventType,
  SubscriptionRowModel,
  SubscriptionScopeView,
  SubscriptionThresholds,
  SubscriptionView,
  ThresholdBound,
} from './digestModel';

/** Registration descriptor for the shell's feature registry (Notifications tab). */
export const notificationsMount = {
  id: 'notifications',
  label: 'Notifications',
  mountPath: 'notifications',
  component: NotificationPrefsPanel,
} as const;
