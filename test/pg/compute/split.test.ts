/**
 * A text's separator split, r.split (ir/rel.ts TextSplit `pieces`, lower/conservative/call lowerPieces), and its rest
 * after a prefix, r.rest (TextSplit `rest`, lowerRest), served reads on PostgreSQL 19 against JavaScript's own reading
 * (split.fixtures.ts): over one transaction's texts of a letter, a comma, a slash, a space, a two-byte é, a four-byte
 * character beyond the BMP and a tab, repeated, leading, trailing and empty among them, each text's pieces at each of
 * the five separators are JavaScript's split of it, n occurrences n + 1 pieces, each at its place from 0, the empty
 * text one empty piece, the pieces of a text of no bound alike; and each text's rest after its prefix, most often a
 * prefix of it, is the text past the prefix where it starts with it and none where it does not, read after a column, a
 * constant and a parameter, negated, and read again after a comma. The reads that cast a piece into its text's
 * characters but its separator, and a rest into its text's characters, compile only where the checker types them so
 * (check/checker.ts #splitHeading), within the text's 64 bytes.
 *
 * Oracle: JavaScript's String.prototype.split at the separator, and startsWith and slice for a rest (split.fixtures.ts
 * piecesModel, restOf).
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter } from "effect"
import { Db } from "#adapter/public/db.ts"
import { jsonText } from "#compiler/core/trusted.ts"
import {
	caseGen,
	factsOf,
	idsText,
	piecesModel,
	piecesText,
	restOf,
	restsModel,
	restsText,
	type SplitCase,
	type SplitFeature,
	separated,
	separators,
	splitFeatures,
	Splits,
	splitsInstall,
	splitsTemplate,
	unprefixedModel
} from "#test/pg/compute/split.fixtures.ts"
import { openedIn } from "#test/pg/reads/support.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"

/**
 * A text's pieces at a separator are JavaScript's split of it, the empty text one empty piece, and its rest after a
 * prefix the text past the prefix where it starts with it, none where it does not.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const aTextsPiecesAtASeparatorAreJavaScriptsSplitOfItAndItsRestAfterAPrefixIsTheTextPastThePrefixOrNone =
	property.explore(caseGen, {
		needs: { fixture: Substrate.fresh(splitsTemplate) },
		situations: [
			"the empty text, one empty piece",
			"a separator at either end",
			"two separators in a row",
			"no separator in the text",
			"a split at a character beyond the BMP",
			"a rest after the empty prefix",
			"a rest after the whole text",
			"a text without the prefix",
			"a prefix longer than the text",
			"a rest of a rest"
		] satisfies ReadonlyArray<Reached<SplitFeature>>,
		check:
			({ fixture }, k: Case<SplitFeature>) =>
			(c: SplitCase) =>
				Effect.scoped(
					Effect.flatMap(fixture, (taken) =>
						Effect.provideService(
							Effect.gen(function* () {
								const o = yield* openedIn(Splits, {}, splitsInstall, taken)
								return yield* Effect.gen(function* () {
									const db = yield* Db.open(o.served.login.roles.app, {})
									yield* db.workload.load.once({ params: {}, facts: { insert: factsOf(c) } })
									const none = { params: {}, facts: {} }
									const where = Formatter.format(c)
									for (const name of separated) {
										const pieces = yield* db.workload[name].once(none)
										assert.deepEqual(
											piecesText(pieces),
											piecesModel(c.texts, separators[name]),
											`the pieces at ${jsonText(separators[name])} of ${where}`
										)
									}
									const commaCast = yield* db.workload.commaCast.once(none)
									assert.deepEqual(
										piecesText(commaCast),
										piecesModel(c.texts, separators.comma),
										`the pieces at a comma cast into its text's characters but the comma, of ${where}`
									)
									const wideCast = yield* db.workload.wideCast.once(none)
									assert.deepEqual(
										piecesText(wideCast),
										piecesModel(c.texts, separators.wide),
										`the pieces at the character beyond the BMP cast, of ${where}`
									)
									const looseSlash = yield* db.workload.looseSlash.once(none)
									assert.deepEqual(
										piecesText(looseSlash),
										piecesModel(c.texts, separators.slash),
										`the pieces at a slash of the texts as any text, of ${where}`
									)
									const rests = yield* db.workload.rest.once(none)
									assert.deepEqual(
										restsText(rests),
										restsModel(c.pairs, (p) => restOf(p.text, p.prefix)),
										`each rest after its prefix, cast into the text's characters, of ${where}`
									)
									const unprefixed = yield* db.workload.unprefixed.once(none)
									assert.deepEqual(
										idsText(unprefixed),
										unprefixedModel(c.pairs),
										`the texts without their prefix, of ${where}`
									)
									const constant = yield* db.workload.restConstant.once(none)
									assert.deepEqual(
										restsText(constant),
										restsModel(c.pairs, (p) => restOf(p.text, "a,")),
										`each rest after the constant a, of ${where}`
									)
									const param = yield* db.workload.restParam.once({
										params: { prefix: c.prefix },
										facts: {}
									})
									assert.deepEqual(
										restsText(param),
										restsModel(c.pairs, (p) => restOf(p.text, c.prefix)),
										`each rest after the parameter ${jsonText(c.prefix)}, of ${where}`
									)
									const twice = yield* db.workload.restRest.once(none)
									assert.deepEqual(
										restsText(twice),
										restsModel(c.pairs, (p) =>
											Arr.flatMap(restOf(p.text, p.prefix), (once) => restOf(once, ","))
										),
										`each rest after its prefix and then a comma, of ${where}`
									)
									for (const feature of splitFeatures(c)) {
										k.note(feature)
									}
								}).pipe(Effect.scoped, withLayer(o.served.layer))
							}),
							Substrate,
							taken.substrate
						)
					)
				),
		oracle: {
			kind: "specification",
			name: "JavaScript's String.prototype.split of each text at the separator, each piece at its place from 0, and the text past its prefix where String.prototype.startsWith holds, none where it does not"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/conservative/call/index.ts",
				original: '\t\tbinary(">", read(1), lit.int(1, types.bigint)),',
				replacement: "\t\tundefined,",
				why: "The empty piece before the separator written ahead of the text is kept, at place -1, so every text's pieces hold one more."
			},
			{
				file: "packages/engine/src/lower/conservative/call/index.ts",
				original:
					'\t\tcall("string_to_table", [binary("||", written, splitArgument(node, "text", cx, env)), written]),',
				replacement:
					'\t\tcall("string_to_table", [splitArgument(node, "text", cx, env), written]),',
				why: "No separator is written ahead of the text, so its first piece is dropped and the empty text has no piece, where JavaScript reads one empty piece."
			},
			{
				file: "packages/engine/src/lower/conservative/call/index.ts",
				original: '\t\t\tbinary("+", call("char_length", [prefix]), lit.int(1, types.integer))\n',
				replacement: '\t\t\tcall("char_length", [prefix])\n',
				why: "A rest keeps the prefix's last character, so the rest after a nonempty prefix starts one character early."
			},
			{
				file: "packages/engine/src/scalar/regex/stretch.ts",
				original: "\tconst n = intersection(alphabet, complement(excluded))\n",
				replacement: "\tconst n = alphabet\n",
				why: "A piece is typed as any character of its text, the separator among them, so a piece cast into its text's characters but the comma is refused and the fixture does not compile."
			},
			{
				file: "packages/engine/src/check/checker.ts",
				original:
					"\t\tconst bytes = textInfoBounds(text)?.bytes\n\t\tconst language = bytes === undefined ? pattern : languageWithin(pattern, bytes)\n\t\treturn this.schema.queryFieldType(",
				replacement:
					"\t\tconst bytes = undefined\n\t\tconst language = bytes === undefined ? pattern : languageWithin(pattern, bytes)\n\t\treturn this.schema.queryFieldType(",
				why: "A rest and a piece are typed with no byte bound, so a rest cast into the drawn texts' 64 bytes is refused and the fixture does not compile."
			},
			{
				file: "packages/engine/src/check/checker.ts",
				original:
					"\t\t\tif (bindTerms(filter.source).some(([, term]) => this.#readsRegion(term))) {",
				replacement:
					'\t\t\tif ((filter.source.kind === "query" || filter.source.kind === "step") && bindTerms(filter.source).some(([, term]) => this.#readsRegion(term))) {',
				why: "A negated rest whose text the head does not deliver is placed after the head, where its text is no column, so the negation does not compile."
			}
		]
	})
