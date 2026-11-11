import { Array as Arr, Option, String as Str } from "effect"
import * as ts from "typescript/ast"
import { isAt, isAtAny } from "#lint/paths.ts"
import { fileOf, isUnrelatedCall, resolutionAt, topLevelNameOf } from "#lint/sql.ts"
import type { Visit } from "#lint/types.ts"

/** The native statement forms statement custody runs, by the class that declares their `execute`: a builder's
 * QueryPromise, and a prepared query, which alone takes its placeholder values. */
const NATIVE_STATEMENTS: ReadonlyArray<
	Readonly<{ module: string; owner: string; arguments: number }>
> = [
	{ module: "/drizzle-orm/query-promise.", owner: "QueryPromise", arguments: 0 },
	{ module: "/drizzle-orm/pg-core/async/session.", owner: "PgAsyncPreparedQuery", arguments: 1 }
]

/** Whether a call runs a native statement form with the arguments it takes. */
const isNativeStatementCall = (call: ts.CallExpression, declaration: ts.Node): boolean => {
	const owner = declaration.parent
	if (!ts.isClassDeclaration(owner) || owner.name === undefined) {
		return false
	}
	const { text } = owner.name
	return Arr.some(
		NATIVE_STATEMENTS,
		(statement) =>
			Str.includes(statement.module)(fileOf(declaration)) &&
			statement.owner === text &&
			call.arguments.length <= statement.arguments
	)
}

const isPgFile = (file: string): boolean =>
	Str.includes("/@types/pg/")(file) || Str.includes("/pg/")(file)

/**
 * Statements execute only through statement custody. A Drizzle `execute` (a builder's, a prepared query's, or a
 * database's `execute(sql)`) runs only in a statement owner, which runs native builders and prepared queries, or as a
 * declared execution: in its executor, `execute(statement(…))` with the statement declared in the same owner. pg's
 * `query` runs only in a native client owner, or as a pg-copy-streams COPY in a copy-stream owner.
 */
export const sqlRawExecution: Visit = ({ sourceFile, semantics, options }) => {
	const { statementOwners, copyStreamOwners, nativeClientOwners, declaredExecutions } =
		options.sqlRawExecution
	const { fileName } = sourceFile
	const statementOwner = isAtAny(statementOwners, fileName)
	const copyStreamOwner = isAtAny(copyStreamOwners, fileName)
	const nativeClientOwner = isAtAny(nativeClientOwners, fileName)
	const declared = Arr.filter(declaredExecutions, (execution) => isAt(fileName)(execution.owner))

	const isDeclaredExecution = (call: ts.CallExpression): boolean => {
		const [statement, extra] = call.arguments
		if (statement === undefined || extra !== undefined || !ts.isCallExpression(statement)) {
			return false
		}
		const callee = semantics.symbolAt(statement.expression)
		const declaration = semantics.signatureDeclarationAt(statement)
		return Arr.some(
			declared,
			(execution) =>
				callee !== undefined &&
				semantics.aliasTarget(callee).name === execution.statement &&
				declaration !== undefined &&
				isAt(fileOf(declaration))(execution.owner) &&
				Option.contains(topLevelNameOf(call), execution.executor)
		)
	}

	const isCopyStream = (call: ts.CallExpression): boolean => {
		const [copy, extra] = call.arguments
		if (
			!copyStreamOwner ||
			copy === undefined ||
			extra !== undefined ||
			!ts.isCallExpression(copy)
		) {
			return false
		}
		const declaration = semantics.signatureDeclarationAt(copy)
		return (
			declaration !== undefined && Str.includes("/@types/pg-copy-streams/")(fileOf(declaration))
		)
	}

	return (node) => {
		if (!ts.isCallExpression(node) || isUnrelatedCall(semantics, node)) {
			return []
		}
		const resolution = resolutionAt(semantics, node)
		if (Option.isNone(resolution)) {
			return []
		}
		const { declaration, file, name } = resolution.value
		const drizzleExecution =
			Str.includes("/drizzle-orm/")(file) &&
			Option.contains(name, "execute") &&
			!(statementOwner && isNativeStatementCall(node, declaration)) &&
			!isDeclaredExecution(node)
		const pgQuery =
			isPgFile(file) && Option.contains(name, "query") && !nativeClientOwner && !isCopyStream(node)
		return drizzleExecution || pgQuery
			? [
					{
						node,
						message:
							"Statements execute only through statement custody: native builders and prepared queries run in a statement owner, and only declared executions issue their reviewed statement.",
						suggestion:
							"Run the statement through the statement owner's scope (superlint option sqlRawExecution)."
					}
				]
			: []
	}
}
