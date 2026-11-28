/** What the property of clock-reading.test.ts reads: its box, its schemas and the rule its verdicts state. */

import { int as between, type Gen, map } from "@bjornpagen/testing/gen"
import { clockReadingRange, type ClockUnit } from "#compiler/core/clock.ts"
import { Logic, Num, Type } from "#compiler/public/compute.ts"
import { domain, int4, int8 } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { changeSetOver as ChangeSet } from "#compiler/write/changeset/value.ts"

/**
 * A deadline a clocked write computes, `due = cast(base(now) + base(delay), Due)`: `now` its member's parameter bound to
 * the database's clock in `unit` and declared an unbounded contract over bigint, `delay` a row's value of a contract
 * whose predicate bounds it within [0, 10^exponent], stored beside the deadline and the reading, and `Due` the field's type, an unbounded contract over bigint or one
 * whose predicate bounds it at most 10^16.
 */
export interface Deadline {
	readonly unit: ClockUnit
	readonly exponent: number
	readonly due: "unbounded" | "at most 10^16"
}

export const deadlineGen: Gen<Deadline> = (source) => ({
	unit: source.draw(map(between(0, 1), (n): ClockUnit => (n === 0 ? "millis" : "micros"))),
	exponent: source.draw(map(between(0, 6), (n) => n * 3)),
	due: source.draw(
		map(between(0, 1), (n): Deadline["due"] => (n === 0 ? "unbounded" : "at most 10^16"))
	)
})

/** The greatest value of int8, PostgreSQL's bigint, which a value of no narrower bound holds. */
const int8Max = 2n ** 63n - 1n

/**
 * Whether the deadline types with no guard, by the rule: the sum's values lie within the clock's range in its unit, met
 * with bigint's, plus [0, 10^exponent], and they fit Due exactly where their greatest is at most Due's (the clock's
 * least is below 0, which neither Due bounds).
 */
export const fits = (d: Deadline): boolean => {
	const range = clockReadingRange[d.unit]
	const high = (range.high < int8Max ? range.high : int8Max) + 10n ** BigInt(d.exponent)
	return high <= (d.due === "unbounded" ? int8Max : 10n ** 16n)
}

export type DeadlineFeature =
	| "a millis deadline that fits"
	| "a micros deadline past bigint"
	| "a deadline past its field's bound"

export const deadlineFeature = (d: Deadline): DeadlineFeature =>
	fits(d)
		? "a millis deadline that fits"
		: d.unit === "micros" && d.due === "unbounded"
			? "a micros deadline past bigint"
			: "a deadline past its field's bound"

const delayKey = Symbol("Delay")
const dueKey = Symbol("Due")
const instantKey = Symbol("DenInstant")
/** The case's schema and its clocked write's ChangeSet, built as a JavaScript caller builds them. */
export const deadlineOf = (d: Deadline) => {
	const Instant = domain<typeof instantKey>()("DenInstant", int8)
	const Due =
		d.due === "unbounded"
			? domain<typeof dueKey>()("Due", int8)
			: domain<typeof dueKey>()("Due", int8, (t) => Logic.le(t, 10n ** 16n))
	const bound = 10n ** BigInt(d.exponent)
	const Delay = domain<typeof delayKey>()("Delay", int8, (t) =>
		Logic.and([Logic.ge(t, 0n), Logic.le(t, bound)])
	)
	const Step = relation("Step", { step: int4, at: Instant, delay: Delay, due: Due }, ["step"])
	const Deadlines = schema("Deadlines", [Step], [])
	const spawned = query(Deadlines).rule((r) => {
		const rows = r.relation("steps", { step: int4, delay: Delay })
		const row = v(rows, "row")
		return r.match(rows, { step: row.step, delay: row.delay }).find({
			step: row.step,
			at: r.param("now", Instant),
			delay: row.delay,
			due: Type.cast(Num.add(Type.base(r.param("now", Instant)), Type.base(row.delay)), Due, dueKey)
		})
	})
	return { schema: Deadlines, changeSet: () => ChangeSet.empty(Deadlines).insert(Step, spawned) }
}
