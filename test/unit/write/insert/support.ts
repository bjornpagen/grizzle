import { identity } from "#compiler/core/identity.ts"
import { compileInstallation, installOptions } from "#compiler/physical/install/compile.ts"
import type { WriteNames } from "#compiler/write/insert/statement.ts"
import { succeeded } from "#test/support/assert.ts"
import type { FixtureSchema } from "#test/support/compile.ts"
import { parsedSchemaName } from "#test/support/kernel/naming.ts"
import { owning } from "#test/support/policy.ts"

/** The installed names of a schema whose one level is installed as `schema`, as the write lowering tests compile under. */
export const writeNamesOf = (schemaValue: FixtureSchema, schema: string): WriteNames => {
	const owned = owning(schemaValue)
	return succeeded(
		compileInstallation(owned, {
			...installOptions(owned, "owner"),
			levels: [identity.schema(parsedSchemaName(schema))]
		})
	).names
}
