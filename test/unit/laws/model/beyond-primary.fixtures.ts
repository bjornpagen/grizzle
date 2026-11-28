/** What the properties of beyond-primary.test.ts read: its spaces, models and helpers. */

import { indices } from "@bjornpagen/grizzle-text/base/array"
import { array, boolean, element, type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr, Order, Record as Rec } from "effect"
import { canonicalEquals } from "#compiler/core/canonical.ts"
import type { PrimaryKeyObject, UniqueObject, UniqueObjects } from "#compiler/laws/model/uniques.ts"

import { defined } from "@bjornpagen/testing/assert"
import { bool, int4 } from "#compiler/scalar/pg.ts"
import { relationBuilder as relation } from "#compiler/schema/relation.ts"
import { schemaBuilder as schema } from "#compiler/schema/schema.ts"
import {
	containedBuilder,
	keyBuilder,
	onBuilder,
	selectBuilder
} from "#compiler/schema/statements.ts"
import type { rowHelpers, RowTerm } from "#compiler/schema/terms.ts"
import type { Statement } from "#compiler/types/schema/statements.ts"
import { Id } from "#test/support/ids.ts"

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
export const sameKeyInTwoOrders = (x: KeyDraw, y: KeyDraw): boolean =>
	guardText(x) === guardText(y) &&
	Arr.join(x.fields, ",") !== Arr.join(y.fields, ",") &&
	Arr.join(Arr.sort(x.fields, Order.String), ",") ===
		Arr.join(Arr.sort(y.fields, Order.String), ",")

/** Whether two containments reference one key: K's, T's, or one S's. */
const sameTarget = (x: ContainmentDraw["to"], y: ContainmentDraw["to"]): boolean =>
	x.kind === "S" ? y.kind === "S" && x.at === y.at : x.kind === y.kind

export const caseGen: Gen<BeyondCase> = (source) => {
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
export const subsumes = (w: UniqueObject | PrimaryKeyObject, u: UniqueObject): boolean =>
	w.kind !== "span" &&
	u.kind !== "span" &&
	Arr.every(w.equal, (f) => Arr.some(u.equal, (e) => e === f)) &&
	(w.kind === "key" ||
		Arr.every(w.within, (g) =>
			u.kind === "guarded"
				? Arr.some(u.within, (h) => canonicalEquals(g.predicate, h.predicate))
				: false
		))

export const restated = (uniques: UniqueObjects): ReadonlyArray<UniqueObject> =>
	Arr.filter(
		uniques.others,
		(u, i) =>
			!subsumes(uniques.primary, u) &&
			!Arr.some(uniques.others, (w, j) => j !== i && subsumes(w, u) && (j < i || !subsumes(u, w)))
	)

type TRow = { readonly kind: RowTerm; readonly flag: RowTerm } & typeof rowHelpers

type SRow = { readonly live: RowTerm } & typeof rowHelpers

/** The schema of a case: T with its keys, K, the S relations and their containments. */
export const schemaOf = (c: BeyondCase) => {
	const T = relation(
		"T",
		{
			id: Id,
			a: Id,
			b: Id,
			kind: int4,
			flag: bool
		},
		["id"],
		[]
	)
	const K = relation("K", { id: Id }, ["id"], [])
	const sources = Arr.map(indices(c.sources), (i) =>
		relation(`S${i}`, { id: Id, t: Id, live: bool }, ["id"], [])
	)
	const atom = (r: TRow, a: Atom) =>
		a.kind === "kind" ? r.eq(r.kind, a.value) : r.eq(r.flag, a.value)
	const keys: ReadonlyArray<Statement> = Arr.map(c.keys, (k) => {
		const [first, second] = k.guard
		const side =
			first === undefined
				? T
				: selectBuilder(T, (r: TRow) =>
						second === undefined ? atom(r, first) : r.and([atom(r, first), atom(r, second)])
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
		Rec.values(
			Rec.fromEntries([["T", T], ["K", K], ...Arr.map(sources, (s, i) => [`S${i}`, s] as const)])
		),
		[...keys, ...containments],
		[]
	)
}

export type BeyondFeature =
	| "a guarded key subsumed"
	| "two keys over one set in two orders, one object"
	| "a key beyond the primary"
	| "an immediate containment"
	| "a deferred containment"
