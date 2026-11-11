import { Array as Arr, Option } from "effect"
import * as ts from "typescript/ast"
import { isAt, isAtAny } from "#lint/paths.ts"
import { fileOf, literalTextOf } from "#lint/sql.ts"
import type { RuleContext, Visit } from "#lint/types.ts"
import type { Report } from "#shared/finding.ts"

type AdmittedDeadline = RuleContext["options"]["sqlQueryDeadline"]["admitted"][number]

/** Whether a property assignment is an admitted deadline: in its owner, inside `new construction(…)`, the property
 * set to `subject === principals.principal ? constant : false`, the constant declared in its module. */
const isAdmittedDeadline = (
	context: RuleContext,
	admitted: AdmittedDeadline,
	node: ts.PropertyAssignment
): boolean => {
	const { semantics } = context
	const { initializer } = node
	if (
		!Option.contains(literalTextOf(node.name), admitted.property) ||
		!ts.isConditionalExpression(initializer)
	) {
		return false
	}
	const { condition, whenTrue, whenFalse } = initializer
	if (
		!ts.isBinaryExpression(condition) ||
		condition.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken ||
		!ts.isPropertyAccessExpression(condition.right) ||
		!Option.contains(literalTextOf(condition.left), admitted.guard.subject) ||
		!Option.contains(literalTextOf(condition.right.expression), admitted.guard.principals) ||
		condition.right.name.text !== admitted.guard.principal ||
		whenFalse.kind !== ts.SyntaxKind.FalseKeyword
	) {
		return false
	}
	const symbol = semantics.symbolAt(whenTrue)
	const setting = symbol === undefined ? undefined : semantics.aliasTarget(symbol)
	const allocation = node.parent.parent
	return (
		setting !== undefined &&
		setting.name === admitted.value.constant &&
		Arr.some(semantics.declarationsOf(setting), (declaration) =>
			isAt(fileOf(declaration))(admitted.value.module)
		) &&
		ts.isNewExpression(allocation) &&
		Option.contains(literalTextOf(allocation.expression), admitted.construction)
	)
}

const SETTING: Omit<Report, "node"> = {
	message: "A database query or checkout deadline terminates admitted work.",
	suggestion: "Remove the timeout option; performance targets do not terminate admitted work."
}

const REFUSAL: Omit<Report, "node"> = {
	message: "An elapsed-time database refusal terminates admitted work.",
	suggestion: "Remove the refusal; keep real cancellation and native settlement."
}

/**
 * Database code sets no deadline on admitted work: no property that sets a query, statement, lock or checkout timeout,
 * and no refusal by elapsed time, in the files the options name. A deadline the options admit (a reader's startup
 * bound, which survives an orphaned host) is the one exception.
 */
export const sqlQueryDeadline: Visit = (context) => {
	const { sourceFile, options } = context
	const { files, properties, refusals, admitted } = options.sqlQueryDeadline
	if (!isAtAny(files, sourceFile.fileName)) {
		return () => []
	}
	const deadlines = [...properties, ...refusals]
	const admittedHere = Arr.filter(admitted, (entry) => isAt(sourceFile.fileName)(entry.owner))
	const isSetting = (node: ts.PropertyAssignment | ts.PropertySignatureDeclaration): boolean =>
		Option.exists(literalTextOf(node.name), (name) => Arr.contains(deadlines, name)) &&
		!(
			ts.isPropertyAssignment(node) &&
			Arr.some(admittedHere, (entry) => isAdmittedDeadline(context, entry, node))
		)
	return (node) => {
		const setting =
			(ts.isPropertyAssignment(node) || ts.isPropertySignatureDeclaration(node)) && isSetting(node)
		const refusal = ts.isStringLiteralLikeNode(node) && Arr.contains(refusals, node.text)
		return [...(setting ? [{ node, ...SETTING }] : []), ...(refusal ? [{ node, ...REFUSAL }] : [])]
	}
}
