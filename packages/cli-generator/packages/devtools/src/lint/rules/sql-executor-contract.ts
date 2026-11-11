import { Array as Arr } from "effect"
import * as ts from "typescript/ast"
import { isRawSqlType } from "#lint/sql.ts"
import type { Visit } from "#lint/types.ts"

/** The result types an executor answers with. */
const EXECUTOR_RESULTS: ReadonlyArray<string> = ["Effect", "Promise"]

/**
 * A function type or method signature that takes Drizzle `SQL` and answers an Effect or a Promise is an executor of
 * raw SQL, which erases the native builder's contract: lend the query scope and return its typed QueryPromise.
 */
export const sqlExecutorContract: Visit =
	({ checker, semantics }) =>
	(node) => {
		if (!ts.isFunctionTypeNode(node) && !ts.isMethodSignatureDeclaration(node)) {
			return []
		}
		const result = node.type
		if (
			result === undefined ||
			!Arr.some(node.parameters, (parameter) => {
				const type = semantics.typeAt(parameter)
				return type !== undefined && isRawSqlType(type)
			})
		) {
			return []
		}
		const type = checker.getTypeFromTypeNode(result)
		const named = type.getAliasSymbol() ?? type.getSymbol()
		return named !== undefined && Arr.contains(EXECUTOR_RESULTS, named.name)
			? [
					{
						node,
						message: "An executor of Drizzle `SQL` erases the native builder's contract.",
						suggestion: "Lend the query scope and return its typed QueryPromise."
					}
				]
			: []
	}
