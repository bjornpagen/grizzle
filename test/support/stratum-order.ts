import { Array as Arr, Option } from "effect"

/**
 * Where two distinct facts of a relation meet (schedule.ts Meeting): at its primary key, where a field it carries lies
 * outside the key; else, a pure set's, at a unique object besides the key; else nowhere.
 */
export type Meeting = "key" | "unique" | "nowhere"

/** A relation as a stratum's order reads it: where its facts meet, and whether its identity draws some field of it. */
export interface OrderRelation {
	readonly name: string
	readonly meeting: Meeting
	readonly serial: boolean
}

/** An immediate reference, checked at every statement: facts of `from` name facts of `to`. */
export interface OrderReference {
	readonly from: string
	readonly to: string
}

/**
 * A schema as a stratum's order reads it: where each relation's facts meet, whether its identity draws a field, and the
 * immediate references between relations. The order is grizzle's schedule's (packages/engine/src/write/frontend/
 * schedule.ts), and the write oracle (oracle/write/expect.ts) and the law model (laws/model.ts) both judge
 * UnorderableStratum by this one model of it, each over its own schema.
 */
export interface OrderSchema {
	readonly relations: ReadonlyArray<OrderRelation>
	readonly references: ReadonlyArray<OrderReference>
}

/**
 * A stratum's member as the front end drafts writes from it: a deletion or a put; an insertion from enumerated facts,
 * an array or a Stream; or a described insertion, whose query's head delivers complete facts or leaves every serial
 * field out (generated).
 */
export type OrderMember =
	| { readonly relation: string; readonly op: "delete" | "put" }
	| {
			readonly relation: string
			readonly op: "insert"
			readonly source: "enumerated" | "complete" | "generated"
	  }

/**
 * A write the schedule orders, as the front end drafts it (write/frontend/compile.ts compileChangeSet, steps 2 and 3):
 * a deletion or a put of a relation, or an insertion of its complete facts or of its generated ones, which leave every
 * serial field to its identity.
 */
export type Drafted =
	| { readonly relation: string; readonly op: "delete" }
	| { readonly relation: string; readonly op: "put" }
	| { readonly relation: string; readonly op: "insert"; readonly facts: "complete" | "generated" }

/**
 * One stratum's writes as the keys order them: each class of write it drafts once (`draftedOf`), since writes of one
 * class order alike and never one another, and each pair the keys order, the first before the second (`runsBefore`).
 */
export interface StratumOrder {
	readonly writes: ReadonlyArray<Drafted>
	readonly before: ReadonlyArray<readonly [Drafted, Drafted]>
}

const relationIn = (schema: OrderSchema, name: string): OrderRelation => {
	const r = Arr.findFirst(schema.relations, (x) => x.name === name)
	if (Option.isNone(r)) {
		throw new Error(`the order's schema holds no relation ${name}`)
	}
	return r.value
}

/**
 * The writes a member drafts: a deletion and a put their own; an insertion into a relation whose identity draws no
 * field its complete facts; an enumerated insertion into one that does both classes, whatever facts it holds, since
 * the program is compiled before its facts are drawn; and a described insertion the class its head delivers.
 */
const draftedOf = (schema: OrderSchema, m: OrderMember): ReadonlyArray<Drafted> => {
	if (m.op !== "insert") {
		return [{ relation: m.relation, op: m.op }]
	}
	const complete: Drafted = { relation: m.relation, op: "insert", facts: "complete" }
	const generated: Drafted = { relation: m.relation, op: "insert", facts: "generated" }
	if (!relationIn(schema, m.relation).serial) {
		return [complete]
	}
	switch (m.source) {
		case "enumerated":
			return [complete, generated]
		case "complete":
			return [complete]
		case "generated":
			return [generated]
	}
}

/** A write's phase on its relation: deletion, then put, then insertion of complete facts, then of generated ones. */
const phaseOf = (w: Drafted): number =>
	w.op === "delete" ? 0 : w.op === "put" ? 1 : w.facts === "complete" ? 2 : 3

/** Whether a write removes facts: a deletion, or a put where facts meet at the key, which displaces its occupant. */
const removes = (schema: OrderSchema, w: Drafted): boolean =>
	w.op === "delete" || (w.op === "put" && relationIn(schema, w.relation).meeting === "key")

/**
 * Whether the keys run `a` before `b`, two writes of one stratum (schedule.ts scheduleStratum). On one relation, by
 * phase, its keys and unique objects being immediate; but a deletion where facts meet nowhere orders nothing against a
 * put or an insertion of complete facts, which meet no fact it frees but their own, which it excepts (D EXCEPT A),
 * while a generated insertion still follows it, whose drawn facts it does not except. Across an immediate reference
 * from C into P: P's additions before C's, and C's removals before P's.
 */
const runsBefore = (schema: OrderSchema, a: Drafted, b: Drafted): boolean => {
	if (a.relation === b.relation) {
		return (
			phaseOf(a) < phaseOf(b) &&
			!(
				a.op === "delete" &&
				relationIn(schema, a.relation).meeting === "nowhere" &&
				!(b.op === "insert" && b.facts === "generated")
			)
		)
	}
	const into = (from: string, to: string): boolean =>
		Arr.some(schema.references, (r) => r.from === from && r.to === to)
	return (
		(into(b.relation, a.relation) && a.op !== "delete" && b.op !== "delete") ||
		(into(a.relation, b.relation) && removes(schema, a) && removes(schema, b))
	)
}

/** Whether two drafted writes are one class: one relation, one op, and an insertion's one class of facts. */
const sameDrafted = (x: Drafted, y: Drafted): boolean =>
	x.relation === y.relation &&
	(x.op === "insert" && y.op === "insert" ? x.facts === y.facts : x.op === y.op)

/** The writes a stratum of `members` drafts and the pairs the keys order among them. */
export const stratumOrder = (
	schema: OrderSchema,
	members: ReadonlyArray<OrderMember>
): StratumOrder => {
	const writes = Arr.dedupeWith(
		Arr.flatMap(members, (m) => draftedOf(schema, m)),
		sameDrafted
	)
	return {
		writes,
		before: Arr.flatMap(writes, (a) =>
			Arr.flatMap(writes, (b): ReadonlyArray<readonly [Drafted, Drafted]> =>
				a !== b && runsBefore(schema, a, b) ? [[a, b]] : []
			)
		)
	}
}

/** Whether no order of `writes` keeps every pair of `before`: some remain once every write that follows none left is
 * taken away, again and again. */
const cyclic = (
	writes: ReadonlyArray<Drafted>,
	before: ReadonlyArray<readonly [Drafted, Drafted]>
): boolean => {
	const free = Arr.filter(
		writes,
		(w) => !Arr.some(before, ([x, y]) => y === w && writes.includes(x))
	)
	return free.length === 0
		? writes.length > 0
		: cyclic(
				Arr.filter(writes, (w) => !free.includes(w)),
				before
			)
}

/** Whether the keys order a stratum's writes in a cycle, which no order of its statements keeps: UnorderableStratum. */
export const unorderable = (order: StratumOrder): boolean => cyclic(order.writes, order.before)

/**
 * Whether a cycle an UnorderableStratum names, each write's relation and operation, is one of `order`'s: each of its
 * writes runs before the next by a pair the keys order, and the last before the first, an insertion either class the
 * stratum drafts.
 */
export const holdsCycle = (
	order: StratumOrder,
	cycle: Arr.NonEmptyReadonlyArray<{ readonly relation: string; readonly op: string }>
): boolean => {
	const drafted = (step: (typeof cycle)[number]): ReadonlyArray<Drafted> =>
		Arr.filter(order.writes, (w) => w.relation === step.relation && w.op === step.op)
	const precedes = (a: Drafted, b: Drafted): boolean =>
		Arr.some(order.before, ([x, y]) => x === a && y === b)
	const [first, ...rest] = cycle
	return Arr.some(drafted(first), (start) =>
		Arr.some(
			Arr.reduce(rest, [start], (reached: ReadonlyArray<Drafted>, step) =>
				Arr.filter(drafted(step), (w) => Arr.some(reached, (x) => precedes(x, w)))
			),
			(last) => precedes(last, start)
		)
	)
}

/** A drafted write as a report prints it. */
const printDrafted = (w: Drafted): string =>
	`${w.op} ${w.relation}${w.op === "insert" ? ` (${w.facts})` : ""}`

/** A stratum's order as a report prints it: each pair the keys order. */
export const printOrder = (order: StratumOrder): string =>
	order.before.length === 0
		? "no pair ordered"
		: Arr.join(
				Arr.map(order.before, ([a, b]) => `${printDrafted(a)} before ${printDrafted(b)}`),
				", "
			)
