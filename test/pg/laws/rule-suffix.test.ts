/**
 * A rule whose probe seeks a suffix it holds fixed reads by the B-tree on its text's suffix key (sql/suffix.ts,
 * physical/indexes/engine.ts KeyTerm `suffix`): edullm's Media type in miniature, the references that end with a
 * forbidden suffix (rule-suffix.fixtures.ts Ending), a check refusing one of kind 1. A forbidden suffix inserted is
 * judged by a probe of its side of news that reads Ref by the suffix it holds, the suffix test's subject Ref's target:
 * the judged read states the key's range in place of the test, and the installation holds the B-tree its request asks
 * for, so PostgreSQL seeks it where it read every reference.
 *
 * - **Locality:** each case draws 250 to 400 keys and one of them, and 600 to 900 keys more; each key a reference of
 *   kind 1 at `f<k>.x<k>` and one of kind 0 at `g<k>.z<k>`. Forbidding `.z<k>` is judged, lawful, in a transaction of
 *   its own rolled back, the judged statements over Forbidden's side of news explained while it holds the row: the rows
 *   they read, as EXPLAIN ANALYZE counts them, and the SIRead locks the transaction holds once SET CONSTRAINTS ALL
 *   IMMEDIATE has run the judge, by lock type and relation, are the same beside every key as beside the first, and no
 *   SIRead lock is on a whole relation, each statement run under its routine's advice, and the plan laws hold over
 *   those routines (test/support/advice.ts), the range the index condition of Ref's read. A probe that read every
 *   reference would read more rows beside more keys and lock Ref whole.
 * - **Seek:** each case draws up to twelve targets and up to six suffixes, each a target's tail or drawn apart, over the
 *   code points the range turns on (the sentinel, the edges of UTF-8's sequences, U+D7FF and U+E000, the first astral
 *   code point, U+10FFFE and U+10FFFF): the range, as a judged read states it with the suffix a parameter, and the
 *   suffix test find exactly the references the host's endsWith does, and under the advice that reads Ref by the
 *   B-tree on the key the range is that Index Scan's index condition, never its filter.
 */
import { assert, defined } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { property, type Case } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, String as Str } from "effect"
import { seatIn } from "#test/pg/fin/installed.ts"
import {
	footprintBeside,
	localityGen,
	RELATIONS,
	runSeek,
	type SeekFeature,
	seekGen,
	suffixTemplate
} from "#test/pg/laws/rule-suffix.fixtures.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * Read the same rows and take the same SIRead locks beside hundreds more references, none on a whole relation, when a
 * suffix is forbidden.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const aForbiddenSuffixIsJudgedByASeekOfItsReferencesBesideAnyNumberOfOthersAndLocksNoWholeRelation =
	property.explore(localityGen, {
		needs: { fresh: Substrate.fresh(suffixTemplate) },
		situations: ["measured"] satisfies ReadonlyArray<Reached<"measured">>,
		check:
			({ fresh }, c: Case<"measured">) =>
			(l) =>
				Effect.scoped(
					Effect.flatMap(fresh, (taken) =>
						Effect.provideService(
							Effect.gen(function* () {
								const seat = yield* seatIn(taken, RELATIONS, "rule_suffix")
								const where = Formatter.format(l)
								const before = yield* footprintBeside(seat, l.key, 1, l.before)
								const after = yield* footprintBeside(seat, l.key, l.before + 1, l.after)
								assert.ok(
									Arr.some(before.rows, (n) => n > 0),
									`${where}: a probe reads a reference`
								)
								assert.deepEqual(
									after.rows,
									before.rows,
									`${where}: each probe reads the same rows`
								)
								assert.deepEqual(after.locks, before.locks, `${where}: the same SIRead locks`)
								assert.deepEqual(
									Arr.filter(after.locks, Str.startsWith("relation ")),
									[],
									`${where}: no SIRead lock on a whole relation`
								)
								c.note("measured")
							}),
							Substrate,
							taken.substrate
						)
					)
				),
		oracle: {
			kind: "universal",
			name: "invariance: the judge of a forbidden suffix reads the same rows and takes the same SIRead locks whatever other references are stored"
		},
		show: Formatter.format,
		budget: { runs: 6, steered: 0 },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/sql/suffix.ts",
				original:
					"\t\treturn origin !== undefined && suffixed.has(origin) ? suffixRange(test.text, test.suffix) : e\n",
				replacement: "\t\treturn e\n",
				why: "The suffix test read as it was lowered, right(target, char_length(suffix)) = suffix, which no index condition reads: the probe scans every reference, reads more rows beside more keys and locks Ref whole."
			}
		]
	})

/**
 * Find exactly the references the suffix test finds through the B-tree on the key, over the code points the range
 * turns on.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const aSuffixKeysRangeFindsExactlyTheReferencesTheSuffixTestFindsThroughTheBTreeOnTheKey =
	property.explore(seekGen, {
		needs: { fresh: Substrate.fresh(suffixTemplate) },
		situations: [
			"a suffix some target ends with",
			"a suffix no target ends with",
			"an empty suffix",
			"a suffix of U+10FFFF alone",
			"an astral suffix"
		] satisfies ReadonlyArray<Reached<SeekFeature>>,
		check:
			({ fresh }, c: Case<SeekFeature>) =>
			(seek) =>
				Effect.scoped(
					Effect.flatMap(fresh, (taken) =>
						Effect.provideService(
							Effect.gen(function* () {
								const seat = yield* seatIn(taken, RELATIONS, "rule_suffix")
								yield* runSeek(seat, defined(seek, "a seek case"), (f) => c.note(f))
							}),
							Substrate,
							taken.substrate
						)
					)
				),
		oracle: {
			kind: "postgresql",
			name: "the suffix test, right(target, char_length(suffix)) = suffix, and the host's endsWith, over the stored references"
		},
		show: Formatter.format,
		kept: [],
		kills: [
			{
				file: "packages/engine/src/sql/suffix.ts",
				original:
					'\tbinary("||", call("chr", [lit.int(1, types.integer)]), call("reverse", [text]))\n',
				replacement: '\tcall("reverse", [text])\n',
				why: "A key with no sentinel: a suffix of U+10FFFF alone has no text above its keys, and its bound, the empty prefix raised, is U+0001, below them, so PostgreSQL finds no reference that ends with it."
			}
		]
	})
