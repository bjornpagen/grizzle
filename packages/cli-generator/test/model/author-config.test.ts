/**
 * The author config's reader (design 4.8, D-AD11): a config of every documented key, each optional one present or
 * not, reads to itself, its `security`'s credentials apart from `add`; a config with faults planted in its members (a
 * bin name missing, off its pattern or no string; a package version off semver 2.0.0 or missing; an unknown or
 * unsupported key at any depth; a commands module outside the package; a wrongly typed value; a naming override's
 * field pointer, field flag or alias entry; a non-standard switch; a root that is no object) is refused with exactly
 * one CFG-1 document refusal per fault, at the fault's own pointer, in pointer order, each echoing no value it refuses
 * and hinting the folded title only for a missing bin name.
 */
import { assert } from "@bjornpagen/testing/assert"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	actualOf,
	configSpace,
	expectedOf,
	type Feature,
	featuresOf
} from "#test/model/author-config.fixtures.ts"

/**
 * A drawn config reads to itself, or is refused exactly as its planted faults say. Its budget replaces 31 example
 * cases (author-config 21, author-config-aliases 5, author-config-non-standard 5): 31 independent cases, and up to 32
 * steered while one of its 16 situations is unreached, each reached by its own aimed arm.
 */
export const authorConfig = property.explore(configSpace, {
	needs: {},
	situations: [
		"a valid config",
		"a missing bin name",
		"an invalid bin name",
		"an unsafe commands module",
		"an unsupported key",
		"an unknown key",
		"a missing key",
		"an invalid version",
		"an invalid value",
		"an invalid field pointer",
		"an invalid field flag",
		"an alias refused",
		"a key escaped in its pointer",
		"a value at the root that is no object",
		"several refusals in pointer order",
		"a hint naming the folded title"
	],
	check: (_, k: Case<Feature>) => (c) =>
		Effect.gen(function* () {
			k.noteAll(featuresOf(c))
			const actual = yield* actualOf(c)
			assert.deepEqual(actual, expectedOf(c))
		}),
	oracle: {
		kind: "specification",
		name: "the config itself, its security's credentials apart from add, or one CFG-1 document refusal per planted fault at its pointer, in pointer order"
	},
	kept: [],
	budget: { runs: 31, steered: 32 },
	kills: [
		{
			file: "packages/cli-generator/src/model/author-config.ts",
			original: 'part !== "" && part !== "." && part !== ".."',
			replacement: "false",
			why: "A commands module's segments are never plain, so every commands module is refused as unsafe; the property fails (CATCH's evidence, mutant 84169df5f6)."
		},
		{
			file: "packages/cli-generator/src/model/author-config.ts",
			original: 'Arr.every(Str.split(group, "."), Str.isNonEmpty)',
			replacement: "false",
			why: "A dotted alias group is never admitted, so a config whose alias names a group as a string is refused; the property fails (CATCH's evidence, mutant 851028c2ce)."
		},
		{
			file: "packages/cli-generator/src/model/author-config.ts",
			original: "sortDiagnostics([context.document], diagnostics)",
			replacement: "diagnostics",
			why: "The refusals are not ordered by pointer, so several refusals come in the order the reader meets them; the property fails (CATCH's evidence, mutant 161e92aabd)."
		},
		{
			file: "packages/cli-generator/src/model/author-config.ts",
			original: 'const unknownKey = (): Rule => "unknown-key"',
			replacement: 'const unknownKey = (): Rule => "invalid-field-pointer"',
			why: "An unknown key of an object the config declares is refused as a field pointer off its pattern, so it is refused under the wrong rule; the property fails (CATCH's evidence, mutant 19223c25f8)."
		},
		{
			file: "packages/cli-generator/src/model/author-config.ts",
			original: 'mapOf(Str.isNonEmpty, "unknown-key", credentialVariable)',
			replacement: 'mapOf((name) => name === "add", "unknown-key", credentialVariable)',
			why: "A security scheme's name is admitted only when it is `add`, so a config naming a scheme's environment variable is refused; the property fails (CATCH's evidence, mutant 7195dc3ec1)."
		},
		{
			file: "packages/cli-generator/src/model/author-config.ts",
			original:
				'\t\t\t\t\tmatching(binNamePattern, "invalid-bin-name"),\n\t\t\t\t\t"missing-bin-name"',
			replacement:
				'\t\t\t\t\tmatching(binNamePattern, "missing-bin-name"),\n\t\t\t\t\t"invalid-bin-name"',
			why: "A missing bin name is refused as invalid and an invalid one as missing; the property fails (CATCH's evidence, mutant 949f80d319)."
		},
		{
			file: "packages/cli-generator/src/model/author-config.ts",
			original: "onSome: (member) => read(member, [...path, key], refuse)",
			replacement: "onSome: (member) => read(member, [key], refuse)",
			why: "A required member is read without the tokens above it, so a refusal under package points at the wrong place; the property fails (CATCH's evidence, mutant e1304fd8c3)."
		},
		{
			file: "packages/cli-generator/src/model/author-config.ts",
			original: "admits(value) ? Option.some(value) : refuse(rule, path)",
			replacement: 'admits(value) ? Option.some(value) : refuse("invalid-bin-name", path)',
			why: "Every refused string is refused as the bin name, so a refusal of a version, a flag or a commands module is named for the bin name; the property fails (CATCH's evidence, mutant ac1ffde917)."
		},
		{
			file: "packages/cli-generator/src/model/author-config.ts",
			original:
				"const members = read(value, path, refuse)\n\n\t\treturn Option.flatMap(Option.all(strays), () => members)",
			replacement: "return Option.flatMap(Option.all(strays), () => read(value, path, refuse))",
			why: "An object holding a key it does not declare has its members left unread, so a missing bin name beside an unknown key goes unreported; the property fails."
		}
	]
})
