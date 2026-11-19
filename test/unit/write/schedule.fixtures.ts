/** What the properties of schedule.test.ts read: its spaces, models and helpers. */

import { boolean, element, type Gen, subarray } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import { ParamId, StoredRelationName } from "#compiler/core/ids.ts"
import type { ActionCore } from "#compiler/ir/write.ts"

/** An operation of a stratum's action on C or on P. */
type Op = "delete" | "put" | "insert"

/** The phase of an operation on its own relation, the schedule's: deletions, then puts, then insertions. */
export const phase: { readonly [O in Op]: number } = {
	delete: 0,
	put: 1,
	insert: 2
}

/** A stratum's shape: its actions, C's name and C's and P's payloads. */
interface Shape {
	/** Whether C sorts before P by name, so the canonical order puts C's action first. */
	readonly sourceFirst: boolean
	/** Whether C has a payload, its reference outside its key, so its put displaces the occupant of its key. */
	readonly keyed: boolean
	/** Whether P has a payload, every fact of it at its one key, so its put displaces the occupant there and an insert
	 * meets it. */
	readonly targetKeyed: boolean
	readonly onP: ReadonlyArray<Op>
	readonly onC: ReadonlyArray<Op>
}

/** A fact: P's an id; C's an id and the P id it references, C's own id 1 when it has a payload. */
type Fact = readonly [id: number, p: number]

/** The ids of the box. */
const ids: Arr.NonEmptyReadonlyArray<number> = Arr.range(1, 2)

/** A write of an instance: an action's fact. */
interface Written {
	readonly relation: "C" | "P"
	readonly op: Op
	readonly fact: Fact
}

/** A state of the box: P's ids and C's facts. */
type State = {
	readonly p: ReadonlyArray<number>
	readonly c: ReadonlyArray<Fact>
}

/** An instance of a shape: the state before, and each action's write. */
type Instance = State & { readonly writes: ReadonlyArray<Written> }

const same = (a: Fact, b: Fact): boolean => a[0] === b[0] && a[1] === b[1]

const holds = (s: State): boolean => Arr.every(s.c, ([, ref]) => s.p.includes(ref))

/** Whether C's facts keep its key: a C with a payload holds at most one fact at its one id. */
const keyed = (shape: Shape, c: ReadonlyArray<Fact>): boolean => !shape.keyed || c.length <= 1

/** Whether P's facts keep its key: a P with a payload holds at most one fact at its one key. */
const targetKeyed = (shape: Shape, p: ReadonlyArray<number>): boolean =>
	!shape.targetKeyed || p.length <= 1

/** Whether a state keeps every immediate constraint: C's references and both relations' keys. */
const lawful = (shape: Shape, s: State): boolean =>
	holds(s) && keyed(shape, s.c) && targetKeyed(shape, s.p)

/** Whether two states hold the same facts, each relation's as a set. */
const sameFacts = (a: State, b: State): boolean =>
	a.p.length === b.p.length &&
	Arr.every(a.p, (x) => b.p.includes(x)) &&
	a.c.length === b.c.length &&
	Arr.every(a.c, (f) => Arr.some(b.c, (g) => same(f, g)))

/**
 * An instance's writes as the host's normalization leaves them: a P id both deleted and added is only added, and one
 * both put and inserted is only put; C writes one fact.
 */
const normalized = (instance: Instance): ReadonlyArray<Written> => {
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
const statementsOf = (shape: Shape, w: Written): ReadonlyArray<(s: State) => State> => {
	if (w.relation === "P") {
		const [id] = w.fact
		const add = (s: State): State => ({ ...s, p: s.p.includes(id) ? s.p : [...s.p, id] })
		return w.op === "delete"
			? [(s) => ({ ...s, p: Arr.filter(s.p, (x) => x !== id) })]
			: w.op === "put" && shape.targetKeyed
				? [(s) => ({ ...s, p: Arr.filter(s.p, (x) => x === id) }), add]
				: [add]
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

/** Runs `writes` statement by statement from `state`, while every state between them is lawful; none where one is not. */
const run = (shape: Shape, state: State, writes: ReadonlyArray<Written>): State | undefined => {
	let at = state
	for (const w of writes) {
		for (const statement of statementsOf(shape, w)) {
			at = statement(at)
			if (!lawful(shape, at)) {
				return undefined
			}
		}
	}
	return at
}

/**
 * A stratum's one final state: its normalized writes in phase order on the state before, P's deletions there, then its
 * additions, then C's write, whatever the states between them.
 */
const finalOf = (shape: Shape, instance: Instance): State => {
	const writes = normalized(instance)
	const phased = [
		...Arr.flatMap(["delete", "put", "insert"] as const, (op) =>
			Arr.filter(writes, (w) => w.relation === "P" && w.op === op)
		),
		...Arr.filter(writes, (w) => w.relation === "C")
	]
	return Arr.reduce(phased, instance, (s: State, w) =>
		Arr.reduce(statementsOf(shape, w), s, (t, statement) => statement(t))
	)
}

/**
 * Whether running the actions in `order`, each by its relation and operation, keeps every C fact's reference and both
 * relations' keys after every statement of `instance`, and reaches its final state.
 */
export const keeps = (
	shape: Shape,
	instance: Instance,
	order: ReadonlyArray<{ readonly relation: "C" | "P"; readonly op: Op }>
): boolean => {
	const writes = normalized(instance)
	const reached = run(
		shape,
		instance,
		Arr.flatMap(order, (action) =>
			Arr.filter(writes, (w) => w.relation === action.relation && w.op === action.op)
		)
	)
	return reached !== undefined && sameFacts(reached, finalOf(shape, instance))
}

/**
 * Every lawful instance of a shape: every state of the box whose facts keep both keys and whose C facts reference P,
 * with every write of each action at an id of the box, whose final state keeps them too.
 */
export const instancesOf = (shape: Shape): ReadonlyArray<Instance> => {
	const facts = (ref: number): Fact => [1, ref]
	const states = Arr.flatMap(subsets(ids), (p) =>
		Arr.map(subsets(Arr.map(ids, facts)), (c): State => ({ p, c }))
	)
	const choices: ReadonlyArray<ReadonlyArray<Written>> = [
		...Arr.map(shape.onP, (op) =>
			Arr.map(ids, (id): Written => ({ relation: "P", op, fact: [id, id] }))
		),
		...Arr.map(shape.onC, (op) =>
			Arr.map(ids, (id): Written => ({ relation: "C", op, fact: facts(id) }))
		)
	]
	const none: ReadonlyArray<ReadonlyArray<Written>> = [[]]
	const writings = Arr.reduce(choices, none, (sofar, choice) =>
		Arr.flatMap(sofar, (ws) => Arr.map(choice, (w) => [...ws, w]))
	)
	return Arr.flatMap(states, (state) =>
		lawful(shape, state)
			? Arr.flatMap(writings, (writes) => {
					const instance = { ...state, writes }
					return lawful(shape, finalOf(shape, instance)) ? [instance] : []
				})
			: []
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
export const orders = <A>(items: ReadonlyArray<A>): ReadonlyArray<ReadonlyArray<A>> =>
	items.length === 0
		? [[]]
		: Arr.flatMap(items, (item, i) =>
				Arr.map(orders(Arr.filter(items, (_, j) => j !== i)), (rest): ReadonlyArray<A> => [
					item,
					...rest
				])
			)

export const nameOf = (shape: Shape, relation: "C" | "P"): StoredRelationName =>
	StoredRelationName((relation === "C") === shape.sourceFirst ? "A" : "B")

export const actionOf = (shape: Shape, relation: "C" | "P", op: Op): ActionCore => {
	const source = { kind: "enumerated", slot: ParamId(`${relation} ${op}`) } as const
	const name = nameOf(shape, relation)
	switch (op) {
		case "insert":
			return { op: "insert", relation: name, source }
		case "put":
			return { op: "put", relation: name, source }
		case "delete":
			return { op: "delete", relation: name, source }
	}
}

/** The explicit operations of an action. */
const explicitOps = ["delete", "put", "insert"] as const

/** Every shape: C's name, both payloads, any set of P's actions, and one action of C or none. */
export const shapeGen: Gen<Shape> = (source) => {
	const sourceFirst = source.draw(boolean)
	const keyed = source.draw(boolean)
	const targetKeyed = source.draw(boolean)
	return {
		sourceFirst,
		keyed,
		targetKeyed,
		onP: source.draw(subarray(explicitOps)),
		onC: source.draw(boolean) ? [source.draw(element(explicitOps))] : []
	}
}

export type Situation =
	| "the schedule orders a stratum"
	| "no order keeps a stratum"
	| "a pure set's deletion after its addition"
	| "both put, the source named first"
	| "both put, the target named first"
