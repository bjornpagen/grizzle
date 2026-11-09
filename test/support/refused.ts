import { Array as Arr } from "effect"
import type { Law, Refused } from "#compiler/types/changeset/changeset.ts"

/**
 * The laws a refusal names, each as the schema states it, in the refusal's order: what a test reads that compares the
 * laws a write broke, not the identities and installed objects the refusal names beside them.
 */
export const refusedLaws = (refused: Refused): Arr.NonEmptyReadonlyArray<Law> =>
	Arr.map(refused.laws, (r) => r.law)
