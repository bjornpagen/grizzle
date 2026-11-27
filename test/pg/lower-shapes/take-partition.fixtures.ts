/** What take-partition.test.ts reads: its schema, its reads and one case's run. */

import { assert } from "@bjornpagen/testing/assert"
import { element, type Gen, int } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Order } from "effect"
import { identity } from "#compiler/core/identity.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { key, on, relation, schema } from "#compiler/public/schema.ts"
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
	rowsBeside,
	rowsPerPage,
	type StatedDistinct,
	statedDistinct
} from "#test/support/substrate/fill.ts"

const i = pg.integer

/**
 * A ledger shaped as metis's: each child's sittings of its stages, its item sessions at their stages (keyed by child,
 * stage and place too, as edullm's and metis's are), each session's attempts, a score each attempt's snapshot holds, and
 * a score asserted of some, which stands in place of the snapshot's.
 */
const Attempt = relation("Attempt", { child: i, n: i, at: i }, ["child", "n", "at"])
const ItemSession = relation("ItemSession", { child: i, n: i, stage: i }, ["child", "n"])
const Snapshot = relation("Snapshot", { child: i, n: i, at: i, score: i }, ["child", "n", "at"])
const Asserted = relation("Asserted", { child: i, n: i, at: i, score: i }, ["child", "n", "at"])
const Sitting = relation("Sitting", { sitting: i, child: i, stage: i }, ["sitting"])
const Ledger = schema(
	"TakePartition",
	[Attempt, ItemSession, Snapshot, Asserted, Sitting],
	[key(on(ItemSession, "child", "stage", "n"))]
)

/**
 * Each attempt's score in force: the score asserted of it, else its snapshot's where none is, as metis's credit reads
 * an attempt's values in force (a union, one rule an anti-join).
 */
const inForce = query(Ledger)
	.rule((r) => {
		const { child, n, at, score } = v(Asserted, "asserted")
		return r
			.match(Attempt, { child, n, at })
			.match(Asserted, { child, n, at, score })
			.find({ child, n, at, score })
	})
	.rule((r) => {
		const { child, n, at, score } = v(Snapshot, "snapshot")
		return r
			.match(Attempt, { child, n, at })
			.match(Snapshot, { child, n, at, score })
			.where(r.not(Asserted, { child, n, at }))
			.find({ child, n, at, score })
	})

/**
 * A sitting's sessions, each with its latest attempt's score in force attached, as metis's results page reads each
 * session's latest credit: the attachment's child a take of one by the attempts' times, newest first, correlated at
 * the session's child and place, its partition (lower/shapes/take/partition.ts), over the union of the scores in force.
 */
const latestRead = query(Ledger)
	.rule((r) => {
		const { child, n, stage } = v(ItemSession, "session")
		return r
			.match(Sitting, { sitting: r.param("sitting", i), child, stage })
			.match(ItemSession, { child, n, stage })
			.find({ child, n, stage })
	})
	.attach(
		"latest",
		(head) =>
			query(Ledger)
				.rule((r) => {
					const { at, score } = v(inForce, "inForce")
					return r.match(inForce, { child: head.child, n: head.n, at, score }).find({ at, score })
				})
				.orderBy(["at", "desc"])
				.take(1),
		"option"
	)

/** Each child's total score in force. */
const totals = query(Ledger).rule((r) => {
	const { child, n, at, score } = v(inForce, "counted")
	return r.match(inForce, { child, n, at, score }).find({ child, total: r.sum(score) })
})

/** The children of the three greatest totals: a take of no correlation, so of no partition, ranking every child as one. */
const leaders = totals.orderBy(["total", "desc"]).take(3)

/**
 * A child's total where it is one of the leaders, read at the child: the parameter equates a column of the take's rows
 * that is no column of its partition, so it stays above the take, which ranks every child's total first.
 */
const leaderRead = query(Ledger).rule((r) => {
	const { total } = v(leaders, "leader")
	return r.match(leaders, { child: r.param("child", i), total }).find({ total })
})

/** The ledger installed through its first migration, with a reader whose workload's indexes the reads earn. */
export const partitionTemplate = fullWorldTemplate({
	declaredIn: import.meta,
	name: "take partition",
	fixture: Ledger,
	programs: { latestRead, leaderRead },
	label: "take_partition",
	ambient: ordinarySession
})

/**
 * How a case's columns' statistics stand: as the stored rows' counts leave them, or stated each value its own or every
 * row one value (fill.ts statedDistinct), so a plan PostgreSQL's estimates choose is the one those statements lead to.
 */
export type Statistics = "counted" | StatedDistinct

/**
 * A case: the children stored, each with `stages` stages of `sessions` item sessions, each of `attempts` attempts, the
 * latest of every third session asserted; the children stored beside them before the read is explained again; and how
 * the columns' statistics stand.
 */
export interface PartitionCase {
	readonly children: number
	readonly stages: number
	readonly sessions: number
	readonly attempts: number
	readonly more: number
	readonly statistics: Statistics
}

export const partitionGen: Gen<PartitionCase> = (s) => ({
	children: s.draw(int(10, 30)),
	stages: s.draw(int(2, 4)),
	sessions: s.draw(int(12, 24)),
	attempts: s.draw(int(2, 4)),
	more: s.draw(int(60, 160)),
	statistics: s.draw(element<Statistics>(["counted", "unique", "one value"]))
})

export type StageFeature =
	| "beside a few children"
	| "beside many children"
	| "under counted statistics"
	| "under statistics stating each value its own"
	| "under statistics stating every row one value"

export type LeaderFeature = "a leader's total" | "a child no leader"

/**
 * The statements storing children `from` to `to`: child c's sitting of each stage, its item session n at stage n mod
 * `stages`, each with `attempts` attempts, a snapshot score of each, and an asserted score of the latest attempt of
 * every third session; then each table counted as a VACUUM counts it, and its columns' statistics as the case states
 * them. A score grows with its child, so the leaders are the children of the greatest numbers, no two totals tied.
 */
const stored = (
	installed: Installed,
	c: PartitionCase,
	from: number,
	to: number
): ReadonlyArray<string> => {
	const names = namesOf(installed)
	const children = `generate_series(${String(from)}, ${String(to)}) AS g(c)`
	const sessions = `FROM ${children}, generate_series(1, ${String(c.stages * c.sessions)}) AS h(n)`
	const attempts = `${sessions}, generate_series(1, ${String(c.attempts)}) AS a(at)`
	const tables = Arr.map([Attempt, ItemSession, Snapshot, Asserted, Sitting], (t) => names.table(t))
	const statistics = c.statistics
	return [
		`INSERT INTO ${names.table(Sitting)} SELECT c * ${String(c.stages)} + s, c, s FROM ${children}, generate_series(0, ${String(c.stages - 1)}) AS t(s)`,
		`INSERT INTO ${names.table(ItemSession)} SELECT c, n, n % ${String(c.stages)} ${sessions}`,
		`INSERT INTO ${names.table(Attempt)} SELECT c, n, at ${attempts}`,
		`INSERT INTO ${names.table(Snapshot)} SELECT c, n, at, c * 10 + at ${attempts}`,
		`INSERT INTO ${names.table(Asserted)} SELECT c, n, ${String(c.attempts)}, c * 10 + 5 ${sessions} WHERE n % 3 = 0`,
		...Arr.map(tables, countedAsVacuumed),
		...(statistics === "counted" ? [] : Arr.map(tables, (t) => statedDistinct(t, statistics)))
	]
}

/** The case's children `from` to `to` stored (`stored`). */
const store = (
	installed: Installed,
	connection: PgConnection,
	c: PartitionCase,
	from: number,
	to: number
) =>
	Effect.forEach(stored(installed, c, from, to), (sql) => connection.query(sql, []), {
		discard: true
	})

/**
 * The children a latest case stores beside its own before any of them, numbered past every child a case stores, each
 * of one sitting at stage 0 and one item session of one attempt, snapshot and assertion: a store large beside the
 * stage's rows, so PostgreSQL reads each relation the read binds by key through its index under no planner setting
 * (fill.ts rowsBeside), at `probes` probes of each table, the narrowest four integers a row.
 */
const besideChildren = (
	installed: Installed,
	c: PartitionCase,
	probes: number
): ReadonlyArray<string> => {
	const names = namesOf(installed)
	const children = `FROM generate_series(1000000, ${String(1_000_000 + rowsBeside(probes, rowsPerPage(4 * 4)) - 1)}) AS g(c)`
	return [
		`INSERT INTO ${names.table(Sitting)} SELECT c * ${String(c.stages)}, c, 0 ${children}`,
		`INSERT INTO ${names.table(ItemSession)} SELECT c, 1, 1 % ${String(c.stages)} ${children}`,
		`INSERT INTO ${names.table(Attempt)} SELECT c, 1, 1 ${children}`,
		`INSERT INTO ${names.table(Snapshot)} SELECT c, 1, 1, 1 ${children}`,
		`INSERT INTO ${names.table(Asserted)} SELECT c, 1, 1, 1 ${children}`
	]
}

/** The options a case's reads compile with: the test compile's, in the installed schema. */
const optionsOf = (installed: Installed) => ({
	...testCompile,
	installation: identity.schema(parsedSchemaName(installed.declared))
})

/**
 * One case of the latest read in its one transaction, which the case's end rolls back: the children beside
 * (`besideChildren`) stored, then children 1 to `children`, the read of child 1's stage 0 through its sitting explained
 * under no planner setting; then `more` children stored beside them, and the read explained again. Both times it reads
 * no table larger than a probe whole, and its keyed work (test/support/judge.ts keyedReadWork) is at most three times
 * the stage's stored rows, its sitting, its sessions, their attempts, snapshots and assertions: each
 * session's take reads that session's attempts by its key, the union's arms each at it, and the asserted scores one
 * probe a snapshot. A take ranked beside its parents, over the union derived for every child, reads every child's
 * rows; one ranked inside each session over the union derived at the sitting's keys and read beside each session, a
 * CTE no index reads, reads the stage's every attempt once for each of its sessions, past three times its rows from
 * twelve sessions on.
 */
export const runLatest = (
	installed: Installed,
	connection: PgConnection,
	c: PartitionCase,
	k: Case<StageFeature>
) =>
	Effect.gen(function* () {
		const probeCost = yield* probeCostOf((sql) => connection.queryValues(sql, []))
		for (const sql of besideChildren(installed, c, 2 * c.sessions)) {
			yield* connection.query(sql, [])
		}
		yield* store(installed, connection, c, 1, c.children)
		const options = optionsOf(installed)
		const template = succeeded(compileTemplate(latestRead, undefined, options), "the read compiles")
		const [statement, ...others] = template.optimized
		assert.ok(statement !== undefined && others.length === 0, "the read is one statement")
		const params = paramTexts(
			statement,
			{ sitting: c.stages },
			declaredOf(template, latestRead, undefined, options)
		)
		const explained = Effect.map(
			planAsRun(connection.queryValues, statement.sql, params),
			(plan) => ({ work: keyedReadWork(plan, probeCost), wide: wideScans(plan, probeCost) })
		)
		/** The stage's stored rows: its sitting, its sessions, their attempts and snapshots, and at most one assertion each. */
		const own = 1 + c.sessions * (2 + 2 * c.attempts)
		const bound = 3 * own
		const bounded = (children: number) =>
			Effect.map(explained, ({ work, wide }) => {
				assert.deepEqual(
					wide,
					[],
					`${Formatter.format(c)}: the read of child 1's stage beside ${String(children)} children reads no table larger than a probe whole\n${statement.sql}`
				)
				assert.ok(
					work <= bound,
					`${Formatter.format(c)}: the read of child 1's stage beside ${String(children)} children reads ${String(work)} rows, past its bound ${String(bound)} (the stage's ${String(own)})\n${statement.sql}`
				)
			})
		yield* bounded(c.children)
		yield* store(installed, connection, c, c.children + 1, c.children + c.more)
		yield* bounded(c.children + c.more)
		k.note(c.children < 20 ? "beside a few children" : "beside many children")
		k.note(
			c.statistics === "counted"
				? "under counted statistics"
				: c.statistics === "unique"
					? "under statistics stating each value its own"
					: "under statistics stating every row one value"
		)
	})

/**
 * The leaders' totals as a second implementation computes them, in plain SQL over the stored tables: each attempt's
 * score in force, each child's total, the three greatest (a score grows with its child, so no two children's totals
 * tie), and the total of the child `$1` where it is one of them.
 */
const leadersBySql = (installed: Installed): string => {
	const names = namesOf(installed)
	const [attempt, snapshot, asserted] = [
		names.table(Attempt),
		names.table(Snapshot),
		names.table(Asserted)
	]
	const attempted = (row: string) =>
		`EXISTS (SELECT FROM ${attempt} AS a WHERE a.child = ${row}.child AND a.n = ${row}.n AND a.at = ${row}.at)`
	return Arr.join(
		[
			`WITH f AS (SELECT s.child, s.n, s.at, s.score FROM ${asserted} AS s WHERE ${attempted("s")}`,
			`UNION SELECT s.child, s.n, s.at, s.score FROM ${snapshot} AS s WHERE ${attempted("s")}`,
			`AND NOT EXISTS (SELECT FROM ${asserted} AS x WHERE x.child = s.child AND x.n = s.n AND x.at = s.at)),`,
			"t AS (SELECT child, sum(score) AS total FROM f GROUP BY child ORDER BY total DESC LIMIT 3)",
			"SELECT total::text FROM t WHERE child = $1::integer"
		],
		" "
	)
}

/**
 * One case of the leaders' read in its one transaction: children 1 to `children` stored, the read of a child's total
 * among the leaders, the greatest child's (a leader's) or child 1's (no leader's), equal to the second implementation's
 * (leadersBySql). Restricted below the take, the parameter would rank its own child's total alone, child 1 then a
 * leader of one.
 */
export const runLeaders = (
	installed: Installed,
	connection: PgConnection,
	c: PartitionCase,
	k: Case<LeaderFeature>
) =>
	Effect.gen(function* () {
		yield* store(installed, connection, c, 1, c.children)
		const options = optionsOf(installed)
		const template = succeeded(compileTemplate(leaderRead, undefined, options), "the read compiles")
		const [statement, ...others] = template.optimized
		assert.ok(statement !== undefined && others.length === 0, "the read is one statement")
		const declared = declaredOf(template, leaderRead, undefined, options)
		for (const child of [c.children, 1]) {
			const read = yield* connection.queryValues(
				statement.sql,
				paramTexts(statement, { child }, declared)
			)
			const expected = yield* connection.queryValues(leadersBySql(installed), [String(child)])
			const texts = (rows: ReadonlyArray<ReadonlyArray<unknown>>) =>
				Arr.sort(
					Arr.map(rows, (row) => String(row[0])),
					Order.String
				)
			assert.deepEqual(
				texts(read),
				texts(expected),
				`${Formatter.format(c)}: child ${String(child)}'s total among the three leaders\n${statement.sql}`
			)
			k.note(child === 1 ? "a child no leader" : "a leader's total")
		}
	})
