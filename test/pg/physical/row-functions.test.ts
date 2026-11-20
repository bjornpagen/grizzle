/**
 * Every row function an installation emits passes the installed-catalog checker on PostgreSQL 19 (test/support/catalog
 * installed.ts checkInstallation, which every migrated install runs): a PL/pgSQL function of the columns it reads, in
 * order, IMMUTABLE, not SECURITY DEFINER, owned by the owner, its one SET clause the closed search_path, and EXECUTE held
 * by exactly the writers of the tables whose CHECKs and generated columns call it (verify.ts rowFunction), never judged
 * as a constant, which is an SQL function of no argument and no SET clause.
 *
 * - **Property:** over the row-function boxes (test/unit/physical/row-functions.fixtures.ts: a relation contained in a
 *   closed relation, whose CHECK calls the closed relation's constant; a relation whose CHECK and whose key's selection
 *   match a pattern of a drawn length across inlineLiteralMaxBytes, with and without a generated field), each installed
 *   by the migrator in a database of its own, the checker finds nothing, and the catalog holds every row function the
 *   installation creates.
 * - **Oracle:** specification: the checker's rule for a row function, beside its rule for a constant.
 * - **Features:** a box whose installation creates a row function, and one that creates none.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Order } from "effect"
import { ordinarySession } from "#test/support/ambient.ts"
import { installMigrated } from "#test/support/install-migrate.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"
import { rowCaseGen, rowSchemaOf } from "#test/unit/physical/row-functions.fixtures.ts"

type RowFeature = "a box creating a row function" | "a box creating none"

/** The row functions an installation's catalog holds, by name, as pg_proc lists them in its schema. */
const rowFunctionsSql =
	"SELECT p.proname::text FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = $1 AND p.proname LIKE '\\_\\_row\\_%'"

/** Every row function an installation emits passes the installed-catalog checker, judged as a row function and never as a constant. */
export const everyRowFunctionAnInstallationEmitsPassesTheInstalledCatalogChecker = property.explore(
	rowCaseGen,
	{
		needs: { substrate2: Substrate.installing },
		budget: { runs: 12, steered: 12 },
		situations: ["a box creating a row function", "a box creating none"] satisfies ReadonlyArray<
			Reached<RowFeature>
		>,
		check:
			({ substrate2 }, c: Case<RowFeature>) =>
			(rowCase) =>
				Effect.provideServiceEffect(
					Effect.gen(function* () {
						const substrate = yield* Substrate
						const owner = yield* substrate.session({
							...ownerSession(),
							label: "row functions owner"
						})
						return yield* Effect.scoped(
							Effect.gen(function* () {
								const installed = yield* installMigrated(rowSchemaOf(rowCase), {
									label: "row functions",
									logins: [],
									extensions: [],
									ambient: ordinarySession
								})
								const created = Arr.flatMap(installed.installation.statements, (s) =>
									s.kind === "createConstant" && s.language === "plpgsql" ? [s.name.name] : []
								)
								const held = yield* owner.values(rowFunctionsSql, [
									installed.installation.names.schema
								])
								assert.deepEqual(
									Arr.sort(
										Arr.map(held, (row) => String(row[0])),
										Order.String
									),
									Arr.sort(created, Order.String),
									"the catalog holds every row function the installation creates, each passing the checker"
								)
								c.note(created.length > 0 ? "a box creating a row function" : "a box creating none")
							})
						)
					}),
					Substrate,
					substrate2
				),
		oracle: {
			kind: "specification",
			name: "the installed-catalog checker's rule for a row function (test/support/catalog/verify.ts rowFunction)"
		},
		kept: [],
		kills: [
			{
				file: "test/support/catalog/installed.ts",
				original:
					'\t\t\t\t\t\t: s.kind === "createConstant" && s.language === "plpgsql"\n\t\t\t\t\t\t\t? [[s.name.name, row(s)]]\n',
				replacement:
					'\t\t\t\t\t\t: s.kind === "createConstant" && s.language === "sql-never"\n\t\t\t\t\t\t\t? [[s.name.name, row(s)]]\n',
				why: "The description-built expectation reads a row function as a closed relation's constant, an SQL function of no argument and no SET clause, so the checker refuses every row function grizzle installs."
			},
			{
				file: "test/support/catalog/installed.ts",
				original: '\t\t\t\t\tif (s.language === "plpgsql") {\n',
				replacement: "\t\t\t\t\tif (s.language !== s.language) {\n",
				why: "The installation-built expectation reads a row function as a closed relation's constant, so the checker refuses every row function grizzle installs, as level-checks met at 56f26ca01."
			}
		]
	}
)
