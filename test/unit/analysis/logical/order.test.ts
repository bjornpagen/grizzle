import { describe, it } from "@effect/vitest"
import { drawn, exhaust, explore } from "@grizzle/testing/explore"
import { required, requiredInSpace } from "@grizzle/testing/features"
import { array, boolean, constant, element, type Gen, int, map, oneOf } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Order } from "effect"
import { provisionalTheory } from "#compiler/analysis/theory/theory.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import type { NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import { contextAdmits } from "#compiler/ir/evidence.ts"
import type { KeyClasses } from "#compiler/ir/keys.ts"
import {
	conservativeMeta,
	type HeadingColumn,
	type OrderKey,
	type RelNode
} from "#compiler/ir/rel.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import { analyzeLogical, orderSubjectOf } from "#compiler/logical/annotate.ts"
import { completeOrder, type OrderSubject } from "#compiler/logical/order.ts"
import { plainType } from "#compiler/scalar/compute/types.ts"
import { assert, defined, refused, succeeded } from "#test/support/assert.ts"
import { asc as ascending, type BuiltQuery, Ir } from "#test/support/fixtures/ir/build.ts"
import * as W from "#test/support/fixtures/ir/work.ts"
import { caseHang } from "#test/support/limits.ts"
import { logicalEnv, theoryUnder } from "#test/unit/analysis/logical/support.ts"

/**
 * Order completion: the page completion policy, union roster-order completion included.
 *
 * completeOrder is judged against the policy written from its statement, by search over the sets of fields it may
 * append, over generated subjects (headings, classes of equal columns, keys over them, fixed columns, a discriminant,
 * user orders in and outside the heading), and the order it completes is checked total over generated relations the
 * subject describes. Every type a
 * schema can declare is ordered, so the unordered refusals are no case. The subjects the analysis derives from a union
 * of several headings are the examples below.
 */

const int4 = plainType("int4")

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
 * A subject of the order completion, read from an ORDER BY, with no fixed column and no discriminant unless stated, each
 * key one factor of one minimal key.
 */
const subject = (
	heading: ReadonlyArray<HeadingColumn>,
	keys: ReadonlyArray<KeyClasses>,
	stated: Pick<OrderSubject, "fixed" | "discriminant">
): OrderSubject => ({
	heading,
	keys: Arr.map(keys, (k) => [[k]] as const),
	loc: SourceLoc("orderBy", []),
	...stated
})

/** Every key a subject states: one minimal key of each of a key's factors, together. */
const keysOf = (s: OrderSubject): ReadonlyArray<KeyClasses> =>
	Arr.flatMap(s.keys, (factors) =>
		Arr.reduce(factors, [[]], (keys: ReadonlyArray<KeyClasses>, alternatives) =>
			Arr.flatMap(keys, (k) => Arr.map(alternatives, (a): KeyClasses => [...k, ...a]))
		)
	)

/**
 * What the completion policy gives, written from its statement (logical/order.ts) by search rather than by key: the
 * user's fields, each in the heading and once; then the discriminant; then the fewest further fields, in heading order,
 * that with the user's and the fixed ones contain a key narrower than the heading, the lexicographically least set of
 * names among the fewest; else every remaining field in heading order, which over arms of different headings is total
 * only when it contains a key. A set contains a key over classes when it holds a column of each of its classes.
 */
type Spec =
	| { readonly kind: "refused"; readonly reason: Refusal }
	| {
			readonly kind: "order"
			readonly keys: ReadonlyArray<OrderKey>
			/** The step that made the order total. */
			readonly step: "stated" | "discriminant" | "key" | "heading"
	  }

const specOrder = (s: OrderSubject, user: ReadonlyArray<OrderKey>): Spec => {
	const names = Arr.map(s.heading, (c) => c.name)
	const ordered = new Set<string>()
	for (const k of user) {
		if (!names.includes(k.column) || ordered.has(k.column)) {
			return { kind: "refused", reason: "MalformedDescription" }
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
	const discriminant = Arr.filter(
		s.discriminant,
		(d) => names.includes(d) && !ordered.has(d) && !fixed.has(d)
	)
	const withDiscriminant = [...user, ...Arr.map(discriminant, asc)]
	if (covered(discriminant)) {
		return { kind: "order", keys: withDiscriminant, step: "discriminant" }
	}
	const remaining = Arr.filter(
		names,
		(c) => !ordered.has(c) && !fixed.has(c) && !discriminant.includes(c)
	)
	const narrow = Arr.filter(keysOf(s), (key) => key.length < names.length)
	const reaches = (extra: ReadonlyArray<string>) =>
		Arr.some(narrow, (key) =>
			Arr.every(key, (members) =>
				Arr.some(
					members,
					(c) => ordered.has(c) || fixed.has(c) || discriminant.includes(c) || extra.includes(c)
				)
			)
		)
	/** Every set of remaining fields, the fewest first, then by its sorted names. */
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
				...withDiscriminant,
				...Arr.map(
					Arr.filter(remaining, (c) => least.includes(c)),
					asc
				)
			],
			step: "key"
		}
	}
	const all = [...withDiscriminant, ...Arr.map(remaining, asc)]
	return s.discriminant.length > 0 && !covered([...discriminant, ...remaining])
		? { kind: "refused", reason: "UnsupportedOperation" }
		: { kind: "order", keys: all, step: "heading" }
}

/**
 * A generated subject: a heading of up to four integer columns, each column joined to the class of an earlier one or
 * none, keys and fixed columns as masks over it, a key over the classes of the columns its mask holds, at most one
 * discriminant column, and a user order of columns of the heading or one outside it.
 */
const names = ["a", "b", "c", "d"] as const

const columnsOf = (heading: ReadonlyArray<string>, mask: number): ReadonlyArray<string> =>
	Arr.flatMap([...heading.entries()], ([i, c]) => (((mask >> i) & 1) === 1 ? [c] : []))

/** The drawn parts of a case, before they are read as a subject. */
interface CaseDraw {
	readonly width: number
	/** Each column's link: an earlier column whose class it joins, or itself. */
	readonly links: readonly [number, number, number, number]
	readonly keys: ReadonlyArray<number>
	readonly fixed: number
	readonly discriminant:
		| { readonly kind: "none" }
		| { readonly kind: "column"; readonly index: number }
	readonly user: ReadonlyArray<{ readonly column: number; readonly dir: "asc" | "desc" }>
	readonly rows: ReadonlyArray<ReadonlyArray<number>>
}

const caseDrawGen: Gen<CaseDraw> = (source) => ({
	width: source.draw(int(0, 4)),
	links: [0, source.draw(int(0, 1)), source.draw(int(0, 2)), source.draw(int(0, 3))],
	keys: source.draw(array(int(0, 15), { min: 0, max: 3 })),
	fixed: source.draw(int(0, 15)),
	discriminant: source.draw(
		oneOf<CaseDraw["discriminant"]>([
			constant({ kind: "none" }),
			map(int(0, 3), (index) => ({ kind: "column", index }))
		])
	),
	user: source.draw(
		array(
			(key) => ({
				column: key.draw(int(0, 4)),
				dir: key.draw(element<"asc" | "desc">(["asc", "desc"]))
			}),
			{ min: 0, max: 3 }
		)
	),
	rows: source.draw(array(array(int(0, 2), { min: 4, max: 4 }), { min: 0, max: 6 }))
})

const caseGen = map(caseDrawGen, (c) => {
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
	const discriminant =
		c.discriminant.kind === "column" && c.discriminant.index < heading.length
			? [defined(heading[c.discriminant.index], "the discriminant column")]
			: []
	const s = subject(
		Arr.map(heading, (n) => col(n, int4)),
		Arr.map(c.keys, keyOf),
		{ fixed: columnsOf(heading, c.fixed), discriminant }
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
	return { subject: s, user, rows }
})

/**
 * The rows of a relation the subject describes: distinct, every key unique, every fixed column one value, the columns
 * of a class equal as drawn; drawn rows that would break one are left out.
 */
const rowsOf = (
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

type OrderFeature =
	| `refused ${Refusal}`
	| "total as stated"
	| "completed by the discriminant"
	| "completed by a narrower key"
	| "completed by the heading"
	| "a fixed column skipped"
	| "the empty heading"

describe("completing an order", () => {
	it.effect(
		"is the policy's completion: the user's fields, the discriminant, the least narrower key, or the heading",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: { kind: "unstated" },
						suite: "unit/analysis/logical/order-completion",
						draw: drawn(caseGen),
						literal: Formatter.format,
						coverage: required<OrderFeature>(
							[
								"refused MalformedDescription",
								"refused UnsupportedOperation",
								"total as stated",
								"completed by the discriminant",
								"completed by a narrower key",
								"completed by the heading",
								"a fixed column skipped",
								"the empty heading"
							],
							{ cases: 3000, sense: notesOnly }
						),
						kept: [],
						runs: 3000,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					({ subject: s, user, rows }, c) =>
						Effect.sync(() => {
							const got = completeOrder(s, user)
							const want = specOrder(s, user)
							if (want.kind === "refused") {
								c.note(`refused ${want.reason}`)
								assert.ok(
									!got.ok,
									`the policy refuses, and completeOrder gives ${Formatter.format(got.ok ? got.value : undefined)}`
								)
								assert.equal(got.error.reason._tag, want.reason)
								return
							}
							if (!got.ok) {
								throw new Error(
									`completeOrder refuses (${got.error.message}) what the policy completes`
								)
							}
							assert.deepEqual(got.value.keys, want.keys)
							if (s.heading.length === 0) {
								c.note("the empty heading")
							}
							c.note(
								want.step === "stated"
									? "total as stated"
									: want.step === "discriminant"
										? "completed by the discriminant"
										: want.step === "key"
											? "completed by a narrower key"
											: "completed by the heading"
							)
							if (Arr.some(s.fixed, (field) => !Arr.some(user, (k) => k.column === field))) {
								c.note("a fixed column skipped")
							}
							/** The completed order is total over every relation the subject describes: no two of its rows tie. */
							const columns = Arr.map(got.value.keys, (k) =>
								Option.getOrThrowWith(
									Arr.findFirstIndex(s.heading, (h) => h.name === k.column),
									() => new Error("a column the case's own heading holds")
								)
							)
							const kept = rowsOf(s, rows)
							for (const [i, x] of kept.entries()) {
								for (const y of kept.slice(i + 1)) {
									assert.ok(
										Arr.some(columns, (index) => x[index] !== y[index]),
										`rows ${Formatter.format(x)} and ${Formatter.format(y)} tie on ${Arr.join(
											Arr.map(got.value.keys, (k) => k.column),
											", "
										)}`
									)
								}
							}
						})
				)
			)
	)
})

describe("completing an order over a union of different headings", () => {
	/**
	 * Task's two payload arms, (id, account, kind, budget) and (id, account, kind, operator), or without the id when
	 * `keyed` is false, so that the fields common to every arm hold no key of the union.
	 */
	const payloads = (q: Ir, keyed: boolean): RelNode => {
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
	const work = theoryUnder(W.WorkDesc, provisionalTheory)
	const subjectAt = (built: BuiltQuery, at: RelNode) => {
		const analysis = succeeded(analyzeLogical(built.dag, logicalEnv(work)))
		return orderSubjectOf(at, analysis.of(at).props, [], (k) =>
			contextAdmits("transaction", k.context)
		)
	}
	/**
	 * What the union is read through: nothing, a take(k), that take ordered again or taken again, a semi-join or an
	 * anti-join with the notes, an intersection with itself, a difference, or an attachment of the notes.
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
	const wrapped = (q: Ir, union: RelNode, keyed: boolean, wrapper: Wrapper): RelNode => {
		const byKey = keyed ? ascending("account", "kind", "id") : ascending("account", "kind")
		const correlation: ReadonlyArray<readonly [string, string]> = [
			[keyed ? "id" : "account", "task"]
		]
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
		}
	}
	const wrappers: Arr.NonEmptyReadonlyArray<Wrapper> = [
		"the union",
		"take",
		"take, ordered again",
		"take, taken again",
		"semi-join",
		"anti-join",
		"intersection",
		"difference",
		"attachment"
	]
	const users: Arr.NonEmptyReadonlyArray<ReadonlyArray<OrderKey>> = [
		[],
		[asc("account")],
		[desc("id")],
		[asc("kind")],
		[asc("account"), desc("id")]
	]
	type UnionFeature = `${Wrapper} ${"completed" | "refused"}`

	it.effect(
		"completes a union read through a bound, a join, a set operation or an attachment as the union, the discriminant right after the user's fields",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						box: { kind: "unstated" },
						oracle: { kind: "unstated" },
						suite: "unit/analysis/logical/union-order",
						generator: (source) =>
							[
								source.draw(boolean),
								source.draw(element(wrappers)),
								source.draw(element(users))
							] as const,
						literal: Formatter.format,
						limit: 200,
						coverage: requiredInSpace<UnionFeature>(
							Arr.flatMap(wrappers, (w): Arr.NonEmptyReadonlyArray<UnionFeature> => [
								`${w} completed`,
								`${w} refused`
							])
						),
						caseHang
					},
					([keyed, wrapper, userOrder], c) =>
						Effect.sync(() => {
							const user = keyed ? userOrder : Arr.filter(userOrder, (k) => k.column !== "id")
							const q = new Ir(W.workModel())
							const union = payloads(q, keyed)
							const at = wrapped(q, union, keyed, wrapper)
							const s = subjectAt(q.build(at), at)
							assert.deepEqual(s.discriminant, ["kind"])
							const own = subjectAt(q.build(union), union)
							const want = specOrder(own, user)
							const got = completeOrder(s, user)
							if (want.kind === "refused") {
								c.note(`${wrapper} refused`)
								refused(got, want.reason)
								return
							}
							c.note(`${wrapper} completed`)
							assert.deepEqual(succeeded(got).keys, want.keys)
							/** The discriminant follows the user's fields, before any arm key. */
							const keys = Arr.map(succeeded(got).keys, (k) => k.column)
							if (!Arr.some(user, (k) => k.column === "kind")) {
								assert.equal(keys[user.length], "kind")
							}
						})
				)
			)
	)
})
