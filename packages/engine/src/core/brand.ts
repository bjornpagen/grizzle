import { malformedDescription, ruleRefused } from "#compiler/core/errors.ts"
import { captureLoc } from "#compiler/core/loc.ts"

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

/**
 * The key a host type's marks ride under (HostMark): declared and never defined, so no value holds a member under it,
 * and a value of a marked type is only ever one a mint returned (mintOf) or one grizzle's decoder read (core/decoder.ts
 * hostColumn).
 */
declare const hostMark: unique symbol

/**
 * A consumer's mark on a host type: the consumer's key K, a unique symbol of its own module, under grizzle's key, one
 * member per key, so a host type over another host type holds both keys and loses neither.
 */
export interface HostMark<K extends symbol> {
	readonly [hostMark]: { readonly [k in K]: true }
}

/**
 * A consumer's host type over a base host type A: A's values under the consumer's key K, `typeof key` for
 * `const key = Symbol(name)` in the consumer's module. It is a contract's host type (public/fields.ts contract), so a
 * write of the contract takes only values of it, and a read delivers it. A value of it is minted only by mintOf(key), so
 * only the module that holds the key mints one, and grizzle's decoder, which trusts its own database.
 */
export type Marked<A, K extends symbol> = A & HostMark<K>

/** The keys a host type H is marked by (HostMark): none for a type no consumer marks. */
export type HostKeysOf<H> = H extends { readonly [hostMark]: infer M } ? keyof M : never

/** A consumer's mint over its key K: any value, returned as the same value under K (Marked). */
export type HostMint<K extends symbol> = <A>(value: A) => Marked<A, K>

/** The claim behind a host mint, unchecked: a value of the base is one of the host type under K. */
const hosted: <A, K extends symbol>(value: A) => asserts value is Marked<A, K> = () => undefined

/**
 * A key as a JavaScript caller passes it to a mint, mintOf's and every database-side one's (scalar/contract.ts
 * admitMintKey), `label` naming where: a symbol of its module's own, never a registered one, which Symbol.for gives any
 * module by its name, so it is the capability a mint needs; anything else is no key.
 */
export const admitHostKey = (key: unknown, label: string): void => {
	if (typeof key !== "symbol") {
		throw malformedDescription(captureLoc(label, []), "a host's key: a unique symbol, Symbol(name)")
	}
	if (Symbol.keyFor(key) !== undefined) {
		throw ruleRefused(
			captureLoc(label, []),
			"a host's key is a unique symbol: its module's own Symbol(name), never a registered one, which any module reads"
		)
	}
}

/**
 * The mint of the host types under `key` (public/fields.ts mintOf, whose type refuses a key that is no unique symbol):
 * the one unchecked conversion a consumer makes, from a value of a host type's base to the host type. The key is the
 * capability, a value only its module holds (admitHostKey).
 */
export const hostMintOf = <K extends symbol>(key: K): HostMint<K> => {
	admitHostKey(key, "mintOf key")
	return <A>(value: A): Marked<A, K> => {
		hosted<A, K>(value)
		return value
	}
}
