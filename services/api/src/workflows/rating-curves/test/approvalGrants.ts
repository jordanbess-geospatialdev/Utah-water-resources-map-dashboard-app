import { withEntitlement } from '../../../../../../packages/policy/src/index.ts';
import { createRatingCurveStore as createBaseStore, type RatingCurveStore } from '../store.ts';

/** Explicit test-only approvers; the default commissioner/deputy grants remain QC-only. */
export function createRatingCurveStore(): RatingCurveStore {
  const store = createBaseStore();
  let world = store.world;
  for (const id of ['ent-commissioner-cody', 'ent-deputy-ana']) {
    const assignment = world.assignments.find((candidate) => candidate.id === id)!;
    world = withEntitlement(world, id, { capabilities: [...assignment.capabilities, 'approve-rating-curves'] });
  }
  // Preserve the store's live getters for audit, conversion and outbox arrays.
  Object.defineProperty(store, 'world', { value: world, enumerable: true });
  return store;
}
