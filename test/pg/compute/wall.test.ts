/**
 * Time.wall on PostgreSQL 19 against the TZif reference: a zone's wall clock at an instant, as the server's own tzdata
 * reads it, through the statement a served query runs.
 *
 * Each case installs a schema of its own: Zone, a zone roster (closed.zones) of one to four zones drawn from a
 * dictionary of what a wall clock branches on (wall.fixtures.ts zones), so the migration's Setup reads each handle as
 * a time zone first (deploy/diff/diff.ts zoneChecks); and Probe, an instant of milliseconds within timestamptz's range
 * (Millis) and a closed id of Zone, by id, installed as `grizzle generate` drafts and serves it, its login serving the
 * case's programs. It writes twenty to sixty probes and reads `{ id, wall: Time.wall(at, zone) }` through the full role's
 * Db, so the query's SQL calls the installation's library function `wall` over the zone's name,
 * read from Zone's names constant, which the role is granted. Each probe lies around a transition of its zone's file,
 * a minute or an hour either way and a millisecond, at one of metis's instants, within three days of the epoch, a leap
 * day or either end of the range or its outer Gregorian cycles, or anywhere in a year of the range.
 *
 * Oracle: the TZif reference (test/support/oracle/reference/tzif.ts), RFC 8536 read apart from PostgreSQL's
 * localtime.c and grizzle's SQL, over the zone files of the share directory of the pinned build the cluster runs, the
 * files the server itself reads: one tzdata by construction.
 *
 * A second property holds the migration's zone check: a zone roster naming a zone the server's tzdata lacks refuses its
 * migration with PostgreSQL's 22023, so no Time.wall over it ever raises.
 *
 * A third holds Time.epochDay and Time.dateOfEpochDay, which the host evaluates too, to Hinnant's day count.
 *
 * Kills: the zone's offset at the Unix epoch read for every instant, a fixed UTC offset; the instant's day taken by
 * truncating division, which puts an instant before 1970 in the next day, so one short of a transition reads the
 * offset past it; a reading of no handle by the migration; an epoch day off by one for days before 1970 on the host;
 * and PostgreSQL's epoch day with its sign turned.
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { boolean, element, type Gen } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import {
	Array as Arr,
	Cause,
	Effect,
	Exit,
	FileSystem,
	Formatter,
	Predicate,
	String as Str
} from "effect"
import { MigrateError } from "#adapter/migrate/errors.ts"
import { rowEvaluator } from "#adapter/public/host.ts"
import { pin } from "#pg/pin.ts"
import {
	caseGen,
	type DayFeature,
	dayCaseGen,
	daysSchema,
	featuresOf,
	firstDay,
	lastDay,
	instantOf,
	type WallCase,
	type WallFeature,
	wallWorld,
	type ZoneName,
	zones
} from "#test/pg/compute/wall.fixtures.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { succeeded } from "#test/support/assert.ts"
import { readOnce, writeOnce } from "#test/support/calls.ts"
import { installGenerated } from "#test/support/install-migrate.ts"
import { dateText, daysOfDate } from "#test/support/oracle/reference/calendar.ts"
import { wallMillis, type Zone, zoneOf } from "#test/support/oracle/reference/tzif.ts"
import { member, openServedDb } from "#test/support/served-db.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"

/**
 * The server's zone files: the timezone directory of the share directory of the pinned build the cluster's members run
 * (packages/pg pin.ts, GRIZZLE_PG_PREFIX), where a build with its bundled tzdata installs its zones and its pg_config
 * reports them (SHAREDIR).
 */
const zoneFiles = `${pin.GRIZZLE_PG_PREFIX}/share/timezone`

/** Each of `names` read from the server's zone files. */
const zonesRead = (names: ReadonlyArray<ZoneName>) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const read = new Map<ZoneName, Zone>()
		for (const name of names) {
			const bytes = yield* fs.readFile(`${zoneFiles}/${name}`)
			read.set(name, zoneOf(bytes))
		}
		return read
	})

/**
 * Time.wall on PostgreSQL 19: every probe's wall clock is the TZif reference's over the server's own zone files.
 *
 * Its budget, measured (fastcycle's cull):
 *
 * @limitKind measured
 * @owner test/pg/compute/wall.test.ts, this property's search
 * @unit cases of the rotating stream; the floor stream runs a quarter of them, rounded up
 * @scope one search of this property in one run; the steered phase's cases, its cap, run only while a required
 *   situation is pending
 * @evidence `TEST_SEED=2219874524 pnpm exec toolchain-test kills test/pg/compute/wall.test.ts` at its budget before, `{
 *   runs: 8, steered: 16 }`, each kill's verdict printed with where its witnesses went red (judgedLine with the red's
 *   headline, a local print), in ~/.cache/grizzle-release/CULL-COMPUTE/kills-current.log; this budget run by path in
 *   run-budgets.log there
 * @observed 2026-11-23, 04:00 to 06:00 UTC
 * @environment cassowary, Ubuntu 26.04 on arm64 in AWS, 64 cores and 247 GiB at load 440 to 530; PostgreSQL 19 in
 *   memory (the family grizzle-m-cull-compute); Node 26.13.1; grizzle at dbcb09929 with lane CULL-COMPUTE's cull,
 *   vendor/toolchain at 2cc4817
 * @workload each declared kill applied alone and judged on the property's witnesses: its kept cases, its floor stream
 *   and its steered phase, which no run seed moves
 * @result each of its 2 kills went red on the first case of its floor stream
 * @decision 1, the least a generative search draws, whose floor stream holds that one case; no headroom: a kill its
 *   witnesses stop killing fails the kill gate, which measures it again
 * @revalidate a change of its space, situations, kept cases or kills, of its label (the floor stream's seed), or of the
 *   runner's floor rule
 */
export const timeWallOnPostgreSQL19EveryProbesWallClockIsTheTzifReferencesOverTheServersOwnZoneFiles =
	property.explore(caseGen, {
		needs: { substrate: Substrate.fresh(baseSubstrate) },
		situations: [
			"an instant short of a transition into daylight time",
			"an instant past a transition into daylight time",
			"an instant short of a transition out of daylight time",
			"an instant past a transition out of daylight time",
			"an instant before 1970",
			"an instant of the first Gregorian cycle of the range",
			"an instant of the last Gregorian cycle of the range",
			"a zone of an offset not of whole hours",
			"one of metis's instants",
			"a wall clock before the local epoch within a day of it"
		] satisfies ReadonlyArray<Reached<WallFeature>>,
		check:
			({ substrate }, k: Case<WallFeature>) =>
			(c: WallCase) =>
				Effect.provideServiceEffect(
					Effect.scoped(
						Effect.gen(function* () {
							const generated = yield* installGenerated(
								(name) => {
									const w = wallWorld(name, c.zones)
									return { schema: w.s, logins: [w.world.server] }
								},
								{ label: "walls", ambient: ordinarySession }
							)
							const built = wallWorld(generated.installed.declared, c.zones)
							const db = yield* openServedDb(generated.installed, built.world.server.roles.app, {})
							const served = yield* db.serve(built.programs)
							const read = yield* zonesRead(c.zones)
							const probes = Arr.map(c.probes, (p, id) => {
								const zone = defined(read.get(p.zone), `the file of ${p.zone}`)
								return { id, zone: p.zone, file: zone, at: instantOf(p.at, zone), spec: p.at }
							})
							yield* writeOnce(member(served, "probes"))({
								params: {},
								facts: {
									insert: {
										Probe: Arr.map(probes, (p) => ({ id: p.id, at: p.at, zone: p.zone }))
									}
								}
							})
							const walls = yield* readOnce(member(served, "walls"))({ params: {}, facts: {} })
							const byId = new Map(
								Arr.map(Arr.fromIterable(walls), (row) => [row["id"], row["wall"]] as const)
							)
							for (const p of probes) {
								const expected = wallMillis(p.file, p.at)
								k.noteAll(featuresOf(p.file, p.at, expected, p.spec))
								assert.equal(
									byId.get(p.id),
									expected,
									`the wall clock of ${p.zone} at ${p.at} (${Formatter.format(p.spec)})`
								)
							}
						})
					),
					Substrate,
					Effect.map(substrate, (taken) => taken.substrate)
				),
		oracle: {
			kind: "second-implementation",
			name: "RFC 8536's TZif read over the server's own zone files (test/support/oracle/reference/tzif.ts)"
		},
		show: Formatter.format,
		budget: { runs: 1, steered: 16 },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/physical/ddl/library.ts",
				original: "\tconst offset = offsetAt(utc)",
				replacement:
					'\tconst offset = offsetAt(binary("+", lit.text("1970-01-01", types.date), lit.text("0 seconds", types.interval)))',
				why: "Every instant takes its zone's offset at the Unix epoch, a fixed UTC offset: a probe in daylight time, or of another year's rules, reads the wrong wall clock."
			},
			{
				file: "packages/engine/src/physical/ddl/library.ts",
				original: '\tconst days = binary("/", binary("-", read, intoDay), day)',
				replacement: '\tconst days = binary("/", read, day)',
				why: "The instant's day is taken by truncating division, so an instant before 1970 lies a day late, and one short of a transition reads the offset past it."
			}
		]
	})

/**
 * The SQLSTATE a test install's refused migration statement met: the test install reports a refused apply as a defect
 * whose cause is the MigrateError (test/support/install-migrate.ts applied), its reason StatementFailed with the server's
 * error.
 */
const refusedSqlstate = (defect: unknown): string | undefined => {
	const cause = Predicate.hasProperty(defect, "cause") ? defect.cause : undefined
	return cause instanceof MigrateError &&
		cause.reason._tag === "StatementFailed" &&
		cause.reason.failure._tag === "ServerError"
		? cause.reason.failure.sqlstate
		: undefined
}

/** A zone the server's tzdata names no zone of, in the Area/Location form a zone roster admits. */
const noZone = "Mars/Olympus_Mons"

/**
 * A zone roster beside a zone of the dictionary: one naming a zone the server's tzdata lacks refuses its migration,
 * PostgreSQL's 22023 (time zone not recognized), before anything is installed; one of tzdata's zones alone installs.
 */
const rosterGen: Gen<{ readonly zone: ZoneName; readonly unknown: boolean }> = (s) => ({
	zone: s.draw(element(zones)),
	unknown: s.draw(boolean)
})

/** A zone roster's migration reads each handle as a time zone: one the server's tzdata lacks refuses it with 22023. */
export const aZoneRostersMigrationReadsEachHandleAsATimeZoneOneTheServersTzdataLacksRefusesItWith22023 =
	property.explore(rosterGen, {
		needs: { substrate: Substrate.fresh(baseSubstrate) },
		situations: ["a roster of tzdata's zones installs", "a roster naming no zone is refused"],
		check:
			(
				{ substrate },
				k: Case<"a roster of tzdata's zones installs" | "a roster naming no zone is refused">
			) =>
			(c) =>
				Effect.provideServiceEffect(
					Effect.scoped(
						Effect.gen(function* () {
							const roster: Arr.NonEmptyReadonlyArray<string> = c.unknown
								? [c.zone, noZone]
								: [c.zone]
							const installed = yield* Effect.exit(
								installGenerated(
									(name) => {
										const w = wallWorld(name, roster)
										return { schema: w.s, logins: [w.world.server] }
									},
									{ ambient: ordinarySession, label: "zoned" }
								)
							)
							if (c.unknown) {
								k.note("a roster naming no zone is refused")
								assert.equal(
									Exit.isFailure(installed)
										? refusedSqlstate(Cause.squash(installed.cause))
										: "installed",
									"22023",
									`a roster naming ${noZone} is refused by a statement with 22023`
								)
								return
							}
							k.note("a roster of tzdata's zones installs")
							assert.ok(Exit.isSuccess(installed), `a roster of ${c.zone} installs`)
						})
					),
					Substrate,
					Effect.map(substrate, (taken) => taken.substrate)
				),
		oracle: {
			kind: "specification",
			name: "PostgreSQL's timezone(text, timestamptz) over each handle"
		},
		show: Formatter.format,
		budget: { runs: 4, steered: 4 },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/deploy/diff/diff.ts",
				original: "\t\tthis.zoneChecks()\n",
				replacement: "",
				why: "The migration reads no handle as a time zone: a roster naming one the server lacks installs, and a Time.wall over it raises 22023 at its first read."
			}
		]
	})

/**
 * Time.epochDay and Time.dateOfEpochDay on PostgreSQL 19, on the host and by Hinnant's day count: each date's epoch
 * day, the date of that epoch day, and the date of an integer, drawn inside grizzle's dates and past them, as three
 * generated fields of Days, are one in PostgreSQL's stored row, in the host's evaluation of the row (rowEvaluator) and
 * in the reference calendar (test/support/oracle/reference/calendar.ts), dates before 1970 among them.
 *
 * Its budget, measured (fastcycle's cull):
 *
 * @limitKind measured
 * @owner test/pg/compute/wall.test.ts, this property's search
 * @unit cases of the rotating stream; the floor stream runs a quarter of them, rounded up
 * @scope one search of this property in one run; the steered phase's cases, its cap, run only while a required
 *   situation is pending
 * @evidence `TEST_SEED=2219874524 pnpm exec toolchain-test kills test/pg/compute/wall.test.ts` at its budget before, `{
 *   runs: 6, steered: 12 }`, each kill's verdict printed with where its witnesses went red (judgedLine with the red's
 *   headline, a local print), in ~/.cache/grizzle-release/CULL-COMPUTE/kills-current.log; this budget run by path in
 *   run-budgets.log there
 * @observed 2026-11-23, 04:00 to 06:00 UTC
 * @environment cassowary, Ubuntu 26.04 on arm64 in AWS, 64 cores and 247 GiB at load 440 to 530; PostgreSQL 19 in
 *   memory (the family grizzle-m-cull-compute); Node 26.13.1; grizzle at dbcb09929 with lane CULL-COMPUTE's cull,
 *   vendor/toolchain at 2cc4817
 * @workload each declared kill applied alone and judged on the property's witnesses: its kept cases, its floor stream
 *   and its steered phase, which no run seed moves
 * @result each of its 2 kills went red on the first case of its floor stream
 * @decision 1, the least a generative search draws, whose floor stream holds that one case; no headroom: a kill its
 *   witnesses stop killing fails the kill gate, which measures it again
 * @revalidate a change of its space, situations, kept cases or kills, of its label (the floor stream's seed), or of the
 *   runner's floor rule
 */
export const timeEpochDayAndDateOfEpochDayOnPostgreSQL19AndTheHostAreHinnantsDayCount =
	property.explore(dayCaseGen, {
		needs: { substrate: Substrate.fresh(baseSubstrate) },
		situations: [
			"a date before 1970",
			"a date of 1970 or after",
			"a leap day",
			"an integer epoch day of no date grizzle holds"
		] satisfies ReadonlyArray<Reached<DayFeature>>,
		check:
			({ substrate }, k: Case<DayFeature>) =>
			(probes) =>
				Effect.provideServiceEffect(
					Effect.scoped(
						Effect.gen(function* () {
							const { installed: done } = yield* installGenerated(
								(name) => {
									const days = daysSchema(name)
									return { schema: days.s, logins: [days.world.server] }
								},
								{ ambient: ordinarySession, label: "days" }
							)
							const built = daysSchema(done.schema)
							const evaluate = succeeded(rowEvaluator(built.s), "the days schema compiles")
							const db = yield* openServedDb(done, built.world.server.roles.app, {})
							const served = yield* db.serve(built.programs)
							const rows = Arr.map(probes, (p) => ({ day: dateText(BigInt(p.day)), n: p.n }))
							yield* writeOnce(member(served, "insertDays"))({
								params: {},
								facts: { insert: { Days: rows } }
							})
							const read = yield* readOnce(member(served, "days"))({ params: {}, facts: {} })
							const stored = new Map(
								Arr.map(Arr.fromIterable(read), (row) => [row["day"], row] as const)
							)
							for (const [p, row] of Arr.zip(probes, rows)) {
								const inside = BigInt(p.n) >= firstDay && BigInt(p.n) <= lastDay
								k.note(p.day < 0 ? "a date before 1970" : "a date of 1970 or after")
								if (Str.endsWith("-02-29")(row.day)) {
									k.note("a leap day")
								}
								if (!inside) {
									k.note("an integer epoch day of no date grizzle holds")
								}
								const expected = {
									epoch: BigInt(p.day),
									back: row.day,
									ofN: inside ? dateText(BigInt(p.n)) : "1970-01-01"
								}
								assert.equal(
									daysOfDate(row.day),
									BigInt(p.day),
									`the reference reads ${row.day} back`
								)
								const pgRow = defined(stored.get(row.day), `the stored row of ${row.day}`)
								assert.deepEqual(
									{ epoch: BigInt(String(pgRow["epoch"])), back: pgRow["back"], ofN: pgRow["ofN"] },
									expected,
									`PostgreSQL's fields of ${row.day} and ${p.n}`
								)
								const admitted = succeeded(
									evaluate.admit(built.Days, row),
									`${row.day} is admitted`
								)
								const host = evaluate(built.Days, admitted).generated
								assert.deepEqual(
									{
										epoch: BigInt(String(succeeded(host.epoch, "the host's epoch day"))),
										back: succeeded(host.back, "the host's date of it"),
										ofN: succeeded(host.ofN, "the host's date of the integer")
									},
									expected,
									`the host's fields of ${row.day} and ${p.n}`
								)
							}
						})
					),
					Substrate,
					Effect.map(substrate, (taken) => taken.substrate)
				),
		oracle: {
			kind: "second-implementation",
			name: "Hinnant's days_from_civil and civil_from_days (test/support/oracle/reference/calendar.ts)"
		},
		show: Formatter.format,
		budget: { runs: 1, steered: 12 },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/ir/date.ts",
				original:
					"export const epochDayOf = (date: CalendarDate): number => dayNumber(date) - epochDayNumber",
				replacement:
					"export const epochDayOf = (date: CalendarDate): number => dayNumber(date) - epochDayNumber + (dayNumber(date) < epochDayNumber ? 1 : 0)",
				why: "The host's epoch day of a date before 1970 is one too many, an off-by-one for negative days, so its epoch field differs from PostgreSQL's and the reference's."
			},
			{
				file: "packages/engine/src/lower/conservative/expr/ops.ts",
				original: '\t\t\t\t? binary("-", first, lit.text(unixEpochDate, types.date))',
				replacement: '\t\t\t\t? binary("-", lit.text(unixEpochDate, types.date), first)',
				why: "PostgreSQL's epoch day is the epoch less the date, its sign turned, so every stored epoch field but 1970-01-01's differs from the host's and the reference's."
			}
		]
	})
