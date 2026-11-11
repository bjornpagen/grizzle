/** A brand's minting function: a value of the base `A`, returned as the brand `B` it already is. */
export type Mint<A, B extends A> = (value: A) => B

/**
 * Type-only brands. A brand is its base type intersected with a property keyed by its own unique symbol, so it has no
 * runtime form and a LawId never stands where another brand is expected.
 *
 * `nominal<Base, Branded>()` is a brand's minting function: unchecked, the caller asserts the value already is one of
 * that kind, and the value is returned as it is.
 */
/* @__NO_SIDE_EFFECTS__ */
export const nominal = <A, B extends A>(): Mint<A, B> => {
	/** The claim behind the mint, unchecked: a value of the base already is one of the brand. */
	const claim: (value: A) => asserts value is B = () => undefined
	return (value) => {
		claim(value)
		return value
	}
}
