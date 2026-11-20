/** What the property of computed.test.ts reads: its schema, its programs, its space and its model. */

import type { Reached } from "@bjornpagen/testing/features"
import { array, element, type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { Logic, Num, Type } from "#compiler/public/compute.ts"
import { accumulated, contract, drawn, generated, natural, pg } from "#compiler/public/fields.ts"
import { param, query } from "#compiler/public/query.ts"
import { contained, fin, on, ordered, relation, schema } from "#compiler/public/schema.ts"
import { clocked } from "#compiler/public/workload.ts"
import { fixtureTemplate } from "#test/pg/reads/support.ts"

/** A span of time a call adds to its clock's reading, bounded, so the sum fits a bigint under its guard. */
export const Span = contract("Span", pg.bigint, (d) =>
	Logic.and(Logic.ge(d, 0n), Logic.le(d, 10n ** 12n))
)

/** A row of Span's, so the installation holds its domain, which the calls' parameters bind through. */
const Spans = relation("Spans", { span: Span }, ["span"])

/** Depth 0: a lease, its `until` computed. */
const Lease = relation("Lease", { id: pg.integer, until: pg.bigint }, ["id"])

/**
 * Depth 1: an owner keyed by its queue and its computed `due`, its `until` computed, `held` generated over it, its items
 * carrying `due` and copying `until` along the owner axis at `cu`.
 */
const Flat = relation.generated(
	"Flat",
	{ q: pg.integer, due: pg.bigint, until: pg.bigint, items: drawn(natural) },
	["q", "due"],
	(r) => ({ held: generated(pg.bigint, Logic.cond(Logic.ge(r.until, 0n), r.until, 0n)) })
)
const FlatItem = relation(
	"FlatItem",
	{
		q: pg.integer,
		due: pg.bigint,
		at: drawn(natural),
		v: pg.integer,
		cu: accumulated(pg.bigint, 0n)
	},
	["q", "due", "at"]
)

/** Depth 2: an owner as Flat, its items nesting parts, every member carrying `due`. */
const Deep = relation(
	"Deep",
	{ q: pg.integer, due: pg.bigint, until: pg.bigint, items: drawn(natural) },
	["q", "due"]
)
const DeepItem = relation(
	"DeepItem",
	{ q: pg.integer, due: pg.bigint, at: drawn(natural), v: pg.integer, parts: drawn(natural) },
	["q", "due", "at"]
)
const DeepPart = relation(
	"DeepPart",
	{ q: pg.integer, due: pg.bigint, at: natural, bt: drawn(natural), w: pg.integer },
	["q", "due", "at", "bt"]
)

export const Computed = schema(
	"Computed",
	[Spans, Lease, Flat, FlatItem, Deep, DeepItem, DeepPart],
	[
		ordered(on(FlatItem, "q", "due", "at"), fin(Flat, "items")),
		contained(on(FlatItem, "q", "due", "cu"), on(Flat, "q", "due", "until")),
		ordered(on(DeepItem, "q", "due", "at"), fin(Deep, "items")),
		ordered(on(DeepPart, "q", "due", "at", "bt"), fin(DeepItem, "parts"))
	]
)

/** The call's reading of the database's clock, in microseconds, plus the parameter `by`, a bigint under its guard. */
const after = <const By extends string>(by: By) =>
	Logic.when(
		Num.within(
			Num.add(Type.base(param("now", pg.bigint)), Type.base(param(by, Span))),
			0n,
			9223372036854775807n
		),
		(x) => Type.cast(x, pg.bigint),
		0n
	)

/** The call's reading, read back in its transaction: the parameter `now` alone, which the member binds to the clock. */
const reading = () => query(Computed).rule((r) => r.find({ now: r.param("now", pg.bigint) }))

/** Each depth's insert, its fields computed from the call's reading, reading the reading back, clocked in micros. */
const programs = Object.freeze({
	lease: clocked(
		ChangeSet.empty(Computed)
			.insertComputed(Lease, [], { until: after("budget") })
			.read("reading", reading),
		{ now: "micros" }
	),
	flat: clocked(
		ChangeSet.empty(Computed)
			.insertComputed(Flat, [], { due: after("delay"), until: after("budget") })
			.read("reading", reading),
		{ now: "micros" }
	),
	deep: clocked(
		ChangeSet.empty(Computed)
			.insertComputed(Deep, [], { due: after("delay"), until: after("budget") })
			.read("reading", reading),
		{ now: "micros" }
	)
})

export const computedInstall = Object.freeze({ label: "computed", programs })

/** Computed installed as `grizzle generate` drafts it, once per member: the template every case clones. */
export const computedTemplate = fixtureTemplate(import.meta, Computed, computedInstall)

/** How deep a call's rows nest: a lease's none, a Flat's items, a Deep's items and their parts. */
export type Depth = 0 | 1 | 2

/** One owner a call states: its queue, and per item its value and its parts' values. */
export interface Owner {
	readonly q: number
	readonly items: ReadonlyArray<{ readonly v: number; readonly parts: ReadonlyArray<number> }>
}

export interface Computing {
	readonly depth: Depth
	readonly owners: ReadonlyArray<Owner>
	readonly budget: bigint
	readonly delay: bigint
}

export type ComputedFeature =
	| "depth 0"
	| "depth 1"
	| "depth 2"
	| "several owners in one call"
	| "an owner nesting no member"
	| "a member nesting parts"

const ownersGen =
	(depth: Depth): Gen<ReadonlyArray<Owner>> =>
	(source) => {
		const count = source.draw(int(1, 3))
		return Array.from({ length: count }, (_, i) => ({
			q: i + 1,
			items:
				depth === 0
					? []
					: source.draw(
							array(
								(s) => ({
									v: s.draw(int(0, 9)),
									parts: depth === 2 ? s.draw(array(int(0, 9), { min: 0, max: 2 })) : []
								}),
								{ min: 0, max: 2 }
							)
						)
		}))
	}

export const computingGen: Gen<Computing> = (source) => {
	const depth = source.draw(element([0, 1, 2] as const))
	return {
		depth,
		owners: source.draw(ownersGen(depth)),
		budget: BigInt(source.draw(int(0, 1_000_000))),
		delay: BigInt(source.draw(int(0, 1_000_000)))
	}
}

export const computedFeatures = (c: Computing): ReadonlyArray<ComputedFeature> => [
	c.depth === 0 ? "depth 0" : c.depth === 1 ? "depth 1" : "depth 2",
	...(c.owners.length > 1 ? (["several owners in one call"] as const) : []),
	...(c.depth > 0 && Arr.some(c.owners, (o) => o.items.length === 0)
		? (["an owner nesting no member"] as const)
		: []),
	...(Arr.some(c.owners, (o) => Arr.some(o.items, (i) => i.parts.length > 0))
		? (["a member nesting parts"] as const)
		: [])
]

export const situations = [
	"depth 0",
	"depth 1",
	"depth 2",
	"several owners in one call",
	"an owner nesting no member",
	"a member nesting parts"
] as const satisfies ReadonlyArray<Reached<ComputedFeature>>
