/**
 * Provider and site ingestion CONFIGURATION registry (WD-014; FR-013).
 *
 * "A steward registers a provider and site ingestion configuration,
 * validates required parameters, and tests a connection in staging;
 * engineer requests can be submitted but cannot bypass the approved
 * ownership policy."
 *
 * SCOPE NOTE - MONITORING ONLY, NO NEW INGESTION PLATFORM. This module is
 * configuration plus health monitoring: provider definitions with typed
 * parameter schemas, site configuration records, a SIMULATED staging
 * connection test and the request/promote governance flow. It deliberately
 * implements no transport, no polling scheduler and no data pipeline - it
 * never touches a network (the transport is an injectable pure function).
 *
 * Rules implemented here:
 *
 * - Providers are registered by STEWARDS ONLY (capability
 *   `configure-ingestion`; satisfied statewide for the fixture steward).
 * - Site configurations validate their parameters against the provider's
 *   typed schema: unknown parameters are rejected, required parameters must
 *   be present, types must match, URL parameters must be credential-free
 *   https URLs. Secrets are stored for the (simulated) test but are NEVER
 *   serialized or echoed back - every view redacts them.
 * - The site's systemId is resolved SERVER-SIDE from the station object in
 *   the policy world (FR-010: membership never comes from the request body).
 * - ENGINEER BOUNDARY: an engineer holding `request-ingestion-configuration`
 *   (regional profile) may submit a REQUEST for a station inside their
 *   assignment scope; the request enters state `requested`. Only a steward
 *   can promote it to `configured`. An engineer calling register or promote
 *   is denied 403 - the request verb is NOT satisfied by
 *   configure-ingestion and vice versa (policy matrix row note).
 * - STAGING CONNECTION TEST: simulated transport with injectable failure
 *   modes (success / auth-failure / timeout). No real network. The outcome
 *   and its timestamp are recorded on the configuration; connections.ts
 *   derives connection health from these records.
 */
import type { PolicyObject, PolicyWorld } from '../../../../../packages/policy/src/index.ts';
import { gateAct, governanceObject, instantIso, withExtraObjects, type GateOutcome, type PolicyEvaluator } from './gate.ts';

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

export const PARAMETER_TYPES = ['string', 'secret', 'number', 'url'] as const;
export type ParameterType = (typeof PARAMETER_TYPES)[number];

export interface ParameterSpec {
  readonly key: string;
  readonly type: ParameterType;
  readonly required: boolean;
  /** Value pattern for string/secret/url parameters (validated with RegExp.test). */
  readonly pattern?: string;
  readonly description?: string;
}

export const PROVIDER_KINDS = ['telemetry', 'manual', 'api'] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

export interface ProviderRecord {
  readonly id: string;
  readonly name: string;
  readonly kind: ProviderKind;
  readonly parameterSchema: readonly ParameterSpec[];
  readonly status: 'active' | 'retired';
  readonly registeredBy: string;
  readonly registeredAt: string;
  readonly registryVersion: number;
}

export type IngestionConfigStatus = 'requested' | 'configured';

/** Simulated staging test outcomes (no real network; FR-014 connection health taxonomy). */
export const TEST_OUTCOMES = ['success', 'auth-failure', 'timeout'] as const;
export type TestOutcome = (typeof TEST_OUTCOMES)[number];

export interface ConnectionTestResult {
  readonly at: string;
  readonly outcome: TestOutcome;
  readonly latencyMs: number;
}

export interface SiteIngestionConfig {
  readonly id: string;
  readonly providerId: string;
  readonly stationId: string;
  /** Resolved server-side from the station object (never from the request body). */
  readonly systemId: string;
  readonly params: Readonly<Record<string, string>>;
  readonly status: IngestionConfigStatus;
  readonly requestedBy: string;
  readonly requestedAt: string;
  readonly promotedBy: string | null;
  readonly promotedAt: string | null;
  readonly lastConnectionTest: ConnectionTestResult | null;
}

export type IngestionAuditAction = 'register-provider' | 'register-config' | 'request-config' | 'promote-request' | 'connection-test';

export interface IngestionAuditEvent {
  readonly id: string;
  readonly at: string;
  readonly actorId: string;
  readonly action: IngestionAuditAction;
  readonly targetId: string;
  readonly detail: string;
  readonly registryVersion: number;
}

export type MutationDenial = { readonly ok: false; readonly denied: GateOutcome & { ok: false } };

// ---------------------------------------------------------------------------
// Pure validation (schema and parameters)
// ---------------------------------------------------------------------------

export const PARAMETER_KEY_PATTERN = /^[a-z][a-z0-9-]{0,39}$/;
export const PROVIDER_ID_PATTERN = /^prov-[a-z0-9][a-z0-9-]{0,63}$/;
export const CONFIG_ID_PREFIX = 'ing';
/** Credential-free https URLs only: scheme https, no userinfo, non-empty host. */
export const URL_PARAMETER_PATTERN = /^https:\/\/[a-z0-9][a-z0-9.-]*\.[a-z]{2,}(\/[^\s@]*)?$/i;

export type ParameterIssueCode = 'unknown-parameter' | 'missing-parameter' | 'bad-parameter-type' | 'bad-parameter-value';

export interface ParameterIssue {
  readonly code: ParameterIssueCode;
  readonly key: string;
}

/** Validate raw parameters against a provider's typed schema (pure). */
export function validateParameters(schema: readonly ParameterSpec[], params: Readonly<Record<string, unknown>>): readonly ParameterIssue[] {
  const issues: ParameterIssue[] = [];
  const specByKey = new Map(schema.map((spec) => [spec.key, spec]));

  for (const key of Object.keys(params)) {
    if (!specByKey.has(key)) issues.push({ code: 'unknown-parameter', key });
  }
  for (const spec of schema) {
    const raw = params[spec.key];
    const present = raw !== undefined && raw !== null && `${raw}`.length > 0;
    if (!present) {
      if (spec.required) issues.push({ code: 'missing-parameter', key: spec.key });
      continue;
    }
    if (spec.type === 'number') {
      if (typeof raw !== 'number' && !/^-?\d+(\.\d+)?$/.test(`${raw}`)) {
        issues.push({ code: 'bad-parameter-type', key: spec.key });
        continue;
      }
    } else if (typeof raw !== 'string') {
      issues.push({ code: 'bad-parameter-type', key: spec.key });
      continue;
    } else if (spec.type === 'url') {
      if (!URL_PARAMETER_PATTERN.test(raw)) issues.push({ code: 'bad-parameter-value', key: spec.key });
    } else if (spec.pattern !== undefined && !new RegExp(spec.pattern).test(raw)) {
      issues.push({ code: 'bad-parameter-value', key: spec.key });
    }
  }
  return issues;
}

export type ProviderSchemaIssueCode = 'bad-provider-id' | 'bad-provider-name' | 'unknown-provider-kind' | 'bad-parameter-key' | 'duplicate-parameter-key' | 'unknown-parameter-type' | 'bad-parameter-pattern';

/** Validate a provider registration (pure). */
export function validateProviderSchema(input: { id: string; name: string; kind: string; parameterSchema: readonly ParameterSpec[] }): readonly ProviderSchemaIssueCode[] {
  const issues: ProviderSchemaIssueCode[] = [];
  if (!PROVIDER_ID_PATTERN.test(input.id ?? '')) issues.push('bad-provider-id');
  if (typeof input.name !== 'string' || input.name.trim().length === 0) issues.push('bad-provider-name');
  if (!(PROVIDER_KINDS as readonly string[]).includes(input.kind)) issues.push('unknown-provider-kind');
  const keys = new Set<string>();
  for (const spec of input.parameterSchema ?? []) {
    if (!PARAMETER_KEY_PATTERN.test(spec?.key ?? '')) issues.push('bad-parameter-key');
    if (keys.has(spec?.key ?? '')) issues.push('duplicate-parameter-key');
    keys.add(spec?.key ?? '');
    const type = spec?.type as string | undefined;
    if (!type || !(PARAMETER_TYPES as readonly string[]).includes(type)) issues.push('unknown-parameter-type');
    if (spec?.pattern !== undefined) {
      try {
        void new RegExp(spec.pattern);
      } catch {
        issues.push('bad-parameter-pattern');
      }
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Simulated staging transport (no real network)
// ---------------------------------------------------------------------------

export interface TransportResult {
  readonly outcome: TestOutcome;
  readonly latencyMs: number;
}

/** Injectable simulated transport. Default: fixed per-mode latencies, zero I/O. */
export type SimulatedTransport = (input: { readonly providerId: string; readonly params: Readonly<Record<string, string>>; readonly mode: TestOutcome }) => TransportResult;

export function defaultSimulatedTransport(): SimulatedTransport {
  const latency: Readonly<Record<TestOutcome, number>> = { success: 120, 'auth-failure': 40, timeout: 5000 };
  return (input) => ({ outcome: input.mode, latencyMs: latency[input.mode] });
}

/** Build a transport scripted per mode (tests pin exact latencies). */
export function scriptedTransport(script: Readonly<Partial<Record<TestOutcome, TransportResult>>>): SimulatedTransport {
  return (input) => script[input.mode] ?? { outcome: input.mode, latencyMs: 0 };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface IngestionServiceDeps {
  readonly world: PolicyWorld;
  /** REQUIRED injected clock (no hidden Date.now reads; determinism is tested). */
  readonly clock: () => Date | string;
  readonly policy?: PolicyEvaluator;
  /** Simulated staging transport; default has NO I/O (documented: no real network). */
  readonly transport?: SimulatedTransport;
}

export interface RegisterProviderInput {
  readonly id: string;
  readonly name: string;
  readonly kind: ProviderKind | string;
  readonly parameterSchema: readonly ParameterSpec[];
}

export interface SiteConfigInput {
  readonly providerId: string;
  readonly stationId: string;
  readonly params: Readonly<Record<string, string>>;
}

export type ConfigErrorCode =
  | 'unknown-provider'
  | 'unknown-station'
  | 'retired-provider';

export interface ConfigView {
  readonly config: SiteIngestionConfig;
  /** Parameters with secret values replaced by '[redacted]' - secrets never leave the registry in clear. */
  readonly safeParams: Readonly<Record<string, string>>;
}

export interface IngestionService {
  /** Steward-only provider registration with a typed parameter schema. */
  registerProvider(principalId: string | null, input: Readonly<RegisterProviderInput>): { ok: true; provider: ProviderRecord } | { ok: false; errors: readonly ProviderSchemaIssueCode[] } | MutationDenial;
  /** Steward-only direct site configuration registration (state configured). */
  registerSiteConfig(principalId: string | null, input: Readonly<SiteConfigInput>): { ok: true; view: ConfigView } | { ok: false; errors: readonly (ParameterIssueCode | ConfigErrorCode)[] } | MutationDenial;
  /** Engineer request (capability request-ingestion-configuration, station inside the caller's scope). Enters state requested. */
  requestSiteConfig(principalId: string | null, input: Readonly<SiteConfigInput>): { ok: true; view: ConfigView } | { ok: false; errors: readonly (ParameterIssueCode | ConfigErrorCode)[] } | MutationDenial;
  /** Steward-only promotion of a request to configured (FR-013 ownership boundary). */
  promoteRequest(principalId: string | null, configId: string): { ok: true; view: ConfigView } | { ok: false; errors: readonly ('unknown-config' | 'already-configured')[] } | MutationDenial;
  /** Steward-only SIMULATED staging connection test; outcome recorded with a timestamp. */
  testConnection(principalId: string | null, configId: string, mode: TestOutcome): { ok: true; view: ConfigView } | { ok: false; errors: readonly 'unknown-config'[] } | MutationDenial;
  providers(): readonly ProviderRecord[];
  configs(): readonly ConfigView[];
  /** Engineer requests awaiting steward promotion (deterministic order). */
  pendingRequests(): readonly ConfigView[];
  config(configId: string): ConfigView | null;
  changeLog(): readonly IngestionAuditEvent[];
  registryVersion(): number;
  serialize(): string;
}

function providersRootObject(): PolicyObject {
  return governanceObject({ id: 'providers:root', kind: 'provider' });
}

function providerObject(id: string): PolicyObject {
  return governanceObject({ id: `provider:${id}`, kind: 'provider' });
}

function configObject(id: string, systemId: string): PolicyObject {
  return governanceObject({ id: `ingest:${id}`, kind: 'provider', systemId });
}

const REDACTED = '[redacted]';

export function createIngestionService(deps: IngestionServiceDeps): IngestionService {
  const clock = deps.clock;
  const policy = deps.policy;
  const transport = deps.transport ?? defaultSimulatedTransport();
  const providers: ProviderRecord[] = [];
  const configs: SiteIngestionConfig[] = [];
  const audit: IngestionAuditEvent[] = [];
  let version = 0;
  let auditCounter = 0;
  let configCounter = 0;

  const nextVersion = (): number => {
    version += 1;
    return version;
  };
  const nextAuditId = (): string => `ie-${String((auditCounter += 1)).padStart(6, '0')}`;
  const nextConfigId = (): string => `${CONFIG_ID_PREFIX}-${String((configCounter += 1)).padStart(6, '0')}`;
  const now = (): string => instantIso(clock());

  const gate = (principalId: string | null, action: string, object: PolicyObject[], target: { kind: string; id: string }): GateOutcome =>
    gateAct({ world: withExtraObjects(deps.world, object), clock, policy }, principalId, action, { kind: target.kind, id: target.id });

  const deny = (outcome: GateOutcome & { ok: false }): MutationDenial => ({ ok: false, denied: outcome });

  const recordAudit = (actorId: string | null, action: IngestionAuditAction, targetId: string, detail: string): void => {
    audit.push(Object.freeze({ id: nextAuditId(), at: now(), actorId: actorId ?? '', action, targetId, detail, registryVersion: version }));
  };

  const view = (config: SiteIngestionConfig): ConfigView => {
    const schema = providers.find((provider) => provider.id === config.providerId)?.parameterSchema ?? [];
    const safeParams: Record<string, string> = {};
    for (const [key, value] of Object.entries(config.params)) {
      const spec = schema.find((candidate) => candidate.key === key);
      safeParams[key] = spec?.type === 'secret' ? REDACTED : value;
    }
    // The view's embedded config carries the REDACTED parameters: secrets
    // never leave the registry in clear through any read surface.
    const safeConfig = Object.freeze({ ...config, params: Object.freeze(safeParams) });
    return Object.freeze({ config: safeConfig, safeParams: Object.freeze(safeParams) });
  };

  const stationGateObject = (stationId: string): PolicyObject | null => {
    const station = deps.world.objects[stationId];
    return station ?? null;
  };

  /** Shared site-config body validation + creation. `direct` skips the request state (steward registration). */
  const upsertSiteConfig = (
    actorId: string | null,
    action: 'register-config' | 'request-config',
    input: Readonly<SiteConfigInput>,
    direct: boolean,
  ): { ok: true; view: ConfigView } | { ok: false; errors: readonly (ParameterIssueCode | ConfigErrorCode)[] } | MutationDenial => {
    const station = stationGateObject(input.stationId);
    const gateAction = direct ? 'configure-ingestion' : 'request-ingestion-configuration';
    const gateObject = station ?? governanceObject({ id: input.stationId, kind: 'station' });
    const verdict = gate(actorId, gateAction, [gateObject], { kind: 'station', id: input.stationId });
    if (!verdict.ok) return deny(verdict);

    const errors: (ParameterIssueCode | ConfigErrorCode)[] = [];
    const provider = providers.find((candidate) => candidate.id === input.providerId);
    if (!provider) errors.push('unknown-provider');
    else if (provider.status === 'retired') errors.push('retired-provider');
    if (!station || station.kind !== 'station') errors.push('unknown-station');
    if (provider && station) {
      for (const issue of validateParameters(provider.parameterSchema, input.params)) errors.push(issue.code);
    }
    if (errors.length > 0) return { ok: false, errors };

    nextVersion();
    const id = nextConfigId();
    const at = now();
    const config: SiteIngestionConfig = Object.freeze({
      id,
      providerId: input.providerId,
      stationId: input.stationId,
      systemId: station!.systemId!,
      params: Object.freeze({ ...input.params }),
      status: direct ? 'configured' : 'requested',
      requestedBy: actorId ?? '',
      requestedAt: at,
      promotedBy: direct ? actorId ?? '' : null,
      promotedAt: direct ? at : null,
      lastConnectionTest: null,
    });
    configs.push(config);
    recordAudit(actorId, action, id, `${input.stationId} via ${input.providerId} -> ${config.status}`);
    return { ok: true, view: view(config) };
  };

  const mutateConfig = (
    actorId: string | null,
    configId: string,
    action: 'configure-ingestion',
    apply: (config: SiteIngestionConfig, at: string) => SiteIngestionConfig,
    auditAction: IngestionAuditAction,
    auditDetail: (config: SiteIngestionConfig) => string,
  ): { ok: true; view: ConfigView } | { ok: false; errors: readonly 'unknown-config'[] } | MutationDenial => {
    const index = configs.findIndex((candidate) => candidate.id === configId);
    const config = index >= 0 ? configs[index]! : null;
    const gateObject = config ? configObject(config.id, config.systemId) : governanceObject({ id: `ingest:${configId}`, kind: 'provider' });
    const verdict = gate(actorId, action, [gateObject], { kind: 'provider', id: gateObject.id });
    if (!verdict.ok) return deny(verdict);
    if (!config) return { ok: false, errors: ['unknown-config'] as const };

    nextVersion();
    const at = now();
    const updated = apply(config, at);
    configs[index!] = updated;
    recordAudit(actorId, auditAction, config.id, auditDetail(updated));
    return { ok: true, view: view(updated) };
  };

  return {
    registerProvider(principalId, input) {
      const verdict = gate(principalId, 'configure-ingestion', [providersRootObject(), providerObject(input.id ?? '')], { kind: 'provider', id: providersRootObject().id });
      if (!verdict.ok) return deny(verdict);
      const errors = validateProviderSchema(input as { id: string; name: string; kind: string; parameterSchema: readonly ParameterSpec[] });
      if (errors.length > 0) return { ok: false, errors };
      if (providers.some((provider) => provider.id === input.id)) return { ok: false, errors: ['bad-provider-id'] as const };

      const registeredAt = now();
      const provider: ProviderRecord = Object.freeze({
        id: input.id,
        name: input.name.trim(),
        kind: input.kind as ProviderKind,
        parameterSchema: Object.freeze(input.parameterSchema.map((spec) => Object.freeze({ ...spec }))),
        status: 'active',
        registeredBy: principalId ?? '',
        registeredAt,
        registryVersion: nextVersion(),
      });
      providers.push(provider);
      recordAudit(principalId, 'register-provider', provider.id, `${provider.name} (${provider.kind}) with ${provider.parameterSchema.length} parameters`);
      return { ok: true, provider };
    },

    registerSiteConfig(principalId, input) {
      return upsertSiteConfig(principalId, 'register-config', input, true);
    },

    requestSiteConfig(principalId, input) {
      return upsertSiteConfig(principalId, 'request-config', input, false);
    },

    promoteRequest(principalId, configId) {
      const config = configs.find((candidate) => candidate.id === configId);
      if (config && config.status === 'configured') {
        // Gate first even for a no-op target: engineers must not probe state.
        const verdict = gate(principalId, 'configure-ingestion', [configObject(config.id, config.systemId)], { kind: 'provider', id: `ingest:${config.id}` });
        if (!verdict.ok) return deny(verdict);
        return { ok: false, errors: ['already-configured'] as const };
      }
      return mutateConfig(principalId, configId, 'configure-ingestion', (current, at) => ({ ...current, status: 'configured', promotedBy: principalId ?? '', promotedAt: at }), 'promote-request', (current) => `promoted ${current.id} (requested by ${current.requestedBy})`);
    },

    testConnection(principalId, configId, mode) {
      return mutateConfig(
        principalId,
        configId,
        'configure-ingestion',
        (current, at) => {
          const result = transport({ providerId: current.providerId, params: current.params, mode });
          return { ...current, lastConnectionTest: Object.freeze({ at, outcome: result.outcome, latencyMs: result.latencyMs }) };
        },
        'connection-test',
        (current) => `staging test ${current.lastConnectionTest?.outcome ?? mode} (${current.lastConnectionTest?.latencyMs ?? 0} ms)`,
      );
    },

    providers() {
      return [...providers];
    },

    configs() {
      return configs.map(view);
    },

    pendingRequests() {
      return configs.filter((config) => config.status === 'requested').map(view);
    },

    config(configId) {
      const found = configs.find((candidate) => candidate.id === configId);
      return found ? view(found) : null;
    },

    changeLog() {
      return [...audit];
    },

    registryVersion() {
      return version;
    },

    serialize() {
      // Secrets never serialize: every written config goes through the redacting view.
      return JSON.stringify(
        { registryVersion: version, providers, configs: configs.map((config) => view(config).config), audit },
        null,
        0,
      );
    },
  };
}
