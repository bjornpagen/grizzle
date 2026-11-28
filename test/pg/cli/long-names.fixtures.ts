/** What the properties of long-names.test.ts read: its spaces, models and helpers. */

import { utf8Length } from "@bjornpagen/grizzle-text/utf8"
import {
	array,
	boolean,
	codePoint,
	element,
	type Gen,
	option,
	string
} from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import {
	Array as Arr,
	Effect,
	FileSystem,
	Option,
	Order,
	Record as Rec,
	String as Str
} from "effect"
import { Db } from "#adapter/public/db.ts"
import { roleNameOf } from "#adapter/served/served.ts"
import { maxIdentifierBytes, conversionOf } from "#compiler/core/identity.ts"
import { trusted } from "#compiler/core/trusted.ts"

import { assert } from "@bjornpagen/testing/assert"
import {
	type AnyLogin,
	type AnyRole,
	login,
	relation,
	role,
	schema,
	schemaNameOf,
	wholeSchemaNameOf,
	wholeEntriesOf
} from "#compiler/public/schema.ts"
import { defineConfig } from "#index.ts"
import { throwsRefused } from "#test/support/assert.ts"
import { readCatalog } from "#test/support/catalog/read.ts"
import { Id } from "#test/support/ids.ts"
import { parsedName } from "#test/support/kernel/naming.ts"
import {
	cliOver,
	configName,
	connectionOf,
	ownerOn,
	servedFromFile,
	workspace
} from "#test/support/pg/cli/support.ts"
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
export const namesGen: Gen<Names> = (source) => {
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

export type LimitFeature =
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
	const base = schema(declared, [relation("Item", { id: Id }, ["id"])], [])
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

const notesOf = (n: Names): ReadonlyArray<LimitFeature> => [
	n.past ? "one byte past" : "at the limit",
	utf8Length(converted(n.login)) === longest(n)
		? "the login's role the longest"
		: "a role's role the longest",
	...(Arr.some([n.login, ...n.roles], (name) => Str.includes("_")(converted(name)))
		? (["a converted camel-case name"] as const)
		: [])
]

export const limitCase = (n: Names, c: Case<LimitFeature>) =>
	Effect.scoped(
		Effect.gen(function* () {
			c.noteAll(notesOf(n))
			const substrate = yield* Substrate
			const length = maxIdentifierBytes - 2 - longest(n) + (n.past ? 1 : 0)
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
				rolePrefixBytes: 0,
				connection: () =>
					connectionOf(substrate.cluster, ownerOn(substrate.cluster, substrate.database))
			})
			const run = (command: string) => cliOver(dir, config, [command, configName])
			if (n.past) {
				const ran = yield* run("generate")
				const report = ran.report
				assert.ok(
					report.outcome === "refused" &&
						report.refusal._tag === "CliError" &&
						report.refusal.reason._tag === "DraftRefused" &&
						report.refusal.reason.error.reason._tag === "IdentifierTooLong",
					`generate refuses a role past the limit: ${ran.stderr}`
				)
				const drafted = yield* fs.exists(`${dir}/migrations/${allocated}`)
				assert.ok(!drafted, "generate drafts nothing")
				for (const w of worlds) {
					const bytes = utf8Length(allocated) + 2 + utf8Length(converted(w.name))
					if (bytes > maxIdentifierBytes) {
						throwsRefused(
							() => roleNameOf(w.world, {}),
							"IdentifierTooLong",
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
				Arr.some([loginRole, ...roles], (r) => utf8Length(r) === maxIdentifierBytes),
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
				"SELECT n.nspname::text FROM pg_catalog.pg_namespace AS n WHERE starts_with(n.nspname::text, $1::text) OR n.nspname::text = $2::text ORDER BY 1",
				[rolePrefix(allocated), wholeSchemaNameOf(world.schema)]
			)
			const heldSchemas = trusted<ReadonlyArray<readonly [string]>>(schemaRows)
			assert.deepEqual(
				Arr.map(heldSchemas, ([held]) => held),
				[wholeSchemaNameOf(world.schema)],
				"its roles hold whole entries alone, so it holds no role's schema, and wholeSchemaNameOf names the schema of the whole views they read"
			)
			const servedLogin = yield* servedFromFile(dir, allocated, world.login)
			for (const r of Rec.values(servedLogin.login.roles)) {
				yield* Effect.scoped(Db.open(r, { token: tokenOf({}) })).pipe(withLayer(servedLogin.layer))
			}
		})
	)
