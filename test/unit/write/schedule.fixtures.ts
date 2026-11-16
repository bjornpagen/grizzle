/** What the properties of schedule.test.ts read: its spaces, models and helpers. */

import { aimed, boolean, constant, element, type Gen, int, subarray } from "@bjornpagen/testing/gen"
import { Array as Arr, Option, String as Str } from "effect"
import { maxOf } from "#compiler/core/array.ts"
import { ParamId, StoredRelationName } from "#compiler/core/ids.ts"
import type { ActionCore } from "#compiler/ir/write.ts"
import { completeClass } from "#compiler/ir/write.ts"
import {
	type FamilyNode as AnyFamilyNode,
	type FamilyPair,
	type ImmediateReference,
	type Meeting,
	type MemberEdit,
	type MemberOp,
	type RefillOrder,
	updateChanges,
	type Write
} from "#compiler/write/frontend/schedule.ts"
import { defined } from "#test/support/assert.ts"
import { upTo } from "#test/support/up-to.ts"

/** A family statement this model's strata hold: a member relation's rows or a family's counts, the planner's own. */
type FamilyNode = Exclude<AnyFamilyNode, { readonly kind: "additions" | "removals" | "unit" }>

/** An operation of a stratum's action on C, or an explicit one on P. */
type Op = "delete" | "put" | "insert"

/** An operation of a stratum's action on P: an explicit one, or a generated insertion, which draws P's id. */
type TargetOp = Op | "generated"

/** The phase of an operation on its own relation, the schedule's: deletions, then puts, then insertions, then generated
 * insertions. */
export const phase: { readonly [O in TargetOp]: number } = {
	delete: 0,
	put: 1,
	insert: 2,
	generated: 3
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
	readonly onP: ReadonlyArray<TargetOp>
	readonly onC: ReadonlyArray<Op>
}

/** A fact: P's an id; C's an id and the P id it references, C's own id 1 when it has a payload. */
type Fact = readonly [id: number, p: number]

/** The ids of the box. */
const ids: Arr.NonEmptyReadonlyArray<number> = Arr.range(1, 2)

/** A write of an instance: an action's fact, or P's generated insertion, which is given none and draws its id. */
type Written =
	| { readonly relation: "C" | "P"; readonly op: Op; readonly fact: Fact }
	| { readonly relation: "P"; readonly op: "generated" }

/** A state of the box: P's ids, C's facts, and the last id P's sequence passed, at or past every stored P id. */
type State = {
	readonly p: ReadonlyArray<number>
	readonly c: ReadonlyArray<Fact>
	readonly seq: number
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
 * An instance's writes as the host's normalization leaves them: a P id both deleted and added explicitly is only added,
 * and one both put and inserted is only put; a drawn id is no write's, so nothing nets against it; C writes one fact.
 */
const normalized = (instance: Instance): ReadonlyArray<Written> => {
	const added = (op: Op) =>
		Arr.flatMap(instance.writes, (w) =>
			w.op !== "generated" && w.relation === "P" && w.op === op ? [w.fact[0]] : []
		)
	return Arr.filter(instance.writes, (w) => {
		if (w.op === "generated" || w.relation === "C") {
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

/**
 * One action's statements, each a change of the state, in the order the action sends them. An explicit P id advances
 * P's sequence past it, and a generated insertion adds the next id the sequence draws.
 */
const statementsOf = (shape: Shape, w: Written): ReadonlyArray<(s: State) => State> => {
	if (w.op === "generated") {
		return [(s) => ({ ...s, p: [...s.p, s.seq + 1], seq: s.seq + 1 })]
	}
	if (w.relation === "P") {
		const [id] = w.fact
		const add = (s: State): State => ({
			...s,
			p: s.p.includes(id) ? s.p : [...s.p, id],
			seq: Math.max(s.seq, id)
		})
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
 * additions, the draw past every explicit id, then C's write, whatever the states between them.
 */
const finalOf = (shape: Shape, instance: Instance): State => {
	const writes = normalized(instance)
	const phased = [
		...Arr.flatMap(["delete", "put", "insert", "generated"] as const, (op) =>
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
	order: ReadonlyArray<{ readonly relation: "C" | "P"; readonly op: TargetOp }>
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
 * at every position of P's sequence at or past its stored ids where the shape draws one, with every write of each
 * action at an id of the box, whose final state keeps them too.
 */
export const instancesOf = (shape: Shape): ReadonlyArray<Instance> => {
	const facts = (ref: number): Fact => [1, ref]
	const passed = (p: ReadonlyArray<number>): ReadonlyArray<number> =>
		shape.onP.includes("generated") ? upTo(3 - maxOf(p, 0), (i) => maxOf(p, 0) + i) : [maxOf(p, 0)]
	const states = Arr.flatMap(subsets(ids), (p) =>
		Arr.flatMap(subsets(Arr.map(ids, facts)), (c) => Arr.map(passed(p), (seq) => ({ p, c, seq })))
	)
	const choices: ReadonlyArray<ReadonlyArray<Written>> = [
		...Arr.map(shape.onP, (op): ReadonlyArray<Written> =>
			op === "generated"
				? [{ relation: "P", op }]
				: Arr.map(ids, (id): Written => ({ relation: "P", op, fact: [id, id] }))
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

export const actionOf = (shape: Shape, relation: "C" | "P", op: TargetOp): ActionCore => {
	const source = { kind: "enumerated", slot: ParamId(`${relation} ${op}`) } as const
	const name = nameOf(shape, relation)
	switch (op) {
		case "generated":
			return { op: "insert", serial: { kind: "generated", drawn: ["id"] }, relation: name, source }
		case "insert":
			return { op: "insert", serial: completeClass, relation: name, source }
		case "put":
			return { op: "put", relation: name, source }
		case "delete":
			return { op: "delete", relation: name, source }
	}
}

/** The explicit operations of an action. */
const explicitOps = ["delete", "put", "insert"] as const

/**
 * Every shape: C's name, both payloads, any set of P's actions, a generated insertion among them where P is a pure set,
 * whose id is its key, and one action of C or none.
 */
export const shapeGen: Gen<Shape> = (source) => {
	const sourceFirst = source.draw(boolean)
	const keyed = source.draw(boolean)
	const targetKeyed = source.draw(boolean)
	const onP: ReadonlyArray<TargetOp> = targetKeyed ? explicitOps : [...explicitOps, "generated"]
	return {
		sourceFirst,
		keyed,
		targetKeyed,
		onP: source.draw(subarray(onP)),
		onC: source.draw(boolean) ? [source.draw(element(explicitOps))] : []
	}
}

export type Situation =
	| "the schedule orders a stratum"
	| "no order keeps a stratum"
	| "a pure set's deletion after its addition"
	| "both put, the source named first"
	| "both put, the target named first"
	| "a generated insertion beside its relation's deletion"

/**
 * A generated stratum at an import's scale: up to 24 relations, families between them, each an owner and a member, and
 * the stratum's writes: plain actions of the relations no family has as a member, a deletion, a put, an insertion of
 * given facts or a generated insertion each, and family statements of the members it edits, their deletions, updates in
 * place and insertions, and the counts of every family of an edited member, so an owner of several families takes
 * several counts. Its immediate references are each family's owner axis, where drawn immediate, cascading and naming
 * the member's group, count copy and a copy of the owner's `a`, and laws' keys between any two relations, naming
 * columns drawn from each side.
 *
 * The box before this one draws two relations and plain actions alone, so no family statement ever met a search: the
 * total order the family statements used to keep among themselves, which together with a key between a plain action
 * and a family statement closed cycles no key requires, refused an import of 152 inserts beside updates and counts.
 *
 * A member it edits may take a refill too (analysis/theory/refill.ts), its rows rewritten in place ahead of a change, with
 * the order its refills require (`RefillOrder`): each refill before every put of a plain relation it is drawn ahead
 * of, and before or after a family statement of the stratum.
 *
 * Each member it edits states its operations (`edits`), and its update in place changes what the schedule's
 * `updateChanges` says they write: a member's caller fields are a and b, each family it is a member of draws an index
 * ‹i› and a copy c of its owner's a, and PostgreSQL generates h from a, q from h, and each family's ‹p› from its index,
 * as a predecessor's term is. An update once changed every column it could set whatever its edits wrote, so a deletion
 * of an ordered member, or an insertion of a counted one, counted against a key over a caller field it never writes.
 */
interface Stratum {
	readonly actions: ReadonlyArray<StratumAction>
	readonly family: ReadonlyArray<FamilyNode>
	readonly edits: ReadonlyArray<{
		readonly relation: StoredRelationName
		readonly edit: MemberEdit
	}>
	readonly pairs: ReadonlyArray<FamilyPair>
	readonly references: ReadonlyArray<ImmediateReference>
	readonly refills: RefillOrder
}

/** A stratum with no refill. */
export const noRefills: RefillOrder = { precedes: [], edges: [] }

/** A plain action of a generated stratum, by its relation and operation, and where its relation's facts meet. */
interface StratumAction {
	readonly action: ActionCore
	readonly meeting: Meeting
}

const relationName = (r: number): StoredRelationName => StoredRelationName(`R${String(r)}`)

const memberOps: ReadonlyArray<MemberOp> = ["insert", "put", "delete", "nested"]

/** A relation's generated columns: h from a, q from h, and the ‹p› of each family `k` of `memberOf` from its index. */
const generatedOn = (memberOf: ReadonlyArray<number>): MemberEdit["generated"] => [
	{ key: "law:q", reads: ["field:h"] },
	{ key: "field:h", reads: ["field:a"] },
	...Arr.map(memberOf, (k) => ({ key: `law:p${String(k)}`, reads: [`law:i${String(k)}`] }))
]

/** A plain action of a generated stratum: a deletion, a put, an insertion of given facts or a generated insertion,
 * which draws the relation's id. */
const plainAction = (
	op: "delete" | "put" | "insert" | "generated",
	relation: StoredRelationName,
	source: ActionCore["source"]
): ActionCore => {
	switch (op) {
		case "generated":
			return { op: "insert", serial: { kind: "generated", drawn: ["id"] }, relation, source }
		case "insert":
			return { op, serial: completeClass, relation, source }
		case "put":
		case "delete":
			return { op, relation, source }
	}
}

/** A family of a stratum by its number `k`: its owner and member relations, by number, its owner axis immediate or
 * deferred, and counted or ordered. */
interface FamilyDraw {
	readonly k: number
	readonly owner: number
	readonly member: number
	readonly immediate: boolean
	readonly counted: boolean
}

/**
 * How a stratum is drafted: how many relations it has, its families over them, how many laws' keys it holds, whether
 * a member relation is edited and, edited, inserted, and the operations its edit states.
 */
interface Drafting {
	readonly relations: Gen<number>
	readonly families: (n: number) => Gen<ReadonlyArray<FamilyDraw>>
	readonly laws: (n: number) => Gen<number>
	readonly edited: Gen<boolean>
	readonly inserted: Gen<boolean>
	readonly ops: Gen<ReadonlyArray<MemberOp>>
}

/**
 * Any stratum at an import's scale: up to 24 relations and as many families, whose owner comes before their member, but
 * where `cyclic` draws, which draws any two relations, so families may form a cycle, as an owner of an ordered family
 * whose member owns a counted family of it does; up to a law's key a relation; each member edited or not, and inserted
 * or not.
 */
const anyStratum: Drafting = {
	relations: int(2, 24),
	families: (n) => (source) =>
		upTo(source.draw(int(0, n)), (k) => {
			if (source.draw(boolean)) {
				const owner = source.draw(int(0, n - 1))
				const other = source.draw(int(0, n - 2))
				return {
					k,
					owner,
					member: other >= owner ? other + 1 : other,
					immediate: source.draw(boolean),
					counted: source.draw(boolean)
				}
			}
			const owner = source.draw(int(0, n - 2))
			return {
				k,
				owner,
				member: source.draw(int(owner + 1, n - 1)),
				immediate: source.draw(boolean),
				counted: source.draw(boolean)
			}
		}),
	laws: (n) => int(0, n),
	edited: boolean,
	inserted: boolean,
	ops: subarray(memberOps)
}

/**
 * A cycle of families alone: R0 owns a family of R1 and R1 one of R0, each counted or ordered, neither owner axis
 * immediate, so the axes lie on the cycle and are deferred and neither order of the two insertions is required; both
 * members edited and inserted, by insertions alone, so neither update in place changes a column an axis cascades, and
 * no law's key beside them.
 */
const deferredCycle: Drafting = {
	relations: constant(2),
	families: () => (source) => [
		{ k: 0, owner: 0, member: 1, immediate: false, counted: source.draw(boolean) },
		{ k: 1, owner: 1, member: 0, immediate: false, counted: source.draw(boolean) }
	],
	laws: () => constant(0),
	edited: constant(true),
	inserted: constant(true),
	ops: subarray(["insert", "nested"] as const)
}

/** A generated stratum, as `drafting` drafts it (see `Stratum`). */
const stratumOf =
	(drafting: Drafting): Gen<Stratum> =>
	(source) => {
		const n = source.draw(drafting.relations)
		const families = source.draw(drafting.families(n))
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
		/** The families `r` is a member of. */
		const memberOf = (r: number) => Arr.filter(families, (f) => f.member === r)
		/** The columns the host draws on `r`: each family's index and copy on its member, and each count and end on its owner. */
		const drawnOn = (r: number): ReadonlyArray<string> => [
			...Arr.flatMap(memberOf(r), (f) => [`law:i${String(f.k)}`, `field:c${String(f.k)}`]),
			...Arr.flatMap(families, (f) =>
				f.owner === r ? [`field:n${String(f.k)}`, `field:e${String(f.k)}`] : []
			)
		]
		const columnsOf = (r: number): ReadonlyArray<string> => [
			"field:id",
			"field:a",
			"field:b",
			"field:h",
			"law:q",
			...drawnOn(r),
			...Arr.map(memberOf(r), (f) => `law:p${String(f.k)}`)
		]
		const laws = upTo(source.draw(drafting.laws(n)), (): ImmediateReference => {
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
		const refilled: Array<FamilyNode> = []
		const edits: Array<{ readonly relation: StoredRelationName; readonly edit: MemberEdit }> = []
		for (let r = 0; r < n; r += 1) {
			const relation = relationName(r)
			if (!members.has(r)) {
				const meeting = source.draw(element(["key", "unique", "nowhere"] as const))
				const source_ = { kind: "enumerated", slot: ParamId(`${relation} member`) } as const
				for (const op of source.draw(subarray(["delete", "put", "insert", "generated"] as const))) {
					actions.push({ meeting, action: plainAction(op, relation, source_) })
				}
				continue
			}
			if (!source.draw(drafting.edited)) {
				continue
			}
			if (source.draw(boolean)) {
				family.push({ kind: "rows", relation, statement: "delete" })
			}
			const rewritten = source.draw(subarray(columnsOf(r)))
			const refill = Arr.isReadonlyArrayNonEmpty(rewritten) && source.draw(boolean)
			if (refill) {
				refilled.push({ kind: "rows", relation, statement: "refill", changes: rewritten })
			}
			const edit: MemberEdit = {
				ops: source.draw(drafting.ops),
				own: ["field:a", "field:b"],
				placed: Arr.flatMap(memberOf(r), (f) =>
					f.counted ? [`law:i${String(f.k)}`, `field:c${String(f.k)}`] : []
				),
				refreshed: refill ? drawnOn(r) : [],
				generated: generatedOn(Arr.map(memberOf(r), (f) => f.k))
			}
			edits.push({ relation, edit })
			updates.push({ kind: "rows", relation, statement: "update", changes: updateChanges(edit) })
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
			if (source.draw(drafting.inserted)) {
				inserts.push({ kind: "rows", relation, statement: "insert" })
			}
		}
		const statements = [...family, ...refilled, ...updates, ...counts, ...inserts]
		const plainPuts = Arr.dedupe(
			Arr.flatMap(actions, (a) => (a.action.op === "put" ? [a.action.relation] : []))
		)
		const pick = <A>(xs: Arr.NonEmptyReadonlyArray<A>): A =>
			defined(xs[source.draw(int(0, xs.length - 1))], "a drawn element")
		const refills: RefillOrder = {
			precedes: Arr.flatMap(refilled, (node) =>
				Arr.isReadonlyArrayNonEmpty(plainPuts) && source.draw(boolean)
					? [{ node, relation: pick(plainPuts) }]
					: []
			),
			edges: Arr.flatMap(refilled, (node) => {
				const others = Arr.filter(statements, (f) => f !== node)
				return Arr.isReadonlyArrayNonEmpty(others) && source.draw(boolean)
					? [
							source.draw(boolean)
								? { before: node, after: pick(others) }
								: { before: pick(others), after: node }
						]
					: []
			})
		}
		return {
			actions,
			family: statements,
			edits,
			pairs: Arr.map(families, (f) => ({
				family: { owner: relationName(f.owner), count: `n${String(f.k)}` },
				owner: relationName(f.owner),
				member: relationName(f.member),
				immediate: f.immediate,
				...axisOf(f)
			})),
			references: [...ownAxis, ...laws],
			refills
		}
	}

/**
 * The strata the search draws: any (`anyStratum`), or, while an orderable deferred cycle of families both of whose
 * members are inserted is pending, that cycle alone (`deferredCycle`), which an order of owners before their members
 * refuses.
 */
export const strataDraw = aimed(stratumOf(anyStratum), [
	[
		"a cycle of families, both owner axes deferred, both inserted, its required order acyclic",
		stratumOf(deferredCycle)
	]
])

/** A write of a stratum by its number: an action's position among its actions, a family statement's after them. */
export const writeId = <A>(stratum: Stratum, w: Write<A>): number =>
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

export const edgeKey = (from: number, to: number): string => `${String(from)}>${String(to)}`

export const edgeOf = (key: string): readonly [number, number] => {
	const [from, to] = Str.split(key, ">")
	return [Number(defined(from, "an edge's first")), Number(defined(to, "an edge's second"))]
}

/** The phase of a plain action on its own relation: deletions, then puts, then insertions of given facts, then
 * generated insertions. */
const plainPhase = (a: ActionCore): number =>
	generatedInsertion(a) ? 3 : a.op === "insert" ? 2 : a.op === "put" ? 1 : 0

/** Whether a plain action is a generated insertion, which draws its relation's serial values. */
const generatedInsertion = (a: ActionCore): boolean =>
	a.op === "insert" && a.serial.kind === "generated"

/**
 * Every order a stratum's writes require, edge by edge, stated apart from the schedule:
 * - a referenced fact is added before a fact that names it, and a naming fact removed before the fact it names: an
 *   insertion or a put adds, a deletion or a put of a relation with a payload removes; a family's insertion adds and
 *   its deletion removes, and its update in place or count adds and changes facts only at the columns it changes, a
 *   change a removal only where no cascade carries it;
 * - one relation's plain deletion, put, insertion of given facts and generated insertion run in that order, save the
 *   deletion of a relation whose facts meet nowhere, which frees nothing its put or insertion of given facts takes, but
 *   precedes its generated insertion: the deletion excepts only the stratum's complete additions, so after a draw it
 *   would delete the drawn fact at a value it names; and its plain actions before its family statements;
 * - a member's deletion, update and insertion run in that order; a family's count after its member's and its owner's
 *   deletions and updates and before its owner's insertions, and before its member's where the owner axis is
 *   immediate; a member's update before its owner's update or refill where the one changes a column the owner axis
 *   cascades into and the other one it reads; and a family insertion before the family insertion that names it by an
 *   immediate key, and a family deletion that names before the one it names, so an owner's insertion before its
 *   members' where the owner axis is immediate and in no order where it is deferred. Nothing else orders family
 *   statements among themselves: two families' statements of unrelated relations, an owner's counts of several families
 *   among them, run in any order;
 * - a refill, an update in place of the rows a change leaves stale, after its relation's deletion, which frees the
 *   slots it moves members into, and before every count of a family its relation owns or is a member of, as an update
 *   is; before every put of a relation its refills' order says it is drawn ahead of, and before or after each family
 *   statement that order names. A refill changes facts at its columns as an update in place does.
 */
export const requiredEdges = (stratum: Stratum): ReadonlySet<string> => {
	const edges = new Set<string>()
	const add = (from: number | undefined, to: number | undefined): void => {
		if (from !== undefined && to !== undefined && from !== to && from >= 0 && to >= 0) {
			edges.add(edgeKey(from, to))
		}
	}
	const plains = Arr.map(stratum.actions, (a, i) => ({ a, id: i }))
	const families = Arr.map(stratum.family, (f, i) => ({ f, id: stratum.actions.length + i }))
	const rowsOf = (relation: string, statement: "delete" | "refill" | "update" | "insert") =>
		Arr.findFirst(
			families,
			({ f }) => f.kind === "rows" && f.relation === relation && f.statement === statement
		).pipe(
			Option.map((x) => x.id),
			Option.getOrUndefined
		)
	const plainAdds = (a: StratumAction) => a.action.op !== "delete"
	const plainRemoves = (a: StratumAction) =>
		a.action.op === "delete" || (a.action.op === "put" && a.meeting === "key")
	for (const x of plains) {
		for (const y of plains) {
			const a = x.a.action
			const b = y.a.action
			if (x.id === y.id) {
				continue
			}
			if (a.relation === b.relation) {
				if (
					plainPhase(a) < plainPhase(b) &&
					(x.a.meeting !== "nowhere" || a.op !== "delete" || generatedInsertion(b))
				) {
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
			if (f.statement === "refill") {
				add(rowsOf(f.relation, "delete"), id)
				continue
			}
			if (f.statement !== "delete") {
				add(rowsOf(f.relation, "delete"), id)
			}
			if (f.statement !== "insert") {
				add(id, rowsOf(f.relation, "insert"))
			}
			continue
		}
		for (const relation of [f.relation, f.member]) {
			add(rowsOf(relation, "delete"), id)
			add(rowsOf(relation, "refill"), id)
			add(rowsOf(relation, "update"), id)
		}
		add(id, rowsOf(f.relation, "insert"))
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
	/** A family statement's number, by its identity: its kind, its relation and statement, or its family. */
	const statementOf = (node: AnyFamilyNode): number | undefined =>
		Arr.findFirst(families, ({ f }) =>
			node.kind === "owners"
				? f.kind === "owners" &&
					f.family.owner === node.family.owner &&
					f.family.count === node.family.count
				: node.kind === "rows" &&
					f.kind === "rows" &&
					f.relation === node.relation &&
					f.statement === node.statement
		).pipe(
			Option.map((x) => x.id),
			Option.getOrUndefined
		)
	for (const p of stratum.refills.precedes) {
		for (const x of plains) {
			if (x.a.action.relation === p.relation && x.a.action.op === "put") {
				add(statementOf(p.node), x.id)
			}
		}
	}
	for (const e of stratum.refills.edges) {
		add(statementOf(e.before), statementOf(e.after))
	}
	/** The statement `statement` of `relation`, where the stratum holds one, with its number. */
	const nodeOf = (relation: string, statement: "refill" | "update") =>
		Arr.findFirst(
			families,
			({ f }) => f.kind === "rows" && f.relation === relation && f.statement === statement
		).pipe(Option.getOrUndefined)
	for (const p of stratum.pairs) {
		const member = nodeOf(p.member, "update")
		if (p.owner === p.member || member === undefined || !changesAny(member.f, p.fromColumns)) {
			continue
		}
		for (const owner of [nodeOf(p.owner, "refill"), nodeOf(p.owner, "update")]) {
			if (owner !== undefined && changesAny(owner.f, p.toColumns)) {
				add(member.id, owner.id)
			}
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
	const touches = (f: FamilyNode, columns: ReadonlyArray<string>) => {
		if (f.kind === "rows" && (f.statement === "insert" || f.statement === "delete")) {
			return { adds: f.statement === "insert", removes: f.statement === "delete", changes: false }
		}
		const at = changesAny(f, columns)
		return { adds: at, removes: false, changes: at }
	}
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
	(f.kind === "owners" || f.statement === "refill" || f.statement === "update") &&
	Arr.some(f.changes, (c) => columns.includes(c))

/**
 * What a stratum's edits of a member write in place, operation by operation, as the family planner writes them
 * (write/family/edit.ts): an insertion and a nested write's row write nothing in place, each inserted whole, and a
 * sequence re-places its members by a deletion and an insertion; a deletion moves a counted family's last member into
 * the slot it frees and draws its values again, and a refilled relation's rows so written carry every value the
 * stratum's other changes leave; a put writes its caller's fields besides, and what a deletion writes, since it may
 * move its member between groups or change a value a counted family draws from. PostgreSQL then generates again every
 * generated column one of those feeds, through another or not.
 */
export const writtenInPlace = (edit: MemberEdit): ReadonlySet<string> => {
	const byOp = (op: MemberOp): ReadonlyArray<string> => {
		switch (op) {
			case "insert":
			case "nested":
				return []
			case "delete":
				return [...edit.placed, ...edit.refreshed]
			case "put":
				return [...edit.own, ...edit.placed, ...edit.refreshed]
		}
	}
	const close = (known: ReadonlySet<string>): ReadonlySet<string> => {
		const fed = Arr.filter(
			edit.generated,
			(g) => !known.has(g.key) && Arr.some(g.reads, (r) => known.has(r))
		)
		return Arr.isReadonlyArrayNonEmpty(fed)
			? close(new Set([...known, ...Arr.map(fed, (g) => g.key)]))
			: known
	}
	return close(new Set(Arr.flatMap(edit.ops, byOp)))
}

/** Whether `edges` over a stratum's writes close a cycle. */
export const hasCycle = (stratum: Stratum, edges: ReadonlySet<string>): boolean => {
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
	return Arr.some(
		upTo(writes, (i) => i),
		(w) => state.get(w) === undefined && visit(w)
	)
}

export type StratumSituation =
	| "ordered"
	| "refused: a required cycle"
	| "several counts of one relation"
	| "counts, updates and inserts together"
	| "a reference from a plain relation into a family member"
	| "a family member's reference into a plain relation"
	| "a refill drawn ahead of a plain put"
	| "a refill ordered against another family statement"
	| "a cycle of families"
	| "a cycle of families, both owner axes deferred, both inserted, its required order acyclic"
	| "an update that writes no column in place"

export const stratumSituations: Arr.NonEmptyReadonlyArray<StratumSituation> = [
	"ordered",
	"refused: a required cycle",
	"several counts of one relation",
	"counts, updates and inserts together",
	"a reference from a plain relation into a family member",
	"a family member's reference into a plain relation",
	"a refill drawn ahead of a plain put",
	"a refill ordered against another family statement",
	"a cycle of families",
	"a cycle of families, both owner axes deferred, both inserted, its required order acyclic",
	"an update that writes no column in place"
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
export const stratumShapes = (stratum: Stratum): ReadonlyArray<StratumSituation> => {
	const owners = Arr.flatMap(stratum.family, (f) => (f.kind === "owners" ? [f.relation] : []))
	const familyRelations = new Set<string>(Arr.map(stratum.family, (f) => f.relation))
	const plainRelations = new Set<string>(Arr.map(stratum.actions, (a) => a.action.relation))
	const has = (statement: "update" | "insert") =>
		Arr.some(stratum.family, (f) => f.kind === "rows" && f.statement === statement)
	/** Whether the stratum inserts rows of `relation`. */
	const inserted = (relation: string) =>
		Arr.some(
			stratum.family,
			(f) => f.kind === "rows" && f.relation === relation && f.statement === "insert"
		)
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
		...(Arr.isReadonlyArrayNonEmpty(stratum.refills.precedes)
			? (["a refill drawn ahead of a plain put"] as const)
			: []),
		...(Arr.isReadonlyArrayNonEmpty(stratum.refills.edges)
			? (["a refill ordered against another family statement"] as const)
			: []),
		...(familiesCycle(stratum.pairs) ? (["a cycle of families"] as const) : []),
		...(Arr.some(
			stratum.pairs,
			(p) =>
				!p.immediate &&
				inserted(p.owner) &&
				inserted(p.member) &&
				Arr.some(stratum.pairs, (q) => !q.immediate && q.owner === p.member && q.member === p.owner)
		) && !hasCycle(stratum, requiredEdges(stratum))
			? ([
					"a cycle of families, both owner axes deferred, both inserted, its required order acyclic"
				] as const)
			: []),
		...(Arr.some(
			stratum.family,
			(f) => f.kind === "rows" && f.statement === "update" && f.changes.length === 0
		)
			? (["an update that writes no column in place"] as const)
			: [])
	]
}
