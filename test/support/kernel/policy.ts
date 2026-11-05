import { type Gen, production } from "@grizzle/testing/gen"
import type { Array as Arr } from "effect"

/**
 * A limit: production's constant five times in six, otherwise one of the small values.
 *
 * Limits drawn per case, passed to the function that decides them.
 *
 * Grizzle's thresholds (core/policy.ts) are plain constants, and no test may depend on their values. A test of a
 * decision a threshold drives calls the deciding function with a limit drawn here, through that function's own
 * parameter, never by changing a global. Each draw offers production's constant first, so a failing case shrinks
 * toward the limit in force, then small values that put both sides of the limit within a small case.
 */
export const limitGen = (inForce: number, small: Arr.NonEmptyReadonlyArray<number>): Gen<number> =>
	production(inForce, small)
