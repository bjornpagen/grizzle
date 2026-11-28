/**
 * Text at the host boundary and its orders (core/text.ts).
 *
 * - Validation: validateText admits exactly the well-formed, NUL-free strings, and refuses a planted NUL, a lone
 *   surrogate of either half or a reversed pair at any position, and every non-string, by its fault. Oracle: the
 *   boundary's specification, each plant's fault named by the plant.
 * - Code point order: compareCodePoints orders as the UTF-8 bytes of the texts do, PostgreSQL's C collation. Oracle: a
 *   second implementation, TextEncoder's bytes compared one by one.
 * - Tuple orders: a tuple of texts orders as a JSON array by code unit and by code point; and its identity (core/text.ts
 *   textsId) orders as its texts' code points, text by text, a tuple before every tuple it begins, as its texts do
 *   compared as they are (compareTextLists), and stands so in a set of identities sorted through its columns
 *   (inIdentityOrder), and is another tuple's identity in a TextsMap exactly when the tuples are one, one tuple one
 *   digest. Oracle: a second implementation, the tuples spelled and compared.
 * - Collisions: a TextsMap holds lists whose digests meet apart, those a birthday search finds and a family of texts
 *   past V8's hashed length made to meet, and a lookup compares texts with at most its bucket's AVL height of entries.
 *   Oracle: the specification, a map of lists exact whatever their digests.
 *
 * Features: live text, a non-string and each plant at each position; equal tuples, a prefix, a difference past the
 * first text, of two lengths, and at an escaped unit.
 */

import { codePoints, compareCodePoints } from "@bjornpagen/grizzle-text/text"
import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { array } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option, Order, String as Str } from "effect"
import { compareStrings } from "#compiler/core/order.ts"
import {
	compareQuotedTuples,
	compareTextLists,
	compareTextsIds,
	inIdentityOrder,
	isValidText,
	TextsMap,
	textsId,
	validateText
} from "#compiler/core/text.ts"
import { jsonText } from "#compiler/core/trusted.ts"
import { faulted, succeeded } from "#test/support/assert.ts"
import { callCounts } from "#test/support/kernel/calls.ts"
import { longestHashedText } from "#test/support/kernel/long-keys.ts"
import {
	plantedFault,
	type PlantedFeature,
	plantedFeature,
	plantedTextGen,
	plantedValue
} from "#test/support/unit/values/support.ts"
import {
	avlHeight,
	bytesNeed,
	type CodePointFeature,
	codePointFeatures,
	collidingFamily,
	collidingLists,
	escaped,
	kinds,
	positions,
	signOf,
	spelledText,
	text,
	tuple,
	type TupleFeature,
	identityOfTuple,
	type IdentifiedTuple
} from "#test/unit/values/text.fixtures.ts"

/** Text validation admits exactly the well-formed NUL-free strings and refuses every planted NUL, lone surrogate and non-string by its fault. Its budget is its suite's before it was a property (test/unit/values/text.test.ts at 4ca3036a): 1000 runs and 1000 steered cases. */
export const textValidationAdmitsExactlyTheWellFormedNULFreeStringsAndRefusesEveryPlantedNULLoneSurrogateAndNonStringByItsFault =
	property.explore(plantedTextGen, {
		needs: {},
		budget: { runs: 1000, steered: 1000 },
		situations: [
			"live",
			"not a string",
			...Arr.flatMap(kinds, (kind) =>
				Arr.map(positions, (position): PlantedFeature => `${kind} ${position}`)
			)
		] satisfies ReadonlyArray<Reached<PlantedFeature>>,
		check: (_, c: Case<PlantedFeature>) => (planted) =>
			Effect.sync(() => {
				c.note(plantedFeature(planted))
				const fault = plantedFault(planted)
				const value = plantedValue(planted)
				const result = validateText(value)
				if (fault !== undefined) {
					faulted(result, fault)
				} else if (typeof value === "string") {
					const admitted: string = succeeded(result)
					assert.equal(admitted, value)
				} else {
					assert.fail("a live planted text is a string")
				}
				assert.equal(isValidText(value), fault === undefined)
			}),
		oracle: {
			kind: "specification",
			name: "the boundary's rule: well-formed NUL-free strings, each plant refused by its fault"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/core/text.ts",
				original:
					'\tif (!isWellFormedText(value)) {\n\t\treturn Result.err("textSurrogate")\n\t}\n',
				replacement: "",
				why: "validateText admits a lone surrogate; the validation property fails."
			}
		]
	})

/** Code point order matches UTF-8 byte order. Its budget is its suite's before it was a property (test/unit/values/text.test.ts at 4ca3036a): 5000 runs and 400 steered cases. */
export const codePointOrderMatchesUTF8ByteOrder = property.explore(
	(source) => [source.draw(text), source.draw(text)] as const,
	{
		needs: { bytesNeed },
		budget: { runs: 5000, steered: 400 },
		situations: [
			"a unit past the surrogates against an astral scalar",
			"one text the other's prefix",
			"equal texts"
		] satisfies ReadonlyArray<Reached<CodePointFeature>>,
		check:
			({ bytesNeed }, c: Case<CodePointFeature>) =>
			([a, b]) =>
				Effect.gen(function* () {
					const bytes = yield* bytesNeed
					return yield* Effect.sync(() => {
						c.noteAll(codePointFeatures(a, b))
						assert.equal(compareCodePoints(a, b), bytes(a, b))
					})
				}),
		oracle: {
			kind: "second-implementation",
			name: "TextEncoder's UTF-8 bytes compared one by one"
		},
		kept: [],
		kills: [
			{
				file: "packages/text/src/text.ts",
				original: "\t\t\treturn codePointRank(x) < codePointRank(y) ? -1 : 1",
				replacement: "\t\t\treturn x < y ? -1 : 1",
				why: "compareCodePoints orders texts by code unit; the code point order property fails."
			}
		]
	}
)

/** Text tuple orders order as their texts' spellings do, each text after its length, and as JSON arrays by code unit and by code point. Its budget is its suite's before it was a property (test/unit/values/text.test.ts at 4ca3036a): 2000 runs and 2000 steered cases. */
export const textTuplesOrderAsJSONArraysByCodeUnitAndByCodePointAndAsIdentitiesByTheirTextsCodePoints =
	property.explore((source) => [source.draw(tuple), source.draw(tuple)] as const, {
		needs: {},
		budget: { runs: 2000, steered: 2000 },
		situations: [
			"equal tuples",
			"one tuple the other's prefix",
			"differing first past the first text",
			"texts of two lengths where they differ",
			"an escaped unit where they differ",
			"a unit past the surrogates against an astral scalar where they differ"
		] satisfies ReadonlyArray<Reached<TupleFeature>>,
		check:
			(_, c: Case<TupleFeature>) =>
			([a, b]) =>
				Effect.sync(() => {
					const differs = Arr.findFirstIndex(a, (x, i) => x !== b[i])
					const at = differs._tag === "Some" ? differs.value : a.length
					const x = a[at]
					const y = b[at]
					if (x === undefined || y === undefined) {
						c.note(a.length === b.length ? "equal tuples" : "one tuple the other's prefix")
					} else {
						if (at > 0) {
							c.note("differing first past the first text")
						}
						if (x.length !== y.length) {
							c.note("texts of two lengths where they differ")
						}
						let unit = 0
						while (unit < x.length && unit < y.length && x[unit] === y[unit]) {
							unit += 1
						}
						if (
							Option.exists(Str.charCodeAt(x, unit), escaped) ||
							Option.exists(Str.charCodeAt(y, unit), escaped)
						) {
							c.note("an escaped unit where they differ")
						}
						if (
							Arr.contains(
								codePointFeatures(x, y),
								"a unit past the surrogates against an astral scalar"
							)
						) {
							c.note("a unit past the surrogates against an astral scalar where they differ")
						}
					}
					assert.equal(
						signOf(compareQuotedTuples(compareStrings)(a, b)),
						signOf(compareStrings(jsonText(a), jsonText(b))),
						"code unit order is the JSON array's"
					)
					assert.equal(
						signOf(compareQuotedTuples(compareCodePoints)(a, b)),
						compareCodePoints(jsonText(a), jsonText(b)),
						"code point order is the JSON array's"
					)
					const idA = textsId(a)
					const idB = textsId(b)
					/** Each tuple spelled as its texts' code points, compared list by list, a list before those it begins. */
					const byCodePoints = Order.Array(Order.Array(Order.Number))(
						Arr.map(a, codePoints),
						Arr.map(b, codePoints)
					)
					assert.equal(
						compareTextsIds(idA, idB),
						byCodePoints,
						"a tuple's identity orders as its texts by code point, text by text"
					)
					assert.equal(
						compareTextLists(a, b),
						byCodePoints,
						"a tuple's texts as they are order as its identity does"
					)
					assert.deepEqual(
						Arr.map(
							inIdentityOrder([idB, idA], (id) => id),
							(id) => id.texts
						),
						byCodePoints <= 0 ? [a, b] : [b, a],
						"a set of identities sorted through its columns stands as its texts by code point"
					)
					const same = jsonText(a) === jsonText(b)
					assert.equal(
						new TextsMap<true>().set(idA, true).has(idB),
						same,
						"two tuples are one identity exactly when they are one"
					)
					assert.ok(!same || idA.digest === idB.digest, "one tuple, one digest")
				}),
		oracle: {
			kind: "second-implementation",
			name: "the tuples spelled by JSON.stringify, then compared"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/core/text.ts",
				original: "\t\t\t\treturn y === undefined ? -1 : 1",
				replacement: "\t\t\t\treturn 1",
				why: "compareQuotedTuples orders a tuple after its own prefix, where a JSON array that goes on (`,`) is below one that ends (`]`); the tuple orders property fails."
			},
			{
				file: "packages/engine/src/core/text.ts",
				original:
					"\tconst text = identities.every((id) => id.belowSurrogates) ? compareStrings : compareCodePoints",
				replacement: "\tconst text = compareStrings",
				why: "A set of identities is sorted by code unit whatever its texts: a scalar past U+FFFF, spelled by a surrogate pair, sorts below a unit from U+E000, where code point order puts it above."
			},
			{
				file: "packages/engine/src/core/text.ts",
				original: "\t\t\tbelowSurrogates &&= code < 0xd800",
				replacement: "\t\t\tbelowSurrogates &&= true",
				why: "Every identity is ordered by code unit: a scalar past U+FFFF, spelled by a surrogate pair, orders below a unit from U+E000, where code point order puts it above."
			}
		]
	})

/** The calls a TextsMap's lookups compare two identities' texts by: exactly in a bucket of one (core/text.ts
 * sameTextsId), in order in a bucket's tree (compareTextsIds). */
const compareSites = Object.freeze({
	compares: { file: "packages/engine/src/core/text.ts", name: "sameTextsId" },
	ordered: { file: "packages/engine/src/core/text.ts", name: "compareTextsIds" }
})

/** How many entries' texts one lookup of `key` in `map` compares with, and what it reads (kernel/calls.ts callCounts). */
const lookupCompares = <V>(map: TextsMap<V>, key: ReadonlyArray<string>) =>
	Effect.map(
		callCounts(
			Effect.sync(() => map.get(textsId(key))),
			compareSites
		),
		([held, counts]) => [held, counts.compares + counts.ordered] as const
	)

/**
 * A TextsMap holds lists whose digests meet apart, and a lookup compares at most its bucket's tree's height of entries,
 * one where its digest is one list's. Over drawn prefixes: two lists of the prefix and a piece made to meet under
 * FNV-1a's public start (text.fixtures.ts collidingLists, its digests textsId's), set beside a third list of the prefix alone, are three entries in the order they were set, each
 * read back with its own value, a list set again keeping its place, and one deleted leaving the other; and a family of
 * four texts of one length past V8's longest hashed text (kernel/long-keys.ts longestHashedText), the prefix and a filler
 * then pieces made to meet under FNV-1a's public start (`collidingFamily`, its digests textsId's), whose first k for k =
 * 2 to 4 set in ascending order are k entries, each read back as itself and the rest of the family held by none. Every
 * lookup of a list or of a member of the family, held or not, compares texts with at most `avlHeight` of its bucket's
 * entries (kernel/calls.ts callCounts), 2 at two, 2 at three, 3 at four, below 1.4405·log₂(k + 2) (core/text.ts
 * BucketNode), so lists made to meet, however long their texts and in whatever order they come, make no lookup compare
 * more. Budget: 4 runs, each three searches of a few hundred units.
 */
export const aTextsMapHoldsListsWhoseDigestsMeetApartAndALookupComparesAtMostItsBucketsHeight =
	property.explore(spelledText, {
		needs: {},
		budget: { runs: 4, steered: 0 },
		situations: [],
		check: () => (prefix) =>
			Effect.gen(function* () {
				const [first, second] = collidingLists(prefix)
				const alone = [prefix]
				assert.equal(textsId(first).digest, textsId(second).digest, "the two lists' digests meet")
				const map = new TextsMap<string>()
					.set(textsId(first), "first")
					.set(textsId(alone), "alone")
					.set(textsId(second), "second")
					.set(textsId([...first]), "first again")
				assert.equal(map.size, 3, "two lists of one digest are two entries")
				assert.deepEqual(
					Arr.map([...map], ([key, value]) => [key.texts, value] as const),
					[
						[first, "first again"],
						[alone, "alone"],
						[second, "second"]
					],
					"in the order they were set, a list set again in its place"
				)
				const [held, pair] = yield* lookupCompares(map, second)
				assert.equal(held, "second", "the second list of a digest read back as itself")
				assert.ok(
					pair <= avlHeight(2),
					`a lookup in a bucket of two compares ${pair} entries, past its tree's height of ${avlHeight(2)}`
				)
				const [, single] = yield* lookupCompares(map, alone)
				assert.ok(single <= avlHeight(1), `a lookup in a bucket of one compares ${single} entries`)
				assert.ok(map.delete(textsId(first)), "a list of the bucket deleted")
				assert.deepEqual(
					[map.size, map.get(textsId(second)), map.has(textsId(first))],
					[2, "second", false],
					"the other list of its digest kept"
				)
				const family = collidingFamily(prefix)
				assert.equal(
					new Set(Arr.map(family, (text) => `${text.length} ${textsId([text]).digest}`)).size,
					1,
					"the family's texts are one length and one digest"
				)
				assert.ok(
					Arr.every(family, (text) => text.length > longestHashedText),
					"past V8's hashed length"
				)
				assert.equal(new Set(family).size, family.length, "the family's texts are distinct")
				for (const k of [2, 3, 4]) {
					const set = Arr.sort(Arr.take(family, k), Order.make(compareCodePoints))
					const members = new TextsMap<string>()
					for (const text of set) {
						members.set(textsId([text]), text)
					}
					assert.equal(members.size, k, `${k} texts of one digest are ${k} entries`)
					for (const text of family) {
						const [found, compares] = yield* lookupCompares(members, [text])
						assert.equal(
							found,
							Arr.contains(set, text) ? text : undefined,
							`a member of the family read back at k = ${k} as itself where it was set, as none where not`
						)
						assert.ok(
							compares <= avlHeight(k),
							`a lookup in a bucket of ${k} set in ascending order compares ${compares} entries, past an AVL tree's height of ${avlHeight(k)}`
						)
					}
				}
			}),
		oracle: { kind: "specification", name: "a map of lists, exact whatever their digests" },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/core/text.ts",
				original:
					'\t"texts" in bucket ? (sameTextsId(bucket, key) ? bucket : undefined) : foundIn(bucket, key)',
				replacement: '\t"texts" in bucket ? bucket : foundIn(bucket, key)',
				why: "A bucket of one trusts the digest alone: the second list of a digest is taken for the first, so the two are one entry."
			},
			{
				file: "packages/engine/src/core/text.ts",
				original:
					'\t"texts" in bucket ? (sameTextsId(bucket, key) ? bucket : undefined) : foundIn(bucket, key)',
				replacement:
					'\t"texts" in bucket ? (sameTextsId(bucket, key) ? bucket : undefined) : bucket.key',
				why: "A bucket of several trusts the digest alone: a lookup of the second list of a digest reads the first's value."
			},
			{
				file: "packages/engine/src/core/text.ts",
				original: "\t\t: balanced(node.key, node.before, insertedIn(node.after, key))",
				replacement: "\t\t: nodeOf(node.key, node.before, insertedIn(node.after, key))",
				why: "A bucket of several is a list where entries come in ascending order: each goes after every entry before it, unbalanced, so the family's k texts set ascending are one chain and a lookup of the last compares k entries, past an AVL tree's height at three and four."
			}
		]
	})

/** The calls a sort through columns makes (core/text.ts inIdentityOrder): its reads of an entry's identity, and its
 * comparisons of two places. */
const columnSortSites = Object.freeze({
	reads: { file: "test/unit/values/text.fixtures.ts", name: "identityOfTuple" },
	compares: { file: "packages/engine/src/core/text.ts", name: "byColumns" },
	checks: { file: "packages/engine/src/core/text.ts", name: "compareTextsIds" }
})

/** What a case of the column sort's property shows. */
type ColumnSorted =
	| "a set out of its order"
	| "a set already in its order"
	| "two entries of one tuple"

/**
 * A set of identities sorted through its columns (core/text.ts inIdentityOrder) stands in its tuples' code point order,
 * text by text, ties in the order given, and reads each entry's identity once and compares at most n⌈log₂ n⌉ + n times:
 * over a drawn set of up to 64 tuples of the tuple space (`tuple`, units the orders branch on, past U+FFFF among them),
 * the sort's reads of an entry's identity (text.fixtures.ts identityOfTuple) are exactly n, and its comparisons, of
 * two identities in the one pass that finds a set already in order (compareTextsIds) and of two places
 * (byColumns), at most that pass's n and a merge sort's n⌈log₂ n⌉
 * (kernel/calls.ts callCounts), so no comparison walks from an entry to its identity and its list, the walk that made a
 * sort of hundreds of thousands of facts most of its cost. Oracle: the tuples sorted by their code points, a second
 * implementation.
 */
export const aSetOfIdentitiesSortedThroughItsColumnsStandsInCodePointOrderReadingEachIdentityOnce =
	property.explore((source) => source.draw(array(tuple, { min: 0, max: 64 })), {
		needs: {},
		budget: { runs: 300, steered: 0 },
		situations: [
			"a set out of its order",
			"a set already in its order",
			"two entries of one tuple"
		] satisfies ReadonlyArray<Reached<ColumnSorted>>,
		check: (_, c: Case<ColumnSorted>) => (tuples) =>
			Effect.gen(function* () {
				const entries: ReadonlyArray<IdentifiedTuple> = Arr.map(tuples, (t) => ({
					tuple: t,
					id: textsId(t)
				}))
				const byCodePoints = Order.mapInput(
					Order.Array(Order.Array(Order.Number)),
					(entry: IdentifiedTuple) => Arr.map(entry.tuple, codePoints)
				)
				const [sorted, counts] = yield* callCounts(
					Effect.sync(() => inIdentityOrder(entries, identityOfTuple)),
					columnSortSites
				)
				assert.deepEqual(
					Arr.map(sorted, (e) => e.tuple),
					Arr.map(Arr.sort(entries, byCodePoints), (e) => e.tuple),
					"the set stands in its tuples' code point order, ties as given"
				)
				const n = entries.length
				assert.equal(counts.reads, n, "each entry's identity read once")
				const compares = counts.compares + counts.checks
				assert.ok(
					compares <= n * Math.ceil(Math.log2(Math.max(n, 1))) + n,
					`${compares} comparisons of ${n} entries, past n⌈log₂ n⌉ + n`
				)
				c.note(
					Arr.every(sorted, (e, at) => e === entries[at])
						? "a set already in its order"
						: "a set out of its order"
				)
				if (new Set(Arr.map(tuples, jsonText)).size < tuples.length) {
					c.note("two entries of one tuple")
				}
			}),
		oracle: { kind: "second-implementation", name: "the tuples sorted by their code points" },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/core/text.ts",
				original:
					'\tplaces.sort(byColumns)\n\treturn places.map((at) => defined(entries[at], "an entry at its place"))',
				replacement:
					"\treturn sortInPlace([...entries], (a, b) => compareTextsIds(identityOf(a), identityOf(b)))",
				why: "The sort compares entries by walking each to its identity and its list, as normalFacts sorted before: each comparison reads two identities, so a set of n entries reads them about 2n log₂ n times past its n."
			}
		]
	})
