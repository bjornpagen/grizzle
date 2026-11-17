/**
 * The author config's decoder (design 4.8, D-AD11): a config of every documented key, each optional one present or
 * not, decodes and encodes back to itself; a config with faults planted in its members (a bin name missing, off its
 * pattern or no string; a package version off semver 2.0.0 or missing; an unknown or unsupported key at any depth; a
 * commands module outside the package; a wrongly typed value; a naming override's field pointer, field flag or alias
 * entry; a non-standard switch; a root that is no object) is refused with exactly one CFG-1 document refusal per fault,
 * at the fault's own pointer, in pointer order, each echoing no value it refuses and hinting the folded title only for
 * a missing bin name.
 */
import { deepStrictEqual } from "@bjornpagen/testing/assert"
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
 * A drawn config decodes to itself, or is refused exactly as its planted faults say. Its budget replaces 31 example
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
			deepStrictEqual(actual, expectedOf(c))
		}),
	oracle: {
		kind: "specification",
		name: "the config itself, or one CFG-1 document refusal per planted fault at its pointer, in pointer order"
	},
	kept: [],
	budget: { runs: 31, steered: 32 },
	kills: [
		{
			file: "packages/generator/src/model/author-config.ts",
			original: 'part !== "" && part !== "." && part !== ".."',
			replacement: "false",
			why: "A commands module's segments are never plain, so every commands module is refused as unsafe; the property fails (CATCH's evidence, mutant 84169df5f6)."
		},
		{
			file: "packages/generator/src/model/author-config.ts",
			original: 'group.split(".").every((segment) => segment !== "")',
			replacement: "false",
			why: "A dotted alias group is never admitted, so a config whose alias names a group as a string is refused; the property fails (CATCH's evidence, mutant 851028c2ce)."
		},
		{
			file: "packages/generator/src/model/author-config.ts",
			original:
				"Effect.forEach(findings(issue, []), (finding) => diagnose(finding, context)).pipe(\n\t\tEffect.map(\n\t\t\t(diagnostics) =>\n\t\t\t\tnew AuthorConfigRefused({\n\t\t\t\t\tdiagnostics: sortDiagnostics(\n\t\t\t\t\t\t[context.document],\n\t\t\t\t\t\tArr.dedupeWith(\n\t\t\t\t\t\t\tdiagnostics,\n\t\t\t\t\t\t\t(left, right) => left.pointer === right.pointer && left.code === right.code\n\t\t\t\t\t\t)\n\t\t\t\t\t)\n\t\t\t\t})\n\t\t)\n\t)",
			replacement: "Effect.forEach(findings(issue, []), (finding) => diagnose(finding, context))",
			why: "The refusals are neither ordered by pointer nor deduplicated, so several refusals come in the decoder's order; the property fails (CATCH's evidence, mutant 161e92aabd)."
		},
		{
			file: "packages/generator/src/model/author-config.ts",
			original: 'isField(path, 5) && kind === "unknown"',
			replacement: 'kind === "unknown"',
			why: "Every unknown key is read as a field pointer off its pattern, so an unknown key is refused under the wrong rule; the property fails (CATCH's evidence, mutant 19223c25f8)."
		},
		{
			file: "packages/generator/src/model/author-config.ts",
			original: '\t\t\t\t\tSchema.check(Schema.makeFilter((name: string) => name !== "add"))',
			replacement: '\t\t\t\t\tSchema.check(Schema.makeFilter((name: string) => name === "add"))',
			why: "A security scheme's name is admitted only when it is `add`, so a config naming a scheme's environment variable is refused; the property fails (CATCH's evidence, mutant 7195dc3ec1)."
		},
		{
			file: "packages/generator/src/model/author-config.ts",
			original: '\t\treturn kind === "missing" ? "missing-bin-name" : "invalid-bin-name"',
			replacement: '\t\treturn kind !== "missing" ? "missing-bin-name" : "invalid-bin-name"',
			why: "A missing bin name is refused as invalid and an invalid one as missing; the property fails (CATCH's evidence, mutant 949f80d319)."
		},
		{
			file: "packages/generator/src/model/author-config.ts",
			original: "[...path, ...pointer.path.map(String)]",
			replacement: "[...pointer.path.map(String)]",
			why: "A nested finding loses the tokens above it, so a refusal under package, naming or nonStandard points at the wrong place; the property fails (CATCH's evidence, mutant e1304fd8c3)."
		},
		{
			file: "packages/generator/src/model/author-config.ts",
			original: 'path.length === 1 && path[0] === "binName"',
			replacement: "true",
			why: "Every finding is read as the bin name's, so any refusal is named for the bin name; the property fails (CATCH's evidence, mutant ac1ffde917)."
		}
	]
})
