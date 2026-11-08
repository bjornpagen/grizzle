import type { SchemaArtifacts } from "#compiler/plan/common.ts"

/**
 * The PostgreSQL role a Db enters.
 *
 * A DbLayer is built for a login, and every session of its pool logs in as the login's role (LOGIN NOINHERIT), fixed
 * for the connection's lifetime, the one the naming door names it (program/names.ts loginRoleName). A Db opened for a
 * role of the login enters the role's own (NOLOGIN), for each of its transactions (wire/batch.ts runFramed), as the
 * artifacts compiled for the role name it (physical/ddl/names.ts worldNames).
 *
 * The role a Db of the role the artifacts were compiled for enters; undefined for artifacts of reality.
 */
export const theoryRole = (artifacts: SchemaArtifacts): string | undefined =>
	artifacts.world.kind === "role" ? artifacts.world.names.role : undefined
