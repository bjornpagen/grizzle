/** What the properties of drift.test.ts read: its spaces, models and helpers. */

import { defined, nonEmpty } from "@bjornpagen/testing/assert"
import { array, constant, type Gen, weighted, type Steered } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Option, Record as Rec, String as Str } from "effect"
import { quoteIdent } from "#compiler/core/text.ts"
import { trusted } from "#compiler/core/trusted.ts"
import { pickFrom, pickGen, pickOf } from "#test/support/pick.ts"
import { Substrate, underDatabaseLock } from "#test/support/substrate/substrate.ts"

type Planted =
	| "a view's security barrier"
	| "row security disabled"
	| "a policy widened"
	| "a function's volatility"
	| "a privilege granted"
	| "a role's setting"
	| "a role's attribute"
	| "a membership granted"
	| "a table in a schema of views"
	| "a TEMPORARY grant beyond the snapshot"

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
	"a table in a schema of views": each(),
	"a TEMPORARY grant beyond the snapshot": each()
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
export interface Change {
	readonly plant: ReadonlyArray<string>
	readonly undo: ReadonlyArray<string>
	readonly named: string
	/** The situations the change reaches beyond its operator's own, read off the catalog it was picked from. */
	readonly reaches: ReadonlyArray<DriftFeature>
}

/** The installed names a change reaches: the database, the schema, its tables, the roles, and the roles' schemas. */
export interface DriftNames {
	readonly database: string
	readonly schema: string
	readonly tables: Arr.NonEmptyReadonlyArray<string>
	readonly editor: string
	readonly viewer: string
	readonly keeper: string
	readonly login: string
	readonly viewSchemas: Arr.NonEmptyReadonlyArray<string>
}

/** The installation's roles and its login an operator picks among, by their fields of DriftNames, in pick order. */
const pickedRoles = ["editor", "viewer", "login"] as const

/** The tables an operator picks among, by their declared names, in pick order. */
export const pickedTables = ["Doc", "Note"] as const

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
 * the attribute that undoes it: CREATEDB and CREATEROLE, which the administrator holds (@bjornpagen/testing/pg), and a
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

/** TEMPORARY on the database, granted to or revoked from `role` (`verb`), under the database lock: no installation grants
 * it any role (deploy/admission/roles.ts privilegeFamilies), so a grant is drift and its revoke undoes it. */
const temporary = (n: DriftNames, verb: "GRANT" | "REVOKE", role: string): string =>
	underDatabaseLock(
		`${verb} TEMPORARY ON DATABASE ${quoteIdent(n.database)} ${verb === "GRANT" ? "TO" : "FROM"} ${quoteIdent(role)}`
	)

/** The change of `kind` at `picks`, reading from the catalog what it reaches, as the cluster's superuser. */
export const changeOf = (kind: Planted, [first, second, third]: Picks, n: DriftNames) =>
	Effect.gen(function* () {
		const admin = (yield* Substrate).admin
		const table = (name: string) => `${quoteIdent(n.schema)}.${quoteIdent(name)}`
		const roles = Arr.map(pickedRoles, (r) => n[r])
		switch (kind) {
			case "a view's security barrier": {
				const rows = yield* admin.queryValues(
					"SELECT s.nspname::text, c.relname::text, coalesce(array_to_string(c.reloptions, ','), '') FROM pg_catalog.pg_class AS c JOIN pg_catalog.pg_namespace AS s ON s.oid = c.relnamespace WHERE s.nspname = ANY ($1::text[]) AND c.relkind = 'v' ORDER BY 1, 2",
					[n.viewSchemas]
				)
				const row = picked(rows, first, "a view of a role")
				const view = column(row, 1)
				const name = `${quoteIdent(column(row, 0))}.${quoteIdent(view)}`
				const set = `ALTER VIEW ${name} SET (security_barrier = true)`
				const reset = `ALTER VIEW ${name} RESET (security_barrier)`
				const change: Change = Str.includes("security_barrier=true")(column(row, 2))
					? { plant: [reset], undo: [set], named: view, reaches: [] }
					: { plant: [set], undo: [reset], named: view, reaches: [] }
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
					named: name,
					reaches: []
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
					named: policy,
					reaches: []
				}
				return change
			}
			case "a function's volatility": {
				const rows = yield* admin.queryValues(
					"SELECT p.oid::regprocedure::text, p.proname::text, p.provolatile::text FROM pg_catalog.pg_proc AS p JOIN pg_catalog.pg_namespace AS s ON s.oid = p.pronamespace WHERE s.nspname = ANY ($1::text[]) AND p.prokind = 'f' AND p.provolatile <> 'i' ORDER BY 2, 1",
					[[...n.viewSchemas, n.schema]]
				)
				const row = picked(rows, first, "a function a world reads")
				const signature = column(row, 0)
				const was = column(row, 2) === "s" ? "STABLE" : "VOLATILE"
				const now = column(row, 2) === "s" ? "VOLATILE" : "STABLE"
				const change: Change = {
					plant: [`ALTER FUNCTION ${signature} ${now}`],
					undo: [`ALTER FUNCTION ${signature} ${was}`],
					named: column(row, 1),
					reaches: []
				}
				return change
			}
			case "a privilege granted": {
				const role = pickFrom(roles, first)
				const name = pickFrom(n.tables, second)
				/**
				 * The privileges the role holds on the table, whole or on any of its columns: a REVOKE on the table revokes
				 * the role's privilege of that type on every column too, so the undo of a privilege the role holds on a
				 * column would take that column's grant away with the plant.
				 */
				const acl = yield* admin.queryValues(
					"SELECT a.privilege_type::text FROM pg_catalog.pg_class AS c, aclexplode(c.relacl) AS a WHERE c.oid = $1::regclass AND a.grantee = $2::regrole UNION SELECT a.privilege_type::text FROM pg_catalog.pg_attribute AS t, aclexplode(t.attacl) AS a WHERE t.attrelid = $1::regclass AND t.attnum > 0 AND NOT t.attisdropped AND a.grantee = $2::regrole",
					[table(name), quoteIdent(role)]
				)
				const held = textRows(acl)
				/**
				 * The role's grants on the table's columns, which a privilege granted beside them must leave as its undo
				 * finds them.
				 */
				const columnGrants = yield* admin.queryValues(
					"SELECT DISTINCT a.privilege_type::text FROM pg_catalog.pg_attribute AS t, aclexplode(t.attacl) AS a WHERE t.attrelid = $1::regclass AND t.attnum > 0 AND NOT t.attisdropped AND a.grantee = $2::regrole",
					[table(name), quoteIdent(role)]
				)
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
					named: name,
					reaches: Arr.isReadonlyArrayNonEmpty(textRows(columnGrants))
						? ["a privilege granted beside the role's column grants"]
						: []
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
					named: "work_mem",
					reaches: []
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
					named: role,
					reaches: []
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
					named: granted,
					reaches: []
				}
				return change
			}
			case "a table in a schema of views": {
				const stray = `${quoteIdent(pickFrom(n.viewSchemas, first))}.${quoteIdent("stray_by_hand")}`
				const change: Change = {
					plant: [`CREATE TABLE ${stray} (a int4)`],
					undo: [`DROP TABLE ${stray}`],
					named: "stray_by_hand",
					reaches: []
				}
				return change
			}
			case "a TEMPORARY grant beyond the snapshot": {
				const role = pickFrom([n.editor, n.viewer, n.keeper, n.login], first)
				const change: Change = {
					plant: [temporary(n, "GRANT", role)],
					undo: [temporary(n, "REVOKE", role)],
					named: `role ${role} privilege TEMPORARY on database`,
					reaches: []
				}
				return change
			}
		}
	})

export type DriftFeature =
	| Planted
	| "nothing planted"
	| "several planted"
	| "a privilege granted beside the role's column grants"

/** The operators a case plants, each at its picks, in the operators' order. */
export const plantedOf = (plants: Plants): ReadonlyArray<readonly [Planted, Picks]> =>
	Arr.flatMap(Rec.toEntries(plants), ([kind, picks]): ReadonlyArray<readonly [Planted, Picks]> =>
		Option.match(picks, { onNone: () => [], onSome: (p) => [[kind, p]] })
	)

/** What a case reaches: each operator it plants, nothing, or several. */
export const plantsFeatures = (plants: Plants): ReadonlyArray<DriftFeature> => {
	const planted = plantedOf(plants)
	return [
		...Arr.map(planted, ([kind]) => kind),
		...(planted.length === 0 ? ["nothing planted" as const] : []),
		...(planted.length > 1 ? ["several planted" as const] : [])
	]
}

/**
 * The privilege operator's picks that reach a role's column grants: the editor on Note, whose rule Mine reads Note's
 * columns, so the editor holds SELECT on them (fixture.ts worlds), at pick 0: the first privilege, in PostgreSQL's
 * privilege list, that the editor holds on neither the table nor any of its columns.
 */
const besideColumnGrants: Picks = [
	pickOf(pickedRoles.indexOf("editor"), pickedRoles.length),
	pickOf(pickedTables.indexOf("Note"), pickedTables.length),
	0
]

/** How many candidates the generator draws, under steering, for plants that reach a pending situation. */
const aimCandidates = 32

/**
 * A case's plants as the generator draws them: where the case's turn aims at a privilege granted beside a role's column
 * grants, which the catalog decides and no draw of picks foresees, that privilege alone (besideColumnGrants); else the
 * drawn ones, or, where steering names situations no case has reached and they reach none, the first of up to
 * `aimCandidates` further draws that reaches one, else the drawn ones; a rotating case is drawn unaimed.
 */
export const aimedPlantsGen: Steered<Plants, DriftFeature>["under"] = (steering) => (source) => {
	if (
		Option.exists(steering, (pending) =>
			pending.aimed("a privilege granted beside the role's column grants")
		)
	) {
		return {
			...plantsOf(() => Option.none()),
			"a privilege granted": Option.some(besideColumnGrants)
		}
	}
	const drawnPlants = source.draw(plantsGen)
	return Option.match(steering, {
		onNone: () => drawnPlants,
		onSome: (pending) => {
			const reaches = (p: Plants) => Arr.some(plantsFeatures(p), (f) => pending.has(f))
			return reaches(drawnPlants)
				? drawnPlants
				: Option.getOrElse(
						Arr.findFirst(
							source.draw(array(plantsGen, { min: aimCandidates, max: aimCandidates })),
							reaches
						),
						() => drawnPlants
					)
		}
	})
}
