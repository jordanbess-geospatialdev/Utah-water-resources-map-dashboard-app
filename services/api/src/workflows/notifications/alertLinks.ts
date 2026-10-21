/**
 * Alert links that repeat the authorization check on use (WD-015; FR-025:
 * "the alert link repeats the authorization check"; FR-010 boundaries).
 *
 * Every digest entry and test event carries a link reference. The link is a
 * bare, deterministic route to the event - it encodes NO membership, NO
 * scope, NO credentials and NO authority: by itself it grants nothing and
 * reveals nothing. Opening it RESOLVES through this registry, which re-runs
 * the entitlement engine against the CURRENT world snapshot at resolve time:
 *
 * - the recipient's grants were revoked, expired or deactivated since the
 *   digest was built -> the link resolves to DENIED (tested);
 * - the object is outside the recipient's current scope -> DENIED;
 * - the link target is unknown -> 404, never a fallback view.
 *
 * Like WD-015's delivery channel this is deliberately infrastructure-free:
 * the resolver is a pure decision over an injected world + clock, ready to
 * sit behind an authenticated GET /alerts/{eventId} without change.
 */
import type { Decision } from '../../../../../packages/policy/src/index.ts';
import { admitEvent, type NotificationDeps } from './subscriptions.ts';
import type { NotificationEvent } from './types.ts';

/** Link route prefix (a display/dashboard path, never an API grant). */
export const ALERT_LINK_ROUTE = '/alerts';

/** The link reference carried by every digest entry: `/alerts/{eventId}`. */
export function alertLinkFor(event: NotificationEvent): string {
  return `${ALERT_LINK_ROUTE}/${encodeURIComponent(event.id)}`;
}

/** Inverse of alertLinkFor: the event id a link refers to (null if malformed). */
export function parseAlertLink(link: string): string | null {
  if (typeof link !== 'string' || !link.startsWith(`${ALERT_LINK_ROUTE}/`)) return null;
  const raw = decodeURIComponent(link.slice(ALERT_LINK_ROUTE.length + 1));
  return raw.length > 0 ? raw : null;
}

// ---------------------------------------------------------------------------
// Registry + resolver
// ---------------------------------------------------------------------------

export type AlertResolution =
  | { readonly ok: true; readonly event: NotificationEvent; readonly resolvedAt: string }
  | { readonly ok: false; readonly status: 401 | 403 | 404; readonly reason: string; readonly detail: string; readonly decision: Decision | null };

export interface AlertLinkRegistry {
  /** Register an event (idempotent by event id); returns its link reference. */
  register(event: NotificationEvent): string;
  /** RE-RUN authorization at resolve time against the CURRENT world. */
  resolve(principalId: string | null, link: string): AlertResolution;
  size(): number;
}

/**
 * Build the alert-link registry. `deps.world` may be a snapshot PROVIDER so
 * that a revocation performed after links were minted is visible to the very
 * next resolve (FR-011 "revocation affects the next authorized request").
 */
export function createAlertLinkRegistry(deps: NotificationDeps | Omit<NotificationDeps, 'channel'>): AlertLinkRegistry {
  const events = new Map<string, NotificationEvent>();
  return {
    register(event) {
      if (!events.has(event.id)) events.set(event.id, event);
      return alertLinkFor(event);
    },
    resolve(principalId, link) {
      const eventId = parseAlertLink(link);
      if (eventId === null) {
        return { ok: false, status: 404, reason: 'DENY_MALFORMED_LINK', detail: `not an alert link: "${link}"`, decision: null };
      }
      const event = events.get(eventId);
      if (!event) {
        return { ok: false, status: 404, reason: 'DENY_UNKNOWN_OBJECT', detail: `no registered alert event "${eventId}"`, decision: null };
      }
      // THE re-authorization: current world snapshot, injected clock, engine.
      const admission = admitEvent(deps, principalId, event);
      if (!admission.ok) {
        return { ok: false, status: admission.status, reason: admission.reason, detail: admission.detail, decision: admission.decision };
      }
      const now = deps.clock();
      const resolvedAt = typeof now === 'string' ? now : new Date(now.getTime()).toISOString();
      return { ok: true, event, resolvedAt };
    },
    size() {
      return events.size;
    },
  };
}
