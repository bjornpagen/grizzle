import { assert } from "@bjornpagen/testing/assert"
import { element, type Gen, int } from "@bjornpagen/testing/gen"
import { Effect } from "effect"
import { query, v } from "#compiler/public/query.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { Account, Work, type WorkNamed, workWorlds } from "#test/support/fixtures/api/work.ts"
import { generatedTemplate, type Installed, type Version } from "#test/support/install-migrate.ts"
import { rebuild } from "#test/support/installed.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import type { PgConnection, SqlError } from "#test/support/pg.ts"
import {
	claimsOfNoFact,
	roleSession,
	type SubstrateShape,
	worldSession
} from "#test/support/substrate/substrate.ts"
import { fullWorld } from "#test/support/worlds.ts"

/** Work rebuilt under the allocated name `name` (installed.ts rebuild) with its server login over it. */
const workVersion = (name: string): Version => {
	const named = rebuild(Work, name)
	return { schema: named, logins: [workWorlds(named).server] }
}

/**
 * Work installed through its first migration with its server login (test/support/fixtures/api/work.ts): the template the
 * forms' properties clone, built once per member.
 */
export const workTemplate = generatedTemplate({
	declaredIn: import.meta,
	name: "work",
	content: { schema: "Work", logins: ["server"], ambient: "ordinary" },
	build: workVersion,
	ambient: ordinarySession
})

/**
 * Work installed once more as a template of its own, `copy` apart from workTemplate's and every other copy's content: a
 * template of the closed sets the oneOf and budget properties draw from.
 */
const workCopyTemplate = (copy: string) =>
	generatedTemplate({
		declaredIn: import.meta,
		name: `work, ${copy}`,
		content: { schema: "Work", logins: ["server"], ambient: "ordinary", copy },
		build: workVersion,
		ambient: ordinarySession
	})

/** The second of the closed set of templates oneOfTemplates draws from. */
export const secondWorkTemplate = workCopyTemplate("second")

/**
 * Work's templates a case of the budget property holds at once, each its own fresh clone (forms.test.ts
 * aCaseOfFreshSubstratesAndAFullPoolStaysWithinItsBudget): four templates apart, so a case takes four needs apart.
 */
export const heldWorkTemplates = {
	first: workTemplate,
	second: secondWorkTemplate,
	third: workCopyTemplate("third"),
	fourth: workCopyTemplate("fourth")
} as const

/** The keys of the closed set of templates the oneOf property draws a case's from. */
const templateKeys = ["first", "second"] as const

/** A oneOf case: the template it draws among templateKeys, and the rows it writes. */
export const oneOfCase: Gen<readonly [(typeof templateKeys)[number], number]> = (source) => [
	source.draw(element(templateKeys)),
	source.draw(int(1, 4))
]

/** Every account, by id and name, over `installed`: the read the served login's workload holds (servedTemplate). */
const everyAccount = (installed: WorkNamed<string>) =>
	query(installed).rule((r) => {
		const { id, name } = v(Account, "account")
		return r.match(Account, { id, name }).find({ id, name })
	})

/** Work's full world over the schema it is given (test/support/worlds.ts fullWorld), its login reading every account. */
export const servedWorld = (installed: WorkNamed<string>) =>
	fullWorld(installed, { accounts: everyAccount(installed) })

/**
 * Work drafted and served as `grizzle generate` does, with its full world's server login (servedWorld), which Served.of
 * serves over each case's clone.
 */
export const servedTemplate = generatedTemplate({
	declaredIn: import.meta,
	name: "work served",
	content: { schema: "Work", logins: ["server of the full world, reading every account"] },
	build: (name) => {
		const named = rebuild(Work, name)
		return { schema: named, logins: [servedWorld(named).server] }
	},
	ambient: ordinarySession
})

/** How many accounts `connection` reads in the installation. */
const accounts = (
	connection: PgConnection,
	installed: Installed
): Effect.Effect<number, SqlError> =>
	Effect.map(
		connection.queryValues(`SELECT count(*)::int4 FROM ${namesOf(installed).table(Account)}`, []),
		(rows) => Number(rows[0]?.[0])
	)

/**
 * `rows` accounts written into the installation on `connection`, which finds none before: the case's clone holds the
 * template's installation and no row an earlier case wrote.
 */
export const writtenAccounts = (
	connection: PgConnection,
	installed: Installed,
	rows: number
): Effect.Effect<void, SqlError> =>
	Effect.gen(function* () {
		const names = namesOf(installed)
		const before = yield* accounts(connection, installed)
		assert.equal(before, 0, "the clone holds no account")
		yield* connection.query(
			`INSERT INTO ${names.table(Account)} (${names.column(Account, "id")}, ${names.column(Account, "name")}) SELECT pg_catalog.gen_random_uuid(), 'account ' || n::text FROM pg_catalog.generate_series(1, $1::int4) AS n`,
			[rows]
		)
		const after = yield* accounts(connection, installed)
		assert.equal(after, rows, "the case's accounts")
	})

/**
 * Every login of the template's installation logs in on the case's clone with the credentials the case derives, the
 * owner login among them, and takes on a world role.
 */
export const loggedIn = (
	substrate: SubstrateShape,
	installed: Installed
): Effect.Effect<void, SqlError> =>
	Effect.gen(function* () {
		const worlds = workWorlds(Work)
		const server = yield* substrate.session(roleSession(installed.as(worlds.server)))
		yield* server.query("SELECT 1", [])
		const owner = yield* substrate.session(roleSession(installed.ambientOwner.credentials))
		yield* owner.query("SELECT 1", [])
		const reader = yield* substrate.session(
			worldSession(installed.world(worlds.reader), claimsOfNoFact)
		)
		const [[role] = []] = yield* reader.values("SELECT current_user::text", [])
		assert.equal(role, installed.role(worlds.reader), "the reader's session acts as its world role")
	}).pipe(Effect.scoped)
