import { regex } from "arkregex"
import { Array as Arr, Effect, Path, Result, Schema, String as Str } from "effect"
import * as ts from "typescript/ast"
import { createFileSystem } from "typescript/fs"
import { API } from "typescript/sync"

/**
 * Source mutation, for measuring whether a suite catches a wrong change: each operator rewrites one span of a source
 * file the way a real slip would (a comparison flipped, a conjunct dropped, a guard deleted, an early exit removed, two
 * arms swapped, a pipe stage dropped, a bound moved by one), so a mutant the suite still passes on names behaviour no
 * test pins. The operators read TypeScript 7's native syntax tree and never type information, so a mutant may not
 * typecheck; the tester sets those aside as invalid. scripts/mutate.ts runs a package's suite against each mutant.
 */
export const OPERATORS = [
	"comparison",
	"conjunct",
	"disjunct",
	"negation",
	"boolean",
	"arm-swap",
	"statement",
	"guard",
	"bound",
	"fallback",
	"operand-swap",
	"quantifier",
	"element",
	"pipe-stage"
] as const

export type Operator = (typeof OPERATORS)[number]

/** One mutant of one file: the span it replaces, what it puts there, and where a person reads it. */
export type Mutant = Readonly<{
	id: string
	file: string
	/** The unmutated text of the mutant's file. */
	source: string
	operator: Operator
	start: number
	end: number
	replacement: string
	line: number
	column: number
	fn: string
	original: string
}>

/** The mutant's file with its span replaced. */
export const applied = (mutant: Mutant): string =>
	`${Str.slice(0, mutant.start)(mutant.source)}${mutant.replacement}${Str.slice(mutant.end)(mutant.source)}`

/** The native compiler did not admit a source it was asked to read. */
class MutationSourceRefused extends Schema.TaggedError<
	MutationSourceRefused,
	{ readonly brand: unique symbol }
>()("MutationSourceRefused", { file: Schema.String }) {}

type Span = Readonly<{ start: number; end: number }>

type Draft = Span & Readonly<{ operator: Operator; replacement: string; fn: string }>

const FLIPPED: ReadonlyMap<ts.SyntaxKind, string> = new Map([
	[ts.SyntaxKind.LessThanToken, ">="],
	[ts.SyntaxKind.LessThanEqualsToken, ">"],
	[ts.SyntaxKind.GreaterThanToken, "<="],
	[ts.SyntaxKind.GreaterThanEqualsToken, "<"],
	[ts.SyntaxKind.EqualsEqualsEqualsToken, "!=="],
	[ts.SyntaxKind.ExclamationEqualsEqualsToken, "==="]
])

const isExit = (s: ts.Statement) =>
	ts.isReturnStatement(s) ||
	ts.isContinueStatement(s) ||
	ts.isBreakStatement(s) ||
	ts.isThrowStatement(s)

const method = (node: ts.Node) =>
	ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
		? { call: node, callee: node.expression }
		: undefined

/** The node a function is the value of: its parent, or the declaration of the `fn`/`fnUntraced` it is the body of. */
const holderOf = (fn: ts.ArrowFunction | ts.FunctionExpression): ts.Node => {
	const call = fn.parent
	const name =
		ts.isCallExpression(call) && call.arguments[0] === fn
			? method(call)?.callee.name.text
			: undefined
	return name === "fnUntraced" || name === "fn" ? call.parent : call
}

/** The name a function is known by, where it has one. */
const nameOf = (node: ts.Node): string | undefined => {
	if (ts.isFunctionDeclaration(node) && node.name !== undefined) {
		return node.name.text
	}
	if (!ts.isArrowFunction(node) && !ts.isFunctionExpression(node)) {
		return undefined
	}
	const holder = holderOf(node)
	return ts.isVariableDeclaration(holder) && ts.isIdentifier(holder.name)
		? holder.name.text
		: undefined
}

/** The operands of a left-nested chain of one binary operator, from its top node. */
const chainOf = (node: ts.BinaryExpression, kind: ts.SyntaxKind): Array<ts.Expression> => {
	const operands: Array<ts.Expression> = []
	let left: ts.Expression = node
	while (ts.isBinaryExpression(left) && left.operatorToken.kind === kind) {
		operands.unshift(left.right)
		left = left.left
	}
	operands.unshift(left)
	return operands
}

const isChainTop = (node: ts.BinaryExpression, kind: ts.SyntaxKind) =>
	node.operatorToken.kind === kind &&
	!(
		ts.isBinaryExpression(node.parent) &&
		node.parent.operatorToken.kind === kind &&
		node.parent.left === node
	)

/** Where an operator finds its spans: the source, and the one way to record a mutant. */
type Site = Readonly<{
	text: string
	source: ts.SourceFile
	slice: (node: ts.Node) => string
	span: (node: ts.Node) => Span
	add: (operator: Operator, span: Span, replacement: string) => void
}>

type Rule = (node: ts.Node, site: Site) => void

const without = (items: ReadonlyArray<string>, index: number) => Arr.remove(items, index)

/** A comparison flipped to its complement. */
const comparison: Rule = (node, { add, span }) => {
	const flip = ts.isBinaryExpression(node) ? FLIPPED.get(node.operatorToken.kind) : undefined
	if (ts.isBinaryExpression(node) && flip !== undefined) {
		add("comparison", span(node.operatorToken), flip)
	}
}

const CHAINS = [
	[ts.SyntaxKind.AmpersandAmpersandToken, "conjunct", " && "],
	[ts.SyntaxKind.BarBarToken, "disjunct", " || "]
] as const

/** One operand of an && or || chain dropped. */
const chain: Rule = (node, { add, slice, span }) => {
	if (!ts.isBinaryExpression(node)) {
		return
	}
	for (const [kind, operator, glue] of Arr.filter(CHAINS, ([top]) => isChainTop(node, top))) {
		const operands = Arr.map(chainOf(node, kind), slice)
		for (const index of operands.keys()) {
			add(operator, span(node), Arr.join(without(operands, index), glue))
		}
	}
}

/** A fallback dropped, and a difference's operands swapped. */
const arithmetic: Rule = (node, { add, slice, span }) => {
	if (!ts.isBinaryExpression(node)) {
		return
	}
	if (node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
		add("fallback", span(node), slice(node.left))
	}
	if (node.operatorToken.kind === ts.SyntaxKind.MinusToken) {
		add("operand-swap", span(node), `${slice(node.right)} - ${slice(node.left)}`)
	}
}

/** `some` and `every` exchanged, on a collection: never on `Option.some`, which constructs an Option. */
const quantifier: Rule = (node, { add, span }) => {
	const found = method(node)
	const name = found?.callee.name
	const constructsOption =
		found !== undefined &&
		ts.isIdentifier(found.callee.expression) &&
		found.callee.expression.text === "Option"
	if (!constructsOption && (name?.text === "some" || name?.text === "every")) {
		add("quantifier", span(name), name.text === "some" ? "every" : "some")
	}
}

/** One stage of a pipe dropped, or one pipeable of an `Effect.fn` or `Effect.fnUntraced`. */
const pipeStage: Rule = (node, { add, slice, span }) => {
	const found = method(node)
	if (found === undefined) {
		return
	}
	const subject = slice(found.callee.expression)
	if (found.callee.name.text === "pipe") {
		const stages = Arr.map(found.call.arguments, slice)
		for (const index of stages.keys()) {
			const kept = without(stages, index)
			add(
				"pipe-stage",
				span(node),
				kept.length === 0 ? subject : `${subject}.pipe(${Arr.join(kept, ", ")})`
			)
		}
	}
	const [body, ...pipeables] = found.call.arguments
	const fn = found.callee.name.text
	if ((fn === "fnUntraced" || fn === "fn") && body !== undefined) {
		const stages = Arr.map(pipeables, slice)
		for (const index of stages.keys()) {
			add(
				"pipe-stage",
				span(node),
				`${subject}.${fn}(${Arr.join([slice(body), ...without(stages, index)], ", ")})`
			)
		}
	}
}

const exits = (then: ts.Statement) =>
	ts.isBlock(then)
		? then.statements.length === 1 && Arr.every(then.statements, isExit)
		: isExit(then)

/** An early exit deleted, and an if's arms swapped. */
const branch: Rule = (node, { add, slice, span }) => {
	if (!ts.isIfStatement(node)) {
		return
	}
	const otherwise = node.elseStatement
	if (otherwise === undefined && exits(node.thenStatement)) {
		add("guard", span(node), "{}")
	}
	if (otherwise !== undefined) {
		add(
			"arm-swap",
			span(node),
			`if (${slice(node.expression)}) ${slice(otherwise)} else ${slice(node.thenStatement)}`
		)
	}
}

/** A statement of a block or a switch arm deleted. */
const statement: Rule = (node, { add, span }) => {
	const parent =
		ts.isExpressionStatement(node) || ts.isBreakStatement(node) ? node.parent : undefined
	if (
		parent !== undefined &&
		(ts.isBlock(parent) || ts.isCaseClause(parent) || ts.isDefaultClause(parent))
	) {
		add("statement", span(node), "{}")
	}
}

/** Two neighbouring switch arms' bodies swapped. */
const caseSwap: Rule = (node, { add, text, source }) => {
	if (!ts.isSwitchStatement(node)) {
		return
	}
	const first = (c: ts.CaseOrDefaultClause) => c.statements[0]?.getStart(source) ?? c.end
	const last = (c: ts.CaseOrDefaultClause) => c.statements.at(-1)?.end ?? c.end
	const body = (c: ts.CaseOrDefaultClause) => Str.slice(first(c), last(c))(text)
	const clauses = Arr.filter(node.caseBlock.clauses, (clause) => clause.statements.length > 0)
	for (const [index, clause] of clauses.entries()) {
		const next = clauses[index + 1]
		if (next !== undefined) {
			const between = Str.slice(last(clause), first(next))(text)
			add(
				"arm-swap",
				{ start: first(clause), end: last(next) },
				`${body(next)}${between}${body(clause)}`
			)
		}
	}
}

/** One element of an array literal dropped. */
const element: Rule = (node, { add, slice, span }) => {
	if (ts.isArrayLiteralExpression(node) && node.elements.length > 1) {
		const elements = Arr.map(node.elements, slice)
		for (const index of elements.keys()) {
			add("element", span(node), `[${Arr.join(without(elements, index), ", ")}]`)
		}
	}
}

/** A conditional's arms swapped. */
const conditional: Rule = (node, { add, slice, span }) => {
	if (ts.isConditionalExpression(node)) {
		add(
			"arm-swap",
			span(node),
			`${slice(node.condition)} ? ${slice(node.whenFalse)} : ${slice(node.whenTrue)}`
		)
	}
}

/** A negation dropped. */
const negation: Rule = (node, { add, slice, span }) => {
	if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) {
		add("negation", span(node), slice(node.operand))
	}
}

/** A boolean literal flipped, and a number an arithmetic or comparison reads moved by one either way. */
const literal: Rule = (node, { add, span }) => {
	if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) {
		add("boolean", span(node), node.kind === ts.SyntaxKind.TrueKeyword ? "false" : "true")
	}
	if (ts.isNumericLiteral(node) && ts.isBinaryExpression(node.parent)) {
		const value = Number(node.text)
		add("bound", span(node), String(value + 1))
		add("bound", span(node), value === 0 ? "(-1)" : String(value - 1))
	}
}

const RULES: ReadonlyArray<Rule> = [
	comparison,
	chain,
	arithmetic,
	quantifier,
	pipeStage,
	branch,
	statement,
	caseSwap,
	element,
	conditional,
	negation,
	literal
]

/** A mutant before its id: `key` names it among every mutant of its file, and the id is its digest. */
type Located = Omit<Mutant, "id"> & Readonly<{ key: string }>

/** Every mutant of one parsed source, outside type positions and imports. */
const locatedOf = (file: string, text: string, source: ts.SourceFile): ReadonlyArray<Located> => {
	const drafts: Array<Draft> = []
	const functions: Array<string> = []
	const site: Site = {
		text,
		source,
		slice: (node) => Str.slice(node.getStart(source), node.end)(text),
		span: (node) => ({ start: node.getStart(source), end: node.end }),
		add: (operator, { start, end }, replacement) => {
			if (Str.slice(start, end)(text) !== replacement) {
				drafts.push({ operator, start, end, replacement, fn: functions.at(-1) ?? "<module>" })
			}
		}
	}
	const visit = (node: ts.Node): void => {
		if (ts.isTypeNode(node) || ts.isImportDeclaration(node)) {
			return
		}
		const name = nameOf(node)
		if (name !== undefined) {
			functions.push(name)
		}
		for (const rule of RULES) {
			rule(node, site)
		}
		node.forEachChild(visit)
		if (name !== undefined) {
			functions.pop()
		}
	}
	visit(source)
	const seen = new Map<string, number>()
	return Arr.map(drafts, (draft) => {
		const original = Str.slice(draft.start, draft.end)(text)
		const key = Arr.join([file, draft.operator, draft.fn, original, draft.replacement], "\u0000")
		const ordinal = seen.get(key) ?? 0
		seen.set(key, ordinal + 1)
		const { line, character } = source.getLineAndCharacterOfPosition(draft.start)
		return {
			key: `${key}\u0000${String(ordinal)}`,
			file,
			source: text,
			...draft,
			line: line + 1,
			column: character + 1,
			original
		}
	})
}

const BYTE_ORDER_MARK = regex("^﻿")

/**
 * A mutant's id: ten hex digits from two FNV-1a lanes over its key's UTF-8, 40 bits. It needs no platform service, so
 * the library uses no crypto API, and it is the same on every machine and run; a file's few thousand mutants collide
 * with negligible probability.
 */
const idOf = (key: string): string => {
	let h1 = 0x811c_9dc5
	let h2 = 0x01_00_01b3
	for (const byte of new TextEncoder().encode(key)) {
		h1 = Math.imul(h1 ^ byte, 0x0100_0193)
		h2 = Math.imul(h2 ^ byte, 0x5bd1_e995)
		h2 ^= h2 >>> 15
	}
	return `${Str.padStart(8, "0")((h1 >>> 0).toString(16))}${Str.padStart(2, "0")((h2 >>> 24).toString(16))}`
}

/**
 * Every mutant of `sources` (each a file's name and its text), read through TypeScript 7's native compiler in a
 * file system of their own, so nothing on disk but the compiler is read. Each mutant's id is its key's idOf, stable
 * across runs while its file's text is.
 */
export const mutantsOf = Effect.fn("testing.mutants.of")(function* (
	sources: ReadonlyArray<Readonly<{ file: string; text: string }>>
) {
	const path = yield* Path.Path
	const root = path.resolve(".testing-mutants")
	const config = path.join(root, "tsconfig.json")
	const entries = Arr.map(sources, (source, index) => ({
		source,
		at: path.join(root, `source-${index}.ts`)
	}))
	const located = yield* Effect.try({
		try: (): Result.Result<ReadonlyArray<Located>, MutationSourceRefused> => {
			const fileSystem = createFileSystem([
				[
					config,
					`{"compilerOptions":{"target":"esnext","noLib":true,"noResolve":true,"types":[]},"files":[${Arr.join(
						Arr.map(entries, ({ at }) => `"${at}"`),
						","
					)}]}`
				],
				...Arr.map(
					entries,
					({ source, at }) => [at, Str.replace(BYTE_ORDER_MARK, " ")(source.text)] as const
				)
			])
			using session = {
				api: new API({ cwd: root }),
				[Symbol.dispose]() {
					this.api.close()
				}
			}
			using snapshot = session.api.createSnapshot({ openProjects: [config], fileSystem })
			const project = snapshot.getConfiguredProject(config)
			const all: Array<Located> = []
			for (const { source, at } of entries) {
				const parsed = project?.program.getSourceFile(at)
				if (parsed === undefined) {
					return Result.fail(MutationSourceRefused.make({ file: source.file }))
				}
				for (const mutant of locatedOf(source.file, source.text, parsed)) {
					all.push(mutant)
				}
			}
			return Result.succeed(all)
		},
		catch: () =>
			MutationSourceRefused.make({
				file: Arr.join(
					Arr.map(sources, (s) => s.file),
					", "
				)
			})
	}).pipe(Effect.flatMap(Effect.fromResult))
	return Arr.map(located, ({ key, ...mutant }): Mutant => ({ id: idOf(key), ...mutant }))
})
