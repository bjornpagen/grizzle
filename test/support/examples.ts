import type { Examples } from "@bjornpagen/testing/vitest/reporter"

/**
 * The files whose test cases may run no search, each set with its reason, by the test tier that runs them: the testing
 * library's reporter fails every other passing test case that ran none (defineTestConfig's examples). A path is
 * relative to the repository root, the Vitest root of every config that names it; one ending in "/" names a directory.
 */
type Exemption = Extract<Examples, { readonly kind: "banned" }>["exempt"][number]

/** The README's and SKILL.md's mirror. */
const documentationMirror: Exemption = {
	files: ["test/types/examples/blocks.test.ts", "test/types/examples/examples.test.ts"],
	reason:
		"The README's and SKILL.md's mirror: blocks.test.ts holds every documented block to its mirrored fixture, and examples.test.ts typechecks those fixtures and fails each refusal the README states with exactly the diagnostic it names, so the documentation is checked code; its blocks are the documentation, never inputs a person chose to test."
}

/** The submodule-consumer gate. */
const consumerGate: Exemption = {
	files: ["test/unit/dev/package.test.ts"],
	reason:
		"The submodule-consumer gate: the README's and SKILL.md's mirrored programs, the one sanctioned example code, typecheck as a consumer's against the package's source reached through its exports, so the source checks under a consumer's tsconfig and no type the README states is any."
}

/** The performance gates. */
const performanceGates: Exemption = {
	files: ["test/pg/bench/"],
	reason:
		"The performance gates: each measures a workload against its gate, a performance property, never a verdict a person wrote."
}

/** The type batch's population runners. */
const typeBatchRunners: Exemption = {
	files: [
		"test/types/api/access.test.ts",
		"test/types/api/config.test.ts",
		"test/types/api/decoder.test.ts",
		"test/types/api/handle.test.ts",
		"test/types/api/recursion.test.ts",
		"test/types/api/surface.test.ts",
		"test/types/api/untyped.test.ts",
		"test/types/api/workload.test.ts",
		"test/types/changeset/changeset.test.ts",
		"test/types/changeset/delete-where.test.ts",
		"test/types/changeset/entry-owner.test.ts",
		"test/types/changeset/nesting.test.ts",
		"test/types/compute/compute.test.ts",
		"test/types/evidence/agreement.test.ts",
		"test/types/evidence/attachments.test.ts",
		"test/types/evidence/parameter.test.ts",
		"test/types/executor/boundary.test.ts",
		"test/types/harness/harness.test.ts",
		"test/types/ir/semi-join.test.ts",
		"test/types/regex/agreement.test.ts",
		"test/types/schema/agreement.test.ts",
		"test/types/schema/generic.test.ts",
		"test/types/text/bytes.test.ts",
		"test/types/text/regex.test.ts"
	],
	reason:
		"The type batch's population runners: the population is drawn by the testing library's generators, or exhausts a box the source's own rosters define, and is printed as one program the batch typechecks at once, so no case can run a search per program; each case checks the drawn population against the engine as oracle, or that its floor's witnesses reach every requirement."
}

/** The type layer's cost gates. */
const typeCostGates: Exemption = {
	files: [
		"test/types/changeset/budget/members.test.ts",
		"test/types/query/budget/invariance.test.ts",
		"test/types/query/budget/scaling.test.ts",
		"test/types/regex/scaling.test.ts",
		"test/types/schema/budget/families.test.ts",
		"test/types/schema/budget/extension.test.ts",
		"test/types/schema/budget/invariance.test.ts",
		"test/types/schema/budget/logins.test.ts",
		"test/types/schema/budget/roles.test.ts",
		"test/types/schema/budget/scaling.test.ts",
		"test/types/skeleton/budget/invariance.test.ts"
	],
	reason:
		"The type layer's cost gates: each typechecks programs generated at three sizes an equal step apart and holds their types and instantiations to grow no faster than linearly, the second step adding no more than the first (test/support/growth.ts), a performance property; or holds the largest program's inference and refusals to its twin's, the same declarations at the smallest scale its probes read; or holds the instantiations a ChangeSet's members add to be the same over a small schema and a large one (changeset/budget/members.test.ts), and those an extension's derived relations and its laws over them add to be the same over a small base and a large one (schema/budget/extension.test.ts), as those a full role adds for each derived relation of its level and each law over one (schema/budget/roles.test.ts). No verdict is one a person wrote."
}

/** `pnpm test`'s exemptions: the unit and type tiers' files among them. */
export const unitExamples: Examples = {
	kind: "banned",
	exempt: [documentationMirror, consumerGate, typeBatchRunners, typeCostGates]
}

/** `pnpm test:network`'s exemptions: the pg and schedules tiers' files among them. */
export const networkExamples: Examples = { kind: "banned", exempt: [performanceGates] }
