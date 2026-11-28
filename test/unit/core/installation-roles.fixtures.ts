/** What installation-roles.test.ts reads: its box, its installations and the roles each one's script creates. */

import { boolean, element, type Gen } from "@bjornpagen/testing/gen"
import { regex } from "arkregex"
import { Array as Arr, String as Str } from "effect"
import { identifierOf, identity, type RoleSpace, roleSpaceOf } from "#compiler/core/identity.ts"
import { resolveVariables } from "#compiler/deploy/render/variables.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"
import { int4 } from "#compiler/public/fields.ts"
import {
	type AnyLogin,
	type AnySchema,
	fn,
	login,
	relation,
	role,
	schema,
	wholeEntriesOf
} from "#compiler/public/schema.ts"
import { succeeded } from "#test/support/assert.ts"
import { draftedSql } from "#test/support/compile.ts"
import { Id } from "#test/support/ids.ts"
import { parsedSchemaName } from "#test/support/kernel/naming.ts"
import { owning } from "#test/support/policy.ts"
import { installed } from "#test/unit/core/identity.fixtures.ts"

/**
 * One installation of the box: the schema name it is installed under, its role prefix or none, whether its schema
 * declares a function, and how many roles its login takes on.
 */
export interface RolesCase {
	readonly schema: "gz_roles_one" | "gz_roles_two"
	readonly prefix: "p" | "qti_pie_v2" | undefined
	readonly functions: boolean
	readonly roles: 1 | 2
}

/** The role prefixes of the box, none among them: an installation at its stems. */
export const rolePrefixes = ["p", "qti_pie_v2", undefined] as const

/** An installation of the box: a schema name, a role prefix or none, a declared function or none, one role or two. */
export const rolesCaseGen: Gen<RolesCase> = (source) => ({
	schema: source.draw(element(["gz_roles_one", "gz_roles_two"] as const)),
	prefix: source.draw(element(rolePrefixes)),
	functions: source.draw(boolean),
	roles: source.draw(element([1, 2] as const))
})

export type RolesFeature =
	| "at its stems"
	| "under a prefix"
	| "a function owner"
	| "no function"
	| "two roles"

/** A declared function, which gives its installation a function owner. */
const doubled = fn("doubled", {
	calls: [],
	args: { x: int4 },
	returns: int4,
	volatility: "immutable",
	nullInput: "called",
	language: "sql",
	body: fn.body`SELECT $1 * 2`
})

const Item = relation("Item", { id: Id }, ["id"])

/** The schema of one relation, and the one that also declares a function. */
const plain = schema("Roles", [Item], [])
const declaring = schema("Roles", [Item, doubled], [])

/** Each schema's login over one role, `writer`, and over two, `writer` and `reader`. */
const logins = {
	plain: {
		1: login(plain, "desk", [role(plain, "writer", wholeEntriesOf(plain))]),
		2: login(plain, "desk", [
			role(plain, "writer", wholeEntriesOf(plain)),
			role(plain, "reader", wholeEntriesOf(plain))
		])
	},
	declaring: {
		1: login(declaring, "desk", [role(declaring, "writer", wholeEntriesOf(declaring))]),
		2: login(declaring, "desk", [
			role(declaring, "writer", wholeEntriesOf(declaring)),
			role(declaring, "reader", wholeEntriesOf(declaring))
		])
	}
} as const

/** The installation of `c`: a schema of one relation, its function where it declares one, and a login over its roles. */
export const rolesInstallationOf = (c: RolesCase): Installation => {
	const [s, desk]: readonly [AnySchema, AnyLogin] = c.functions
		? [declaring, logins.declaring[c.roles]]
		: [plain, logins.plain[c.roles]]
	return installed(owning(s), desk, identity.schema(parsedSchemaName(c.schema)))
}

/** The role space of `c`'s installation: its prefix's, or its stems'. */
export const spaceOf = (c: RolesCase): RoleSpace => succeeded(roleSpaceOf(c.prefix))

/** The PostgreSQL schemas of `installation`'s levels. */
export const levelsOf = (installation: Installation): ReadonlySet<string> =>
	new Set(Arr.map(installation.settings.levels, identifierOf))

/** A CREATE ROLE statement's role, quoted as an identifier. */
const createdRole = regex('^CREATE ROLE "((?:[^"]|"")+)"')

/**
 * Every role `installation`'s script creates as `grizzle migrate` sends it under `space`, by name: each CREATE ROLE's,
 * its variables filled through the product's one door (deploy/render/variables.ts resolveVariables).
 */
export const createdRoles = (installation: Installation, space: RoleSpace): ReadonlyArray<string> =>
	Arr.flatMap(draftedSql(installation).statements, (statement) => {
		const filled = succeeded(resolveVariables(statement, { database: "roles", roles: space }))
		const created = createdRole.exec(Str.trimStart(filled))
		return created?.[1] === undefined ? [] : [Str.replaceAll('""', '"')(created[1])]
	})
