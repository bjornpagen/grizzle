/**
 * The law model decides each relation's unique objects beyond its primary key once, as it is built
 * (RelationLaws.beyond), comparing two guards by their predicates' canonical texts, each encoded once where its object
 * is built; and it specializes the schema once, over the theory whose containment evidence the plans' immediate laws
 * settle. Both are representation changes the decisions must survive unchanged.
 *
 * Each case draws a relation T's keys, each over its fields a and b, plain or over a selection of T by a conjunction of
 * `kind = j` and `flag = v` atoms, so keys share fields and guards in every arrangement: one subsuming another, two over
 * one selection and set of fields in two orders, none; and relations S whose `t` is contained, from every row or the
 * live ones, in K's key (K holds its key alone, so the reference is immediate), in T's or in an S's (each with a field
 * it does not reference, so deferred). A key over every fact is a candidate key, and no two of those share a set of
 * fields, which the schema refuses (schema/own.ts distinctKeys). The oracles: every relation's objects beyond its
 * primary key are those the decision restated here keeps, comparing two guards by encoding both, as it did before a
 * guard carried its canonical text; no two of a relation's unique objects hold each other, since two that would are
 * one key (ir/law.ts KeyColumnSet); and a containment's law is immediate, in the specialized model and in its
 * evidence, exactly when it is into K.
 *
 * Plants (~/.cache/grizzle-release/BR03/plants): beyond-primary-guards-alike (laws/model/uniques.ts subsumes finds any
 * two guards one guard).
 *
 * Features: a guarded key subsumed, two keys over one set in two orders as one object, a key beyond the primary, an
 * immediate containment, a deferred containment.
 */
import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, boolean, element, type Gen, int } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Order, Record as Rec } from "effect"
import { indices } from "#compiler/core/array.ts"
import { canonicalEquals, everyProperty } from "#compiler/core/canonical.ts"
import { compileLaws } from "#compiler/laws/model/model.ts"
import type { PrimaryKeyObject, UniqueObject, UniqueObjects } from "#compiler/laws/model/uniques.ts"
import { uuid } from "#compiler/public/fields.ts"
import { pgDescriptors } from "#compiler/scalar/pg.ts"
import { everySlice } from "#compiler/schema/reach.ts"
import { relation } from "#compiler/schema/relation.ts"
import { schema } from "#compiler/schema/schema.ts"
import {
	containedBuilder,
	keyBuilder,
	onBuilder,
	selectBuilder
} from "#compiler/schema/statements.ts"
import type { RowTerm, rowHelpers } from "#compiler/schema/terms.ts"
import type { Statement } from "#compiler/types/schema/statements.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { ownedInput } from "#test/support/policy.ts"

/** A conjunct of a key's selection of T. */
type Atom =
	| { readonly kind: "kind"; readonly value: number }
	| { readonly kind: "flag"; readonly value: boolean }

/** A key of T: its fields, and the conjuncts of the selection it is over, none for a key over every fact. */
interface KeyDraw {
	readonly fields: Arr.NonEmptyReadonlyArray<"a" | "b">
	readonly guard: ReadonlyArray<Atom>
}

/** A containment of an S's `t` in a key: K's, T's or an S's `id`, from every row of the S or its live ones. */
interface ContainmentDraw {
	readonly from: number
	readonly to:
		| { readonly kind: "K" }
		| { readonly kind: "T" }
		| { readonly kind: "S"; readonly at: number }
	readonly selected: boolean
}

interface BeyondCase {
	readonly keys: Arr.NonEmptyReadonlyArray<KeyDraw>
	readonly sources: number
	readonly containments: ReadonlyArray<ContainmentDraw>
}

const atomGen: Gen<Atom> = (source) =>
	source.draw(boolean)
		? { kind: "kind", value: source.draw(int(0, 2)) }
		: { kind: "flag", value: source.draw(boolean) }

const keyGen: Gen<KeyDraw> = (source) => ({
	fields: source.draw(
		element<Arr.NonEmptyReadonlyArray<"a" | "b">>([["a"], ["b"], ["a", "b"], ["b", "a"]])
	),
	guard: source.draw(array(atomGen, { min: 0, max: 2 }))
})

/** A key's conjuncts' text. */
const guardText = (k: KeyDraw): string =>
	Arr.join(
		Arr.map(k.guard, (a) => `${a.kind}=${String(a.value)}`),
		"&"
	)

/** A key's text: its fields and its conjuncts, which tell two keys of one statement apart, a key over every fact by its
 * set of fields, since a second candidate key over one set is refused. */
const keyText = (k: KeyDraw): string =>
	`${Arr.join(k.guard.length === 0 ? Arr.sort(k.fields, Order.String) : k.fields, ",")}|${guardText(k)}`

/** Whether two drawn keys are over one selection and one set of fields in two orders: one key. */
const sameKeyInTwoOrders = (x: KeyDraw, y: KeyDraw): boolean =>
	guardText(x) === guardText(y) &&
	Arr.join(x.fields, ",") !== Arr.join(y.fields, ",") &&
	Arr.join(Arr.sort(x.fields, Order.String), ",") ===
		Arr.join(Arr.sort(y.fields, Order.String), ",")

/** Whether two containments reference one key: K's, T's, or one S's. */
const sameTarget = (x: ContainmentDraw["to"], y: ContainmentDraw["to"]): boolean =>
	x.kind === "S" ? y.kind === "S" && x.at === y.at : x.kind === y.kind

const caseGen: Gen<BeyondCase> = (source) => {
	const [first, ...rest] = Arr.dedupeWith(
		source.draw(array(keyGen, { min: 1, max: 7 })),
		(x, y) => keyText(x) === keyText(y)
	)
	const sources = source.draw(int(0, 3))
	const containmentGen: Gen<ContainmentDraw> = (inner) => ({
		from: inner.draw(int(0, Math.max(0, sources - 1))),
		to: inner.draw(
			element<ContainmentDraw["to"]>([
				{ kind: "K" },
				{ kind: "T" },
				...Arr.map(indices(sources), (at) => ({ kind: "S" as const, at }))
			])
		),
		selected: inner.draw(boolean)
	})
	return {
		keys: [defined(first, "a drawn key"), ...rest],
		sources,
		containments:
			sources === 0
				? []
				: Arr.dedupeWith(
						source.draw(array(containmentGen, { min: 0, max: 3 })),
						(x, y) => x.from === y.from && x.selected === y.selected && sameTarget(x.to, y.to)
					)
	}
}

/** The decision restated as it was before a guard carried its canonical text: two guards equal by encoding both. */
const subsumes = (w: UniqueObject | PrimaryKeyObject, u: UniqueObject): boolean =>
	w.kind !== "span" &&
	u.kind !== "span" &&
	Arr.every(w.equal, (f) => Arr.some(u.equal, (e) => e === f)) &&
	(w.kind === "key" ||
		Arr.every(w.within, (g) =>
			u.kind === "guarded"
				? Arr.some(u.within, (h) => canonicalEquals(g.predicate, h.predicate, everyProperty))
				: false
		))

const restated = (uniques: UniqueObjects): ReadonlyArray<UniqueObject> =>
	Arr.filter(
		uniques.others,
		(u, i) =>
			!subsumes(uniques.primary, u) &&
			!Arr.some(uniques.others, (w, j) => j !== i && subsumes(w, u) && (j < i || !subsumes(u, w)))
	)

type TRow = { readonly kind: RowTerm; readonly flag: RowTerm } & typeof rowHelpers
type SRow = { readonly live: RowTerm } & typeof rowHelpers

/** The schema of a case: T with its keys, K, the S relations and their containments. */
const schemaOf = (c: BeyondCase) => {
	const T = relation(
		"T",
		{
			id: uuid,
			a: uuid,
			b: uuid,
			kind: pgDescriptors.integer,
			flag: pgDescriptors.boolean
		},
		["id"],
		[]
	)
	const K = relation("K", { id: uuid }, ["id"], [])
	const sources = Arr.map(indices(c.sources), (i) =>
		relation(`S${i}`, { id: uuid, t: uuid, live: pgDescriptors.boolean }, ["id"], [])
	)
	const atom = (r: TRow, a: Atom) =>
		a.kind === "kind" ? r.eq(r.kind, a.value) : r.eq(r.flag, a.value)
	const keys: ReadonlyArray<Statement> = Arr.map(c.keys, (k) => {
		const [first, second] = k.guard
		const side =
			first === undefined
				? T
				: selectBuilder(T, (r: TRow) =>
						second === undefined ? atom(r, first) : r.and(atom(r, first), atom(r, second))
					)
		return keyBuilder(onBuilder(side, k.fields))
	})
	const containments: ReadonlyArray<Statement> = Arr.map(c.containments, (d) => {
		const from = defined(sources[d.from], "a source relation")
		const side = d.selected ? selectBuilder(from, (r: SRow) => r.eq(r.live, true)) : from
		const target =
			d.to.kind === "K" ? K : d.to.kind === "T" ? T : defined(sources[d.to.at], "a target")
		return containedBuilder(onBuilder(side, ["t"]), onBuilder(target, ["id"]))
	})
	return schema(
		"Beyond",
		Rec.fromEntries([["T", T], ["K", K], ...Arr.map(sources, (s, i) => [`S${i}`, s] as const)]),
		[...keys, ...containments],
		[]
	)
}

type BeyondFeature =
	| "a guarded key subsumed"
	| "two keys over one set in two orders, one object"
	| "a key beyond the primary"
	| "an immediate containment"
	| "a deferred containment"

describe("the objects beyond a primary key and the immediate laws", () => {
	it.effect(
		"are decided as before, once, by guards' canonical texts and the plans' immediate laws",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "second-implementation",
							name: "the decision restated, two guards compared by encoding both; a containment immediate exactly when it is into K"
						},
						suite: "unit/laws/model/beyond-primary",
						draw: drawn(caseGen),
						literal: Formatter.format,
						coverage: required<BeyondFeature>(
							[
								"a guarded key subsumed",
								"two keys over one set in two orders, one object",
								"a key beyond the primary",
								"an immediate containment",
								"a deferred containment"
							],
							{ cases: 200, sense: notesOnly }
						),
						kept: [],
						runs: 200,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(c, k) =>
						Effect.sync(() => {
							const owned = succeeded(ownedInput(schemaOf(c)))
							const model = succeeded(
								compileLaws(owned, everySlice(owned), { kind: "planned" }),
								"the schema compiles"
							)
							for (const [name, laws] of model.relations) {
								const expected = restated(laws.uniques)
								assert.deepEqual(
									Arr.map(laws.beyond, (u) => u.name),
									Arr.map(expected, (u) => u.name),
									`${name}'s objects beyond its primary key`
								)
								const { others } = laws.uniques
								if (expected.length > 0) {
									k.note("a key beyond the primary")
								}
								if (Arr.some(others, (u) => u.kind === "guarded" && !expected.includes(u))) {
									k.note("a guarded key subsumed")
								}
								assert.ok(
									!Arr.some(others, (u, i) =>
										Arr.some(others, (w, j) => i < j && subsumes(w, u) && subsumes(u, w))
									),
									`no two of ${name}'s unique objects hold each other`
								)
							}
							if (
								Arr.some(c.keys, (x, i) =>
									Arr.some(c.keys, (y, j) => i < j && sameKeyInTwoOrders(x, y))
								)
							) {
								k.note("two keys over one set in two orders, one object")
							}
							for (const e of model.theory.evidence.containments) {
								/** K holds its key alone and references nothing, so no reference into it is replaceable or on a cycle. */
								const immediate = e.to.relation === "K"
								assert.equal(
									model.immediate.has(e.law),
									immediate,
									`the containment of ${e.from.relation} in ${e.to.relation} is immediate exactly when it is into K`
								)
								assert.equal(
									e.context,
									immediate ? "immediate" : "committedSnapshot",
									"a containment's evidence context, the specialized model's verdict"
								)
								k.note(immediate ? "an immediate containment" : "a deferred containment")
							}
						})
				)
			)
	)
})
