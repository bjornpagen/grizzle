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
 *
 * Oracle: the lexer reading each printed text back (a round trip): a block's lines compose, a dollar string holds the
 * block's lines whole, a commented alternative lexes as nothing, a quoted name as that name; and a float literal against
 * the snapshot's reader and JavaScript's reading of a number's text, standing in for float8in.
 *
 * Features: each width a block is wide at, and a split; each dollar tag; each commentable and each line break; each
 * class of double.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { aimed, constant, element, finite, weighted } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { double } from "@bjornpagen/testing/values"
import { Array as Arr, Effect, Formatter, String as Str } from "effect"
import { decode, encode, everyProperty, noRevivers } from "#compiler/core/canonical.ts"
import { BlockLines } from "#compiler/core/lines.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import { writeJsonText } from "#compiler/deploy/snapshot/build.ts"
import type { PlStatement } from "#compiler/sql/ast.ts"
import { lit, provedSelect, target, types } from "#compiler/sql/build.ts"
import { lex } from "#compiler/sql/lexer.ts"
import {
	commented,
	printStatement,
	sqlText,
	writeDoBlock,
	writeStatement
} from "#compiler/sql/print.ts"
import { succeeded } from "#test/support/assert.ts"
import { auditTextViolations, guardedTermsOf } from "#test/support/oracle/verify/sql.ts"
import {
	blockSketch,
	type ClauseFeature,
	clauseCaseGen,
	clauseFeature,
	clauseFeatures,
	clauseQuery,
	commentable,
	type CommentFeature,
	commentLoc,
	type DollarTag,
	doText,
	type FloatFeature,
	nameGen,
	plBlockGen,
	printedItems,
	resolveBlock,
	sketchOf,
	statementLines,
	tagFeature,
	triggerFunction,
	wideAt,
	widePositions,
	type WriteFeature
} from "#test/unit/sql/print.fixtures.ts"

/**
 * PL/pgSQL through the line sink writes a block of every width, wider than one call's argument limit, and its
 * statements' lines compose.
 *
 * Budget: 96 runs and 96 steered cases, what its suite stated before it became a property
 * (test/unit/sql/print.test.ts:396 at 8cad5bce, its runs and its coverage's cases).
 */
export const pLPgSQLThroughTheLineSinkWritesABlockOfEveryWidthWiderThanOneCallsArgumentLimitAndItsStatementsLinesCompose =
	property.explore(
		aimed(
			blockSketch,
			Arr.map(widePositions, (at) => [`wide ${at}`, sketchOf(wideAt(constant(at)))] as const)
		),
		{
			needs: {},
			budget: { runs: 96, steered: 96 },
			situations: [
				"narrow",
				"wide statement list",
				"wide IF branch body",
				"wide CASE arm body",
				"wide DECLARE list",
				"split"
			] satisfies ReadonlyArray<Reached<WriteFeature>>,
			check: (_, c: Case<WriteFeature>) => (sketch) =>
				Effect.sync(() => {
					const block = resolveBlock(sketch)
					printStatement(triggerFunction(block))
					doText(block)
					const body = block.body
					if (body.length >= 2) {
						const k = 1 + (sketch.split % (body.length - 1))
						const [first, ...rest] = body
						const prefix: Arr.NonEmptyReadonlyArray<PlStatement> = [first, ...rest.slice(0, k - 1)]
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
				}),
			oracle: {
				kind: "universal",
				name: "a block's statement lines are the concatenation of any split's halves"
			},
			kept: [],
			kills: [
				{
					file: "packages/engine/src/sql/print.ts",
					original:
						"const plStatements = (out: Lines, statements: ReadonlyArray<PlStatement>): void => {\n\tfor (const statement of statements) {",
					replacement:
						"const plStatements = (out: Lines, statements: ReadonlyArray<PlStatement>): void => {\n\tfor (const statement of Array.of(...statements)) {",
					why: "A block's statement list is read through one call's arguments; the width search fails at a list wider than the argument limit."
				}
			]
		}
	)

/**
 * Dollar quoting quotes a block's lines with a tag none of them holds, so a DO block and a function body each lex back
 * as one dollar string of the same lines.
 *
 * Budget: 300 runs and 300 steered cases, what its suite stated before it became a property
 * (test/unit/sql/print.test.ts:463 at 8cad5bce, its runs and its coverage's cases).
 */
export const dollarQuotingQuotesABlocksLinesWithATagNoneOfThemHoldsSoADOBlockAndAFunctionBodyEachLexBackAsOneDollarStringOfTheSameLines =
	property.explore(plBlockGen, {
		needs: {},
		budget: { runs: 300, steered: 300 },
		situations: ["$$", "$gz$", "$gzN$"] satisfies ReadonlyArray<Reached<DollarTag>>,
		check: (_, c: Case<DollarTag>) => (block) =>
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
			}),
		oracle: {
			kind: "universal",
			name: "the lexer reads a DO block and a function body back as one dollar string of the block's lines"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/sql/print.ts",
				original: "\tconst tag = dollarQuoteTag(body)",
				replacement: '\tconst tag = "$$"',
				why: "Every body is quoted under $$; the dollar quoting search fails."
			}
		]
	})

/**
 * A commented alternative holds no live SQL: every physical line, a literal's line breaks of both kinds included,
 * begins with -- and lexes as nothing.
 *
 * Budget: 300 runs and 300 steered cases, what its suite stated before it became a property
 * (test/unit/sql/print.test.ts:525 at 8cad5bce, its runs and its coverage's cases).
 */
export const aCommentedAlternativeHoldsNoLiveSQLEveryPhysicalLineALiteralsLineBreaksOfBothKindsIncludedBeginsWithAndLexesAsNothing =
	property.explore(commentable, {
		needs: {},
		budget: { runs: 300, steered: 300 },
		situations: [
			"statement",
			"function",
			"DO block",
			"carriage return",
			"line feed"
		] satisfies ReadonlyArray<Reached<CommentFeature>>,
		check: (_, c: Case<CommentFeature>) => (alternative) =>
			Effect.sync(() => {
				const text = sqlText(commentLoc, (out) =>
					alternative.kind === "statement"
						? writeStatement(commented(out), alternative.statement)
						: writeDoBlock(commented(out), alternative.block)
				)
				const physical = Arr.flatMap(Str.split(text, "\n"), (line) => Str.split(line, "\r"))
				for (const line of physical) {
					assert.ok(
						Str.startsWith("--")(line),
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
			}),
		oracle: {
			kind: "specification",
			name: "every physical line begins with --, and the lexer reads the text as nothing"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/core/lines.ts",
				original: `\t\tfor (const physical of \`\${this.#indent}\${text}\`.replaceAll("\\r", "\\r-- ").split("\\n")) {`,
				replacement: `\t\tfor (const physical of \`\${this.#indent}\${text}\`.split("\\n")) {`,
				why: "A commented line's carriage returns are left live (core/lines.ts); the commented alternative's search fails."
			}
		]
	})

/**
 * Identifiers, types and literals quotes every identifier so that it lexes back as that one name.
 *
 * Budget: 400 runs and 0 steered cases, what its suite stated before it became a property
 * (test/unit/sql/print.test.ts:631 at 8cad5bce, its runs and its coverage's cases).
 */
export const identifiersTypesAndLiteralsQuotesEveryIdentifierSoThatItLexesBackAsThatOneName =
	property.explore(nameGen, {
		needs: {},
		budget: { runs: 400, steered: 0 },
		situations: [],
		check: () => (name) =>
			Effect.sync(() => {
				const lexed = lex(quoteIdent(name))
				assert.deepEqual(
					Arr.map(lexed.tokens, (token) =>
						token.kind === "quotedIdent" ? token.text : token.kind
					),
					[name]
				)
			}),
		oracle: {
			kind: "universal",
			name: "the lexer reads a quoted name back as that one name"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/core/text.ts",
				original: `export const quoteIdent = (name: string): string => \`"\${name.replaceAll('"', '""')}"\``,
				replacement: `export const quoteIdent = (name: string): string => \`"\${name}"\``,
				why: "A quoted name's quotes are left undoubled; the quoted identifier search fails."
			}
		]
	})

/**
 * Identifiers, types and literals a float literal of every double survives the snapshot and spells the double for the
 * float input function.
 *
 * Budget: 300 runs and 300 steered cases, what its suite stated before it became a property
 * (test/unit/sql/print.test.ts:664 at 8cad5bce, its runs and its coverage's cases).
 */
export const identifiersTypesAndLiteralsAFloatLiteralOfEveryDoubleSurvivesTheSnapshotAndSpellsTheDoubleForTheFloatInputFunction =
	property.explore(
		weighted([
			[3, double(-Number.MAX_VALUE, Number.MAX_VALUE)],
			[1, element([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0] as const)]
		]),
		{
			needs: {},
			budget: { runs: 300, steered: 300 },
			situations: ["NaN", "infinity", "negative zero", "finite"] satisfies ReadonlyArray<
				Reached<FloatFeature>
			>,
			check: (_, c: Case<FloatFeature>) => (x) =>
				Effect.sync(() => {
					const s = provedSelect("oneRow", [target(lit.float(x, types.double))], [], undefined)
					const written = succeeded(writeJsonText(s), "the snapshot writer writes a float literal")
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
				}),
			oracle: {
				kind: "universal",
				name: "the snapshot reads the literal back as itself, and its text reads as the double"
			},
			kept: [],
			kills: [
				{
					file: "packages/engine/src/sql/print.ts",
					original: '\t\t\treturn { kind: "quoted", text: String(value.value) }',
					replacement: '\t\t\treturn { kind: "quoted", text: value.value.toPrecision(15) }',
					why: "A float literal is printed to fifteen digits; the float literal search fails."
				}
			]
		}
	)

/**
 * A constant in a query's ORDER BY, GROUP BY or DISTINCT ON prints as the constant, never as an output column's
 * position: PostgreSQL reads a bare constant item there as a position where it is an integer and refuses any other,
 * under any parentheses and, for a number, any unary minus (parse_clause.c findTargetlistEntrySQL92, gram.y doNegate),
 * so a GROUP BY's and a DISTINCT ON's constant prints typed, and an ORDER BY's, which orders nothing, is left out,
 * typed where a DISTINCT ON names it, since the ORDER BY must begin with DISTINCT ON's items; over a set operation and
 * under SELECT DISTINCT, where PostgreSQL refuses even a typed constant, it is left out too.
 *
 * Every case: 9 constants, each of the 6 numbers negated or not, 3 places, and 7 clauses and bodies, 315 in all.
 */
export const aConstantInAQuerysOrderByGroupByOrDistinctOnPrintsAsTheConstantTypedOrLeftOutOfAnOrderByItOrdersNothing =
	property.exhaust(finite(clauseCaseGen), {
		box: "every constant spelling, each number negated or not, alone, first or last, in a GROUP BY, a DISTINCT ON and an ORDER BY over each body it orders",
		needs: {},
		situations: clauseFeatures satisfies ReadonlyArray<Reached<ClauseFeature>>,
		check: (_, c: Case<ClauseFeature>) => (clauseCase) =>
			Effect.sync(() => {
				c.note(clauseFeature(clauseCase))
				if (clauseCase.negated) {
					c.note("negated")
				}
				const { select, printed } = clauseQuery(clauseCase)
				const text = printStatement(select)
				assert.deepEqual(auditTextViolations(text, guardedTermsOf(select)), [], text)
				for (const clause of ["ORDER BY", "GROUP BY", "DISTINCT ON"] as const) {
					assert.equal(
						printedItems(text, clause).length,
						printed[clause],
						`${clause} items of\n${text}`
					)
				}
			}),
		oracle: {
			kind: "specification",
			name: "the text audit's positional rule, PostgreSQL's reading of a bare clause item restated over tokens, and the items each clause keeps"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/sql/print.ts",
				original: "\t\t? typedLiteral(e.value, e.type)",
				replacement: "\t\t? printLiteral(e.value, e.type)",
				why: "A clause's literal prints as an expression's, a boolean and a nonnegative integer bare, which PostgreSQL reads as a position or refuses; the clause constant search fails."
			},
			{
				file: "packages/engine/src/sql/print.ts",
				original: "\t\treturn named.has(text) ? [directed(text, item.direction)] : []",
				replacement: "\t\treturn [directed(text, item.direction)]",
				why: "An ORDER BY keeps every constant, typed, which PostgreSQL refuses over a set operation and under SELECT DISTINCT; the clause constant search fails."
			},
			{
				file: "packages/engine/src/sql/print.ts",
				original: "\t\treturn named.has(text) ? [directed(text, item.direction)] : []",
				replacement: "\t\treturn []",
				why: "An ORDER BY leaves out a constant its DISTINCT ON names, so it no longer begins with DISTINCT ON's items; the clause constant search fails."
			}
		]
	})
