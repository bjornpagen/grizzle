/**
 * An anonymous stored canonical relation's table (analysis/derived/canonical.ts), which no role names, is read by
 * exactly the roles that see whole every relation its definition reads (schema/own.ts roleSeesWhole, analysis/schema.ts
 * CheckedSchema serves): its rows are then a function of rows the role sees, so the installation gives the table a
 * whole view, named by its form (names.ts InstallNames canonicalWholeView), owned by the owner and granted SELECT to
 * such a role, whose programs read the table through it in the join's place (physical/ddl/roles.ts addWholeViews,
 * addRole); a role that sees a relation the definition reads narrowed, or not at all, is granted nothing on it, and no
 * role holds anything on the table itself (the installed-catalog checker, test/support/catalog/verify.ts).
 *
 * The box is canonical-grants.fixtures.ts: a Document-local join of a place with its note, imported by a live relation
 * at each link's target, across documents, so the join is stored and anonymous; a full role holding every relation
 * whole, whose program reads the live relation, and a partial role holding the places and the links alone. Each case
 * installs the schema as `grizzle generate` drafts it, loads its places, notes and links, and reads the catalog's
 * privileges on the join's whole view and the full role's program's rows.
 *
 * The oracle is PostgreSQL's: has_table_privilege of each role on the whole view, and the program's rows against the
 * rule restated, a read PostgreSQL would refuse with 42501 were the grant missing. The box, exhausted: three places of
 * two documents, a link to each, and a note at each of a drawn set of them, none to all three.
 *
 * Features: no note at a linked place, notes at some.
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Order, Record as Rec, Result } from "effect"
import { memberCalls } from "#adapter/db/handles.ts"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { isRecord } from "#compiler/core/record.ts"
import {
	builtOf,
	factsOf,
	type GrantsCase,
	grantsCase,
	linkedRows,
	rowText
} from "#test/pg/derived/canonical-grants.fixtures.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { readOnce } from "#test/support/calls.ts"
import { installGenerated, loadMigrated } from "#test/support/install-migrate.ts"
import { member, withServedDb } from "#test/support/served-db.ts"
import { ownerSession, Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"

type GrantsFeature = "no note at a linked place" | "notes at some linked places"

/** Whether `role` holds SELECT on the view named `view`, by the catalog. */
const privilegeQuery = `SELECT pg_catalog.has_table_privilege($1::text, c.oid, 'SELECT')
FROM pg_catalog.pg_class AS c WHERE c.relname = $2::text AND c.relkind = 'v'`

/** An anonymous canonical table is granted to the roles seeing its reads whole, read by their programs, and to no other. */
export const anAnonymousCanonicalTableIsGrantedExactlyToTheRolesThatSeeEveryRelationItReadsWhole =
	property.exhaust(finite(grantsCase), {
		needs: { substrate: Substrate.fresh(baseSubstrate) },
		situations: [
			"no note at a linked place",
			"notes at some linked places"
		] satisfies ReadonlyArray<Reached<GrantsFeature>>,
		check:
			({ substrate }, notes: Case<GrantsFeature>) =>
			(c: GrantsCase) =>
				Effect.provideServiceEffect(
					Effect.gen(function* () {
						notes.note(
							Arr.isReadonlyArrayEmpty(c.notes)
								? "no note at a linked place"
								: "notes at some linked places"
						)
						const generated = yield* installGenerated(
							(name) => {
								const built = builtOf(name)
								return { schema: built.schema, logins: [built.login] }
							},
							{ label: "canonical_grants", ambient: ordinarySession }
						)
						const installed = generated.installed
						const built = builtOf(installed.declared)
						const stored = Arr.filter(
							[...installed.installation.checked.canonical.values()],
							(r) => r.holding.kind === "stored"
						)
						assert.equal(stored.length, 1, "the join, and it alone, is stored")
						const join = defined(stored[0], "the join")
						assert.ok(
							!Rec.has(installed.installation.owned.relations, join.subject.name),
							"the join is anonymous: no derived relation names it"
						)
						const view = identifierOf(identity.canonicalWholeView(join.digest))
						const taken = yield* Substrate
						const owner = yield* taken.session({
							...ownerSession(),
							label: "owner canonical_grants"
						})
						const granted = (role: string) =>
							Effect.map(owner.values(privilegeQuery, [role, view]), (rows) => rows[0]?.[0])
						const full = yield* granted(installed.role(built.full))
						const partial = yield* granted(installed.role(built.partial))
						assert.equal(
							full,
							true,
							"the full role, which sees the places and the notes whole, holds SELECT on the join's whole view"
						)
						assert.equal(
							partial,
							false,
							"the partial role, which sees no note, holds nothing on the join's whole view"
						)
						yield* loadMigrated(installed, factsOf(c))
						yield* withServedDb(
							installed,
							built.login.roles.full,
							{},
							({ ctx: db, loadWithTables }) =>
								Effect.gen(function* () {
									const loaded = yield* loadWithTables(built.programs)
									const answered = yield* Effect.result(
										readOnce(memberCalls(db, member(loaded.members, "linked")))({
											params: {},
											facts: {}
										})
									)
									if (Result.isFailure(answered)) {
										return assert.fail(
											`the full role's program reads the join's table: ${Formatter.format(answered.failure)}`
										)
									}
									assert.deepEqual(
										Arr.sort(
											Arr.map(answered.success, (row) =>
												isRecord(row)
													? rowText({ doc: row["doc"], at: row["at"], v: row["v"] })
													: "not a row"
											),
											Order.String
										),
										[...linkedRows(c)],
										"the full role's program reads each link at its noted target, the join read from its table"
									)
								})
						)
					}).pipe(Effect.scoped),
					Substrate,
					Effect.map(substrate, (taken) => taken.substrate)
				),
		oracle: {
			kind: "specification",
			name: "PostgreSQL's has_table_privilege on the join's table for each role, and the full role's program's rows against the rule restated"
		},
		box: "a Document-local join imported by a live relation across documents, a full role reading it and a partial role seeing no note, a note at each of a drawn set of three linked places",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/schema.ts",
				original:
					'\t\t\t\treturn c?.holding.kind === "stored" && c.subject.reads.every(seesWhole)\n',
				replacement: '\t\t\t\treturn c?.holding.kind === "stored"\n',
				why: "Every role reads every stored canonical relation's table, the partial role, which sees no note, among them: it is granted SELECT on the join's table and reads the notes' values through it."
			},
			{
				file: "packages/engine/src/physical/ddl/roles.ts",
				original: "\tconst anonymous = anonymousTables(checked)\n",
				replacement: "\tconst anonymous = anonymousTables(checked).slice(0, 0)\n",
				why: "No role is granted the whole view of the anonymous table its programs read, so the full role's read of the live relation is refused with 42501 as its executor starts."
			}
		]
	})
