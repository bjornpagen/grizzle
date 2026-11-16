import { type Limit, provisional } from "@bjornpagen/limit"
import { Effect } from "effect"
import { compileInstallation } from "#compiler/physical/install/compile.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { assert } from "#test/support/assert.ts"
import { Account, Work, workWorlds } from "#test/support/fixtures/api/work.ts"
import { type Installed, migratedTemplate } from "#test/support/install-migrate.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"
import type { PgConnection, SqlError } from "#test/support/pg.ts"
import {
	roleSession,
	type SubstrateShape,
	worldSession
} from "#test/support/substrate/substrate.ts"

/**
 * Work installed through its first migration with its server login (test/support/fixtures/api/work.ts): the template the
 * forms' properties clone, built once per member.
 */
export const workTemplate = migratedTemplate({
	declaredIn: import.meta,
	name: "work",
	content: { schema: "Work", logins: ["server"], ambient: "ordinary" },
	versions: [{ schema: Work, logins: [workWorlds(Work).server], declarations: noDeclarations }],
	options: { label: "work", extensions: [], compile: compileInstallation, ambient: ordinarySession }
})

/**
 * How long a case of the forms' properties may run, its worker's first included. Temporary: until the runner opens a
 * need before its case's clock starts (TESTSYS lane CORE's fix), each worker's first case pays the need's one-time open
 * inside its own deadline: the template module's closure hash, the install's plan, the template's build or the wait on
 * it, and the worker's connection lease.
 */
export const firstCaseDeadline: Limit = provisional({
	value: 240_000,
	owner: "test/pg/substrate/forms.test.ts",
	unit: "milliseconds",
	scope: "one case of a forms property on the runner, its worker's first case of it included",
	breaks:
		"a case that never ends would hold its worker until the run is killed; the runner's own case deadline (60 s) cuts a worker's first case while its need opens, under load",
	measure:
		"delete this citation once the runner opens needs outside the case clock (CORE); until then, time each worker's first case at full width on a loaded machine and keep the slowest with stated headroom",
	origin:
		"GZ-FOUNDATION, 2026-11-16: four times the runner's caseDeadlineMillis. At 64 workers and load 350 a worker's first take of a built template took up to 18.5 s (measure/overhead1.jsonl); at load 500 to 700 with the templates unbuilt every property was cut at 60 s on its workers' first cases",
	recorded: "2026-11-16"
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
		const reader = yield* substrate.session(worldSession(installed.world(worlds.reader)))
		const [[role] = []] = yield* reader.values("SELECT current_user::text", [])
		assert.equal(role, installed.role(worlds.reader), "the reader's session acts as its world role")
	}).pipe(Effect.scoped)
