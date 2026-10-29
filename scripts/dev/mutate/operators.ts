import { Array as Arr, Option, pipe, String as Str } from "effect"
import * as ts from "typescript/ast"
import { sha256Hex } from "#compiler/core/sha256.ts"
import {
	isWorldFile,
	visitWorld,
	type WorldSite,
	worldOperators
} from "#scripts/dev/mutate/world.ts"

import {
	type SyntaxInput,
	type SyntaxSource,
	withNativeSyntax
} from "#scripts/dev/shared/native-syntax.ts"

import { regex } from "arkregex"
/** The operators that apply to every file in scope. */
export const classicOperators = [
	"comparison",
	"conjunct",
	"boolean-return",
	"set-semantics",
	"bound",
	"guard"
] as const

/** Every operator, the classic ones then the `sql-world` family, which applies only to the world files. */
export const operators = [...classicOperators, ...worldOperators] as const
export type Operator = (typeof operators)[number]

/** The operator families a run names with --operators: each the operators it stands for. */
export const families: Readonly<Record<string, ReadonlyArray<Operator>>> = {
	classic: classicOperators,
	"sql-world": worldOperators
}

export interface Mutant {
	/**
	 * Stable across edits elsewhere in the file: a digest of the file, the operator, the enclosing function, the
	 * original and replacement text, and the ordinal among identical such mutants.
	 */
	readonly id: string
	readonly file: string
	readonly operator: Operator
	readonly start: number
	readonly end: number
	readonly replacement: string
	readonly line: number
	readonly column: number
	readonly function: string
	readonly original: string
}

interface Draft {
	readonly operator: Operator
	readonly start: number
	readonly end: number
	readonly replacement: string
	readonly function: string
}

const flipped: ReadonlyMap<ts.SyntaxKind, string> = new Map([
	[ts.SyntaxKind.LessThanToken, ">="],
	[ts.SyntaxKind.LessThanEqualsToken, ">"],
	[ts.SyntaxKind.GreaterThanToken, "<="],
	[ts.SyntaxKind.GreaterThanEqualsToken, "<"],
	[ts.SyntaxKind.EqualsEqualsEqualsToken, "!=="],
	[ts.SyntaxKind.ExclamationEqualsEqualsToken, "==="],
	[ts.SyntaxKind.EqualsEqualsToken, "!="],
	[ts.SyntaxKind.ExclamationEqualsToken, "=="]
])

const boundParents: ReadonlySet<ts.SyntaxKind> = new Set([
	...flipped.keys(),
	ts.SyntaxKind.PlusToken,
	ts.SyntaxKind.MinusToken
])

/** Methods whose call is a boolean, for recognizing a boolean-returning function with no annotation. */
const booleanMethods: ReadonlySet<string> = new Set([
	"some",
	"every",
	"has",
	"includes",
	"startsWith",
	"endsWith",
	"test",
	"isArray"
])

const skipParens = (e: ts.Expression): ts.Expression => {
	let out = e
	while (ts.isParenthesizedExpression(out)) {
		out = out.expression
	}
	return out
}

/**
 * Whether `e` is a boolean by its syntax alone: a boolean literal, a negation, a comparison, a logical combination of
 * booleans, or a call of a boolean method.
 */
const isBooleanSyntax = (e: ts.Expression): boolean => {
	const x = skipParens(e)
	if (x.kind === ts.SyntaxKind.TrueKeyword || x.kind === ts.SyntaxKind.FalseKeyword) {
		return true
	}
	if (ts.isPrefixUnaryExpression(x)) {
		return x.operator === ts.SyntaxKind.ExclamationToken
	}
	if (ts.isBinaryExpression(x)) {
		const op = x.operatorToken.kind
		if (
			flipped.has(op) ||
			op === ts.SyntaxKind.InstanceOfKeyword ||
			op === ts.SyntaxKind.InKeyword
		) {
			return true
		}
		if (op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.BarBarToken) {
			return isBooleanSyntax(x.left) && isBooleanSyntax(x.right)
		}
		return false
	}
	if (ts.isCallExpression(x) && ts.isPropertyAccessExpression(x.expression)) {
		return booleanMethods.has(x.expression.name.text)
	}
	return false
}

type FunctionLike =
	| ts.FunctionDeclaration
	| ts.MethodDeclaration
	| ts.ArrowFunction
	| ts.FunctionExpression

const isFunctionLike = (node: ts.Node): node is FunctionLike =>
	ts.isFunctionDeclaration(node) ||
	ts.isMethodDeclaration(node) ||
	ts.isArrowFunction(node) ||
	ts.isFunctionExpression(node)

const nameOf = (node: ts.Node): string => {
	if (
		(ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) &&
		node.name !== undefined
	) {
		return node.name.text
	}
	if (
		ts.isMethodDeclaration(node) &&
		(ts.isIdentifier(node.name) || ts.isPrivateIdentifier(node.name))
	) {
		return node.name.text
	}
	const parent = node.parent
	if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
		return parent.name.text
	}
	if (ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name)) {
		return parent.name.text
	}
	if (ts.isPropertyDeclaration(parent) && ts.isIdentifier(parent.name)) {
		return parent.name.text
	}
	return "<anonymous>"
}

/** The return statements of a function body, not those of functions nested in it. */
const returnsOf = (body: ts.Block): ReadonlyArray<ts.ReturnStatement> => {
	const out: Array<ts.ReturnStatement> = []
	const visit = (node: ts.Node): void => {
		if (isFunctionLike(node) || ts.isClassLikeDeclaration(node)) {
			return
		}
		if (ts.isReturnStatement(node)) {
			out.push(node)
		}
		node.forEachChild(visit)
	}
	body.forEachChild(visit)
	return out
}

const returnsBoolean = (fn: FunctionLike): boolean => {
	if (fn.body === undefined || fn.asteriskToken !== undefined) {
		return false
	}
	if (
		fn.modifiers !== undefined &&
		Arr.some(fn.modifiers, (m) => m.kind === ts.SyntaxKind.AsyncKeyword)
	) {
		return false
	}
	if (fn.type !== undefined) {
		return fn.type.kind === ts.SyntaxKind.BooleanKeyword || ts.isTypePredicateNode(fn.type)
	}
	if (!ts.isBlock(fn.body)) {
		return isBooleanSyntax(fn.body)
	}
	const returns = returnsOf(fn.body)
	return (
		returns.length > 0 &&
		Arr.every(returns, (r) => r.expression !== undefined && isBooleanSyntax(r.expression))
	)
}

const isExit = (s: ts.Statement): boolean =>
	ts.isReturnStatement(s) ||
	ts.isContinueStatement(s) ||
	ts.isBreakStatement(s) ||
	ts.isThrowStatement(s)

/** The conjuncts of a chain `a && b && c`, which is left-nested: its top is the `&&` no left operand of another. */
const conjunctsOf = (top: ts.Expression): ReadonlyArray<ts.Expression> => {
	const conjuncts: Array<ts.Expression> = []
	let left: ts.Expression = top
	while (
		ts.isBinaryExpression(left) &&
		left.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
	) {
		conjuncts.unshift(left.right)
		left = left.left
	}
	conjuncts.unshift(left)
	return conjuncts
}

/**
 * The occurrences of `needle` in `text`, as offsets. matchAll gives each match its index, which RegExpMatchArray types
 * as optional: a match without one is none of them.
 */
const occurrences = (
	text: string,
	needle: RegExp
): ReadonlyArray<{ readonly at: number; readonly match: string }> =>
	Arr.flatMap([...Str.matchAll(needle)(text)], (m) =>
		m.index === undefined ? [] : [{ at: m.index, match: m[0] }]
	)

/** Every mutant of one parsed source file. Its `file` is the repository-relative path recorded in each mutant. */
const mutantsOfSource = ({
	file,
	text,
	sourceFile: source
}: SyntaxSource<SyntaxInput>): ReadonlyArray<Mutant> => {
	const drafts: Array<Draft> = []
	const functions: Array<string> = []
	const current = (): string => functions.at(-1) ?? "<module>"
	const add = (operator: Operator, start: number, end: number, replacement: string): void => {
		if (Str.slice(start, end)(text) !== replacement) {
			drafts.push({ operator, start, end, replacement, function: current() })
		}
	}
	/** A world fault two visits find, a template and a string inside it, is one mutant. */
	const addOnce = (operator: Operator, start: number, end: number, replacement: string): void => {
		const twin = Arr.some(
			drafts,
			(d) =>
				d.operator === operator &&
				d.start === start &&
				d.end === end &&
				d.replacement === replacement
		)
		if (!twin) {
			add(operator, start, end, replacement)
		}
	}
	const world: Option.Option<WorldSite> = isWorldFile(file)
		? Option.some({ file, text, source, add: addOnce })
		: Option.none()

	/**
	 * SQL text inside a string literal or template part: UNION ALL and UNION swapped, DISTINCT dropped. Only SQL: a
	 * literal that is a set keyword alone, or reads like a statement; prose that names UNION is left alone.
	 */
	const sqlText = (node: ts.Node & { readonly text: string }): void => {
		if (
			!regex("^\\s*(?:UNION(?: ALL)?|DISTINCT)\\s*$").test(node.text) &&
			!regex("\\b(?:SELECT|FROM|WHERE|JOIN)\\b").test(node.text)
		) {
			return
		}
		const start = node.getStart(source)
		const raw = Str.slice(start, node.end)(text)
		for (const { at } of occurrences(raw, regex("\\bUNION ALL\\b", "g"))) {
			add("set-semantics", start + at, start + at + 9, "UNION")
		}
		for (const { at } of occurrences(raw, regex("\\bUNION\\b(?! ALL\\b)", "g"))) {
			add("set-semantics", start + at, start + at + 5, "UNION ALL")
		}
		for (const { at, match } of occurrences(
			raw,
			regex("(?<!\\bIS (?:NOT )?)\\bDISTINCT (?!FROM\\b)", "g")
		)) {
			add("set-semantics", start + at, start + at + match.length, "")
		}
	}

	const booleanReturn = (fn: FunctionLike): void => {
		if (!returnsBoolean(fn) || fn.body === undefined) {
			return
		}
		const block = ts.isBlock(fn.body)
		const bodyStart = fn.body.getStart(source)
		for (const value of ["true", "false"]) {
			add("boolean-return", bodyStart, fn.body.end, block ? `{ return ${value} }` : value)
		}
	}
	const binary = (node: ts.BinaryExpression): void => {
		const op = node.operatorToken.kind
		const flip = flipped.get(op)
		if (flip !== undefined) {
			add("comparison", node.operatorToken.getStart(source), node.operatorToken.end, flip)
		}
		const parent = node.parent
		const isChainTop =
			op === ts.SyntaxKind.AmpersandAmpersandToken &&
			!(
				ts.isBinaryExpression(parent) &&
				parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
				parent.left === node
			)
		if (!isChainTop) {
			return
		}
		const texts = Arr.map(conjunctsOf(node), (c) =>
			pipe(text, Str.slice(c.getStart(source), c.end))
		)
		for (const i of texts.keys()) {
			add("conjunct", node.getStart(source), node.end, Arr.join(Arr.remove(texts, i), " && "))
		}
	}
	const bound = (node: ts.NumericLiteral): void => {
		const negated =
			ts.isPrefixUnaryExpression(node.parent) && node.parent.operator === ts.SyntaxKind.MinusToken
		const site = negated ? node.parent : node
		const operand = site.parent
		if (!ts.isBinaryExpression(operand) || !boundParents.has(operand.operatorToken.kind)) {
			return
		}
		const value = Number(node.text) * (negated ? -1 : 1)
		for (const moved of [value - 1, value + 1]) {
			add("bound", site.getStart(source), site.end, moved < 0 ? `(${moved})` : String(moved))
		}
	}
	const distinctFlag = (node: ts.PropertyAssignment): void => {
		const value = ts.isAsExpression(node.initializer)
			? node.initializer.expression
			: node.initializer
		if (value.kind === ts.SyntaxKind.TrueKeyword) {
			add("set-semantics", value.getStart(source), value.end, "false")
		}
		if (value.kind === ts.SyntaxKind.FalseKeyword) {
			add("set-semantics", value.getStart(source), value.end, "true")
		}
	}
	const guard = (node: ts.IfStatement): void => {
		const then = node.thenStatement
		const exits = ts.isBlock(then)
			? then.statements.length === 1 && Arr.every(then.statements, isExit)
			: isExit(then)
		if (exits && node.elseStatement === undefined) {
			add("guard", node.getStart(source), node.end, "{}")
		}
	}
	/** Type positions carry no behaviour and take no mutant. */
	const visit = (node: ts.Node): void => {
		if (ts.isTypeNode(node) && !ts.isExpressionWithTypeArguments(node)) {
			return
		}
		const isFn = isFunctionLike(node)
		if (isFn) {
			functions.push(nameOf(node))
			booleanReturn(node)
		}
		if (ts.isBinaryExpression(node)) {
			binary(node)
		}
		if (ts.isNumericLiteral(node) && regex("^\\d+$").test(node.text)) {
			bound(node)
		}
		if (
			ts.isStringLiteral(node) ||
			ts.isNoSubstitutionTemplateLiteral(node) ||
			ts.isTemplateLiteralToken(node)
		) {
			sqlText(node)
		}
		if (
			ts.isPropertyAssignment(node) &&
			ts.isIdentifier(node.name) &&
			node.name.text === "distinct"
		) {
			distinctFlag(node)
		}
		if (ts.isIfStatement(node)) {
			guard(node)
		}
		if (Option.isSome(world)) {
			visitWorld(world.value, node)
		}
		node.forEachChild(visit)
		if (isFn) {
			functions.pop()
		}
	}
	visit(source)

	const seen = new Map<string, number>()
	return Arr.map(drafts, (d) => {
		const original = Str.slice(d.start, d.end)(text)
		const key = Arr.join([file, d.operator, d.function, original, d.replacement], "\u0000")
		const ordinal = seen.get(key) ?? 0
		seen.set(key, ordinal + 1)
		const id = pipe(sha256Hex(`${key}\u0000${ordinal}`), Str.slice(0, 12))
		const { line, character } = source.getLineAndCharacterOfPosition(d.start)
		return { id, file, ...d, line: line + 1, column: character + 1, original }
	})
}

/**
 * Every input with its mutants, from one native parse of them all: the mutation operators of grizzle's own mutation
 * tester, each rewriting a span of a source file of the compiler or the adapter, found on the TypeScript AST, into a
 * small fault the test suite ought to notice.
 *
 * - comparison: a relational or equality operator negated (`<` to `>=`, `===` to `!==`, ...);
 * - conjunct: one conjunct of an `&&` chain dropped, the chain's top being the `&&` that is no left operand of another;
 * - boolean-return: the body of a boolean-returning function replaced by `true`, and by `false`;
 * - set-semantics: UNION ALL swapped with UNION in SQL text, a `distinct: true` flag flipped, a DISTINCT keyword
 *   dropped from SQL text (a literal that is the keyword alone, or holds SELECT, FROM, WHERE or JOIN);
 * - bound: an integer literal in a comparison or an addition moved by one either way;
 * - guard: an early-exit `if (...) return | continue | break | throw` deleted;
 * - the `sql-world` family (world.ts), in the world files only.
 *
 * Type positions carry no behaviour and take no mutant. The parser is TypeScript 7's native one, one compiler process
 * for a whole batch of files. Type stripping keeps every offset, so a span here is also a span of the code Node runs.
 */
export const mutantsOf = <I extends SyntaxInput>(
	inputs: ReadonlyArray<I>
): ReadonlyArray<{ readonly input: I; readonly mutants: ReadonlyArray<Mutant> }> =>
	withNativeSyntax(inputs, (sources) =>
		Arr.map(sources, (source) => ({ input: source, mutants: mutantsOfSource(source) }))
	)

/** The mutated text of a mutant's file. */
export const applyMutant: (
	text: string,
	m: Pick<Mutant, "start" | "end" | "replacement">
) => string = (text, m) => `${Str.slice(0, m.start)(text)}${m.replacement}${Str.slice(m.end)(text)}`

/** Every input with whether it parses with no syntax error, for checking that an operator keeps its file valid. */
export const parsed = <I extends SyntaxInput>(
	inputs: ReadonlyArray<I>
): ReadonlyArray<{ readonly input: I; readonly parses: boolean }> =>
	withNativeSyntax(inputs, (sources) =>
		Arr.map(sources, (source) => ({ input: source, parses: source.diagnostics.length === 0 }))
	)
