import { Array as Arr, Option, Result, String as Str } from "effect"
import * as ts from "typescript/ast"
import type { Checker, Type } from "typescript/sync"
import { declaredTypesOf, missingTypeMessage } from "#lint/declared.ts"
import { isAtAny } from "#lint/paths.ts"
import type { RuleContext, Visit } from "#lint/types.ts"
import type { Report } from "#shared/finding.ts"
import { isTestFile } from "#shared/tests.ts"

/** Where a vocabulary member is declared, and the type that checks it: the declared type itself for a union of
 * strings, its `_tag` for a union of tagged values. */
type Member = Readonly<{ module: string; checkedBy: string }>

type Literal = ts.StringLiteral | ts.NoSubstitutionTemplateLiteral

const unionMembersOf = (type: Type): ReadonlyArray<Type> =>
	type.isUnionType() ? type.getTypes() : [type]

const literalMembersOf = (type: Type): ReadonlyArray<string> =>
	Arr.flatMap(unionMembersOf(type), (member) =>
		member.isStringLiteralType() && typeof member.value === "string" ? [member.value] : []
	)

/** A member a declared type spells, and whether it is a tagged value's `_tag`. */
type Spelled = Readonly<{ text: string; tagged: boolean }>

/** The members a declared type spells: its string literals, and the `_tag` of each tagged value among its members
 * (a tagged error class, or a union of them). */
const vocabularyOf = (checker: Checker, type: Type): ReadonlyArray<Spelled> =>
	Arr.flatMap(unionMembersOf(type), (member): ReadonlyArray<Spelled> => {
		if (member.isStringLiteralType()) {
			return Arr.map(literalMembersOf(member), (text) => ({ text, tagged: false }))
		}
		const tag = checker.getPropertyOfType(member, "_tag")
		return tag === undefined
			? []
			: Arr.map(literalMembersOf(checker.getTypeOfSymbol(tag)), (text) => ({ text, tagged: true }))
	})

/** A member that is one lowercase word collides with English and with field names, so it is left out of the
 * vocabulary and the typed door checks it. */
const isOneLowercaseWord = (text: string): boolean =>
	Str.isNonEmpty(text) &&
	Arr.every(Str.split("")(text), (character) => character >= "a" && character <= "z")

/** The registrar a call names, through `it.each(cases)` and the like: `it(…)`, `it.effect(…)`, `it.each(cases)(…)`;
 * none for any other callee shape. */
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
 * spells "TodoNotFound" into a `string` position keeps compiling when the source renames or deletes the error, and
 * fails at run time or not at all. In the test files and the test support the options name, every string literal
 * whose text is a member of a declared vocabulary (a union of strings, or the `_tag` of a tagged error) is checked,
 * unless it sits where its text is not a vocabulary reference (a type, an import or export specifier, a property
 * name, an unannotated const's initializer, a registrar's title, the argument of a prose parameter) or where the
 * compiler already checks it (an equality whose other side, or a case whose switch, is typed by a literal union
 * holding the text, or a contextual type narrower than string). An equality whose type parameter infers from both
 * sides (`strictEqual(error._tag, "TodoNotFound")`) widens the literal to string, so it is not checked. The
 * vocabularies are read through the checker once per file, at its first candidate literal, which also reports a
 * vocabulary whose module the file's program holds without its type; a module it does not hold is not its vocabulary.
 */
export const uncheckedVocabularyLiteral: Visit = (context: RuleContext) => {
	const { sourceFile, checker, semantics, options } = context
	const { support, vocabularies, titled, explanations } = options.uncheckedVocabularyLiteral
	if (
		!Arr.isReadonlyArrayNonEmpty(vocabularies) ||
		!(isTestFile(sourceFile.fileName) || isAtAny(support, sourceFile.fileName))
	) {
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
	let read = Option.none<ReadonlyMap<string, Member>>()
	const membersAt = (
		literal: Literal
	): Readonly<{ members: ReadonlyMap<string, Member>; misconfigured: ReadonlyArray<Report> }> => {
		if (Option.isSome(read)) {
			return { members: read.value, misconfigured: [] }
		}
		const declared = declaredTypesOf({
			checker,
			fileName: sourceFile.fileName,
			declared: vocabularies
		})
		const members: ReadonlyMap<string, Member> = new Map(
			Arr.flatMap(declared.found, (found) =>
				Arr.filterMap(
					vocabularyOf(checker, found.type),
					({ text, tagged }): Result.Result<readonly [string, Member], void> =>
						isOneLowercaseWord(text)
							? Result.failVoid
							: Result.succeed([
									text,
									{
										module: found.declared.module,
										checkedBy: tagged ? `${found.declared.type}["_tag"]` : found.declared.type
									}
								])
				)
			)
		)
		read = Option.some(members)
		return {
			members,
			misconfigured: Arr.map(declared.missing, (missing) => ({
				node: literal,
				message: missingTypeMessage("uncheckedVocabularyLiteral.vocabularies", missing)
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
		const { members, misconfigured } = membersAt(node)
		const member = members.get(node.text)
		if (member === undefined || isChecked(node)) {
			return misconfigured
		}
		return [
			...misconfigured,
			{
				node,
				message: `"${node.text}" names a member of ${member.checkedBy} (${member.module}), but the compiler cannot check it here.`,
				suggestion: `Type the parameter or field ${member.checkedBy}, or compare against a field typed ${member.checkedBy}.`
			}
		]
	}
}
