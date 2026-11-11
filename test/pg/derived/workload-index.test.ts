import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { type Gen, int, subset } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Order, pipe, String as Str } from "effect"
import { planIndexNames } from "#bench/harness/explain.ts"
import { indices } from "#compiler/core/array.ts"
import { identity } from "#compiler/core/identity.ts"
import { trusted } from "#compiler/core/trusted.ts"
import { codeOf } from "#compiler/ir/codes.ts"
import { workload } from "#compiler/program/workload/value.ts"
import { pg, type Uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { printObjectName } from "#compiler/sql/print.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { assert, defined, unorderedEqual } from "#test/support/assert.ts"
import {
	compileTemplate,
	declaredOf,
	paramTexts,
	testCompile,
	workloadOver
} from "#test/support/compile.ts"
import * as W from "#test/support/fixtures/api/work.ts"
import { installMigrated as install, loadMigrated as load } from "#test/support/install-migrate.ts"
import { namesOf, parsedName, parsedSchemaName } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"

/** The account budgets with at least `least` automatic tasks.
 *
 * Workload indexes on a derived relation on PostgreSQL 19.
 *
 * A workload program that reads AccountBudget by a range on its `tasks` column justifies a non-unique index on the
 * `tasks` column, beside the view's key index, which the installation's first migration creates on the materialized
 * view. The index is a plain B-tree on the view, survives a plain refresh and a concurrent one, and serves the
 * program's own optimized statement: over drawn thresholds and accounts made busy inside a transaction, with sequential
 * scans off, PostgreSQL plans the statement through it rather than the key index, and returns the accounts whose
 * automatic tasks number at least the threshold.
 *
 * Plants (main's test phase): derived-workload-index-unique.patch.
 */
const busyAccounts = query(W.Reports).rule((r) => {
	const { account, tasks, budget } = v(W.AccountBudget, "accountBudget")
	return r
		.match(W.AccountBudget, { account, tasks, budget })
		.where(r.ge(tasks, r.param("least", pg.bigint)))
		.find({ account, budget })
})

const id = (n: number): Uuid =>
	`00000000-0000-4000-8000-${pipe(n.toString(16), Str.padStart(12, "0"))}`

/** 300 accounts with one automatic task each: a range on `tasks` from 2 selects only the accounts a case makes busy. */
const accounts = Arr.map(indices(300), (i) => i + 1)
const facts = {
	Account: Arr.map(accounts, (a) => ({ id: id(a), name: `account${a}` })),
	Task: Arr.map(accounts, (a) => ({ id: id(1000 + a), account: id(a), kind: "Automatic" })),
	AutomaticTask: Arr.map(accounts, (a) => ({ task: id(1000 + a), budget: 100n }))
}

/**
 * A case: the least task count the program asks for, and up to three accounts given more automatic tasks inside the
 * case's transaction, so a range on `tasks` from it selects a few rows of 300, which the view's `tasks` index reaches
 * in a few pages where its key index would read them all.
 */
interface BusyCase {
	readonly least: number
	readonly busy: ReadonlyArray<readonly [account: number, more: number]>
}

const busyCaseGen: Gen<BusyCase> = (source) => ({
	least: source.draw(int(2, 5)),
	busy: Arr.map(
		source.draw(subset(accounts, { min: 0, max: 3 })),
		(account) => [account, source.draw(int(1, 4))] as const
	)
})

type BusyFeature =
	| "a busy account selected"
	| "a busy account below the least"
	| "no account selected"

/** Each index of the view as (name, unique, valid, kind of the indexed relation, its key columns joined by commas). */
type IndexRow = readonly [
	name: string,
	unique: string,
	valid: string,
	kind: string,
	columns: string
]

layer(Substrate.layer)("workload indexes on a derived relation", (it) => {
	it.effect(
		"a workload range on a view column is an index on the view that the program's statement uses, through every refresh",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const substrate = yield* Substrate
					const installed = yield* install(W.Reports, {
						ambient: ordinarySession,
						extensions: [
							workloadOver([
								{ login: "server", workloads: [workload(W.Reports, { busyAccounts })] }
							])
						],
						label: "derived_workload",
						logins: []
					})
					const s = installed.declared
					yield* load(installed, facts)
					const owner = yield* substrate.session({ ...ownerSession(), label: "owner" })
					const view = printObjectName(installed.names.relation("AccountBudget"))
					const keyIndex = namesOf(installed).viewKeyIndex(W.AccountBudget, ["account"])
					const names = namesOf(installed)
					const automatic = codeOf(
						defined(
							installed.names.codes.rosters.get(parsedName(W.Kind.name)),
							"the installation's codes of Kind"
						),
						"Automatic"
					)
					const tasksColumn = names.columnIdent(W.AccountBudget, "tasks")
					const indexes = () =>
						Effect.map(
							owner.values(
								`SELECT c.relname::text, i.indisunique::text, i.indisvalid::text, t.relkind::text,
								(SELECT pg_catalog.string_agg(a.attname::text, ',' ORDER BY k.ord)
								 FROM pg_catalog.unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
								 JOIN pg_catalog.pg_attribute AS a ON a.attrelid = i.indrelid AND a.attnum = k.attnum)
							FROM pg_catalog.pg_index AS i JOIN pg_catalog.pg_class AS c ON c.oid = i.indexrelid
							JOIN pg_catalog.pg_class AS t ON t.oid = i.indrelid WHERE i.indrelid = '${view}'::regclass`,
								[]
							),
							(rows) => trusted<ReadonlyArray<IndexRow>>(rows)
						)
					/** The view's key index, unique, and its workload index, a non-unique index on `tasks` alone. */
					const before = yield* indexes()
					assert.ok(
						Arr.some(
							before,
							([name, unique, valid, kind]) =>
								name === keyIndex && unique === "true" && valid === "true" && kind === "m"
						),
						"the view's unique key index"
					)
					const [workloadIndex] = Option.getOrThrowWith(
						Arr.findFirst(
							before,
							([, unique, valid, kind, columns]) =>
								unique === "false" && valid === "true" && kind === "m" && columns === tasksColumn
						),
						() => new Error("the view's non-unique workload index on tasks")
					)
					yield* owner.query(`REFRESH MATERIALIZED VIEW ${view}`, [])
					const options = { ...testCompile, installation: identity.schema(parsedSchemaName(s)) }
					const template = compileTemplate(busyAccounts, undefined, options)
					if (!template.ok) {
						throw new Error(template.error.message)
					}
					const [statement] = template.value.optimized
					if (statement === undefined) {
						throw new Error("one statement")
					}
					return yield* explore(
						{
							suite: "pg/derived/workload-index",
							draw: drawn(busyCaseGen),
							literal: Formatter.format,
							oracle: {
								kind: "second-implementation",
								name: "the accounts whose automatic tasks number at least the least, counted on the host"
							},
							coverage: required<BusyFeature>(
								[
									"a busy account selected",
									"a busy account below the least",
									"no account selected"
								],
								{ cases: 12, sense: notesOnly }
							),
							kept: [],
							runs: 8,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 4,
							caseHang
						},
						(c, k) =>
							Effect.ensuring(
								Effect.gen(function* () {
									yield* owner.begin
									for (const [n, [account, more]] of c.busy.entries()) {
										for (const extra of indices(more)) {
											const task = id(2000 + 10 * n + extra)
											yield* owner.query(
												`INSERT INTO ${names.table(W.Task)} (${names.column(W.Task, "id")}, ${names.column(W.Task, "account")}, ${names.column(W.Task, "kind")}) VALUES ('${task}'::uuid, '${id(account)}'::uuid, ${automatic}::smallint)`,
												[]
											)
											yield* owner.query(
												`INSERT INTO ${names.table(W.AutomaticTask)} (${names.column(W.AutomaticTask, "task")}, ${names.column(W.AutomaticTask, "budget")}) VALUES ('${task}'::uuid, 100)`,
												[]
											)
										}
									}
									yield* owner.query(`REFRESH MATERIALIZED VIEW ${view}`, [])
									yield* owner.query(`REFRESH MATERIALIZED VIEW CONCURRENTLY ${view}`, [])
									const after = yield* indexes()
									unorderedEqual(after, before, "every index survives both refreshes")
									yield* owner.query(`ANALYZE ${view}`, [])
									yield* owner.query("SET LOCAL enable_seqscan = off", [])
									const least = paramTexts(
										statement,
										{ least: BigInt(c.least) },
										declaredOf(template.value, busyAccounts, undefined, options)
									)
									const explained = yield* owner.values(
										`EXPLAIN (FORMAT JSON) ${statement.sql}`,
										least
									)
									assert.ok(
										planIndexNames(explained[0]?.[0]).includes(workloadIndex),
										"the statement reads the view through the workload index"
									)
									const rows = yield* owner.values(statement.sql, least)
									const selected = Arr.flatMap(c.busy, ([account, more]) =>
										1 + more >= c.least ? [id(account)] : []
									)
									assert.deepEqual(
										Arr.sort(
											Arr.map(rows, (r) => String(r[0])),
											Order.String
										),
										Arr.sort(selected, Order.String)
									)
									k.note(selected.length === 0 ? "no account selected" : "a busy account selected")
									if (Arr.some(c.busy, ([, more]) => 1 + more < c.least)) {
										k.note("a busy account below the least")
									}
								}),
								Effect.orDie(owner.rollback)
							)
					)
				})
			)
	)
})
