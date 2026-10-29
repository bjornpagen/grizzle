import { Array as Arr, Option, String as Str } from "effect"
import * as ts from "typescript/ast"
import type { Type } from "typescript/sync"
import { declaredAliasesOf, missingAliasMessage } from "#lint/declared.ts"
import { isAtAny } from "#lint/paths.ts"
import type { RuleContext, Visit } from "#lint/types.ts"
import type { Report } from "#shared/finding.ts"

/** Where a vocabulary member is declared: its alias and module. */
type Member = Readonly<{ alias: string; module: string }>

type Literal = ts.StringLiteral | ts.NoSubstitutionTemplateLiteral

const literalMembersOf = (type: Type): ReadonlyArray<string> =>
	Arr.flatMap(type.isUnionType() ? type.getTypes() : [type], (member) =>
		member.isStringLiteralType() && typeof member.value === "string" ? [member.value] : []
	)

/** A member that is one lowercase word collides with English and with field names, so it is left out of the
 * vocabulary and the typed door checks it. */
const isOneLowercaseWord = (text: string): boolean =>
	Str.isNonEmpty(text) &&
	Arr.every(Str.split("")(text), (character) => character >= "a" && character <= "z")

/** The registrar a call names, through `it.with(options)` and `it.each(cases)`: `it(…)`, `it.effect(…)`,
 * `it.with(o).effect(…)`, `it.each(cases)(…)`; none for any other callee shape. */
const registrarNameOf = (callee: ts.Expression): Option.Option<string> => {
	if (ts.isIdentifier(callee)) {
		return Option.some(callee.text)
	}
	if (ts.isPropertyAccessExpression(callee)) {
		return Option.some(callee.name.text)
	}
	return ts.isCallExpression(callee) ? registrarNameOf(callee.expression) : Option.none()
}

const isUnannotatedConstInitializer = (literal: Literal, parent: ts.Node): boolean =>
	ts.isVariableDeclaration(parent) &&
	parent.initializer === literal &&
	parent.type === undefined &&
	ts.isVariableDeclarationList(parent.parent) &&
	(parent.parent.flags & ts.NodeFlags.Const) !== 0

const isEquality = (kind: ts.SyntaxKind): boolean =>
	kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
	kind === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
	kind === ts.SyntaxKind.EqualsEqualsToken ||
	kind === ts.SyntaxKind.ExclamationEqualsToken

/**
 * A member of one of the repository's closed vocabularies written where the compiler cannot check it. A test that
 * spells "UnsupportedOperation" into a `string` position keeps compiling when the source renames or deletes the
 * member, and fails at run time or not at all. In the test files the options name, every string literal whose text is
 * a member of a declared vocabulary is checked, unless it sits where its text is not a vocabulary reference (a type,
 * an import or export specifier, a property name, an unannotated const's initializer, a registrar's title, the
 * argument of a prose parameter) or where the compiler already checks it (an equality whose other side, or a case
 * whose switch, is typed by a literal union holding the text, or a contextual type narrower than string). The
 * vocabularies are read through the checker once per file, at its first candidate literal, which also reports any
 * vocabulary the file's program does not hold.
 */
export const uncheckedVocabularyLiteral: Visit = (context: RuleContext) => {
	const { sourceFile, checker, semantics, options } = context
	const { files, vocabularies, titled, explanations } = options.uncheckedVocabularyLiteral
	if (!Arr.isReadonlyArrayNonEmpty(vocabularies) || !isAtAny(files, sourceFile.fileName)) {
		return () => []
	}
	const isTitle = (literal: Literal, call: ts.CallExpression): boolean =>
		call.arguments[0] === literal &&
		Option.exists(registrarNameOf(call.expression), (name) => Arr.contains(titled, name))
	const isNotAReference = (literal: Literal): boolean => {
		const { parent } = literal
		return (
			ts.isLiteralTypeNode(parent) ||
			ts.isImportDeclaration(parent) ||
			ts.isExportDeclaration(parent) ||
			ts.isImportSpecifier(parent) ||
			ts.isExportSpecifier(parent) ||
			ts.isExternalModuleReference(parent) ||
			((ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent)) &&
				parent.name === literal) ||
			ts.isPropertySignatureDeclaration(parent) ||
			ts.isComputedPropertyName(parent) ||
			(ts.isElementAccessExpression(parent) && parent.argumentExpression === literal) ||
			isUnannotatedConstInitializer(literal, parent) ||
			(ts.isCallExpression(parent) && isTitle(literal, parent))
		)
	}
	const string = checker.getStringType()
	const checks = (type: Type, text: string): boolean =>
		!checker.isTypeAssignableTo(string, type) && Arr.contains(literalMembersOf(type), text)
	const isProse = (call: ts.CallExpression, literal: Literal): boolean => {
		const parameters = checker.getResolvedSignature(call).getParameters()
		return Option.exists(
			Arr.findFirstIndex(call.arguments, (argument) => argument === literal),
			(index) =>
				Option.exists(Arr.get(parameters, Math.min(index, parameters.length - 1)), (parameter) =>
					Arr.contains(explanations, parameter.name)
				)
		)
	}
	const isChecked = (literal: Literal): boolean => {
		const { parent } = literal
		if (ts.isBinaryExpression(parent) && isEquality(parent.operatorToken.kind)) {
			const other = parent.left === literal ? parent.right : parent.left
			const type = semantics.typeAt(other)
			return type !== undefined && checks(type, literal.text)
		}
		if (ts.isCaseClause(parent) && ts.isSwitchStatement(parent.parent.parent)) {
			const type = semantics.typeAt(parent.parent.parent.expression)
			return type !== undefined && checks(type, literal.text)
		}
		if (ts.isCallExpression(parent) && isProse(parent, literal)) {
			return true
		}
		const contextual = checker.getContextualType(literal)
		return contextual !== undefined && !checker.isTypeAssignableTo(string, contextual)
	}
	let vocabulary = Option.none<ReadonlyMap<string, Member>>()
	const vocabularyOf = (
		literal: Literal
	): Readonly<{ members: ReadonlyMap<string, Member>; misconfigured: ReadonlyArray<Report> }> => {
		if (Option.isSome(vocabulary)) {
			return { members: vocabulary.value, misconfigured: [] }
		}
		const aliases = declaredAliasesOf({
			checker,
			fileName: sourceFile.fileName,
			declared: vocabularies
		})
		const members: ReadonlyMap<string, Member> = new Map(
			Arr.flatMap(aliases.found, ({ declared, type }) =>
				Arr.map(
					Arr.filter(literalMembersOf(type), (text) => !isOneLowercaseWord(text)),
					(text): readonly [string, Member] => [
						text,
						{ alias: declared.alias, module: declared.module }
					]
				)
			)
		)
		vocabulary = Option.some(members)
		return {
			members,
			misconfigured: Arr.map(aliases.missing, (declared) => ({
				node: literal,
				message: missingAliasMessage("uncheckedVocabularyLiteral.vocabularies", declared)
			}))
		}
	}
	return (node) => {
		if (
			(!ts.isStringLiteral(node) && !ts.isNoSubstitutionTemplateLiteral(node)) ||
			isOneLowercaseWord(node.text) ||
			isNotAReference(node)
		) {
			return []
		}
		const { members, misconfigured } = vocabularyOf(node)
		const member = members.get(node.text)
		if (member === undefined || isChecked(node)) {
			return misconfigured
		}
		return [
			...misconfigured,
			{
				node,
				message: `"${node.text}" names a member of ${member.alias} (${member.module}), but the compiler cannot check it here.`,
				suggestion: `Type the parameter or field ${member.alias}, or compare against a field typed ${member.alias}.`
			}
		]
	}
}
