/** What the property of computed.test.ts reads: its schema, its programs, its space and its model. */

import type { Reached } from "@bjornpagen/testing/features"
import { array, element, type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { Logic, Num, Type } from "#compiler/public/compute.ts"
import {
	accumulated,
	contract,
	drawn,
	generated,
	mintOf,
	natural,
	pg
} from "#compiler/public/fields.ts"
import { param, query } from "#compiler/public/query.ts"
import { check, contained, fin, on, ordered, relation, schema } from "#compiler/public/schema.ts"
import { clocked } from "#compiler/public/workload.ts"
import { fixtureTemplate } from "#test/pg/reads/support.ts"

const spanKey = Symbol("Span")
/** A span of time a call adds to its clock's reading, bounded, so the sum fits a bigint under its guard. */
const Span = contract<typeof spanKey>()("Span", pg.bigint, (d) =>
	Logic.and([Logic.ge(d, 0n), Logic.le(d, 10n ** 12n)])
)
export const toSpan = mintOf(spanKey)

/** A row of Span's, so the installation holds its domain, which the calls' parameters bind through. */
const Spans = relation("Spans", { span: Span }, ["span"])

/** Depth 0: a lease, its `until` computed. */
const Lease = relation("Lease", { id: pg.integer, until: pg.bigint }, ["id"])

/**
 * Depth 1: an owner keyed by its queue and its computed `due`, its `until` computed, `held` generated over it, its items
 * carrying `due` and copying `until` along the owner axis at `cu`; Listed holds its queue to 1 and up, so an owner at
 * queue 0 is refused, its `held` over a value the database's clock supplies, which no host value holds.
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

/**
 * Depth 2: an owner as Flat, its items nesting parts, every member carrying `due`, and no generated field; Queued holds
 * its queue to 1 and up, so an owner at queue 0 is refused, its key's `due` the call's reading of the database's clock
 * plus its delay, which no host value holds.
 */
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

/**
 * A plain relation keyed over a field its insert computes, as den's served rows are keyed by their environment and the
 * instant the call casts its parameter into: Slot(env, at, v) keyed (env, at), `at` a Span, nesting nothing.
 */
const Slot = relation("Slot", { env: pg.integer, at: Span, v: pg.integer }, ["env", "at"])

export const Computed = schema(
	"Computed",
	[Spans, Lease, Flat, FlatItem, Deep, DeepItem, DeepPart, Slot],
	[
		ordered(on(FlatItem, "q", "due", "at"), fin(Flat, "items")),
		contained(on(FlatItem, "q", "due", "cu"), on(Flat, "q", "due", "until")),
		ordered(on(DeepItem, "q", "due", "at"), fin(Deep, "items")),
		ordered(on(DeepPart, "q", "due", "at", "bt"), fin(DeepItem, "parts")),
		check("Listed", Flat, (f) => f.ge(f.q, 1)),
		check("Queued", Deep, (d) => d.ge(d.q, 1))
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
			.insertAllComputed({ Lease: [] }, { until: after("budget") })
			.read("reading", reading),
		{ now: "micros" }
	),
	flat: clocked(
		ChangeSet.empty(Computed)
			.insertAllComputed({ Flat: [] }, { due: after("delay"), until: after("budget") })
			.read("reading", reading),
		{ now: "micros" }
	),
	deep: clocked(
		ChangeSet.empty(Computed)
			.insertAllComputed({ Deep: [] }, { due: after("delay"), until: after("budget") })
			.read("reading", reading),
		{ now: "micros" }
	),
	/** Slot's rows, `at` its key field computed as the call's parameter `t` cast into Span, as den's is. */
	slot: ChangeSet.empty(Computed).insertAllComputed(
		{ Slot: [] },
		{
			at: Type.cast(Type.base(param("t", Span)), Span, spanKey)
		}
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

/** The owner a call states at queue 0, which Listed refuses at depth 1 and Queued at depth 2: its relation and its
 * queue; none where every queue is 1 or up. */
export const unqueuedOf = (
	c: Computing
): { readonly relation: "Flat" | "Deep"; readonly q: 0 } | undefined =>
	c.depth === 0 || !Arr.some(c.owners, (o) => o.q === 0)
		? undefined
		: { relation: c.depth === 1 ? "Flat" : "Deep", q: 0 }

export type ComputedFeature =
	| "depth 0"
	| "depth 1"
	| "depth 2"
	| "several owners in one call"
	| "an owner nesting no member"
	| "a member nesting parts"
	| "a Flat at queue 0, its held generated over the database's clock reading"
	| "a Deep at queue 0, its key's clock reading the database's"

const ownersGen =
	(depth: Depth): Gen<ReadonlyArray<Owner>> =>
	(source) => {
		const count = source.draw(int(1, 3))
		/** The first queue: 1, or at depth 1 and 2, where Listed and Queued hold it, 0 or 1. */
		const from = depth === 0 ? 1 : source.draw(element([0, 1] as const))
		return Array.from({ length: count }, (_, i) => ({
			q: i + from,
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
		: []),
	...((): ReadonlyArray<ComputedFeature> => {
		const unqueued = unqueuedOf(c)
		return unqueued === undefined
			? []
			: [
					unqueued.relation === "Flat"
						? "a Flat at queue 0, its held generated over the database's clock reading"
						: "a Deep at queue 0, its key's clock reading the database's"
				]
	})()
]

export const situations = [
	"depth 0",
	"depth 1",
	"depth 2",
	"several owners in one call",
	"an owner nesting no member",
	"a member nesting parts",
	"a Flat at queue 0, its held generated over the database's clock reading",
	"a Deep at queue 0, its key's clock reading the database's"
] as const satisfies ReadonlyArray<Reached<ComputedFeature>>

/** One call of `slot`: its parameter `t`, every row's `at`, and its rows, each an environment and a value. */
export interface SlotCall {
	readonly t: bigint
	readonly rows: ReadonlyArray<{ readonly env: number; readonly v: number }>
}

/** Calls of `slot` one after another, each on the state the ones before it left. */
export interface Slotting {
	readonly calls: ReadonlyArray<SlotCall>
}

export type SlotFeature =
	| "one row"
	| "two rows of one environment and two values in one call"
	| "two rows of one fact in one call"
	| "two environments in one call"
	| "a call at a stored key's at, its value equal"
	| "a call at a stored key's at, its value another"
	| "two calls at two ats"

/** Few environments, values and parameters, so rows of one call meet at an environment and calls meet at `t`. */
const slotCallGen: Gen<SlotCall> = (source) => ({
	t: BigInt(source.draw(int(0, 2))),
	rows: source.draw(
		array((s) => ({ env: s.draw(int(0, 2)), v: s.draw(int(0, 2)) }), { min: 1, max: 3 })
	)
})

export const slottingGen: Gen<Slotting> = (source) => ({
	calls: source.draw(array(slotCallGen, { min: 1, max: 2 }))
})

/** What a call does: refused at Slot's key, its state kept; or accepted, adding `added` rows, none `unchanged`. */
export type SlotAnswer =
	| { readonly kind: "refused" }
	| { readonly kind: "accepted" | "unchanged"; readonly added: ReadonlyArray<SlotRow> }

/** A row of Slot, `at` read as a bigint. */
export interface SlotRow {
	readonly env: number
	readonly at: bigint
	readonly v: number
}

/** The model: `call` on `stored`, every row holding the call's `t` at `at`. Its rows are one fact each per distinct row;
 * two of them at one environment and two values share the key (env, t) and refuse the call; a row at a stored key is
 * its repeat when its value is the stored one, else it refuses the call; every other row is added. */
export const slotAnswer = (stored: ReadonlyArray<SlotRow>, call: SlotCall): SlotAnswer => {
	const facts = Arr.dedupeWith(call.rows, (a, b) => a.env === b.env && a.v === b.v)
	const shared = Arr.some(facts, (a) => Arr.some(facts, (b) => a.env === b.env && a.v !== b.v))
	const atKey = (f: { readonly env: number }) =>
		Arr.findFirst(stored, (r) => r.env === f.env && r.at === call.t)
	const conflicts = Arr.some(facts, (f) => {
		const met = atKey(f)
		return met._tag === "Some" && met.value.v !== f.v
	})
	if (shared || conflicts) {
		return { kind: "refused" }
	}
	const added = Arr.map(
		Arr.filter(facts, (f) => atKey(f)._tag === "None"),
		(f): SlotRow => ({ env: f.env, at: call.t, v: f.v })
	)
	return { kind: Arr.isReadonlyArrayNonEmpty(added) ? "accepted" : "unchanged", added }
}

/** The features a case reaches, read off its calls and the model's states. */
export const slotFeatures = (c: Slotting): ReadonlyArray<SlotFeature> => {
	const features: Array<SlotFeature> = []
	const stored: Array<SlotRow> = []
	for (const call of c.calls) {
		const facts = Arr.dedupeWith(call.rows, (a, b) => a.env === b.env && a.v === b.v)
		if (call.rows.length === 1) {
			features.push("one row")
		}
		if (Arr.some(facts, (a) => Arr.some(facts, (b) => a.env === b.env && a.v !== b.v))) {
			features.push("two rows of one environment and two values in one call")
		}
		if (facts.length < call.rows.length) {
			features.push("two rows of one fact in one call")
		}
		if (Arr.dedupe(Arr.map(facts, (f) => f.env)).length > 1) {
			features.push("two environments in one call")
		}
		for (const f of facts) {
			const met = Arr.findFirst(stored, (r) => r.env === f.env && r.at === call.t)
			if (met._tag === "Some") {
				features.push(
					met.value.v === f.v
						? "a call at a stored key's at, its value equal"
						: "a call at a stored key's at, its value another"
				)
			}
		}
		const answer = slotAnswer(stored, call)
		if (answer.kind !== "refused") {
			for (const row of answer.added) {
				stored.push(row)
			}
		}
	}
	const [first, second] = c.calls
	if (first !== undefined && second !== undefined && first.t !== second.t) {
		features.push("two calls at two ats")
	}
	return Arr.dedupe(features)
}

export const slotSituations = [
	"one row",
	"two rows of one environment and two values in one call",
	"two rows of one fact in one call",
	"two environments in one call",
	"a call at a stored key's at, its value equal",
	"a call at a stored key's at, its value another",
	"two calls at two ats"
] as const satisfies ReadonlyArray<Reached<SlotFeature>>
