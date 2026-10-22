import { withEntitlement, type PolicyWorld } from '../../../../../../packages/policy/src/index.ts';
import { reportWorld } from '../../distribution-report/world.ts';

/** Explicit test-only accounting assignments; QC review alone never authorizes finalization. */
export function accountingTestWorld(): PolicyWorld {
  let world = reportWorld().policyWorld;
  for (const id of ['ent-commissioner-cody', 'ent-deputy-ana']) {
    const assignment = world.assignments.find((candidate) => candidate.id === id)!;
    world = withEntitlement(world, id, { capabilities: [...assignment.capabilities, 'finalize-accounting'] });
  }
  return world;
}
