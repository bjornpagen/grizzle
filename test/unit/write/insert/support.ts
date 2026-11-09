import { identity } from "#compiler/core/identity.ts"
import { compileInstallation, installOptions } from "#compiler/physical/install/compile.ts"
import type { WriteNames } from "#compiler/write/insert/statement.ts"
import { succeeded } from "#test/support/assert.ts"
import { parsedSchemaName } from "#test/support/kernel/naming.ts"
import { owning } from "#test/support/policy.ts"

/** Shared fixtures for the write lowering tests: the installed names of a schema, and the checked relations of the worked
 * example's Work schema. */
export const writeNamesOf = (schemaValue: unknown, schema: string): WriteNames => {
	const owned = owning(schemaValue)
	return succeeded(
		compileInstallation(owned, {
			...installOptions(owned, "owner"),
			levels: [identity.schema(parsedSchemaName(schema))]
		})
	).names
}
