import { defect } from "#compiler/core/invariant.ts"
import { isNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import * as Order from "#compiler/core/order.ts"
import type { FamilyId } from "#compiler/ir/law.ts"
import type { ActionCore } from "#compiler/ir/write.ts"

/** An action in execution order, with the positions of the earlier actions it depends on. */
interface ScheduledAction<A> {
	readonly scheduled: A
	readonly dependsOn: ReadonlyArray<number>
}

/**
 * One of a stratum's family statements, as the schedule orders it among the stratum's actions: the rows of a member
 * relation a family write deletes, updates in place or inserts (`rows`), or the counts and ends of a family's owners
 * (`owners`), which update the owner relation's rows (write/family/order.ts FamilyStatement).
 */
export type FamilyNode =
	| {
			readonly kind: "rows"
			readonly relation: string
			readonly statement: "delete" | "update" | "insert"
	  }
	| { readonly kind: "owners"; readonly family: FamilyId; readonly relation: string }

/** A family statement in the stratum's order: `at`, the number of the stratum's actions that run before it. */
export interface FamilyAt {
	readonly node: FamilyNode
	readonly at: number
}

/** A write the schedule places: one of the stratum's actions, or one of its family statements. */
export type Write<A> =
	| { readonly kind: "action"; readonly action: A }
	| { readonly kind: "family"; readonly node: FamilyNode }

/**
 * A stratum's schedule: its actions in execution order, and where each of its family statements runs among them; or a
 * cycle of its writes, each of which an immediate key or foreign key must run before the next, and the last before the
 * first, which no order keeps.
 */
export type Schedule<A> =
	| {
			readonly kind: "ordered"
			readonly actions: ReadonlyArray<ScheduledAction<A>>
			readonly family: ReadonlyArray<FamilyAt>
	  }
	| { readonly kind: "cycle"; readonly cycle: NonEmptyReadonlyArray<Write<A>> }

/**
 * What the schedule reads of an action: what it does, and whether its relation is a pure set, whose every field its
 * primary key holds (write/frontend/targets.ts Payload), so that a put of it displaces nothing.
 */
interface Scheduled {
	readonly action: ActionCore
	readonly pureSet: boolean
}

/**
 * An immediate reference: facts of `from` name facts of `to` at every statement; `cascade` where an update of the
 * referenced facts carries itself into the referencing ones (ON UPDATE CASCADE), so only a deletion removes what they
 * reference.
 */
export interface ImmediateReference {
	readonly from: string
	readonly to: string
	readonly cascade: boolean
}

/** The phase of an action on its own relation. */
const phaseOf = (a: ActionCore): 0 | 1 | 2 | 3 =>
	a.op === "delete" ? 0 : a.op === "put" ? 1 : a.serial.kind === "generated" ? 3 : 2

/**
 * Whether an action removes facts: a deletion, or a put of a relation with a payload, which displaces the occupant of
 * each key it writes. A pure set's put displaces nothing: its fact at a key is the key, so its put only adds.
 */
const removes = (s: Scheduled): boolean =>
	s.action.op === "delete" || (s.action.op === "put" && !s.pureSet)
const adds = (s: Scheduled): boolean => s.action.op === "insert" || s.action.op === "put"

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
 * the next action is the first in canonical order whose predecessors are all placed. Where none is, the remaining
 * actions hold a cycle no order keeps, and the schedule is that cycle: no edge is ever dropped.
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
 *   order until COMMIT, so it orders nothing. A put is both a removal and an addition, but a pure set's put displaces
 *   nothing and is an addition alone, and an immediate foreign key's target is a pure set under the deferral rule (a
 *   reference into a relation that has a field outside the referenced columns is deferred): so C's put follows P's.
 *   Where the rules still order actions in a cycle, as a deletion and an insertion of one relation around a put of
 *   another that references it, no order keeps every key at every statement, and that cycle is the schedule.
 *
 * The actions are numbered in a canonical order (relation, then the phases above, then member order), sorted
 * topologically with that order breaking ties, and each action's dependsOn lists the earlier actions an edge orders
 * before it. */
export const scheduleStratum = <A extends Scheduled>(
	actions: ReadonlyArray<A>,
	family: ReadonlyArray<FamilyNode>,
	references: ReadonlyArray<ImmediateReference>
): Schedule<A> => {
	interface Vertex {
		readonly write: Write<A>
		readonly follows: Set<Vertex>
	}
	const vertexOf = (write: Write<A>): Vertex => ({ write, follows: new Set<Vertex>() })
	const plain = actions.map((action) => ({ action, vertex: vertexOf({ kind: "action", action }) }))
	const statements = family.map((node) => vertexOf({ kind: "family", node }))
	for (const { action: xa, vertex: x } of plain) {
		for (const { action: ya, vertex: y } of plain) {
			if (x === y) {
				continue
			}
			const a = xa.action
			const b = ya.action
			if (a.relation === b.relation) {
				if (phaseOf(a) < phaseOf(b)) {
					y.follows.add(x)
				}
				continue
			}
			if (!references.some((r) => r.from === b.relation && r.to === a.relation)) {
				continue
			}
			if (adds(xa) && adds(ya)) {
				y.follows.add(x)
			}
			if (removes(xa) && removes(ya)) {
				x.follows.add(y)
			}
		}
	}
	for (const [i, y] of statements.entries()) {
		const before = statements[i - 1]
		if (before !== undefined) {
			y.follows.add(before)
		}
	}
	for (const { vertex: x } of plain) {
		for (const y of statements) {
			const a = effectOf(x.write)
			const b = effectOf(y.write)
			for (const r of references) {
				if (r.to === a.relation && r.from === b.relation) {
					order(x, a, y, b, r)
				}
				if (r.to === b.relation && r.from === a.relation) {
					order(y, b, x, a, r)
				}
			}
		}
	}
	const sequence: Array<Vertex> = []
	const placed = new Set<Vertex>()
	for (
		let remaining: ReadonlyArray<Vertex> = [...plain.map((p) => p.vertex), ...statements];
		isNonEmpty(remaining);
	) {
		const ready = remaining.find((v) => [...v.follows].every((u) => placed.has(u)))
		if (ready === undefined) {
			return { kind: "cycle", cycle: cycleAmong(remaining, placed) }
		}
		sequence.push(ready)
		placed.add(ready)
		remaining = remaining.filter((v) => v !== ready)
	}
	const ordered = sequence.flatMap((v) => (v.write.kind === "action" ? [v] : []))
	return {
		kind: "ordered",
		actions: ordered.map((v, at) => ({
			scheduled: actionOf(v.write),
			dependsOn: Object.freeze(
				ordered.slice(0, at).flatMap((u, position) => (v.follows.has(u) ? [position] : []))
			)
		})),
		family: sequence.flatMap((v, i) =>
			v.write.kind === "family"
				? [
						{
							node: v.write.node,
							at: sequence.slice(0, i).filter((u) => u.write.kind === "action").length
						}
					]
				: []
		)
	}
}

/** A placed write's action, which an action vertex holds. */
const actionOf = <A>(write: Write<A>): A => {
	if (write.kind !== "action") {
		throw defect("an action vertex holds an action")
	}
	return write.action
}

/**
 * What a write does to its relation's facts as a reference sees them: whether it adds facts that reference or are
 * referenced, and whether it removes them, as the source of a reference and as its target. A put of a relation with a
 * payload displaces the occupant of each key it writes, and an update in place, a family's or its owners' counts,
 * changes the facts it updates; as a target, either removes what is referenced only where no cascade carries the
 * change into the referencing facts.
 */
interface Effect {
	readonly relation: string
	readonly adds: boolean
	readonly removes: boolean
	readonly updates: boolean
}

const effectOf = <A extends Scheduled>(write: Write<A>): Effect => {
	if (write.kind === "action") {
		const { action } = write
		return {
			relation: action.action.relation,
			adds: adds(action),
			removes: action.action.op === "delete",
			updates: action.action.op === "put" && !action.pureSet
		}
	}
	const node = write.node
	if (node.kind === "owners") {
		return { relation: node.relation, adds: true, removes: false, updates: true }
	}
	switch (node.statement) {
		case "delete":
			return { relation: node.relation, adds: false, removes: true, updates: false }
		case "update":
			return { relation: node.relation, adds: true, removes: false, updates: true }
		case "insert":
			return { relation: node.relation, adds: true, removes: false, updates: false }
	}
}

/**
 * Orders a write `target` of the referenced relation and a write `source` of the referencing one by the reference `r`:
 * the target's additions before the source's, and the source's removals before the target's, a target's update a
 * removal unless `r` cascades it, a source's update a removal of the references it changes.
 */
const order = <V extends { readonly follows: Set<V> }>(
	targetVertex: V,
	target: Effect,
	sourceVertex: V,
	source: Effect,
	r: ImmediateReference
): void => {
	if (target.adds && source.adds) {
		sourceVertex.follows.add(targetVertex)
	}
	const targetRemoves = target.removes || (target.updates && !r.cascade)
	const sourceRemoves = source.removes || source.updates
	if (targetRemoves && sourceRemoves) {
		targetVertex.follows.add(sourceVertex)
	}
}

/**
 * A cycle among `remaining`, every one of which follows an action not yet `placed`, in the order they must run: from the
 * first remaining, each step goes back to an unplaced action it follows, until one is met again, and the actions from
 * that one on, reversed, each must run before the next.
 */
const cycleAmong = <A>(
	remaining: NonEmptyReadonlyArray<{
		readonly write: Write<A>
		readonly follows: ReadonlySet<unknown>
	}>,
	placed: ReadonlySet<unknown>
): NonEmptyReadonlyArray<Write<A>> => {
	type Vertex = (typeof remaining)[number]
	const walked: Array<Vertex> = []
	for (let at: Vertex | undefined = remaining[0]; at !== undefined;) {
		const seen = walked.indexOf(at)
		if (seen >= 0) {
			const [first, ...rest] = walked.slice(seen).toReversed()
			if (first === undefined) {
				break
			}
			return [first.write, ...rest.map((v) => v.write)]
		}
		walked.push(at)
		const from: Vertex = at
		at = remaining.find((v) => from.follows.has(v) && !placed.has(v))
	}
	throw defect("every remaining action follows an unplaced one, so the walk back meets one again")
}
