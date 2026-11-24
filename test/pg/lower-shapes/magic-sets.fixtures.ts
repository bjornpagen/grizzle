/** What magic-sets.test.ts reads: its schema, its reads and one case's run. */

import { assert } from "@bjornpagen/testing/assert"
import { type Gen, int } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter } from "effect"
import {
	type PlanNode,
	parsePlan,
	planNodes,
	rowsGenerated,
	rowsRead,
	scannedRows
} from "#bench/harness/explain.ts"
import { identity } from "#compiler/core/identity.ts"
import { compileInstallation } from "#compiler/physical/install/compile.ts"
import { workload } from "#compiler/program/workload/value.ts"
import type { Term } from "#compiler/public/compute.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { key, on, relation, schema } from "#compiler/public/schema.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { succeeded } from "#test/support/assert.ts"
import {
	compileTemplate,
	declaredOf,
	paramTexts,
	testCompile,
	workloadOver
} from "#test/support/compile.ts"
import { type Installed, migratedTemplate, noPlaceholders } from "#test/support/install-migrate.ts"
import { namesOf, parsedSchemaName } from "#test/support/kernel/naming.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"
import type { PgConnection } from "#test/support/pg.ts"
import { countedAsVacuumed } from "#test/support/substrate/fill.ts"

const i = pg.integer

/**
 * A ledger shaped as edullm's: each child's item sessions, each at a stage and keyed by it too (edullm's ItemSession key
 * (child, stage, package, item)), each session's attempts, and each attempt's mark.
 */
const Attempt = relation("Attempt", { child: i, n: i, at: i }, ["child", "n", "at"])
const ItemSession = relation("ItemSession", { child: i, n: i, stage: i }, ["child", "n"])
const Mark = relation("Mark", { child: i, n: i, at: i, score: i }, ["child", "n", "at"])
/**
 * A sitting of one child's stage, by its own number, and when it opened: the stage a read reaches through a stored row,
 * never a parameter.
 */
const Sitting = relation("Sitting", { sitting: i, child: i, stage: i, opened: i }, ["sitting"])
const Ledger = schema(
	"MagicSets",
	[Attempt, ItemSession, Mark, Sitting],
	[key(on(ItemSession, "child", "stage", "n"))]
)

/** Each item session's latest attempt, by its child, its stage and its place: a fold of every attempt stored. */
const latest = query(Ledger).rule((r) => {
	const { child, n, at } = v(Attempt, "attempt")
	const { stage } = v(ItemSession, "session")
	return r
		.match(Attempt, { child, n, at })
		.match(ItemSession, { child, n, stage })
		.find({ child, stage, n, at: r.max(at) })
})

/** The marks of the latest attempts of a head row's child's stage, the attachment both reads read at each head row. */
const marksOf = (head: {
	readonly child: Term<number, unknown, unknown, "integer">
	readonly stage: Term<number, unknown, unknown, "integer">
}) =>
	query(Ledger).rule((r) => {
		const { n, at } = v(latest, "theirs")
		const { score } = v(Mark, "mark")
		return r
			.match(latest, { child: head.child, stage: head.stage, n, at })
			.match(Mark, { child: head.child, n, at, score })
			.find({ n, score })
	})

/**
 * A sitting's stage's latest attempts, each with the marks of its stage's latest attempts attached, as edullm's review
 * reads the latest attempt of each session of its sitting's stage beside each session (reviewOf's LatestAttempt, read
 * by the head at its sitting and by the marks' gradable at each row): the fold read by the head at the child and stage
 * its sitting's row holds and by the attachment at each head row's. The keys are the sitting's stored values, which
 * no parameter fixes.
 */
const sittingRead = query(Ledger)
	.rule((r) => {
		const { child, stage, n, at } = v(latest, "latest")
		const { opened } = v(Sitting, "sitting")
		return r
			.match(Sitting, { sitting: r.param("sitting", i), child, stage, opened })
			.match(latest, { child, stage, n, at })
			.find({ child, stage, n, at, opened })
	})
	.attach("marks", marksOf, "array")

/**
 * A child's stage's latest attempts at the parameters, with the same marks attached: the constant-column pass
 * (lower/optimize/propagate) reads the parameters in place of the head's child and stage, so the attachment's child
 * holds every column of its correlation at a parameter, one key for every head row, the statement's.
 */
const stageRead = query(Ledger)
	.rule((r) => {
		const { child, stage, n, at } = v(latest, "latest")
		return r
			.match(latest, { child, stage, n, at })
			.where(r.eq(child, r.param("child", i)), r.eq(stage, r.param("stage", i)))
			.find({ child, stage, n, at })
	})
	.attach("marks", marksOf, "array")

/** Each read a case runs, by the keys it reads child 1's stage 0 at. */
export type StageRead = "sitting" | "parameters"

/** The ledger installed through its first migration, with a reader whose workload's indexes the read earns. */
export const stageTemplate = migratedTemplate({
	declaredIn: import.meta,
	name: "magic sets stage read",
	content: { schema: Ledger.name, logins: [] },
	versions: [{ schema: Ledger, logins: [], declarations: noDeclarations }],
	options: {
		label: "magic_sets_stage",
		extensions: [
			workloadOver([{ login: "reader", workloads: [workload(Ledger, { sittingRead, stageRead })] }])
		],
		compile: compileInstallation,
		ambient: ordinarySession,
		review: noPlaceholders
	}
})

/**
 * A case: the children stored, each with `stages` stages of `sessions` item sessions, each of `attempts` attempts and
 * their marks, and the children stored beside them before the read is explained again.
 */
export interface StageCase {
	readonly children: number
	readonly stages: number
	readonly sessions: number
	readonly attempts: number
	readonly more: number
}

export const stageGen: Gen<StageCase> = (s) => ({
	children: s.draw(int(10, 40)),
	stages: s.draw(int(4, 8)),
	sessions: s.draw(int(1, 5)),
	attempts: s.draw(int(2, 4)),
	more: s.draw(int(60, 200))
})

export type StageFeature = "beside a few children" | "beside many children"

/**
 * The work of a statement's scans, every loop: the rows each scan of a stored relation reads, each read of a function
 * yields, and each scan of a CTE reads, its output and what its filter removed, where a CTE read at a correlated row's
 * value is scanned whole for each such row.
 */
const work = (plan: PlanNode): number =>
	rowsRead(plan) +
	rowsGenerated(plan) +
	Arr.reduce(
		Arr.filter([...planNodes(plan)], (n) => n.nodeType === "CTE Scan"),
		0,
		(sum, n) => sum + scannedRows(n)
	)

/**
 * One case in its one transaction, which the case's end rolls back: children 1 to `children` stored, child c's sitting
 * of each stage, its item session n at stage n mod `stages`, each with `attempts` attempts and a mark each, counted as a
 * VACUUM counts them; the read of child 1's stage 0 (`by` its sitting, or at the parameters) explained, every read of a
 * stored relation through an index (scans off); then `more` children stored beside them alike, and the read explained
 * again. Both times its scans read at most three times the stage's stored rows, its sitting where the read reaches the
 * stage through it, its sessions, their attempts and marks: the head's fold at the sitting's child and stage (a
 * statement site, one evaluation of the fold LATERAL per key) or at the parameters, and the attachment's at the head's
 * rows, each read the stage's sessions by (child, stage), the chain's lead, and each session's attempts by its key, the
 * attachment each latest attempt's mark by its key, and each CTE row is the key or one of the stage's latest attempts,
 * read at most once by each reader (6 rows a session and 2 an attempt at most, within three times the stage's 1 and 2).
 * Every attempt of the child, its other stages', read first, as an order PostgreSQL's estimates chose did, passes the
 * bound at four stages; a fold derived whole reads every child's rows, ten times at least; and an attachment whose
 * correlation the parameters hold, co-grouped as if no declared-key prefix bound it, joins every mark of the child, its
 * other stages', by the child alone. The bound, not the rows themselves, holds: PostgreSQL plans what it reads of the
 * stage by its estimates, which the children beside move (a mark read by the child, or by its latest attempt's key).
 */
export const runStage = (
	installed: Installed,
	connection: PgConnection,
	c: StageCase,
	k: Case<StageFeature>,
	by: StageRead
) =>
	Effect.gen(function* () {
		const names = namesOf(installed)
		const stored = (from: number, to: number) => {
			const sessions = `FROM generate_series(${String(from)}, ${String(to)}) AS g(c), generate_series(1, ${String(c.stages * c.sessions)}) AS h(n)`
			const attempts = `${sessions}, generate_series(1, ${String(c.attempts)}) AS a(at)`
			return [
				`INSERT INTO ${names.table(Sitting)} SELECT c * ${String(c.stages)} + s, c, s, s FROM generate_series(${String(from)}, ${String(to)}) AS g(c), generate_series(0, ${String(c.stages - 1)}) AS t(s)`,
				`INSERT INTO ${names.table(ItemSession)} SELECT c, n, n % ${String(c.stages)} ${sessions}`,
				`INSERT INTO ${names.table(Attempt)} SELECT c, n, at ${attempts}`,
				`INSERT INTO ${names.table(Mark)} SELECT c, n, at, at * 10 ${attempts}`
			]
		}
		const tables = Arr.map([Attempt, ItemSession, Mark, Sitting], (t) => names.table(t))
		for (const sql of [
			...stored(1, c.children),
			...Arr.map(tables, countedAsVacuumed),
			"SET LOCAL enable_seqscan = off",
			"SET LOCAL enable_bitmapscan = off"
		]) {
			yield* connection.query(sql, [])
		}
		const options = {
			...testCompile,
			installation: identity.schema(parsedSchemaName(installed.declared))
		}
		const read = by === "sitting" ? sittingRead : stageRead
		const template = succeeded(compileTemplate(read, undefined, options), "the read compiles")
		const [statement, ...others] = template.optimized
		assert.ok(statement !== undefined && others.length === 0, "the read is one statement")
		const params = paramTexts(
			statement,
			by === "sitting" ? { sitting: c.stages } : { child: 1, stage: 0 },
			declaredOf(template, read, undefined, options)
		)
		const explained = Effect.map(
			connection.queryValues(
				`EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, SETTINGS, FORMAT JSON) ${statement.sql}`,
				params
			),
			(rows) => work(succeeded(parsePlan(rows[0]?.[0]), "one EXPLAIN plan").plan)
		)
		/** The stage's stored rows: child 1's sitting of stage 0 where the read reaches it, its sessions, their attempts and marks. */
		const own = (by === "sitting" ? 1 : 0) + c.sessions * (1 + 2 * c.attempts)
		const bounded = (children: number) =>
			Effect.map(explained, (scanned) =>
				assert.ok(
					scanned <= 3 * own,
					`${Formatter.format(c)}: the read of child 1's stage beside ${String(children)} children reads ${String(scanned)} rows, more than three times the stage's ${String(own)}`
				)
			)
		yield* bounded(c.children)
		for (const sql of [
			...stored(c.children + 1, c.children + c.more),
			...Arr.map(tables, countedAsVacuumed)
		]) {
			yield* connection.query(sql, [])
		}
		yield* bounded(c.children + c.more)
		k.note(c.children < 25 ? "beside a few children" : "beside many children")
	})
