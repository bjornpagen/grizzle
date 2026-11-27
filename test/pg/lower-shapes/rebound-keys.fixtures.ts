/** What rebound-keys.test.ts reads: its schema, its read and one case's run. */

import { assert } from "@bjornpagen/testing/assert"
import { element, type Gen, int } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter } from "effect"
import { identity } from "#compiler/core/identity.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { succeeded } from "#test/support/assert.ts"
import { compileTemplate, declaredOf, paramTexts, testCompile } from "#test/support/compile.ts"
import { type Installed } from "#test/support/install-migrate.ts"
import { fullWorldTemplate } from "#test/support/installed.ts"
import { keyedReadWork, planAsRun, probeCostOf, wideScans } from "#test/support/judge.ts"
import { namesOf, parsedSchemaName } from "#test/support/kernel/naming.ts"
import type { PgConnection } from "#test/support/pg.ts"
import {
	countedAsVacuumed,
	misleadingDistinct,
	rowsBeside,
	rowsPerPage
} from "#test/support/substrate/fill.ts"

/** A learner's id as the ledger keys it, a text of a byte bound, as metis's LearnerId. */
const Learner = str.bytes(69, str.regex("^.+$", "su"))

/** A learner's id as the sitting's claim holds it, a text of another refinement, as metis's TimebackUser. */
const Person = str.bytes(1020, str.regex("^.{1,255}$", "su"))

const Name = str.bytes(200, str.regex("^.+$", "su"))

/**
 * A ledger shaped as metis's (lower/shapes/rebound-keys.fixtures.ts): each learner's sitting of a test by its stage,
 * the claim that names it, each presentation of an item in it and the sitting's moments, and the test's items.
 */
const Claim = relation("Claim", { claim: pg.bigint, child: Person, stage: pg.bigint }, ["claim"])
const Session = relation(
	"Session",
	{ child: Learner, stage: pg.bigint, package: Name, path: Name },
	["child", "stage"]
)
const Presented = relation(
	"Presented",
	{ child: Learner, stage: pg.bigint, at: pg.bigint, k: pg.bigint, package: Name, path: Name },
	["child", "stage", "at"]
)
const Moment = relation("Moment", { child: Learner, stage: pg.bigint, at: pg.bigint }, [
	"child",
	"stage",
	"at"
])
const Member = relation("Member", { package: Name, path: Name, item: Name }, [
	"package",
	"path",
	"item"
])

const Ledger = schema("ReboundKeys", [Claim, Session, Presented, Moment, Member], [])

/** Each presentation with the sitting's next moment after it, as metis's presentedSpans. */
const spans = query(Ledger).rule((r) => {
	const { child, stage, at, k, package: pkg, path } = v(Presented, "presented")
	const { at: next } = v(Moment, "next")
	return r
		.match(Presented, { at, child, k, package: pkg, path, stage })
		.match(Moment, { at: next, child, stage })
		.where(r.gt(next, at))
		.find({ at, child, end: r.min(next), k, package: pkg, path, stage })
})

/** Each learner's item's last span end, as metis's ItemDuration over presentedSpans. */
const until = query(Ledger).rule((r) => {
	const { child, stage, at, k, package: pkg, path, end } = v(spans, "span")
	return r
		.match(spans, { at, child, end, k, package: pkg, path, stage })
		.find({ child, package: pkg, path, stage, until: r.max(end) })
})

/**
 * The claimed sitting's items' last span ends: the learner and stage of claim `claim` (the learner first bound at the
 * claim's refinement, as metis's guards bind a sitting's child by the signed-in person), its test's items, and each
 * item's fold read at them, as metis's submit reads ItemDuration at the sitting its call names.
 */
const durations = query(Ledger).rule((r) => {
	const { child, stage } = v(Claim, "claim")
	const { package: pkg, path: test } = v(Session, "session")
	const { item } = v(Member, "member")
	const { until: end } = v(until, "until")
	return r
		.match(Claim, { claim: r.param("claim", pg.bigint), child, stage })
		.match(Session, { child, package: pkg, path: test, stage })
		.match(Member, { package: pkg, path: test, item })
		.match(until, { child, package: pkg, path: item, stage, until: end })
		.find({ child, path: item, until: end })
})

/** The ledger installed through its first migration, with a reader whose workload's indexes the read earns. */
export const durationsTemplate = fullWorldTemplate({
	declaredIn: import.meta,
	name: "rebound keys durations",
	fixture: Ledger,
	programs: { durations },
	label: "rebound_keys",
	ambient: ordinarySession
})

/**
 * The statistics the planner reads of the ledger: what a VACUUM counts, or misleading ones that state every row one
 * learner's and every stage distinct (pg_restore_attribute_stats), so an estimate would read a stage's rows as one
 * learner's and a learner's as every row.
 */
export type Statistics = "counted" | "misleading"

/**
 * A case: the learners stored, every one's sitting at stage 0 of one test of `items` items, each presented once with a
 * moment after it, and the learners stored beside them before the read is explained again.
 */
export interface DurationsCase {
	readonly learners: number
	readonly items: number
	readonly more: number
	readonly statistics: Statistics
}

export const durationsGen: Gen<DurationsCase> = (s) => ({
	learners: s.draw(int(10, 40)),
	items: s.draw(int(2, 6)),
	more: s.draw(int(60, 200)),
	statistics: s.draw(element(["counted", "misleading"] as const))
})

export type DurationsFeature = `${Statistics}, beside ${"a few" | "many"} learners`

/**
 * The learners a case stores beside its own before any of them, numbered past every learner a case stores, each with a
 * claim, a sitting at stage 0 of the test, one presentation of its first item and one moment after it: a store large
 * beside the sitting's rows, so PostgreSQL reads each relation the read binds by key through its index under no planner
 * setting (fill.ts rowsBeside), at `probes` probes of each table, the narrowest a learner's text and two bigints a row.
 */
const besideLearners = (installed: Installed, probes: number): ReadonlyArray<string> => {
	const names = namesOf(installed)
	const learners = `FROM generate_series(1000000, ${String(1_000_000 + rowsBeside(probes, rowsPerPage(4 * 8)) - 1)}) AS g(c)`
	return [
		`INSERT INTO ${names.table(Claim)} SELECT c, 'learner ' || c, 0 ${learners}`,
		`INSERT INTO ${names.table(Session)} SELECT 'learner ' || c, 0, 'package', 'test' ${learners}`,
		`INSERT INTO ${names.table(Presented)} SELECT 'learner ' || c, 0, 10, 1, 'package', 'item 1' ${learners}`,
		`INSERT INTO ${names.table(Moment)} SELECT 'learner ' || c, 0, 15 ${learners}`
	]
}

/** The misleading statistics of `table`'s learner and stage: one learner, every stage distinct (fill.ts misleadingDistinct). */
const misleadingOf = (table: string): ReadonlyArray<string> =>
	misleadingDistinct(table, [
		["child", "1"],
		["stage", "-1"]
	])

/**
 * One case in its one transaction, which the case's end rolls back: learners 1 to `learners` stored, each's claim and
 * sitting at stage 0 of one test, each of its `items` items presented at 10 j with a moment at 10 j + 5, counted as a
 * VACUUM counts them beside the learners a case stores first (`besideLearners`), their learner and stage stated
 * misleading where the case draws it; the read of learner 1's claimed sitting explained under no planner setting; then
 * `more` learners stored beside them alike, and the read explained again. Both times it reads no table larger than a
 * probe whole, and its keyed work (test/support/judge.ts keyedReadWork) is at most three times the sitting's own rows
 * (its claim, its sitting, its test's items, its presentations, and for each presentation the sitting's moments): the
 * folds keyed at the learner, the item and the stage, each presentation's moments read by the learner's key. A fold keyed
 * at the item and the stage alone reads every learner's presentations of the stage, and each one's moments, ten times
 * the bound at least beside many learners.
 */
export const runDurations = (
	installed: Installed,
	connection: PgConnection,
	c: DurationsCase,
	k: Case<DurationsFeature>
) =>
	Effect.gen(function* () {
		const names = namesOf(installed)
		const tables = Arr.map([Claim, Session, Presented, Moment, Member], (t) => names.table(t))
		const stored = (from: number, to: number) => {
			const learners = `FROM generate_series(${String(from)}, ${String(to)}) AS g(c)`
			const presented = `${learners}, generate_series(1, ${String(c.items)}) AS h(j)`
			return [
				`INSERT INTO ${names.table(Claim)} SELECT c, 'learner ' || c, 0 ${learners}`,
				`INSERT INTO ${names.table(Session)} SELECT 'learner ' || c, 0, 'package', 'test' ${learners}`,
				`INSERT INTO ${names.table(Presented)} SELECT 'learner ' || c, 0, 10 * j, 1, 'package', 'item ' || j ${presented}`,
				`INSERT INTO ${names.table(Moment)} SELECT 'learner ' || c, 0, 10 * j + 5 ${presented}`
			]
		}
		const statistics = (): ReadonlyArray<string> => [
			...Arr.map(tables, countedAsVacuumed),
			...(c.statistics === "misleading"
				? Arr.flatMap([Claim, Session, Presented, Moment], (t) => misleadingOf(names.table(t)))
				: [])
		]
		const probeCost = yield* probeCostOf((sql) => connection.queryValues(sql, []))
		for (const sql of [
			`INSERT INTO ${names.table(Member)} SELECT 'package', 'test', 'item ' || j FROM generate_series(1, ${String(c.items)}) AS h(j)`,
			...besideLearners(installed, 2 * c.items + 3),
			...stored(1, c.learners),
			...statistics()
		]) {
			yield* connection.query(sql, [])
		}
		const options = {
			...testCompile,
			installation: identity.schema(parsedSchemaName(installed.declared))
		}
		const template = succeeded(compileTemplate(durations, undefined, options), "the read compiles")
		const [statement, ...others] = template.optimized
		assert.ok(statement !== undefined && others.length === 0, "the read is one statement")
		const params = paramTexts(
			statement,
			{ claim: 1n },
			declaredOf(template, durations, undefined, options)
		)
		const explained = Effect.map(
			planAsRun(connection.queryValues, statement.sql, params),
			(plan) => ({ work: keyedReadWork(plan, probeCost), wide: wideScans(plan, probeCost) })
		)
		/** The sitting's own rows: its claim, its sitting, its test's items, its presentations, and for each the moments. */
		const own = 2 + 2 * c.items + c.items * c.items
		const bound = 3 * own
		const bounded = (learners: number) =>
			Effect.map(explained, ({ work, wide }) => {
				assert.deepEqual(
					wide,
					[],
					`${Formatter.format(c)}: the read of learner 1's sitting beside ${String(learners)} learners reads no table larger than a probe whole\n${statement.sql}`
				)
				assert.ok(
					work <= bound,
					`${Formatter.format(c)}: the read of learner 1's sitting beside ${String(learners)} learners reads ${String(work)} rows, past its bound ${String(bound)} (the sitting's ${String(own)})`
				)
			})
		yield* bounded(c.learners)
		for (const sql of [...stored(c.learners + 1, c.learners + c.more), ...statistics()]) {
			yield* connection.query(sql, [])
		}
		yield* bounded(c.learners + c.more)
		k.note(`${c.statistics}, beside ${c.learners < 25 ? "a few" : "many"} learners`)
	})
