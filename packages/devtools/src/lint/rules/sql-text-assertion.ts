import { Array as Arr, Option } from "effect"
import * as ts from "typescript/ast"
import { type DeclaredAliases, declaredAliasesOf, missingAliasMessage } from "#lint/declared.ts"
import { isAtAny } from "#lint/paths.ts"
import type { Visit } from "#lint/types.ts"
import type { Report } from "#shared/finding.ts"

type DeclaredText = Readonly<{ module: string; alias: string }>

const isWrittenText = (node: ts.Expression): boolean =>
	ts.isStringLiteral(node) ||
	ts.isNoSubstitutionTemplateLiteral(node) ||
	ts.isTemplateExpression(node)

/** The callee's spelling, `assert.match` or `containsText`; none for any other callee shape. */
const calleeTextOf = (call: ts.CallExpression): Option.Option<string> => {
	const callee = call.expression
	if (ts.isIdentifier(callee)) {
		return Option.some(callee.text)
	}
	if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
		return Option.some(`${callee.expression.text}.${callee.name.text}`)
	}
	return Option.none()
}

/**
 * A test asserts emitted SQL by its structure or by an oracle, never by its text. Reported: a matcher the options
 * name (`assert.match`), and an equality they name (`assert.equal`) whose expected value is a written string, when its
 * first argument is typed as emitted text (one of the declared aliases). Two emitted texts compared with each other
 * (determinism) stay legal. The rule reads the test files the options name, except the exempt ones, whose text a
 * person reviews. The emitted-text aliases are read through the checker once per file, at its first text assertion,
 * which also reports any alias the file's program does not hold.
 */
export const sqlTextAssertion: Visit = ({ sourceFile, checker, semantics, options, root }) => {
	const { files, exempt, texts, matchers, equalities } = options.sqlTextAssertion
	const { fileName } = sourceFile
	if (
		!Arr.isReadonlyArrayNonEmpty(texts) ||
		!isAtAny(root, files, fileName) ||
		isAtAny(root, exempt, fileName)
	) {
		return () => []
	}
	const isTextAssertion = (call: ts.CallExpression): boolean => {
		const expected = call.arguments[1]
		return Option.exists(
			calleeTextOf(call),
			(callee) =>
				Arr.contains(matchers, callee) ||
				(Arr.contains(equalities, callee) && expected !== undefined && isWrittenText(expected))
		)
	}
	let emitted = Option.none<DeclaredAliases<DeclaredText>>()
	const emittedOf = (): Readonly<{ aliases: DeclaredAliases<DeclaredText>; first: boolean }> => {
		if (Option.isSome(emitted)) {
			return { aliases: emitted.value, first: false }
		}
		const aliases = declaredAliasesOf({ checker, fileName, declared: texts })
		emitted = Option.some(aliases)
		return { aliases, first: true }
	}
	return (node) => {
		if (!ts.isCallExpression(node) || !isTextAssertion(node)) {
			return []
		}
		const [subject] = node.arguments
		if (subject === undefined) {
			return []
		}
		const { aliases, first } = emittedOf()
		const misconfigured = first
			? Arr.map(aliases.missing, (declared): Report => ({
					node,
					message: missingAliasMessage("sqlTextAssertion.texts", declared)
				}))
			: []
		const type = semantics.typeAt(subject)
		const asserted =
			type !== undefined &&
			Arr.some(aliases.found, (found) => checker.isTypeAssignableTo(type, found.type))
		return asserted
			? [
					...misconfigured,
					{
						node,
						message:
							"Emitted SQL is asserted by its structure or by an oracle, never by its text; only text a person reviews is asserted as text.",
						suggestion:
							"Assert the statement's structure, or compare it with an oracle's; the superlint option sqlTextAssertion.exempt names the files whose text a person reviews."
					}
				]
			: misconfigured
	}
}
