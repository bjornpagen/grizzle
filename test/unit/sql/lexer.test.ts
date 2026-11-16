/**
 * The PostgreSQL lexer the text audit and the migration file's statement splitter run on (sql/lexer.ts): it is the
 * audit's eyes, so a token it misreads is a construct the audit cannot see. The oracle is PostgreSQL's own scanner,
 * scan.l transcribed rule by rule apart from the lexer (test/unit/sql/scan.ts): the lexer reads every text as the
 * scanner does, each lexeme's kind, content and offset, a refused run's extent among them, and the quote or comment it
 * never closes, and where; each semicolon that ends a statement where psql's scanner ends one (psqlscan.l, transcribed
 * beside scan.l), outside every parenthesis and every BEGIN block of a routine's body, is its terminator; and
 * PostgreSQL accepts the tokens before the first refusal (lex), every semicolon punctuation to it.
 *
 * - Every text of up to three characters over the characters the scanner's rules branch on, and every run of up to
 *   three tokens and separators written edge to edge, lex as the scanner reads them: the boundaries between tokens.
 * - Generated token sequences of every kind, written apart by whitespace and comments (nested block comments
 *   included), a string constant continued across newlines among them, its later segments read as its first, lex as
 *   the scanner reads them and back to the tokens drawn, each at the offset it was written at; an
 *   operator's run lexes as the scanner cuts it by its trailing + and - rule. A sequence whose last quoted token loses
 *   its closing quote is reported unterminated at that token's offset.
 * - Every statement the kernel's generator draws (sqlgen.ts statementGen), printed, lexes as the scanner reads it, with
 *   no error.
 * - Generated statements, CREATE [OR REPLACE] FUNCTION or PROCEDURE among them with BEGIN blocks, CASE expressions
 *   and parentheses nested in their bodies, semicolons inside each, and stray tokens of each kind between, end where
 *   psql's scanner ends them.
 *
 * Features: tokens, refused runs and what follows them, unclosed constructs, terminators and semicolons inside
 * parentheses; every token and separator kind; each statement kind ended.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, String as Str } from "effect"
import { lex } from "#compiler/sql/lexer.ts"
import { printStatement } from "#compiler/sql/print.ts"
import { assert } from "#test/support/assert.ts"
import { statementGen } from "#test/support/kernel/sqlgen.ts"
import { sqlCatalog } from "#test/unit/sql/audit/catalog.ts"
import {
	asScanned,
	boundaryAtoms,
	boundaryCharacters,
	type BoundaryFeature,
	boundaryFeatures,
	joined,
	type PrintedFeature,
	render,
	type RenderedKind,
	type SeparatorKind,
	sequenceGen,
	shape,
	type StatementEndFeature,
	statementFeatures,
	statementsGen,
	tokenGen,
	tokensOf
} from "#test/unit/sql/lexer.fixtures.ts"

/** Lex reads every text of up to three boundary characters as PostgreSQL's scanner does. */
export const lexReadsEveryTextOfUpToThreeBoundaryCharactersAsPostgreSQLsScannerDoes =
	property.exhaust(finite(joined(boundaryCharacters, 3)), {
		needs: {},
		situations: [
			"a token",
			"two tokens",
			"a refused run",
			"a lexeme after a refused run",
			"an unclosed construct",
			"a terminator",
			"a semicolon inside parentheses"
		] satisfies ReadonlyArray<Reached<BoundaryFeature>>,
		check: (_, c: Case<BoundaryFeature>) => (text) =>
			Effect.sync(() => {
				asScanned(text)
				c.noteAll(boundaryFeatures(text))
			}),
		oracle: {
			kind: "second-implementation",
			name: "scan.l's and psqlscan.l's rules, transcribed apart"
		},
		box: "every text of up to three characters over the 31 that scan.l's and psqlscan.l's rules branch on",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/sql/lexer.ts",
				original: "\tunclosed: { opener, offset }",
				replacement: "\tunclosed: { opener, offset: offset + 1 }",
				why: "An unclosed construct is reported one past its opening; the boundary characters, the token runs, the unterminated quoted tokens and the statements fail."
			}
		]
	})

/** Lex reads every run of up to three tokens and separators edge to edge as PostgreSQL's scanner does. */
export const lexReadsEveryRunOfUpToThreeTokensAndSeparatorsEdgeToEdgeAsPostgreSQLsScannerDoes =
	property.exhaust(finite(joined(boundaryAtoms, 3)), {
		needs: {},
		situations: [
			"a token",
			"two tokens",
			"a refused run",
			"a lexeme after a refused run",
			"an unclosed construct",
			"a continued string"
		] satisfies ReadonlyArray<Reached<BoundaryFeature>>,
		check: (_, c: Case<BoundaryFeature>) => (text) =>
			Effect.sync(() => {
				asScanned(text)
				c.noteAll(boundaryFeatures(text))
			}),
		oracle: {
			kind: "second-implementation",
			name: "scan.l's and psqlscan.l's rules, transcribed apart"
		},
		box: "every run of up to three of 29 tokens and separators, written edge to edge",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/sql/lexer.ts",
				original:
					"\t\tif (at(text, j) === slash && at(text, j + 1) === star) {\n\t\t\tdepth += 1\n\t\t\tj += 2\n\t\t} else if (at(text, j) === star && at(text, j + 1) === slash) {",
				replacement: "\t\tif (at(text, j) === star && at(text, j + 1) === slash) {",
				why: "Block comments no longer nest; the token sequences, the token runs and the unterminated quoted tokens fail."
			},
			{
				file: "packages/engine/src/sql/lexer.ts",
				original: "\tunclosed: { opener, offset }",
				replacement: "\tunclosed: { opener, offset: offset + 1 }",
				why: "An unclosed construct is reported one past its opening; the boundary characters, the token runs, the unterminated quoted tokens and the statements fail."
			}
		]
	})

/**
 * Lex reads every generated token sequence as the scanner does, each token back at the offset it was rendered at.
 *
 * Budget: 400 runs and 400 steered cases, what its suite stated before it became a property
 * (test/unit/sql/lexer.test.ts:977 at 8cad5bce, its runs and its coverage's cases).
 */
export const lexReadsEveryGeneratedTokenSequenceAsTheScannerDoesEachTokenBackAtTheOffsetItWasRenderedAt =
	property.explore(sequenceGen, {
		needs: {},
		budget: { runs: 400, steered: 400 },
		situations: [
			"word",
			"quotedIdent",
			"string",
			"prefixed string",
			"escape string",
			"continued string",
			"continued escape string",
			"continued escape string ending in an escaped quote",
			"dollar",
			"param",
			"number",
			"non-decimal number",
			"operator",
			"punct",
			"whitespace",
			"a line comment ended by a line feed",
			"a line comment ended by a lone carriage return",
			"a block comment",
			"a nested block comment"
		] satisfies ReadonlyArray<Reached<RenderedKind | SeparatorKind>>,
		check: (_, c: Case<RenderedKind | SeparatorKind>) => (s) =>
			Effect.sync(() => {
				const { text, starts, separators } = render(s)
				c.noteAll(separators)
				asScanned(text)
				const lexed = lex(text)
				assert.equal(lexed.error, undefined, text)
				const tokens = tokensOf(s)
				assert.deepEqual(
					Arr.map(lexed.tokens, shape),
					Arr.flatMap(tokens, (token) => token.expected),
					text
				)
				/** Each rendered token begins where its first lexed token starts. */
				let at = 0
				for (const [i, token] of tokens.entries()) {
					assert.equal(lexed.tokens[at]?.start, starts[i], `${token.kind} in ${text}`)
					at += token.expected.length
					c.note(token.kind)
				}
			}),
		oracle: {
			kind: "second-implementation",
			name: "scan.l's and psqlscan.l's rules, transcribed apart, and the tokens the sequence was rendered from"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/sql/lexer.ts",
				original:
					"\t\tif (at(text, j) === slash && at(text, j + 1) === star) {\n\t\t\tdepth += 1\n\t\t\tj += 2\n\t\t} else if (at(text, j) === star && at(text, j + 1) === slash) {",
				replacement: "\t\tif (at(text, j) === star && at(text, j + 1) === slash) {",
				why: "Block comments no longer nest; the token sequences, the token runs and the unterminated quoted tokens fail."
			}
		]
	})

/**
 * Lex reports a quoted token that lost its closing quote as unterminated, at its own offset.
 *
 * Budget: 300 runs and 300 steered cases, what its suite stated before it became a property
 * (test/unit/sql/lexer.test.ts:1046 at 8cad5bce, its runs and its coverage's cases).
 */
export const lexReportsAQuotedTokenThatLostItsClosingQuoteAsUnterminatedAtItsOwnOffset =
	property.explore((source) => [source.draw(sequenceGen), source.draw(tokenGen)] as const, {
		needs: {},
		budget: { runs: 300, steered: 300 },
		situations: [
			"quotedIdent",
			"string",
			"continued escape string ending in an escaped quote",
			"dollar"
		] satisfies ReadonlyArray<Reached<RenderedKind>>,
		check:
			(_, c: Case<RenderedKind>) =>
			([s, last]) =>
				Effect.sync(() => {
					const closing = last.closing
					if (closing === undefined) {
						return
					}
					const { text } = render(s)
					const truncated = `${text} ${Str.slice(0, last.text.length - closing.length)(last.text)}`
					asScanned(truncated)
					assert.equal(lex(truncated).error?.offset, text.length + 1, truncated)
					c.note(last.kind)
				}),
		oracle: {
			kind: "second-implementation",
			name: "scan.l's and psqlscan.l's rules, transcribed apart, and the offset the truncated token was rendered at"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/sql/lexer.ts",
				original:
					"\t\tif (at(text, j) === slash && at(text, j + 1) === star) {\n\t\t\tdepth += 1\n\t\t\tj += 2\n\t\t} else if (at(text, j) === star && at(text, j + 1) === slash) {",
				replacement: "\t\tif (at(text, j) === star && at(text, j + 1) === slash) {",
				why: "Block comments no longer nest; the token sequences, the token runs and the unterminated quoted tokens fail."
			},
			{
				file: "packages/engine/src/sql/lexer.ts",
				original: "\tunclosed: { opener, offset }",
				replacement: "\tunclosed: { opener, offset: offset + 1 }",
				why: "An unclosed construct is reported one past its opening; the boundary characters, the token runs, the unterminated quoted tokens and the statements fail."
			}
		]
	})

/**
 * Lex reads every statement the kernel's generator draws, printed, as the scanner does.
 *
 * Budget: 100 runs and 100 steered cases, what its suite stated before it became a property
 * (test/unit/sql/lexer.test.ts:1091 at 8cad5bce, its runs and its coverage's cases).
 */
export const lexReadsEveryStatementTheKernelsGeneratorDrawsPrintedAsTheScannerDoes =
	property.explore(statementGen(sqlCatalog), {
		needs: {},
		budget: { runs: 100, steered: 100 },
		situations: [
			"word",
			"quotedIdent",
			"string",
			"number",
			"param",
			"operator",
			"punct"
		] satisfies ReadonlyArray<Reached<PrintedFeature>>,
		check: (_, c: Case<PrintedFeature>) => (statement) =>
			Effect.sync(() => {
				const text = printStatement(statement)
				asScanned(text)
				const lexed = lex(text)
				assert.equal(lexed.error, undefined, text)
				c.noteAll(Arr.map(lexed.tokens, (t) => t.kind))
			}),
		oracle: {
			kind: "second-implementation",
			name: "scan.l's and psqlscan.l's rules, transcribed apart"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/sql/lexer.ts",
				original: '\tc === colon && next === colon\n\t\t? "::"\n\t\t: c === dot && next === dot',
				replacement: "\tc === dot && next === dot",
				why: "`::` is read as two colons; the printed statements fail."
			}
		]
	})

/**
 * Lex ends every generated statement where psql's scanner ends it.
 *
 * Budget: 400 runs and 400 steered cases, what its suite stated before it became a property
 * (test/unit/sql/lexer.test.ts:1127 at 8cad5bce, its runs and its coverage's cases).
 */
export const lexEndsEveryGeneratedStatementWherePsqlsScannerEndsIt = property.explore(
	statementsGen,
	{
		needs: {},
		budget: { runs: 400, steered: 400 },
		situations: statementFeatures satisfies ReadonlyArray<Reached<StatementEndFeature>>,
		check: (_, c: Case<StatementEndFeature>) => (drawnStatements) =>
			Effect.sync(() => {
				c.noteAll(drawnStatements.reaches)
				asScanned(drawnStatements.text)
			}),
		oracle: {
			kind: "second-implementation",
			name: "scan.l's and psqlscan.l's rules and state, transcribed apart"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/sql/lexer.ts",
				original:
					'\tstatement.parens === 0 && (statement.opening.kind !== "routine" || statement.opening.blocks === 0)',
				replacement: '\tstatement.opening.kind !== "routine" || statement.opening.blocks === 0',
				why: "A semicolon inside parentheses ends its statement; the statements fail."
			}
		]
	}
)
