import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { boolean, element, type Gen, subarray } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter } from "effect"
import { ParamId } from "#compiler/core/ids.ts"
import type { ActionCore } from "#compiler/ir/write.ts"
import { completeClass } from "#compiler/ir/write.ts"
import { canonicalActionOrder, scheduleStratum } from "#compiler/write/frontend/schedule.ts"
import { assert } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"

/**
 * A stratum's schedule holds an immediate foreign key at every statement, or names a cycle no order keeps. A stratum's
 * actions are over a relation C and a pure set P that C references immediately, the foreign key grizzle makes
 * immediate only into a pure set: at most one action of each operation on P, and one on C or none. Its shape is which
 * actions it holds, with C named first or second and C with a payload or a pure set itself; its instances are every
 * lawful state of a small box with every lawful write of that shape.
 *
 * The oracle is a model of the statements each action sends, not of the schedule's rule: a deletion removes its facts;
 * an insertion adds them; a put of a relation with a payload displaces the occupant of its key, then inserts; a pure
 * set's put inserts alone, since its fact at a key is the key; and, as the host's normalization does, a fact both
 * deleted and added is only added, and one both put and inserted only put. Every order of a stratum's actions reaches
 * the stratum's one final state; the schedule decides only the states between its statements.
 *
 * - Where the schedule orders a shape, its order keeps every C fact's reference in P after each statement of every
 *   instance.
 * - Where it names a cycle, the cycle's actions are the shape's, and every order of the shape's actions that runs each
 *   relation's deletion before its put and its put before its insertion, as immediate keys the schedule cannot see the
 *   facts of require, leaves some C fact referencing no P fact after some statement of some instance: no order keeps
 *   the stratum, and the front end refuses it (UnorderableStratum) where it used to drop an edge and fail at the server.
 */

type Op = "delete" | "put" | "insert"

/** The phase of an operation on its own relation, the schedule's: deletions, then puts, then insertions. */
const phase: { readonly [O in Op]: number } = { delete: 0, put: 1, insert: 2 }

/** A stratum's shape: its actions, C's name and C's payload. */
interface Shape {
	/** Whether C sorts before P by name, so the canonical order puts C's action first. */
	readonly sourceFirst: boolean
	/** Whether C has a payload, its reference outside its key, so its put displaces the occupant of its key. */
	readonly keyed: boolean
	readonly onP: ReadonlyArray<Op>
	readonly onC: ReadonlyArray<Op>
}

/** A fact: P's an id; C's an id and the P id it references, C's own id 1 when it has a payload. */
type Fact = readonly [id: number, p: number]

/** The ids of the box. */
const ids = Arr.range(1, 2)

/** An instance of a shape: the state before, and each action's fact. */
interface Instance {
	readonly p: ReadonlyArray<number>
	readonly c: ReadonlyArray<Fact>
	readonly writes: ReadonlyArray<{
		readonly relation: "C" | "P"
		readonly op: Op
		readonly fact: Fact
	}>
}

type State = { readonly p: ReadonlyArray<number>; readonly c: ReadonlyArray<Fact> }

const same = (a: Fact, b: Fact): boolean => a[0] === b[0] && a[1] === b[1]

const holds = (s: State): boolean => Arr.every(s.c, ([, ref]) => s.p.includes(ref))

/** Whether C's facts keep its key: a C with a payload holds at most one fact at its one id. */
const keyed = (shape: Shape, c: ReadonlyArray<Fact>): boolean => !shape.keyed || c.length <= 1

/**
 * An instance's writes as the host's normalization leaves them: a P id both deleted and added is only added, and one both
 * put and inserted is only put; C writes one fact.
 */
const normalized = (instance: Instance): Instance["writes"] => {
	const added = (op: Op) =>
		Arr.flatMap(instance.writes, (w) => (w.relation === "P" && w.op === op ? [w.fact[0]] : []))
	return Arr.filter(instance.writes, (w) => {
		if (w.relation === "C") {
			return true
		}
		switch (w.op) {
			case "delete":
				return !added("put").includes(w.fact[0]) && !added("insert").includes(w.fact[0])
			case "insert":
				return !added("put").includes(w.fact[0])
			case "put":
				return true
		}
	})
}

/** One action's statements, each a change of the state, in the order the action sends them. */
const statementsOf = (
	shape: Shape,
	w: Instance["writes"][number]
): ReadonlyArray<(s: State) => State> => {
	if (w.relation === "P") {
		const [id] = w.fact
		return w.op === "delete"
			? [(s) => ({ ...s, p: Arr.filter(s.p, (x) => x !== id) })]
			: [(s) => (s.p.includes(id) ? s : { ...s, p: [...s.p, id] })]
	}
	const insert = (s: State): State =>
		Arr.some(s.c, (f) => same(f, w.fact)) ? s : { ...s, c: [...s.c, w.fact] }
	switch (w.op) {
		case "delete":
			return [(s) => ({ ...s, c: Arr.filter(s.c, (f) => !same(f, w.fact)) })]
		case "insert":
			return [insert]
		case "put":
			return shape.keyed
				? [
						(s) => ({ ...s, c: Arr.filter(s.c, (f) => f[0] !== w.fact[0] || same(f, w.fact)) }),
						insert
					]
				: [insert]
	}
}

/**
 * Whether running the actions in `order`, each by its relation and operation, keeps every C fact's reference after
 * every statement of `instance`.
 */
const keeps = (
	shape: Shape,
	instance: Instance,
	order: ReadonlyArray<{ readonly relation: "C" | "P"; readonly op: Op }>
): boolean => {
	const writes = normalized(instance)
	let state: State = { p: instance.p, c: instance.c }
	for (const action of order) {
		for (const w of writes) {
			if (w.relation !== action.relation || w.op !== action.op) {
				continue
			}
			for (const statement of statementsOf(shape, w)) {
				state = statement(state)
				if (!holds(state)) {
					return false
				}
			}
		}
	}
	return true
}

/**
 * Every lawful instance of a shape: every state of the box whose C facts keep C's key and reference P, with every write
 * of each action at an id of the box, whose final state keeps them too.
 */
const instancesOf = (shape: Shape): ReadonlyArray<Instance> => {
	const facts = (ref: number): Fact => [1, ref]
	const states = Arr.flatMap(subsets(ids), (p) =>
		Arr.flatMap(subsets(Arr.map(ids, facts)), (c) => (keyed(shape, c) ? [{ p, c }] : []))
	)
	const actions = [
		...Arr.map(shape.onP, (op) => ({ relation: "P" as const, op })),
		...Arr.map(shape.onC, (op) => ({ relation: "C" as const, op }))
	]
	const none: ReadonlyArray<Instance["writes"]> = [[]]
	const writings = Arr.reduce(actions, none, (sofar, action) =>
		Arr.flatMap(sofar, (ws) =>
			Arr.map(ids, (id) => [
				...ws,
				{ ...action, fact: action.relation === "P" ? ([id, id] as const) : facts(id) }
			])
		)
	)
	return Arr.flatMap(states, (state) =>
		Arr.flatMap(writings, (writes) => {
			const instance = { ...state, writes }
			if (!holds(state)) {
				return []
			}
			const final = Arr.reduce(normalized(instance), state, (s, w) =>
				Arr.reduce(statementsOf(shape, w), s, (t, statement) => statement(t))
			)
			return holds(final) && keyed(shape, final.c) ? [instance] : []
		})
	)
}

/** Every subset of `items`. */
const subsets = <A>(items: ReadonlyArray<A>): ReadonlyArray<ReadonlyArray<A>> => {
	const empty: ReadonlyArray<ReadonlyArray<A>> = [[]]
	return Arr.reduce(items, empty, (sofar, item) => [
		...sofar,
		...Arr.map(sofar, (s) => [...s, item])
	])
}

/** Every order of `items`. */
const orders = <A>(items: ReadonlyArray<A>): ReadonlyArray<ReadonlyArray<A>> =>
	items.length === 0
		? [[]]
		: Arr.flatMap(items, (item, i) =>
				Arr.map(orders(Arr.filter(items, (_, j) => j !== i)), (rest): ReadonlyArray<A> => [
					item,
					...rest
				])
			)

const nameOf = (shape: Shape, relation: "C" | "P"): string =>
	(relation === "C") === shape.sourceFirst ? "A" : "B"

const actionOf = (shape: Shape, relation: "C" | "P", op: Op): ActionCore => {
	const source = { kind: "enumerated", slot: ParamId(`${relation} ${op}`) } as const
	const name = nameOf(shape, relation)
	switch (op) {
		case "insert":
			return { op: "insert", serial: completeClass, relation: name, source }
		case "put":
			return { op: "put", relation: name, source }
		case "delete":
			return { op: "delete", relation: name, source }
	}
}

/** Every shape: C's name and payload, any set of P's actions, and one action of C or none. */
const shapeGen: Gen<Shape> = (source) => ({
	sourceFirst: source.draw(boolean),
	keyed: source.draw(boolean),
	onP: source.draw(subarray(["delete", "put", "insert"] as const)),
	onC: source.draw(boolean) ? [source.draw(element(["delete", "put", "insert"] as const))] : []
})

type Situation =
	| "the schedule orders a stratum"
	| "no order keeps a stratum"
	| "both put, the source named first"
	| "both put, the target named first"

describe("a stratum's schedule", () => {
	it.effect(
		"keeps an immediate foreign key into a pure set at every statement, or names a cycle no order keeps",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/write/schedule",
						generator: shapeGen,
						literal: Formatter.format,
						limit: 2 * 2 * 8 * 4,
						box: "C named first or second, with a payload or a pure set; any set of P's deletion, put and insertion; one action of C or none; every lawful state over two ids",
						oracle: {
							kind: "second-implementation",
							name: "the statements each action sends, over every lawful instance and every order"
						},
						coverage: requiredInSpace<Situation>([
							"the schedule orders a stratum",
							"no order keeps a stratum",
							"both put, the source named first",
							"both put, the target named first"
						]),
						caseHang
					},
					(shape, c) =>
						Effect.sync(() => {
							const actions = [
								...Arr.map(shape.onP, (op) => ({ relation: "P" as const, op })),
								...Arr.map(shape.onC, (op) => ({ relation: "C" as const, op }))
							]
							const instances = instancesOf(shape)
							if (actions.length === 0 || instances.length === 0) {
								return
							}
							const schedule = scheduleStratum(
								canonicalActionOrder(
									Arr.map(actions, ({ relation, op }) => ({
										action: actionOf(shape, relation, op),
										pureSet: relation === "P" || !shape.keyed,
										relation,
										op
									}))
								),
								[],
								[{ from: nameOf(shape, "C"), to: nameOf(shape, "P"), cascade: false }]
							)
							if (schedule.kind === "ordered") {
								const order = Arr.map(schedule.actions, ({ scheduled }) => scheduled)
								for (const instance of instances) {
									assert.ok(
										keeps(shape, instance, order),
										`the order ${Formatter.format(order)} leaves a C fact referencing no P fact in ${Formatter.format(instance)}`
									)
								}
								c.note("the schedule orders a stratum")
							} else {
								assert.ok(
									Arr.every(
										schedule.cycle,
										(w) =>
											w.kind === "action" &&
											Arr.some(
												actions,
												(b) => b.relation === w.action.relation && b.op === w.action.op
											)
									),
									"the cycle's actions are the stratum's"
								)
								const phased = Arr.filter(orders(actions), (order) =>
									Arr.every(order, (a, i) =>
										Arr.every(
											order.slice(i + 1),
											(b) => b.relation !== a.relation || phase[a.op] < phase[b.op]
										)
									)
								)
								for (const order of phased) {
									assert.ok(
										Arr.some(instances, (instance) => !keeps(shape, instance, order)),
										`the order ${Formatter.format(order)} keeps every instance of a stratum the schedule names a cycle of`
									)
								}
								c.note("no order keeps a stratum")
							}
							if (shape.onC.includes("put") && shape.onP.includes("put")) {
								c.note(
									shape.sourceFirst
										? "both put, the source named first"
										: "both put, the target named first"
								)
							}
						})
				)
			)
	)
})
