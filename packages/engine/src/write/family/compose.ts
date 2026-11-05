/**
 * One changeset's family writes as one plan.
 *
 * A changeset's family writes write several member relations, each through its own statements (order.ts
 * planRelation), and the owners of several families (planOwners). A member's row references its owners' rows, so the
 * relations' statements interleave in one order across relations, by each relation's depth among the families (a
 * relation no family has as a member is at depth 0, a member of a family whose owner is at depth d at d + 1 or more):
 *
 * - every relation's deletes first, deepest first: a member is deleted before an owner it references;
 * - then every relation's updates in place, deepest first;
 * - then every family's counts;
 * - then every relation's inserts, shallowest first: a member is inserted only after its owners.
 *
 * Within one depth, the relations keep the order they are given in, and each relation's statements their own order.
 */
import type { Phase, Plan, RelationPlan } from "#compiler/write/family/order.ts"

/** A relation's statements at its depth among the families. */
export interface RelationPlanAt {
	readonly depth: number
	readonly plan: RelationPlan
}

/** Plans by depth, deepest first or shallowest first; a stable sort, so one depth keeps its order. */
const byDepth = (
	plans: ReadonlyArray<RelationPlanAt>,
	order: "deepest" | "shallowest"
): ReadonlyArray<RelationPlanAt> =>
	plans.toSorted((a, b) => (order === "deepest" ? b.depth - a.depth : a.depth - b.depth))

/** One changeset's family writes as one plan: deletes and updates deepest first, then counts, then inserts shallowest
 * first. */
export const compose = (
	relations: ReadonlyArray<RelationPlanAt>,
	counts: ReadonlyArray<Phase<"count">>
): Plan => {
	const deepest = byDepth(relations, "deepest")
	return [
		deepest.flatMap((p) => p.plan[0]),
		deepest.flatMap((p) => p.plan[1]),
		counts.flat(),
		byDepth(relations, "shallowest").flatMap((p) => p.plan[2])
	]
}

/**
 * Each relation's depth among the law model's `families`: 0 for a relation no family has as a member, and one more
 * than its deepest owner's for a member; a tree's own family, of its relation over itself, adds none. A relation on a
 * cycle of families, which no nesting orders, takes the depth its walk met it at.
 */
export const relationDepths = (
	families: ReadonlyArray<{
		readonly owner: { readonly name: string }
		readonly member: { readonly name: string }
	}>
): ((relation: string) => number) => {
	const known = new Map<string, number>()
	const depthOf = (relation: string, seen: ReadonlySet<string>): number => {
		const memo = known.get(relation)
		if (memo !== undefined) {
			return memo
		}
		const owners = families.filter(
			(f) => f.member.name === relation && f.owner.name !== relation && !seen.has(f.owner.name)
		)
		const next = new Set([...seen, relation])
		const depth = owners.reduce((d, f) => Math.max(d, 1 + depthOf(f.owner.name, next)), 0)
		known.set(relation, depth)
		return depth
	}
	return (relation) => depthOf(relation, new Set())
}
