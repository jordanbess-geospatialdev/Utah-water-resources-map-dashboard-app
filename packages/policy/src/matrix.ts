/**
 * The proposed authorization matrix from
 * docs/product/baseline/02-technical-specification.md as DATA, plus the
 * engineer capability profiles, the deputy delegation policy and the
 * documented role boundaries.
 *
 * Two representations deliberately coexist and the T-02 suite cross-checks
 * them against each other and the engine:
 *
 *  1. AUTHORIZATION_MATRIX - the human table (13 rows x 6 persona columns),
 *     cell-for-cell as written in the specification. It records the PROPOSED
 *     authority ceiling per persona family, pending stakeholder ratification.
 *  2. CAPABILITY_SATISFIES / field-read capability sets / lifecycle classes -
 *     the evaluation tables the engine consults. They are constrained by the
 *     matrix: a satisfaction entry may never exceed the matrix ceiling for
 *     the role that carries it.
 *
 * Concrete authority in any deployment comes from Assignment grants (the
 * fixture world in fixtures/contracts/principals.json). Where a fixture grant
 * is narrower than the matrix ceiling (for example the fixture field engineer
 * holds no review-data capability, and the fixture commissioner holds no
 * create-sites grant), the grant wins - the engine evaluates grants, and the
 * matrix documents what a steward may eventually grant.
 */
import type { Capability, EngineerProfile, FieldClass, RoleFamily } from './types.ts';

/** Persona columns of the matrix (01-product-requirements.md "Personas and proposed permissions"). */
export type PersonaKey = 'donna' | 'wiley' | 'sarah' | 'cody' | 'fatima' | 'diego';

export interface Persona {
  readonly key: PersonaKey;
  readonly name: string;
  readonly roleFamily: RoleFamily;
  readonly description: string;
  /** Donna browses without any identity at all. */
  readonly anonymous: boolean;
}

export const PERSONAS: readonly Persona[] = [
  { key: 'donna', name: 'Donna', roleFamily: 'public', description: 'Public user or policy reader; no login, no edit authority regardless of civic status.', anonymous: true },
  { key: 'wiley', name: 'Wiley', roleFamily: 'water-user', description: 'Registered water user; own preferences and organization-assigned records only.', anonymous: false },
  { key: 'sarah', name: 'Sarah', roleFamily: 'researcher', description: 'Researcher/consultant; approved dataset grants and own scoped credentials.', anonymous: false },
  { key: 'cody', name: 'Cody', roleFamily: 'commissioner', description: 'Commissioner (deputy via explicit time-bounded delegation); assigned system operations.', anonymous: false },
  { key: 'fatima', name: 'Fatima', roleFamily: 'engineer', description: 'Engineer family (field/automation/regional/modeler profiles); assigned systems.', anonymous: false },
  { key: 'diego', name: 'Diego', roleFamily: 'steward', description: 'Statewide data steward: users, assignments, vocabulary, systems, ingestion, QC.', anonymous: false },
];

/** Matrix cell semantics. `grant` keeps the exact wording of the specification table. */
export type MatrixCell =
  | { readonly effect: 'public'; readonly grant: 'Public' }
  | { readonly effect: 'own-account'; readonly grant: string }
  | { readonly effect: 'assigned'; readonly grant: string }
  | { readonly effect: 'none'; readonly grant: string }
  | { readonly effect: 'future'; readonly grant: string };

export interface MatrixRow {
  /** Row id == the representative capability verb. */
  readonly id: Capability;
  /** Row label exactly as in the specification table. */
  readonly label: string;
  readonly cells: Readonly<Record<PersonaKey, MatrixCell>>;
  readonly note?: string;
}

/**
 * The proposed authorization matrix, every row of the specification table.
 * Cell text is quoted verbatim from
 * docs/product/baseline/02-technical-specification.md ("Proposed
 * authorization matrix"). All grants require stakeholder ratification before
 * production.
 */
export const AUTHORIZATION_MATRIX: readonly MatrixRow[] = [
  {
    id: 'browse-published',
    label: 'Browse published stations/series',
    cells: {
      donna: { effect: 'public', grant: 'Public' },
      wiley: { effect: 'public', grant: 'Public' },
      sarah: { effect: 'public', grant: 'Public' },
      cody: { effect: 'public', grant: 'Public' },
      fatima: { effect: 'public', grant: 'Public' },
      diego: { effect: 'public', grant: 'Public' },
    },
  },
  {
    id: 'manage-own-preferences',
    label: 'Save favorites and personal alerts',
    cells: {
      donna: { effect: 'own-account', grant: 'Login needed' },
      wiley: { effect: 'own-account', grant: 'Own preferences' },
      sarah: { effect: 'own-account', grant: 'Own preferences' },
      cody: { effect: 'own-account', grant: 'Own preferences' },
      fatima: { effect: 'own-account', grant: 'Own preferences' },
      diego: { effect: 'own-account', grant: 'Own preferences' },
    },
    note: 'Favoriting never creates edit, ownership or restricted-read entitlement (see DOCUMENTED_BOUNDARIES).',
  },
  {
    id: 'view-restricted-details',
    label: 'View restricted operational details',
    cells: {
      donna: { effect: 'none', grant: 'No' },
      wiley: { effect: 'assigned', grant: 'Assigned organization data only' },
      sarah: { effect: 'assigned', grant: 'Explicit approved dataset grant' },
      cody: { effect: 'assigned', grant: 'Assigned' },
      fatima: { effect: 'assigned', grant: 'Assigned' },
      diego: { effect: 'assigned', grant: 'Statewide administration' },
    },
  },
  {
    id: 'enter-readings',
    label: 'Enter readings and revise best available',
    cells: {
      donna: { effect: 'none', grant: 'No' },
      wiley: { effect: 'none', grant: 'No by default' },
      sarah: { effect: 'none', grant: 'No' },
      cody: { effect: 'assigned', grant: 'Assigned' },
      fatima: { effect: 'assigned', grant: 'Assigned' },
      diego: { effect: 'assigned', grant: 'Statewide, audited' },
    },
  },
  {
    id: 'edit-site-metadata',
    label: 'Change site metadata/photos',
    cells: {
      donna: { effect: 'none', grant: 'No' },
      wiley: { effect: 'none', grant: 'No by default' },
      sarah: { effect: 'none', grant: 'No' },
      cody: { effect: 'assigned', grant: 'Assigned permitted fields' },
      fatima: { effect: 'assigned', grant: 'Assigned permitted fields' },
      diego: { effect: 'assigned', grant: 'Statewide' },
    },
    note: 'The commissioner variant edit-permitted-site-fields is deliberately weaker than full edit-site-metadata; field-subset enforcement lands with the site-metadata field contract (WD-010).',
  },
  {
    id: 'create-sites',
    label: 'Create sites/streams',
    cells: {
      donna: { effect: 'none', grant: 'No' },
      wiley: { effect: 'none', grant: 'No' },
      sarah: { effect: 'none', grant: 'No' },
      cody: { effect: 'assigned', grant: 'Separate explicit grant' },
      fatima: { effect: 'assigned', grant: 'Assigned systems' },
      diego: { effect: 'assigned', grant: 'Statewide' },
    },
    note: 'The fixture commissioner holds no create-sites grant: "separate explicit grant" means an ordinary commissioner assignment must NOT satisfy it.',
  },
  {
    id: 'review-data',
    label: 'Review data and change processing status',
    cells: {
      donna: { effect: 'none', grant: 'No' },
      wiley: { effect: 'none', grant: 'No' },
      sarah: { effect: 'none', grant: 'No' },
      cody: { effect: 'assigned', grant: 'Assigned, permitted transition' },
      fatima: { effect: 'assigned', grant: 'Assigned, permitted transition' },
      diego: { effect: 'assigned', grant: 'Statewide' },
    },
  },
  {
    id: 'manage-vocabulary',
    label: 'Change universal metadata/systems',
    cells: {
      donna: { effect: 'none', grant: 'No' },
      wiley: { effect: 'none', grant: 'No' },
      sarah: { effect: 'none', grant: 'No' },
      cody: { effect: 'none', grant: 'No' },
      fatima: { effect: 'none', grant: 'No' },
      diego: { effect: 'assigned', grant: 'Yes' },
    },
  },
  {
    id: 'manage-users',
    label: 'Manage application users/assignments',
    cells: {
      donna: { effect: 'none', grant: 'No' },
      wiley: { effect: 'none', grant: 'No' },
      sarah: { effect: 'none', grant: 'No' },
      cody: { effect: 'none', grant: 'No' },
      fatima: { effect: 'none', grant: 'No' },
      diego: { effect: 'assigned', grant: 'Yes' },
    },
  },
  {
    id: 'configure-ingestion',
    label: 'Configure ingestion provider credentials',
    cells: {
      donna: { effect: 'none', grant: 'No' },
      wiley: { effect: 'none', grant: 'No' },
      sarah: { effect: 'none', grant: 'No' },
      cody: { effect: 'none', grant: 'No' },
      fatima: { effect: 'assigned', grant: 'Request/delegation only' },
      diego: { effect: 'assigned', grant: 'Yes' },
    },
    note: 'Engineers may request; only the request-ingestion-configuration capability exists for the engineer family, never configure-ingestion.',
  },
  {
    id: 'withdraw-raw',
    label: 'Exclude erroneous original readings',
    cells: {
      donna: { effect: 'none', grant: 'No' },
      wiley: { effect: 'none', grant: 'No' },
      sarah: { effect: 'none', grant: 'No' },
      cody: { effect: 'none', grant: 'No' },
      fatima: { effect: 'assigned', grant: 'Automation capability only, proposed review' },
      diego: { effect: 'assigned', grant: 'Explicit governance capability' },
    },
    note: 'Raw withdrawal is an exclusion/tombstone with retained provenance (FR-039), never physical deletion.',
  },
  {
    id: 'manage-own-tokens',
    label: 'Generate research API credential',
    cells: {
      donna: { effect: 'none', grant: 'No' },
      wiley: { effect: 'own-account', grant: 'Optional scoped account' },
      sarah: { effect: 'own-account', grant: 'Approved scopes' },
      cody: { effect: 'own-account', grant: 'Optional scoped account' },
      fatima: { effect: 'own-account', grant: 'Optional scoped account' },
      diego: { effect: 'own-account', grant: 'Own scope or administration' },
    },
    note: 'A token can never exceed its account current authority (FR-064); token objects are own-account objects.',
  },
  {
    id: 'supplier-reporting',
    label: 'Water supplier reporting/boundary proposals',
    cells: {
      donna: { effect: 'none', grant: 'No' },
      wiley: { effect: 'future', grant: 'Assigned supplier, later module' },
      sarah: { effect: 'none', grant: 'No' },
      cody: { effect: 'none', grant: 'No' },
      fatima: { effect: 'none', grant: 'No by default' },
      diego: { effect: 'future', grant: 'Separate Water Use Manager role' },
    },
    note: 'R2 module (PRD release boundaries). No MVP grant satisfies supplier-reporting; the engine denies it everywhere.',
  },
];

/**
 * Engineer capability profiles (technical specification matrix notes:
 * "Field, regional, automation and modeler are capability profiles under the
 * engineer family; modelers do not automatically gain correction or hardware
 * privileges"). Each profile is a SUBSET of the engineer family ceiling; a
 * steward grants one profile's verbs, never the family by name.
 */
export const ENGINEER_PROFILES: Readonly<Record<EngineerProfile, readonly Capability[]>> = {
  field: [
    'enter-readings',
    'revise-best-available',
    'edit-site-metadata',
    'create-sites',
    'field-visits',
    'view-internal-diagnostics',
  ],
  automation: [
    'enter-readings',
    'revise-best-available',
    'edit-site-metadata',
    'create-sites',
    'field-visits',
    'view-internal-diagnostics',
    // Automation-only: raw withdrawal is distinct from correction (FR-039).
    'withdraw-raw',
  ],
  regional: [
    'enter-readings',
    'revise-best-available',
    'edit-site-metadata',
    'create-sites',
    'field-visits',
    'view-internal-diagnostics',
    'view-restricted-details',
    // Matrix row "Configure ingestion": engineers may request only.
    'request-ingestion-configuration',
  ],
  modeler: [
    // No correction, no entry, no hardware, no withdrawal for modelers.
    'view-internal-diagnostics',
    'create-exports',
  ],
};

/** Union of every engineer profile verb: the ceiling a steward may grant inside the engineer family. */
export const ENGINEER_FAMILY_CEILING: readonly Capability[] = [
  ...new Set(Object.values(ENGINEER_PROFILES).flat()),
];

/**
 * Capabilities each role family may hold at most (derived from the matrix
 * columns). Grant-time guard for the steward console; the engine itself
 * evaluates concrete grants and never infers authority from a role label.
 */
export const ROLE_CEILING: Readonly<Record<RoleFamily, readonly Capability[]>> = {
  public: ['browse-published'],
  'water-user': ['browse-published', 'manage-own-preferences', 'manage-own-tokens', 'view-restricted-details', 'supplier-reporting'],
  owner: ['browse-published', 'manage-own-preferences', 'manage-own-tokens', 'view-restricted-details', 'supplier-reporting'],
  researcher: ['browse-published', 'manage-own-preferences', 'manage-own-tokens', 'read-approved-datasets', 'create-exports'],
  commissioner: ['browse-published', 'manage-own-preferences', 'manage-own-tokens', 'view-restricted-details', 'enter-readings', 'revise-best-available', 'edit-permitted-site-fields', 'create-sites', 'review-data', 'generate-reports'],
  deputy: ['browse-published', 'manage-own-preferences', 'manage-own-tokens', 'view-restricted-details', 'enter-readings', 'revise-best-available', 'edit-permitted-site-fields', 'review-data', 'generate-reports'],
  engineer: ENGINEER_FAMILY_CEILING,
  steward: [
    'browse-published',
    'manage-own-preferences',
    'manage-own-tokens',
    'statewide-administration',
    'manage-users',
    'manage-assignments',
    'manage-vocabulary',
    'configure-ingestion',
    'review-data',
    'enter-readings',
    'revise-best-available',
    'edit-site-metadata',
    'create-sites',
    'view-internal-diagnostics',
    'view-restricted-details',
    'withdraw-raw',
    'generate-reports',
    'create-exports',
    'read-approved-datasets',
  ],
};

/** Deputy delegation policy: explicit, time-bounded, audited; never statewide by default. */
export const DEPUTY_DELEGATION_POLICY = {
  requiresDelegation: true,
  statewideByDefault: false as const,
  /** A deputy grant whose scope is statewide is structurally invalid and denies. */
  statewideDeputyIsInvalid: true as const,
  /** Delegation window is half-open [effectiveAt, expiresAt); checked against the injected clock. */
  interval: 'half-open' as const,
  note: 'A deputy is scoped through an explicit delegation with effective and expiry dates (technical specification, authorization matrix notes).',
};

/** Boundaries the specification states in prose; T-02 asserts each one holds in the engine. */
export interface DocumentedBoundary {
  readonly id: string;
  readonly statement: string;
  /** Capability-looking strings that must remain unsatisfiable - deny for every principal, including the steward. */
  readonly unsatisfiableActions?: readonly string[];
}

export const DOCUMENTED_BOUNDARIES: readonly DocumentedBoundary[] = [
  {
    id: 'favoriting-grants-nothing',
    statement: 'Saving a favorite or personal alert is an own-preference action only; it never confers edit, ownership or restricted-read entitlement on the favorited site (PRD Wiley boundary, FR-052).',
  },
  {
    id: 'steward-not-infrastructure',
    statement: "Diego's statewide dashboard administration does not grant cloud infrastructure ownership, NeoServer super-admin/workspace-editor or database-owner access.",
    unsatisfiableActions: [
      'manage-cloud-infrastructure',
      'neoserver-super-admin',
      'neoserver-workspace-editor',
      'database-owner',
    ],
  },
  {
    id: 'deputy-explicit-delegation',
    statement: 'A deputy acts only through an explicit, time-bounded, audited delegation and is never statewide by default.',
  },
  {
    id: 'engineer-variants-no-implicit-privilege',
    statement: 'Engineer capability profiles grant subsets; a modeler assignment does not automatically gain correction, hardware or raw-withdrawal authority; each action needs the corresponding approved capability and object scope.',
  },
  {
    id: 'neoserver-roles-separate',
    statement: "NeoServer's global super_admin and workspace admin/editor/viewer roles are separate from this domain policy; a business commissioner or steward is never mapped straight to NeoServer editor.",
  },
];

/**
 * Actions satisfiable by the public read branch:
 * allow_public_read = explicit_public_read_action AND object_is_currently_published
 * AND fields_are_in_public_projection.
 */
export const PUBLIC_ACTIONS: ReadonlySet<string> = new Set(['browse-published']);

/**
 * Which granted capabilities satisfy a requested action. This is where the
 * matrix meets the fixture vocabulary:
 * - an action is always satisfied by an identical grant;
 * - statewide-administration (steward) satisfies every operational verb the
 *   matrix gives Diego statewide;
 * - viewing restricted operational details is satisfied by any operational
 *   capability scoped over the object (matrix row 3 "Assigned"), enumerated
 *   in RESTRICTED_FIELD_READ_CAPABILITIES;
 * - edit-permitted-site-fields satisfies edit-site-metadata because the
 *   commissioner variant IS the matrix row 5 "Assigned permitted fields"
 *   grant (field-subset refinement arrives with WD-010).
 * Nothing here may exceed ROLE_CEILING for the role that carries the grant.
 */
export const CAPABILITY_SATISFIES: Readonly<Record<string, readonly Capability[]>> = {
  'browse-published': ['browse-published'],
  'manage-own-preferences': ['manage-own-preferences'],
  'view-restricted-details': [
    'view-restricted-details',
    'enter-readings',
    'revise-best-available',
    'edit-site-metadata',
    'edit-permitted-site-fields',
    'create-sites',
    'review-data',
    'field-visits',
    'view-internal-diagnostics',
    'generate-reports',
    'create-exports',
    'read-approved-datasets',
    'statewide-administration',
  ],
  'enter-readings': ['enter-readings', 'statewide-administration'],
  'revise-best-available': ['revise-best-available', 'statewide-administration'],
  'edit-site-metadata': ['edit-site-metadata', 'edit-permitted-site-fields', 'statewide-administration'],
  'edit-permitted-site-fields': ['edit-permitted-site-fields', 'edit-site-metadata', 'statewide-administration'],
  'create-sites': ['create-sites', 'statewide-administration'],
  'review-data': ['review-data', 'statewide-administration'],
  'manage-vocabulary': ['manage-vocabulary', 'statewide-administration'],
  'manage-users': ['manage-users', 'statewide-administration'],
  'manage-assignments': ['manage-assignments', 'statewide-administration'],
  'configure-ingestion': ['configure-ingestion', 'statewide-administration'],
  // The engineer "Request/delegation only" verb is NOT satisfied by configure-ingestion.
  'request-ingestion-configuration': ['request-ingestion-configuration'],
  // Raw withdrawal: automation capability, or the steward governance capability.
  'withdraw-raw': ['withdraw-raw', 'statewide-administration'],
  'manage-own-tokens': ['manage-own-tokens'],
  'supplier-reporting': ['supplier-reporting'],
  'field-visits': ['field-visits', 'statewide-administration'],
  'view-internal-diagnostics': ['view-internal-diagnostics', 'statewide-administration'],
  'read-approved-datasets': ['read-approved-datasets', 'statewide-administration'],
  'create-exports': ['create-exports', 'statewide-administration'],
  'generate-reports': ['generate-reports', 'statewide-administration'],
  'statewide-administration': ['statewide-administration'],
};

/**
 * Capabilities that permit reading restricted-class fields of an object the
 * grant covers (matrix row 3). Restricted row visibility is necessary but not
 * sufficient: field classes are checked independently (FR-049).
 */
export const RESTRICTED_FIELD_READ_CAPABILITIES: ReadonlySet<string> = new Set([
  ...CAPABILITY_SATISFIES['view-restricted-details'],
]);

/**
 * Capabilities that permit reading internal-class fields (gate codes, wiring
 * notes, diagnostics). Intentionally narrow: an assignment over an object
 * does NOT expose its internal block.
 */
export const INTERNAL_FIELD_READ_CAPABILITIES: ReadonlySet<string> = new Set([
  'view-internal-diagnostics',
  'edit-site-metadata',
  'statewide-administration',
]);

/**
 * Lifecycle classes for the "lifecycle_allows_requested_change" clause.
 * - read: any lifecycle (visibility still applies);
 * - mutate: only active objects may receive readings, revisions, reviews,
 *   visits or withdrawals;
 * - draft-edit: site metadata may also be edited while proposed (the
 *   proposing engineer prepares the site; matrix row 6);
 * - admin: account/vocabulary/user administration is not object-lifecycle bound.
 * Finalized objects (submitted reports, finalized accounting - FR-029) admit
 * no mutation class at all.
 */
export type ActionLifecycleClass = 'read' | 'mutate' | 'draft-edit' | 'admin';

export const ACTION_LIFECYCLE_CLASS: Readonly<Record<string, ActionLifecycleClass>> = {
  'browse-published': 'read',
  'view-restricted-details': 'read',
  'view-internal-diagnostics': 'read',
  'read-approved-datasets': 'read',
  'generate-reports': 'read',
  'create-exports': 'read',
  'enter-readings': 'mutate',
  'revise-best-available': 'mutate',
  'review-data': 'mutate',
  'withdraw-raw': 'mutate',
  'field-visits': 'mutate',
  'create-sites': 'mutate',
  'edit-site-metadata': 'draft-edit',
  'edit-permitted-site-fields': 'draft-edit',
  'manage-own-preferences': 'admin',
  'manage-own-tokens': 'admin',
  'manage-users': 'admin',
  'manage-assignments': 'admin',
  'manage-vocabulary': 'admin',
  'configure-ingestion': 'admin',
  'request-ingestion-configuration': 'admin',
  'supplier-reporting': 'admin',
  'statewide-administration': 'admin',
};

export const LIFECYCLE_ALLOWED_STATES: Readonly<Record<ActionLifecycleClass, readonly string[]>> = {
  read: ['proposed', 'active', 'inactive', 'retired', 'finalized'],
  mutate: ['active'],
  'draft-edit': ['proposed', 'active'],
  admin: ['proposed', 'active', 'inactive', 'retired', 'finalized'],
};

/**
 * Own-account actions: satisfied by ownership of the object itself, no
 * assignment required (matrix rows 2 and 12). Preferences additionally
 * require the favorite target to be readable (PUT /me/favorites/{siteId}
 * "Add favorite only if published or otherwise readable").
 */
export const OWN_ACCOUNT_ACTIONS: Readonly<Record<string, string>> = {
  'manage-own-preferences': 'preference',
  'manage-own-tokens': 'token',
};
