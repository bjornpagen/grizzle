import { Array as Arr, Option, String as Str } from "effect"
import * as ts from "typescript/ast"
import type { Type } from "typescript/sync"
import { isAt, isAtAny } from "#lint/paths.ts"
import { authoredSql, collapseWhitespace, hasStatementGrammar } from "#lint/sql-text.ts"
import { declaredNameOf, fileOf, isDrizzleSqlTemplate, topLevelNameOf } from "#lint/sql.ts"
import type { Visit } from "#lint/types.ts"
import type { Report } from "#shared/finding.ts"
import type { Semantics } from "#shared/semantic.ts"

/** Whether a type is Drizzle's TypedQueryBuilder: the native builder an envelope wraps. */
const isTypedQueryBuilder = (type: Type | undefined): boolean => {
	const symbol = type?.getSymbol()
	return (
		symbol?.name === "TypedQueryBuilder" &&
		Arr.some(symbol.declarations, (declaration) =>
			Str.includes("/drizzle-orm/query-builders/query-builder.")(declaration.path)
		)
	)
}

/**
 * Drizzle has no recursive declaration syntax. The envelope it needs is admitted exactly: `with recursive `, a Drizzle
 * `sql.join` of the declarations, then a native TypedQueryBuilder, and nothing else. Every declaration template it
 * joins is still inspected on its own, so the envelope admits no authored SELECT, UNION, predicate or execution.
 */
const isRecursiveEnvelope = (semantics: Semantics, node: ts.TaggedTemplateExpression): boolean => {
	const { template } = node
	if (!ts.isTemplateExpression(template)) {
		return false
	}
	const [entries, result, extra] = template.templateSpans
	if (
		template.head.text !== "with recursive " ||
		entries === undefined ||
		result === undefined ||
		extra !== undefined ||
		entries.literal.text !== " " ||
		result.literal.text !== "" ||
		!ts.isCallExpression(entries.expression)
	) {
		return false
	}
	const join = semantics.signatureDeclarationAt(entries.expression)
	return (
		join !== undefined &&
		Option.contains(declaredNameOf(join), "join") &&
		Str.includes("/drizzle-orm/sql/")(fileOf(join)) &&
		isTypedQueryBuilder(semantics.typeAt(result.expression))
	)
}

/** Drizzle leaves out a numeric `offset 0`. The projection boundary around a native builder is admitted exactly:
 * `${builder.getSQL()} offset 0`, the builder a TypedQueryBuilder. */
const isProjectionEnvelope = (semantics: Semantics, node: ts.TaggedTemplateExpression): boolean => {
	const { template } = node
	if (!ts.isTemplateExpression(template)) {
		return false
	}
	const [query, extra] = template.templateSpans
	if (
		template.head.text !== "" ||
		query === undefined ||
		extra !== undefined ||
		query.literal.text !== " offset 0" ||
		!ts.isCallExpression(query.expression) ||
		Arr.isReadonlyArrayNonEmpty(query.expression.arguments) ||
		!ts.isPropertyAccessExpression(query.expression.expression) ||
		query.expression.expression.name.text !== "getSQL"
	) {
		return false
	}
	return isTypedQueryBuilder(semantics.typeAt(query.expression.expression.expression))
}

/** Whether an identifier names Drizzle's `sql.raw`. */
const isDrizzleRaw = (semantics: Semantics, node: ts.Identifier): boolean => {
	const symbol = semantics.symbolAt(node)
	if (symbol === undefined) {
		return false
	}
	const target = semantics.aliasTarget(symbol)
	return (
		target.name === "raw" &&
		Arr.some(target.declarations, (declaration) =>
			Str.includes("/drizzle-orm/sql/")(declaration.path)
		)
	)
}

const RAW: Omit<Report, "node"> = {
	message: "`sql.raw` is forbidden.",
	suggestion: "Use a native query builder or a fixed typed scalar expression."
}

const STATEMENT: Omit<Report, "node"> = {
	message:
		"A handwritten data statement, subquery or statement fragment in a `sql` template; `sql` templates express only narrow scalar or boolean gaps.",
	suggestion:
		"Compose Drizzle's native fluent builders, or declare the reviewed statement in the superlint option sqlRawStatement."
}

/**
 * A Drizzle `sql` template writes no statement grammar: no data command (SELECT, INSERT, UPDATE, DELETE, MERGE, DDL,
 * GRANT, a set operation), and no opening clause, sided join or grouping. `sql.raw` is refused wherever it is named.
 * The options admit the native gaps exactly: the recursive and projection envelopes in their owners, and each
 * declared statement, a top-level declaration of its owner whose authored grammar is exactly its grammar.
 */
export const sqlRawStatement: Visit = ({ sourceFile, semantics, options }) => {
	const { recursiveEnvelopeOwners, projectionEnvelopeOwners, declaredStatements } =
		options.sqlRawStatement
	const { fileName } = sourceFile
	const recursive = isAtAny(recursiveEnvelopeOwners, fileName)
	const projection = isAtAny(projectionEnvelopeOwners, fileName)
	const declared = Arr.filter(declaredStatements, (statement) => isAt(fileName)(statement.owner))
	const isAdmitted = (node: ts.TaggedTemplateExpression, authored: string): boolean =>
		(recursive && isRecursiveEnvelope(semantics, node)) ||
		(projection && isProjectionEnvelope(semantics, node)) ||
		Arr.some(
			declared,
			(statement) =>
				Option.contains(topLevelNameOf(node), statement.declaration) &&
				collapseWhitespace(authored) === statement.grammar
		)
	return (node) => {
		if (ts.isIdentifier(node)) {
			return isDrizzleRaw(semantics, node) ? [{ node, ...RAW }] : []
		}
		if (!ts.isTaggedTemplateExpression(node)) {
			return []
		}
		const authored = authoredSql(node.template)
		return hasStatementGrammar(authored) &&
			isDrizzleSqlTemplate(semantics, node) &&
			!isAdmitted(node, authored)
			? [{ node, ...STATEMENT }]
			: []
	}
}
