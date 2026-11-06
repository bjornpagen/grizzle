import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { type Case, exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, DateTime, Effect, Formatter, Layer, String as Str } from "effect"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { trusted } from "#compiler/core/trusted.ts"
import { quoteIdent } from "#compiler/sql/print.ts"
import { defineConfig } from "#index.ts"
import { worlds } from "#test/pg/cli/fixture.ts"
import {
	type CliRun,
	cliOver,
	configName,
	connectionOf,
	ownerOn,
	workspace
} from "#test/pg/cli/support.ts"
import { assert, defined } from "#test/support/assert.ts"
import { loginRoleOf, worldRoleOf } from "#test/support/installed.ts"
import { parsedName, parsedSchemaName } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * `grizzle drift` against a change made by hand to each kind of object a world installs, on PostgreSQL 19, exhausted:
 * drift applies nothing and passes on a fresh installation, and once one object is changed by hand it refuses with
 * Drifted, a mismatch of which names the object; once the change is undone it passes again.
 *
 * The installation is the worlds fixture (fixture.ts): `editor` reads Doc and writes Mine, the notes of the documents
 * its session's subject owns, under row security, through a filter that reads Doc beside Note; `viewer` reads Doc;
 * both in the login `desk`. It is generated and migrated through the command line once, and every case changes one
 * object as the cluster's superuser:
 *
 * - a role's view loses or gains its security barrier;
 * - row security is disabled on a table a role writes under it;
 * - a role's policy is widened to PUBLIC;
 * - a role's function changes its volatility;
 * - a role is granted a privilege the snapshot does not grant;
 * - a role stores a setting;
 * - the login gains an attribute;
 * - a role becomes a member of another;
 * - a table is created in a role's schema.
 */
type Planted =
	| "a view's security barrier"
	| "row security disabled"
	| "a policy widened"
	| "a function's volatility"
	| "a privilege granted"
	| "a role's setting"
	| "a login's attribute"
	| "a membership granted"
	| "a table in a role's schema"

const plantedKinds = [
	"a view's security barrier",
	"row security disabled",
	"a policy widened",
	"a function's volatility",
	"a privilege granted",
	"a role's setting",
	"a login's attribute",
	"a membership granted",
	"a table in a role's schema"
] as const satisfies ReadonlyArray<Planted>

/** A change made by hand: what it does, what undoes it, and the name a mismatch of the drift check must hold. */
interface Change {
	readonly plant: ReadonlyArray<string>
	readonly undo: ReadonlyArray<string>
	readonly named: string
}

/** The installed names a change reaches: the schema, its tables, the roles, and the editor's schema. */
interface Names {
	readonly schema: string
	readonly doc: string
	readonly note: string
	readonly editor: string
	readonly viewer: string
	readonly login: string
	readonly editorSchema: string
}

/** The first row a catalog read of text columns answers, which the installation must hold. */
const first = (rows: ReadonlyArray<ReadonlyArray<unknown>>, what: string): ReadonlyArray<string> =>
	defined(trusted<ReadonlyArray<ReadonlyArray<string>>>(rows)[0], what)

/** Column `i` of a row a catalog read answers. */
const column = (row: ReadonlyArray<string>, i: number): string => defined(row[i], "a column read")

/** The change of `kind`, reading from the catalog what it reaches, as the cluster's superuser. */
const changeOf = (kind: Planted, n: Names) =>
	Effect.gen(function* () {
		const admin = (yield* Substrate).admin
		const table = (name: string) => `${quoteIdent(n.schema)}.${quoteIdent(name)}`
		switch (kind) {
			case "a view's security barrier": {
				const rows = yield* admin.queryValues(
					"SELECT c.relname::text, coalesce(array_to_string(c.reloptions, ','), '') FROM pg_catalog.pg_class AS c JOIN pg_catalog.pg_namespace AS s ON s.oid = c.relnamespace WHERE s.nspname = $1::text AND c.relkind = 'v' ORDER BY 1 LIMIT 1",
					[n.editorSchema]
				)
				const row = first(rows, "a view of the editor")
				const view = column(row, 0)
				const options = column(row, 1)
				const name = `${quoteIdent(n.editorSchema)}.${quoteIdent(view)}`
				const barrier = Str.includes("security_barrier=true")(options)
				const set = `ALTER VIEW ${name} SET (security_barrier = true)`
				const reset = `ALTER VIEW ${name} RESET (security_barrier)`
				const change: Change = barrier
					? { plant: [reset], undo: [set], named: view }
					: { plant: [set], undo: [reset], named: view }
				return change
			}
			case "row security disabled": {
				const change: Change = {
					plant: [`ALTER TABLE ${table(n.note)} DISABLE ROW LEVEL SECURITY`],
					undo: [`ALTER TABLE ${table(n.note)} ENABLE ROW LEVEL SECURITY`],
					named: n.note
				}
				return change
			}
			case "a policy widened": {
				const rows = yield* admin.queryValues(
					"SELECT p.policyname::text, array_to_string(p.roles, ',') FROM pg_catalog.pg_policies AS p WHERE p.schemaname = $1::text AND p.tablename = $2::text ORDER BY 1 LIMIT 1",
					[n.schema, n.note]
				)
				const row = first(rows, "a policy on Note")
				const policy = column(row, 0)
				const to = Arr.join(
					Arr.map(Str.split(column(row, 1), ","), (r) => quoteIdent(r)),
					", "
				)
				const change: Change = {
					plant: [`ALTER POLICY ${quoteIdent(policy)} ON ${table(n.note)} TO ${to}, PUBLIC`],
					undo: [`ALTER POLICY ${quoteIdent(policy)} ON ${table(n.note)} TO ${to}`],
					named: policy
				}
				return change
			}
			case "a function's volatility": {
				const rows = yield* admin.queryValues(
					"SELECT p.oid::regprocedure::text, p.proname::text, p.provolatile::text FROM pg_catalog.pg_proc AS p JOIN pg_catalog.pg_namespace AS s ON s.oid = p.pronamespace WHERE s.nspname = ANY ($1::text[]) AND p.prokind = 'f' AND p.provolatile <> 'i' ORDER BY 2 LIMIT 1",
					[[n.editorSchema, n.schema]]
				)
				const row = first(rows, "a function a world reads")
				const signature = column(row, 0)
				const name = column(row, 1)
				const volatility = column(row, 2)
				const was = volatility === "s" ? "STABLE" : "VOLATILE"
				const now = volatility === "s" ? "VOLATILE" : "STABLE"
				const change: Change = {
					plant: [`ALTER FUNCTION ${signature} ${now}`],
					undo: [`ALTER FUNCTION ${signature} ${was}`],
					named: name
				}
				return change
			}
			case "a privilege granted": {
				const change: Change = {
					plant: [`GRANT DELETE ON ${table(n.doc)} TO ${quoteIdent(n.viewer)}`],
					undo: [`REVOKE DELETE ON ${table(n.doc)} FROM ${quoteIdent(n.viewer)}`],
					named: n.doc
				}
				return change
			}
			case "a role's setting": {
				const change: Change = {
					plant: [`ALTER ROLE ${quoteIdent(n.editor)} SET work_mem = '2MB'`],
					undo: [`ALTER ROLE ${quoteIdent(n.editor)} RESET work_mem`],
					named: "work_mem"
				}
				return change
			}
			case "a login's attribute": {
				const change: Change = {
					plant: [`ALTER ROLE ${quoteIdent(n.login)} CREATEDB`],
					undo: [`ALTER ROLE ${quoteIdent(n.login)} NOCREATEDB`],
					named: n.login
				}
				return change
			}
			case "a membership granted": {
				const change: Change = {
					plant: [`GRANT ${quoteIdent(n.viewer)} TO ${quoteIdent(n.editor)}`],
					undo: [`REVOKE ${quoteIdent(n.viewer)} FROM ${quoteIdent(n.editor)}`],
					named: n.viewer
				}
				return change
			}
			case "a table in a role's schema": {
				const stray = `${quoteIdent(n.editorSchema)}.${quoteIdent("stray_by_hand")}`
				const change: Change = {
					plant: [`CREATE TABLE ${stray} (a int4)`],
					undo: [`DROP TABLE ${stray}`],
					named: "stray_by_hand"
				}
				return change
			}
		}
	})

/** The facts a drift refusal names, none when the command ran or was refused for anything else. */
const mismatchesOf = (ran: CliRun): ReadonlyArray<string> => {
	const report = ran.report
	if (report.outcome !== "refused" || report.refusal._tag !== "CommandRefused") {
		return []
	}
	const reason = report.refusal.error.reason
	return reason._tag === "Drifted" ? Arr.map(reason.mismatches, (m) => `${m.kind} ${m.fact}`) : []
}

const at = DateTime.makeUnsafe({
	year: 2026,
	month: 10,
	day: 12,
	hour: 12,
	minute: 0,
	second: 0,
	millisecond: 0
})

layer(Layer.merge(Substrate.layer, NodeServices.layer))(
	"grizzle drift over a world's objects",
	(it) => {
		it.effect(
			"passes on a fresh installation, refuses a hand change to each kind of world object naming it, and passes once it is undone",
			(ctx) =>
				searched(
					ctx,
					Effect.scoped(
						Effect.gen(function* () {
							const substrate = yield* Substrate
							const name = yield* substrate.schema({ create: false, label: "drift" })
							const w = worlds(name)
							const ws = yield* workspace("drift")
							const config = defineConfig({
								schemas: [w.schema],
								logins: [w.desk],
								migrations: "migrations",
								connection: connectionOf(substrate.cluster, ownerOn(substrate.database))
							})
							const run = (command: string) => cliOver(ws, config, [command, configName], at)
							const fresh = yield* Effect.forEach(["generate", "migrate", "drift"], (command) =>
								Effect.map(run(command), (ran) => ({ command, ran }))
							)
							for (const { command, ran } of fresh) {
								assert.equal(
									ran.code,
									0,
									`grizzle ${command} on a fresh installation: ${ran.stderr}`
								)
							}
							const installation = identity.schema(parsedSchemaName(name))
							const names: Names = {
								schema: identifierOf(installation),
								doc: identifierOf(identity.table(parsedName("Doc"))),
								note: identifierOf(identity.table(parsedName("Note"))),
								editor: worldRoleOf(w.editor),
								viewer: worldRoleOf(w.viewer),
								login: loginRoleOf(w.desk),
								editorSchema: identifierOf(
									identity.roleSchema(identity.role(installation, parsedName("editor")))
								)
							}
							return yield* exhaust(
								{
									suite: "pg/cli/drift-worlds",
									generator: element(plantedKinds),
									literal: Formatter.format,
									limit: plantedKinds.length,
									coverage: requiredInSpace<Planted>(plantedKinds),
									caseHang,
									box: "every kind of object a world installs that drift compares: a view's options, a table's row security, a policy's roles, a function's volatility, a role's privileges, settings, attributes and memberships, and a role schema's relations",
									oracle: {
										kind: "postgresql",
										name: "the catalog PostgreSQL holds after each change by hand, as the drift check reads it"
									}
								},
								(kind: Planted, c: Case<Planted>) =>
									Effect.gen(function* () {
										c.note(kind)
										const change = yield* changeOf(kind, names)
										for (const sql of change.plant) {
											yield* substrate.admin.query(sql, [])
										}
										const drifted = yield* Effect.ensuring(
											run("drift"),
											Effect.orDie(
												Effect.forEach(change.undo, (sql) => substrate.admin.query(sql, []), {
													discard: true
												})
											)
										)
										assert.equal(drifted.code, 1, `${kind}: ${drifted.stdout}`)
										const mismatches = mismatchesOf(drifted)
										assert.ok(
											Arr.some(mismatches, (m) => Str.includes(change.named)(m)),
											`${kind}: a mismatch names ${change.named}: ${Arr.join(mismatches, "; ")}`
										)
										const undone = yield* run("drift")
										assert.equal(undone.code, 0, `${kind} undone: ${undone.stderr}`)
									})
							)
						})
					)
				)
		)
	}
)
