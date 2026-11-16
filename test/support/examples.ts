import type { Examples } from "@bjornpagen/testing/vitest/reporter"

/**
 * The files whose test cases may run no search, each set with its reason, by the test tier that runs them: the testing
 * library's reporter fails every other passing test case that ran none (defineTestConfig's examples). A path is
 * relative to the repository root, the Vitest root of every config that names it; one ending in "/" names a directory.
 */
type Exemption = Extract<Examples, { readonly kind: "banned" }>["exempt"][number]

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

/** `pnpm test`'s exemptions: the unit tier's files among them. */
export const unitExamples: Examples = { kind: "banned", exempt: [consumerGate] }

/** `pnpm test:network`'s exemptions: the pg and schedules tiers' files among them. */
export const networkExamples: Examples = { kind: "banned", exempt: [performanceGates] }
