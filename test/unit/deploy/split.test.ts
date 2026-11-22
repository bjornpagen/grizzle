/**
 * Splitting a no-transaction migration file into the statements that run one by one, generated: a file is drawn as
 * its statements, each a run of PostgreSQL tokens and comments joined by whitespace, so the split it must yield is
 * known. Every semicolon that is not a statement's end sits where PostgreSQL's scanner does not end a statement: in a
 * string constant (standard, with doubled quotes and backslashes that escape nothing, or E'' with backslash escapes),
 * a quoted identifier, a dollar-quoted body whose tag may be any identifier PostgreSQL allows (non-ASCII letters
 * among them), a line comment, or a nested block comment. Identifiers carry `$`, positional parameters appear beside
 * dollar quotes, and a piece that holds only comments and whitespace is no statement. A run the scanner reads whole
 * and refuses (an empty quoted identifier, junk after a number or a parameter, a base with no digit, a stray `$`, a
 * character no rule reads) is part of its statement, and the split goes on after it. As psql splits a file, a
 * semicolon inside parentheses, nested or not, ends no statement, and neither does one in the body of a CREATE [OR
 * REPLACE] FUNCTION or PROCEDURE between BEGIN ATOMIC and its END, through the BEGIN blocks and CASE expressions nested
 * inside; a `)` no parenthesis opened closes none. Each statement keeps its leading comments and loses its terminator;
 * a file whose last statement opens a quote or a parenthesis it never closes keeps the rest of the file as that
 * statement, and a block comment left open, nested or not, adds no statement of its own. A string constant continues
 * across whitespace holding a newline, line comments among it, into the quote that follows (scan.l quotecontinue),
 * and every segment is read as the first is, so an escape string's later segments keep their backslash escapes: the
 * search draws such continuations on purpose (continuedGen), and keeps two drawn strings from joining by accident
 * (spaced).
 *
 * A dollar-quoted body is drawn and filtered where it would spell its own closing tag before its end: whether a body
 * does depends on the tag drawn with it, and the filter's discards are counted.
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option, String as Str } from "effect"
import {
	type StatementToken,
	splitStatements,
	statementDigest,
	statementTokens,
	writtenAs
} from "#compiler/deploy/render/markers.ts"
import { placeholderToken } from "#compiler/sql/print.ts"
import { succeeded } from "#test/support/assert.ts"
import {
	anyRunEnds,
	balancedRunEnds,
	draftGen,
	editOf,
	fileGen,
	fillable,
	type SplitFeature,
	slotOf,
	splitFeatures,
	type WrittenFeature
} from "#test/unit/deploy/split.fixtures.ts"

/** Splitting a no-transaction file into its statements, generated splits exactly at the semicolons that end statements. Its budget is its suite's before it was a property (test/unit/deploy/split.test.ts at 4ca3036a): 500 runs and 500 steered cases. */
export const splittingANoTransactionFileIntoItsStatementsGeneratedSplitsExactlyAtTheSemicolonsThatEndStatements =
	property.explore(fileGen, {
		needs: {},
		budget: { runs: 500, steered: 500 },
		situations: splitFeatures satisfies ReadonlyArray<Reached<SplitFeature>>,
		check:
			(_, c: Case<SplitFeature>) =>
			({ pieces, terminated, unterminated }) =>
				Effect.sync(() => {
					c.noteAll(Arr.flatMap(pieces, ([piece]) => piece.reaches))
					c.noteAll(unterminated === null ? [] : unterminated.reaches)
					const texts = Arr.map(pieces, ([piece, space], i) =>
						i < pieces.length - 1 || terminated ? `${piece.text};${space}` : piece.text
					)
					const expected = Arr.map(
						Arr.filter(pieces, ([piece]) => piece.substantive),
						([piece]) => Str.trim(piece.text)
					)
					const text =
						unterminated === null
							? Arr.join(texts, "")
							: `${Arr.join(texts, "")}${unterminated.text}`
					if (unterminated !== null) {
						/** The unclosed quote or comment takes the rest of the file into the statement it is in, which
						 * is one when the quote or that statement's text before it is. */
						const last = pieces.at(-1)
						const continues = !terminated && last?.[0].substantive === true
						const open =
							terminated || last === undefined
								? unterminated.text
								: `${last[0].text}${unterminated.text}`
						if (continues) {
							expected.pop()
						}
						if (continues || unterminated.substantive) {
							expected.push(Str.trim(open))
						}
					}
					assert.deepEqual(splitStatements(text), expected, Formatter.format(text))
				}),
		oracle: {
			kind: "second-implementation",
			name: "a file drawn as its statements, whose split is known by construction"
		},
		kept: [
			{
				token: ReplayToken(
					"test/unit/deploy/split.test.ts#splittingANoTransactionFileIntoItsStatementsGeneratedSplitsExactlyAtTheSemicolonsThatEndStatements:-:2.0.1.0.8.0.5.0.0.0.0.0.0.0"
				),
				reason: "a dollar quote tagged ß split at its semicolon",
				since: "2026-10-29"
			},
			{
				token: ReplayToken(
					"test/unit/deploy/split.test.ts#splittingANoTransactionFileIntoItsStatementsGeneratedSplitsExactlyAtTheSemicolonsThatEndStatements:-:1.0.1.0.9.0.0.0.1.0"
				),
				reason:
					"an empty quoted identifier ends no reading: its statement ends at the semicolon after it",
				since: "2026-11-07"
			},
			{
				token: ReplayToken(
					"test/unit/deploy/split.test.ts#splittingANoTransactionFileIntoItsStatementsGeneratedSplitsExactlyAtTheSemicolonsThatEndStatements:-:1.0.1.1.1.0.6.1.0.1.0.1.c.0.0.0.1.0"
				),
				reason:
					"an escape string continued across a newline reads its later segment's \\' as an escaped quote",
				since: "2026-11-08"
			},
			{
				token: ReplayToken(
					"test/unit/deploy/split.test.ts#splittingANoTransactionFileIntoItsStatementsGeneratedSplitsExactlyAtTheSemicolonsThatEndStatements:-:1.0.1.0.0.3.0.0.1.1.2"
				),
				reason:
					"an escape string continued across a newline never closes at a quote its backslash escapes",
				since: "2026-11-08"
			}
		],
		kills: [
			{
				file: "packages/engine/src/deploy/render/markers.ts",
				original: "\t\tif (ends && substantive) {",
				replacement: "\t\tif (ends) {",
				why: "An empty statement between two semicolons is kept as one."
			}
		]
	})

/** A word as a reviewer may spell it: its ASCII letters in lower case, which PostgreSQL folds as it reads an unquoted
 * word. */
const asciiLower = (text: string): string =>
	Arr.join(
		Arr.map(Array.from(text), (ch) => (ch >= "A" && ch <= "Z" ? Str.toLowerCase(ch) : ch)),
		""
	)

/** A reviewed statement read against its draft is written as drafted exactly when it holds the draft's tokens, each placeholder filled by a balanced run, and a draft that holds no placeholder, which meta.json records by its tokens' digest (statementDigest), is written as drafted exactly when the reviewed statement's tokens digest alike, respelled (its words in lower case, a comment and a newline between its tokens) or edited. Its budget is its suite's before it was a property (test/unit/deploy/split.test.ts at 4ca3036a): 300 runs and 300 steered cases. */
export const aReviewedStatementReadAgainstItsDraftIsWrittenAsDraftedExactlyWhenItHoldsTheDraftsTokensEachPlaceholderFilledByABalancedRun =
	property.explore(draftGen, {
		needs: {},
		budget: { runs: 300, steered: 300 },
		situations: [
			"a placeholder filled",
			"a word edited",
			"a string edited",
			"another token edited",
			"a string kept",
			"an edit the placeholders absorb",
			"an edit only unbalanced runs absorb",
			"a draft recorded by its digest, respelled as drafted",
			"a draft recorded by its digest, edited"
		] satisfies ReadonlyArray<Reached<WrittenFeature>>,
		check: (_, c: Case<WrittenFeature>) => (d) =>
			Effect.sync(() => {
				const written = (edit: Option.Option<number>) =>
					statementTokens(
						Arr.join(
							Arr.map(d.tokens, (t, i) =>
								t.kind === "hole"
									? defined(d.fills[i], "a placeholder's fill")
									: Option.contains(edit, i)
										? editOf(t)
										: t.text
							),
							" "
						)
					)
				const drafted = statementTokens(
					Arr.join(
						Arr.map(d.tokens, (t) => (t.kind === "hole" ? placeholderToken : t.text)),
						" "
					)
				)
				assert.ok(
					writtenAs(drafted, written(Option.none())),
					"the draft with its placeholders filled"
				)
				/** The draft's tokens where it holds no placeholder, which meta.json records it by their digest. */
				const scanned = Arr.flatMap(d.tokens, (t) => (t.kind === "token" ? [t] : []))
				const recorded =
					scanned.length === d.tokens.length
						? Option.some(succeeded(statementDigest(drafted), "a drafted statement's digest"))
						: Option.none()
				/** Whether the draft is recorded by its digest, and if so, that reviewed tokens digest as it does exactly
				 * when they are written as drafted. */
				const digestsAsDrafted = (
					reviewed: ReadonlyArray<StatementToken>,
					label: string
				): boolean =>
					Option.match(recorded, {
						onNone: () => false,
						onSome: (digest) => {
							assert.equal(
								succeeded(statementDigest(reviewed), "a reviewed statement's digest") === digest,
								writtenAs(drafted, reviewed),
								label
							)
							return true
						}
					})
				const respelled = statementTokens(
					Arr.join(
						Arr.map(scanned, (t) => (t.is === "word" ? asciiLower(t.text) : t.text)),
						" /* reviewed */\n"
					)
				)
				if (digestsAsDrafted(respelled, "the draft respelled") && writtenAs(drafted, respelled)) {
					c.note("a draft recorded by its digest, respelled as drafted")
				}
				if (Arr.some(d.tokens, (t) => t.kind === "hole")) {
					c.note("a placeholder filled")
				}
				if (Arr.some(d.tokens, (t) => t.kind === "token" && t.is === "string")) {
					c.note("a string kept")
				}
				const edited = d.tokens[d.edited]
				if (edited === undefined || edited.kind === "hole") {
					return
				}
				const edit = written(Option.some(d.edited))
				const slots = Arr.map(drafted, slotOf)
				const absorbed = fillable(slots, edit, balancedRunEnds)
				assert.equal(writtenAs(drafted, edit), absorbed, `the draft with ${edited.text} edited`)
				if (digestsAsDrafted(edit, `the draft with ${edited.text} edited`)) {
					c.note("a draft recorded by its digest, edited")
				}
				if (absorbed) {
					c.note("an edit the placeholders absorb")
				} else if (fillable(slots, edit, anyRunEnds)) {
					c.note("an edit only unbalanced runs absorb")
				}
				c.note(
					edited.is === "word"
						? "a word edited"
						: edited.is === "string"
							? "a string edited"
							: "another token edited"
				)
			}),
		oracle: {
			kind: "second-implementation",
			name: "a draft with each placeholder filled is written as drafted, and one with a token outside a placeholder changed exactly when the offsets each prefix of its slots can end at reach the end; a draft that holds no placeholder digests as a reviewed statement exactly when writtenAs holds"
		},
		kept: [
			{
				token: ReplayToken(
					"test/unit/deploy/split.test.ts#aReviewedStatementReadAgainstItsDraftIsWrittenAsDraftedExactlyWhenItHoldsTheDraftsTokensEachPlaceholderFilledByABalancedRun:-:0.4.1.0.2.0.0.1.1.0.0.0.3.1"
				),
				reason:
					"an edited token the placeholders around it absorb: 1 x 1 f(a) fills them with 1 x, f and (a)",
				since: "2026-11-08"
			}
		],
		kills: [
			{
				file: "packages/engine/src/deploy/render/markers.ts",
				original: 'b.kind === "word" && a.upper === b.upper',
				replacement: 'b.kind === "word"',
				why: 'Operator mutant db15f59d86 at packages/engine/src/deploy/render/markers.ts:226 in sameToken: `b.kind === "word" && a.upper === b.upper` becomes `b.kind === "word"`; the property fails (the census, lane TESTPOLICY2).'
			},
			{
				file: "packages/engine/src/deploy/render/markers.ts",
				original:
					'\tResult.map(digest("statement-tokens", tokens, everyProperty), mintStatementDigest)',
				replacement:
					'\tResult.map(digest("statement-tokens", tokens.slice(1), everyProperty), mintStatementDigest)',
				why: "A weaker key: a statement's digest leaves its first token out, so a draft edited in its first token, or a one-token draft edited at all, digests as drafted, and meta.json's record holds a file a reviewer changed as written (lane META8)."
			}
		]
	})
