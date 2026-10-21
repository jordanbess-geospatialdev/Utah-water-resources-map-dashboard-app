/**
 * WD-020 support/onboarding feature entry point (FR-008/FR-017/FR-018/FR-068).
 *
 * Exports the mountable Help panel (role-aware task help + feedback with a
 * support-context preview), the skippable first-visit OnboardingTour, the
 * browser analytics-consent persistence model, and the tour persistence
 * helpers. WD-020 does not touch apps/web/src/shell/App.tsx: the shell
 * wiring is pending and documented in README.md.
 */
import HelpPanel from './HelpPanel';
import OnboardingTour from './OnboardingTour';

export { HelpPanel };
export default HelpPanel;
export type { HelpPanelProps } from './HelpPanel';

export { OnboardingTour };
export type { OnboardingTourProps, Tour, TourStep } from './OnboardingTour';
export {
  inMemoryTourStorage,
  localStorageTourAdapter,
  readTourRecord,
  shouldAutoStart,
  TOUR_PERSONA_IDS,
  TOUR_SCHEMA_VERSION,
  tourForPersona,
  tourStorageKey,
} from './OnboardingTour';
export type { TourCompletionState, TourRecord, TourStorage } from './OnboardingTour';

export {
  ANALYTICS_POLICY_VERSION,
  clearConsent,
  CONSENT_SCHEMA_VERSION,
  consentStatus,
  consentStorageKey,
  inMemoryStorage as inMemoryConsentStore,
  localStorageAdapter as localStorageConsentAdapter,
  readConsent,
  recordConsent,
} from './consent';
export type { AnalyticsConsentChoice, ConsentStatus, ConsentStorage, RecordConsentInput } from './consent';

export {
  ALLOWED_URL_HOSTS,
  APP_VERSION,
  buildSupportContextPreview,
  DESCRIPTION_MAX_LENGTH,
  DESCRIPTION_MIN_LENGTH,
  FEEDBACK_CATEGORIES,
  FEEDBACK_CATEGORY_LABELS,
  guidesForPersona,
  SCREENSHOT_REF_PATTERN,
  validateFeedbackForm,
} from './HelpPanel';
export type { FeedbackCategory, FeedbackFormErrorCode, SupportContextPreview, TaskGuide } from './HelpPanel';

/** Registration descriptor for the shell's feature registry (Help tab). */
export const helpMount = {
  id: 'help',
  label: 'Help',
  mountPath: 'help',
  component: HelpPanel,
} as const;

/** Registration descriptor for the tour overlay (first-visit, role-relevant). */
export const onboardingTourMount = {
  id: 'onboarding-tour',
  label: 'Onboarding tour',
  kind: 'overlay' as const,
  component: OnboardingTour,
} as const;
