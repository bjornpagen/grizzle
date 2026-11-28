/** What the properties of clock.test.ts read: its spaces, models and helpers. */

import { assert } from "@bjornpagen/testing/assert"
import { element, type Gen, int } from "@bjornpagen/testing/gen"
import { Record as Rec } from "effect"
import { isRecord } from "#compiler/core/record.ts"
import { clockedMember } from "#compiler/program/workload/value.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { Logic } from "#compiler/public/compute.ts"
import { contract, pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import type { Generated } from "#test/support/install-migrate.ts"
import { fixtureTemplate } from "#test/support/pg/reads/support.ts"
import type { SubstrateTemplate } from "#test/support/substrate/substrate.ts"

/**
 * A member that binds a parameter to the database's clock (workload clocked) reads the instant its call's transaction
 * began, transaction_timestamp(), once per call, in its unit, and answers at that instant alone. Generated: a fresh
 * installation per case, the reading's unit, and wanted rows due before the call's first reading or an hour or more
 * after it, then one call of each member.
 *
 * Properties, each against an oracle the host computes from the readings the calls deliver, never from a clock of its
 * own:
 *
 * - A call binding the reading in microseconds and in milliseconds reads ms = floor(us / 1000).
 * - A clocked read of what is due at or before the reading answers exactly the rows due before the first reading:
 *   every one committed before its call began, so due at or before its reading, and none of those due an hour on.
 *   Its answer is `reset`, its upserts, `ready`, then `end`, and the stream ends there: it is never live.
 * - One reading per call: a clocked ChangeSet stamping every wanted key into Stamp, then into Mark in a later stratum,
 *   stamps every row with the one instant its read-back reads.
 * - A clocked parameter of a contract is judged by its contract: a reading the contract admits answers, and one it
 *   refuses is `refused`.
 */

const instantKey = Symbol("Instant")
/** An instant, and the instants on either side of 2100-01-01 in milliseconds since the epoch. */
const Instant = contract<typeof instantKey>()("Instant", pg.bigint)

const year2100 = 4_102_444_800_000n

const before2100Key = Symbol("Before2100")
const Before2100 = contract<typeof before2100Key>()("Before2100", pg.bigint, (x) =>
	Logic.le(x, year2100)
)

const after2100Key = Symbol("After2100")
const After2100 = contract<typeof after2100Key>()("After2100", pg.bigint, (x) =>
	Logic.ge(x, year2100)
)

const Wanted = relation("Wanted", { key: pg.integer, due: Instant }, ["key"])

const Stamp = relation("Stamp", { key: pg.integer, at: Instant }, ["key"])

const Mark = relation("Mark", { key: pg.integer, at: Instant }, ["key"])

const Bounds = relation("Bounds", { key: pg.integer, before: Before2100, after: After2100 }, [
	"key"
])

export const Clock = schema("Clock", [Wanted, Stamp, Mark, Bounds], [])

type Unit = "micros" | "millis"

/** How many of a unit one hour holds. */
export const perHour: { readonly [U in Unit]: bigint } = {
	micros: 3_600_000_000n,
	millis: 3_600_000n
}

/** A wanted row as offsets from the first reading: due that many units before it, or an hour and that many after it. */
interface Want {
	readonly past: boolean
	readonly offset: bigint
}

interface ClockCase {
	readonly unit: Unit
	readonly wants: ReadonlyArray<Want>
}

const wantGen: Gen<Want> = (source) => {
	const past = source.draw(element([true, false] as const))
	const offset = source.draw(element([0, 1, 999, 1_000, 59_999, 3_599_999] as const))
	return { past, offset: BigInt(offset) }
}

export const caseGen: Gen<ClockCase> = (source) => ({
	unit: source.draw(element(["micros", "millis"] as const)),
	wants: Array.from({ length: source.draw(int(1, 40)) }, () => source.draw(wantGen))
})

export type Feature =
	| "micros"
	| "millis"
	| "a row due exactly at the first reading"
	| "a row due an hour on"
	| "no row due"
	| "a contract that admits the reading"
	| "a contract that refuses the reading"

/** The one bigint member of a read's one row, `name`. */
export const onlyReading = (rows: ReadonlyArray<unknown>, name: string): bigint => {
	const [row, ...rest] = rows
	const value = isRecord(row) ? row[name] : undefined
	assert.ok(rest.length === 0 && typeof value === "bigint", `one row holding a bigint ${name}`)
	return typeof value === "bigint" ? value : 0n
}

/** A row's bigint member `name`. */
export const bigintOf = (row: unknown, name: string): bigint => {
	const value = isRecord(row) ? row[name] : undefined
	assert.ok(typeof value === "bigint", `a row holding a bigint ${name}`)
	return typeof value === "bigint" ? value : 0n
}

/** A reading of the clock, `now`, in the case's unit. */
const instant = () => query(Clock).rule((r) => r.find({ now: r.param("now", Instant) }))

/** Every wanted key stamped into `target` at the call's reading. */
const stampsOf = (target: typeof Stamp | typeof Mark) =>
	ChangeSet.empty(Clock).insert(
		target,
		query(Clock).rule((r) => {
			const { key, due } = v(Wanted, "wanted")
			return r.match(Wanted, { key, due }).find({ key, at: r.param("now", Instant) })
		})
	)

/**
 * The members a case of `unit` installs in its login's workload and calls: a reading, a reading in both units, the
 * wanted rows' insert, what is due at the reading, the two strata of stamps and their reads, and a reading under each
 * contract.
 */
export const clockPrograms = (unit: Unit) => ({
	reading: clockedMember(instant(), { now: unit }),
	both: clockedMember(
		query(Clock).rule((r) =>
			r.find({ us: r.param("us", pg.bigint), ms: r.param("ms", pg.bigint) })
		),
		{ us: "micros", ms: "millis" }
	),
	want: ChangeSet.empty(Clock).insert(Wanted, []),
	due: clockedMember(
		query(Clock).rule((r) => {
			const { key, due } = v(Wanted, "wanted")
			return r
				.match(Wanted, { key, due })
				.where(r.le(due, r.param("now", Instant)))
				.find({ key, due })
		}),
		{ now: unit }
	),
	stamp: clockedMember(
		ChangeSet.sequence(stampsOf(Stamp), stampsOf(Mark)).read("now", () => instant()),
		{ now: unit }
	),
	stamps: query(Clock).rule((r) => {
		const { key, at: stamped } = v(Stamp, "stamp")
		return r.match(Stamp, { key, at: stamped }).find({ key, at: stamped })
	}),
	marks: query(Clock).rule((r) => {
		const { key, at: marked } = v(Mark, "mark")
		return r.match(Mark, { key, at: marked }).find({ key, at: marked })
	}),
	before: clockedMember(
		query(Clock).rule((r) => r.find({ now: r.param("now", Before2100) })),
		{
			now: "millis"
		}
	),
	after: clockedMember(
		query(Clock).rule((r) => r.find({ now: r.param("now", After2100) })),
		{
			now: "millis"
		}
	)
})

/** What a case of `unit` installs: Clock, with its login's workload holding that unit's members (clockPrograms). */
export const clockInstall = (unit: Unit) => ({
	label: `clock_${unit}`,
	programs: clockPrograms(unit)
})

/** Clock installed once per member for each unit (reads/support.ts fixtureTemplate), which a case of that unit clones. */
export const clockTemplates: Readonly<Record<Unit, SubstrateTemplate<Generated>>> = Rec.map(
	{ micros: "micros", millis: "millis" } satisfies Readonly<Record<Unit, Unit>>,
	(unit) => fixtureTemplate(import.meta, Clock, clockInstall(unit))
)
