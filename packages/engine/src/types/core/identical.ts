/**
 * Whether A and B are one type, as the checker's identity relation compares them: never mere mutual assignability, so
 * a type with one field more, or one optional field where the other's is required, is never taken for the other.
 */
export type Identical<A, B> =
	(<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
