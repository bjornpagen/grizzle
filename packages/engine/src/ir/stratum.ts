import { nominal } from "#compiler/core/brand.ts"

declare const stratumAtBrand: unique symbol

/**
 * A stratum of a write by its position among the ChangeSet's occupied strata: the stratum its statements run in, by
 * which the IR's strata, the slot groups, edits, nested writes and refills, the schedule's steps and the statements a
 * refusal is judged at are numbered. A ChangeSet drops its empty strata, so a stratum's index among the ChangeSet's own
 * strata, which only a member slot's spelled name carries, is no StratumAt.
 */
export type StratumAt = number & { readonly [stratumAtBrand]: true }

const at = nominal<number, StratumAt>()

/** Each of a write's occupied strata, in order, with its position: the one place a StratumAt is made. */
export const strataAt = <T>(strata: ReadonlyArray<T>): ReadonlyArray<readonly [StratumAt, T]> =>
	strata.map((stratum, i) => [at(i), stratum] as const)
