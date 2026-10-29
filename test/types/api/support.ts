/**
 * Type-level assertions for the public API fixtures.
 *
 * Exact type equality, including readonly and optionality.
 */
export type Equals<A, B> =
	(<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false
export type Expect<T extends true> = T
