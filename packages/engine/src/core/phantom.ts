/**
 * The keys every phantom of the type vocabulary rides under.
 *
 * A phantom is a type no runtime value holds: a field descriptor's host type, a term's host type, parameters and
 * origin, a query's heading and evidence. It is an optional member under the declared symbol `phantom`, so the
 * member's type keeps the variance. `declare const` is erased: no runtime value has that key, and its export is
 * type-only (`import type { phantom }`), for an interface that refines an inherited bundle. `| undefined` keeps an
 * absent member from being an exactOptionalPropertyTypes mismatch.
 *
 * An optional member alone would let any plain object with a type's real members claim the type, phantoms included:
 * `{ expr }` would be a `Term<Cents>`, `{}` a `Source<{ secret: string }>`. So every phantom carrier also holds the
 * required brand `built`, a real symbol that only grizzle's builders set (`[built]: true`, through `builtMark`). No
 * barrel exports the symbol, so a plain object never has a phantom type. The brand is a plain own data property, so a
 * branded value stays a frozen record of its real members.
 *
 * The brand alone does not make the phantom the builder's: an object spread copies a branded value's members and its
 * brand, and TypeScript gives the copy the source's type, phantom included, whatever members the spread replaces. So no
 * builder reads a value's meaning from its members. Every value a builder admits is admitted by identity: queries,
 * sources, ChangeSets and owned schema values by the WeakMap state their builders keep, field descriptors by the
 * registry's owned set, and terms and predicates by the registry scalar/compute/term.ts keeps, which refuses a branded
 * copy of a term (MalformedDescription). A value is accepted, with its phantom, only when a builder made it, and the
 * phantom is the one that builder's signature gave it.
 *
 * It lives in core so that every layer that declares a phantom (scalar, text, schema, types, query, write) shares the
 * one pair of keys.
 *
 * A carrier's domain rides under `domain`, as every other phantom rides under `phantom`: the host type a term bound at
 * the carrier, or a variable minted over it, has (Domained); the facts its values are proved to have under `proved`
 * (Proving); and its language, the values of its type, under `language` (Languaged).
 */
export declare const phantom: unique symbol

/** The key a carrier's domain rides under: a phantom, as `phantom` is. */
export declare const domain: unique symbol

/** What a heading carrier states: its domain, the host type a term bound at it or a variable minted over it has. */
export interface Domained<out D> {
	readonly [domain]?: D | undefined
}

/** The key the facts a carrier's values are proved to have ride under: a phantom, as `domain` is. */
export declare const proved: unique symbol

/** What a carrier or a term states beside its domain: the facts its values are proved to have. */
export interface Proving<out F> {
	readonly [proved]?: F | undefined
}

/** The key a carrier's language rides under: a phantom, as `domain` is. */
export declare const language: unique symbol

/**
 * What a carrier or a term states beside its domain: its language, every value of its type, which a JavaScript value
 * standing at it is one of: a refined text's pattern's language, a roster's handles, uuid_out's spelling, and the base
 * host type of every other type. A constant's values are one member of it.
 */
export interface Languaged<out L> {
	readonly [language]?: L | undefined
}

/** The key a JavaScript value's stated domain in a head rides under (types/core/phantom.ts Retyped). */
export declare const retyped: unique symbol

/** The key a union carrier's constants' values ride under (types/core/phantom.ts Constants). */
export declare const constants: unique symbol

/** The key a delta source's relation rides under (types/changeset DeltaSource): a phantom, as `domain` is. */
export declare const delta: unique symbol

export const built: unique symbol = Symbol("grizzle.built")

/** What a builder sets on every value it makes: the brand. */
export interface Built {
	readonly [built]: true
}

/** The brand, for a builder to spread into the value it makes. */
export const builtMark: Built = Object.freeze({ [built]: true } as const)

export interface Phantom<out Bundle> extends Built {
	readonly [phantom]?: Bundle | undefined
}
