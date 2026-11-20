/**
 * The names plan (names/index.ts) over normalized APIs drawn from the names that collide, fold alike or take a name the
 * generated modules hold: operation ids and routes, tags with parent chains, path, query and header parameters,
 * JSON, multipart and binary bodies over component schemas, and author configs that rename, skip or name an operation
 * that is not there, strict or not. Every plan keeps design 4.4's laws: each operation is one command, or refused at
 * operation scope, or skipped with a notice; command names and identifiers are unique in their module and none is a
 * reserved word, a name its module holds (the package imports, runtime namespaces and `cli/root.ts` bindings) or another
 * command's family member; an identifier is suffixed only when its fold is taken and then OPR-06/renamed is reported, a
 * group namespace likewise with TAG-02/renamed, and no namespace is a domain name its own commands import; segments are
 * safe and none is root, servers or security; a command's flags, their negations and its positionals are unique and none
 * reserved; every imported domain name is exported by domain/schemas.ts; and an override matching nothing is reported,
 * a refusal under --strict.
 */
import { assert } from "@bjornpagen/testing/assert"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	brokenLawsOf,
	type Feature,
	featuresOf,
	planOf,
	planSpace
} from "#test/names/plan.fixtures.ts"

/**
 * A drawn API's plan keeps every law. Its budget replaces 49 example cases (plan 45, reserved 4): 49 independent cases,
 * and up to 28 steered while one of its 14 situations is unreached, each reached by its own aimed arm.
 */
export const namePlan = property.explore(planSpace, {
	needs: {},
	situations: [
		"a command collision refused",
		"a group collision refused",
		"an empty name refused",
		"a reserved segment refused",
		"a flag collision refused",
		"an identifier suffixed",
		"a namespace suffixed",
		"a root binding avoided",
		"a parent chain nested",
		"a renamed command",
		"a skipped operation",
		"an unmatched override",
		"a multipart body's schema import",
		"a positional and a boolean flag"
	],
	check: (_, k: Case<Feature>) => (c) =>
		Effect.gen(function* () {
			const planned = yield* planOf(c)
			k.noteAll(featuresOf(planned.plan))
			assert.deepEqual(brokenLawsOf(c, planned), [])
		}),
	oracle: {
		kind: "universal",
		name: "design 4.4's laws: accounting, uniqueness, held names, suffixes only when taken and noticed, exported imports"
	},
	kept: [
		{
			token: ReplayToken("test/names/plan.test.ts#namePlan:-:1.0.0.0.0.1.2.0.1.0.0.1.1.0.0.0"),
			reason:
				"a group's command whose identifier folds to `group`, the command its module exports: it is suffixed, as the group module holds the name, where the laws held the name for no module and called the suffix one for nothing (found by the push gate's rotating stream at TEST_SEED=3990536058)",
			since: "2026-11-19"
		}
	],
	budget: { runs: 49, steered: 28 },
	kills: [
		{
			file: "packages/cli-generator/src/names/index.ts",
			original:
				"new Set([...fixedNamespaces, ...groupModuleNames, namespace, ...imported, ...foreign]),",
			replacement: "new Set([...fixedNamespaces, namespace, ...imported, ...foreign]),",
			why: "A group's command keeps the identifier `group`, which its module exports as its group command, so the module declares it twice; the property fails."
		},
		{
			file: "packages/cli-generator/src/names/index.ts",
			original:
				"\t\tconst identifier = used(base.name) ? toIdentifier(suffixed(base.name, clash)) : base.name\n\t\tif (identifier !== base.name) {\n\t\t\tfor (const member of familyOf(identifier)) {",
			replacement:
				"\t\tconst identifier = used(base.name) ? toIdentifier(suffixed(base.name, clash)) : base.name\n\t\tif (identifier === base.name) {\n\t\t\tfor (const member of familyOf(identifier)) {",
			why: "A command identifier is suffixed when its fold is free and kept when it is taken, so two commands share an identifier or one is renamed for nothing; the property fails (CATCH's evidence, mutant 557cb2426e)."
		},
		{
			file: "packages/cli-generator/src/names/index.ts",
			original: "planned.set(node, namespace)",
			replacement: "{}",
			why: "No group gets its planned namespace, so planning any tagged operation fails; the property fails (CATCH's evidence, mutant e6388e44a5)."
		},
		{
			file: "packages/cli-generator/src/model/entities.ts",
			original:
				'[\n\t"cookie",\n\t"deepObject",\n\t"form",\n\t"label",\n\t"matrix",\n\t"pipeDelimited",\n\t"simple",\n\t"spaceDelimited"\n]',
			replacement:
				'["cookie", "deepObject", "label", "matrix", "pipeDelimited", "simple", "spaceDelimited"]',
			why: "The form style is no style the model admits, so an API with a query parameter no longer decodes; the property fails (CATCH's evidence, mutant 85f71acc09)."
		},
		{
			file: "packages/cli-generator/src/names/index.ts",
			original: '\t\t\t\t\t\talternative.codec !== "multipart")',
			replacement: '\t\t\t\t\t\talternative.codec === "multipart")',
			why: "A group's commands import every body schema but their multipart ones, so a group namespace may take the name of a multipart body's schema its own module imports; the property fails (CATCH's evidence, mutant 6338b80dc2)."
		},
		{
			file: "packages/cli-generator/src/emit/domain.ts",
			original: "\t\treturn !this.failed && this.position >= this.tokens.length",
			replacement: "\t\treturn this.failed && this.position >= this.tokens.length",
			why: "The domain emitter reads every printed schema as failed, so an imported domain name is not exported; the property fails (CATCH's evidence, mutant 4ea4629990)."
		},
		{
			file: "packages/cli-generator/src/names/index.ts",
			original: "byName.get(entry.container) ?? new Map<string, Named[]>()",
			replacement: "byName.get(entry.container)",
			why: "Commands are tallied by name into a container that was never made, so planning any operation fails; the property fails (CATCH's evidence, mutant eee6e19c02)."
		},
		{
			file: "packages/cli-generator/src/names/index.ts",
			original:
				'\tconst imported = domainNames(entries, domain)\n\tif (first !== undefined) {\n\t\tcollector.folded(first.operation, "TAG-02", "Tag", first.tagPointer, node.notes)',
			replacement:
				'\tconst imported = domainNames(entries, domain)\n\tif (first === undefined) {\n\t\tcollector.folded(first.operation, "TAG-02", "Tag", first.tagPointer, node.notes)',
			why: "A group's TAG-02 notices are reported only when it has no first operation, so a renamed namespace goes unnoticed; the property fails (CATCH's evidence, mutant 72955079dd)."
		}
	]
})
