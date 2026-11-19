/**
 * A direct writer through a role that writes by its insert list, on PostgreSQL 19 (physical/ddl/roles.ts
 * grantedPrivileges): the role holds SELECT and INSERT on what it writes and no UPDATE or DELETE anywhere, so its
 * UPDATE or DELETE of any table is refused with 42501, beside a role that states `write` over the same entries.
 *
 * The schema: Stores own a counted family of Items, which add their quantities into their store's stock, both mutable;
 * Shelves (immutable) own an ordered family of Slots; Tickets stand alone. Roles: `appender` inserts into Item, Slot
 * and Ticket, each whole; `editor` writes the same entries by its write list, the control; `filer` inserts into Store
 * whole, a mutable table, and into Ticket through AllTickets, a query entry holding every row.
 *
 * A case draws probes, each a role and a statement on a table, sent under the role (SET LOCAL ROLE in the owner's
 * session, rolled back), each reading and writing no row, so PostgreSQL judges its privileges alone: a SELECT of the
 * key, an INSERT of the key from no row, an UPDATE of a payload field or of an owner's count to itself, and a DELETE,
 * each WHERE false. The oracle is the rule restated: a role selects what it writes and the family columns of an owner
 * whose member it writes; inserts into what it writes; and, by its write list alone, deletes from what it writes and
 * updates a mutable table it writes whole, or a mutable owner's count whose member it writes. A statement the rule
 * refuses is refused with 42501, and every other returns no row.
 *
 * Features: each role's probes of each statement kind, admitted and refused.
 */

import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option } from "effect"
import { quoteIdent } from "#compiler/sql/print.ts"
import {
	allowed,
	asRole,
	type Built,
	countOf,
	type Feature,
	holdsOwner,
	insertedOf,
	inserts,
	isOwner,
	keyOf,
	payloadOf,
	type Probe,
	probesGen,
	type RoleName,
	type Table,
	versionOf,
	ways
} from "#test/pg/physical/insert-grants.fixtures.ts"
import { assert, defined } from "#test/support/assert.ts"
import { migrated, type Version } from "#test/support/installed.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"

/**
 * A direct writer through an insert role is refused every UPDATE and DELETE, where the write role is refused only what it lacks.
 *
 * Its pre-conversion budget: runs 48, coverage cases 64 (test/pg/physical/insert-grants.test.ts at d8eed1786).
 */
export const aDirectWriterThroughAnInsertRoleIsRefusedEveryUPDATEAndDELETEWhereTheWriteRoleIsRefusedOnlyWhatItLacks =
	property.explore(probesGen, {
		needs: { substrate2: Substrate.installing },
		situations: [
			"an insert role refused an UPDATE",
			"an insert role refused a DELETE",
			"an insert role refused a recount",
			"an insert role inserts",
			"an insert role selects an owner's family columns",
			"the write role updates",
			"the write role deletes",
			"the write role recounts",
			"a role refused a table it does not hold"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check:
			({ substrate2 }, c: Case<Feature>) =>
			(probes) =>
				Effect.provideServiceEffect(
					Effect.gen(function* () {
						let built: Built | undefined
						const substrate = yield* Substrate
						const m = yield* migrated({
							label: "insert_grants",
							schemaName: { kind: "unique" },
							first: (name: string): Version => {
								built = versionOf(name)
								return { schema: built.schema, logins: [built.login] }
							},
							later: [],
							apply: { kind: "noPlaceholders" },
							declared: () => noDeclarations,
							observe: Option.none()
						})
						const b = defined(built, "the version")
						const names = namesOf(m)
						const tableOf = (t: Table): string => names.table(b.relations[t])
						const column = (t: Table, field: string): string =>
							quoteIdent(names.columnIdent({ name: t }, field))
						const roleOf = (r: RoleName): string =>
							defined(
								Arr.findFirst(
									Arr.flatMap(m.installation.worlds, (l) => l.roles),
									(x) => x.name === r
								).pipe(Option.getOrUndefined),
								`the role ${r}`
							).role
						const sqlOf = (p: Probe): string => {
							const table = tableOf(p.table)
							const key = column(p.table, keyOf[p.table])
							switch (p.statement) {
								case "select":
									return `SELECT ${key} FROM ${table} WHERE false`
								case "insert": {
									const inserted = column(p.table, insertedOf[p.table])
									return `INSERT INTO ${table} (${inserted}) SELECT ${inserted} FROM ${table} WHERE false`
								}
								case "update": {
									const payload = column(p.table, payloadOf[p.table])
									return `UPDATE ${table} SET ${payload} = ${payload} WHERE false`
								}
								case "recount": {
									const count = column(
										p.table,
										isOwner(p.table) ? countOf[p.table] : keyOf[p.table]
									)
									return `UPDATE ${table} SET ${count} = ${count} WHERE false`
								}
								case "delete":
									return `DELETE FROM ${table} WHERE false`
							}
						}
						const owner = yield* substrate.session({
							...ownerSession(),
							label: "insert grants owner"
						})

						for (const p of probes) {
							const sql = sqlOf(p)
							const got = yield* asRole(owner, roleOf(p.role), sql)
							const may = allowed(p.role, p.table, p.statement)
							assert.deepEqual(
								got,
								may ? { rows: 0 } : { refused: "42501" },
								`${p.role} ${may ? "may send" : "is refused"}: ${sql}`
							)
							const holds = ways[p.role][p.table] !== "none" || holdsOwner(p.role, p.table)
							if (!holds) {
								c.note("a role refused a table it does not hold")
							} else if (inserts[p.role]) {
								if (p.statement === "update") {
									c.note("an insert role refused an UPDATE")
								} else if (p.statement === "delete") {
									c.note("an insert role refused a DELETE")
								} else if (p.statement === "recount") {
									c.note("an insert role refused a recount")
								} else if (p.statement === "insert" && may) {
									c.note("an insert role inserts")
								} else if (p.statement === "select" && holdsOwner(p.role, p.table)) {
									c.note("an insert role selects an owner's family columns")
								}
							} else if (may && p.statement === "update") {
								c.note("the write role updates")
							} else if (may && p.statement === "delete") {
								c.note("the write role deletes")
							} else if (may && p.statement === "recount") {
								c.note("the write role recounts")
							}
						}
					}),
					Substrate,
					substrate2
				),
		oracle: {
			kind: "specification",
			name: "the insert list's rule: SELECT and INSERT on what it writes, never UPDATE or DELETE"
		},
		budget: { runs: 48, steered: 64 },
		kept: [],
		kills: []
	})
