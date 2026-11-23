import { catchRefusal } from "#compiler/core/canonical.ts"
import { identifierOf, identity, wholeSchemaIdentity } from "#compiler/core/identity.ts"
import { schemaInstallation } from "#compiler/schema/own.ts"
import { malformed, orThrow } from "#compiler/schema/protocol.ts"
import { schemaDescOf } from "#compiler/schema/schema.ts"
import { theoryRole } from "#compiler/schema/stem.ts"
import { roleDescOf } from "#compiler/schema/world.ts"
import type { AnySchema } from "#compiler/types/schema/schema.ts"
import type { AnyRole } from "#compiler/types/schema/world.ts"

/**
 * schemaNameOf(of): the PostgreSQL schema grizzle installs a schema's tables, rosters and functions in, or a role's own
 * schema, which holds the view of each of its query entries for a direct SQL writer to read, and which the installation
 * creates exactly when the role holds a query entry; a whole entry is read through its relation's whole view, in
 * wholeSchemaNameOf of the schema that declares the relation. Each is minted by the naming door as the installation
 * mints it (schema/own.ts schemaInstallation, core/identity.ts identity.roleSchema), and a schema is the database's, so
 * a role's is its stem's in every installation, whatever its role prefix. It throws CompileError for a value
 * schema(...), schema.extend or role(...) did not build, and for a name the installation refuses: a declared name the
 * naming door refuses (MalformedDescription, or IdentifierTooLong past 63 bytes), a schema's starting with `pg_`, or a
 * role's past PostgreSQL's 63 bytes (IdentifierTooLong).
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

/**
 * wholeSchemaNameOf(of): the PostgreSQL schema of the whole views of the relations a schema declares itself, `__` and
 * its schemaNameOf: each such relation a role holds whole, a stored relation or a stored derived one, has one view
 * there, under its table's name, every row and column of it, each closed id followed by its decoded `<field>_name`,
 * which every role holding it whole reads, and no other. Minted by the naming door as the installation mints it
 * (core/identity.ts identity.wholeSchema). It throws CompileError as schemaNameOf does, and IdentifierTooLong where
 * `__<schema>` passes PostgreSQL's 63 bytes.
 */
export const wholeSchemaNameOf = (of: AnySchema): string => {
	const desc = schemaDescOf(of)
	if (desc === undefined) {
		throw malformed("wholeSchemaNameOf", "a schema built by schema(...) or schema.extend(...)")
	}
	const level = orThrow(schemaInstallation(desc.name, desc.loc))
	return identifierOf(
		orThrow(
			catchRefusal(() =>
				wholeSchemaIdentity(level, `the whole views' schema of schema ${desc.name}`, desc.loc)
			)
		)
	)
}
