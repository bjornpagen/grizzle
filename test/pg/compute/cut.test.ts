/**
 * Text.cutBefore and Text.cutFrom on PostgreSQL 19, against the host and a model of the cut.
 *
 * Each library function's SQL (physical/ddl/library.ts cutDefinition), created in the session's pg_temp, over a batch of
 * pairs in one round trip: drawn texts of an href's delimiters, multibyte characters and characters beyond the BMP, each
 * cut at a drawn set of characters, the empty set and a repeat among them. Each cut, lowered as a query and as a check
 * lowers it, over a text of a bounded pattern and over any text, is text within the subject's bytes; PostgreSQL's text
 * of each pair, the host evaluator's and the reference evaluator's are the model's: the text before its first
 * character among the set, all of it where it holds none, and the text from that character on, the empty text where it
 * holds none, the two concatenating to the text.
 *
 * Oracle: the model, the text's code points read up to the first one the set's code points hold, by the reference
 * evaluator's own walk (test/support/oracle/evaluate/catalog.ts), beside the host's grizzle-text cut.
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter } from "effect"
import { jsonText } from "#compiler/core/trusted.ts"
import {
	createLibrary,
	type CutFeature,
	cutBatch,
	cutFeatures,
	cutLowered,
	cutModel,
	cutSql,
	cuts,
	hostCut,
	referenceCut
} from "#test/pg/compute/cut.fixtures.ts"
import { inInstallation, textCell } from "#test/support/pg/compute/support.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"

/** Each cut at each site, over a bounded text and over any text. */
const terms = Arr.flatMap(cuts, (fn) =>
	Arr.flatMap(["query", "check"] as const, (mode) =>
		Arr.map([true, false], (bounded) => ({
			fn,
			mode,
			bounded,
			term: cutLowered(fn, mode, bounded)
		}))
	)
)

/**
 * Text.cutBefore and Text.cutFrom on PostgreSQL 19 cut a text at its first character among a set, as the host and the
 * model do, in a query and a check.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const textCutBeforeAndCutFromOnPostgreSQL19CutATextAtItsFirstCharacterAmongASetAsTheHostAndTheModelDo =
	property.explore(cutBatch, {
		needs: { tx: Substrate.rolledBack(baseSubstrate) },
		situations: [
			"a cut inside the text",
			"a cut at the first character",
			"no character of the set in the text",
			"the set empty",
			"a repeated character in the set",
			"a character beyond the Basic Multilingual Plane before the cut",
			"the cut at a character beyond the Basic Multilingual Plane"
		] satisfies ReadonlyArray<CutFeature>,
		check:
			({ tx }, k: Case<CutFeature>) =>
			(pairs) =>
				Effect.gen(function* () {
					const { bare } = yield* tx
					const rows = yield* inInstallation(
						bare,
						createLibrary,
						bare.queryValues(cutSql(Arr.map(terms, (t) => t.term)), [
							jsonText(Arr.map(pairs, (p, ord) => ({ ord, t: p.text, c: p.chars })))
						])
					)
					assert.equal(rows.length, pairs.length, "a row per pair")
					for (const [i, row] of rows.entries()) {
						const pair = defined(pairs[i], "the pair PostgreSQL read")
						const model = cutModel(pair)
						const where = Formatter.format(pair)
						for (const [j, { fn, mode, bounded, term }] of terms.entries()) {
							const label = `${fn} in a ${mode} over ${bounded ? "a bounded" : "any"} text, ${where}`
							assert.equal(textCell(row, j), model[fn], `PostgreSQL's ${label}`)
							assert.equal(hostCut(term, pair), model[fn], `the host's ${label}`)
							assert.equal(referenceCut(term, pair), model[fn], `the reference's ${label}`)
						}
						for (const feature of cutFeatures(pair)) {
							k.note(feature)
						}
					}
				}),
		oracle: {
			kind: "specification",
			name: "the text's code points up to the first one the set holds, and from it on, all of the text and the empty text where the set holds none of them"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/physical/ddl/library.ts",
				original:
					'\t\tfn === "cutBefore" ? call("left", [subject, binary("-", at, integer(1))]) : from(subject, at)',
				replacement: '\t\tfn === "cutBefore" ? call("left", [subject, at]) : from(subject, at)',
				why: "PostgreSQL's cutBefore keeps the character it cuts at, so the path of an href with a query ends in its `?`, where the host's and the model's stop before it."
			},
			{
				file: "packages/text/src/text.ts",
				original: "\ttext.slice(firstAmong(text, chars) ?? text.length)\n",
				replacement: "\ttext.slice(firstAmong(text, chars) ?? 0)\n",
				why: "The host's cutFrom is the whole text where the set holds none of its characters, so a reference with no query or fragment reads its path as its params, where PostgreSQL's and the model's are empty."
			}
		]
	})
