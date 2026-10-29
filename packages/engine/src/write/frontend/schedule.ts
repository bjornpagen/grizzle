import { headNonEmpty, isNonEmpty } from "#compiler/core/nonempty.ts"
import * as Order from "#compiler/core/order.ts"
import type { ActionCore } from "#compiler/ir/write.ts"

/** An action in execution order, with the positions of the earlier actions it depends on. */
interface ScheduledAction<A> {
	readonly scheduled: A
	readonly dependsOn: ReadonlyArray<number>
}

/** What the schedule reads of an action: what it does. */
interface Scheduled {
	readonly action: ActionCore
}

/** An immediate reference: facts of `from` name facts of `to` at every statement. */
export interface ImmediateReference {
	readonly from: string
	readonly to: string
}

/** The phase of an action on its own relation. */
const phaseOf = (a: ActionCore): number =>
	a.op === "delete" ? 0 : a.op === "put" ? 1 : a.serial === "generated" ? 3 : 2

const removes = (a: ActionCore): boolean => a.op === "delete" || a.op === "put"
const adds = (a: ActionCore): boolean => a.op === "insert" || a.op === "put"

/** The canonical order of a stratum's actions: relation, phase, then (the sort being stable) the order given. */
const scheduledOrder: Order.Comparator<Scheduled> = Order.combine(
	Order.mapInput(Order.compareStrings, (s: Scheduled) => s.action.relation),
	Order.mapInput(Order.compareNumbers, (s: Scheduled) => phaseOf(s.action))
)

export const canonicalActionOrder = <A extends Scheduled>(
	actions: ReadonlyArray<A>
): ReadonlyArray<A> => actions.toSorted(scheduledOrder)

/** Orders one stratum's actions, given in canonical order (canonicalActionOrder): each in execution order with the
 * positions of the earlier actions it depends on. Each action is a vertex holding the actions an edge orders before it;
 * the next action is the first in canonical order whose predecessors are all placed, or, on a cycle, the first
 * remaining, whose edges from remaining actions are dropped.
 *
 * b references a: a's additions before b's, b's removals before a's.
 *
 * The dependency graph of one stratum's physical actions.
 *
 * Every member of a stratum is evaluated against the state before the stratum's writes, so the order of its actions
 * is a physical choice, constrained only by what immediate constraints see between statements:
 *
 * - On one relation, removals come before additions, because primary keys and UNIQUE constraints are immediate and
 *   cannot be wished away: the exact deletions first, then the puts, whose implied deletion frees each
 *   replaced key before its insertion, then the inserts with explicit or no serial values, then the generated
 *   additions. An insert after the puts meets a put's new fact as an exact repeat or a conflict witness of the insert
 *   protocol, never as a displaced occupant, which is what makes a put and an insert of one key with different
 *   payloads a key conflict; and the sequence advance after explicit serial values precedes every
 *   value a generated addition draws.
 * - Across relations, an immediate foreign key from C into P (`natives`, deferrable false) is checked at
 *   each statement, so P's additions precede C's, and C's removals precede P's. A deferred reference tolerates any
 *   order until COMMIT, so it orders nothing. A put is both a removal and an addition; where the two rules
 *   would order two actions both ways, the foreign key cannot be immediate under the deferral rule (a
 *   reference into a relation that has a field outside the referenced columns is deferred), and the edge
 *   that closes the cycle is dropped.
 *
 * The actions are numbered in a canonical order (relation, then the phases above, then member order), sorted
 * topologically with that order breaking ties, and each action's dependsOn lists the earlier actions an edge orders
 * before it. */
export const scheduleStratum = <A extends Scheduled>(
	actions: ReadonlyArray<A>,
	references: ReadonlyArray<ImmediateReference>
): ReadonlyArray<ScheduledAction<A>> => {
	interface Vertex {
		readonly scheduled: A
		readonly follows: Set<Vertex>
	}
	const vertices: ReadonlyArray<Vertex> = actions.map((scheduled) => ({
		scheduled,
		follows: new Set<Vertex>()
	}))
	for (const x of vertices) {
		for (const y of vertices) {
			if (x === y) {
				continue
			}
			const a = x.scheduled.action
			const b = y.scheduled.action
			if (a.relation === b.relation) {
				if (phaseOf(a) < phaseOf(b)) {
					y.follows.add(x)
				}
				continue
			}
			if (!references.some((r) => r.from === b.relation && r.to === a.relation)) {
				continue
			}
			if (adds(a) && adds(b)) {
				y.follows.add(x)
			}
			if (removes(a) && removes(b)) {
				x.follows.add(y)
			}
		}
	}
	const order: Array<Vertex> = []
	const placed = new Set<Vertex>()
	for (let remaining = vertices; isNonEmpty(remaining);) {
		const first = headNonEmpty(remaining)
		const ready = remaining.find((v) => [...v.follows].every((u) => placed.has(u)))
		const next = ready ?? first
		order.push(next)
		placed.add(next)
		remaining = remaining.filter((v) => v !== next)
	}
	return order.map((v, at) => ({
		scheduled: v.scheduled,
		dependsOn: Object.freeze(
			order.slice(0, at).flatMap((u, position) => (v.follows.has(u) ? [position] : []))
		)
	}))
}
