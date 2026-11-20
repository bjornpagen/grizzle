/**
 * Design 4.4's folds (names/fold.ts) over names built from pieces of every class they decide on: words of each case,
 * digits, separators, marks NFKD splits off, compatibility characters it decomposes, non-ASCII letters, controls, bidi
 * overrides, emoji, reserved words and Windows device names. The kebab, camel and Pascal folds and the file-segment fold
 * give exactly what a model written as a walk over code points gives (the word split, the `n` prefix on a leading digit,
 * the `_` suffix on a reserved word, a device name or a segment over 64 characters refused), every refusal of an empty
 * fold included; a kebab name folds to itself, an identifier is a SafeIdentifier and a segment a SafeFileSegment; and
 * those two brands admit exactly the raw names design 4.4 does. The domain module's export names are design 4.4's too.
 */
import { assert } from "@bjornpagen/testing/assert"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	actualDomainOf,
	actualOf,
	type DomainFeature,
	domainFeaturesOf,
	domainSpace,
	expectedDomainOf,
	expectedOf,
	type Feature,
	featuresOf,
	foldSpace
} from "#test/names/fold.fixtures.ts"

/**
 * A drawn name folds as the model does, its laws hold and the brands agree. Its budget replaces 17 example cases: 17
 * independent cases, and up to 38 steered while one of its 19 situations is unreached, each reached by its own aimed arm.
 */
export const foldLaws = property.explore(foldSpace, {
	needs: {},
	situations: [
		"a kebab fold",
		"a camel fold",
		"a pascal fold",
		"a segment fold",
		"an empty kebab fold refused",
		"an empty camel fold refused",
		"an empty pascal fold refused",
		"an empty segment fold refused",
		"a leading digit prefixed",
		"a reserved word suffixed",
		"a named device refused",
		"a COM port refused",
		"an LPT port refused",
		"a segment over 64 characters refused",
		"a mark dropped",
		"a compatibility character decomposed",
		"a lower-to-upper boundary split",
		"a reserved word as a raw identifier",
		"a device name as a raw segment"
	],
	check: (_, k: Case<Feature>) => (c) =>
		Effect.sync(() => {
			k.noteAll(featuresOf(c))
			assert.deepEqual(actualOf(c), expectedOf(c))
		}),
	oracle: {
		kind: "second-implementation",
		name: "design 4.4's folds as a walk over NFKD code points, and the brands' patterns and reserved sets"
	},
	kept: [],
	budget: { runs: 17, steered: 38 },
	kills: [
		{
			file: "packages/cli-generator/src/names/fold.ts",
			original:
				"export const foldKebab = (input: string): Result.Result<Folded<string>, EmptyFold> => {\n\tconst parts = words(input)\n\tif (parts.length === 0) {\n\t\treturn Result.fail(EmptyFold.make({ input }))\n\t}",
			replacement:
				"export const foldKebab = (input: string): Result.Result<Folded<string>, EmptyFold> => {\n\tconst parts = words(input)\n\tif (parts.length !== 0) {\n\t\treturn Result.fail(EmptyFold.make({ input }))\n\t}",
			why: "foldKebab refuses every name with a word and folds an empty one, so every flag and command fold fails; the property fails (CATCH's evidence, mutant 077846b20e)."
		},
		{
			file: "packages/cli-generator/src/names/fold.ts",
			original:
				"export const foldKebab = (input: string): Result.Result<Folded<string>, EmptyFold> => {\n\tconst parts = words(input)\n\tif (parts.length === 0) {\n\t\treturn Result.fail(EmptyFold.make({ input }))\n\t}",
			replacement:
				"export const foldKebab = (input: string): Result.Result<Folded<string>, EmptyFold> => {\n\tconst parts = words(input)\n\tif (parts.length === 1) {\n\t\treturn Result.fail(EmptyFold.make({ input }))\n\t}",
			why: "foldKebab refuses a name of exactly one word as empty; the property fails (CATCH's evidence, mutant 00af26c2eb)."
		},
		{
			file: "packages/cli-generator/src/names/fold.ts",
			original:
				"): Result.Result<Folded<SafeIdentifierValue>, EmptyFold> => {\n\tconst parts = words(input)\n\tif (parts.length === 0) {\n\t\treturn Result.fail(EmptyFold.make({ input }))\n\t}",
			replacement:
				"): Result.Result<Folded<SafeIdentifierValue>, EmptyFold> => {\n\tconst parts = words(input)\n\tif (parts.length === 1) {\n\t\treturn Result.fail(EmptyFold.make({ input }))\n\t}",
			why: "foldIdentifier refuses a name of exactly one word as empty; the property fails (CATCH's evidence, mutant 6c0ab40c00)."
		},
		{
			file: "packages/cli-generator/src/names/fold.ts",
			original: "!reservedIdentifiers.has(joined)",
			replacement: "reservedIdentifiers.has(joined)",
			why: "foldIdentifier suffixes every identifier but the reserved words, which it leaves bare; the property fails (CATCH's evidence, mutant 09a8a2413f)."
		},
		{
			file: "packages/cli-generator/src/names/fold.ts",
			original: "!isDeviceName(value)",
			replacement: "isDeviceName(value)",
			why: "SafeFileSegment admits only Windows device names, so every ordinary segment is refused; the property fails (CATCH's evidence, mutant db96ab03ef)."
		},
		{
			file: "packages/cli-generator/src/names/reserved.ts",
			original: "(_, digit) => `LPT",
			replacement: "(_, digit) => `COM",
			why: "The device names lose LPT0 to LPT9, so a group folding to lpt9 becomes a file Windows cannot open; the property fails (CATCH's evidence, mutant 44fed36e5e)."
		},
		{
			file: "packages/cli-generator/src/names/fold.ts",
			original:
				'Schema.String.pipe(\n\tSchema.check(\n\t\tSchema.makeFilter((value: string) => segmentPattern.test(value) && !isDeviceName(value))\n\t),\n\tSchema.brand("SafeFileSegment")\n)',
			replacement: 'Schema.String.pipe(Schema.brand("SafeFileSegment"))',
			why: "SafeFileSegment checks neither pattern nor device names, so a segment over 64 characters is admitted; the property fails (CATCH's evidence, mutant 1208fb9e15)."
		},
		{
			file: "packages/cli-generator/src/names/fold.ts",
			original: "identifierPattern.test(value) && !reservedIdentifiers.has(value)",
			replacement: "identifierPattern.test(value)",
			why: "SafeIdentifier admits reserved words, so `class` is a generated identifier; the property fails (CATCH's evidence, mutant 5cab5d3c28)."
		},
		{
			file: "packages/cli-generator/src/names/fold.ts",
			original: "identifierPattern.test(value) && !reservedIdentifiers.has(value)",
			replacement: "false",
			why: "SafeIdentifier admits nothing, so every identifier fold dies minting its brand; the property fails (CATCH's evidence, mutant 23ad1f75eb)."
		},
		{
			file: "packages/cli-generator/src/names/fold.ts",
			original:
				'if (casing === "kebab") {\n\t\treturn Arr.join(Arr.map(parts, Str.toLowerCase), "-")\n\t}',
			replacement: "{}",
			why: "The kebab fold joins words as Pascal case, so flags and commands lose their dashes and case; the property fails (CATCH's evidence, mutant 4a790ad7ca)."
		},
		{
			file: "packages/cli-generator/src/names/fold.ts",
			original: "!Schema.is(SafeFileSegment)(segment)",
			replacement: "Schema.is(SafeFileSegment)(segment)",
			why: "foldFileSegment refuses every segment its brand admits and admits the rest; the property fails (CATCH's evidence, mutant f1535863a0)."
		}
	]
})

/**
 * The domain module's export names (names/domain.ts) are design 4.4's: every schema key once, in code-point order, its
 * Pascal fold (Definition for a key with nothing to fold), a fold the cli modules hold (their package imports, runtime
 * namespaces and `cli/root.ts` bindings) or already taken getting the first free numeric suffix from 2, the same
 * whatever order the keys come in. Its budget replaces 8 example cases: 8 independent cases, and up to 12 steered while
 * one of its 6 situations is unreached, each reached by its own aimed arm.
 */
export const domainNames = property.explore(domainSpace, {
	needs: {},
	situations: [
		"keys folding alike",
		"a held name",
		"a reserved word",
		"a key with nothing to fold",
		"an inline pointer key",
		"a suffixed name already taken"
	],
	check: (_, k: Case<DomainFeature>) => (keys) =>
		Effect.sync(() => {
			k.noteAll(domainFeaturesOf(keys))
			const expected = expectedDomainOf(keys)
			assert.deepEqual(actualDomainOf(keys), [expected, expected])
		}),
	oracle: {
		kind: "second-implementation",
		name: "design 4.4's Pascal fold, held names from the emitter's own lists, suffixes from 2 in code-point order"
	},
	kept: [],
	budget: { runs: 8, steered: 12 },
	kills: [
		{
			file: "packages/cli-generator/src/names/domain.ts",
			original: "reserved.has(candidate) || assigned.has(candidate)",
			replacement: "reserved.has(candidate)",
			why: "A name another key already took is not taken, so two keys folding alike export one name twice; the property fails (CATCH's evidence, mutant 9e29cbf5de)."
		}
	]
})
