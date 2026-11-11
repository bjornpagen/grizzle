import { Array as Arr, Result } from "effect"
import * as ts from "typescript/ast"
import type { Checker, Type } from "typescript/sync"
import { closesWithWord, opensWithWordOrEnd } from "#lint/sql-text.ts"
import { interpolationsOf, isDrizzleSqlTemplate } from "#lint/sql.ts"
import type { Visit } from "#lint/types.ts"

/** Whether every member of a type renders itself as SQL: it has a `getSQL` method. */
const rendersAsSql = (checker: Checker, type: Type): boolean =>
	type.isUnionType()
		? Arr.every(type.getTypes(), (member) => rendersAsSql(checker, member))
		: checker.getPropertyOfType(checker.getApparentType(type), "getSQL") !== undefined

const ARM_STARTS: ReadonlyArray<string> = ["then", "else"]

const ARM_ENDS: ReadonlyArray<string> = ["when", "else", "end"]

/**
 * A CASE arm whose whole result is one interpolated value (`then ${value} when`, `else ${value} end`) binds an
 * unknown-typed parameter, which can make the CASE resolve to text; a value that renders itself as SQL carries its
 * own type and is left alone.
 */
export const sqlCaseArmCast: Visit =
	({ checker, semantics }) =>
	(node) => {
		if (!ts.isTaggedTemplateExpression(node) || !ts.isTemplateExpression(node.template)) {
			return []
		}
		const arms = Arr.filter(
			interpolationsOf(node.template),
			({ span, before }) =>
				closesWithWord(before, ARM_STARTS) && opensWithWordOrEnd(span.literal.text, ARM_ENDS)
		)
		if (!Arr.isReadonlyArrayNonEmpty(arms) || !isDrizzleSqlTemplate(semantics, node)) {
			return []
		}
		return Arr.filterMap(arms, ({ span }) => {
			const type = semantics.typeAt(span.expression)
			return type !== undefined && !rendersAsSql(checker, type)
				? Result.succeed({
						node: span.expression,
						message:
							"A bare CASE result parameter has no PostgreSQL type, and an unknown parameter can make the CASE resolve to text.",
						suggestion:
							"Give the value its semantic PostgreSQL cast through a cast leaf's typed function."
					})
				: Result.failVoid
		})
	}
