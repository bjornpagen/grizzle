import { Array as Arr } from "effect"
import { C, type ManifestStatement, type RoleExpectation } from "#compiler/plan/catalog.ts"
import { maxStackDepth, type TemplateRequirements } from "#compiler/plan/common.ts"

const settings = C.from("pg_settings", "s")

/** The server's max_stack_depth as pg_settings reports it, in kilobytes, its unit: a column of grizzle migrate's first read. */
export const stackDepthColumn: C.CatalogExpr = C.asText(
	C.scalar(
		C.query(
			[settings.col("setting")],
			[settings.item],
			C.eq(settings.col("name"), C.text("max_stack_depth"))
		)
	)
)

/**
 * Whether a server's max_stack_depth, as stackDepthColumn reads it, is below the default the pattern limits were
 * measured at (core/limits.ts maxStackDepth). A setting the server cannot report as kilobytes is below it.
 */
export const stackTooShallow = (reported: string): boolean => {
	const kilobytes = Number(reported)
	return !Number.isSafeInteger(kilobytes) || kilobytes < maxStackDepth.value
}

/** What a server's max_stack_depth must be at least, as a refusal states it. */
export const stackDepthRequired = `${maxStackDepth.value} kB, the default PostgreSQL's regex compiler was measured at`

/**
 * What a Db's statements can name of what lies outside its own schemas, as its snapshot installs and grants it: every
 * extension the snapshot creates, by name, with the schema it lives in, and the schemas the Db's role holds USAGE on. A
 * statement that names an extension's type needs both: the extension installed, and USAGE on its schema. A Db checks
 * nothing of its database, the one its snapshot was migrated to (grizzle migrate and grizzle drift judge it).
 */
export interface DbCapabilities {
	readonly installedExtensions: ReadonlyMap<string, string>
	readonly usableSchemas: ReadonlySet<string>
}

/** The capabilities of a Db of `expected`'s role, its snapshot's manifest being `statements`. */
export const capabilitiesOf = (
	statements: ReadonlyArray<ManifestStatement>,
	expected: RoleExpectation
): DbCapabilities => ({
	installedExtensions: new Map(
		Arr.flatMap(statements, (s) => (s.kind === "createExtension" ? [[s.name, s.schema] as const] : []))
	),
	usableSchemas: new Set(
		Arr.flatMap(expected.privileges, (p) =>
			p.family === "schema" && p.privilege === "USAGE" ? [p.name] : []
		)
	)
})

/**
 * The capability a compiled template needs and the Db lacks, as a CompileError capability text: the first extension of
 * the template's requirements its snapshot does not install in the schema its compiled names place it in, or installs
 * in a schema the Db's role holds no USAGE on, where PostgreSQL would refuse the statement naming its type. Undefined
 * when every one is installed there, usable by the role.
 */
export const missingExtension = (
	requirements: Pick<TemplateRequirements, "extensions" | "extensionSchemas">,
	capabilities: DbCapabilities
): string | undefined => {
	for (const name of requirements.extensions) {
		const schema = requirements.extensionSchemas[name]
		const at = capabilities.installedExtensions.get(name)
		if (at === undefined || (schema !== undefined && at !== schema)) {
			return schema === undefined ? `extension ${name}` : `extension ${name} in schema ${schema}`
		}
		if (!capabilities.usableSchemas.has(at)) {
			return `USAGE on schema ${at}`
		}
	}
	return undefined
}
