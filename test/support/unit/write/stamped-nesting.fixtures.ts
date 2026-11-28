/**
 * What the properties over a nested write under a stamped owner read: their box, the schema and the ChangeSet of each
 * case, the rule's verdict, and their features (stamped-nesting.test.ts, test/pg/write/stamped-nesting).
 */

import { int as between, element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import { Logic } from "#compiler/public/compute.ts"
import {
	accumulated,
	drawn,
	generated,
	natural,
	place,
	int4,
	int8
} from "#compiler/public/fields.ts"
import {
	contained,
	fin,
	fold,
	Monoid,
	on,
	ordered,
	relation,
	schema,
	select,
	type Statement
} from "#compiler/public/schema.ts"
import { changeSetOver as ChangeSet } from "#compiler/write/changeset/value.ts"

/**
 * Which members the owner's sum of its members' payload `v` steps over, each member also holding a generated field over
 * its carried place and copying the owner's `x` along the owner axis:
 * - `every`: every member, so the walk reads no stamp;
 * - `stamp`: those whose carried place is at least 1;
 * - `generated`: those whose generated field over their carried place is at least 1.
 */
const selections = ["every", "stamp", "generated"] as const

export type Selection = (typeof selections)[number]

/** The owners a case's call inserts: one; two in two groups; or two in one group, stated apart. */
const ownerSets = ["one", "two groups", "one group"] as const

export type OwnerSet = (typeof ownerSets)[number]

/**
 * A case: its members' depth, a sequence of members or members two deep; the members the owner's fold steps over; the
 * owners its call inserts; and each owner's members, and at depth 2 each member's.
 */
export interface StampedCase {
	readonly depth: number
	readonly selects: Selection
	readonly owners: OwnerSet
	readonly members: number
}

/** The cases whose owner's fold steps over the members `selects` draws, every other axis drawn from its bounds. */
const casesOver =
	(selects: Gen<Selection>): Gen<StampedCase> =>
	(source) => ({
		depth: source.draw(between(1, 2)),
		selects: source.draw(selects),
		owners: source.draw(element(ownerSets)),
		members: source.draw(between(0, 2))
	})

export const stampedGen: Gen<StampedCase> = casesOver(element(selections))

/** The cases whose owner's fold steps over every member, which bind and are written: the walk reads no stamp. */
export const writtenGen: Gen<StampedCase> = casesOver(() => "every")

/** What the rule says of a case: its write binds; it is refused where it compiles, the fill of a member's fold reading
 * `source`, a column the write's statement stamps; or two of its owners, stamped one place, meet at the owner's key. */
export type StampedVerdict =
	| { readonly kind: "bound" }
	| { readonly kind: "unfillable"; readonly source: "s" | "gs" }
	| { readonly kind: "conflict" }

export const verdictOf = (c: StampedCase): StampedVerdict => {
	switch (c.selects) {
		case "stamp":
			return { kind: "unfillable", source: "s" }
		case "generated":
			return { kind: "unfillable", source: "gs" }
		case "every":
			return c.owners === "one group" ? { kind: "conflict" } : { kind: "bound" }
	}
}

export type StampedFeature =
	| `selects ${Selection}`
	| `owners ${OwnerSet}`
	| "members two deep"
	| "no member"
	| StampedVerdict["kind"]

export const featuresOf = (c: StampedCase): ReadonlyArray<StampedFeature> => [
	`selects ${c.selects}`,
	`owners ${c.owners}`,
	verdictOf(c).kind,
	...(c.depth === 2 ? (["members two deep"] as const) : []),
	...(c.members === 0 ? (["no member"] as const) : [])
]

/**
 * A case's schema, built under `name`: Owner keyed by its child (g, h) and its place `s`, owning the sequence M1 at
 * `ms`, its members carrying its key and holding a payload `v`, with `gs`, a generated field over their carried place,
 * `cx`, a copy of the owner's `x`, and the owner's sum `tot` of its members' payload over the members the case selects;
 * M1 owns the sequence M2 at `ks`, each carrying its owner's key, the den claim's holds' shape (Claim(step, root,
 * attempt) owning Hold(step, root, attempt, at)).
 */
export const stampedSchemaOf = (c: Pick<StampedCase, "selects">, name: string) => {
	const Owner = relation(
		"Owner",
		{
			g: int4,
			h: int4,
			s: place,
			x: int4,
			ms: drawn(natural),
			tot: accumulated(int8, 0n)
		},
		["g", "h", "s"]
	)
	const M1 = relation.generated(
		"M1",
		{
			g: int4,
			h: int4,
			s: natural,
			at: drawn(natural),
			v: int8,
			cx: accumulated(int4, 0),
			ks: drawn(natural)
		},
		["g", "h", "s", "at"],
		(r) => ({ gs: generated(int8, Logic.cond(Logic.ge(r.s, 1n), r.v, 0n)) })
	)
	const M2 = relation(
		"M2",
		{ g: int4, h: int4, s: natural, at: natural, bt: drawn(natural), w: int4 },
		["g", "h", "s", "at", "bt"]
	)
	const members = ordered(on(M1, "g", "h", "s", "at"), fin(Owner, "ms"))
	const total = on(Owner, "g", "h", "s", "tot")
	const summed = ((): Statement => {
		switch (c.selects) {
			case "every":
				return fold(members, Monoid.sum, on(M1, "g", "h", "s", "v"), total)
			case "stamp":
				return fold(
					members,
					Monoid.sum,
					on(
						select(M1, (m) => m.ge(m.s, 1n)),
						"g",
						"h",
						"s",
						"v"
					),
					total
				)
			case "generated":
				return fold(
					members,
					Monoid.sum,
					on(
						select(M1, (m) => m.ge(m.gs, 1n)),
						"g",
						"h",
						"s",
						"v"
					),
					total
				)
		}
	})()
	return {
		Owner,
		M1,
		M2,
		schema: schema(
			name,
			[Owner, M1, M2],
			[
				members,
				ordered(on(M2, "g", "h", "s", "at", "bt"), fin(M1, "ks")),
				contained(on(M1, "g", "h", "s", "cx"), on(Owner, "g", "h", "s", "x")),
				summed
			]
		)
	}
}

/** An owner a case's call inserts: its child's values and its `x`, and its members, each with its payload and, two deep,
 * its own members' `w`. */
export interface OwnerFact {
	readonly g: number
	readonly h: number
	readonly x: number
	readonly members: ReadonlyArray<{ readonly v: bigint; readonly ws: ReadonlyArray<number> }>
}

/** The owners a case's call inserts (`OwnerFact`), each with the case's members, two deep each with as many of its own. */
export const ownersOf = (c: StampedCase): ReadonlyArray<OwnerFact> => {
	const members = Array.from({ length: c.members }, (_, i) => ({
		v: BigInt(10 * (i + 1)),
		ws: c.depth === 1 ? [] : Array.from({ length: c.members }, (_w, j) => 100 * (i + 1) + j)
	}))
	const at = (g: number, x: number): OwnerFact => ({ g, h: 7, x, members })
	switch (c.owners) {
		case "one":
			return [at(1, 1)]
		case "two groups":
			return [at(1, 1), at(2, 2)]
		case "one group":
			return [at(1, 1), at(1, 2)]
	}
}

/** A case's ChangeSet over its schema `built`: an insert of its owners' host rows, each leaving its place out, its
 * members nested at `ms`, theirs at `ks`. */
export const changeSetOf = (c: StampedCase, built: ReturnType<typeof stampedSchemaOf>) =>
	ChangeSet.empty(built.schema).insert(
		built.Owner,
		Arr.map(ownersOf(c), (o) => ({
			g: o.g,
			h: o.h,
			x: o.x,
			ms: Arr.map(o.members, (m) => ({ v: m.v, ks: Arr.map(m.ws, (w) => ({ w })) }))
		}))
	)
