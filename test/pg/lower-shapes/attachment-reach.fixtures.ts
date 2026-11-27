/** What attachment-reach.test.ts reads: its schema, its read and one case's run. */

import { assert } from "@bjornpagen/testing/assert"
import { element, type Gen, int } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import { type PlanNode, planNodes } from "#bench/harness/explain.ts"
import { identity } from "#compiler/core/identity.ts"
import { Num } from "#compiler/public/compute.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { derived, relation, schema } from "#compiler/public/schema.ts"
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
 * A ledger's sittings and item sessions, as qti-pie's holds them: each sitting of a learner's stage; each item session
 * of a learner by its place, of an item at a stage; each item's own control and each learner's stage's control, either
 * of which sets a session's attempt limit; and each session's attempts.
 */
const Sitting = relation("Sitting", { sitting: i, child: i, stage: i }, ["sitting"])
const Session = relation("Session", { child: i, n: i, item: i, stage: i }, ["child", "n"])
const ItemControl = relation("ItemControl", { item: i, limit: i }, ["item"])
const StageControl = relation("StageControl", { child: i, stage: i, limit: i }, ["child", "stage"])
const Attempt = relation("Attempt", { child: i, n: i, at: i }, ["child", "n", "at"])
const Ledger = schema("AttachmentReach", [Sitting, Session, ItemControl, StageControl, Attempt], [])

/**
 * Each item session's control, as qti-pie's ItemSessionControl holds it: its limit by its item's control or by its
 * learner's stage's, a union over every learner's sessions, computed where it is read (no unit holds it, so nothing
 * stores it).
 */
const Control = derived(
	"Control",
	query(Ledger)
		.rule((r) => {
			const { child, n, item, stage } = v(Session, "byItem")
			const { limit } = v(ItemControl, "itemControl")
			return r
				.match(Session, { child, n, item, stage })
				.match(ItemControl, { item, limit })
				.find({ child, n, limit })
		})
		.rule((r) => {
			const { child, n, item, stage } = v(Session, "byStage")
			const { limit } = v(StageControl, "stageControl")
			return r
				.match(Session, { child, n, item, stage })
				.match(StageControl, { child, stage, limit })
				.find({ child, n, limit })
		})
)
const Controlled = schema.extend([Ledger], "AttachmentReachControlled", [Control], [])

/**
 * A sitting's item sessions, at the parameter, each with its control attached and, under the control, the attempts its
 * limit leaves it before its first, read from the control again at the session's key: metis's resume (`sitting`) reads
 * qti-pie's session control so (ledger/session-control.ts sessionControlOf, its `control` with `left` under it). The
 * learner comes of the sitting, so no statement value holds a column of Control.
 */
const sittingRead = query(Controlled)
	.rule((r) => {
		const { child, n, stage } = v(Session, "session")
		return r
			.match(Sitting, { sitting: r.param("sitting", i), child, stage })
			.match(Session, { child, n, stage })
			.find({ child, n })
	})
	.attach(
		"control",
		(head) =>
			query(Controlled)
				.rule((r) => {
					const { limit } = v(Control, "control")
					return r
						.match(Control, { child: head.child, n: head.n, limit })
						.find({ child: head.child, n: head.n, limit })
				})
				.attach(
					"left",
					(control) =>
						query(Controlled).rule((r) => {
							const { limit } = v(Control, "untried")
							return r
								.match(Control, { child: control.child, n: control.n, limit })
								.where(r.gt(limit, 0), r.not(Attempt, { child: control.child, n: control.n }))
								.find({ left: Num.sub(limit, 0) })
						}),
					"array"
				),
		"array"
	)

/** The schema installed through its first migration, with a reader whose workload's indexes the read earns. */
export const reachTemplate = fullWorldTemplate({
	declaredIn: import.meta,
	name: "attachment reach",
	fixture: Controlled,
	programs: { sittingRead },
	label: "attachment_reach",
	ambient: ordinarySession
})

/** How a case's columns' statistics stand: as the stored rows' counts leave them, or stated (fill.ts statedDistinct). */
export type Statistics = "counted" | StatedDistinct

/**
 * A case: the read sitting's `sessions` item sessions, of items 1 to `sessions`; `learners` learners' sittings beside it,
 * each of `beside` sessions; then `more` learners stored beside them before the read is explained again; and how the
 * columns' statistics stand.
 */
export interface ReachCase {
	readonly sessions: number
	readonly learners: number
	readonly beside: number
	readonly more: number
	readonly statistics: Statistics
}

export const reachGen: Gen<ReachCase> = (s) => ({
	sessions: s.draw(int(1, 8)),
	learners: s.draw(int(1, 4)),
	beside: s.draw(int(1, 8)),
	more: s.draw(int(20, 60)),
	statistics: s.draw(element<Statistics>(["counted", "unique", "one value"]))
})

export type ReachFeature =
	| "beside few learners"
	| "beside many learners"
	| "under counted statistics"
	| "under statistics stating each value its own"
	| "under statistics stating every row one value"

/**
 * The statements storing learners `from` to `to` (learner 1 the read sitting's, its sessions `sessions`, every other's
 * `beside`): each learner's sitting, its item sessions at stage 0, its stage's control, an attempt of each even session,
 * and each item's control; then each table counted as a VACUUM counts it, and its columns' statistics as the case states
 * them.
 */
const stored = (
	installed: Installed,
	c: ReachCase,
	from: number,
	to: number
): ReadonlyArray<string> => {
	const names = namesOf(installed)
	const learners = `generate_series(${String(from)}, ${String(to)}) AS g(child)`
	const sessions = `generate_series(1, CASE WHEN child = 1 THEN ${String(c.sessions)} ELSE ${String(c.beside)} END) AS h(n)`
	const tables = Arr.map([Sitting, Session, ItemControl, StageControl, Attempt], (t) =>
		names.table(t)
	)
	const statistics = c.statistics
	return [
		`INSERT INTO ${names.table(Sitting)} SELECT child, child, 0 FROM ${learners}`,
		`INSERT INTO ${names.table(Session)} SELECT child, n, n, 0 FROM ${learners}, ${sessions}`,
		`INSERT INTO ${names.table(StageControl)} SELECT child, 0, 2 FROM ${learners}`,
		`INSERT INTO ${names.table(Attempt)} SELECT child, n, 1 FROM ${learners}, ${sessions} WHERE n % 2 = 0`,
		...(from === 1
			? [
					`INSERT INTO ${names.table(ItemControl)} SELECT item, item % 3 FROM generate_series(1, ${String(Math.max(c.sessions, c.beside))}) AS g(item)`
				]
			: []),
		...Arr.map(tables, countedAsVacuumed),
		...(statistics === "counted" ? [] : Arr.map(tables, (t) => statedDistinct(t, statistics)))
	]
}

/**
 * The learners a case stores beside its own before any of them, numbered past every learner a case stores, each with a
 * sitting, one item session of item 2, its stage's control and an attempt: a store large beside the read sitting's
 * rows, so PostgreSQL reads each relation the read binds by key through its index under no planner setting (fill.ts
 * rowsBeside), at `probes` probes of each table, the narrowest three integers a row.
 */
const besideLearners = (installed: Installed, probes: number): ReadonlyArray<string> => {
	const names = namesOf(installed)
	const learners = `FROM generate_series(1000000, ${String(1_000_000 + rowsBeside(probes, rowsPerPage(3 * 4)) - 1)}) AS g(child)`
	return [
		`INSERT INTO ${names.table(Sitting)} SELECT child, child, 0 ${learners}`,
		`INSERT INTO ${names.table(Session)} SELECT child, 2, 2, 0 ${learners}`,
		`INSERT INTO ${names.table(StageControl)} SELECT child, 0, 2 ${learners}`,
		`INSERT INTO ${names.table(Attempt)} SELECT child, 2, 1 ${learners}`
	]
}

/**
 * The CTEs of a plan each read by one scan: a CTE a statement holds is read at two places at least, since one read alone
 * is printed in place (sql/print-once.ts), and a held one of one read is a tuplestore per row bought for nothing.
 */
const readOnce = (plan: PlanNode): ReadonlyArray<string> => {
	const reads = new Map<string, number>()
	for (const n of planNodes(plan)) {
		if (n.nodeType === "CTE Scan" && Option.isSome(n.cte)) {
			reads.set(n.cte.value, (reads.get(n.cte.value) ?? 0) + 1)
		}
	}
	return Arr.flatMap([...reads], ([name, count]) => (count === 1 ? [name] : []))
}

/**
 * One case in its one transaction, which the case's end rolls back: the learners beside (`besideLearners`) stored, then
 * the read sitting's learner and `learners` beside it, the read of the sitting explained under no planner setting; then
 * `more` learners stored beside them, and the read explained again: it reads no table larger than a probe whole, and
 * its keyed work (test/support/judge.ts keyedReadWork) is no more than before. The sitting's
 * rows are the same, and the control's read and the one under it each read Control at the session's key, each arm a
 * seek of the session and of its control, which no other learner's rows enter; where a control read at its key under
 * the head alone, the read under it unreached, left Control the statement's, every learner's sessions' controls derived
 * whole and scanned once per session, so each learner stored beside adds to the work.
 */
export const runReach = (
	installed: Installed,
	connection: PgConnection,
	c: ReachCase,
	k: Case<ReachFeature>
) =>
	Effect.gen(function* () {
		const probeCost = yield* probeCostOf((sql) => connection.queryValues(sql, []))
		for (const sql of [
			...besideLearners(installed, 2 * c.sessions),
			...stored(installed, c, 1, 1 + c.learners)
		]) {
			yield* connection.query(sql, [])
		}
		const options = {
			...testCompile,
			installation: identity.schema(parsedSchemaName(installed.declared))
		}
		const template = succeeded(
			compileTemplate(sittingRead, undefined, options),
			"the read compiles"
		)
		const [statement, ...others] = template.optimized
		assert.ok(statement !== undefined && others.length === 0, "the read is one statement")
		const params = paramTexts(
			statement,
			{ sitting: 1 },
			declaredOf(template, sittingRead, undefined, options)
		)
		const explained = Effect.map(
			planAsRun(connection.queryValues, statement.sql, params),
			(plan) => {
				const once = readOnce(plan)
				assert.ok(
					once.length === 0,
					`${Formatter.format(c)}: the read holds ${Arr.join(once, ", ")} as a CTE read by one scan\n${statement.sql}`
				)
				return { work: keyedReadWork(plan, probeCost), wide: wideScans(plan, probeCost) }
			}
		)
		const few = yield* explained
		for (const sql of stored(installed, c, 2 + c.learners, 1 + c.learners + c.more)) {
			yield* connection.query(sql, [])
		}
		const many = yield* explained
		assert.deepEqual(
			[...few.wide, ...many.wide],
			[],
			`${Formatter.format(c)}: the read of the sitting reads no table larger than a probe whole\n${statement.sql}`
		)
		assert.ok(
			many.work <= few.work,
			`${Formatter.format(c)}: the read of the sitting reads ${String(few.work)} rows beside ${String(c.learners)} learners and ${String(many.work)} beside ${String(c.learners + c.more)}\n${statement.sql}`
		)
		k.note(c.learners < 3 ? "beside few learners" : "beside many learners")
		k.note(
			c.statistics === "counted"
				? "under counted statistics"
				: c.statistics === "unique"
					? "under statistics stating each value its own"
					: "under statistics stating every row one value"
		)
	})
