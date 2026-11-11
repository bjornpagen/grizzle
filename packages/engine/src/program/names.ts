import { identifierOf, identity } from "#compiler/core/identity.ts"
import { schemaInstallation } from "#compiler/schema/own.ts"
import { malformed, orThrow } from "#compiler/schema/protocol.ts"
import { schemaDescOf } from "#compiler/schema/schema.ts"
import { theoryRole } from "#compiler/schema/stem.ts"
import { roleDescOf } from "#compiler/schema/world.ts"
import type { AnySchema } from "#compiler/types/schema/schema.ts"
import type { AnyRole } from "#compiler/types/schema/world.ts"

/**
 * schemaNameOf(of): the PostgreSQL schema grizzle installs a schema's tables, rosters and functions in, or a role's own
 * schema, which holds a view of each of its relations for a direct SQL writer to read. Each is minted by the naming door
 * as the installation mints it (schema/own.ts schemaInstallation, core/identity.ts identity.roleSchema), and a schema
 * is the database's, so a role's is its stem's in every installation, whatever its role prefix. It throws CompileError
 * for a value schema(...), schema.extend or role(...) did not build, and for a name the installation refuses: a
 * declared name the naming door refuses (MalformedDescription), a schema's starting with `pg_`, or a role's past
 * PostgreSQL's 63 bytes (RoleNameTooLong).
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
		case "role": {
			const desc = roleDescOf(of)
			if (desc === undefined) {
				throw malformed("schemaNameOf", "a role built by role(...)")
			}
			return identifierOf(identity.roleSchema(orThrow(theoryRole(desc))))
		}
	}
}
