/**
 * The six WD-006 persona entry points, mapped onto the fixture principals
 * from principals.json (seed utah-water-fixture-v1).
 *
 * The persona selector in the shell is explicitly a demonstration control,
 * not a security boundary; the viewer objects below only drive the demo
 * projection in projection.ts. Real authorization is server-side (WD-004).
 *
 * Wiley (water user) has no fixture user record: principals.json carries two
 * water-owner organizations but no member account, so his viewer is
 * synthesized from org-cache-water (the owner of sta-hyrum-diversion-owner)
 * and clearly marked as a demo assumption.
 */
import { organizations } from './fixtures';
import type { DemoRole, Viewer } from './projection';

export interface Persona {
  id: string;
  name: string;
  title: string;
  initials: string;
  role: DemoRole;
  description: string;
  /** Fixture principal backing the persona; null for Donna (unauthenticated) and Wiley (demo synthesis). */
  principalId: string | null;
  organizationId: string | null;
  principalNote: string;
}

const cacheWater = organizations.find((org) => org.id === 'org-cache-water');
if (!cacheWater) throw new Error('fixture world missing org-cache-water');

export const personas: Persona[] = [
  {
    id: 'donna',
    name: 'Donna',
    title: 'Public / policy overview',
    initials: 'DO',
    role: 'public',
    description: 'Published statewide stations, freshness indicators and shareable views. No account required.',
    principalId: null,
    organizationId: null,
    principalNote: 'Unauthenticated browsing of the public projection.',
  },
  {
    id: 'wiley',
    name: 'Wiley',
    title: 'Water user',
    initials: 'WI',
    role: 'water-user',
    description: 'Published stations plus the restricted delivery station owned by his organization.',
    principalId: null,
    organizationId: 'org-cache-water',
    principalNote: `Demo synthesis: member of ${cacheWater.name} (principals.json defines the organization, not a member account).`,
  },
  {
    id: 'sarah',
    name: 'Sarah',
    title: 'Researcher',
    initials: 'SA',
    role: 'researcher',
    description: 'Public projection with provenance, processing levels and reproducible extracts.',
    principalId: 'principal-sarah-researcher',
    organizationId: null,
    principalNote: 'Fixture principal with an approved dataset grant (dataset-approved-discharge-v1).',
  },
  {
    id: 'cody',
    name: 'Cody',
    title: 'Commissioner',
    initials: 'CO',
    role: 'commissioner',
    description: 'Readings and review for stations in his assigned system (Bear River).',
    principalId: 'principal-cody-commissioner',
    organizationId: null,
    principalNote: 'Fixture principal, entitlement scoped to sys-bear-river.',
  },
  {
    id: 'fatima',
    name: 'Fatima',
    title: 'Field engineer',
    initials: 'FA',
    role: 'engineer',
    description: 'Quality review, corrections and internal diagnostics for her assigned system (Bear River).',
    principalId: 'principal-fatima-engineer',
    organizationId: null,
    principalNote: 'Fixture principal, entitlement scoped to sys-bear-river with view-internal-diagnostics.',
  },
  {
    id: 'diego',
    name: 'Diego',
    title: 'Data steward',
    initials: 'DI',
    role: 'steward',
    description: 'Statewide stewardship: assignments, vocabulary, systems and connection health.',
    principalId: 'principal-diego-steward',
    organizationId: null,
    principalNote: 'Fixture principal with statewide administration.',
  },
];

export const defaultPersonaId = 'donna';

export function personaById(id: string): Persona {
  return personas.find((persona) => persona.id === id) ?? personas[0]!;
}

export function viewerFor(persona: Persona): Viewer {
  return { personaId: persona.id, role: persona.role, principalId: persona.principalId, organizationId: persona.organizationId };
}

/** Extra fixture principals that are not entry points but demonstrate scope denial in tests and the steward console. */
export const auxiliaryPrincipals = [
  { id: 'principal-priya-engineer', note: 'Engineer assigned to sys-weber-river only; must receive nothing from Bear River.' },
  { id: 'principal-ana-deputy', note: 'Deputy commissioner via explicit, time-bounded delegation on sys-bear-river.' },
];
