import { catchCompileError } from "#compiler/core/canonical.ts"
import { type CompileError, malformedDescription } from "#compiler/core/errors.ts"
import {
	type DeclaredName,
	type Identity,
	identifierOf,
	parseDeclaredName
} from "#compiler/core/identity.ts"
import type { SourceLoc } from "#compiler/core/loc.ts"
import * as Result from "#compiler/core/result.ts"
import type { LoginDesc, RoleDesc } from "#compiler/ir/desc.ts"
import { loginIdentity, roleIdentity } from "#compiler/physical/ddl/names.ts"
import { schemaInstallation } from "#compiler/schema/own.ts"

/**
 * A login's or a role's stem: the PostgreSQL role its identity spells under the schema it is over (physical/ddl/names.ts
 * loginIdentity, roleIdentity), which `grizzle generate` commits and every installation installs under its role space
 * (core/identity.ts installedRole). login(...) and role(...) compute it once, as they build the value, which carries it,
 * its refusal too (types/schema/world.ts AnyLogin, AnyRole `stem`), for roleNameOf to read.
 */

/** A login's or a role's name, parsed as its ownership parses it (core/identity.ts DeclaredNamespace), or its refusal. */
const worldName = (
	name: string,
	kind: "login" | "role",
	loc: SourceLoc
): Result.Result<DeclaredName, CompileError> =>
	Result.mapError(parseDeclaredName(name), (why) =>
		malformedDescription(loc, `the declared ${kind} name ${JSON.stringify(name)} as ${why}`)
	)

/**
 * A login's stem, minted by the installer's function (physical/ddl/names.ts loginIdentity) under the installation its
 * base's declared name gives (schema/own.ts schemaInstallation): the role its migration creates, the one its layer's
 * pool logs in as and admission judges, at the stem; or its refusal, a name the naming door refuses or a role past
 * PostgreSQL's 63 bytes (RoleNameTooLong).
 */
export const loginStem = (login: LoginDesc): Result.Result<string, CompileError> =>
	Result.flatMap(schemaInstallation(login.base.name, login.base.loc), (installation) =>
		Result.flatMap(worldName(login.name, "login", login.loc), (name) =>
			catchCompileError(() => identifierOf(loginIdentity(installation, name, login.loc)))
		)
	)

/** A role's theory role, minted as loginStem mints a login's (physical/ddl/names.ts roleIdentity), or its refusal. */
export const theoryRole = (role: RoleDesc): Result.Result<Identity<"role">, CompileError> =>
	Result.flatMap(schemaInstallation(role.base.name, role.base.loc), (installation) =>
		Result.flatMap(worldName(role.name, "role", role.loc), (name) =>
			catchCompileError(() => roleIdentity(installation, name, role.loc))
		)
	)

/** A role's stem, its theory role's identifier (theoryRole), or its refusal. */
export const roleStem = (role: RoleDesc): Result.Result<string, CompileError> =>
	Result.map(theoryRole(role), identifierOf)
