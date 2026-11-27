/** What the properties of print.test.ts read: its spaces, models and helpers. */

import {
	array,
	boolean,
	characterOf,
	codePoint,
	constant,
	element,
	type Gen,
	int,
	oneOf,
	string,
	weighted
} from "@bjornpagen/testing/gen"
import { Array as Arr, Option, String as Str } from "effect"
import { SourceLoc } from "#compiler/core/loc.ts"
import { noAdvice } from "#compiler/sql/advice.ts"
import type {
	Expr,
	PerformQuery,
	PlBlock,
	PlDeclaration,
	PlFunction,
	PlStatement,
	RaiseOption,
	Select,
	SelectCore,
	SqlStatement,
	Target
} from "#compiler/sql/ast.ts"
import {
	asc,
	col,
	core,
	distinctCore,
	distinctOnCore,
	eq,
	grouped,
	lit,
	objectName,
	operandSelect,
	provedCore,
	provedSelect,
	select,
	setOperation,
	table,
	tableCol,
	target,
	types
} from "#compiler/sql/build.ts"
import { lex, type Token } from "#compiler/sql/lexer.ts"
import { sqlText, writeDoBlock } from "#compiler/sql/print.ts"
import { statementGen } from "#test/support/kernel/sqlgen.ts"
import { sqlCatalog } from "#test/unit/sql/audit/catalog.ts"

/**
 * The text a block's literals and RAISE messages are built of: the dollar-quote tags themselves, parts of them, line
 * breaks of both kinds PostgreSQL's scanner ends a comment at, a quote, the comment openers, and text around them.
 */
const fragments = [
	"$$",
	"$gz$",
	"$gz1$",
	"$gz2$",
	"$g",
	"z$",
	"$",
	"gz",
	"1$",
	"BEGIN",
	" ",
	"\n",
	"\r",
	"'",
	"--",
	"/*",
	"x"
] as const

/** Up to eight fragments, as one text. */
const fragmentText: Gen<string> = (s) =>
	Arr.join(s.draw(array(element(fragments), { min: 0, max: 8 })), "")

/** A PL/pgSQL variable read by name. */
const plVar = (name: string): Expr => ({ kind: "plVar", name })

/** A text literal of fragments. */
const textLiteral: Gen<Expr> = (s) => lit.text(s.draw(fragmentText), types.text)

/** An IF's or WHEN's condition: true, n equal to a digit, or t equal to a text literal. */
const condition: Gen<Expr> = oneOf([
	constant(lit.bool(true)),
	(s) => eq(plVar("n"), lit.int(s.draw(int(0, 9)), types.integer)),
	(s) => eq(plVar("t"), s.draw(textLiteral))
])

/** A query a block reads: one table's key, where a text column equals a drawn literal. */
const scan: Gen<SelectCore> = (s) =>
	core(
		[target(col("r1", "id"))],
		[table("audit", "order", "r1")],
		eq(col("r1", "select"), s.draw(textLiteral))
	)

/** A PERFORM's query: the scan, limited to one row or not. */
const performQuery: Gen<PerformQuery> = (s) => ({
	body: s.draw(scan),
	orderBy: [],
	limit: s.draw(boolean) ? lit.int(1, types.integer) : undefined,
	offset: undefined
})

/** The options a RAISE may take, in the order it states them. */
const raiseOptions: ReadonlyArray<RaiseOption["option"]> = ["ERRCODE", "CONSTRAINT", "DETAIL"]

/** A statement of one line: an assignment, a PERFORM, a RAISE without options, or a RETURN. */
const oneLineStatement: Gen<PlStatement> = weighted([
	[2, (s) => ({ kind: "assign", target: "t", value: s.draw(textLiteral) })],
	[2, (s) => ({ kind: "perform", query: s.draw(performQuery) })],
	[1, (s) => ({ kind: "raise", message: s.draw(fragmentText), using: [] })],
	[1, constant<PlStatement>({ kind: "return", value: lit.bool(true) })]
])

/** A statement that nests none: one of one line, or a RAISE with up to three USING options. */
const flatStatement: Gen<PlStatement> = weighted([
	[4, oneLineStatement],
	[
		3,
		(s) => ({
			kind: "raise",
			message: s.draw(fragmentText),
			using: Arr.map(Arr.take(raiseOptions, s.draw(int(0, raiseOptions.length))), (option) => ({
				option,
				value: s.draw(textLiteral)
			}))
		})
	]
])

/** At least one statement: a block's body and an absent probe's obligation are never empty. */
const nonEmptyStatements =
	(depth: number): Gen<Arr.NonEmptyReadonlyArray<PlStatement>> =>
	(s) => [s.draw(statementAt(depth)), ...s.draw(array(statementAt(depth), { min: 0, max: 2 }))]

/** Up to three statements nesting others at most `depth` levels deep. */
const statements = (depth: number): Gen<ReadonlyArray<PlStatement>> =>
	array(statementAt(depth), { min: 0, max: 3 })

/** One WHEN of a PL/pgSQL CASE: its values, at least one, and its body. */
type CaseWhen = Extract<PlStatement, { readonly kind: "case" }>["whens"][number]

/** A statement nesting others at most `depth` levels deep: IF with ELSIF and ELSE, FOR, an absent probe, CASE. */
const statementAt = (depth: number): Gen<PlStatement> =>
	depth === 0
		? flatStatement
		: weighted([
				[4, flatStatement],
				[
					2,
					(s) => ({
						kind: "if",
						branches: [
							{ condition: s.draw(condition), body: s.draw(statements(depth - 1)) },
							...s.draw(
								array(
									(t) => ({ condition: t.draw(condition), body: t.draw(statements(depth - 1)) }),
									{
										min: 0,
										max: 2
									}
								)
							)
						],
						else: s.draw(statements(depth - 1))
					})
				],
				[
					1,
					(s) => ({
						kind: "forQuery",
						variable: "r",
						query: provedSelect(
							"keyed",
							[target(col("r1", "id"))],
							[table("audit", "order", "r1")],
							undefined
						),
						body: s.draw(statements(depth - 1))
					})
				],
				[
					1,
					(s) => ({
						kind: "whenFound",
						query: operandSelect(s.draw(scan)),
						body: s.draw(nonEmptyStatements(depth - 1))
					})
				],
				[
					2,
					(s) => ({
						kind: "case",
						operand: plVar("n"),
						whens: [
							{
								values: [lit.int(s.draw(int(0, 9)), types.integer)],
								body: s.draw(statements(depth - 1))
							},
							...s.draw(
								array(
									(t): CaseWhen => ({
										values: [
											lit.int(t.draw(int(0, 9)), types.integer),
											...t.draw(
												array((u) => lit.int(u.draw(int(0, 9)), types.integer), { min: 0, max: 2 })
											)
										],
										body: t.draw(statements(depth - 1))
									}),
									{ min: 0, max: 2 }
								)
							)
						]
					})
				]
			])

/**
 * The variables the drawn statements read and assign, which every block declares, as PostgreSQL refuses a block reading
 * one it does not: n, the CASE operand and an IF's integer; t, assigned and an IF's text; r, the FOR loop's row.
 */
const readVariables: ReadonlyArray<PlDeclaration> = [
	{ name: "n", type: types.integer },
	{ name: "t", type: types.text },
	{ name: "r", type: types.integer }
]

/** Up to three integer declarations, d0 onward. */
const declarations: Gen<ReadonlyArray<PlDeclaration>> = (s) =>
	Array.from({ length: s.draw(int(0, 3)) }, (_, i) => ({ name: `d${i}`, type: types.integer }))

/** A PL/pgSQL block nested to a drawn depth, declaring the variables its statements read and up to three more. */
export const plBlockGen: Gen<PlBlock> = (s) => ({
	declare: [...readVariables, ...s.draw(declarations)],
	body: s.draw(nonEmptyStatements(s.draw(int(0, 3))))
})

/** Where a block holds a list of at least 2^17 lines, above the arguments one call takes at Node's default stack. */
type WidePosition = "statement list" | "IF branch body" | "CASE arm body" | "DECLARE list"

/** Every position a block holds a wide list at. */
export const widePositions: Arr.NonEmptyReadonlyArray<WidePosition> = [
	"statement list",
	"IF branch body",
	"CASE arm body",
	"DECLARE list"
]

/** A block as drawn: narrow, or with one list `width` long at one position, every element `statement`. */
type Width =
	| { readonly kind: "narrow" }
	| {
			readonly kind: "wide"
			readonly at: WidePosition
			readonly width: number
			readonly statement: PlStatement
	  }

/** A block as drawn: the block, its width, and where its statements are split. */
interface BlockSketch {
	readonly block: PlBlock
	readonly width: Width
	/** Where the composition property splits the block's statements, reduced modulo their count. */
	readonly split: number
}

/** The least length of a wide list: 2^17, above the arguments one call takes at Node's default stack. */
const wideWidth = 2 ** 17

/** A list wider than one call's argument limit at the position `at` draws, every element one drawn statement. */
export const wideAt =
	(at: Gen<WidePosition>): Gen<Width> =>
	(t) => ({
		kind: "wide",
		at: t.draw(at),
		width: t.draw(int(wideWidth, wideWidth + 64)),
		statement: t.draw(oneLineStatement)
	})

/** A block sketch of a drawn block, the width `width` draws, and a drawn split. */
export const sketchOf =
	(width: Gen<Width>): Gen<BlockSketch> =>
	(s) => ({
		block: s.draw(plBlockGen),
		width: s.draw(width),
		split: s.draw(int(0, 1_000))
	})

/**
 * Narrow blocks most of the time, and one case in thirteen a list wider than one call's argument limit, at a drawn
 * position: the required situation the suite names, never an incidental size.
 */
export const blockSketch: Gen<BlockSketch> = sketchOf(
	weighted<Width>([
		[12, constant<Width>({ kind: "narrow" })],
		[1, wideAt(element(widePositions))]
	])
)

/** `width` copies of `item`. */
const copies = <A>(item: A, width: number): Arr.NonEmptyReadonlyArray<A> => [
	item,
	...Array.from({ length: width - 1 }, () => item)
]

/** The block a sketch is: the drawn block, or that block with one list `width` long at its wide position. */
export const resolveBlock = (sketch: BlockSketch): PlBlock => {
	const { block, width } = sketch
	if (width.kind === "narrow") {
		return block
	}
	const wide = copies(width.statement, width.width)
	switch (width.at) {
		case "statement list":
			return { ...block, body: Arr.appendAll(block.body, wide) }
		case "IF branch body":
			return {
				...block,
				body: [
					{ kind: "if", branches: [{ condition: lit.bool(true), body: wide }], else: [] },
					...block.body
				]
			}
		case "CASE arm body":
			return {
				...block,
				body: [
					{
						kind: "case",
						operand: plVar("n"),
						whens: [{ values: [lit.int(0, types.integer)], body: wide }]
					},
					...block.body
				]
			}
		case "DECLARE list":
			return {
				...block,
				declare: [
					...block.declare,
					...Array.from({ length: width.width }, (_, i) => ({ name: `w${i}`, type: types.integer }))
				]
			}
	}
}

/** A trigger function of a block: the function body a block is printed in beside a DO block. */
export const triggerFunction = (block: PlBlock): PlFunction => ({
	kind: "createFunction",
	advice: noAdvice,
	language: "plpgsql",
	name: objectName("audit", "law"),
	params: [],
	returns: "trigger",
	volatility: "VOLATILE",
	parallel: "UNSAFE",
	security: "DEFINER",
	body: block
})

/** The place every DO block's text is written under. */
const doLoc = SourceLoc("DO block", [])

/** A block's DO block text. */
export const doText = (block: PlBlock): string => sqlText(doLoc, (out) => writeDoBlock(out, block))

/**
 * A DO block's statement lines, physical lines included: everything between its BEGIN line and its END line, the
 * block declaring the variables they read.
 */
export const statementLines = (
	body: Arr.NonEmptyReadonlyArray<PlStatement>
): ReadonlyArray<string> => {
	const lines = Str.split(doText({ declare: readVariables, body }), "\n")
	return lines.slice(lines.indexOf("BEGIN") + 1, -2)
}

/** What a block written through the line sink reached: narrow or wide at a position, and a split. */
export type WriteFeature = `wide ${WidePosition}` | "narrow" | "split"

/** The tag a body took: the plain one, the first named one, or a numbered one. */
export type DollarTag = "$$" | "$gz$" | "$gzN$"

/** The tag feature a body's dollar tag is. */
export const tagFeature = (tag: string): DollarTag =>
	tag === "$$" ? "$$" : tag === "$gz$" ? "$gz$" : "$gzN$"

/** What a commented alternative holds: a generated statement, a function's dollar-quoted body, a DO block, and the
 * line breaks of its literals. */
export type CommentFeature = "statement" | "function" | "DO block" | "carriage return" | "line feed"

/** What a commented alternative is written from: a statement, or a PL/pgSQL block written as a DO statement. */
type Commentable =
	| { readonly kind: "statement"; readonly statement: SqlStatement }
	| { readonly kind: "DO block"; readonly block: PlBlock }

/**
 * A commented alternative: a generated statement, a COMMENT whose text is built of the fragments, a trigger function or
 * a DO block. A block spells a constant holding a line feed as an escape string (sql/print.ts proceduralBlock), so the
 * COMMENT's text is where a commented alternative's literal holds a raw line feed.
 */
export const commentable: Gen<Commentable> = weighted<Commentable>([
	[2, (s) => ({ kind: "statement", statement: s.draw(statementGen(sqlCatalog)) })],
	[
		1,
		(s) => ({
			kind: "statement",
			statement: {
				kind: "comment",
				on: { kind: "SCHEMA", name: "audit" },
				text: s.draw(fragmentText)
			}
		})
	],
	[1, (s) => ({ kind: "statement", statement: triggerFunction(s.draw(plBlockGen)) })],
	[1, (s) => ({ kind: "DO block", block: s.draw(plBlockGen) })]
])

/** The place every commented alternative is written under. */
export const commentLoc = SourceLoc("commented alternative", [])

/** The class of double a float literal holds: the specials no persisted number held, and the rest. */
export type FloatFeature = "NaN" | "infinity" | "negative zero" | "finite"

/**
 * One grapheme of a name, never NUL: printable ASCII most often, then a scalar of the rest of the Basic Multilingual
 * Plane, an astral scalar, or a grapheme of several code points.
 */
const grapheme: Gen<string> = weighted([
	[4, characterOf(['"', "'", "$", " ", "-", "/", "*", "a", "Z", "_", "0", "\\", ";"] as const)],
	[2, codePoint(0x20, 0x7e)],
	[2, oneOf([codePoint(0xa0, 0xd7ff), codePoint(0xe000, 0xfffd)])],
	[1, codePoint(0x1_0000, 0x10_ffff)],
	[
		1,
		element([
			"e\u0301",
			"\u{1f44d}\u{1f3fd}",
			"\u{1f1eb}\u{1f1f7}",
			"\u{1f469}\u200d\u{1f467}"
		] as const)
	]
])

/** A name: up to twelve graphemes, or a spelling SQL reads as something else unquoted. */
export const nameGen: Gen<string> = oneOf([
	string(grapheme, { min: 1, max: 12 }),
	element([
		"select",
		"NULL",
		'a"b',
		'""',
		"Mixed Case",
		"is null",
		"--",
		"/*",
		"$$",
		"\u00fcml"
	] as const)
])

/** A constant a query's clause may hold, one of each spelling the printer gives a literal. */
export type ClauseConstant =
	| "boolean"
	| "zero"
	| "integer"
	| "negative integer"
	| "bigint"
	| "numeric"
	| "double"
	| "text"
	| "bits"

const clauseConstants: Arr.NonEmptyReadonlyArray<ClauseConstant> = [
	"boolean",
	"zero",
	"integer",
	"negative integer",
	"bigint",
	"numeric",
	"double",
	"text",
	"bits"
]

/** What a query's ORDER BY orders: a plain core, one under DISTINCT, under DISTINCT ON, or a set operation. */
export type OrderedBody =
	| "core"
	| "distinct"
	| "distinct on"
	| "distinct on naming it"
	| "set operation"

const orderedBodies: Arr.NonEmptyReadonlyArray<OrderedBody> = [
	"core",
	"distinct",
	"distinct on",
	"distinct on naming it",
	"set operation"
]

/**
 * A query whose ORDER BY, GROUP BY or DISTINCT ON holds a constant: alone, before a column or after one, the constant
 * negated where it is a number, and an ORDER BY over each body it may order.
 */
export type ClauseCase = {
	readonly constant: ClauseConstant
	readonly negated: boolean
	readonly place: "alone" | "first" | "last"
} & (
	| { readonly clause: "ORDER BY"; readonly body: OrderedBody }
	| { readonly clause: "GROUP BY" | "DISTINCT ON" }
)

export type ClauseFeature = `ORDER BY over ${OrderedBody}` | "GROUP BY" | "DISTINCT ON" | "negated"

const numbers: ReadonlySet<ClauseConstant> = new Set([
	"zero",
	"integer",
	"negative integer",
	"bigint",
	"numeric",
	"double"
])

export const clauseCaseGen: Gen<ClauseCase> = (s) => {
	const constant = s.draw(element(clauseConstants))
	const negated = numbers.has(constant) && s.draw(boolean)
	const place = s.draw(element(["alone", "first", "last"] as const))
	const clause = s.draw(element(["ORDER BY", "GROUP BY", "DISTINCT ON"] as const))
	return clause === "ORDER BY"
		? { constant, negated, place, clause, body: s.draw(element(orderedBodies)) }
		: { constant, negated, place, clause }
}

const literalOf = (constant: ClauseConstant): Expr => {
	switch (constant) {
		case "boolean":
			return lit.bool(true)
		case "zero":
			return lit.int(0, types.integer)
		case "integer":
			return lit.int(7, types.integer)
		case "negative integer":
			return lit.int(-3, types.integer)
		case "bigint":
			return lit.int(7, types.bigint)
		case "numeric":
			return { kind: "literal", value: { kind: "decimal", value: "1.5" }, type: types.numeric }
		case "double":
			return lit.float(2.5, types.double)
		case "text":
			return lit.text("x", types.text)
		case "bits":
			return lit.bits("A", types.varbit)
	}
}

const from = [table("audit", "order", "r1")] as const
const column = col("r1", "id")
/** The column as a set operation's ORDER BY names it: its output, unqualified, as no FROM of the operation reaches it. */
const output = tableCol("id")
const other = col("r1", "select")

/** A case's query, and how many items each of its clauses must print. */
export const clauseQuery = (
	c: ClauseCase
): {
	readonly select: Select
	readonly printed: Readonly<Record<"ORDER BY" | "GROUP BY" | "DISTINCT ON", number>>
} => {
	const literal = literalOf(c.constant)
	const constant: Expr = c.negated ? { kind: "negate", expr: literal } : literal
	const itemsOver = (named: Expr): Arr.NonEmptyReadonlyArray<Expr> =>
		c.place === "alone" ? [constant] : c.place === "first" ? [constant, named] : [named, constant]
	const items = itemsOver(column)
	const targets: Arr.NonEmptyReadonlyArray<Target> = [target(column)]
	switch (c.clause) {
		case "GROUP BY":
			return {
				select: select(grouped(core(targets, from, undefined), items)),
				printed: { "ORDER BY": 0, "GROUP BY": items.length, "DISTINCT ON": 0 }
			}
		case "DISTINCT ON":
			return {
				select: select(distinctOnCore(items, targets, from, undefined)),
				printed: { "ORDER BY": 0, "GROUP BY": 0, "DISTINCT ON": items.length }
			}
		case "ORDER BY": {
			const ordered = Arr.map(items, asc)
			const columns = items.length - 1
			switch (c.body) {
				case "core":
					return {
						select: {
							...select(provedCore("certified", targets, from, undefined)),
							orderBy: ordered
						},
						printed: { "ORDER BY": columns, "GROUP BY": 0, "DISTINCT ON": 0 }
					}
				case "distinct":
					return {
						select: { ...select(distinctCore(targets, from, undefined)), orderBy: ordered },
						printed: { "ORDER BY": columns, "GROUP BY": 0, "DISTINCT ON": 0 }
					}
				case "distinct on":
					return {
						select: {
							...select(distinctOnCore([other], targets, from, undefined)),
							orderBy: [asc(other), ...ordered]
						},
						printed: { "ORDER BY": 1 + columns, "GROUP BY": 0, "DISTINCT ON": 1 }
					}
				case "distinct on naming it":
					return {
						select: {
							...select(distinctOnCore(items, targets, from, undefined)),
							orderBy: ordered
						},
						printed: { "ORDER BY": items.length, "GROUP BY": 0, "DISTINCT ON": items.length }
					}
				case "set operation":
					return {
						select: {
							...select(
								setOperation("UNION", [
									provedCore("certified", targets, from, undefined),
									provedCore("certified", targets, from, undefined)
								])
							),
							orderBy: Arr.map(itemsOver(output), asc)
						},
						printed: { "ORDER BY": columns, "GROUP BY": 0, "DISTINCT ON": 0 }
					}
			}
		}
	}
}

/** The case's situation: its clause, and an ORDER BY's body. */
export const clauseFeature = (c: ClauseCase): ClauseFeature =>
	c.clause === "ORDER BY" ? `ORDER BY over ${c.body}` : c.clause

export const clauseFeatures: ReadonlyArray<ClauseFeature> = [
	...Arr.map(orderedBodies, (body): ClauseFeature => `ORDER BY over ${body}`),
	"GROUP BY",
	"DISTINCT ON",
	"negated"
]

const isPunctToken = (t: Token, text: string): boolean => t.kind === "punct" && t.text === text

/** Tokens split at each "," outside every parenthesis they open. */
const splitItems = (tokens: ReadonlyArray<Token>): ReadonlyArray<ReadonlyArray<Token>> => {
	const items: Array<ReadonlyArray<Token>> = []
	let item: Array<Token> = []
	let depth = 0
	for (const t of tokens) {
		depth += isPunctToken(t, "(") ? 1 : isPunctToken(t, ")") ? -1 : 0
		if (depth === 0 && isPunctToken(t, ",")) {
			items.push(item)
			item = []
		} else {
			item.push(t)
		}
	}
	return tokens.length === 0 ? [] : [...items, item]
}

/** The tokens inside the parenthesis the first token opens. */
const parenthesized = (tokens: ReadonlyArray<Token>): ReadonlyArray<Token> => {
	let depth = 0
	for (const [i, t] of tokens.entries()) {
		depth += isPunctToken(t, "(") ? 1 : isPunctToken(t, ")") ? -1 : 0
		if (depth === 0) {
			return tokens.slice(1, i)
		}
	}
	return tokens
}

/**
 * The items a printed query's clause holds, each its tokens: an ORDER BY's and a GROUP BY's on the line the clause opens,
 * a DISTINCT ON's in the parentheses after it.
 */
export const printedItems = (
	text: string,
	clause: "ORDER BY" | "GROUP BY" | "DISTINCT ON"
): ReadonlyArray<ReadonlyArray<Token>> => {
	const opener = clause === "DISTINCT ON" ? "SELECT DISTINCT ON " : `${clause} `
	return Option.match(Arr.findFirst(Str.split(text, "\n"), Str.startsWith(opener)), {
		onNone: () => [],
		onSome: (line) => {
			const tokens = lex(Str.slice(opener.length)(line)).tokens
			return splitItems(clause === "DISTINCT ON" ? parenthesized(tokens) : tokens)
		}
	})
}
