import { Array as Arr, Option, String as Str } from "effect"
import * as ts from "typescript/ast"
import { isAt } from "#lint/paths.ts"
import { isEnclosedByFunction, isUnrelatedCall, resolutionAt } from "#lint/sql.ts"
import type { Visit } from "#lint/types.ts"
import type { Report } from "#shared/finding.ts"

/** Whether a table constructor's column map is not one static object: a computed map, a spread or a computed name. */
const hasDynamicColumns = (call: ts.CallExpression): boolean => {
	const columns = call.arguments[1]
	return (
		columns === undefined ||
		!ts.isObjectLiteralExpression(columns) ||
		Arr.some(
			columns.properties,
			(property) => ts.isSpreadAssignment(property) || ts.isComputedPropertyName(property.name)
		)
	)
}

const TABLE: Omit<Report, "node"> = {
	message:
		"A table and its columns are declared directly, in one static object at the top level; table and column-shape factories and spreads are forbidden.",
	suggestion:
		"Declare the table with a literal column object at the top level of its schema module."
}

const SCHEMA: Omit<Report, "node"> = {
	message: "A schema's identity is a static literal declared at the top level.",
	suggestion: 'Call `pgSchema("name")` with a string literal at the top level of its module.'
}

/**
 * A Drizzle schema is static: each table is declared at the top level with a literal column object (no factory, no
 * spread, no computed name), and each `pgSchema` names a literal at the top level. The table factories the options
 * name are exempt: top-level arrow functions in their owner that build a session-local relation from static
 * declarations.
 */
export const sqlDynamicSchema: Visit = ({ sourceFile, semantics, options }) => {
	const factories = Arr.filter(options.sqlDynamicSchema.tableFactories, (factory) =>
		isAt(sourceFile.fileName)(factory.owner)
	)
	const isDeclaredFactory = (call: ts.CallExpression): boolean => {
		const enclosing = call.parent
		if (
			!ts.isArrowFunction(enclosing) ||
			!ts.isVariableDeclaration(enclosing.parent) ||
			!ts.isIdentifier(enclosing.parent.name)
		) {
			return false
		}
		const declared = enclosing.parent.name.text
		return Arr.some(factories, (factory) => factory.declaration === declared)
	}
	return (node) => {
		if (!ts.isCallExpression(node) || isUnrelatedCall(semantics, node)) {
			return []
		}
		const resolution = resolutionAt(semantics, node)
		if (Option.isNone(resolution) || !Str.includes("/drizzle-orm/")(resolution.value.file)) {
			return []
		}
		const { file, name } = resolution.value
		const isTableConstructor =
			Str.includes("/pg-core/table.")(file) ||
			(Str.includes("/pg-core/schema.")(file) && Option.contains(name, "table"))
		const table =
			isTableConstructor &&
			!isDeclaredFactory(node) &&
			(isEnclosedByFunction(node) || hasDynamicColumns(node))
		const [identity] = node.arguments
		const schema =
			Option.contains(name, "pgSchema") &&
			(isEnclosedByFunction(node) ||
				identity === undefined ||
				!ts.isStringLiteralLikeNode(identity))
		return [...(table ? [{ node, ...TABLE }] : []), ...(schema ? [{ node, ...SCHEMA }] : [])]
	}
}
