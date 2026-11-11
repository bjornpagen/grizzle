import { Array as Arr, Option, Result } from "effect"
import * as ts from "typescript/ast"
import { type Type, TypeFlags } from "typescript/sync"
import { isDrizzleMethodCall, type MethodCall } from "#lint/drizzle.ts"
import type { Visit } from "#lint/types.ts"
import type { Report } from "#shared/finding.ts"
import type { Semantics } from "#shared/semantic.ts"

const WRITES: ReadonlySet<string> = new Set(["delete", "update"])

const WHERE: ReadonlySet<string> = new Set(["where"])

const isMethodCall = (node: ts.Node): node is MethodCall =>
	ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)

/** The calls chained onto a call, in order: `database.update(t).set(v).where(c)` chains `set`, then `where`. */
const chainOf = (call: MethodCall): ReadonlyArray<MethodCall> => {
	const chained: Array<MethodCall> = []
	let current: ts.Expression = call
	while (
		ts.isPropertyAccessExpression(current.parent) &&
		isMethodCall(current.parent.parent) &&
		current.parent.parent.expression === current.parent
	) {
		chained.push(current.parent.parent)
		current = current.parent.parent
	}
	return chained
}

/** The name a query is bound to when its chain initializes it, `const query = database.delete(t)`. */
const boundNameOf = (end: ts.Expression): Option.Option<ts.Identifier> => {
	const declaration = end.parent
	return ts.isVariableDeclaration(declaration) &&
		declaration.initializer === end &&
		ts.isIdentifier(declaration.name)
		? Option.some(declaration.name)
		: Option.none()
}

/** A `.where(…)` whose receiver is a bare name, with the id of the symbol that name binds. */
type BoundWhere = Readonly<{ receiver: number; call: MethodCall }>

const boundWheresOf = (
	sourceFile: ts.SourceFile,
	semantics: Semantics
): ReadonlyArray<BoundWhere> => {
	const found: Array<BoundWhere> = []
	const walk = (node: ts.Node): void => {
		const call = { semantics, node, names: WHERE }
		if (isDrizzleMethodCall(call) && ts.isIdentifier(call.node.expression.expression)) {
			const receiver = semantics.symbolAt(call.node.expression.expression)
			if (receiver !== undefined) {
				found.push({ receiver: receiver.id, call: call.node })
			}
		}
		node.forEachChild(walk)
	}
	walk(sourceFile)
	return found
}

const admitsUndefined = (type: Type): boolean =>
	Arr.some(
		type.isUnionType() ? type.getTypes() : [type],
		(member) => (member.flags & (TypeFlags.Undefined | TypeFlags.Void)) !== 0
	)

const verbOf = (method: string): string => (method === "delete" ? "deletes" : "updates")

/**
 * A Drizzle `delete` or `update` is narrowed by a `.where(…)` whose condition is always there: without one, or with a
 * condition typed with undefined (`and()` of an empty list is undefined), it changes every row of the table. The
 * `.where` is chained in the same expression, or onto the name the query is bound to in the same file. The builder
 * is recognised by the type its method resolves to, whatever the receiver is named.
 */
export const noDrizzleWriteWithoutWhere: Visit = ({ sourceFile, semantics }) => {
	const boundWheres = boundWheresOf(sourceFile, semantics)

	const wheresOf = (call: MethodCall): ReadonlyArray<MethodCall> => {
		const chain = chainOf(call)
		const chained = Arr.filter(chain, (step) => step.expression.name.text === "where")
		const bound = Option.flatMap(
			boundNameOf(Option.getOrElse(Arr.last(chain), () => call)),
			(name) => Option.fromUndefinedOr(semantics.symbolAt(name))
		)
		return Option.match(bound, {
			onNone: () => chained,
			onSome: (symbol) => [
				...chained,
				...Arr.filterMap(boundWheres, (where) =>
					where.receiver === symbol.id ? Result.succeed(where.call) : Result.failVoid
				)
			]
		})
	}

	const partialConditionsOf = (
		method: string,
		wheres: ReadonlyArray<MethodCall>
	): ReadonlyArray<Report> =>
		Arr.filterMap(wheres, (where) => {
			const [condition] = where.arguments
			const type = condition === undefined ? undefined : semantics.typeAt(condition)
			if (condition !== undefined && (type === undefined || !admitsUndefined(type))) {
				return Result.failVoid
			}
			return Result.succeed({
				node: condition ?? where.expression.name,
				message: `This \`.where()\` of a Drizzle \`.${method}()\` takes a condition that can be undefined, and an undefined condition ${verbOf(method)} every row of the table.`,
				suggestion:
					"Make the condition total: build it from a non-empty list of conditions, so `and(…)` cannot be undefined."
			})
		})

	return (node) => {
		const call = { semantics, node, names: WRITES }
		if (!isDrizzleMethodCall(call)) {
			return []
		}
		const method = call.node.expression.name.text
		const wheres = wheresOf(call.node)
		if (Arr.isReadonlyArrayNonEmpty(wheres)) {
			return partialConditionsOf(method, wheres)
		}
		return [
			{
				node: call.node.expression.name,
				message: `Drizzle \`.${method}()\` without \`.where()\` ${verbOf(method)} every row of the table.`,
				suggestion: `Chain \`.where(…)\` onto the \`.${method}()\`, or onto the name its query is bound to.`
			}
		]
	}
}
