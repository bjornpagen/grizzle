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
			original: 'case "AdditionalProperties":\n\t\t\treturn Effect.succeed("unknown-key")',
			replacement:
				'case "AdditionalProperties":\n\t\t\treturn Effect.succeed("invalid-field-pointer")',
			why: "A key no object of the config declares is refused as a field pointer off its pattern, so an unknown key is refused under the wrong rule; the property fails (CATCH's evidence, mutant 19223c25f8)."
		},
		{
			file: "packages/cli-generator/src/model/author-config.ts",
			original: 'keyWhere(Str.isNonEmpty, "unknown-key"),\n\t\t\t\t\tcredentialVariable',
			replacement:
				'keyWhere((name) => name === "add", "unknown-key"),\n\t\t\t\t\tcredentialVariable',
			why: "A security scheme's name is admitted only when it is `add`, so a config naming a scheme's environment variable is refused; the property fails (CATCH's evidence, mutant 7195dc3ec1)."
		},
		{
			file: "packages/cli-generator/src/model/author-config.ts",
			original: 'reason: because("missing-bin-name")',
			replacement: 'reason: because("invalid-bin-name")',
			why: "A missing bin name is refused as an invalid one; the property fails (CATCH's evidence, mutant 949f80d319)."
		},
		{
			file: "packages/cli-generator/src/model/author-config.ts",
			original: "pointer: formatPointer(Arr.map(issue.path, String))",
			replacement: "pointer: formatPointer(Arr.map(Arr.takeRight(issue.path, 1), String))",
			why: "A refusal keeps only the last token of its place, so a refusal under package, naming or nonStandard points at the wrong place; the property fails (CATCH's evidence, mutant e1304fd8c3)."
		},
		{
			file: "packages/cli-generator/src/model/author-config.ts",
			original: "onSome: Effect.succeed\n\t\t\t\t}",
			replacement: 'onSome: () => Effect.succeed("invalid-bin-name")\n\t\t\t\t}',
			why: "Every refusal a reader words is named for the bin name, so a refusal of a version, a flag or a commands module is named for the bin name; the property fails (CATCH's evidence, mutant ac1ffde917)."
		},
		{
			file: "packages/cli-generator/src/model/author-config.ts",
			original: 'assertPatterns: optionalMember(object, "assertPatterns", unsupported),',
			replacement: "",
			why: "assertPatterns is read as a key the config does not define, so it is refused as unknown where the design names it as unsupported; the property fails."
		}
	]
})
