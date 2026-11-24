/** What the properties of order.test.ts read: its spaces, models and helpers. */

import type { NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import { defined } from "@bjornpagen/testing/assert"
import { array, element, type Gen, int, map } from "@bjornpagen/testing/gen"
import { Array as Arr, Option, Order } from "effect"
import { SourceLoc } from "#compiler/core/loc.ts"
import { type Direction, directions } from "#compiler/core/order.ts"
import { contextAdmits } from "#compiler/ir/evidence.ts"
import type { KeyClasses } from "#compiler/ir/keys.ts"
import {
	conservativeMeta,
	type HeadingColumn,
	type OrderKey,
	type RelNode
} from "#compiler/ir/rel.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import { analyzeLogical, everyNode, orderSubjectOf } from "#compiler/logical/annotate.ts"
import type { OrderSubject } from "#compiler/logical/order.ts"
import { plainType } from "#compiler/scalar/native.ts"
import { succeeded } from "#test/support/assert.ts"
import { asc as ascending, type BuiltQuery, Ir } from "#test/support/fixtures/ir/build.ts"
import { closedIdTypeOf, scalarOf } from "#test/support/fixtures/ir/scalar.ts"
import * as W from "#test/support/fixtures/ir/work.ts"
import { logicalEnv, noImmediate, theoryUnder } from "#test/unit/analysis/logical/support.ts"

const int4 = plainType("int4")

/**
 * What a column of a case is, by how an order reads it: an integer and an ordered roster's closed id have an admitted
 * order, which a stated key reads and a completion breaks ties by; an unordered roster's closed id has none to state,
 * and its codes, which never move, still break a tie a completion leaves; a set, bytes and a search document have none
 * to state, and PostgreSQL's B-tree order of each breaks a tie a completion leaves.
 */
const columnKinds = [
	"integer",
	"ordered closed id",
	"unordered closed id",
	"set",
	"bytes",
	"search document"
] as const
type ColumnKind = (typeof columnKinds)[number]

/** Whether an order the caller states may name a column of `kind`: its type has an admitted order. */
export const statesOrder = (kind: ColumnKind): boolean =>
	kind === "integer" || kind === "ordered closed id"

/** The type of a column of each kind. */
const kindTypes: { readonly [K in ColumnKind]: ScalarType } = {
	integer: int4,
	"ordered closed id": closedIdTypeOf("Kind", "ordered", ["Automatic", "Manual"]),
	"unordered closed id": closedIdTypeOf("Hue", "unordered", ["Automatic", "Manual"]),
	set: scalarOf({ kind: "bits", roster: "Kind" }, { Kind: ["Automatic", "Manual"] }),
	bytes: scalarOf({ kind: "bytes" }, {}),
	"search document": scalarOf({ kind: "search", configuration: "english" }, {})
}

const col = (name: string, type: ScalarType): HeadingColumn => ({ name, type })

const asc = (column: string): OrderKey => ({ column, dir: "asc" })

const desc = (column: string): OrderKey => ({ column, dir: "desc" })

/** Every subset of the items, as a list in their order. */
const subsetsOf = <A>(items: ReadonlyArray<A>): ReadonlyArray<ReadonlyArray<A>> =>
	Arr.reduce(items, [[]], (sets: ReadonlyArray<ReadonlyArray<A>>, item) => [
		...sets,
		...Arr.map(sets, (set) => [...set, item])
	])

/**
 * A subject of the order completion, rows of one heading group read from an ORDER BY, with no fixed column unless
 * stated, each key one factor of one minimal key, and no column copying a declared key's field, so a key's columns keep
 * the order given them, the heading's (logical/key-order.ts declaredKeyOrder over a column that copies none).
 */
const subject = (
	heading: ReadonlyArray<HeadingColumn>,
	keys: ReadonlyArray<KeyClasses>,
	stated: Pick<OrderSubject, "fixed">
): OrderSubject => ({
	heading,
	keys: Arr.map(keys, (k) => [[k]] as const),
	loc: SourceLoc("orderBy", []),
	keyOrder: (columns) => columns,
	...stated
})

/** Every key a subject states: one minimal key of each of a key's factors, together. */
export const keysOf = (s: OrderSubject): ReadonlyArray<KeyClasses> =>
	Arr.flatMap(s.keys, (factors) =>
		Arr.reduce(factors, [[]], (keys: ReadonlyArray<KeyClasses>, alternatives) =>
			Arr.flatMap(keys, (k) => Arr.map(alternatives, (a): KeyClasses => [...k, ...a]))
		)
	)

/**
 * What the completion policy gives rows of one heading group, written from its statement (logical/order.ts) by search
 * rather than by key: the user's fields, each in the heading and once; then the fewest further fields, in heading order,
 * that with the user's and the fixed ones contain a key narrower than the heading, the lexicographically least set of
 * names among the fewest; else every remaining field in heading order: every kind here breaks ties, a set by its bits,
 * bytes and a search document by PostgreSQL's order (scalar/registry.ts breaksTies). A set contains a key over classes when it holds a column of each of its classes.
 */
type Spec =
	| { readonly kind: "refused"; readonly reason: Refusal }
	| {
			readonly kind: "order"
			readonly keys: ReadonlyArray<OrderKey>
			/** The step that made the order total. */
			readonly step: "stated" | "key" | "heading"
	  }

export const specOrder = (
	s: OrderSubject,
	user: ReadonlyArray<OrderKey>,
	kindOf: (column: string) => ColumnKind
): Spec => {
	const names = Arr.map(s.heading, (c) => c.name)
	const ordered = new Set<string>()
	for (const k of user) {
		if (!names.includes(k.column) || ordered.has(k.column)) {
			return { kind: "refused", reason: "MalformedDescription" }
		}
		if (!statesOrder(kindOf(k.column))) {
			return { kind: "refused", reason: "UnsupportedOperation" }
		}
		ordered.add(k.column)
	}
	const fixed = new Set(s.fixed)
	const covered = (extra: ReadonlyArray<string>) =>
		Arr.some(keysOf(s), (key) =>
			Arr.every(key, (members) =>
				Arr.some(members, (c) => ordered.has(c) || fixed.has(c) || extra.includes(c))
			)
		)
	if (names.length === 0 || covered([])) {
		return { kind: "order", keys: user, step: "stated" }
	}
	const remaining = Arr.filter(names, (c) => !ordered.has(c) && !fixed.has(c))
	const narrow = Arr.filter(keysOf(s), (key) => key.length < names.length)
	const reaches = (extra: ReadonlyArray<string>) =>
		Arr.some(narrow, (key) =>
			Arr.every(key, (members) =>
				Arr.some(members, (c) => ordered.has(c) || fixed.has(c) || extra.includes(c))
			)
		)
	/** Every set of remaining fields that break ties, the fewest first, then by its sorted names. */
	const sets = Arr.sort(
		subsetsOf(remaining),
		Order.combine(
			Order.mapInput(Order.Number, (set: ReadonlyArray<string>) => set.length),
			Order.mapInput(Arr.makeOrder(Order.String), (set: ReadonlyArray<string>) =>
				Arr.sort(set, Order.String)
			)
		)
	)
	const found = Arr.findFirst(sets, reaches)
	if (Option.isSome(found)) {
		const least = found.value
		return {
			kind: "order",
			keys: [
				...user,
				...Arr.map(
					Arr.filter(remaining, (c) => least.includes(c)),
					asc
				)
			],
			step: "key"
		}
	}
	return { kind: "order", keys: [...user, ...Arr.map(remaining, asc)], step: "heading" }
}

/**
 * A generated subject: a heading of up to four integer columns, each column joined to the class of an earlier one or
 * none, keys and fixed columns as masks over it, a key over the classes of the columns its mask holds, and a user order
 * of columns of the heading or one outside it.
 */
const names = ["a", "b", "c", "d"] as const

const columnsOf = (heading: ReadonlyArray<string>, mask: number): ReadonlyArray<string> =>
	Arr.flatMap([...heading.entries()], ([i, c]) => (((mask >> i) & 1) === 1 ? [c] : []))

/**
 * The kind of every column of a union case's heading: an id, an account, Kind's closed id and a payload field, each of a
 * type with an admitted order.
 */
export const unionColumnKind = (): ColumnKind => "integer"

/** The drawn parts of a case, before they are read as a subject. */
interface CaseDraw {
	readonly width: number
	/** Each column's kind, an integer three times in four. */
	readonly kinds: readonly [ColumnKind, ColumnKind, ColumnKind, ColumnKind]
	/** Each column's link: an earlier column whose class it joins, or itself. */
	readonly links: readonly [number, number, number, number]
	readonly keys: ReadonlyArray<number>
	readonly fixed: number
	readonly user: ReadonlyArray<{ readonly column: number; readonly dir: Direction }>
	readonly rows: ReadonlyArray<ReadonlyArray<number>>
}

/** A column's kind: an integer three times in four, and each other kind otherwise. */
const kindGen: Gen<ColumnKind> = (source) =>
	source.draw(int(0, 3)) < 3 ? "integer" : source.draw(element(columnKinds))

const caseDrawGen: Gen<CaseDraw> = (source) => ({
	width: source.draw(int(0, 4)),
	kinds: [source.draw(kindGen), source.draw(kindGen), source.draw(kindGen), source.draw(kindGen)],
	links: [0, source.draw(int(0, 1)), source.draw(int(0, 2)), source.draw(int(0, 3))],
	keys: source.draw(array(int(0, 15), { min: 0, max: 3 })),
	fixed: source.draw(int(0, 15)),
	user: source.draw(
		array(
			(key) => ({
				column: key.draw(int(0, 4)),
				dir: key.draw(element(directions))
			}),
			{ min: 0, max: 3 }
		)
	),
	rows: source.draw(array(array(int(0, 2), { min: 4, max: 4 }), { min: 0, max: 6 }))
})

export const caseGen = map(caseDrawGen, (c) => {
	const heading: ReadonlyArray<string> = names.slice(0, c.width)
	/** Each column's class: the columns its links join it to, in heading order. */
	const root = (i: number): number => {
		const link = c.links[i] ?? i
		return link === i ? i : root(link)
	}
	const classOf = (column: string): NonEmptyReadonlyArray<string> => {
		const r = root(heading.indexOf(column))
		const [first, ...rest] = Arr.filter(heading, (other) => root(heading.indexOf(other)) === r)
		return [defined(first, "a column's own class holds it"), ...rest]
	}
	/** A mask's key: the classes of the columns it holds, each once. */
	const keyOf = (mask: number): KeyClasses =>
		Arr.dedupeWith(Arr.map(columnsOf(heading, mask), classOf), (x, y) => x[0] === y[0])
	const kindOf = (column: string): ColumnKind =>
		defined(c.kinds[heading.indexOf(column)], "a heading column's kind")
	const s = subject(
		Arr.map(heading, (n) => col(n, kindTypes[kindOf(n)])),
		Arr.map(c.keys, keyOf),
		{ fixed: columnsOf(heading, c.fixed) }
	)
	/** A column of the heading, or, past its width, one outside it. */
	const user = Arr.map(c.user, (u): OrderKey => ({
		column: u.column < heading.length ? defined(heading[u.column], "the ordered column") : "nope",
		dir: u.dir
	}))
	/** A drawn row with each column holding its class's first column's value: the columns of a class are equal. */
	const rows = Arr.map(c.rows, (row) =>
		Arr.map(row, (v, i) =>
			i < heading.length ? defined(row[root(i)], "the class's first column's value") : v
		)
	)
	return { subject: s, user, rows, kindOf }
})

/**
 * The rows of a relation the subject describes: distinct, every key unique, every fixed column one value, the columns
 * of a class equal as drawn; drawn rows that would break one are left out.
 */
export const rowsOf = (
	s: OrderSubject,
	drawn: ReadonlyArray<ReadonlyArray<number>>
): ReadonlyArray<ReadonlyArray<number>> => {
	const at = (row: ReadonlyArray<number>, c: string) =>
		row[
			Option.getOrThrowWith(
				Arr.findFirstIndex(s.heading, (h) => h.name === c),
				() => new Error("a column the case's own heading holds")
			)
		]
	const kept: Array<ReadonlyArray<number>> = []
	for (const row of drawn) {
		const r = row.slice(0, s.heading.length)
		const clash = Arr.some(
			kept,
			(k) =>
				Arr.some(s.fixed, (c) => at(k, c) !== at(r, c)) ||
				Arr.every(r, (v, i) => k[i] === v) ||
				Arr.some(keysOf(s), (key) => Arr.every(key, ([c]) => at(k, c) === at(r, c)))
		)
		if (!clash) {
			kept.push(r)
		}
	}
	return kept
}

/** The reasons the policy refuses an order for. */
type Refusal = "MalformedDescription" | "UnsupportedOperation"

export type OrderFeature =
	| `refused ${Refusal}`
	| "an order stated over a column of no order"
	| "a tie broken by an unordered closed id"
	| "total as stated"
	| "completed by a narrower key"
	| "completed by the heading"
	| "a fixed column skipped"
	| "the empty heading"

/**
 * How a union of payloads is keyed: by the id every arm holds; by it, the manual arm holding its id again as aid, a
 * field of that group alone whose name precedes id's, so the group's own completion would choose it; or by no field
 * every arm holds, the arms without the id.
 */
export type Payloads = "keyed" | "keyed, a group's own key first" | "keyless"

export const payloadForms: Arr.NonEmptyReadonlyArray<Payloads> = [
	"keyed",
	"keyed, a group's own key first",
	"keyless"
]

/**
 * Task's two payload arms, (id, account, kind, budget) and (id, account, kind, operator), the manual one with its id
 * again as aid where `form` says, or without the id where it is keyless, so that the fields common to every arm hold
 * no key of the union.
 */
export const payloads = (q: Ir, form: Payloads): RelNode => {
	const keyed = form !== "keyless"
	const arm = (kind: string, payload: string, field: string) => {
		const task = q.base("Task")
		const m = q.region(
			[
				{
					source: task,
					bind: { id: "id", account: "account" },
					constants: { kind: q.litFor(task, "kind", kind) }
				},
				{ source: q.base(payload), bind: { task: "id", [field]: field }, constants: {} }
			],
			conservativeMeta
		)
		return q.project(
			m,
			[
				...(keyed ? [["id", "id"] as const] : []),
				...(form === "keyed, a group's own key first" && kind === "Manual"
					? [["aid", "id"] as const]
					: []),
				["account", "account"],
				["kind", q.lit(kind, q.column(task, "kind").type)],
				[field, field]
			],
			conservativeMeta
		)
	}
	return q.union(
		[arm("Automatic", "AutomaticTask", "budget"), arm("Manual", "ManualTask", "operator")],
		["kind"],
		conservativeMeta
	)
}

const notes = (q: Ir, columns: "task only" | "task and note"): RelNode =>
	q.project(
		q.region(
			[{ source: q.base("TaskNote"), bind: { task: "task", note: "note" }, constants: {} }],
			conservativeMeta
		),
		columns === "task only"
			? [["task", "task"]]
			: [
					["task", "task"],
					["note", "note"]
				],
		conservativeMeta
	)

const work = theoryUnder(W.WorkDesc, noImmediate)

export const subjectAt = (built: BuiltQuery, at: RelNode) => {
	const analysis = succeeded(analyzeLogical(built.dag, logicalEnv(work), everyNode))
	return orderSubjectOf(
		at,
		defined(analysis.props.get(at), "the node's properties, kept"),
		[],
		(k) => contextAdmits("transaction", k.context)
	)
}

/**
 * What the union is read through: nothing, a take(k), that take ordered again or taken again, a semi-join or an
 * anti-join with the notes, an intersection with itself, a difference, an attachment of the notes, or a filter that
 * fixes its discriminant to the manual arm's kind, which no order then appends.
 */
type Wrapper =
	| "the union"
	| "take"
	| "take, ordered again"
	| "take, taken again"
	| "semi-join"
	| "anti-join"
	| "intersection"
	| "difference"
	| "attachment"
	| "filtered to one kind"

export const wrapped = (q: Ir, union: RelNode, keyed: boolean, wrapper: Wrapper): RelNode => {
	const byKey = keyed ? ascending("account", "kind", "id") : ascending("account", "kind")
	const correlation: ReadonlyArray<readonly [string, string]> = [[keyed ? "id" : "account", "task"]]
	switch (wrapper) {
		case "the union":
			return union
		case "take":
			return q.take(union, byKey, { kind: "literal", k: 10n }, conservativeMeta)
		case "take, ordered again":
			return q.ordered(q.take(union, byKey, { kind: "literal", k: 10n }, conservativeMeta), byKey)
		case "take, taken again":
			return q.take(
				q.take(union, byKey, { kind: "literal", k: 10n }, conservativeMeta),
				byKey,
				{ kind: "literal", k: 5n },
				conservativeMeta
			)
		case "semi-join":
			return q.semi(union, notes(q, "task only"), correlation)
		case "anti-join":
			return q.anti(union, notes(q, "task only"), correlation)
		case "intersection":
			return q.b.node({
				kind: "Intersect",
				left: union,
				right: union,
				heading: union.heading,
				loc: undefined,
				meta: conservativeMeta
			})
		case "difference":
			return q.b.node({
				kind: "Difference",
				left: union,
				right: q.anti(union, notes(q, "task only"), correlation),
				heading: union.heading,
				loc: undefined,
				meta: conservativeMeta
			})
		case "attachment":
			return q.attach(union, notes(q, "task and note"), "note", correlation, "array", undefined)
		case "filtered to one kind":
			return q.filter(union, q.op("eq", [q.col(union, "kind"), q.litFor(union, "kind", "Manual")]))
	}
}

export const wrappers: Arr.NonEmptyReadonlyArray<Wrapper> = [
	"the union",
	"take",
	"take, ordered again",
	"take, taken again",
	"semi-join",
	"anti-join",
	"intersection",
	"difference",
	"attachment",
	"filtered to one kind"
]

export const users: Arr.NonEmptyReadonlyArray<ReadonlyArray<OrderKey>> = [
	[],
	[asc("account")],
	[desc("id")],
	[asc("kind")],
	[asc("account"), desc("id")]
]

/**
 * A union case's situation: its wrapper, and whether the fields common to every arm hold a key of the union (keyed),
 * whose one order every group takes, a group's own key first by its policy among them, or none, where each group's
 * order needs the group's own fields.
 */
export type UnionFeature = `${Wrapper} ${Payloads}`
