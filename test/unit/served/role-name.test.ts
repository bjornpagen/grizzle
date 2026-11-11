/**
 * The one roleNameOf: a login's, a role's and a served login's PostgreSQL role under an installation's role space,
 * with no database.
 *
 * A case draws a schema's declared name (its letter segments lowercase, capitalized or in capitals), a login and one or
 * two roles over one relation (names of lowercase words or camel case, every conversion apart), and two role spaces:
 * each none or a role prefix (lowercase words and digit runs joined by single underscores, as `gr8des_qti_pin` is
 * written), the two apart. The login is
 * compiled as `grizzle generate` compiles it (test/support/served-login.ts compiledLogin) and its file served as an
 * application serves it (adapter/served/served.ts served).
 *
 * Properties, each against its oracle:
 * - Default oracle: under no prefix, roleNameOf of the login and of each role is the naming door's identity of it
 *   (core/identity.ts identity.login, identity.role, under identity.schema of the parsed schema name), and under a
 *   prefix p, `<p>__<that identity>`, the prefix verbatim: the specification of a role space, spelled here apart from
 *   the function under test.
 * - One function: connectionOf, a connection builder that takes an authoring login or a served login, names both by
 *   the one roleNameOf, and both name the same role; each served role's stem under the space is roleNameOf of its
 *   authoring role, the role a served layer takes on.
 * - Disjoint: the two spaces' roles share no name.
 * - Bound: a prefix whose longest role passes 63 bytes is refused (RoleNameTooLong), and one that fills 63 exactly is
 *   not.
 *
 * Features: a prefix and none, two prefixes, a capitalized spelling, a camel-case name, a prefix at the limit and one
 * byte past.
 *
 * Plants (~/.cache/grizzle-release/ROLESPACE/plants): stem-not-the-door.patch (login(...) computes its stem from the
 * declared names as written, not their conversions), runtime-ignores-prefix.patch, role-prefix-converted.patch (the
 * prefix converted as a declared name, `gr8des` installing as `gr_8_des`).
 */
import { describe, it } from "@effect/vitest"
import { type Case, drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, boolean, codePoint, element, type Gen, option, string } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Result, String as Str } from "effect"
import { served } from "#adapter/public/layer.ts"
import { roleNameOf } from "#adapter/served/served.ts"
import type { ServedLogin } from "#adapter/types/layer.ts"
import {
	conversionOf,
	identifierOf,
	identity,
	roleInSpace,
	maxIdentifierBytes,
	type RoleInstallation,
	roleSpaceOf
} from "#compiler/core/identity.ts"
import { utf8Length } from "#compiler/core/sha256.ts"
import { firstCodebook } from "#compiler/ir/codes.ts"
import { uuid } from "#compiler/public/fields.ts"
import {
	type AnyLogin,
	login,
	relation,
	role,
	schema,
	wholeEntriesOf
} from "#compiler/public/schema.ts"
import { rostersOf } from "#compiler/schema/own.ts"
import { assert, throwsRefused } from "#test/support/assert.ts"
import { parsedName, parsedSchemaName } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { compiledLogin } from "#test/support/served-login.ts"

/** How a letter segment of a declared name is written: each converts to the segment in lowercase. */
type Spelling = "lowercase" | "capitalized" | "capitals"

const spelled: { readonly [S in Spelling]: (segment: string) => string } = {
	lowercase: (segment) => segment,
	capitalized: Str.capitalize,
	capitals: Str.toUpperCase
}

/** Lowercase words joined by single underscores, each segment spelled as drawn. */
const wordsGen: Gen<string> = (source) => {
	const words = [
		`${source.draw(string(codePoint(0x61, 0x7a), { min: 1, max: 5 }))}x`,
		...source.draw(array(string(codePoint(0x61, 0x7a), { min: 1, max: 5 }), { min: 0, max: 2 }))
	]
	return Arr.join(
		Arr.map(words, (w) =>
			spelled[source.draw(element<Spelling>(["lowercase", "capitalized", "capitals"]))](w)
		),
		"_"
	)
}

/**
 * A role prefix as a connection gives one, used verbatim: lowercase words and digit runs joined by single underscores,
 * a letter first and never the reserved `pg` segment, so `gr8des_qti_pin` is drawn as it is written.
 */
const prefixGen: Gen<string> = (source) =>
	Arr.join(
		[
			`${source.draw(string(codePoint(0x61, 0x7a), { min: 1, max: 4 }))}x${source.draw(string(codePoint(0x30, 0x39), { min: 0, max: 2 }))}`,
			...source.draw(
				array(string(element(["a", "q", "z", "0", "8", "9"]), { min: 1, max: 4 }), {
					min: 0,
					max: 2
				})
			)
		],
		"_"
	)

/** A login's or a role's name: lowercase letters, then maybe a capitalized word, which the naming door converts with `_`. */
const nameGen: Gen<string> = (source) => {
	const head = source.draw(string(codePoint(0x61, 0x7a), { min: 1, max: 8 }))
	const tail = source.draw(option(string(codePoint(0x61, 0x7a), { min: 1, max: 5 })))
	return Option.match(tail, { onNone: () => head, onSome: (t) => `${head}${Str.capitalize(t)}` })
}

/** A role space as drawn: none, or a prefix. */
type Drawn = Option.Option<string>

interface Names {
	readonly schema: string
	readonly login: string
	readonly roles: Arr.NonEmptyReadonlyArray<string>
	readonly spaces: readonly [Drawn, Drawn]
	readonly bound: boolean
}

const converted = (name: string): string => conversionOf(parsedName(name))

const namesGen: Gen<Names> = (source) => {
	const loginName = source.draw(nameGen)
	const drawnRoles = source.draw(array(nameGen, { min: 1, max: 2 }))
	const roles = Arr.reduce(drawnRoles, Arr.empty<string>(), (kept, name) =>
		Arr.some([loginName, ...kept], (other) => converted(other) === converted(name))
			? kept
			: [...kept, name]
	)
	const firstSpace = source.draw(option(prefixGen))
	const secondSpace = source.draw(option(prefixGen))
	const apart =
		Option.isSome(firstSpace) &&
		Option.isSome(secondSpace) &&
		firstSpace.value === secondSpace.value
			? Option.none<string>()
			: secondSpace
	return {
		schema: source.draw(wordsGen),
		login: loginName,
		roles: Arr.isReadonlyArrayNonEmpty(roles) ? roles : [`${loginName}x`],
		spaces: [
			firstSpace,
			Option.isNone(firstSpace) && Option.isNone(apart) ? Option.some("seat") : apart
		],
		bound: source.draw(boolean)
	}
}

type NameFeature =
	| "a prefix and none"
	| "two prefixes"
	| "a capitalized spelling"
	| "a camel-case name"
	| "a prefix at the limit"
	| "a prefix one byte past"

/** The installation a drawn space names. */
const installationOf = (space: Drawn): RoleInstallation =>
	Option.match(space, { onNone: () => ({}), onSome: (rolePrefix) => ({ rolePrefix }) })

/** The specification of a role space: the naming door's stem, under `<conversion of the prefix>__` when there is one. */
const specified = (space: Drawn, stem: string): string =>
	Option.match(space, { onNone: () => stem, onSome: (p) => `${p}__${stem}` })

/** A connection builder over an authoring login or a served login, naming its role by the one roleNameOf. */
const connectionOf = <L>(
	named: AnyLogin | ServedLogin<L>,
	installation: RoleInstallation
): { readonly user: string } => ({ user: roleNameOf(named, installation) })

const nameCase = (n: Names, c: Case<NameFeature>) =>
	Effect.gen(function* () {
		const base = schema(n.schema, [relation("Item", { id: uuid }, ["id"])], [])
		const roles = Arr.map(n.roles, (name) => role(base, name, wholeEntriesOf(base)))
		const desk = login(base, n.login, roles)
		const installation = identity.schema(parsedSchemaName(n.schema))
		const loginStem = identifierOf(identity.login(installation, parsedName(n.login)))
		const roleStems = Arr.map(n.roles, (name) =>
			identifierOf(identity.role(installation, parsedName(name)))
		)
		const compiled = yield* Effect.result(
			compiledLogin(desk, (owned) => firstCodebook(rostersOf(owned)))
		)
		if (Result.isFailure(compiled)) {
			return assert.fail(`the login compiles: ${Formatter.format(compiled.failure)}`)
		}
		const servedDesk = served<typeof desk>(compiled.success.json, desk.name)
		if (n.schema !== Str.toLowerCase(n.schema)) {
			c.note("a capitalized spelling")
		}
		if (Arr.some([n.login, ...n.roles], (name) => converted(name) !== name)) {
			c.note("a camel-case name")
		}
		c.note(
			Option.isSome(n.spaces[0]) && Option.isSome(n.spaces[1])
				? "two prefixes"
				: "a prefix and none"
		)
		const namesUnder = (space: Drawn): ReadonlyArray<string> => {
			const at = installationOf(space)
			const loginRole = roleNameOf(desk, at)
			assert.equal(
				loginRole,
				specified(space, loginStem),
				"the login's role is the door's under the space"
			)
			assert.equal(
				connectionOf(desk, at).user,
				loginRole,
				"a connection of the authoring login names it"
			)
			assert.equal(
				connectionOf(servedDesk, at).user,
				loginRole,
				"a connection of the served login names it"
			)
			const roleNames = Arr.zipWith(roles, roleStems, (value, stem) => {
				const name = roleNameOf(value, at)
				assert.equal(name, specified(space, stem), "a role's role is the door's under the space")
				return name
			})
			for (const r of compiled.success.back.roles) {
				const parsed = roleSpaceOf(Option.getOrUndefined(space))
				const stemmed = parsed.ok ? roleInSpace(parsed.value, r.installed) : parsed
				assert.ok(
					stemmed.ok && roleNames.includes(stemmed.value),
					`the served role ${r.name} takes on the role roleNameOf names`
				)
			}
			return [loginRole, ...roleNames]
		}
		const [firstSpace, secondSpace] = n.spaces
		assert.deepEqual(
			Arr.intersection(namesUnder(firstSpace), namesUnder(secondSpace)),
			[],
			"the two role spaces share no role"
		)
		const stems = [loginStem, ...roleStems]
		const longest = Arr.reduce(stems, 0, (most, s) => Math.max(most, utf8Length(s)))
		const room = maxIdentifierBytes.value - 2 - longest + (n.bound ? 1 : 0)
		if (room < 1) {
			return
		}
		const prefix = Str.repeat(room)("q")
		c.note(n.bound ? "a prefix one byte past" : "a prefix at the limit")
		const worlds = [desk, ...roles]
		Arr.forEach(Arr.zip(worlds, stems), ([w, stem]) => {
			const bytes = room + 2 + utf8Length(stem)
			if (bytes > maxIdentifierBytes.value) {
				throwsRefused(
					() => roleNameOf(w, { rolePrefix: prefix }),
					"RoleNameTooLong",
					`${stem} past the limit`
				)
			} else {
				assert.equal(
					utf8Length(roleNameOf(w, { rolePrefix: prefix })),
					bytes,
					`${stem} under the prefix`
				)
			}
		})
	})

describe("the one roleNameOf", () => {
	it.effect(
		"names a login's, its roles' and its served file's PostgreSQL roles as the naming door's stems under each drawn role space, through one function, the spaces disjoint and the 63-byte bound held",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/served/role-name",
						draw: drawn(namesGen),
						literal: Formatter.format,
						oracle: {
							kind: "specification",
							name: "a role space: the naming door's stem, under `<prefix conversion>__` when prefixed"
						},
						coverage: required<NameFeature>(
							[
								"a prefix and none",
								"two prefixes",
								"a capitalized spelling",
								"a camel-case name",
								"a prefix at the limit",
								"a prefix one byte past"
							],
							{ cases: 32, sense: notesOnly }
						),
						kept: [],
						runs: 64,
						shrink: { kind: "bounded", candidates: 40 },
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					nameCase
				)
			)
	)
})
