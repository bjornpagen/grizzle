/**
 * The migration that creates a materialized view populates it (deploy/diff/diff.ts view, structure.refresh), on
 * PostgreSQL 19: a view created WITH NO DATA is unreadable, every read refused with 55000, until a refresh, so a
 * migration that left one unpopulated would leave the application's readers failing until a caller refreshed it.
 *
 * - **Property:** a history of the schema of Ones and Twos over T and Fives over Ones (view-identity.fixtures.ts), its
 *   second version changing nothing or Ones', Twos' or Fives' definition, each version migrated by the runner: after
 *   each migrate, every materialized view the target declares is populated (pg_class.relispopulated), the views the
 *   first creates, those the second creates again and those it keeps.
 * - **Oracle:** specification. Every view of the target's manifest, populated.
 * - **Kill:** a view created with no refresh.
 * - **Features:** the first version, and each second version.
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { element, finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { applyOnSession } from "#adapter/migrate/apply.ts"
import type { GenerateResult } from "#compiler/deploy/render/generate.ts"
import type { DeploySnapshot } from "#compiler/deploy/snapshot/types.ts"
import { printObjectName } from "#compiler/sql/print.ts"
import {
	kept,
	openMigrator,
	parsedTarget,
	reviewedSource,
	statementRows
} from "#test/pg/migrate/support.ts"
import { firstCodes } from "#test/support/compile.ts"
import { atName } from "#test/support/kernel/naming.ts"
import { draftChain, fromEmpty, noDeclarations } from "#test/support/migrate/kit.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"
import { type Change, schemaOf } from "#test/unit/deploy/view-identity.fixtures.ts"

/** What the second version changes: nothing, or one view's definition. */
const changes = ["none", "Ones", "Twos", "Fives"] as const satisfies ReadonlyArray<Change>

type Feature = "the first version" | `the second version: ${(typeof changes)[number]}`

/** Each materialized view of `snapshot`'s manifest, qualified. */
const viewsOf = (snapshot: DeploySnapshot): ReadonlyArray<string> =>
	Arr.flatMap(snapshot.manifest.objects, (o) => {
		const [create] = o.ddl
		return create?.kind === "createStoredTable" ? [printObjectName(create.name)] : []
	})

/** After each migrate, every materialized view the target declares is populated. */
export const everyViewIsPopulatedAfterMigrate = property.exhaust(
	finite((s) => s.draw(element(changes))),
	{
		needs: { caseSubstrate: Substrate.fresh(baseSubstrate) },
		situations: [
			"the first version",
			...Arr.map(changes, (change) => `the second version: ${change}` as const)
		] satisfies ReadonlyArray<Reached<Feature>>,
		check:
			({ caseSubstrate }, c: Case<Feature>) =>
			(change) =>
				Effect.provideServiceEffect(
					Effect.gen(function* () {
						const substrate = yield* Substrate
						const m = yield* openMigrator(substrate, substrate.owner)
						return yield* Effect.scoped(
							Effect.gen(function* () {
								const allocated = yield* substrate.schema({ create: false, label: "populated" })
								const over = {
									schema: atName(allocated),
									extensions: [],
									codes: firstCodes
								}
								const folders: ReadonlyArray<GenerateResult> = draftChain(
									Arr.map(["first", "second"] as const, (version) => ({
										desc: schemaOf(change, version),
										options: over,
										declared: noDeclarations
									})),
									fromEmpty
								)
								const sources = Arr.map(folders, (g) => reviewedSource(g, kept))
								for (const n of [1, 2] as const) {
									const snapshot = defined(folders[n - 1], "a drafted folder").snapshot
									yield* applyOnSession(m, [
										parsedTarget({ snapshot, folders: sources.slice(0, n) })
									])
									const views = viewsOf(snapshot)
									const populated = yield* statementRows(
										m,
										`SELECT c.oid::regclass::text, c.relispopulated::text FROM pg_catalog.pg_class AS c WHERE c.oid IN (${Arr.join(
											Arr.map(views, (_, i) => `$${i + 1}::text::regclass`),
											", "
										)}) ORDER BY 1`,
										views
									)
									assert.equal(populated.length, views.length, "every view the target declares")
									assert.deepEqual(
										Arr.filter(populated, ([, is]) => is !== "true"),
										[],
										`after version ${n}, every view the target declares is populated`
									)
									c.note(n === 1 ? "the first version" : `the second version: ${change}`)
								}
							})
						)
					}),
					Substrate,
					Effect.map(caseSubstrate, (taken) => taken.substrate)
				),
		oracle: {
			kind: "specification",
			name: "every materialized view of the target's manifest, populated after its migrate"
		},
		box: "the schema of Ones and Twos over T and Fives over Ones, migrated through its first version and a second changing nothing or one view's definition",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/deploy/diff/diff.ts",
				original: '\t\t\tthis.sql("structure.refresh", [refreshStatement(v.create.name, false)])\n',
				replacement: "",
				why: "A view the migration creates is left WITH NO DATA, so every read of it is refused until a caller refreshes it."
			}
		]
	}
)
