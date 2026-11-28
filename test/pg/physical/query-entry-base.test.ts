/**
 * A role's query entry is a view over its base: its definition is checked against the base and lowered over it
 * (physical/access/world-views.ts roleWorldViews), so a role whose one entry is a query over a relation it holds none of
 * compiles, installs, and reads the entry's rows through the view, which its owner's rights read behind a security
 * barrier, while the role itself reads that relation nowhere: a read of it over the role is refused as OutsideRole when
 * it compiles (analysis/schema.ts CheckedSchema relation), and PostgreSQL grants the role no SELECT on its table, so a
 * statement of it reading the table is refused with 42501.
 *
 * The box is query-entry-base.fixtures.ts: Secret(k, v) and Kept, a derived relation of its every row, the role `viewer`
 * holding only Seen, every row of Kept, and its login serving a read of Seen. Each case installs the schema as `grizzle generate` drafts it, loads a drawn set of
 * Secret's three rows, reads Seen through the viewer's served Db, compiles a read of Secret over the viewer, and reads
 * the catalog's SELECT privilege of the viewer's role on Secret's table.
 *
 * The oracle is PostgreSQL's: the rows the view returns against Secret's rows, and has_table_privilege, the check that
 * refuses a read with 42501; and the compile's refusal by its kind.
 *
 * Features: an empty Secret, and one of rows.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Order, Result } from "effect"
import { memberCalls } from "#adapter/db/handles.ts"
import { isCompileError } from "#compiler/core/errors.ts"
import { isRecord } from "#compiler/core/record.ts"
import { printObjectName } from "#compiler/sql/print.ts"
import {
	builtOf,
	factsOf,
	rowText,
	type SecretCase,
	secretCase,
	secretRead,
	seenRows
} from "#test/pg/physical/query-entry-base.fixtures.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { readOnce } from "#test/support/calls.ts"
import { installGenerated, loadMigrated } from "#test/support/install-migrate.ts"
import { member, withServedDb } from "#test/support/served-db.ts"
import { ownerSession, Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"

type EntryFeature = "an empty relation behind the entry" | "rows behind the entry"

/** Whether `role` holds SELECT on the table named `table`, by the catalog: the check PostgreSQL refuses a read by. */
const privilegeQuery =
	"SELECT pg_catalog.has_table_privilege($1::text, $2::text::regclass, 'SELECT')"

/** A role's query entry over a relation it does not hold installs and reads its rows; the relation itself stays unread. */
export const aQueryEntryOverARelationItsRoleDoesNotHoldInstallsAndReadsItsRowsWhileTheRoleReadsTheRelationNowhere =
	property.exhaust(finite(secretCase), {
		needs: { substrate: Substrate.fresh(baseSubstrate) },
		situations: [
			"an empty relation behind the entry",
			"rows behind the entry"
		] satisfies ReadonlyArray<Reached<EntryFeature>>,
		check:
			({ substrate }, notes: Case<EntryFeature>) =>
			(c: SecretCase) =>
				Effect.provideServiceEffect(
					Effect.gen(function* () {
						notes.note(
							Arr.isReadonlyArrayEmpty(c.rows)
								? "an empty relation behind the entry"
								: "rows behind the entry"
						)
						const generated = yield* installGenerated(
							(name) => {
								const built = builtOf(name)
								return { schema: built.schema, logins: [built.login] }
							},
							{ label: "query_entry_base", ambient: ordinarySession }
						)
						const installed = generated.installed
						const built = builtOf(installed.declared)
						yield* loadMigrated(installed, factsOf(c))
						yield* withServedDb(
							installed,
							built.login.roles.viewer,
							{},
							({ ctx: db, loadWithTables }) =>
								Effect.gen(function* () {
									const loaded = yield* loadWithTables(built.programs)
									const answered = yield* Effect.result(
										readOnce(memberCalls(db, member(loaded.members, "seen")))({
											params: {},
											facts: {}
										})
									)
									if (Result.isFailure(answered)) {
										return assert.fail(
											`the viewer reads its query entry: ${Formatter.format(answered.failure)}`
										)
									}
									assert.deepEqual(
										Arr.sort(
											Arr.map(answered.success, (row) =>
												isRecord(row) ? rowText({ k: row["k"], v: row["v"] }) : "not a row"
											),
											Order.String
										),
										[...seenRows(c)],
										"the viewer reads every row of Secret through its query entry, which it holds none of"
									)
									const direct = yield* Effect.result(
										loadWithTables({ secret: secretRead(built.viewer) })
									)
									const refusal = Result.isFailure(direct) ? direct.failure : undefined
									const kind =
										refusal !== undefined && "place" in refusal && isCompileError(refusal.error)
											? refusal.error.reason._tag
											: "no compile refusal"
									assert.equal(
										kind,
										"OutsideRole",
										`a read of Secret over the viewer is refused as OutsideRole (${Formatter.format(refusal)})`
									)
								})
						)
						const taken = yield* Substrate
						const owner = yield* taken.session({
							...ownerSession(),
							label: "owner query_entry_base"
						})
						const granted = yield* owner.values(privilegeQuery, [
							installed.role(built.viewer),
							printObjectName(installed.installation.names.relation("Secret"))
						])
						assert.equal(
							granted[0]?.[0],
							false,
							"the viewer's role holds no SELECT on Secret's table, so PostgreSQL refuses its read of it with 42501"
						)
					}).pipe(Effect.scoped),
					Substrate,
					Effect.map(substrate, (taken) => taken.substrate)
				),
		oracle: {
			kind: "specification",
			name: "the rows PostgreSQL's view returns against Secret's rows, has_table_privilege of the viewer's role on Secret's table, and the compile's refusal by its kind"
		},
		box: "Secret(k, v) of a drawn set of three rows, a role whose one entry is a query entry of every row of Secret, and its login serving a read of the entry",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/physical/access/world-views.ts",
				original:
					"\t\t\t\trows: { ...checked.world.base.rows(checked.writable), world: checked.worldRows() }\n",
				replacement: "\t\t\t\trows: checked.rows(checked.writable)\n",
				why: "A query entry's definition lowered over its role's world, which holds none of Kept: the role's compile and its installation refuse the entry as OutsideRole at Kept's definition, though the view, read with its owner's rights, hands the role exactly Kept's rows."
			},
			{
				file: "packages/engine/src/analysis/schema.ts",
				original: '\t\tif (world.kind === "role" && world.base.#held.has(name)) {\n',
				replacement: '\t\tif (world.kind === "role" && !world.base.#held.has(name)) {\n',
				why: "A role's read of a relation of its base it does not hold is no longer refused as outside the role: a program reading Secret over the viewer is refused as no relation of the query's schema, or compiled, where its access is OutsideRole."
			}
		]
	})
