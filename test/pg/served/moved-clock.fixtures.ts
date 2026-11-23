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

/** An hour, in microseconds, the unit every reading and instant here counts. */
const hour = 3_600_000_000n

/** A day, in microseconds. */
const day = 24n * hour

/**
 * The instants a lease is taken at, in microseconds since the Unix epoch: the epoch itself, the least instant an
 * instant holds (scalar/instant.ts: never below zero); one of 2026 to the microsecond; one of 2056; and the last
 * microsecond of the year 9999. None of them is the database's own instant, which a moved Db never reads.
 */
const takings = {
	"the epoch": 0n,
	"an instant of 2026 to the microsecond": 1_795_392_000_123_457n,
	"an instant of 2056": 2_717_366_400_000_001n,
	"the last microsecond of 9999": 253_402_300_799_999_999n
} as const

type Taking = keyof typeof takings

/**
 * Where a lease is judged, from the instant it was taken at: at that instant, at the last microsecond of its lease, at
 * its bound (the taking plus the budget), or past it by `by`.
 */
type Judging =
	| { readonly kind: "at the taking" }
	| { readonly kind: "at its last instant within" }
	| { readonly kind: "past"; readonly by: bigint }

/** A case: the instant the lease is taken at, its budget, and where it is judged. */
export interface Moving {
	readonly taking: Taking
	readonly budget: bigint
	readonly judged: Judging
}

export const movingGen: Gen<Moving> = (source) => ({
	taking: source.draw(
		element<Taking>([
			"the epoch",
			"an instant of 2026 to the microsecond",
			"an instant of 2056",
			"the last microsecond of 9999"
		])
	),
	budget: source.draw(element([1n, hour, day] as const)),
	judged: source.draw(
		element<Judging>([
			{ kind: "at the taking" },
			{ kind: "at its last instant within" },
			{ kind: "past", by: 0n },
			{ kind: "past", by: 1n },
			{ kind: "past", by: day }
		])
	)
})

/** The instant a case's lease is taken at. */
export const takenAt = (c: Moving): bigint => takings[c.taking]

/** The instant a case's lease is judged at. */
export const judgedAt = (c: Moving): bigint => {
	switch (c.judged.kind) {
		case "at the taking":
			return takenAt(c)
		case "at its last instant within":
			return takenAt(c) + c.budget - 1n
		case "past":
			return takenAt(c) + c.budget + c.judged.by
	}
}

/** Whether a case's lease is live where it is judged: before its bound. */
export const liveWhenJudged = (c: Moving): boolean => c.judged.kind !== "past"

export type MovingFeature =
	| Taking
	| "judged at the taking"
	| "judged at its last instant within"
	| "judged at its bound"
	| "judged past its bound"

export const movingFeatures = (c: Moving): ReadonlyArray<MovingFeature> => [
	c.taking,
	c.judged.kind === "at the taking"
		? "judged at the taking"
		: c.judged.kind === "at its last instant within"
			? "judged at its last instant within"
			: c.judged.by === 0n
				? "judged at its bound"
				: "judged past its bound"
]

export const situations = [
	"the epoch",
	"an instant of 2026 to the microsecond",
	"an instant of 2056",
	"the last microsecond of 9999",
	"judged at the taking",
	"judged at its last instant within",
	"judged at its bound",
	"judged past its bound"
] as const satisfies ReadonlyArray<Reached<MovingFeature>>
