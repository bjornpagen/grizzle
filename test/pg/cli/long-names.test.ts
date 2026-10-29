import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { type Case, exhaust } from "@grizzle/testing/explore"
import { features } from "@grizzle/testing/features"
import { element } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import {
	Array as Arr,
	Duration,
	Effect,
	FileSystem,
	Formatter,
	Layer,
	Order,
	Record as Rec,
	Schema
} from "effect"
import { Db } from "#adapter/public/db.ts"
import { DbLayer } from "#adapter/public/layer.ts"
import { conversionOf, identity, maxIdentifierBytes } from "#compiler/core/identity.ts"
import { utf8Length } from "#compiler/core/sha256.ts"
import type { AnyLogin } from "#compiler/public/schema.ts"
import { ledger, shopV1 } from "#test/pg/cli/fixture.ts"
import {
	cli,
	cliClock,
	type SchemaSpec,
	urlEnv,
	viaDatabaseUrl,
	workspace,
	writeConfig
} from "#test/pg/cli/support.ts"
import { assert } from "#test/support/assert.ts"
import { readCatalog } from "#test/support/catalog/read.ts"
import { pgPin } from "#test/support/env.ts"
import { parsedName, parsedSchemaName } from "#test/support/kernel/naming.ts"
import { snapshotJson } from "#test/support/snapshot-json.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"
import { testVerify, tokenOf } from "#test/support/worlds.ts"

/** The clock the in-process command lines of this file read. */
const nextNow = cliClock()

/**
 * On PostgreSQL 19: a login's and its roles' PostgreSQL roles at the identifier limit, through the command line.
 *
 * A login's or role's PostgreSQL role is `<schema>__<name>` (core/identity.ts), which must fit 63 bytes: PostgreSQL
 * would cut a longer one, and Db.open would look for a role no migration created. For the shop and the ledger
 * (test/pg/cli/fixture.ts), each declared with its login under an allocated schema name (substrate/names.ts
 * uniqueSchemaNameOfLength) whose longest login or role role fills exactly 63 bytes, the loop a user runs, as the bin
 * runs it:
 *
 * - `grizzle generate` drafts the first migration into migrations/<schema>;
 * - `grizzle check` passes, and `grizzle migrate` with DATABASE_URL applies it;
 * - the login's role and every role exist exactly as named, and Db.open of every role of the login, over the same
 *   schema value, logs in as the login's role and is admitted, its layer given the committed snapshot.
 *
 * Under a schema name one byte longer, `grizzle generate` refuses and drafts nothing.
 */
interface Fixture {
	readonly label: FixtureLabel
	readonly spec: (name: string) => SchemaSpec
	/** The fixture's login over the schema declared under a name. */
	readonly login: (name: string) => AnyLogin
}

/** The fixtures by name: what each case notes it ran. */
type FixtureLabel = "shop" | "ledger"

const fixtures: Arr.NonEmptyReadonlyArray<Fixture> = [
	{
		label: "shop",
		spec: (name) => ({ name, fixture: "shop", version: 1, workload: "none" }),
		login: (name) => shopV1(name, "none").server
	},
	{
		label: "ledger",
		spec: (name) => ({ name, fixture: "ledger" }),
		login: (name) => ledger(name).server
	}
]

/** Every fixture, by name: each case notes the fixture it ran. */
const everyFixture = <E, R>(
	suite: string,
	property: (fixture: Fixture) => Effect.Effect<void, E, R>
) =>
	exhaust(
		{
			suite,
			generator: element(fixtures),
			literal: (fixture: Fixture) => Formatter.format(fixture.label),
			limit: fixtures.length,
			features: features<FixtureLabel>(["shop", "ledger"]),
			caseHang: Duration.minutes(2)
		},
		(fixture: Fixture, c: Case<FixtureLabel>) =>
			Effect.tap(property(fixture), () => Effect.sync(() => c.note(fixture.label)))
	)

/** The longest conversion among a login's name and its roles' names, which do not depend on the schema's. */
const longestRoleName = (fixture: Fixture): number => {
	const login = fixture.login("probe")
	return Math.max(
		...Arr.map([login.name, ...Rec.keys(login.roles)], (name) =>
			utf8Length(conversionOf(parsedName(name)))
		)
	)
}

/** The length of a schema name whose longest login or role role, `<schema>__<name>`, fills exactly 63 bytes. */
const limitOf = (fixture: Fixture): number => maxIdentifierBytes - 2 - longestRoleName(fixture)

/** The names among `names` a role of the cluster holds. */
const Names = Schema.Array(Schema.Tuple([Schema.String]))

const run = (dir: string, argv: ReadonlyArray<string>, env: Readonly<Record<string, string>>) =>
	cli(dir, argv, nextNow(), env)

const installs = (fixture: Fixture) =>
	Effect.gen(function* () {
		const substrate = yield* Substrate
		const declared = yield* substrate.schemaOfLength("gzlimit", limitOf(fixture))
		const installation = identity.schema(parsedSchemaName(declared))
		const installed = installation.identifier
		const fs = yield* FileSystem.FileSystem
		const dir = yield* workspace(`limit-${fixture.label}`)
		yield* writeConfig(dir, { schemas: [fixture.spec(declared)], connection: viaDatabaseUrl })
		for (const [argv, env] of [
			[["generate"], {}],
			[["check"], {}],
			[["migrate"], urlEnv(substrate.cluster, substrate.database)]
		] as const) {
			const ran = yield* run(dir, argv, env)
			assert.equal(ran.code, 0, `grizzle ${Arr.join(argv, " ")}: ${ran.stderr}`)
		}
		const snapshotFile = `${dir}/migrations/${installed}/snapshot.json`
		assert.ok(
			yield* fs.exists(snapshotFile),
			`the migrations directory is named by the installed schema ${installed}`
		)
		const snapshot = snapshotJson(yield* fs.readFileString(snapshotFile))
		const catalog = yield* readCatalog(substrate.admin, installed)
		assert.equal(catalog.kind, "present", `the schema is installed as ${installed}`)
		const login = fixture.login(declared)
		const loginRole = identity.login(installation, parsedName(login.name)).identifier
		const roles = Arr.map(
			Rec.keys(login.roles),
			(name) => identity.role(installation, parsedName(name)).identifier
		)
		assert.ok(
			Arr.some([loginRole, ...roles], (role) => utf8Length(role) === maxIdentifierBytes),
			"a role fills the identifier"
		)
		const held = yield* Schema.decodeUnknownEffect(Names)(
			yield* substrate.admin.queryValues(
				"SELECT r.rolname::text FROM pg_catalog.pg_roles AS r WHERE r.rolname = ANY ($1::text[]) ORDER BY 1",
				[[loginRole, ...roles]]
			)
		)
		assert.deepEqual(
			Arr.map(held, ([name]) => name),
			Arr.sort([loginRole, ...roles], Order.String),
			"every role exists exactly as named"
		)
		const credentials = yield* substrate.login(loginRole)
		const dbLayer = DbLayer.make({
			login,
			snapshot,
			host: pgPin.host,
			port: pgPin.port,
			database: substrate.database,
			password: credentials.password,
			tls: { ca: substrate.cluster.caPem },
			verify: testVerify
		})
		for (const role of Rec.values(login.roles)) {
			yield* Effect.scoped(Db.open(role, { token: tokenOf({}) })).pipe(withLayer(dbLayer))
		}
	}).pipe(Effect.scoped)

/** One byte past the limit: some login's or role's role would pass 63 bytes, so generate refuses and drafts nothing. */
const refuses = (fixture: Fixture) =>
	Effect.gen(function* () {
		const substrate = yield* Substrate
		const declared = yield* substrate.schemaOfLength("gzlimit", limitOf(fixture) + 1)
		const fs = yield* FileSystem.FileSystem
		const dir = yield* workspace(`past-${fixture.label}`)
		yield* writeConfig(dir, { schemas: [fixture.spec(declared)], connection: viaDatabaseUrl })
		const ran = yield* run(dir, ["generate"], {})
		assert.notEqual(ran.code, 0, "generate refuses a role past the limit")
		assert.ok(
			!(yield* fs.exists(
				`${dir}/migrations/${identity.schema(parsedSchemaName(declared)).identifier}`
			)),
			"generate drafts nothing"
		)
	}).pipe(Effect.scoped)

layer(Layer.merge(Substrate.layer, NodeServices.layer))(
	"logins and roles at the identifier limit, through the command line",
	(it) => {
		it.effect(
			"generate, check and migrate install roles of 63 bytes, and Db.open admits every role of the login, for every fixture",
			(ctx) => searched(ctx, everyFixture("pg/cli/long-names/installs", installs))
		)
		it.effect("generate refuses a schema name one byte longer, for every fixture", (ctx) =>
			searched(ctx, everyFixture("pg/cli/long-names/refuses", refuses))
		)
	}
)
