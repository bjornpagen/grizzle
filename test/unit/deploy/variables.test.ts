/**
 * The variables of a drafted migration and their filling (deploy/render/variables.ts resolveVariables), over every statement
 * `grizzle generate` drafts, with no database.
 *
 * A case draws the shop's declared schema name (test/pg/cli/fixture.ts shopV1: the login `server` and its roles
 * `reader` and `writer`, with its workloads), a role space (none or a prefix), a database name, and a variable name
 * of drawn characters. It drafts the first migration through the command line's generate, offline, and reads every
 * statement of every file of the folder as migrate reads them (deploy/render/markers.ts splitStatements).
 *
 * Properties, each against its oracle:
 * - Byte identity of the default: each statement filled under no prefix, its database named DBNAME, is the statement
 *   with the colon of each variable deleted, psql's interpolation of a variable whose value is its name: the printer's
 *   spelling of every role as `"<stem>"` before roles were variables, quoteIdent of the stem at every variable.
 * - A prefix: each statement filled under a prefix p is the statement with each role variable `:"x"` spelled
 *   `"<p>__x"` and the database variable spelled as the database's quoted name, and no variable is left.
 * - Roles are variables: the roles the folder's CREATE ROLEs name are exactly the variables of roleNameOf's stems of
 *   the login and its roles and of the installation's decoder login, the name of its live source (identity.liveSource
 *   of its root), which the shop's reads give it, and no CREATE ROLE names a role any other way.
 * - The variables are DBNAME and a role's names: a statement naming the variable `:"<name>"` under the drawn role space
 *   is filled exactly when the name is DBNAME, a stem (two conversions joined by `__`: lowercase ASCII words, a letter
 *   first, joined by single underscores), the name a migration sets a role aside under while it renames logins
 *   (`__aside`, its stem's words, `_` and ten characters of lowercase base32, at most 63 bytes) or the installation's
 *   live source's, its decoder login's (`__live`, its root's words, `_` and ten characters of lowercase base32, at most
 *   63 bytes); a role's name is filled as `"<p>__<name>"` under a prefix p, and refused as roleTooLong past 63 bytes;
 *   any other name is refused as unknownVariable. A drawn aside name is the naming door's own for a drawn stem
 *   (identity.aside), and a drawn live source's name its own for a drawn root (identity.liveSource).
 *
 * Features: a prefix and none, a capitalized schema spelling, an unknown variable, a stem variable, an aside variable,
 * a live source variable.
 *
 * Plants (~/.cache/grizzle-release/ROLESPACE/plants): create-role-printed-plain.patch (a CREATE ROLE prints its role by
 * its stem), prefix-applied-twice.patch (a role variable filled with the prefix twice), database-variable-misfilled.patch
 * (the database variable filled with a role's name).
 */
import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { type Case, drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, codePoint, element, type Gen, option, string } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { searched } from "@grizzle/testing/vitest"
import { regex } from "arkregex"
import {
	Array as Arr,
	DateTime,
	Effect,
	FileSystem,
	Formatter,
	Option,
	Order,
	String as Str
} from "effect"
import { roleNameOf } from "#adapter/served/served.ts"
import {
	conversionOf,
	identifierOf,
	identity,
	parseRolePrefix,
	type RoleSpace
} from "#compiler/core/identity.ts"
import { splitStatements } from "#compiler/deploy/render/markers.ts"
import { resolveVariables } from "#compiler/deploy/render/variables.ts"
import { quoteIdent } from "#compiler/sql/print.ts"
import { defineConfig } from "#index.ts"
import { shopV1 } from "#test/pg/cli/fixture.ts"
import { cliOver, configName, offlineOwner, workspace } from "#test/pg/cli/support.ts"
import { assert } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"

type Spelling = "lowercase" | "capitalized" | "capitals"

const spelled: { readonly [S in Spelling]: (segment: string) => string } = {
	lowercase: (segment) => segment,
	capitalized: Str.capitalize,
	capitals: Str.toUpperCase
}

/** Lowercase words joined by single underscores, each spelled as drawn, the first ending in `x` so none is `pg`. */
const wordsGen: Gen<string> = (source) => {
	const words = [
		`${source.draw(string(codePoint(0x61, 0x7a), { min: 1, max: 5 }))}x`,
		...source.draw(array(string(codePoint(0x61, 0x7a), { min: 1, max: 4 }), { min: 0, max: 2 }))
	]
	return Arr.join(
		Arr.map(words, (w) =>
			spelled[source.draw(element<Spelling>(["lowercase", "capitalized", "capitals"]))](w)
		),
		"_"
	)
}

interface Drafting {
	readonly schema: string
	readonly prefix: Option.Option<string>
	readonly database: string
	readonly variable: string
}

/** A word of lowercase letters. */
const wordGen: Gen<string> = string(codePoint(0x61, 0x7a), { min: 1, max: 5 })

/** A variable's name as `kind` draws it. */
const variableGen =
	(kind: VariableKind): Gen<string> =>
	(source) => {
		switch (kind) {
			case "stem":
				return `${source.draw(wordGen)}__${source.draw(wordGen)}`
			case "aside":
				return identity.aside(
					`${source.draw(wordGen)}__${Arr.join(source.draw(array(wordGen, { min: 1, max: 14 })), "_")}`
				).identifier
			case "live":
				return identity.liveSource(Arr.join(source.draw(array(wordGen, { min: 1, max: 14 })), "_"))
					.identifier
			case "database":
				return "DBNAME"
			case "drawn":
				return source.draw(
					string(element(["a", "b", "z", "1", "_", "A", "D", "B", "N", "M", "E", '"']), {
						min: 1,
						max: 10
					})
				)
		}
	}

const draftingGen: Gen<Drafting> = (source) => ({
	schema: source.draw(wordsGen),
	prefix: Option.map(source.draw(option(wordsGen)), Str.toLowerCase),
	database: source.draw(string(codePoint(0x61, 0x7a), { min: 1, max: 12 })),
	variable: source.draw(
		variableGen(source.draw(element<VariableKind>(["stem", "aside", "live", "database", "drawn"])))
	)
})

/**
 * How a case's variable is drawn: a stem's shape, a stem's aside name, a root's live source name, DBNAME's letters, or
 * any characters.
 */
type VariableKind = "stem" | "aside" | "live" | "database" | "drawn"

type DraftFeature =
	| "a prefix"
	| "no prefix"
	| "a capitalized schema spelling"
	| "an unknown variable"
	| "a stem variable"
	| "an aside variable"
	| "a live source variable"

/** One lowercase conversion: a letter, then letters and digits, in words joined by single underscores. */
const conversion = regex("^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$")

/** A name a migration sets a role aside under, by the specification: `__aside`, words, `_` and a ten-character digest. */
const asideName = regex("^__aside(?:_[a-z0-9]+)*_[a-z2-7]{10}$")

/** Whether a variable's name is an aside name by the specification, within PostgreSQL's 63 bytes. */
const isAside = (name: string): boolean => asideName.test(name) && name.length <= 63

/** A live source's name, by the specification: `__live`, words, `_` and a ten-character digest. */
const liveName = regex("^__live(?:_[a-z0-9]+)*_[a-z2-7]{10}$")

/** Whether a variable's name is a live source's name by the specification, within PostgreSQL's 63 bytes. */
const isLive = (name: string): boolean => liveName.test(name) && name.length <= 63

/** The feature a role variable's name notes: the form the specification reads it in. */
const roleFeature = (name: string): DraftFeature =>
	isStem(name) ? "a stem variable" : isAside(name) ? "an aside variable" : "a live source variable"

/** Whether a variable's name is a stem by the specification: two conversions joined by `__`. */
const isStem = (name: string): boolean =>
	Option.match(Str.indexOf("__")(name), {
		onNone: () => false,
		onSome: (at) =>
			at > 0 && conversion.test(Str.slice(0, at)(name)) && conversion.test(Str.slice(at + 2)(name))
	})

/** `statement` with each variable `:"<name>"` spelled as `spell` spells its name: psql's interpolation of it. */
const interpolated = (statement: string, spell: (name: string) => string): string => {
	let out = ""
	let from = 0
	for (const m of Str.matchAll(variables)(statement)) {
		const start = m.index ?? from
		out += `${Str.slice(from, start)(statement)}${spell(m[1] ?? "")}`
		from = start + m[0].length
	}
	return `${out}${Str.slice(from)(statement)}`
}

/** Each variable of a drafted statement: a colon no colon precedes, before a double quote, and its name. */
const variables = regex('(?<!:):"([^"]*)"', "g")

/** A drafted folder's name: its 14-digit timestamp, then its name. */
const folderName = regex("^[0-9]{14}_")

/** A CREATE ROLE statement's role, as it is written. */
const createdRole = regex("^\\s*CREATE ROLE (\\S+)", "m")

const at = DateTime.makeUnsafe({
	year: 2026,
	month: 11,
	day: 11,
	hour: 12,
	minute: 0,
	second: 0,
	millisecond: 0
})

const draftCase = (d: Drafting, c: Case<DraftFeature>) =>
	Effect.scoped(
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const shop = shopV1(d.schema, "full")
			const dir = yield* workspace("variables")
			const config = defineConfig({
				schemas: [shop.schema],
				logins: [shop.server],
				migrations: "migrations",
				connection: () => offlineOwner
			})
			const ran = yield* cliOver(dir, config, ["generate", configName], at)
			assert.equal(ran.code, 0, `grizzle generate: ${ran.stderr}`)
			if (d.schema !== Str.toLowerCase(d.schema)) {
				c.note("a capitalized schema spelling")
			}
			const root = `${dir}/migrations/${conversionOf(d.schema)}`
			const entries = yield* fs.readDirectory(root)
			const statements: Array<string> = []
			for (const folder of Arr.filter(entries, (f) => folderName.test(f))) {
				const files = yield* fs.readDirectory(`${root}/${folder}`)
				for (const file of Arr.filter(files, Str.endsWith(".sql"))) {
					const text = yield* fs.readFileString(`${root}/${folder}/${file}`)
					for (const statement of splitStatements(text)) {
						statements.push(statement)
					}
				}
			}
			assert.ok(statements.length > 0, "the folder holds statements")
			const space: RoleSpace = Option.match(d.prefix, {
				onNone: () => ({ kind: "stems" }),
				onSome: (p) => {
					const parsed = parseRolePrefix(p)
					return parsed.ok ? { kind: "prefixed", prefix: parsed.value } : { kind: "stems" }
				}
			})
			c.note(space.kind === "prefixed" ? "a prefix" : "no prefix")
			for (const statement of statements) {
				const plain = resolveVariables(statement, { database: "DBNAME", roles: { kind: "stems" } })
				assert.ok(plain.ok, `the statement fills under no prefix: ${statement}`)
				assert.equal(
					plain.value,
					interpolated(statement, quoteIdent),
					"filled under no prefix, each variable is its name quoted"
				)
				const filled = resolveVariables(statement, { database: d.database, roles: space })
				assert.ok(filled.ok, `the statement fills under the space: ${statement}`)
				assert.equal(
					filled.value,
					interpolated(statement, (name) =>
						name === "DBNAME"
							? quoteIdent(d.database)
							: quoteIdent(space.kind === "prefixed" ? `${space.prefix}__${name}` : name)
					),
					"filled under the space, each role variable is its role and the database's its name"
				)
			}
			const created = Arr.sort(
				Arr.flatMap(statements, (s) => {
					const m = createdRole.exec(s)
					return m?.[1] === undefined ? [] : [m[1]]
				}),
				Order.String
			)
			assert.deepEqual(
				created,
				Arr.sort(
					[
						...Arr.map(
							[shop.server, shop.reader, shop.writer],
							(w) => `:${quoteIdent(roleNameOf(w, {}))}`
						),
						`:${quoteIdent(identifierOf(identity.liveSource(conversionOf(d.schema))))}`
					],
					Order.String
				),
				"every CREATE ROLE names a stem of the login or its roles, or the decoder login, by its variable"
			)
			const probe = resolveVariables(`SELECT :${quoteIdent(d.variable)}`, {
				database: d.database,
				roles: space
			})
			const role = space.kind === "prefixed" ? `${space.prefix}__${d.variable}` : d.variable
			if (isStem(d.variable) || isAside(d.variable) || isLive(d.variable)) {
				c.note(roleFeature(d.variable))
				assert.deepEqual(
					probe,
					role.length <= 63
						? { ok: true, value: `SELECT ${quoteIdent(role)}` }
						: { ok: false, error: { kind: "roleTooLong", name: d.variable, role, limit: 63 } },
					`the role's name ${d.variable} fills as its role under the space`
				)
			} else if (d.variable === "DBNAME") {
				assert.deepEqual(
					probe,
					{ ok: true, value: `SELECT ${quoteIdent(d.database)}` },
					"DBNAME fills as the database"
				)
			} else {
				c.note("an unknown variable")
				assert.deepEqual(
					probe,
					{ ok: false, error: { kind: "unknownVariable", name: d.variable } },
					`the variable ${d.variable} is neither DBNAME nor a role's name, refused as unknown`
				)
			}
		})
	)

layer(NodeServices.layer)("the variables of a drafted migration", (it) => {
	it.effect(
		"fill every drafted statement under each drawn role space as psql interpolates it, byte for byte under none, name every created role by its variable, and refuse every variable that is neither DBNAME nor a role's stem, aside or live source name",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/deploy/variables",
						draw: drawn(draftingGen),
						literal: Formatter.format,
						oracle: {
							kind: "specification",
							name: "psql's identifier interpolation, each variable its role under the space"
						},
						coverage: required<DraftFeature>(
							[
								"a prefix",
								"no prefix",
								"a capitalized schema spelling",
								"an unknown variable",
								"a stem variable",
								"an aside variable",
								"a live source variable"
							],
							{ cases: 16, sense: notesOnly }
						),
						kept: [],
						runs: 24,
						shrink: { kind: "bounded", candidates: 20 },
						concurrency: 1,
						steerEvery: 8,
						caseHang
					},
					draftCase
				)
			)
	)
})
