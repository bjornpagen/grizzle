/**
 * A text split at the last occurrence of its separator, r.splitLast (ir/rel.ts TextSplit `splitLast`,
 * lower/conservative/call lowerSplitLast), served reads on PostgreSQL 19 against JavaScript's own reading
 * (split-last.fixtures.ts): over one transaction's texts of a letter, a comma, a slash, a dot, a two-byte é and a
 * four-byte character beyond the BMP, repeated, leading, trailing and empty among them, each text's split at each of
 * the five separators is the text before JavaScript's lastIndexOf of it and the text after, none where the text holds
 * none; a negation of it keeps the texts without a comma; and a parameter's split is its own. A split's text may be
 * computed in the rule's scope (check/checker.ts #splitArgument): each text with a comma written ahead of it splits at
 * its last comma into its last piece, its whole text where it holds none, and its negation whose text before is empty
 * keeps the texts that hold a comma. A path's extension is the rooted path's last segment, the text after its last
 * slash, split at its last dot where neither side is empty, Node's path.posix.extname of it without its dot. The reads
 * that cast a text after into its text's characters but its separator, and an extension into a bounded text of no
 * slash or dot, compile only where the checker types them so (check/checker.ts #splitHeading), within their texts'
 * bytes.
 *
 * Oracle: JavaScript's String.prototype.lastIndexOf and slice at the separator, its split for a last piece, and Node's
 * path.posix.extname for an extension, as effect's POSIX Path service reads it (split-last.fixtures.ts lastSplitOf,
 * lastPiecesModel, extensionOf).
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option, Path } from "effect"
import { Db } from "#adapter/public/db.ts"
import { jsonText } from "#compiler/core/trusted.ts"
import {
	caseGen,
	extensionsModel,
	factsOf,
	holdingModel,
	idsText,
	type LastSplitCase,
	type LastSplitFeature,
	LastSplits,
	lastPiecesModel,
	lastSplitFeatures,
	lastSplitOf,
	lastSplitsInstall,
	lastSplitsTemplate,
	separated,
	separators,
	splitsModel,
	splitsText,
	textsText
} from "#test/pg/compute/split-last.fixtures.ts"
import { openedIn } from "#test/pg/reads/support.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"

/**
 * A text split at its last separator is the text before JavaScript's lastIndexOf of it and the text after, none where
 * the text holds none, whether its text is a column, a parameter or computed; and a path's extension, the rooted path's
 * last segment split at its last dot, is Node's path.posix.extname without its dot.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const aTextSplitAtItsLastSeparatorIsTheTextAroundJavaScriptsLastIndexOfAndAPathsExtensionIsNodes =
	property.explore(caseGen, {
		needs: { fixture: Substrate.fresh(lastSplitsTemplate) },
		situations: [
			"the empty text",
			"a separator at either end",
			"two separators in a row",
			"no separator in the text",
			"a split at a character beyond the BMP",
			"a path of one segment",
			"a last segment that leads with a dot",
			"a last segment that ends with a dot",
			"a dot in a directory and none in the last segment",
			"an extension after two dots"
		] satisfies ReadonlyArray<Reached<LastSplitFeature>>,
		check:
			({ fixture }, k: Case<LastSplitFeature>) =>
			(c: LastSplitCase) =>
				Effect.scoped(
					Effect.flatMap(fixture, (taken) =>
						Effect.provideService(
							Effect.gen(function* () {
								const o = yield* openedIn(LastSplits, {}, lastSplitsInstall, taken)
								return yield* Effect.gen(function* () {
									const { extname } = yield* Path.Path
									const db = yield* Db.open(o.served.login.roles.app, {})
									yield* db.workload.load.once({ params: {}, facts: { insert: factsOf(c) } })
									const none = { params: {}, facts: {} }
									const where = Formatter.format(c)
									for (const name of separated) {
										const splits = yield* db.workload[name].once(none)
										assert.deepEqual(
											splitsText(splits),
											splitsModel(c.texts, separators[name]),
											`the split at the last ${jsonText(separators[name])} of ${where}`
										)
									}
									const commaCast = yield* db.workload.commaCast.once(none)
									assert.deepEqual(
										splitsText(commaCast),
										splitsModel(c.texts, separators.comma),
										`the split at the last comma cast into its text's characters, after it but the comma, of ${where}`
									)
									const wideCast = yield* db.workload.wideCast.once(none)
									assert.deepEqual(
										splitsText(wideCast),
										splitsModel(c.texts, separators.wide),
										`the split at the last character beyond the BMP cast, of ${where}`
									)
									const unsplit = yield* db.workload.unsplit.once(none)
									assert.deepEqual(
										idsText(unsplit),
										holdingModel(c.texts, separators.comma, false),
										`the texts without a comma, of ${where}`
									)
									const param = yield* db.workload.param.once({
										params: { text: c.text },
										facts: {}
									})
									assert.deepEqual(
										splitsText(Arr.map(Arr.fromIterable(param), (r) => ({ id: 0, ...r }))),
										splitsText(
											Option.toArray(
												Option.map(lastSplitOf(c.text, separators.slash), (r) => ({ id: 0, ...r }))
											)
										),
										`the split of the parameter ${jsonText(c.text)} at its last slash`
									)
									const lastPiece = yield* db.workload.lastPiece.once(none)
									assert.deepEqual(
										textsText(
											Arr.map(Arr.fromIterable(lastPiece), (r) => ({ id: r.id, text: r.after }))
										),
										lastPiecesModel(c.texts),
										`each text's last piece at a comma, of ${where}`
									)
									const commaHeld = yield* db.workload.commaHeld.once(none)
									assert.deepEqual(
										idsText(commaHeld),
										holdingModel(c.texts, separators.comma, true),
										`the texts that hold a comma, of ${where}`
									)
									const extension = yield* db.workload.extension.once(none)
									assert.deepEqual(
										textsText(
											Arr.map(Arr.fromIterable(extension), (r) => ({ id: r.id, text: r.extension }))
										),
										extensionsModel(extname, c.paths),
										`each path's extension, of ${where}`
									)
									for (const feature of lastSplitFeatures(extname, c)) {
										k.note(feature)
									}
								}).pipe(Effect.scoped, withLayer(o.served.layer), withLayer(Path.layer))
							}),
							Substrate,
							taken.substrate
						)
					)
				),
		oracle: {
			kind: "specification",
			name: "JavaScript's String.prototype.lastIndexOf and slice of each text at the separator, none where it is -1; its split's last piece; and Node's path.posix.extname of each path without its dot, as effect's POSIX Path service reads it"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/conservative/call/index.ts",
				original: '\t\tcall("strpos", [call("reverse", [text]), lit.text(separator, types.text)]),',
				replacement:
					'\t\tbinary("-", binary("+", call("char_length", [text]), lit.int(1, types.integer)), call("strpos", [text, lit.text(separator, types.text)])),',
				why: "The text is split at the first occurrence of its separator, so a text of two occurrences splits wrong and one of none splits too."
			},
			{
				file: "packages/engine/src/lower/conservative/call/index.ts",
				original: '\t\tbinary(">", read(0), lit.int(0, types.integer)),',
				replacement: "\t\tundefined,",
				why: "A text that holds no separator keeps a row, an empty text before and its text past its first character after, where it has none."
			},
			{
				file: "packages/engine/src/check/checker.ts",
				original:
					'\t\t\t\t\t\tname: splitLastHeading.after,\n\t\t\t\t\t\ttype: this.#stretchType(texts("text"), single(this.#separator(split, loc)), loc)',
				replacement:
					'\t\t\t\t\t\tname: splitLastHeading.after,\n\t\t\t\t\t\ttype: this.#stretchType(texts("text"), [], loc)',
				why: "The text after is typed as any character of its text, the separator among them, so the text after a comma cast into its text's characters but the comma is refused and the fixture does not compile."
			},
			{
				file: "packages/engine/src/check/checker.ts",
				original:
					'\t\t\tcase "variant": {\n\t\t\t\tconst computed = lower(term, at)\n\t\t\t\treturn { expr: computed.expr, type: computed.nominal }\n\t\t\t}',
				replacement:
					'\t\t\tcase "variant": {\n\t\t\t\tconst value = bind(term, name, at)\n\t\t\t\treturn { expr: this.#boundArgument(value, wildcardText, name, at), type: wildcardText }\n\t\t\t}',
				why: "A computed text is bound as a bind map's term is, which refuses it, so a split of the path with a slash written ahead of it does not compile."
			},
			{
				file: "packages/engine/src/check/checker.ts",
				original: "\t\t\t\treturn { expr: computed.expr, type: computed.nominal }",
				replacement: "\t\t\t\treturn { expr: computed.expr, type: wildcardText }",
				why: "A computed text is typed as any text, its byte bound lost, so an extension of the rooted path cast into a text of 65 bytes is refused and the fixture does not compile."
			}
		]
	})
