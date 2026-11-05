/**
 * The worked example's plans at volume: every selective workload read is planned through its indexes, and every index the
 * workload creates is read.
 *
 * The file runs with the cluster to itself (`.exclusive`, vitest.network.config.ts): its load at volume is one SERIALIZABLE
 * transaction judged at COMMIT, and SSI retains every transaction that commits meanwhile, which summarizes other files'
 * own.
 *
 * Work installs with its workload's access paths (test/unit/workload/fixtures.ts workPrograms), and the owner loads it at
 * volume in one SERIALIZABLE transaction, every law judged at COMMIT: accounts, tasks alternating automatic and manual
 * over them, each automatic task's budget and each manual task's operator, and a note on every third task; then VACUUM
 * ANALYZE. Each case draws which account, which tasks and which range of names the selective reads ask about, runs
 * every selective read of the workload through the runtime with a counting executor, and EXPLAINs each statement it sent
 * with its parameters (test/support/plans.ts): planned with sequential and index scans disabled, so that a bitmap scan,
 * which reads only by an index condition, is the one scan left, every scan of a relation a statement restricts reads by
 * an index condition on an index the installation planned; and no free plan scans a relation of more than 20,000 rows,
 * neither sequentially nor as a nested loop's inner side without an index condition.
 * Every index the installation created must be read by some free plan of some case.
 *
 * The workload's other reads ask for every fact of a relation (taskPayloads, largestPerAccount, tasksWithoutNotes,
 * assignedTasks, accountCards), so a scan is their plan; they are not run.
 */
import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Layer, pipe, String as Str } from "effect"
import type { TestContext } from "vitest"
import { Db } from "#adapter/public/db.ts"
import { appendAll } from "#compiler/core/array.ts"
import { trusted } from "#compiler/core/trusted.ts"
import { codeOf } from "#compiler/ir/codes.ts"
import { workloadExtension } from "#compiler/physical/access/extension.ts"
import { printObjectName, quoteIdent } from "#compiler/sql/print.ts"
import { installed } from "#test/pg/reads/support.ts"
import { assert, defined } from "#test/support/assert.ts"
import * as W from "#test/support/fixtures/api/work.ts"
import { parsedName } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { pickGen, pickIndex } from "#test/support/pick.ts"
import {
	createdIndexes,
	plannedIndexes,
	recordingReader,
	relationRows,
	sentProblems,
	spread
} from "#test/support/plans.ts"
import { beginSerializable } from "#test/support/substrate/session.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { planOf, workPrograms } from "#test/unit/workload/fixtures.ts"

interface Sizes {
	readonly accounts: number
	/** Even; each task's kind alternates, and every third task has a note. */
	readonly tasks: number
}

/** The entities a case asks about: accounts busiest first, and task ids. */
interface Entities {
	readonly accounts: ReadonlyArray<string>
	readonly tasks: ReadonlyArray<string>
}

type WorkFeature = "a read by a busy account" | "a read by another account"

/** The rows numbered 0 to `rows - 1`, as a FROM clause. */
const series = (rows: number): string => `FROM pg_catalog.generate_series(0, ${rows - 1}) AS s(g)`

/** The name the load gives the account numbered `n`. */
const accountName = (n: number): string => `account ${pipe(String(n), Str.padStart(6, "0"))}`

/** Every selective read of the workload with its parameters for one pick. */
const selectiveReads = (e: Entities, sizes: Sizes, pick: number) => {
	const account = defined(
		e.accounts[pickIndex(pick, 4) === 0 ? 0 : pickIndex(pick, e.accounts.length)],
		"an account with tasks"
	)
	const first = pickIndex(pick, Math.max(1, e.tasks.length - 8))
	const range = pickIndex(pick, Math.floor(sizes.accounts / 10))
	return [
		{ name: "automaticTasksFor", query: W.automaticTasksFor, params: { account } },
		{ name: "automaticBudgetFor", query: W.automaticBudgetFor, params: { account } },
		{ name: "labeledAutomaticTasks", query: W.labeledAutomaticTasks, params: { account } },
		{ name: "taskCards", query: W.taskCards, params: { account } },
		{
			name: "tasksById",
			query: W.tasksById,
			params: { ids: Arr.map(e.tasks.slice(first, first + 8), (id) => ({ id })) }
		},
		{
			name: "accountsByPrefix",
			query: W.accountsByPrefix,
			params: { lo: accountName(range * 10), hi: accountName(range * 10 + 10) }
		}
	]
}

const planSuite = (sizes: Sizes, runs: number) => (ctx: TestContext) =>
	searched(
		ctx,
		Effect.gen(function* () {
			const s = yield* Substrate
			const o = yield* installed(
				W.Work,
				{},
				{ label: "work_plans", extensions: [workloadExtension(planOf(W.Work, workPrograms))] }
			)
			const names = o.installed.names
			const table = (relation: string): string => printObjectName(names.relation(relation))
			const columns = (relation: string, fields: ReadonlyArray<string>): string =>
				Arr.join(
					Arr.map(fields, (f) => quoteIdent(names.column(relation, f))),
					", "
				)
			const kind = defined(names.codes.rosters.get(parsedName("Kind")), "the codes of Kind")
			const load = [
				`INSERT INTO ${table("Account")} (${columns("Account", ["id", "name"])}) ` +
					`SELECT md5('account:' || g)::uuid, 'account ' || lpad(g::text, 6, '0') ${series(sizes.accounts)}`,
				`INSERT INTO ${table("Task")} (${columns("Task", ["id", "account", "kind"])}) ` +
					`SELECT md5('task:' || g)::uuid, md5('account:' || ${spread(1, sizes.accounts)})::uuid, ` +
					`(CASE WHEN g % 2 = 0 THEN ${codeOf(kind, "Automatic")} ELSE ${codeOf(kind, "Manual")} END)::smallint ${series(sizes.tasks)}`,
				`INSERT INTO ${table("AutomaticTask")} (${columns("AutomaticTask", ["task", "budget"])}) ` +
					`SELECT md5('task:' || (2 * g))::uuid, ${spread(2, 10_000)} ${series(sizes.tasks / 2)}`,
				`INSERT INTO ${table("ManualTask")} (${columns("ManualTask", ["task", "operator"])}) ` +
					`SELECT md5('task:' || (2 * g + 1))::uuid, 'operator ' || g ${series(sizes.tasks / 2)}`,
				`INSERT INTO ${table("TaskNote")} (${columns("TaskNote", ["task", "note"])}) ` +
					`SELECT md5('task:' || (3 * g))::uuid, 'note ' || g ${series(Math.floor((sizes.tasks - 1) / 3) + 1)}`
			]
			yield* Effect.onError(
				Effect.gen(function* () {
					yield* s.admin.query(beginSerializable, [])
					for (const statement of load) {
						yield* s.admin.query(statement, [])
					}
					yield* s.admin.query("COMMIT", [])
				}),
				() => Effect.ignore(s.admin.query("ROLLBACK", []))
			)
			for (const r of ["Account", "Task", "AutomaticTask", "ManualTask", "TaskNote"]) {
				yield* s.admin.query(`VACUUM (ANALYZE) ${table(r)}`, [])
			}
			const judge = {
				rows: yield* relationRows(o.installed.schema),
				planned: plannedIndexes(o.installed.installation)
			}
			const column = (relation: string, field: string): string =>
				quoteIdent(names.column(relation, field))
			const busiest = yield* s.admin.queryValues(
				`SELECT ${column("Task", "account")}::text FROM ${table("Task")} GROUP BY 1 ORDER BY count(*) DESC, 1 LIMIT 200`,
				[]
			)
			const tasks = yield* s.admin.queryValues(
				`SELECT ${column("Task", "id")}::text FROM ${table("Task")} ORDER BY 1 LIMIT 400`,
				[]
			)
			const e: Entities = {
				accounts: Arr.map(trusted<ReadonlyArray<readonly [string]>>(busiest), ([a]) => a),
				tasks: Arr.map(trusted<ReadonlyArray<readonly [string]>>(tasks), ([id]) => id)
			}
			const used = new Set<string>()
			const explored = yield* explore(
				{
					suite: `pg/e2e-work/plans ${sizes.tasks}`,
					draw: drawn(pickGen),
					literal: Formatter.format,
					coverage: required<WorkFeature>(
						["a read by a busy account", "a read by another account"],
						{ cases: 10 * runs, sense: notesOnly }
					),
					kept: [],
					runs,
					shrink: completeShrink,
					concurrency: 1,
					/** Windows of four cases, so the steered phase stops within four cases of reaching both reads: every case
					 * plans its reads at volume. */
					steerEvery: 4,
					caseHang
				},
				(pick, cx) =>
					Effect.gen(function* () {
						cx.note(
							pickIndex(pick, 4) === 0 ? "a read by a busy account" : "a read by another account"
						)
						/**
						 * The layer is provided around every use of the Db: its pools end when the layer's scope closes.
						 */
						const db = yield* Db.open(o.server.roles.app, {})
						const { reader, counts } = yield* recordingReader(db)
						const problems: Array<string> = []
						for (const read of selectiveReads(e, sizes, pick)) {
							const before = counts.sent.length
							yield* (yield* reader.execute(read.query, read.params)).collect
							const judged = yield* sentProblems(
								s.admin,
								read.name,
								counts.sent.slice(before),
								judge
							)
							appendAll(problems, judged.problems)
							for (const index of judged.read) {
								used.add(index)
							}
						}
						assert.deepEqual(problems, [], "every selective read is planned through its indexes")
					}).pipe(
						Effect.scoped,
						(body) =>
							Effect.flatMap(Layer.build(o.layer), (context) =>
								Effect.provideContext(body, context)
							),
						Effect.scoped
					)
			)
			const created = yield* createdIndexes(o.installed.schema)
			assert.deepEqual(
				Arr.filter(created, (i) => !used.has(i)),
				[],
				"every index the workload creates is read by a selective read"
			)
			return explored
		})
	)

layer(Substrate.layer)("the worked example's plans at volume", (it) => {
	it.effect(
		"60,000 tasks: every selective read through its indexes, every created index read",
		planSuite({ accounts: 25_000, tasks: 60_000 }, 8)
	)
})
