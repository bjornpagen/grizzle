/**
 * A role's grants are its lists, relation by relation, as PostgreSQL 19's catalog holds them: two roles over the shops
 * schema of test/unit/physical/insert-grants.fixtures.ts (Items counted under Stores, Slots ordered under Shelves, the
 * open Ticket), each writing each relation whole, through a query entry or not at all, each written relation under its
 * insert list or its write list, each owner and Item open or closed, installed through their first migration in a
 * login of their own. A role naming a closed relation under its write list is refused when it is built
 * (insert-grants.test.ts) and installs nowhere; every other is installed.
 *
 * - **The catalog is the rule:** each role's privileges on each table, read from the catalog (has_any_column_privilege
 *   for SELECT, INSERT and UPDATE, a column grant counting as its table's, has_table_privilege for DELETE and
 *   TRUNCATE), are exactly the rule restated over its lists (insert-grants.fixtures.ts rulePrivileges), never read from
 *   grizzle's grant code: SELECT and INSERT on what it writes, UPDATE and DELETE exactly where its write list names it,
 *   SELECT and, under a mutable owner whose member it writes in full (a closed member, or an open one its write list
 *   names), UPDATE on the owner of a family whose member it writes, no TRUNCATE anywhere. So no UPDATE or DELETE stands on a relation under the insert list.
 *   Each installation migrates to its snapshot, the drift check's catalog: an owner the insert list names whole holds
 *   the recount's column UPDATE beside its table grant and no column SELECT, which that grant holds
 *   (physical/ddl/roles.ts OwnerHold).
 * - **PostgreSQL refuses an inserting role's change:** the login, taking on each role, sends an UPDATE of a caller's
 *   field and a DELETE, each matching no row, to every table its insert list names, and PostgreSQL refuses each with
 *   42501, permission denied for the table, before it reads a row.
 *
 * Oracle: PostgreSQL's catalog and its permission check, against the rule restated.
 *
 * Features: an open and a closed relation under the insert list, an open relation under the write list, an owner's
 * recount columns held and an owner held for its reads alone, and each refusal PostgreSQL sends.
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option, String as Str } from "effect"
import type { TablePrivilege } from "#compiler/core/privilege.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import { type AnySchema, login } from "#compiler/public/schema.ts"
import {
	type ModesFeature,
	modesFeatures,
	modesGen,
	privilegeQuery,
	probedField
} from "#test/pg/physical/role-modes.fixtures.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { installGenerated } from "#test/support/install-migrate.ts"
import { pgErrorFields } from "#test/support/substrate/errors.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"
import {
	declarationRefusal,
	type InsertDeclared,
	isOwner,
	memberOf,
	mutableIn,
	roleNames,
	roleOf,
	rulePrivileges,
	schemaOf,
	tablePrivileges,
	written
} from "#test/unit/physical/insert-grants.fixtures.ts"

/** Each role's grants on each table are its lists' as the catalog holds them, and PostgreSQL refuses an inserting role's UPDATE and DELETE. */
export const eachRolesCatalogGrantsAreItsListsRelationByRelationAndPostgreSQLRefusesAnInsertingRolesChange =
	property.explore(modesGen, {
		needs: { substrate: Substrate.fresh(baseSubstrate) },
		/**
		 * Its search budget: each case installs its schema through a migration, so the fewest runs that keep a floor case
		 * and fresh ones and still kill both kills.
		 *
		 * @limitKind measured
		 * @owner test/pg/physical/role-modes.test.ts
		 * @unit cases
		 * @scope one search: `runs` cases of its rotating stream and a quarter of them of its floor stream; `steered` the
		 *   most its steered phase runs while a required situation is unreached
		 * @evidence toolchain-test run and kills of this module at TEST_SEED=2219874524, logs pg1.log and pgkills1.log in
		 *   ~/.cache/grizzle/ROLEMODES-logs on cassowary, uncommitted
		 * @observed 2026-11-24 15:20 to 15:30 UTC
		 * @environment cassowary, grizzle.slice held to 16 CPUs shared with other lanes; this checkout's PostgreSQL 19
		 *   family
		 * @workload its run and its two kills
		 * @result 4 rotating cases, all 7 situations reached in 16 steered cases, verdict in 68 s; 2 of 2 kills killed
		 * @decision runs 4, steered 40: the steered phase stops once every situation is reached, so the cap bounds only a
		 *   run whose situation went unreached
		 * @revalidate a change of its space, situations, check or kills, or of how the runner draws floor and steered cases
		 */
		budget: { runs: 4, steered: 40 },
		situations: modesFeatures satisfies ReadonlyArray<Reached<ModesFeature>>,
		check:
			({ substrate }, c: Case<ModesFeature>) =>
			(m) =>
				Effect.provideServiceEffect(
					Effect.gen(function* () {
						const s = schemaOf(m.mutability, "Shops")
						const declared = Arr.flatMap(roleNames, (name): ReadonlyArray<InsertDeclared> => {
							const rc = name === "clerk" ? m.clerk : m.keeper
							return declarationRefusal(s, rc, m.mutability) === undefined
								? [{ name, role: rc }]
								: []
						})
						if (!Arr.isReadonlyArrayNonEmpty(declared)) {
							return
						}
						const { installed } = yield* installGenerated(
							(name) => {
								const shops = schemaOf(m.mutability, name)
								const roles = Arr.map(declared, (d) => roleOf(shops, d.name, d.role))
								const base: AnySchema = shops
								return { schema: base, logins: [login(base, "desk", roles)] }
							},
							{ ambient: ordinarySession, label: "rolemodes" }
						)
						const world = defined(installed.installation.worlds[0], "the login desk")
						const pgRole = (name: string): string =>
							defined(
								Option.getOrUndefined(Arr.findFirst(world.roles, (r) => r.name === name)),
								`the installed role ${name}`
							).role
						const table = (t: string): string => {
							const named = installed.names.relation(t)
							return `${quoteIdent(named.schema)}.${quoteIdent(named.name)}`
						}
						const sub = yield* Substrate
						for (const d of declared) {
							const { writes, modes } = d.role
							for (const t of [...written, "Open"] as const) {
								const rows = yield* sub.admin.queryValues(privilegeQuery, [
									pgRole(d.name),
									table(t)
								])
								const [select, insert, update, del, truncate] = defined(
									rows[0],
									"the privilege row"
								)
								const held: ReadonlyArray<TablePrivilege> = Arr.filter(
									tablePrivileges,
									(p) =>
										(p === "SELECT"
											? select
											: p === "INSERT"
												? insert
												: p === "UPDATE"
													? update
													: del) === "true"
								)
								assert.deepEqual(
									held,
									rulePrivileges(d, m.mutability, t),
									`${d.name}'s privileges on ${t}, as the catalog holds them, are its lists'`
								)
								assert.equal(truncate, "false", `${d.name} holds no TRUNCATE on ${t}`)
								if (t === "Open" || writes[t] === "none") {
									continue
								}
								c.note(
									modes[t] === "write"
										? "an open relation under the write list"
										: mutableIn(m.mutability, t)
											? "an open relation under the insert list"
											: "a closed relation under the insert list"
								)
								if (
									isOwner(t) &&
									(writes[t] !== "whole" || modes[t] === "insert") &&
									writes[memberOf[t]] !== "none"
								) {
									c.note(
										Arr.some(held, (p) => p === "UPDATE")
											? "an owner's recount columns held"
											: "an owner held for its reads alone"
									)
								}
							}
						}
						const deskLogin = yield* sub.login(world.role)
						const session = yield* sub.session({
							as: { _tag: "Login", credentials: deskLogin },
							role: Option.none(),
							label: "rolemodes desk"
						})
						for (const d of declared) {
							const { writes, modes } = d.role
							for (const t of written) {
								if (writes[t] === "none" || modes[t] === "write") {
									continue
								}
								const column = quoteIdent(installed.names.column(t, probedField[t]))
								const probes = [
									["UPDATE", `UPDATE ${table(t)} SET ${column} = ${column} WHERE false`],
									["DELETE", `DELETE FROM ${table(t)} WHERE false`]
								] as const
								for (const [operation, text] of probes) {
									yield* session.begin
									yield* session.query(`SET LOCAL ROLE ${quoteIdent(pgRole(d.name))}`, [])
									const sent = yield* Effect.result(session.query(text, []))
									yield* session.rollback
									const fields = sent._tag === "Failure" ? pgErrorFields(sent.failure) : undefined
									assert.equal(
										fields?.code,
										"42501",
										`${d.name}'s ${operation} of ${t}, which its insert list names, is refused by PostgreSQL`
									)
									assert.ok(
										Str.startsWith("permission denied for table")(fields?.message ?? ""),
										`refused for the table's privilege: ${fields?.message ?? ""}`
									)
									c.note(
										operation === "UPDATE"
											? "an UPDATE refused by PostgreSQL"
											: "a DELETE refused by PostgreSQL"
									)
								}
							}
						}
					}),
					Substrate,
					Effect.map(substrate, (taken) => taken.substrate)
				),
		oracle: {
			kind: "second-implementation",
			name: "PostgreSQL's catalog and its permission check, against the rule restated"
		},
		kept: [
			{
				token: ReplayToken(
					"test/pg/physical/role-modes.test.ts#eachRolesCatalogGrantsAreItsListsRelationByRelationAndPostgreSQLRefusesAnInsertingRolesChange:-:1.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0"
				),
				reason:
					"the clerk inserts Store, an open owner, and Item, its closed member, both whole: it holds the recount's column UPDATE on Store beside its table SELECT and INSERT, and no column SELECT, which its table grant holds; where the hold granted one, the drift check, which reads no column privilege its table's holds, found the installation 4 facts short of its snapshot (the clerk's column SELECT on Store's id, region, items and stock) and the migration stopped at drift (main 38a1b476)",
				since: "2026-11-26"
			}
		],
		kills: [
			{
				file: "packages/engine/src/physical/ddl/roles.ts",
				original: '\t\t\treturn ["SELECT", "INSERT"]',
				replacement: '\t\t\treturn ["SELECT", "INSERT", "UPDATE", "DELETE"]',
				why: "An entry of the insert list is granted the write list's privileges: the catalog holds UPDATE and DELETE on a table the rule grants neither, and PostgreSQL runs the inserting role's UPDATE."
			},
			{
				file: "packages/engine/src/physical/ddl/roles.ts",
				original:
					"\t\t\t\t\tfull.has(f.member.name) ? [f.count.name, ...endColumns(f).map((c) => c.name)] : []",
				replacement: "\t\t\t\t\t[f.count.name, ...endColumns(f).map((c) => c.name)]",
				why: "A role naming a family's open member under its insert list is granted UPDATE on the mutable owner's recount columns: the catalog holds an UPDATE on the owner the rule grants none."
			},
			{
				file: "packages/engine/src/physical/ddl/roles.ts",
				original:
					'\t\town: owned.get(families[0].owner.name) === "inserted" ? "recounting" : "apart"\n',
				replacement: '\t\town: "apart"\n',
				why: "An owner the role's insert list names whole is held apart, its column SELECT granted beside its table SELECT: the drift check reads no column privilege its table's holds, so the installation is short of its snapshot by each such column and its migration stops at drift."
			}
		]
	})
