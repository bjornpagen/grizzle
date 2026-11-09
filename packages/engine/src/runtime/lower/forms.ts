import type { NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"

/**
 * The forms of a statement: one; or, when per-execution choices of its shapes pick between two, the small form, the
 * statement itself, and the large form L an execution sends when some choice's input exceeds its threshold
 * (runsLargeForm): the same statement lowered in the large mode, of the same placement. Both forms deliver the same
 * rows in the same heading, so the choice is cost only.
 */
export type StatementForms<C, L> =
	| { readonly kind: "one" }
	| { readonly kind: "chosen"; readonly choices: NonEmptyReadonlyArray<C>; readonly large: L }

export const oneForm: { readonly kind: "one" } = Object.freeze({ kind: "one" })
