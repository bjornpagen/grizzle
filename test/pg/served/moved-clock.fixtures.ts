/** What the property of moved-clock.test.ts reads: its schema, its programs, its space and its model. */

import type { Reached } from "@bjornpagen/testing/features"
import { element, type Gen } from "@bjornpagen/testing/gen"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { Logic, Num, Type } from "#compiler/public/compute.ts"
import { contract, instant, pg } from "#compiler/public/fields.ts"
import { param, query, v } from "#compiler/public/query.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { clocked } from "#compiler/public/workload.ts"
import { fixtureTemplate } from "#test/pg/reads/support.ts"

/** A lease's budget, bounded, so a reading plus it fits a bigint under its guard. */
export const Span = contract("Span", pg.bigint, (d) =>
	Logic.and(Logic.ge(d, 0n), Logic.le(d, 10n ** 12n))
)

/** A row of Span's, so the installation holds its domain, which the calls' budgets bind through. */
const Spans = relation("Spans", { span: Span }, ["span"])

/** A lease, its `until` computed: the call's reading plus its budget. */
const Lease = relation("Lease", { id: pg.integer, until: pg.bigint }, ["id"])

/** A mark of a lease's taking, its instant stamped by the insert from the database's clock. */
const Mark = relation("Mark", { id: pg.integer, at: instant }, ["id", "at"])

export const Moved = schema("Moved", [Spans, Lease, Mark], [])

/** The call's reading of the database's clock in microseconds, the parameter `now`, which each member binds to it. */
const now = () => param("now", pg.bigint)

/** The reading plus the budget, a bigint under its guard. */
const untilOf = Logic.when(
	Num.within(Num.add(Type.base(now()), Type.base(param("budget", Span))), 0n, 9223372036854775807n),
	(x) => Type.cast(x, pg.bigint),
	0n
)

/**
 * `take`: a lease taken, its `until` the call's reading plus `budget`, and its mark stamped, reading the reading back in
 * its transaction; `live`: each lease whose `until` is past the call's reading, with that reading. Each is clocked in
 * microseconds.
 */
const programs = Object.freeze({
	take: clocked(
		ChangeSet.empty(Moved)
			.insertAllComputed({ Lease: [] }, { until: untilOf })
			.insert(Mark, [])
			.read("reading", () => query(Moved).rule((r) => r.find({ now: r.param("now", pg.bigint) }))),
		{ now: "micros" }
	),
	live: clocked(
		query(Moved).rule((r) => {
			const { id, until } = v(Lease, "lease")
			const reading = r.param("now", pg.bigint)
			return r.match(Lease, { id, until }).where(r.gt(until, reading)).find({ id, now: reading })
		}),
		{ now: "micros" }
	)
})

export const movedInstall = Object.freeze({ label: "moved", programs })

/** Moved installed as `grizzle generate` drafts it, once per member: the template every case clones. */
export const movedTemplate = fixtureTemplate(import.meta, Moved, movedInstall)

/** An hour, in microseconds, the unit every reading and offset here counts. */
const hour = 3_600_000_000n

/** A day, in microseconds. */
const day = 24n * hour

/**
 * A case: the offset the lease is taken at; its budget, an hour or more, so no call's run outlasts it; and where it is
 * judged: at the offset it was taken at, within its lease, or past its bound, the taking's offset plus the budget and
 * `past` more.
 */
export interface Moving {
	readonly taken: bigint
	readonly budget: bigint
	readonly judged: { readonly kind: "within" } | { readonly kind: "past"; readonly by: bigint }
}

export const movingGen: Gen<Moving> = (source) => ({
	taken: source.draw(element([0n, -hour, 30n * 365n * day, -3n * 365n * day] as const)),
	budget: source.draw(element([hour, 7n * hour, day] as const)),
	judged: source.draw(
		element([
			{ kind: "within" },
			{ kind: "past", by: 0n },
			{ kind: "past", by: 1n },
			{ kind: "past", by: day }
		] as const)
	)
})

/** The offset a case's lease is judged at. */
export const judgedAt = (c: Moving): bigint => {
	switch (c.judged.kind) {
		case "within":
			return c.taken
		case "past":
			return c.taken + c.budget + c.judged.by
	}
}

export type MovingFeature =
	| "offset 0"
	| "an offset into the past"
	| "an offset into the future"
	| "judged within the lease"
	| "judged at its bound"
	| "judged past its bound"

export const movingFeatures = (c: Moving): ReadonlyArray<MovingFeature> => [
	c.taken === 0n
		? "offset 0"
		: c.taken < 0n
			? "an offset into the past"
			: "an offset into the future",
	c.judged.kind === "within"
		? "judged within the lease"
		: c.judged.by === 0n
			? "judged at its bound"
			: "judged past its bound"
]

export const situations = [
	"offset 0",
	"an offset into the past",
	"an offset into the future",
	"judged within the lease",
	"judged at its bound",
	"judged past its bound"
] as const satisfies ReadonlyArray<Reached<MovingFeature>>
