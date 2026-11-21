import { Array as Arr } from "effect"
import type { Law, BrokenLaws, RefusedLaw } from "#compiler/types/changeset/changeset.ts"

/**
 * Every law a refusal names with its identity and object, in the refusal's order: an above refusal's laws of the levels
 * above first, then, where its `own` is `every`, its own; any other refusal's laws.
 */
export const refusedEntries = (refused: BrokenLaws): Arr.NonEmptyReadonlyArray<RefusedLaw<Law>> =>
	refused.kind === "above"
		? refused.own === "every"
			? [...refused.above, ...refused.laws]
			: refused.above
		: refused.laws

/**
 * The laws a refusal names, each as the schema states it, in the refusal's order (refusedEntries): what a test reads
 * that compares the laws a write broke, not the identities and installed objects the refusal names beside them.
 */
export const refusedLaws = (refused: BrokenLaws): Arr.NonEmptyReadonlyArray<Law> =>
	Arr.map(refusedEntries(refused), (r) => r.law)
