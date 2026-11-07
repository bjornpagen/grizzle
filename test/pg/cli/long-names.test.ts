import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { type Case, drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, boolean, codePoint, type Gen, option, string } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { searched } from "@grizzle/testing/vitest"
import {
	Array as Arr,
	DateTime,
	Effect,
	FileSystem,
	Formatter,
	Layer,
	Option,
	Order,
	Record as Rec,
	String as Str
} from "effect"
import { Db } from "#adapter/public/db.ts"
import { DbLayer } from "#adapter/public/layer.ts"
import { conversionOf, identity, maxIdentifierBytes } from "#compiler/core/identity.ts"
import { utf8Length } from "#compiler/core/sha256.ts"
import { trusted } from "#compiler/core/trusted.ts"
import { uuid } from "#compiler/public/fields.ts"
import { login, relation, role, schema, wholeEntriesOf } from "#compiler/public/schema.ts"
import { defineConfig } from "#index.ts"
import { cliOver, configName, connectionOf, ownerOn, workspace } from "#test/pg/cli/support.ts"
import { assert } from "#test/support/assert.ts"
import { readCatalog } from "#test/support/catalog/read.ts"
import { parsedName, parsedSchemaName } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { clusterConnection, clusterPool } from "#test/support/pg.ts"
import { snapshotJson } from "#test/support/snapshot-json.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"
import { testVerify, tokenOf } from "#test/support/worlds.ts"

/**
 * On PostgreSQL 19: a login's and its roles' PostgreSQL roles at the identifier limit, through the command line,
 * generated.
 *
 * A login's or role's PostgreSQL role is `<schema>__<name>` (core/identity.ts), which must fit 63 bytes: PostgreSQL
 * would cut a longer one, and Db.open would look for a role no migration created. A case draws a login and one to
 * three roles over one relation, each name lowercase words or camel case, which the naming door converts, so the
 * longest PostgreSQL role is the login's or a role's; and a schema name (substrate/names.ts uniqueSchemaNameOfLength)
 * whose longest role fills exactly 63 bytes, or one byte more. The rule is the oracle:
 *
 * - at 63 bytes, `grizzle generate` drafts, `grizzle check` passes and `grizzle migrate`, with the configuration's
 *   connection, applies it; the login's role and every role exist exactly as named, and Db.open of every role logs in
 *   as the login's role and is admitted, its layer given the committed snapshot;
 * - one byte past, `grizzle generate` refuses the name as too long and drafts nothing.
 */
interface Names {
	readonly login: string
	readonly roles: Arr.NonEmptyReadonlyArray<string>
	readonly past: boolean
}

/** A declared name: lowercase letters, then maybe a capitalized word, which the naming door converts with `_`. */
const nameGen: Gen<string> = (source) => {
	const head = source.draw(string(codePoint(0x61, 0x7a), { min: 1, max: 10 }))
	const tail = source.draw(option(string(codePoint(0x61, 0x7a), { min: 1, max: 6 })))
	return Option.match(tail, {
		onNone: () => head,
		onSome: (t) => `${head}${Str.capitalize(t)}`
	})
}

/** A name's PostgreSQL conversion, as `<schema>__<conversion>` ends. */
const converted = (name: string): string => conversionOf(parsedName(name))

/** The login's name and its roles' names, every conversion apart from every other. */
const namesGen: Gen<Names> = (source) => {
	const loginName = source.draw(nameGen)
	const drawnRoles = source.draw(array(nameGen, { min: 1, max: 3 }))
	const roles = Arr.reduce(drawnRoles, Arr.empty<string>(), (kept, name) =>
		Arr.some([loginName, ...kept], (other) => converted(other) === converted(name))
			? kept
			: [...kept, name]
	)
	return {
		login: loginName,
		roles: Arr.isReadonlyArrayNonEmpty(roles) ? roles : [`${loginName}x`],
		past: source.draw(boolean)
	}
}

type LimitFeature =
	| "the login's role the longest"
	| "a role's role the longest"
	| "a converted camel-case name"
	| "at the limit"
	| "one byte past"

/** The longest conversion among the login's name and its roles' names. */
const longest = (n: Names): number =>
	Arr.reduce([n.login, ...n.roles], 0, (most, name) => Math.max(most, utf8Length(converted(name))))

/** The world a case's names declare: one relation, each role reading it whole, every role in the login. */
const worldOf = (declared: string, n: Names) => {
	const base = schema(declared, { Item: relation("Item", { id: uuid }, ["id"]) }, [])
	const roles = Arr.map(n.roles, (name) => role(base, name, wholeEntriesOf(base)))
	return { schema: base, login: login(base, n.login, roles) }
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

const notesOf = (n: Names): ReadonlyArray<LimitFeature> => [
	n.past ? "one byte past" : "at the limit",
	utf8Length(converted(n.login)) === longest(n)
		? "the login's role the longest"
		: "a role's role the longest",
	...(Arr.some([n.login, ...n.roles], (name) => Str.includes("_")(converted(name)))
		? (["a converted camel-case name"] as const)
		: [])
]

const limitCase = (n: Names, c: Case<LimitFeature>) =>
	Effect.scoped(
		Effect.gen(function* () {
			c.noteAll(notesOf(n))
			const substrate = yield* Substrate
			const length = maxIdentifierBytes.value - 2 - longest(n) + (n.past ? 1 : 0)
			const declared = yield* substrate.schemaOfLength("gzlimit", length)
			const installation = identity.schema(parsedSchemaName(declared))
			const installed = installation.identifier
			const world = worldOf(declared, n)
			const fs = yield* FileSystem.FileSystem
			const dir = yield* workspace("limit")
			const config = defineConfig({
				schemas: [world.schema],
				logins: [world.login],
				migrations: "migrations",
				connection: connectionOf(substrate.cluster, ownerOn(substrate.database))
			})
			const run = (command: string) => cliOver(dir, config, [command, configName], at)
			if (n.past) {
				const ran = yield* run("generate")
				const report = ran.report
				assert.ok(
					report.outcome === "refused" &&
						report.refusal._tag === "CliError" &&
						report.refusal.reason._tag === "DraftRefused" &&
						report.refusal.reason.error.reason._tag === "RoleNameTooLong",
					`generate refuses a role past the limit: ${ran.stderr}`
				)
				const drafted = yield* fs.exists(`${dir}/migrations/${installed}`)
				assert.ok(!drafted, "generate drafts nothing")
				return
			}
			for (const command of ["generate", "check", "migrate"]) {
				const ran = yield* run(command)
				assert.equal(ran.code, 0, `grizzle ${command}: ${ran.stderr}`)
			}
			const text = yield* fs.readFileString(`${dir}/migrations/${installed}/snapshot.json`)
			const catalog = yield* readCatalog(substrate.admin, installed)
			assert.equal(catalog.kind, "present", `the schema is installed as ${installed}`)
			const loginRole = identity.login(installation, parsedName(n.login)).identifier
			const roles = Arr.map(
				n.roles,
				(name) => identity.role(installation, parsedName(name)).identifier
			)
			assert.ok(
				Arr.some([loginRole, ...roles], (r) => utf8Length(r) === maxIdentifierBytes.value),
				"a role fills the identifier"
			)
			const heldRows = yield* substrate.admin.queryValues(
				"SELECT r.rolname::text FROM pg_catalog.pg_roles AS r WHERE r.rolname = ANY ($1::text[]) ORDER BY 1",
				[[loginRole, ...roles]]
			)
			assert.deepEqual(
				Arr.map(trusted<ReadonlyArray<readonly [string]>>(heldRows), ([held]) => held),
				Arr.sort([loginRole, ...roles], Order.String),
				"every role exists exactly as named"
			)
			const credentials = yield* substrate.login(loginRole)
			const dbLayer = DbLayer.make({
				...clusterConnection(substrate.cluster, substrate.database, credentials.password),
				pool: clusterPool,
				login: world.login,
				snapshot: snapshotJson(text),
				verify: testVerify
			})
			for (const r of Rec.values(world.login.roles)) {
				yield* Effect.scoped(Db.open(r, { token: tokenOf({}) })).pipe(withLayer(dbLayer))
			}
		})
	)

layer(Layer.merge(Substrate.layer, NodeServices.layer))(
	"logins and roles at the identifier limit, through the command line",
	(it) => {
		it.effect(
			"install roles of exactly 63 bytes, each admitted by Db.open, and refuse a schema name one byte longer, for drawn logins and roles",
			(ctx) =>
				searched(
					ctx,
					explore(
						{
							suite: "pg/cli/long-names",
							draw: drawn(namesGen),
							literal: Formatter.format,
							oracle: {
								kind: "specification",
								name: "the 63-byte rule for <schema>__<name>, and PostgreSQL's own roles"
							},
							coverage: required<LimitFeature>(
								[
									"the login's role the longest",
									"a role's role the longest",
									"a converted camel-case name",
									"at the limit",
									"one byte past"
								],
								{ cases: 16, sense: notesOnly }
							),
							kept: [],
							runs: 4,
							shrink: { kind: "bounded", candidates: 20 },
							concurrency: 1,
							steerEvery: 16,
							caseHang
						},
						limitCase
					)
				)
		)
	}
)
