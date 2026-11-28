import * as Result from "@bjornpagen/grizzle-text/base/result"
import type { CompileError } from "#compiler/core/errors.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { admitLoginRoles } from "#compiler/ir/desc.ts"

import { admitSchemaDesc } from "#compiler/schema/admit.ts"
import {
	fullRoleDesc,
	type OwnedLogin,
	type OwnedRole,
	ownLogin,
	ownRole
} from "#compiler/schema/own.ts"
import type { SchemaDesc } from "#test/support/fixtures/ir/desc.ts"

/**
 * The worlds a fixture description opens in, as values: the full role `writer`, holding every relation whole and
 * writing every stored one, and `reader`, holding every relation whole and writing nothing, in the login `server`.
 */
interface FixtureWorlds {
	readonly login: OwnedLogin
	readonly writer: OwnedRole
	readonly reader: OwnedRole
}

/** A compile step's value: the fixture's worlds are well formed, so a refusal is the fixture's defect, thrown. */
const accepted = <A>(r: Result.Result<A, CompileError>): A => {
	if (!r.ok) {
		throw r.error
	}
	return r.value
}

const fixtureWorlds = (desc: SchemaDesc): FixtureWorlds => {
	const loc = SourceLoc(`the fixture login of ${desc.name}`, [])
	const base = accepted(admitSchemaDesc(desc))
	const writer = accepted(fullRoleDesc(base, "writer", loc))
	const reader = { ...writer, name: "reader", write: [] }
	return {
		login: accepted(
			Result.flatMap(
				admitLoginRoles(base, { name: "server", roles: [writer, reader], loc }),
				ownLogin
			)
		),
		writer: accepted(ownRole(writer)),
		reader: accepted(ownRole(reader))
	}
}

/** The fixture's login alone. */
export const fixtureLogin = (desc: SchemaDesc): OwnedLogin => fixtureWorlds(desc).login
