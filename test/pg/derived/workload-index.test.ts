import { layer } from "@effect/vitest"
import { Array as Arr, Effect, Option, pipe, Schema, String as Str } from "effect"
import { planIndexNames } from "#bench/harness/explain.ts"
import { identity } from "#compiler/core/identity.ts"
import { workloadExtension } from "#compiler/physical/access/extension.ts"
import { workload } from "#compiler/program/workload/value.ts"
import { pg, type Uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { printObjectName } from "#compiler/sql/print.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { assert } from "#test/support/assert.ts"
import {
	compileTemplate,
	compileTestWorkload,
	paramTexts,
	testCompile
} from "#test/support/compile.ts"
import * as W from "#test/support/fixtures/api/work.ts"
import { installMigrated as install, loadMigrated as load } from "#test/support/install-migrate.ts"
import { namesOf, parsedSchemaName } from "#test/support/kernel/naming.ts"
import { indices } from "#test/support/oracle/pick.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"

/** The account budgets with at least `least` automatic tasks.
 *
 * Workload indexes on a derived relation on PostgreSQL 19.
 *
 * A workload program that reads AccountBudget by a range on its `tasks` column justifies a non-unique index on the
 * `tasks` column, beside the view's key index, which the installation's first migration creates on the materialized
 * view. The index is a plain B-tree on the view, survives the first plain refresh and a later concurrent one, and
 * serves the program's own optimized statement: with sequential scans off, PostgreSQL plans the statement through it
 * rather than the key index, and returns the rows the definition says. */
const busyAccounts = query(W.Reports).rule((r) => {
	const { account, tasks, budget } = v(W.AccountBudget, "accountBudget")
	return r
		.match(W.AccountBudget, { account, tasks, budget })
		.where(r.ge(tasks, r.param("least", pg.bigint)))
		.find({ account, budget })
})

const id = (n: number): Uuid =>
	`00000000-0000-4000-8000-${pipe(n.toString(16), Str.padStart(12, "0"))}`

/** 300 accounts with one automatic task each, and account 1 with three: a range on `tasks` from 3 selects one row of
 * 300, which the view's `tasks` index reaches in a few pages where its key index would read them all. */
const accounts = Arr.map(indices(300), (i) => i + 1)
const taskIds = [...Arr.map(accounts, (a) => 1000 + a), 2001, 2002]
const facts = {
	Account: Arr.map(accounts, (a) => ({ id: id(a), name: `account${a}` })),
	Task: Arr.map(taskIds, (t) => ({
		id: id(t),
		account: id(t > 2000 ? 1 : t - 1000),
		kind: "Automatic"
	})),
	AutomaticTask: Arr.map(taskIds, (t) => ({ task: id(t), budget: 100n }))
}

/** Each index of the view as (name, unique, valid, kind of the indexed relation): catalog rows, decoded. */
const indexRows = Schema.decodeUnknownEffect(
	Schema.Array(Schema.Tuple([Schema.String, Schema.String, Schema.String, Schema.String]))
)

layer(Substrate.layer)("workload indexes on a derived relation", (it) => {
	it.effect(
		"a workload range on a view column is an index on the view that the program's statement uses",
		() =>
			Effect.gen(function* () {
				const substrate = yield* Substrate
				const plan = compileTestWorkload(
					[{ login: "server", workloads: [workload(W.Reports, { busyAccounts })] }],
					W.Reports,
					testCompile
				)
				if (!plan.ok) {
					throw new Error(plan.error.message)
				}
				const installed = yield* install(W.Reports, {
					ambient: ordinarySession,
					extensions: [workloadExtension(plan.value)],
					label: "derived_workload",
					logins: []
				})
				const s = installed.declared
				yield* load(installed, facts)
				const owner = yield* substrate.session({ ...ownerSession(), label: "owner" })
				const view = printObjectName(installed.names.relation("AccountBudget"))
				const keyIndex = namesOf(installed).viewKeyIndex(W.AccountBudget, ["account"])
				const indexes = () =>
					owner
						.values(
							`SELECT c.relname::text, i.indisunique::text, i.indisvalid::text, t.relkind::text
						FROM pg_catalog.pg_index AS i JOIN pg_catalog.pg_class AS c ON c.oid = i.indexrelid
						JOIN pg_catalog.pg_class AS t ON t.oid = i.indrelid WHERE i.indrelid = '${view}'::regclass
						ORDER BY c.relname`,
							[]
						)
						.pipe(Effect.flatMap(indexRows))
				/** The view's two indexes: its key index, unique, and the workload index, its one non-unique index. */
				const before = yield* indexes()
				assert.equal(before.length, 2)
				assert.deepEqual(
					Option.getOrThrowWith(
						Arr.findFirst(before, ([, unique]) => unique === "true"),
						() => new Error("the view's unique key index")
					),
					[keyIndex, "true", "true", "m"]
				)
				const [workloadIndex, ...workloadFlags] = Option.getOrThrowWith(
					Arr.findFirst(before, ([, unique]) => unique === "false"),
					() => new Error("the view's non-unique workload index")
				)
				assert.deepEqual(workloadFlags, ["false", "true", "m"])
				yield* owner.query(`REFRESH MATERIALIZED VIEW ${view}`, [])
				yield* owner.query(`REFRESH MATERIALIZED VIEW CONCURRENTLY ${view}`, [])
				assert.deepEqual(yield* indexes(), before)
				yield* owner.query(`ANALYZE ${view}`, [])
				yield* owner.query("SET enable_seqscan = off", [])
				const template = compileTemplate(busyAccounts, undefined, {
					...testCompile,
					installation: identity.schema(parsedSchemaName(s))
				})
				if (!template.ok) {
					throw new Error(template.error.message)
				}
				const [statement] = template.value.optimized
				if (statement === undefined) {
					throw new Error("one statement")
				}
				const least = paramTexts(statement, { least: 3n })
				const explained = yield* owner.values(`EXPLAIN (FORMAT JSON) ${statement.sql}`, least)
				assert.ok(
					planIndexNames(explained[0]?.[0]).includes(workloadIndex),
					"the statement reads the view through the workload index"
				)
				const rows = yield* owner.values(statement.sql, least)
				yield* owner.query("RESET enable_seqscan", [])
				assert.deepEqual(
					Arr.map(rows, (r) => r[0]),
					[id(1)]
				)
			})
	)
})
