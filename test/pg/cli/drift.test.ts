import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { type Case, drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, constant, type Gen, weighted } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { searched } from "@grizzle/testing/vitest"
import {
	Array as Arr,
	DateTime,
	Effect,
	Formatter,
	Layer,
	Option,
	Record as Rec,
	String as Str
} from "effect"
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
import { assert, defined, nonEmpty } from "#test/support/assert.ts"
import { loginRoleOf, worldRoleOf } from "#test/support/installed.ts"
import { parsedName, parsedSchemaName } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { pickFrom, pickGen } from "#test/support/pick.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * `grizzle drift` against changes made by hand to the objects a world installs, on PostgreSQL 19, searched: drift
 * passes on a fresh installation; once any set of objects is changed by hand it refuses with Drifted, a mismatch of
 * which names each changed object; once the changes are undone it passes again.
 *
 * The installation is the worlds fixture (fixture.ts): `editor` reads Doc and writes Mine, the notes of the documents
 * its session's subject owns, under row security, through a filter that reads Doc beside Note; `viewer` reads Doc;
 * both in the login `desk`. It is generated and migrated through the command line once. Each case draws, for every
 * operator below, whether it plants a change and where, its target picked among what the installed catalog holds,
 * and makes every drawn change at once as the cluster's superuser:
 *
 * - a role's view loses or gains its security barrier;
 * - row security is disabled on a table a role writes under it;
 * - a role's policy is widened to PUBLIC;
 * - a function a world reads changes its volatility;
 * - a role or the login is granted a table privilege, of PostgreSQL's, the snapshot does not grant;
 * - a role or the login stores a setting;
 * - a role or the login gains an attribute the snapshot denies it, of PostgreSQL's role attributes the test's
 *   administrator may set;
 * - one role becomes a member of the other;
 * - a table is created in a role's schema.
 *
 * The oracle is PostgreSQL's catalog as the drift check reads it: drift refuses exactly when a change was made, its
 * mismatches naming every changed object, and passes once every change is undone.
 */
type Planted =
	| "a view's security barrier"
	| "row security disabled"
	| "a policy widened"
	| "a function's volatility"
	| "a privilege granted"
	| "a role's setting"
	| "a role's attribute"
	| "a membership granted"
	| "a table in a role's schema"

/** Where an operator plants its change: picks among the targets the catalog holds (test/support/pick.ts). */
type Picks = readonly [number, number, number]

/** For every operator, whether a case plants its change and, if it does, where: one choice each, so the space is every
 * subset of the operators, the empty one included. */
type Plants = { readonly [P in Planted]: Option.Option<Picks> }

/** Every operator's choice, made by `each`. */
const plantsOf = (each: () => Option.Option<Picks>): Plants => ({
	"a view's security barrier": each(),
	"row security disabled": each(),
	"a policy widened": each(),
	"a function's volatility": each(),
	"a privilege granted": each(),
	"a role's setting": each(),
	"a role's attribute": each(),
	"a membership granted": each(),
	"a table in a role's schema": each()
})

/** One operator's choice: left out two draws in three, otherwise planted at drawn picks. */
const plantGen: Gen<Option.Option<Picks>> = weighted<Option.Option<Picks>>([
	[2, constant(Option.none())],
	[
		1,
		(source) =>
			Option.some([source.draw(pickGen), source.draw(pickGen), source.draw(pickGen)] as const)
	]
])

/** A case's plants: nothing planted, or each operator's own choice. */
const plantsGen: Gen<Plants> = weighted<Plants>([
	[1, constant(plantsOf(() => Option.none()))],
	[5, (source) => plantsOf(() => source.draw(plantGen))]
])

/** A change made by hand: what it does, what undoes it, and the name a mismatch of the drift check must hold. */
interface Change {
	readonly plant: ReadonlyArray<string>
	readonly undo: ReadonlyArray<string>
	readonly named: string
}

/** The installed names a change reaches: the schema, its tables, the roles, and the roles' schemas. */
interface Names {
	readonly schema: string
	readonly tables: Arr.NonEmptyReadonlyArray<string>
	readonly editor: string
	readonly viewer: string
	readonly login: string
	readonly roleSchemas: Arr.NonEmptyReadonlyArray<string>
}

/** PostgreSQL's table privileges (GRANT's privilege list for a table). */
const tablePrivileges = [
	"SELECT",
	"INSERT",
	"UPDATE",
	"DELETE",
	"TRUNCATE",
	"REFERENCES",
	"TRIGGER",
	"MAINTAIN"
] as const

/**
 * PostgreSQL's role attributes the snapshot denies a login or a role that the test's administrator may set, each with
 * the attribute that undoes it: CREATEDB and CREATEROLE, which the administrator holds (scripts/pg/init.sh), and a
 * login's INHERIT or a role's LOGIN, which it may set on any role it administers. REPLICATION, BYPASSRLS and SUPERUSER
 * are set only by a role that holds them, which the administrator does not.
 */
const deniedAttributes = (
	kind: "login" | "role"
): Arr.NonEmptyReadonlyArray<readonly [string, string]> => [
	["CREATEDB", "NOCREATEDB"],
	["CREATEROLE", "NOCREATEROLE"],
	kind === "login" ? ["INHERIT", "NOINHERIT"] : ["LOGIN", "NOLOGIN"]
]

/** The rows a catalog read of text columns answers. */
const textRows = (
	rows: ReadonlyArray<ReadonlyArray<unknown>>
): ReadonlyArray<ReadonlyArray<string>> => trusted<ReadonlyArray<ReadonlyArray<string>>>(rows)

/** The row a pick selects among those a catalog read answers, which the installation must hold. */
const picked = (
	rows: ReadonlyArray<ReadonlyArray<unknown>>,
	pick: number,
	what: string
): ReadonlyArray<string> => pickFrom(nonEmpty(textRows(rows), what), pick)

/** Column `i` of a row a catalog read answers. */
const column = (row: ReadonlyArray<string>, i: number): string => defined(row[i], "a column read")

/** The change of `kind` at `picks`, reading from the catalog what it reaches, as the cluster's superuser. */
const changeOf = (kind: Planted, [first, second, third]: Picks, n: Names) =>
	Effect.gen(function* () {
		const admin = (yield* Substrate).admin
		const table = (name: string) => `${quoteIdent(n.schema)}.${quoteIdent(name)}`
		const roles = [n.editor, n.viewer, n.login] as const
		switch (kind) {
			case "a view's security barrier": {
				const rows = yield* admin.queryValues(
					"SELECT s.nspname::text, c.relname::text, coalesce(array_to_string(c.reloptions, ','), '') FROM pg_catalog.pg_class AS c JOIN pg_catalog.pg_namespace AS s ON s.oid = c.relnamespace WHERE s.nspname = ANY ($1::text[]) AND c.relkind = 'v' ORDER BY 1, 2",
					[n.roleSchemas]
				)
				const row = picked(rows, first, "a view of a role")
				const view = column(row, 1)
				const name = `${quoteIdent(column(row, 0))}.${quoteIdent(view)}`
				const set = `ALTER VIEW ${name} SET (security_barrier = true)`
				const reset = `ALTER VIEW ${name} RESET (security_barrier)`
				const change: Change = Str.includes("security_barrier=true")(column(row, 2))
					? { plant: [reset], undo: [set], named: view }
					: { plant: [set], undo: [reset], named: view }
				return change
			}
			case "row security disabled": {
				const rows = yield* admin.queryValues(
					"SELECT c.relname::text FROM pg_catalog.pg_class AS c JOIN pg_catalog.pg_namespace AS s ON s.oid = c.relnamespace WHERE s.nspname = $1::text AND c.relkind = 'r' AND c.relrowsecurity ORDER BY 1",
					[n.schema]
				)
				const row = picked(rows, first, "a table under row security")
				const name = column(row, 0)
				const change: Change = {
					plant: [`ALTER TABLE ${table(name)} DISABLE ROW LEVEL SECURITY`],
					undo: [`ALTER TABLE ${table(name)} ENABLE ROW LEVEL SECURITY`],
					named: name
				}
				return change
			}
			case "a policy widened": {
				const rows = yield* admin.queryValues(
					"SELECT p.tablename::text, p.policyname::text, array_to_string(p.roles, ',') FROM pg_catalog.pg_policies AS p WHERE p.schemaname = $1::text ORDER BY 1, 2",
					[n.schema]
				)
				const row = picked(rows, first, "a policy of a role")
				const on = table(column(row, 0))
				const policy = column(row, 1)
				const to = Arr.join(
					Arr.map(Str.split(column(row, 2), ","), (r) => quoteIdent(r)),
					", "
				)
				const change: Change = {
					plant: [`ALTER POLICY ${quoteIdent(policy)} ON ${on} TO ${to}, PUBLIC`],
					undo: [`ALTER POLICY ${quoteIdent(policy)} ON ${on} TO ${to}`],
					named: policy
				}
				return change
			}
			case "a function's volatility": {
				const rows = yield* admin.queryValues(
					"SELECT p.oid::regprocedure::text, p.proname::text, p.provolatile::text FROM pg_catalog.pg_proc AS p JOIN pg_catalog.pg_namespace AS s ON s.oid = p.pronamespace WHERE s.nspname = ANY ($1::text[]) AND p.prokind = 'f' AND p.provolatile <> 'i' ORDER BY 2, 1",
					[[...n.roleSchemas, n.schema]]
				)
				const row = picked(rows, first, "a function a world reads")
				const signature = column(row, 0)
				const was = column(row, 2) === "s" ? "STABLE" : "VOLATILE"
				const now = column(row, 2) === "s" ? "VOLATILE" : "STABLE"
				const change: Change = {
					plant: [`ALTER FUNCTION ${signature} ${now}`],
					undo: [`ALTER FUNCTION ${signature} ${was}`],
					named: column(row, 1)
				}
				return change
			}
			case "a privilege granted": {
				const role = pickFrom(roles, first)
				const name = pickFrom(n.tables, second)
				const acl = yield* admin.queryValues(
					"SELECT a.privilege_type::text FROM pg_catalog.pg_class AS c, aclexplode(c.relacl) AS a WHERE c.oid = $1::regclass AND a.grantee = $2::regrole",
					[table(name), quoteIdent(role)]
				)
				const held = textRows(acl)
				const privilege = pickFrom(
					nonEmpty(
						Arr.filter(tablePrivileges, (p) => !Arr.some(held, (h) => column(h, 0) === p)),
						"a privilege the role does not hold"
					),
					third
				)
				const change: Change = {
					plant: [`GRANT ${privilege} ON ${table(name)} TO ${quoteIdent(role)}`],
					undo: [`REVOKE ${privilege} ON ${table(name)} FROM ${quoteIdent(role)}`],
					named: name
				}
				return change
			}
			case "a role's setting": {
				const role = pickFrom(roles, first)
				const change: Change = {
					plant: [
						`ALTER ROLE ${quoteIdent(role)} SET work_mem = '${pickFrom(Arr.range(1, 64), second)}MB'`
					],
					undo: [`ALTER ROLE ${quoteIdent(role)} RESET work_mem`],
					named: "work_mem"
				}
				return change
			}
			case "a role's attribute": {
				const role = pickFrom(roles, first)
				const [attribute, undo] = pickFrom(
					deniedAttributes(role === n.login ? "login" : "role"),
					second
				)
				const change: Change = {
					plant: [`ALTER ROLE ${quoteIdent(role)} ${attribute}`],
					undo: [`ALTER ROLE ${quoteIdent(role)} ${undo}`],
					named: role
				}
				return change
			}
			case "a membership granted": {
				const [granted, member] = pickFrom(
					[
						[n.viewer, n.editor],
						[n.editor, n.viewer]
					] as const,
					first
				)
				const change: Change = {
					plant: [`GRANT ${quoteIdent(granted)} TO ${quoteIdent(member)}`],
					undo: [`REVOKE ${quoteIdent(granted)} FROM ${quoteIdent(member)}`],
					named: granted
				}
				return change
			}
			case "a table in a role's schema": {
				const stray = `${quoteIdent(pickFrom(n.roleSchemas, first))}.${quoteIdent("stray_by_hand")}`
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

type DriftFeature = Planted | "nothing planted" | "several planted"

/** The operators a case plants, each at its picks, in the operators' order. */
const plantedOf = (plants: Plants): ReadonlyArray<readonly [Planted, Picks]> =>
	Arr.flatMap(Rec.toEntries(plants), ([kind, picks]): ReadonlyArray<readonly [Planted, Picks]> =>
		Option.match(picks, { onNone: () => [], onSome: (p) => [[kind, p]] })
	)

/** What a case reaches: each operator it plants, nothing, or several. */
const plantsFeatures = (plants: Plants): ReadonlyArray<DriftFeature> => {
	const planted = plantedOf(plants)
	return [
		...Arr.map(planted, ([kind]) => kind),
		...(planted.length === 0 ? ["nothing planted" as const] : []),
		...(planted.length > 1 ? ["several planted" as const] : [])
	]
}

/** How many candidates a steered case draws for plants that reach a pending situation. */
const aimCandidates = 32

/**
 * The plants a case runs: the drawn ones, or, where steering names situations no case has reached, the first of up to
 * `aimCandidates` further draws that reaches one, else the drawn one.
 */
const aimedPlants = (drawnPlants: Plants, c: Case<DriftFeature>): Plants =>
	Option.match(c.steering, {
		onNone: () => drawnPlants,
		onSome: (pending) => {
			const reaches = (p: Plants) => Arr.some(plantsFeatures(p), (f) => pending.has(f))
			return reaches(drawnPlants)
				? drawnPlants
				: Option.getOrElse(
						Arr.findFirst(
							c.draw(array(plantsGen, { min: aimCandidates, max: aimCandidates })),
							reaches
						),
						() => drawnPlants
					)
		}
	})

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
			"passes on a fresh installation, refuses any set of hand changes to a world's objects naming each, and passes once they are undone",
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
							const roleSchema = (role: string) =>
								identifierOf(identity.roleSchema(identity.role(installation, parsedName(role))))
							const names: Names = {
								schema: identifierOf(installation),
								tables: [
									identifierOf(identity.table(parsedName("Doc"))),
									identifierOf(identity.table(parsedName("Note")))
								],
								editor: worldRoleOf(w.editor),
								viewer: worldRoleOf(w.viewer),
								login: loginRoleOf(w.desk),
								roleSchemas: [roleSchema("editor"), roleSchema("viewer")]
							}
							return yield* explore(
								{
									suite: "pg/cli/drift-worlds",
									draw: drawn(plantsGen),
									literal: Formatter.format,
									coverage: required<DriftFeature>(
										[
											"a view's security barrier",
											"row security disabled",
											"a policy widened",
											"a function's volatility",
											"a privilege granted",
											"a role's setting",
											"a role's attribute",
											"a membership granted",
											"a table in a role's schema",
											"nothing planted",
											"several planted"
										],
										{ cases: 16, sense: notesOnly }
									),
									kept: [],
									runs: 4,
									shrink: { kind: "bounded", candidates: 24 },
									concurrency: 1,
									steerEvery: 4,
									caseHang,
									oracle: {
										kind: "postgresql",
										name: "the catalog PostgreSQL holds after the changes by hand, as the drift check reads it"
									}
								},
								(drawnPlants: Plants, c: Case<DriftFeature>) =>
									Effect.gen(function* () {
										const plants = aimedPlants(drawnPlants, c)
										c.noteAll(plantsFeatures(plants))
										const planted = plantedOf(plants)
										const changes = yield* Effect.forEach(planted, ([kind, picks]) =>
											changeOf(kind, picks, names)
										)
										const made: Array<Change> = []
										const plant = Effect.forEach(
											changes,
											(change) =>
												Effect.andThen(
													Effect.forEach(change.plant, (sql) => substrate.admin.query(sql, []), {
														discard: true
													}),
													Effect.sync(() => {
														made.push(change)
													})
												),
											{ discard: true }
										)
										const undo = Effect.suspend(() =>
											Effect.flatMap(
												Effect.forEach(
													Arr.reverse(Arr.flatMap(made, (change) => change.undo)),
													(sql) => Effect.result(substrate.admin.query(sql, []))
												),
												(results) =>
													Effect.orDie(
														Effect.forEach(results, Effect.fromResult, { discard: true })
													)
											)
										)
										const drifted = yield* Effect.ensuring(
											Effect.flatMap(plant, () => run("drift")),
											undo
										)
										if (changes.length === 0) {
											assert.equal(drifted.code, 0, `nothing planted: ${drifted.stderr}`)
											return
										}
										assert.equal(drifted.code, 1, drifted.stdout)
										const mismatches = mismatchesOf(drifted)
										for (const change of changes) {
											assert.ok(
												Arr.some(mismatches, (m) => Str.includes(change.named)(m)),
												`a mismatch names ${change.named}: ${Arr.join(mismatches, "; ")}`
											)
										}
										const undone = yield* run("drift")
										assert.equal(undone.code, 0, `undone: ${undone.stderr}`)
									})
							)
						})
					)
				)
		)
	}
)
