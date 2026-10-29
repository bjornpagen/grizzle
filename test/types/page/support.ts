/**
 * Type-level assertions for the page fixtures. The fixtures under ./fixtures are typechecked, never executed.
 *
 * Exact type equality, including readonly and optionality.
 */
export type Equals<A, B> =
	(<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false
export type Expect<T extends true> = T
export type IsAssignable<A, B> = [A] extends [B] ? true : false
export type Not<T extends boolean> = T extends true ? false : true
