import { indices } from "@bjornpagen/grizzle-text/base/array"
import { assert, defined, unorderedEqual } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option, Order } from "effect"
import { planIndexNames } from "#bench/harness/explain.ts"
import { identity } from "#compiler/core/identity.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import { trusted } from "#compiler/core/trusted.ts"
import { codeOf } from "#compiler/ir/codes.ts"
import { printObjectName } from "#compiler/sql/print.ts"
import {
	busyAccounts,
	busyCaseGen,
	type BusyFeature,
	id,
	type IndexRow,
	reportsTemplate
} from "#test/pg/derived/workload-index.fixtures.ts"
import { compileTemplate, declaredOf, paramTexts, testCompile } from "#test/support/compile.ts"
import * as W from "#test/support/fixtures/api/work.ts"
import { namesOf, parsedName, parsedSchemaName } from "#test/support/kernel/naming.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"

/**
 * Workload indexes on a derived relation a workload range on a view column is an index on the view that the program's statement uses, through every refresh.
 *
 * Its pre-conversion budget: runs 8, coverage cases 12 (test/pg/derived/workload-index.test.ts at d8eed1786).
 */
export const workloadIndexesOnADerivedRelationAWorkloadRangeOnAViewColumnIsAnIndexOnTheViewThatTheProgramsStatementUsesThroughEveryRefresh =
	property.explore(busyCaseGen, {
		needs: { reports: Substrate.seat(reportsTemplate) },
		situations: [
			"an account selected",
			"an account below the least",
			"an account at the least",
			"no account selected"
		] satisfies ReadonlyArray<Reached<BusyFeature>>,
		check:
			({ reports }, k: Case<BusyFeature>) =>
			(c) =>
				Effect.gen(function* () {
					const { substrate, value: installed } = yield* reports
					const s = installed.declared
					const owner = yield* substrate.session({ ...ownerSession(), label: "owner" })
					const viewName = installed.names.relation("AccountBudget")
					const view = printObjectName(viewName)
					const keyIndex = namesOf(installed).viewKeyIndex(W.AccountBudget, ["account"])
					const keyIndexName = `${quoteIdent(viewName.schema)}.${quoteIdent(keyIndex)}`
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
					const options = { ...testCompile, installation: identity.schema(parsedSchemaName(s)) }
					const template = compileTemplate(busyAccounts, undefined, options)
					if (!template.ok) {
						throw new Error(template.error.message)
					}
					const [statement] = template.value.optimized
					if (statement === undefined) {
						throw new Error("one statement")
					}
					return yield* Effect.ensuring(
						Effect.gen(function* () {
							yield* owner.begin
							for (const [a, more] of c.more.entries()) {
								yield* owner.query(
									`INSERT INTO ${names.table(W.Account)} (${names.column(W.Account, "id")}, ${names.column(W.Account, "name")}) VALUES ('${id(a)}'::uuid, 'account${a}')`,
									[]
								)
								for (const t of indices(1 + more)) {
									const task = id(1000 + 10 * a + t)
									yield* owner.query(
										`INSERT INTO ${names.table(W.Task)} (${names.column(W.Task, "id")}, ${names.column(W.Task, "account")}, ${names.column(W.Task, "kind")}) VALUES ('${task}'::uuid, '${id(a)}'::uuid, ${automatic}::smallint)`,
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
							yield* owner.query(`DROP INDEX ${keyIndexName}`, [])
							yield* owner.query(`ANALYZE ${view}`, [])
							yield* owner.query("SET LOCAL enable_seqscan = off", [])
							const least = paramTexts(
								statement,
								{ least: BigInt(c.least) },
								declaredOf(template.value, busyAccounts, undefined, options)
							)
							const explained = yield* owner.values(`EXPLAIN (FORMAT JSON) ${statement.sql}`, least)
							assert.ok(
								planIndexNames(explained[0]?.[0]).includes(workloadIndex),
								"the statement reads the view through the workload index"
							)
							const rows = yield* owner.values(statement.sql, least)
							const selected = Arr.flatMap(c.more, (more, a) =>
								1 + more >= c.least ? [id(a)] : []
							)
							assert.deepEqual(
								Arr.sort(
									Arr.map(rows, (r) => String(r[0])),
									Order.String
								),
								Arr.sort(selected, Order.String)
							)
							k.note(selected.length === 0 ? "no account selected" : "an account selected")
							if (Arr.some(c.more, (more) => 1 + more < c.least)) {
								k.note("an account below the least")
							}
							if (Arr.some(c.more, (more) => 1 + more === c.least)) {
								k.note("an account at the least")
							}
						}),
						Effect.orDie(owner.rollback)
					)
				}),
		oracle: {
			kind: "second-implementation",
			name: "the accounts whose automatic tasks number at least the least, counted on the host"
		},
		budget: { runs: 8, steered: 12 },
		kept: [],
		kills: []
	})
