/**
 * Session resolution boundary - the seam the institutional identity
 * provider will plug into.
 *
 * !!! DR-011 (OPEN DECISION) !!!
 * There is NO live identity provider yet. Production will integrate the
 * approved institutional IdP over OIDC Authorization Code with PKCE, and the
 * backend will validate issuer, audience, signature and expiry before
 * mapping immutable subject IDs to application assignments (technical
 * specification, "Identity and application permissions"). That validation
 * ARRIVES WITH THE INSTITUTIONAL IdP and is explicitly NOT implemented here.
 *
 * FixtureSessionResolver below is a STUB FOR STAGING FIXTURES ONLY: it
 * "resolves" opaque `fixture:<principalId>` selector tokens against
 * fixtures/contracts/principals.json. It performs zero cryptography and must
 * never be exposed outside fixture-driven staging. When DR-011 lands, keep
 * the SessionResolver interface and replace the implementation with the
 * OIDC-backed one (token introspection or verified JWT sessions).
 *
 * FR-010: identity is ALWAYS derived server-side from the session (or scoped
 * token). A body `actorId`, browser role switch or submitted owner ID is
 * never consulted - nothing in this module even accepts one.
 */
import { readFileSync } from 'node:fs';
import { parsePrincipal, type Principal } from '../../../../packages/policy/src/index.ts';

/** Resolves a presented credential to a principal, or null for anonymous/invalid. Must never throw for bad input. */
export interface SessionResolver {
  resolve(token: string): Promise<Principal | null>;
}

export interface FixtureSessionResolverOptions {
  /** Path or URL of principals.json. Defaults to the repository contract fixture. */
  fixturePath?: string | URL;
  /** Injection point for tests; defaults to node:fs readFileSync. */
  read?: (path: string | URL) => string;
}

/**
 * Fixture-backed in-memory SessionResolver (STAGING ONLY - see DR-011 note above).
 *
 * Token contract: the literal string `fixture:anonymous` (or any empty /
 * unrecognized token) resolves to null (anonymous). `fixture:<principalId>`
 * resolves to the fixture principal snapshot. Deactivated principals still
 * resolve - the policy engine denies them (DENY_PRINCIPAL_INACTIVE) while
 * audit history keeps the snapshot resolvable (FR-011).
 */
export class FixtureSessionResolver implements SessionResolver {
  private readonly options: FixtureSessionResolverOptions;
  private readonly principals = new Map<string, Principal>();
  private loaded = false;

  constructor(options: FixtureSessionResolverOptions = {}) {
    this.options = options;
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    const read = this.options.read ?? ((path: string | URL) => readFileSync(path, 'utf8'));
    const fixturePath = this.options.fixturePath ?? new URL('../../../../fixtures/contracts/principals.json', import.meta.url);
    const fixture = JSON.parse(read(fixturePath));
    for (const user of fixture.users ?? []) {
      const principal = parsePrincipal(user);
      this.principals.set(principal.id, principal);
    }
    this.loaded = true;
  }

  async resolve(token: string): Promise<Principal | null> {
    if (typeof token !== 'string' || token.length === 0) return null;
    if (token === 'fixture:anonymous') return null;
    if (!token.startsWith('fixture:')) return null; // unrecognized credential scheme -> anonymous, never an error into allow
    this.ensureLoaded();
    return this.principals.get(token.slice('fixture:'.length)) ?? null;
  }
}

/** A session as the authorize() boundary consumes it: a resolver plus the presented token (null when absent). */
export interface SessionContext {
  readonly resolver: SessionResolver;
  readonly token: string | null;
}

/** Convenience for anonymous requests: any resolver, no credential. */
export function anonymousSession(resolver: SessionResolver): SessionContext {
  return { resolver, token: null };
}
