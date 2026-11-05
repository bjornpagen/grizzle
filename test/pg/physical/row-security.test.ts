import { layer } from "@effect/vitest"
import { Array as Arr, Effect, Option, Order } from "effect"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { pg, uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { login, relation, role, schema } from "#compiler/public/schema.ts"
import { assert, defined, unorderedEqual } from "#test/support/assert.ts"
import { checkInstalled, installedScope } from "#test/support/catalog/installed.ts"
import { readCatalog, readCatalogWith } from "#test/support/catalog/read.ts"
import { migrated, type Version, withDb, worldRoleOf } from "#test/support/installed.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"
import { namesOf, parsedSchemaName } from "#test/support/kernel/naming.ts"
import type { RawSession } from "#test/support/substrate/session.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** How clerk writes Note.
 *
 * Row security across migrations on PostgreSQL 19, over Note and Card, each an id and a shelf. `keeper` writes both
 * whole; `clerk` writes Note, through Shelved (the notes on the first shelf, a query entry whose filter fixes the shelf)
 * or whole. The schema migrates from Shelved to whole and back, each folder generated, reviewed and applied by
 * the real runner, which drift-checks the catalog it reaches (`migrated`).
 *
 * Properties, read from the catalog after each migration:
 * - while clerk narrows Note, Note has row security and two policies: clerk's narrowed one and keeper's TRUE one, which
 *   keeps keeper's writes of Note under row security;
 * - once every writer of Note holds every row, Note has neither row security nor a policy: the migration drops both;
 * - Card, which keeper alone writes whole, never has either;
 * - at the last version Db.open admits both roles, and the installed-catalog checker finds nothing.
 */
type ClerkWrite = "narrowed" | "whole"

const steps: Arr.NonEmptyReadonlyArray<ClerkWrite> = ["narrowed", "whole", "narrowed"]

/** The version under the declared name `name`, clerk writing Note as `clerkWrites` says. */
const versionOf = (name: string, clerkWrites: ClerkWrite) => {
	const Note = relation("Note", { id: uuid, shelf: pg.integer }, ["id"])
	const Card = relation("Card", { id: uuid, shelf: pg.integer }, ["id"])
	const base = schema(name, { Note, Card }, [])
	const shelved = query(base).rule((r) => {
		const { id } = v(Note, "note")
		return r.match(Note, { id, shelf: 1 }).find({ id })
	})
	const clerk =
		clerkWrites === "narrowed"
			? role(base, "clerk", { Shelved: shelved }, { write: ["Shelved"] })
			: role(base, "clerk", { Note }, { write: ["Note"] })
	const keeper = role(base, "keeper", { Note, Card }, { write: ["Note", "Card"] })
	return {
		declared: name,
		schema: base,
		Note,
		Card,
		clerk,
		keeper,
		login: login(base, "desk", [clerk, keeper])
	}
}

type Built = ReturnType<typeof versionOf>

/** A policy as the rule judges it: its table, its roles, and whether both its USING and its WITH CHECK admit every
 * row. */
interface PolicySeen {
	readonly table: string
	readonly roles: ReadonlyArray<string>
	readonly holds: "every row" | "narrowed"
}

/** What one version's catalog holds of row security: the tables with it, sorted, and the policies. */
interface Seen {
	readonly rowSecure: ReadonlyArray<string>
	readonly policies: ReadonlyArray<PolicySeen>
}

/** What a version's catalog should hold: row security and both writers' policies on Note exactly while clerk narrows
 * it, and nothing on Card. */
const expectedAt = (clerkWrites: ClerkWrite, b: Built, note: string): Seen => {
	switch (clerkWrites) {
		case "narrowed":
			return {
				rowSecure: [note],
				policies: [
					{ table: note, roles: [worldRoleOf(b.clerk)], holds: "narrowed" },
					{ table: note, roles: [worldRoleOf(b.keeper)], holds: "every row" }
				]
			}
		case "whole":
			return { rowSecure: [], policies: [] }
	}
}

layer(Substrate.layer)("row security across migrations", (it) => {
	it.effect(
		"a narrowing writer keeps every writer's policy, and a migration to writers that all hold every row drops them",
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const substrate = yield* Substrate
					const built: Array<Built> = []
					const version =
						(clerkWrites: ClerkWrite) =>
						(name: string): Version => {
							const b = versionOf(name, clerkWrites)
							built.push(b)
							return { schema: b.schema, logins: [b.login] }
						}
					const seen: Array<Seen> = []
					const [first, ...later] = Arr.map(steps, version)
					const m = yield* migrated({
						label: "row_security",
						schemaName: { kind: "unique" },
						first,
						later,
						apply: { kind: "noPlaceholders" },
						register: true,
						declared: () => noDeclarations,
						observe: Option.some((i: number, owner: RawSession) =>
							Effect.gen(function* () {
								const b = defined(built[i], `version ${i}`)
								const installed = identifierOf(identity.schema(parsedSchemaName(b.declared)))
								const read = yield* readCatalogWith(
									(sql, params) => owner.values(sql, params),
									installed
								)
								assert.ok(read.kind === "present", `the migrated schema ${installed} is absent`)
								seen.push({
									rowSecure: Arr.sort(
										Arr.flatMap(read.catalog.tables, (t): ReadonlyArray<string> =>
											t.rowSecurity ? [t.name] : []
										),
										Order.String
									),
									policies: Arr.map(read.catalog.policies, (p): PolicySeen => ({
										table: p.table,
										roles: p.roles,
										holds:
											Option.exists(p.using, (u) => u === "true") &&
											Option.exists(p.check, (c) => c === "true")
												? "every row"
												: "narrowed"
									}))
								})
							})
						)
					})
					const last = defined(built[built.length - 1], "the last version")
					const note: string = namesOf(m).tableIdent(last.Note)
					assert.equal(seen.length, steps.length, "a reading after each migration")
					for (const [i, clerkWrites] of steps.entries()) {
						const b = defined(built[i], `version ${i}`)
						const at = defined(seen[i], `the reading of version ${i}`)
						const want = expectedAt(clerkWrites, b, note)
						assert.deepEqual(at.rowSecure, want.rowSecure, `the tables under row security at ${i}`)
						unorderedEqual(at.policies, want.policies, `the policies at ${i}`)
					}
					yield* m.reapply
					yield* withDb(m, last.login.roles.clerk, () => Effect.void)
					yield* withDb(m, last.login.roles.keeper, () => Effect.void)
					const read = yield* readCatalog(substrate.admin, m.schema)
					assert.ok(read.kind === "present", `the migrated schema ${m.schema} is absent`)
					assert.deepEqual(
						checkInstalled(read.catalog, installedScope(m.installation, m.snapshot)),
						[]
					)
				})
			)
	)
})
