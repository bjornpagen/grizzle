import { describe, it } from "@effect/vitest"
import { type Case, drawn, explore } from "@grizzle/testing/explore"
import { noCoverage, required } from "@grizzle/testing/features"
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
} from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { double } from "@grizzle/testing/values"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, String as Str } from "effect"
import { decode, encode, everyProperty, noRevivers } from "#compiler/core/canonical.ts"
import { BlockLines } from "#compiler/core/lines.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { writeJsonText } from "#compiler/deploy/snapshot/build.ts"
import type {
	Expr,
	PerformQuery,
	PlBlock,
	PlDeclaration,
	PlFunction,
	PlStatement,
	RaiseOption,
	SelectCore,
	SqlStatement
} from "#compiler/sql/ast.ts"
import {
	col,
	core,
	eq,
	lit,
	objectName,
	provedSelect,
	table,
	target,
	types
} from "#compiler/sql/build.ts"
import { lex } from "#compiler/sql/lexer.ts"
import {
	commented,
	printStatement,
	quoteIdent,
	sqlText,
	writeDoBlock,
	writeStatement
} from "#compiler/sql/print.ts"
import { assert, succeeded } from "#test/support/assert.ts"
import { statementGen } from "#test/support/kernel/sqlgen.ts"
import { caseHang } from "#test/support/limits.ts"
import { sqlCatalog } from "#test/unit/sql/audit/catalog.ts"

/**
 * The SQL printer. A PL/pgSQL block is written through the line sink at every width, wider than one JavaScript call's
 * argument limit included, and its statements' lines compose; its dollar quoting is checked through the public frames,
 * each lexing back as one dollar string; a commented alternative is checked to hold no live SQL. A quoted identifier is
 * checked over generated names, each lexing back as what was quoted, and a float literal over every double, which the
 * snapshot reads back and the float input function reads as that double. The DDL it prints is executed on PostgreSQL by
 * the installation and migration suites, and audited, statement and text, over every installation and drafted migration
 * (test/unit/sql/audit.test.ts). What a printed query means is checked on PostgreSQL (test/pg/sql: generated
 * expressions, set-operation trees and aggregates evaluated against the host, every generated statement planned), and
 * the compiler's own SELECT forms run in the differential suites.
 */

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

const fragmentText: Gen<string> = (s) =>
	Arr.join(s.draw(array(element(fragments), { min: 0, max: 8 })), "")

const plVar = (name: string): Expr => ({ kind: "plVar", name })

const textLiteral: Gen<Expr> = (s) => lit.text(s.draw(fragmentText), types.text)

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

const performQuery: Gen<PerformQuery> = (s) => ({
	body: s.draw(scan),
	orderBy: [],
	limit: s.draw(boolean) ? lit.int(1, types.integer) : undefined,
	offset: undefined
})

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
						kind: "whenAbsent",
						probe: s.draw(performQuery),
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

const declarations: Gen<ReadonlyArray<PlDeclaration>> = (s) =>
	Array.from({ length: s.draw(int(0, 3)) }, (_, i) => ({ name: `d${i}`, type: types.integer }))

/** A PL/pgSQL block nested to a drawn depth. */
const plBlockGen: Gen<PlBlock> = (s) => ({
	declare: s.draw(declarations),
	body: s.draw(nonEmptyStatements(s.draw(int(0, 3))))
})

/** Where a block holds a list of at least 2^17 lines, above the arguments one call takes at Node's default stack. */
type WidePosition = "statement list" | "IF branch body" | "CASE arm body" | "DECLARE list"

const widePositions: Arr.NonEmptyReadonlyArray<WidePosition> = [
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

interface BlockSketch {
	readonly block: PlBlock
	readonly width: Width
	/** Where the composition property splits the block's statements, reduced modulo their count. */
	readonly split: number
}

const wideWidth = 2 ** 17

/**
 * Narrow blocks most of the time, and one case in thirteen a list wider than one call's argument limit, at a drawn
 * position: the required situation the suite names, never an incidental size.
 */
const blockSketch: Gen<BlockSketch> = (s) => ({
	block: s.draw(plBlockGen),
	width: s.draw(
		weighted<Width>([
			[12, constant<Width>({ kind: "narrow" })],
			[
				1,
				(t) => ({
					kind: "wide",
					at: t.draw(element(widePositions)),
					width: t.draw(int(wideWidth, wideWidth + 64)),
					statement: t.draw(oneLineStatement)
				})
			]
		])
	),
	split: s.draw(int(0, 1_000))
})

/** `width` copies of `item`. */
const copies = <A>(item: A, width: number): Arr.NonEmptyReadonlyArray<A> => [
	item,
	...Array.from({ length: width - 1 }, () => item)
]

const resolveBlock = (sketch: BlockSketch): PlBlock => {
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

const triggerFunction = (block: PlBlock): PlFunction => ({
	kind: "createFunction",
	language: "plpgsql",
	name: objectName("audit", "law"),
	params: [],
	returns: "trigger",
	volatility: "VOLATILE",
	parallel: "UNSAFE",
	security: "DEFINER",
	planCacheMode: "force_custom_plan",
	body: block
})

const doLoc = SourceLoc("DO block", [])

const doText = (block: PlBlock): string => sqlText(doLoc, (out) => writeDoBlock(out, block))

/** A DO block's statement lines, physical lines included: everything between its BEGIN line and its END line. */
const statementLines = (body: Arr.NonEmptyReadonlyArray<PlStatement>): ReadonlyArray<string> =>
	Str.split(doText({ declare: [], body }), "\n").slice(2, -2)

type WriteFeature = `wide ${WidePosition}` | "narrow" | "split"

/**
 * A wide sketch aimed, where the case steers, at the first wide position still pending, so a few wide cases reach every
 * position rather than leave one to its share of chance; any other sketch as drawn.
 */
const aimed = (sketch: BlockSketch, steering: Case<WriteFeature>["steering"]): BlockSketch => {
	const width = sketch.width
	if (width.kind === "narrow") {
		return sketch
	}
	return Option.match(
		Option.flatMap(steering, (pending) =>
			Arr.findFirst(widePositions, (at) => pending.has(`wide ${at}`))
		),
		{ onNone: () => sketch, onSome: (at) => ({ ...sketch, width: { ...width, at } }) }
	)
}

describe("PL/pgSQL through the line sink", () => {
	it.effect(
		"writes a block of every width, wider than one call's argument limit, and its statements' lines compose",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/sql/pl-width",
						draw: drawn(blockSketch),
						literal: Formatter.format,
						kept: [],
						runs: 96,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang,
						coverage: required<WriteFeature>(
							[
								"narrow",
								"wide statement list",
								"wide IF branch body",
								"wide CASE arm body",
								"wide DECLARE list",
								"split"
							],
							{ cases: 96, sense: notesOnly }
						)
					},
					(drawnSketch, c) =>
						Effect.sync(() => {
							const sketch = aimed(drawnSketch, c.steering)
							const block = resolveBlock(sketch)
							printStatement(triggerFunction(block))
							doText(block)
							const body = block.body
							if (body.length >= 2) {
								const k = 1 + (sketch.split % (body.length - 1))
								const [first, ...rest] = body
								const prefix: Arr.NonEmptyReadonlyArray<PlStatement> = [
									first,
									...rest.slice(0, k - 1)
								]
								const suffix = Arr.drop(body, k)
								if (Arr.isReadonlyArrayNonEmpty(suffix)) {
									assert.deepEqual(statementLines(body), [
										...statementLines(prefix),
										...statementLines(suffix)
									])
									c.note("split")
								}
							}
							c.note(sketch.width.kind === "narrow" ? "narrow" : `wide ${sketch.width.at}`)
						})
				)
			)
	)
})

/** The tag a body took: the plain one, the first named one, or a numbered one. */
type DollarTag = "$$" | "$gz$" | "$gzN$"

const tagFeature = (tag: string): DollarTag =>
	tag === "$$" ? "$$" : tag === "$gz$" ? "$gz$" : "$gzN$"

describe("dollar quoting", () => {
	it.effect(
		"quotes a block's lines with a tag none of them holds, so a DO block and a function body each lex back as one dollar string of the same lines",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/sql/dollar-tag",
						draw: drawn(plBlockGen),
						literal: Formatter.format,
						kept: [],
						runs: 300,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang,
						coverage: required<DollarTag>(["$$", "$gz$", "$gzN$"], { cases: 300, sense: notesOnly })
					},
					(block, c) =>
						Effect.sync(() => {
							const quoted = doText(block)
							const lexed = lex(quoted)
							assert.equal(lexed.error, undefined)
							const [keyword, dollar, ...more] = lexed.tokens
							assert.ok(keyword?.kind === "word" && keyword.upper === "DO", quoted)
							assert.ok(dollar?.kind === "dollar" && more.length === 0, quoted)
							assert.deepEqual(
								Arr.flatMap(lex(printStatement(triggerFunction(block))).tokens, (t) =>
									t.kind === "dollar" ? [[t.tag, t.body] as const] : []
								),
								[[dollar.tag, dollar.body] as const],
								"a function body is quoted as the DO block is: the tag and the lines are the block's alone"
							)
							assert.equal(doText(block), quoted)
							c.note(tagFeature(dollar.tag))
						})
				)
			)
	)
})

/** What a commented alternative holds: a generated statement, a function's dollar-quoted body, a DO block, and the
 * line breaks of its literals. */
type CommentFeature = "statement" | "function" | "DO block" | "carriage return" | "line feed"

/** What a commented alternative is written from: a statement, or a PL/pgSQL block written as a DO statement. */
type Commentable =
	| { readonly kind: "statement"; readonly statement: SqlStatement }
	| { readonly kind: "DO block"; readonly block: PlBlock }

const commentable: Gen<Commentable> = weighted<Commentable>([
	[2, (s) => ({ kind: "statement", statement: s.draw(statementGen(sqlCatalog)) })],
	[1, (s) => ({ kind: "statement", statement: triggerFunction(s.draw(plBlockGen)) })],
	[1, (s) => ({ kind: "DO block", block: s.draw(plBlockGen) })]
])

const commentLoc = SourceLoc("commented alternative", [])

describe("a commented alternative", () => {
	it.effect(
		"holds no live SQL: every physical line, a literal's line breaks of both kinds included, begins with -- and lexes as nothing",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/sql/commented",
						draw: drawn(commentable),
						literal: Formatter.format,
						kept: [],
						runs: 300,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang,
						coverage: required<CommentFeature>(
							["statement", "function", "DO block", "carriage return", "line feed"],
							{ cases: 300, sense: notesOnly }
						)
					},
					(alternative, c) =>
						Effect.sync(() => {
							const text = sqlText(commentLoc, (out) =>
								alternative.kind === "statement"
									? writeStatement(commented(out), alternative.statement)
									: writeDoBlock(commented(out), alternative.block)
							)
							const physical = Arr.flatMap(Str.split(text, "\n"), (line) => Str.split(line, "\r"))
							for (const line of physical) {
								assert.ok(
									Str.startsWith("-- ")(line),
									`${Formatter.format(line)} is live in ${Formatter.format(text)}`
								)
							}
							assert.deepEqual(lex(text), { tokens: [], error: undefined })
							c.note(
								alternative.kind === "DO block"
									? "DO block"
									: alternative.statement.kind === "createFunction"
										? "function"
										: "statement"
							)
							const written: Array<string> = []
							const raw = new BlockLines(written, "  ", "")
							if (alternative.kind === "statement") {
								writeStatement(raw, alternative.statement)
							} else {
								writeDoBlock(raw, alternative.block)
							}
							if (Arr.some(written, Str.includes("\r"))) {
								c.note("carriage return")
							}
							if (Arr.some(written, Str.includes("\n"))) {
								c.note("line feed")
							}
						})
				)
			)
	)
})

/** The class of double a float literal holds: the specials no persisted number held, and the rest. */
type FloatFeature = "NaN" | "infinity" | "negative zero" | "finite"

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
const nameGen: Gen<string> = oneOf([
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

describe("identifiers, types and literals", () => {
	it.effect("quotes every identifier so that it lexes back as that one name", (ctx) =>
		searched(
			ctx,
			explore(
				{
					suite: "unit/sql/quote-ident",
					draw: drawn(nameGen),
					literal: Formatter.format,
					coverage: noCoverage,
					kept: [],
					runs: 400,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang
				},
				(name) =>
					Effect.sync(() => {
						const lexed = lex(quoteIdent(name))
						assert.deepEqual(
							Arr.map(lexed.tokens, (token) =>
								token.kind === "quotedIdent" ? token.text : token.kind
							),
							[name]
						)
					})
			)
		)
	)

	it.effect(
		"a float literal of every double survives the snapshot and spells the double for the float input function",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/sql/float-literal",
						/**
						 * The finite doubles, every scale as likely, and the specials, which a finite draw never holds and -0 which it
						 * holds too rarely to reach in 300 cases, one case in four.
						 */
						draw: drawn(
							weighted([
								[3, double(-Number.MAX_VALUE, Number.MAX_VALUE)],
								[
									1,
									element([
										Number.NaN,
										Number.POSITIVE_INFINITY,
										Number.NEGATIVE_INFINITY,
										-0
									] as const)
								]
							])
						),
						literal: Formatter.format,
						coverage: required<FloatFeature>(["NaN", "infinity", "negative zero", "finite"], {
							cases: 300,
							sense: notesOnly
						}),
						kept: [],
						runs: 300,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(x, c) =>
						Effect.sync(() => {
							const s = provedSelect("oneRow", [target(lit.float(x, types.double))], [], undefined)
							const written = succeeded(
								writeJsonText(s),
								"the snapshot writer writes a float literal"
							)
							const read = succeeded(
								decode(written, noRevivers),
								"the snapshot reader reads its own float literal"
							)
							assert.equal(
								succeeded(encode(read, everyProperty), "the read literal's canonical text"),
								succeeded(encode(s, everyProperty), "the literal's canonical text"),
								"the snapshot reads the literal back as itself"
							)
							/** JavaScript's own reading of a number's text stands in for the float input function. */
							const text = printStatement(s)
							const [spelled, ...more] = Arr.flatMap(lex(text).tokens, (token) =>
								token.kind === "string" ? [token.text] : []
							)
							assert.ok(
								spelled !== undefined && more.length === 0,
								`${text} spells the double as one string`
							)
							assert.ok(
								Object.is(Number(spelled), x),
								`${text} spells another double than ${Formatter.format(x)}`
							)
							c.note(
								Number.isNaN(x)
									? "NaN"
									: !Number.isFinite(x)
										? "infinity"
										: Object.is(x, -0)
											? "negative zero"
											: "finite"
							)
						})
				)
			)
	)
})
