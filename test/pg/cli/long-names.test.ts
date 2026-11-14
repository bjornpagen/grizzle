/**
 * On PostgreSQL 19: a login's and its roles' PostgreSQL roles and schemas as the installation names them, at the
 * identifier limit, through the command line, generated.
 *
 * A login's or role's PostgreSQL role joins its schema's name and its own (core/identity.ts), and must fit 63 bytes:
 * PostgreSQL would cut a longer one, and Db.open would look for a role no migration created. A caller never spells one:
 * roleNameOf and schemaNameOf (program/names.ts) name each from its value. A case draws a login and one to three roles
 * over one relation, each name lowercase words or camel case, which the naming door converts, so the longest
 * PostgreSQL role is the login's or a role's; a schema name (substrate/names.ts uniqueSchemaNameOfLength) whose longest
 * role fills exactly 63 bytes, or one byte more; and a spelling of the schema's declared name, each of its letter
 * segments lowercase, capitalized or in capitals, which converts back to the allocation. The rule and the catalog are
 * the oracles:
 *
 * - schemaNameOf of the schema is the allocation, however its declared name is spelled;
 * - at 63 bytes, `grizzle generate` drafts, `grizzle check` passes and `grizzle migrate`, with the configuration's
 *   connection, applies it; the installed schema is the allocation; the roles the catalog holds under the allocation
 *   are exactly roleNameOf of the login, which alone logs in, and of every role, and the schemas it holds there exactly
 *   schemaNameOf of every role; and Db.open of every role, its layer given the served file generate wrote and the
 *   password of roleNameOf of the login, logs in and is admitted;
 * - one byte past, `grizzle generate` refuses the name as too long and drafts nothing, and roleNameOf refuses
 *   (RoleNameTooLong) exactly the worlds whose role passes 63 bytes.
 *
 * Features: the login's role the longest and a role's, a converted camel-case name, a schema spelled apart from its
 * conversion, at the limit and one byte past.
 *
 * Plants (~/.cache/grizzle-release/BR13/plants): long-names-limit-off-by-one.patch (the 63-byte rule admitting 64).
 */
import { type Case, drawn, explore } from "@bjornpagen/testing/explore"
import { required } from "@bjornpagen/testing/features"
import {
	array,
	boolean,
	codePoint,
	element,
	type Gen,
	option,
	string
} from "@bjornpagen/testing/gen"
import { notesOnly } from "@bjornpagen/testing/sense"
import { searched } from "@bjornpagen/testing/vitest"
import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
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
import { roleNameOf } from "#adapter/served/served.ts"
import { conversionOf, maxIdentifierBytes } from "#compiler/core/identity.ts"
import { utf8Length } from "#compiler/core/sha256.ts"
import { trusted } from "#compiler/core/trusted.ts"
import { uuid } from "#compiler/public/fields.ts"
import {
	type AnyLogin,
	type AnyRole,
	login,
	relation,
	role,
	schema,
	schemaNameOf,
	wholeEntriesOf
} from "#compiler/public/schema.ts"
import { defineConfig } from "#index.ts"
import {
	cliOver,
	configName,
	connectionOf,
	ownerOn,
	servedFromFile,
	workspace
} from "#test/pg/cli/support.ts"
import { assert, throwsRefused } from "#test/support/assert.ts"
import { readCatalog } from "#test/support/catalog/read.ts"
import { parsedName } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { rolePrefix } from "#test/support/substrate/names.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"
import { tokenOf } from "#test/support/worlds.ts"

interface Names {
	readonly login: string
	readonly roles: Arr.NonEmptyReadonlyArray<string>
	readonly past: boolean
	readonly spellings: Arr.NonEmptyReadonlyArray<Spelling>
}

/** How a letter segment of the schema's declared name is written: each converts to the segment in lowercase. */
type Spelling = "lowercase" | "capitalized" | "capitals"

const spellingGen: Gen<Spelling> = element<Spelling>(["lowercase", "capitalized", "capitals"])

const spelled: { readonly [S in Spelling]: (segment: string) => string } = {
	lowercase: (segment) => segment,
	capitalized: Str.capitalize,
	capitals: Str.toUpperCase
}

/** The allocation's spelling: its i-th letter segment written as the i-th spelling, cycling; digits as they are. */
const spell = (allocated: string, spellings: Arr.NonEmptyReadonlyArray<Spelling>): string =>
	Arr.join(
		Arr.map(Str.split("_")(allocated), (segment, i) =>
			spelled[Arr.getUnsafe(spellings, i % spellings.length)](segment)
		),
		"_"
	)

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
		past: source.draw(boolean),
		spellings: [source.draw(spellingGen), ...source.draw(array(spellingGen, { min: 0, max: 2 }))]
	}
}

type LimitFeature =
	| "the login's role the longest"
	| "a role's role the longest"
	| "a converted camel-case name"
	| "a schema spelled apart from its conversion"
	| "at the limit"
	| "one byte past"

/** The longest conversion among the login's name and its roles' names. */
const longest = (n: Names): number =>
	Arr.reduce([n.login, ...n.roles], 0, (most, name) => Math.max(most, utf8Length(converted(name))))

/** The world a case's names declare: one relation, each role reading it whole, every role in the login. */
const worldOf = (declared: string, n: Names) => {
	const base = schema(declared, [relation("Item", { id: uuid }, ["id"])], [])
	const roles = Arr.map(n.roles, (name) => role(base, name, wholeEntriesOf(base)))
	return { schema: base, roles, login: login(base, n.login, roles) }
}

/** The declared name of a login or role, and the value it declares. */
interface Declared {
	readonly name: string
	readonly world: AnyLogin | AnyRole
}

/** The role names of `rows` that can log in, or that cannot, sorted: each row a name and its rolcanlogin as text. */
const loginColumn = (rows: ReadonlyArray<readonly [string, string]>, logins: boolean) =>
	Arr.sort(
		Arr.map(
			Arr.filter(rows, ([, canLogin]) => (canLogin === "true") === logins),
			([name]) => name
		),
		Order.String
	)

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
			const allocated = yield* substrate.schemaOfLength("gzlimit", length)
			const declared = spell(allocated, n.spellings)
			if (declared !== allocated) {
				c.note("a schema spelled apart from its conversion")
			}
			const world = worldOf(declared, n)
			assert.equal(schemaNameOf(world.schema), allocated, "schemaNameOf names the allocation")
			const worlds: ReadonlyArray<Declared> = [
				{ name: n.login, world: world.login },
				...Arr.zipWith(n.roles, world.roles, (name, value) => ({ name, world: value }))
			]
			const fs = yield* FileSystem.FileSystem
			const dir = yield* workspace("limit")
			const config = defineConfig({
				schemas: [world.schema],
				logins: [world.login],
				migrations: "migrations",
				connection: () => connectionOf(substrate.cluster, ownerOn(substrate.database))
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
				const drafted = yield* fs.exists(`${dir}/migrations/${allocated}`)
				assert.ok(!drafted, "generate drafts nothing")
				for (const w of worlds) {
					const bytes = utf8Length(allocated) + 2 + utf8Length(converted(w.name))
					if (bytes > maxIdentifierBytes.value) {
						throwsRefused(
							() => roleNameOf(w.world, {}),
							"RoleNameTooLong",
							`${w.name} past the limit`
						)
					} else {
						assert.equal(utf8Length(roleNameOf(w.world, {})), bytes, `roleNameOf names ${w.name}`)
					}
				}
				return
			}
			for (const command of ["generate", "check", "migrate"]) {
				const ran = yield* run(command)
				assert.equal(ran.code, 0, `grizzle ${command}: ${ran.stderr}`)
			}
			const catalog = yield* readCatalog(substrate.admin, [allocated])
			assert.equal(catalog.kind, "present", `the schema is installed as ${allocated}`)
			const loginRole = roleNameOf(world.login, {})
			const roles = Arr.map(world.roles, (role) => roleNameOf(role, {}))
			assert.ok(
				Arr.some([loginRole, ...roles], (r) => utf8Length(r) === maxIdentifierBytes.value),
				"a role fills the identifier"
			)
			const roleRows = yield* substrate.admin.queryValues(
				"SELECT r.rolname::text, r.rolcanlogin::text FROM pg_catalog.pg_roles AS r WHERE starts_with(r.rolname::text, $1::text)",
				[rolePrefix(allocated)]
			)
			const heldRoles = trusted<ReadonlyArray<readonly [string, string]>>(roleRows)
			assert.deepEqual(
				loginColumn(heldRoles, true),
				[loginRole],
				"roleNameOf names the one login role"
			)
			assert.deepEqual(
				loginColumn(heldRoles, false),
				Arr.sort(roles, Order.String),
				"roleNameOf names every role the installation holds, and only those"
			)
			const schemaRows = yield* substrate.admin.queryValues(
				"SELECT n.nspname::text FROM pg_catalog.pg_namespace AS n WHERE starts_with(n.nspname::text, $1::text)",
				[rolePrefix(allocated)]
			)
			const heldSchemas = trusted<ReadonlyArray<readonly [string]>>(schemaRows)
			assert.deepEqual(
				Arr.sort(
					Arr.map(heldSchemas, ([held]) => held),
					Order.String
				),
				Arr.sort(Arr.map(world.roles, schemaNameOf), Order.String),
				"schemaNameOf names every role's schema the installation holds, and only those"
			)
			const servedLogin = yield* servedFromFile(dir, allocated, world.login)
			for (const r of Rec.values(servedLogin.login.roles)) {
				yield* Effect.scoped(Db.open(r, { token: tokenOf({}) })).pipe(withLayer(servedLogin.layer))
			}
		})
	)

layer(Layer.merge(Substrate.layer, NodeServices.layer))(
	"logins and roles at the identifier limit, through the command line",
	(it) => {
		it.effect(
			"install roles of exactly 63 bytes, each the one roleNameOf names and admitted by Db.open, and refuse a schema name one byte longer, for drawn logins, roles and schema spellings",
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
								name: "the 63-byte rule for <schema>__<name>, and PostgreSQL's own roles and schemas"
							},
							coverage: required<LimitFeature>(
								[
									"the login's role the longest",
									"a role's role the longest",
									"a converted camel-case name",
									"a schema spelled apart from its conversion",
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
