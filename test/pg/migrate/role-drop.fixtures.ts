/** What role-drop.test.ts reads: its versions, its box, and each case's sessions, its drop and its checks. */

import { assert, defined } from "@bjornpagen/testing/assert"
import { boolean, element, type Gen } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Exit, Option, Scope } from "effect"
import { uninstall } from "#adapter/migrate/uninstall.ts"
import { roleNameOf } from "#adapter/served/served.ts"
import { quoteIdent, quoteString } from "#compiler/core/text.ts"
import { pg } from "#compiler/public/fields.ts"
import { login, relation, role, schema } from "#compiler/public/schema.ts"
import { Id } from "#test/support/ids.ts"
import { noPlaceholders, type Version } from "#test/support/install-migrate.ts"
import { migrated } from "#test/support/installed.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"
import type { SqlError } from "#test/support/pg.ts"
import { migrationConnection, parsedTarget } from "#test/support/pg/migrate/support.ts"
import type { TransactionRolledBack } from "#test/support/substrate/errors.ts"
import type { RawSession } from "#test/support/substrate/session.ts"
import { Substrate, type SubstrateShape } from "#test/support/substrate/substrate.ts"

const Note = relation("Note", { id: Id, n: pg.integer }, ["id"])

/**
 * The installation under `name`: the login `desk` and its roles, `scribe`, which writes the notes, and `reader`, in the
 * first version; `reader` alone in the second, so its migration drops `scribe`.
 */
const builtOf = (name: string) => {
	const base = schema(name, [Note], [])
	const scribe = role(base, "scribe", { Note }, { insert: ["Note"] })
	const reader = role(base, "reader", { Note })
	return { base, scribe, reader, desk: login(base, "desk", [scribe, reader]) }
}

type Built = ReturnType<typeof builtOf>

/** The first version: `desk` with both roles. */
const firstOf = (name: string): { readonly built: Built; readonly version: Version } => {
	const built = builtOf(name)
	return { built, version: { schema: built.base, logins: [built.desk] } }
}

/** The second version: `desk` with `reader` alone. */
const secondOf = (name: string): Version => {
	const base = schema(name, [Note], [])
	return { schema: base, logins: [login(base, "desk", [role(base, "reader", { Note })])] }
}

/** A role of the installation a session acts as. */
type Acting = "scribe" | "reader"

/** What drops the roles: a migration to the second version, which drops `scribe`, or `grizzle uninstall`, every role. */
type Drop = "migration" | "uninstall"

/** A case: what drops roles, and whether a session holds both roles' carriers. */
export interface Box {
	readonly drop: Drop
	readonly both: boolean
}

/** The box: each drop, and a session holding both roles' carriers or none. */
export const box: Gen<Box> = (s) => ({
	drop: s.draw(element<Drop>(["migration", "uninstall"])),
	both: s.draw(boolean)
})

export type RoleDropFeature =
	| "a holder of a carrier ended"
	| "a holder of two roles' carriers ended"
	| "a holder of the kept role's carrier ran on"
	| "a session holding nothing ran on"
	| "uninstall ended every holder"

/**
 * One session of `desk` the case opens before the drop: its label and the roles it stood a carrier up as, none for a
 * session that ran a transaction as `reader` and made nothing.
 */
interface Opened {
	readonly label: string
	readonly holds: ReadonlyArray<Acting>
}

/**
 * The sessions of a case: the holder of `scribe`'s carrier, a session holding a carrier of each role where the case
 * says so, one holding `reader`'s carrier and one holding nothing.
 */
const openedOf = (k: Box): ReadonlyArray<Opened> => [
	{ label: "holder", holds: ["scribe"] },
	...(k.both ? [{ label: "both", holds: ["scribe", "reader"] } satisfies Opened] : []),
	{ label: "kept", holds: ["reader"] },
	{ label: "none", holds: [] }
]

/** The roles each drop drops, of the roles a session acts as. */
const dropped: { readonly [D in Drop]: ReadonlyArray<Acting> } = {
	migration: ["scribe"],
	uninstall: ["scribe", "reader"]
}

/** The temporary table a session makes as a role, an object of the role's in its session's temporary schema. */
const heldTable = "__held"

/** A session of the case, open: its pid and its carriers by the role that made each. */
interface Live {
	readonly opened: Opened
	readonly session: RawSession
	readonly carriers: ReadonlyArray<{ readonly role: Acting; readonly carrier: string }>
}

/**
 * Opens `opened` as `desk` and runs one transaction for each role it holds a temporary object of: SET LOCAL ROLE, then a
 * temporary table of its session kept by every COMMIT, made under PUBLIC's TEMPORARY on the database, and a row in it;
 * then it rests, idle, as a pooled session does between transactions.
 */
const openOne = (
	substrate: SubstrateShape,
	desk: Parameters<SubstrateShape["session"]>[0]["as"],
	pgRoles: { readonly [R in Acting]: string },
	opened: Opened
): Effect.Effect<Live, SqlError | TransactionRolledBack, Scope.Scope> =>
	Effect.gen(function* () {
		const session = yield* substrate.session({ as: desk, role: Option.none(), label: opened.label })
		const carriers: Array<Live["carriers"][number]> = []
		for (const acting of opened.holds) {
			const table = `${heldTable}_${acting}`
			yield* session.begin
			yield* session.query(`SET LOCAL ROLE ${quoteIdent(pgRoles[acting])}`, [])
			yield* session.query(
				`CREATE TEMPORARY TABLE pg_temp.${quoteIdent(table)} (c1 bigint) ON COMMIT PRESERVE ROWS`,
				[]
			)
			yield* session.query(`INSERT INTO pg_temp.${quoteIdent(table)} (c1) VALUES (1)`, [])
			yield* session.commit
			carriers.push({ role: acting, carrier: table })
		}
		if (opened.holds.length === 0) {
			yield* session.begin
			yield* session.query(`SET LOCAL ROLE ${quoteIdent(pgRoles.reader)}`, [])
			yield* session.commit
		}
		return { opened, session, carriers }
	})

/** The OIDs of the roles named `names`, as the cluster holds them now. */
const oidsOf = (substrate: SubstrateShape, names: ReadonlyArray<string>) =>
	Effect.map(
		substrate.admin.queryValues(
			"SELECT oid::text FROM pg_catalog.pg_roles WHERE rolname = ANY($1::text[])",
			[names]
		),
		(rows) => Arr.map(rows, (row) => String(row[0]))
	)

/** What a case records of its roles before the drop: the names of the roles it drops and their OIDs. */
interface Doomed {
	readonly names: ReadonlyArray<string>
	readonly oids: ReadonlyArray<string>
}

/**
 * Opens the case's sessions as `desk` over the first version `b` (openOne), and reads the roles the drop will drop:
 * `scribe`, and under uninstall `reader` and `desk` too.
 */
const openAll = (substrate: SubstrateShape, b: Built, k: Box) =>
	Effect.gen(function* () {
		const pgRoles = { scribe: roleNameOf(b.scribe, {}), reader: roleNameOf(b.reader, {}) }
		const desk = roleNameOf(b.desk, {})
		const credentials = yield* substrate.login(desk)
		const lives = yield* Effect.forEach(openedOf(k), (opened) =>
			openOne(substrate, { _tag: "Login", credentials }, pgRoles, opened)
		)
		const names = [
			...Arr.map(dropped[k.drop], (r) => pgRoles[r]),
			...(k.drop === "uninstall" ? [desk] : [])
		]
		const oids = yield* oidsOf(substrate, names)
		assert.equal(oids.length, names.length, "every role the drop drops stands before it")
		const doomed: Doomed = { names, oids }
		return { lives, doomed }
	})

/**
 * A case: installs the first version through its migration, opens its sessions as `desk`, each holding what it holds
 * (openedOf), then drops roles as the case says: by the migration to the second version, which drops `scribe`, run by
 * the real runner with the sessions resting; or by `grizzle uninstall`, which drops every role of the installation.
 * The oracle: the drop commits; exactly the sessions that held an object of a dropped role are gone, and each other
 * one still answers and still holds its carriers; and nothing of a dropped role remains, no role of its name and no
 * object or shared dependency of its OID.
 */
export const roleDropCase = (k: Box, c: Case<RoleDropFeature>) =>
	Effect.flatMap(Scope.make("sequential"), (own) =>
		Effect.ensuring(dropCase(k, c, own), Scope.close(own, Exit.void))
	)

/**
 * roleDropCase over `own`, the scope of the login's password and its sessions, which the case closes as it ends, the
 * sessions first, before the case's own scope releases the installation's schema and drops its roles, which a session
 * still held fails.
 */
const dropCase = (k: Box, c: Case<RoleDropFeature>, own: Scope.Scope) =>
	Effect.gen(function* () {
		const substrate = yield* Substrate
		const built: Array<Built> = []
		const first = (name: string): Version => {
			const drawn = firstOf(name)
			built.push(drawn.built)
			return drawn.version
		}
		const opening = Effect.suspend(() =>
			Scope.provide(openAll(substrate, defined(built[0], "the first version"), k), own)
		)
		const opened: Array<Effect.Success<typeof opening>> = []
		const m = yield* migrated({
			label: "role_drop",
			schemaName: { kind: "unique" },
			first,
			later: k.drop === "migration" ? [secondOf] : [],
			apply: noPlaceholders,
			declared: () => noDeclarations,
			observe:
				k.drop === "migration"
					? Option.some((i: number) =>
							i === 0 ? Effect.orDie(Effect.map(opening, (o) => void opened.push(o))) : Effect.void
						)
					: Option.none()
		})
		if (k.drop === "uninstall") {
			const met = yield* opening
			opened.push(met)
			yield* uninstall({
				connection: migrationConnection(substrate, m.ambientOwner.credentials),
				targets: [parsedTarget({ snapshot: m.snapshot, folders: m.folders })]
			})
		}
		const { lives, doomed } = defined(opened[0], "the sessions the drop met")
		const ends = (live: Live): boolean =>
			Arr.some(live.opened.holds, (role) => Arr.contains(dropped[k.drop], role))
		for (const live of lives) {
			const [row] = yield* substrate.admin.queryValues(
				"SELECT EXISTS (SELECT FROM pg_catalog.pg_stat_activity WHERE pid = $1::int4)",
				[live.session.pid]
			)
			const standing = defined(row, "the session's activity")[0] === true
			assert.equal(
				standing,
				!ends(live),
				`${live.opened.label}: a session runs on exactly when it held no object of a role the ${k.drop} drops`
			)
			if (!standing) {
				continue
			}
			for (const { carrier } of live.carriers) {
				const [held] = yield* live.session.values(
					`SELECT pg_catalog.to_regclass(${quoteString(`pg_temp.${quoteIdent(carrier)}`)}) IS NOT NULL`,
					[]
				)
				assert.equal(
					defined(held, "the carrier's standing")[0],
					true,
					`${live.opened.label}: a session that runs on keeps its carriers`
				)
			}
		}
		const [left] = yield* substrate.admin.queryValues(
			"SELECT (SELECT count(*) FROM pg_catalog.pg_roles WHERE rolname = ANY($1::text[])) + (SELECT count(*) FROM pg_catalog.pg_shdepend WHERE refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass AND refobjid = ANY($2::oid[])) + (SELECT count(*) FROM pg_catalog.pg_class WHERE relowner = ANY($2::oid[])) + (SELECT count(*) FROM pg_catalog.pg_proc WHERE proowner = ANY($2::oid[]))",
			[doomed.names, doomed.oids]
		)
		assert.equal(
			Number(defined(left, "what is left of the dropped roles")[0]),
			0,
			`nothing of ${Arr.join(doomed.names, ", ")} remains after the ${k.drop}`
		)
		c.note("a holder of a carrier ended")
		if (k.both) {
			c.note("a holder of two roles' carriers ended")
		}
		for (const live of lives) {
			if (ends(live)) {
				continue
			}
			c.note(
				live.carriers.length === 0
					? "a session holding nothing ran on"
					: "a holder of the kept role's carrier ran on"
			)
		}
		if (k.drop === "uninstall") {
			c.note("uninstall ended every holder")
		}
	})
