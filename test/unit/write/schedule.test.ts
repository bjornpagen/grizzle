import { describe, it } from "@effect/vitest"
import { drawn, exhaust, explore } from "@grizzle/testing/explore"
import { required, requiredInSpace } from "@grizzle/testing/features"
import { boolean, element, type Gen, int, subarray } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { boundedShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, String as Str } from "effect"
import { ParamId } from "#compiler/core/ids.ts"
import type { ActionCore } from "#compiler/ir/write.ts"
import { completeClass } from "#compiler/ir/write.ts"
import {
	canonicalActionOrder,
	type FamilyNode,
	type FamilyPair,
	type ImmediateReference,
	scheduleStratum,
	type Write
} from "#compiler/write/frontend/schedule.ts"
import { assert, defined } from "#test/support/assert.ts"
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

/**
 * A generated stratum at an import's scale: up to 24 relations, families between them, each an owner and a member, and
 * the stratum's writes: plain actions of the relations no family has as a member, a deletion, a put or an insertion
 * each, and family statements of the members it edits, their deletions, updates in place and insertions, and the
 * counts of every family of an edited member, so an owner of several families takes several counts. Its immediate
 * references are each family's owner axis, where drawn immediate, cascading and naming the member's group, count copy
 * and a copy of the owner's `a`, and laws' keys between any two relations, naming columns drawn from each side.
 *
 * The box before this one draws two relations and plain actions alone, so no family statement ever met a search: the
 * total order the family statements used to keep among themselves, which together with a key between a plain action
 * and a family statement closed cycles no key requires, refused an import of 152 inserts beside updates and counts.
 */
interface Stratum {
	readonly actions: ReadonlyArray<StratumAction>
	readonly family: ReadonlyArray<FamilyNode>
	readonly pairs: ReadonlyArray<FamilyPair>
	readonly references: ReadonlyArray<ImmediateReference>
}

/** A plain action of a generated stratum, by its relation and operation, its relation a pure set or not. */
interface StratumAction {
	readonly action: ActionCore
	readonly pureSet: boolean
}

const relationName = (r: number): string => `R${String(r)}`

const stratumGen: Gen<Stratum> = (source) => {
	const n = source.draw(int(2, 24))
	/** A family's owner comes before its member, but where `cyclic` draws, which draws any two relations, so families
	 * may form a cycle, as an owner of an ordered family whose member owns a counted family of it does. */
	const families = Arr.makeBy(source.draw(int(0, n)), (k) => {
		if (source.draw(boolean)) {
			const owner = source.draw(int(0, n - 1))
			const other = source.draw(int(0, n - 2))
			return {
				k,
				owner,
				member: other >= owner ? other + 1 : other,
				immediate: source.draw(boolean)
			}
		}
		const owner = source.draw(int(0, n - 2))
		return {
			k,
			owner,
			member: source.draw(int(owner + 1, n - 1)),
			immediate: source.draw(boolean)
		}
	})
	const members = new Set(Arr.map(families, (f) => f.member))
	const axisOf = (f: (typeof families)[number]) => ({
		fromColumns: [`field:g${String(f.k)}`, `law:n${String(f.k)}`, `field:c${String(f.k)}`],
		toColumns: ["field:id", `field:n${String(f.k)}`, "field:a"]
	})
	const ownAxis = Arr.flatMap(families, (f): ReadonlyArray<ImmediateReference> =>
		f.immediate
			? [{ from: relationName(f.member), to: relationName(f.owner), cascade: true, ...axisOf(f) }]
			: []
	)
	const columnsOf = (r: number): ReadonlyArray<string> => [
		"field:id",
		"field:a",
		"field:b",
		...Arr.flatMap(families, (f) =>
			f.owner === r ? [`field:n${String(f.k)}`, `field:e${String(f.k)}`] : []
		),
		...Arr.flatMap(families, (f) => (f.member === r ? [`field:c${String(f.k)}`] : []))
	]
	const laws = Arr.makeBy(source.draw(int(0, n)), (): ImmediateReference => {
		const from = source.draw(int(0, n - 1))
		const to = source.draw(int(0, n - 1))
		const fromColumns = source.draw(subarray(columnsOf(from)))
		const toColumns = source.draw(subarray(columnsOf(to)))
		return {
			from: relationName(from),
			to: relationName(to),
			cascade: false,
			fromColumns: Arr.isReadonlyArrayNonEmpty(fromColumns) ? fromColumns : ["field:a"],
			toColumns: Arr.isReadonlyArrayNonEmpty(toColumns) ? toColumns : ["field:id"]
		}
	})
	const actions: Array<StratumAction> = []
	const family: Array<FamilyNode> = []
	const counts: Array<FamilyNode> = []
	const inserts: Array<FamilyNode> = []
	const updates: Array<FamilyNode> = []
	for (let r = 0; r < n; r += 1) {
		const relation = relationName(r)
		if (!members.has(r)) {
			const pureSet = source.draw(boolean)
			const source_ = { kind: "enumerated", slot: ParamId(`${relation} member`) } as const
			for (const op of source.draw(subarray(["delete", "put", "insert"] as const))) {
				actions.push({
					pureSet,
					action:
						op === "insert"
							? { op, serial: completeClass, relation, source: source_ }
							: { op, relation, source: source_ }
				})
			}
			continue
		}
		if (!source.draw(boolean)) {
			continue
		}
		if (source.draw(boolean)) {
			family.push({ kind: "rows", relation, statement: "delete" })
		}
		const changes = source.draw(subarray(columnsOf(r)))
		if (Arr.isReadonlyArrayNonEmpty(changes)) {
			updates.push({ kind: "rows", relation, statement: "update", changes })
		}
		for (const f of families) {
			if (f.member === r) {
				counts.push({
					kind: "owners",
					family: { owner: relationName(f.owner), count: `n${String(f.k)}` },
					relation: relationName(f.owner),
					member: relation,
					changes: [`field:n${String(f.k)}`, `field:e${String(f.k)}`]
				})
			}
		}
		if (source.draw(boolean)) {
			inserts.push({ kind: "rows", relation, statement: "insert" })
		}
	}
	return {
		actions,
		family: [...family, ...updates, ...counts, ...inserts],
		pairs: Arr.map(families, (f) => ({
			family: { owner: relationName(f.owner), count: `n${String(f.k)}` },
			owner: relationName(f.owner),
			member: relationName(f.member),
			immediate: f.immediate,
			...axisOf(f)
		})),
		references: [...ownAxis, ...laws]
	}
}

/** A write of a stratum by its number: an action's position among its actions, a family statement's after them. */
const writeId = <A>(stratum: Stratum, w: Write<A>): number =>
	w.kind === "action"
		? defined(
				Option.getOrUndefined(Arr.findFirstIndex(stratum.actions, (a) => a === w.action)),
				"an action of the stratum"
			)
		: stratum.actions.length +
			defined(
				Option.getOrUndefined(Arr.findFirstIndex(stratum.family, (f) => f === w.node)),
				"a family statement of the stratum"
			)

const edgeKey = (from: number, to: number): string => `${String(from)}>${String(to)}`

const edgeOf = (key: string): readonly [number, number] => {
	const [from, to] = Str.split(key, ">")
	return [Number(defined(from, "an edge's first")), Number(defined(to, "an edge's second"))]
}

/** The phase of a plain action on its own relation: deletions, then puts, then insertions. */
const plainPhase = { delete: 0, put: 1, insert: 2 } as const

/**
 * Every order a stratum's writes require, edge by edge, stated apart from the schedule:
 * - a referenced fact is added before a fact that names it, and a naming fact removed before the fact it names: an
 *   insertion or a put adds, a deletion or a put of a relation with a payload removes; a family's insertion adds and
 *   its deletion removes, and its update in place or count adds and changes facts only at the columns it changes, a
 *   change a removal only where no cascade carries it;
 * - one relation's plain deletion, put and insertion run in that order, and its plain actions before its family
 *   statements;
 * - a member's deletion, update and insertion run in that order; a family's count after its member's and its owner's
 *   deletions and updates and before its owner's insertions, and before its member's where the owner axis is
 *   immediate; a member's update before its owner's where the one changes a column the owner axis cascades into and
 *   the other one it reads; and a family insertion before the family insertion that names it by an immediate key, and
 *   a family deletion that names before the one it names, so an owner's insertion before its members' where the owner
 *   axis is immediate and in no order where it is deferred. Nothing else orders family statements among themselves:
 *   two families' statements of unrelated relations, an owner's counts of several families among them, run in any
 *   order.
 */
const requiredEdges = (stratum: Stratum): ReadonlySet<string> => {
	const edges = new Set<string>()
	const add = (from: number | undefined, to: number | undefined): void => {
		if (from !== undefined && to !== undefined && from !== to && from >= 0 && to >= 0) {
			edges.add(edgeKey(from, to))
		}
	}
	const plains = Arr.map(stratum.actions, (a, i) => ({ a, id: i }))
	const families = Arr.map(stratum.family, (f, i) => ({ f, id: stratum.actions.length + i }))
	const rowsOf = (relation: string, statement: "delete" | "update" | "insert") =>
		Arr.findFirst(
			families,
			({ f }) => f.kind === "rows" && f.relation === relation && f.statement === statement
		).pipe(
			Option.map((x) => x.id),
			Option.getOrUndefined
		)
	const plainAdds = (a: StratumAction) => a.action.op !== "delete"
	const plainRemoves = (a: StratumAction) =>
		a.action.op === "delete" || (a.action.op === "put" && !a.pureSet)
	for (const x of plains) {
		for (const y of plains) {
			const a = x.a.action
			const b = y.a.action
			if (x.id === y.id) {
				continue
			}
			if (a.relation === b.relation) {
				if (plainPhase[a.op] < plainPhase[b.op]) {
					add(x.id, y.id)
				}
				continue
			}
			if (Arr.some(stratum.references, (r) => r.from === b.relation && r.to === a.relation)) {
				if (plainAdds(x.a) && plainAdds(y.a)) {
					add(x.id, y.id)
				}
				if (plainRemoves(x.a) && plainRemoves(y.a)) {
					add(y.id, x.id)
				}
			}
		}
	}
	for (const { f, id } of families) {
		if (f.kind === "rows") {
			if (f.statement !== "delete") {
				add(rowsOf(f.relation, "delete"), id)
			}
			if (f.statement !== "insert") {
				add(id, rowsOf(f.relation, "insert"))
			}
			continue
		}
		add(rowsOf(f.relation, "delete"), id)
		add(rowsOf(f.relation, "update"), id)
		add(id, rowsOf(f.relation, "insert"))
		add(rowsOf(f.member, "delete"), id)
		add(rowsOf(f.member, "update"), id)
		const counted = f.family
		if (
			Arr.some(
				stratum.pairs,
				(p) => p.immediate && p.family.owner === counted.owner && p.family.count === counted.count
			)
		) {
			add(id, rowsOf(f.member, "insert"))
		}
	}
	/** The update in place of `relation`, where the stratum holds one, and the columns it changes. */
	const updateOf = (relation: string) =>
		Arr.findFirst(
			families,
			({ f }) => f.kind === "rows" && f.relation === relation && f.statement === "update"
		).pipe(Option.getOrUndefined)
	for (const p of stratum.pairs) {
		const member = updateOf(p.member)
		const owner = updateOf(p.owner)
		if (
			p.owner !== p.member &&
			member !== undefined &&
			owner !== undefined &&
			changesAny(member.f, p.fromColumns) &&
			changesAny(owner.f, p.toColumns)
		) {
			add(member.id, owner.id)
		}
	}
	for (const r of stratum.references) {
		if (r.from === r.to) {
			continue
		}
		add(rowsOf(r.to, "insert"), rowsOf(r.from, "insert"))
		add(rowsOf(r.from, "delete"), rowsOf(r.to, "delete"))
	}
	/** A family statement's additions and changes at a reference's columns. */
	const touches = (f: FamilyNode, columns: ReadonlyArray<string>) =>
		f.kind === "rows" && f.statement !== "update"
			? { adds: f.statement === "insert", removes: f.statement === "delete", changes: false }
			: (() => {
					const at = Arr.some(f.changes, (c) => columns.includes(c))
					return { adds: at, removes: false, changes: at }
				})()
	for (const x of plains) {
		for (const { f, id } of families) {
			if (x.a.action.relation === f.relation) {
				add(x.id, id)
			}
			for (const r of stratum.references) {
				if (r.from === r.to) {
					continue
				}
				if (r.to === x.a.action.relation && r.from === f.relation) {
					const t = touches(f, r.fromColumns)
					if (plainAdds(x.a) && t.adds) {
						add(x.id, id)
					}
					if (
						(x.a.action.op === "delete" || (plainRemoves(x.a) && !r.cascade)) &&
						(t.removes || t.changes)
					) {
						add(id, x.id)
					}
				}
				if (r.to === f.relation && r.from === x.a.action.relation) {
					const t = touches(f, r.toColumns)
					if (t.adds && plainAdds(x.a)) {
						add(id, x.id)
					}
					if ((t.removes || (t.changes && !r.cascade)) && plainRemoves(x.a)) {
						add(x.id, id)
					}
				}
			}
		}
	}
	return edges
}

/** Whether a family statement that changes rows in place changes one of `columns`. */
const changesAny = (f: FamilyNode, columns: ReadonlyArray<string>): boolean =>
	(f.kind === "owners" || f.statement === "update") &&
	Arr.some(f.changes, (c) => columns.includes(c))

/** Whether `edges` over a stratum's writes close a cycle. */
const hasCycle = (stratum: Stratum, edges: ReadonlySet<string>): boolean => {
	const writes = stratum.actions.length + stratum.family.length
	const next = new Map<number, Array<number>>()
	for (const edge of edges) {
		const [from, to] = edgeOf(edge)
		next.set(from, [...(next.get(from) ?? []), to])
	}
	const state = new Map<number, "open" | "done">()
	const visit = (at: number): boolean => {
		state.set(at, "open")
		for (const to of next.get(at) ?? []) {
			const seen = state.get(to)
			if (seen === "open" || (seen === undefined && visit(to))) {
				return true
			}
		}
		state.set(at, "done")
		return false
	}
	return Arr.some(Arr.range(0, writes - 1), (w) => state.get(w) === undefined && visit(w))
}

/**
 * The import's shape the schedule once refused: R2, inserted by the stratum's own action, names R0 by an immediate key
 * over R0's count, as a containment from R2 into a selection of R0 by its count does, and owns a counted family of R3,
 * whose update in place the stratum plans; R0's counted family of R1 takes an insert and so a count. A total order of the family statements put the update before every count, the count of R0 before R2's
 * insert, and R2's insert before the update of its member: a cycle no key requires.
 */
const importShape: Stratum = {
	actions: [
		{
			pureSet: false,
			action: {
				op: "insert",
				serial: completeClass,
				relation: "R2",
				source: { kind: "enumerated", slot: ParamId("R2 member") }
			}
		}
	],
	family: [
		{ kind: "rows", relation: "R3", statement: "update", changes: ["field:c1"] },
		{
			kind: "owners",
			family: { owner: "R0", count: "n0" },
			relation: "R0",
			member: "R1",
			changes: ["field:n0", "field:e0"]
		},
		{
			kind: "owners",
			family: { owner: "R2", count: "n1" },
			relation: "R2",
			member: "R3",
			changes: ["field:n1", "field:e1"]
		},
		{ kind: "rows", relation: "R1", statement: "insert" }
	],
	pairs: [
		{
			family: { owner: "R0", count: "n0" },
			owner: "R0",
			member: "R1",
			immediate: true,
			fromColumns: ["field:g0", "law:n0", "field:c0"],
			toColumns: ["field:id", "field:n0", "field:a"]
		},
		{
			family: { owner: "R2", count: "n1" },
			owner: "R2",
			member: "R3",
			immediate: true,
			fromColumns: ["field:g1", "law:n1", "field:c1"],
			toColumns: ["field:id", "field:n1", "field:a"]
		}
	],
	references: [
		{
			from: "R1",
			to: "R0",
			cascade: true,
			fromColumns: ["field:g0", "law:n0", "field:c0"],
			toColumns: ["field:id", "field:n0", "field:a"]
		},
		{
			from: "R3",
			to: "R2",
			cascade: true,
			fromColumns: ["field:g1", "law:n1", "field:c1"],
			toColumns: ["field:id", "field:n1", "field:a"]
		},
		{
			from: "R2",
			to: "R0",
			cascade: false,
			fromColumns: ["field:a"],
			toColumns: ["field:id", "field:n0"]
		}
	]
}

/**
 * A cycle of families the schedule once refused: R1 owns an ordered family of R0, and R0 a counted family of R1, both
 * owner axes on that cycle and so deferred. An insert of R1 nesting R0 writes both relations and counts R0's family of
 * R1; an owner's insertion ordered before its member's for both families, deferred axes or not, closed a cycle no key
 * requires.
 */
const familyCycle: Stratum = {
	actions: [],
	family: [
		{ kind: "rows", relation: "R1", statement: "delete" },
		{
			kind: "owners",
			family: { owner: "R0", count: "n1" },
			relation: "R0",
			member: "R1",
			changes: ["field:n1", "field:e1"]
		},
		{ kind: "rows", relation: "R0", statement: "insert" },
		{ kind: "rows", relation: "R1", statement: "insert" }
	],
	pairs: [
		{
			family: { owner: "R1", count: "n0" },
			owner: "R1",
			member: "R0",
			immediate: false,
			fromColumns: ["field:g0", "law:n0", "field:c0"],
			toColumns: ["field:id", "field:n0", "field:a"]
		},
		{
			family: { owner: "R0", count: "n1" },
			owner: "R0",
			member: "R1",
			immediate: false,
			fromColumns: ["field:g1", "law:n1", "field:c1"],
			toColumns: ["field:id", "field:n1", "field:a"]
		}
	],
	references: []
}

type StratumSituation =
	| "ordered"
	| "refused: a required cycle"
	| "several counts of one relation"
	| "counts, updates and inserts together"
	| "a reference from a plain relation into a family member"
	| "a family member's reference into a plain relation"
	| "a cycle of families"

const stratumSituations: Arr.NonEmptyReadonlyArray<StratumSituation> = [
	"ordered",
	"refused: a required cycle",
	"several counts of one relation",
	"counts, updates and inserts together",
	"a reference from a plain relation into a family member",
	"a family member's reference into a plain relation",
	"a cycle of families"
]

/** Whether a stratum's families form a cycle, owner to member and back. */
const familiesCycle = (pairs: ReadonlyArray<FamilyPair>): boolean => {
	const reaches = (from: string, to: string, seen: ReadonlySet<string>): boolean =>
		Arr.some(
			pairs,
			(p) =>
				p.owner === from &&
				(p.member === to ||
					(!seen.has(p.member) && reaches(p.member, to, new Set([...seen, p.member]))))
		)
	return Arr.some(pairs, (p) => reaches(p.member, p.owner, new Set([p.member])))
}

/** The shapes a generated stratum holds. */
const stratumShapes = (stratum: Stratum): ReadonlyArray<StratumSituation> => {
	const owners = Arr.flatMap(stratum.family, (f) => (f.kind === "owners" ? [f.relation] : []))
	const familyRelations = new Set(Arr.map(stratum.family, (f) => f.relation))
	const plainRelations = new Set(Arr.map(stratum.actions, (a) => a.action.relation))
	const has = (statement: "update" | "insert") =>
		Arr.some(stratum.family, (f) => f.kind === "rows" && f.statement === statement)
	return [
		...(new Set(owners).size < owners.length ? (["several counts of one relation"] as const) : []),
		...(owners.length > 0 && has("update") && has("insert")
			? (["counts, updates and inserts together"] as const)
			: []),
		...(Arr.some(stratum.references, (r) => plainRelations.has(r.from) && familyRelations.has(r.to))
			? (["a reference from a plain relation into a family member"] as const)
			: []),
		...(Arr.some(stratum.references, (r) => familyRelations.has(r.from) && plainRelations.has(r.to))
			? (["a family member's reference into a plain relation"] as const)
			: []),
		...(familiesCycle(stratum.pairs) ? (["a cycle of families"] as const) : [])
	]
}

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
								[],
								[
									{
										from: nameOf(shape, "C"),
										to: nameOf(shape, "P"),
										cascade: false,
										fromColumns: ["field:p"],
										toColumns: ["field:id"]
									}
								]
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

	it.effect(
		"orders every generated stratum exactly when the writes' required order holds no cycle, and keeps every required order",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/write/schedule-strata",
						draw: drawn(stratumGen),
						literal: Formatter.format,
						coverage: required<StratumSituation>(stratumSituations, {
							cases: 400,
							sense: notesOnly
						}),
						kept: [
							{
								note: "an import's shape: a plain owner inserted beside its family's member updated, and the count of another owner the plain owner names",
								sketch: importShape,
								draws: "",
								reaches: [
									"ordered",
									"counts, updates and inserts together",
									"a reference from a plain relation into a family member"
								]
							},
							{
								note: "a cycle of families, both owner axes deferred, written by one nested insert",
								sketch: familyCycle,
								draws: "",
								reaches: ["ordered", "a cycle of families"]
							}
						],
						runs: 300,
						shrink: boundedShrink(400),
						concurrency: 1,
						steerEvery: 16,
						caseHang,
						oracle: {
							kind: "second-implementation",
							name: "the required order of a stratum's writes, stated edge by edge from the keys and the family planner's rules"
						}
					},
					(stratum, c) =>
						Effect.sync(() => {
							c.noteAll(stratumShapes(stratum))
							const required = requiredEdges(stratum)
							const cyclic = hasCycle(stratum, required)
							const schedule = scheduleStratum(
								canonicalActionOrder(stratum.actions),
								stratum.family,
								stratum.pairs,
								stratum.references
							)
							if (schedule.kind === "cycle") {
								assert.ok(
									cyclic,
									"the schedule refuses only a stratum whose required order has a cycle"
								)
								const cycle = Arr.map(schedule.cycle, (w) => writeId(stratum, w))
								for (const [i, at] of cycle.entries()) {
									const next = defined(cycle[(i + 1) % cycle.length], "a cycle's next write")
									assert.ok(
										required.has(edgeKey(at, next)),
										`the cycle's ${String(at)} before ${String(next)} is required`
									)
								}
								c.note("refused: a required cycle")
								return
							}
							assert.ok(
								!cyclic,
								"the schedule orders every stratum whose required order has no cycle"
							)
							const position = new Map<number, number>()
							let next = 0
							for (let i = 0; i <= schedule.actions.length; i += 1) {
								for (const f of schedule.family) {
									if (f.at === i) {
										position.set(writeId(stratum, { kind: "family", node: f.node }), next)
										next += 1
									}
								}
								const action = schedule.actions[i]
								if (action !== undefined) {
									position.set(writeId(stratum, { kind: "action", action: action.scheduled }), next)
									next += 1
								}
							}
							for (const edge of required) {
								const [from, to] = edgeOf(edge)
								assert.ok(
									defined(position.get(from), "a placed write") <
										defined(position.get(to), "a placed write"),
									`the required order ${String(from)} before ${String(to)} holds`
								)
							}
							c.note("ordered")
						})
				)
			)
	)
})
