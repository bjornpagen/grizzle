import { Result } from "effect"
import { LoginNameRefused } from "#adapter/errors/failures.ts"
import { identifierOf } from "#compiler/core/identity.ts"
import { fittedLogin } from "#compiler/physical/ddl/names.ts"
import type { SchemaArtifacts } from "#compiler/program/schema.ts"
import type { OwnedLogin } from "#compiler/schema/own.ts"

/**
 * The PostgreSQL roles a Db's sessions take.
 *
 * A DbLayer is built for a login, and every session of its pool logs in as the login's role (LOGIN NOINHERIT), fixed
 * for the connection's lifetime. A Db opened for a role of the login enters the role's own (NOLOGIN), for each of its
 * transactions (wire/batch.ts runFramed). Both are named by the naming door under the identity of the schema the base
 * is installed under (physical/ddl/names.ts fittedLogin, worldNames), so a login under any installed schema has one
 * spelling, the one its installation created.
 *
 * The login role of `login`, whose ownership declared its name, under the schema the artifacts' base is installed
 * under, or why it has none: `<schema>__<login>` past 63 bytes.
 */
export const loginRole = (
	artifacts: SchemaArtifacts,
	login: OwnedLogin
): Result.Result<string, LoginNameRefused> => {
	const fitted = fittedLogin(artifacts.names.installation, login.name)
	return fitted.ok
		? Result.succeed(identifierOf(fitted.value))
		: Result.fail(
				LoginNameRefused.make({
					login: login.name,
					role: fitted.error.role,
					limit: fitted.error.limit
				})
			)
}

/** The role a Db of the role the artifacts were compiled for enters; undefined for artifacts of reality. */
export const theoryRole = (artifacts: SchemaArtifacts): string | undefined =>
	artifacts.world.kind === "role" ? artifacts.world.names.role : undefined
