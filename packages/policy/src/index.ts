/**
 * @utah-water/policy - stable public API.
 *
 * Everything the server boundary (services/api/src/auth) and future workers
 * need to evaluate entitlements. This barrel is the compatibility surface:
 * keep exports additive; bump POLICY_VERSION on any observable behavior
 * change (docs/product/baseline/02-technical-specification.md, "Identity and
 * application permissions").
 */
export { POLICY_VERSION } from './types.ts';

export type {
  ActorSnapshot,
  Assignment,
  AuthorizationRequest,
  Capability,
  Decision,
  DecisionReason,
  Delegation,
  FieldClass,
  LifecycleState,
  ObjectKind,
  PolicyObject,
  PolicyWorld,
  Principal,
  PrincipalsFixture,
  RawEntitlement,
  RoleFamily,
  Scope,
  ScopeKind,
  StationsFixture,
  EngineerProfile,
} from './types.ts';

export {
  parsePrincipal,
  parseEntitlement,
  buildWorld,
  withPrincipal,
  withEntitlement,
  resolveActor,
  assignmentVersionOf,
  capabilitiesOf,
  evaluate,
  evaluatePublicRead,
  isCurrentlyPublished,
  satisfiesCapability,
} from './engine.ts';

export {
  PERSONAS,
  AUTHORIZATION_MATRIX,
  ENGINEER_PROFILES,
  ENGINEER_FAMILY_CEILING,
  ROLE_CEILING,
  DEPUTY_DELEGATION_POLICY,
  DOCUMENTED_BOUNDARIES,
  PUBLIC_ACTIONS,
  CAPABILITY_SATISFIES,
  RESTRICTED_FIELD_READ_CAPABILITIES,
  INTERNAL_FIELD_READ_CAPABILITIES,
  ACTION_LIFECYCLE_CLASS,
  LIFECYCLE_ALLOWED_STATES,
  OWN_ACCOUNT_ACTIONS,
} from './matrix.ts';

export type { Persona, PersonaKey, MatrixCell, MatrixRow, DocumentedBoundary, ActionLifecycleClass } from './matrix.ts';
