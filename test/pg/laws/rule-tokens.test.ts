/**
 * A text's tokens, r.tokens (ir/rel.ts CallFunction `tokens`, lower/conservative/call), a source a derived relation's
 * definition matches, and the rules over that relation, judged whole: a unit-local rule over a relation of tokens of
 * stored rows reads those rows' tokens alone (analysis/theory/unit.ts, a token split a source of no unit of its own). On
 * PostgreSQL 19, over pantry in small (rule-tokens.fixtures.ts): each document's attributes, an IDREFS one listed,
 * its tokens the derived relation Idref, and each document's targets; every token a target of its document (Idref
 * target), no token of an attribute twice (Distinct tokens), and three tokens at most (Short list).
 *
 * - **equivalence**: one transaction writes one document or two, each whole, its lists drawn of a few tokens between
 *   runs of one to three XML whitespace characters, with whitespace or none at either end, or of whitespace alone. The
 *   judge refuses exactly where a document breaks a rule as XML reads its lists, a specification: each maximal run of
 *   no whitespace a token, in order (XML Schema Part 2 §3.3.10 and §4.3.6), naming a rule some document breaks.
 * - **locality**: thousands of documents stored, analyzed or not, beside one a transaction writes whole: each whole
 *   rule's statement reads the written document's tokens alone, the same when as many documents again are stored; and
 *   with tens of documents written, then four times as many, each node it runs once per unit reads that unit alone. A
 *   publish's judge of these rules reads the tokens of the documents it writes, once each, which is the work a native
 *   foreign key of a stored token does: its probe of each token's target.
 */
import { property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	runTokensLocality,
	runWritten,
	type TokensFeature,
	type TokensLocalityFeature,
	tokensLocalityGen,
	tokensTemplate,
	writtenGen
} from "#test/pg/laws/rule-tokens.fixtures.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * The judge of the rules over a relation of tokens refuses exactly the documents whose lists, read as XML reads a
 * whitespace-separated list, break a rule, naming one they break.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const aRuleOverATextsTokensIsJudgedAsXMLReadsTheListItsTokensSplitAtEachRunOfWhitespace =
	property.explore(writtenGen, {
		needs: { substrate: Substrate.rolledBack(tokensTemplate) },
		situations: [
			"accepted",
			"refused by Idref target",
			"refused by Distinct tokens",
			"refused by Short list",
			"a list of whitespace alone",
			"a run of several whitespace characters",
			"whitespace before the first token or after the last",
			"a tab, LF or CR between two tokens",
			"a list of exactly the longest length",
			"two documents in one transaction"
		] satisfies ReadonlyArray<TokensFeature>,
		check:
			({ substrate }, c) =>
			(written) =>
				Effect.gen(function* () {
					const { connection, value } = yield* substrate
					yield* runWritten(value, connection, written, c)
				}),
		oracle: {
			kind: "specification",
			name: "XML Schema Part 2's reading of a list, each maximal run of no XML whitespace a token, in order: the judge refuses exactly the documents whose tokens so read break Idref target, Distinct tokens or Short list, naming one they break"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/sql/escape.ts",
				original: '\t\tcase 0x0a:\n\t\t\treturn "\\\\n"\n',
				replacement: '\t\tcase 0x0a:\n\t\t\treturn "\\\\r"\n',
				why: "An escape string spells a line feed as a carriage return, so the whitespace fold of a PL/pgSQL block, whose constant holds a line feed and is spelled E'' on the block's one line, reads a line feed as no space, and a list XML splits at one is refused."
			},
			{
				file: "packages/engine/src/lower/conservative/call/index.ts",
				original: "\t\t\t\tcollapsedText(lowerExpr(cx, text.expr, env)),",
				replacement: "\t\t\t\tlowerExpr(cx, text.expr, env),",
				why: "The text is split at each space as written, uncollapsed: a run of two spaces is an empty token, which no target is, a tab, LF or CR stays inside a token, and a leading space is an empty first token, so a list XML reads as targets alone is refused by Idref target."
			},
			{
				file: "packages/engine/src/lower/conservative/call/index.ts",
				original: '\t\t\treturn binary("-", col(alias, number), lit.int(1, types.bigint))',
				replacement: "\t\t\treturn col(alias, number)",
				why: "A token's place is its ordinality, from 1, so a list of exactly three tokens holds one at place 3 and is refused by Short list, which admits places 0 to 2."
			},
			{
				file: "packages/engine/src/analysis/theory/unit.ts",
				original:
					'\t\tcase "split":\n\t\tcase "series":\n\t\t\treturn { unit: { kind: "none" }, source }',
				replacement:
					'\t\tcase "series":\n\t\t\treturn { unit: { kind: "none" }, source }\n\t\tcase "split":\n\t\t\treturn { unit: { kind: "hidden" }, source }',
				why: "A split hides its unit, so every rule whose definition matches it beside the attributes is no unit-local rule, and the probes, which read no token split, refuse the schema: no rule over a text's tokens compiles."
			}
		]
	})

/**
 * Each whole statement of the rules over a relation of tokens reads the tokens of the documents a transaction wrote
 * alone, however many documents stand beside them, with statistics or none, and its work grows with the documents
 * written, not with their square.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const aWholeRuleOverATextsTokensReadsTheTokensOfTheUnitsATransactionWroteAlone =
	property.explore(tokensLocalityGen, {
		needs: { substrate: Substrate.rolledBack(tokensTemplate) },
		situations: [
			"measured with no statistics",
			"measured analyzed"
		] satisfies ReadonlyArray<TokensLocalityFeature>,
		check:
			({ substrate }, c) =>
			(drawn) =>
				Effect.gen(function* () {
					const { connection, value } = yield* substrate
					yield* runTokensLocality(value, connection, drawn, c)
				}),
		oracle: {
			kind: "universal",
			name: "bound: a whole rule's statement over a relation of tokens reads fewer rows than the documents stored beside the written one, however many stand beside it, and each node it runs more than once reads fewer rows a run than the documents written"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/theory/unit.ts",
				original:
					'\t\t\trestriction.kind === "region" ? unitStep(walkedText, unit, restriction.region) : walkedText,',
				replacement: "\t\t\twalkedText,",
				why: "No rule of a whole rule's violation query matches the region of the documents a transaction wrote, so the judge reads every stored document's attributes and splits every list, and a write of one document reads all of them."
			}
		]
	})
