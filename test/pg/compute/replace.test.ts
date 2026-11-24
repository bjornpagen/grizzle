/**
 * Text.replace on PostgreSQL 19, against the host and a model of replace.
 *
 * Over batches of drawn texts of the three characters a URI path segment escapes (`%`, `?`, `#`), multibyte characters
 * and characters beyond the BMP, each with a drawn from of one or two characters, now and then empty, and a drawn to of
 * up to three, the empty one among them: Text.replace lowered as a query over texts whose pattern bounds them, whose
 * term is text within x's bytes and what each occurrence of from adds, and as a check over bounded and over any texts,
 * read in one statement. PostgreSQL's text, the host evaluator's and the reference evaluator's are the model's. A query
 * over texts no pattern bounds refuses it, since replace allocates its result.
 *
 * Oracle: the model, every occurrence of from in the text, left to right and none overlapping, replaced by to, and the
 * text itself for an empty from, by a scan for each next occurrence after the last (the host splits and joins, and the
 * reference evaluator walks code points).
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter } from "effect"
import { jsonText } from "#compiler/core/trusted.ts"
import {
	hostReplace,
	referenceReplace,
	replaceBatch,
	type ReplaceFeature,
	replaceFeatures,
	replaceModel,
	replaceSql,
	terms,
	unboundedQuery
} from "#test/pg/compute/replace.fixtures.ts"
import { textCell } from "#test/pg/compute/support.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"

/**
 * Text.replace on PostgreSQL 19 replaces every occurrence of from by to as the host and the model do, in a query over
 * bounded texts and in a check, and a query refuses it over texts no pattern bounds.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const textReplaceOnPostgreSQL19ReplacesEveryOccurrenceOfFromByToAsTheHostAndTheModelDo =
	property.explore(replaceBatch, {
		needs: { tx: Substrate.rolledBack(baseSubstrate) },
		situations: [
			"one character by several",
			"a character by none",
			"two characters replaced",
			"an empty from",
			"no occurrence",
			"a character beyond the Basic Multilingual Plane replaced"
		] satisfies ReadonlyArray<ReplaceFeature>,
		check:
			({ tx }, k: Case<ReplaceFeature>) =>
			(cases) =>
				Effect.gen(function* () {
					assert.ok(
						!unboundedQuery.ok && unboundedQuery.error.reason._tag === "UnsupportedOperation",
						"a query refuses replace over texts no pattern bounds"
					)
					const { session } = yield* tx
					const rows = yield* session.values(replaceSql, [
						jsonText(Arr.map(cases, (c, ord) => ({ ord, t: c.text, f: c.from, r: c.to })))
					])
					assert.equal(rows.length, cases.length, "a row per case")
					for (const [i, row] of rows.entries()) {
						const c = defined(cases[i], "the case PostgreSQL read")
						const model = replaceModel(c)
						const where = Formatter.format(c)
						for (const [j, { label, term }] of terms.entries()) {
							assert.equal(textCell(row, j), model, `PostgreSQL's in ${label}, ${where}`)
							assert.equal(hostReplace(term, c), model, `the host's in ${label}, ${where}`)
							assert.equal(
								referenceReplace(term, c),
								model,
								`the reference's in ${label}, ${where}`
							)
						}
						for (const feature of replaceFeatures(c)) {
							k.note(feature)
						}
					}
				}),
		oracle: {
			kind: "specification",
			name: "every occurrence of from in the text, left to right and none overlapping, replaced by to, and the text itself for an empty from"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/compute/typing.ts",
				original:
					"\t\t\t\t\t: xBytes + Math.floor(xBytes / fromBytes) * Math.max(0, toBytes - fromBytes)",
				replacement: "\t\t\t\t\t: xBytes",
				why: "replace's term is typed within its subject's bytes, so a query over bounded texts states a bound its result passes wherever to is longer than from."
			},
			{
				file: "packages/text/src/text.ts",
				original: '\tfrom === "" ? text : text.split(from).join(to)',
				replacement: '\tfrom === "" ? text : text.replace(from, to)',
				why: "The host replaces only the first occurrence of from, so a name with two `%` is written with its second unescaped, where PostgreSQL escapes both."
			}
		]
	})
