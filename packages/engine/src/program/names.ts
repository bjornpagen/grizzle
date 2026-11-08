import { catchCompileError } from "#compiler/core/canonical.ts"
import { type CompileError, malformedDescription } from "#compiler/core/errors.ts"
import {
	type DeclaredName,
	type Identity,
	identifierOf,
	identity,
	parseDeclaredName
} from "#compiler/core/identity.ts"
import type { SourceLoc } from "#compiler/core/loc.ts"
import * as Result from "#compiler/core/result.ts"
import type { LoginDesc, RoleDesc } from "#compiler/ir/desc.ts"
import { loginIdentity, roleIdentity } from "#compiler/physical/ddl/names.ts"
import { schemaInstallation } from "#compiler/schema/own.ts"
import { malformed, orThrow } from "#compiler/schema/protocol.ts"
import { schemaDescOf } from "#compiler/schema/schema.ts"
import { loginDescOf, roleDescOf } from "#compiler/schema/world.ts"
import type { AnySchema } from "#compiler/types/schema/schema.ts"
import type { AnyLogin, AnyRole } from "#compiler/types/schema/world.ts"

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
 * A login's PostgreSQL role, minted by the installer's function (physical/ddl/names.ts loginIdentity) under the
 * installation its base's declared name gives (schema/own.ts schemaInstallation): the role its migration creates, the
 * one its layer's pool logs in as and admission judges, or its refusal, a name the naming door refuses or a role past
 * PostgreSQL's 63 bytes (RoleNameTooLong).
 */
export const loginRoleName = (login: LoginDesc): Result.Result<string, CompileError> =>
	Result.flatMap(schemaInstallation(login.base.name, login.base.loc), (installation) =>
		Result.flatMap(worldName(login.name, "login", login.loc), (name) =>
			catchCompileError(() => identifierOf(loginIdentity(installation, name, login.loc)))
		)
	)

/** A role's PostgreSQL role, its theory role, minted as loginRoleName mints a login's (physical/ddl/names.ts
 * roleIdentity), or its refusal. */
const theoryRole = (role: RoleDesc): Result.Result<Identity<"role">, CompileError> =>
	Result.flatMap(schemaInstallation(role.base.name, role.base.loc), (installation) =>
		Result.flatMap(worldName(role.name, "role", role.loc), (name) =>
			catchCompileError(() => roleIdentity(installation, name, role.loc))
		)
	)

/** The description login(...) or role(...) registered for a world value, refused for any other value. */
const worldDesc = <D>(described: D | undefined, operation: string): D => {
	if (described === undefined) {
		throw malformed(operation, "a login built by login(...) or a role built by role(...)")
	}
	return described
}

/**
 * roleNameOf(world): the PostgreSQL role grizzle installs for a login or a role. A login's is the one that logs in, as
 * its layer's pool does: the role a password is set on, `rds_iam` is granted to and an IAM signer names. A role's is the
 * one a direct SQL writer's `SET ROLE` names. Each is minted by the naming door with the installer's own function
 * (loginRoleName), so it is the installed name by construction and never spelled by hand. It throws CompileError for a
 * value login(...) or role(...) did not build, and for a name the installation refuses: a declared name the naming door
 * refuses (MalformedDescription) or a role past PostgreSQL's 63 bytes (RoleNameTooLong).
 */
export const roleNameOf = (world: AnyLogin | AnyRole): string => {
	switch (world.kind) {
		case "login":
			return orThrow(loginRoleName(worldDesc(loginDescOf(world), "roleNameOf")))
		case "role":
			return identifierOf(orThrow(theoryRole(worldDesc(roleDescOf(world), "roleNameOf"))))
	}
}

/**
 * schemaNameOf(of): the PostgreSQL schema grizzle installs a schema's tables, rosters and functions in, or a role's own
 * schema, which holds a view of each of its relations for a direct SQL writer to read. Each is minted by the naming door
 * as the installation mints it (schema/own.ts schemaInstallation, core/identity.ts identity.roleSchema). It throws
 * CompileError for a value schema(...), schema.extend or role(...) did not build, and for a name the installation
 * refuses: a declared name the naming door refuses (MalformedDescription), a schema's starting with `pg_`, or a role's
 * past PostgreSQL's 63 bytes (RoleNameTooLong).
 */
export const schemaNameOf = (of: AnySchema | AnyRole): string => {
	switch (of.kind) {
		case "schema": {
			const desc = schemaDescOf(of)
			if (desc === undefined) {
				throw malformed("schemaNameOf", "a schema built by schema(...) or schema.extend(...)")
			}
			return identifierOf(orThrow(schemaInstallation(desc.name, desc.loc)))
		}
		case "role":
			return identifierOf(
				identity.roleSchema(orThrow(theoryRole(worldDesc(roleDescOf(of), "schemaNameOf"))))
			)
	}
}
