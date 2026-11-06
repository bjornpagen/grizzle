import { type Gen, map, oneOf, proportional } from "@grizzle/testing/gen"
import { Array as Arr, Record } from "effect"
import type { InvalidKind, ValidityWeights } from "#test/support/worlds/model/types.ts"

/** The public boundary an invalid input crosses. */
type Boundary =
	| "token"
	| "claims"
	| "role"
	| "fact"
	| "handle"
	| "catalog"
	| "migration"
	| "install"
	| "isolation"
	| "session"

/**
 * Every invalid kind and the boundary it crosses: a kind the vocabulary adds is a compile error here until it is placed,
 * so the list below is every kind there is.
 */
const boundaryOf: { readonly [K in InvalidKind]: Boundary } = {
	"token:not-json": "token",
	"token:claim-object-missing": "token",
	"token:claim-object-null": "token",
	"token:claim-object-array": "token",
	"token:field-missing": "token",
	"token:field-wrong-type": "token",
	"token:unsafe-integer": "token",
	"token:int8-not-digits": "token",
	"token:lone-surrogate": "token",
	"token:nul-character": "token",
	"token:proto-key": "token",
	"token:huge-payload": "token",
	"token:refinement-edge": "token",
	"token:extra-fields": "token",
	"token:verify-throws": "token",
	"token:verify-not-object": "token",
	"token:stale:removed-user": "token",
	"token:stale:left-organization": "token",
	"token:stale:deleted-organization": "token",
	"token:stale:previous-request": "token",
	"claims:facts:transaction": "claims",
	"claims:facts:session": "claims",
	"claims:malformed:transaction": "claims",
	"claims:malformed:session": "claims",
	"role:other-login": "role",
	"role:dropped": "role",
	"role:nonexistent": "role",
	"role:owner": "role",
	"fact:law-broken": "fact",
	"fact:outside-world": "fact",
	"fact:hidden-key-collision": "fact",
	"fact:hidden-reference": "fact",
	"fact:deleted-reference": "fact",
	"fact:duplicate-in-input": "fact",
	"fact:partial-serial": "fact",
	"fact:filtered-serial-omitted": "fact",
	"fact:domain-refused": "fact",
	"handle:closed-db": "handle",
	"handle:closed-direct": "handle",
	"handle:wrong-kind": "handle",
	"handle:other-role": "handle",
	"handle:other-login": "handle",
	"handle:stale-snapshot": "handle",
	"handle:tampered-snapshot": "handle",
	"handle:foreign-snapshot": "handle",
	"handle:drafted-snapshot": "handle",
	"handle:stale-db": "handle",
	"handle:wild-js-value": "handle",
	"catalog:membership-admin": "catalog",
	"catalog:membership-inherit": "catalog",
	"catalog:membership-revoked": "catalog",
	"catalog:membership-extra": "catalog",
	"catalog:member-extra": "catalog",
	"catalog:role-attribute": "catalog",
	"catalog:role-setting": "catalog",
	"catalog:database-setting": "catalog",
	"catalog:row-security": "catalog",
	"catalog:extra-grant": "catalog",
	"catalog:grant-revoked": "catalog",
	"catalog:extra-column-grant": "catalog",
	"catalog:inherited-grant": "catalog",
	"catalog:public-grant": "catalog",
	"catalog:policy-dropped": "catalog",
	"catalog:policy-edited": "catalog",
	"catalog:view-redefined": "catalog",
	"catalog:function-redefined": "catalog",
	"catalog:search-path-altered": "catalog",
	"catalog:default-privileges": "catalog",
	"catalog:column-default": "catalog",
	"catalog:not-null-dropped": "catalog",
	"catalog:extra-index": "catalog",
	"catalog:extra-table": "catalog",
	"catalog:rewrite-rule": "catalog",
	"catalog:trigger-disabled": "catalog",
	"migration:half-applied": "migration",
	"migration:hand-edited": "migration",
	"migration:law-over-violating-data": "migration",
	"migration:roster-removal-held": "migration",
	"migration:roster-reorder": "migration",
	"install:unwritable-write": "install",
	"install:two-writes-one-relation": "install",
	"isolation:repeatable read": "isolation",
	"isolation:read committed": "isolation",
	"isolation:read uncommitted": "isolation",
	"session:interrupted": "session",
	"session:after-refusal": "session"
}

/** Every invalid kind, in the vocabulary's order: the exhaustive table's keys. */
export const invalidKinds: ReadonlyArray<InvalidKind> = Record.keys(boundaryOf)

/** One drawn input: live, or invalid of the one kind the generator meant it to be. */
type Tagged<T> =
	| { readonly kind: "live"; readonly value: T }
	| { readonly kind: "invalid"; readonly invalid: InvalidKind; readonly value: T }

/** An invalid variant of a boundary: its kind, and the values of it the state offers. */
export interface Variant<T> {
	readonly invalid: InvalidKind
	readonly gen: Gen<T>
}

/**
 * What a boundary draws from in one state: its live values, and its stale and wild variants. Stale values were valid
 * once in another state (a closed handle, a removed user, an earlier request); wild ones are anything the types refuse.
 * A variant the state cannot offer is left out of the list, never drawn and refused later.
 */
export interface BoundaryArms<T> {
	readonly live: Gen<T>
	readonly stale: ReadonlyArray<Variant<T>>
	readonly wild: ReadonlyArray<Variant<T>>
}

/**
 * A weight scale every variant count up to sixteen divides, so a class's weight is split exactly among its variants and
 * every weight stays an integer.
 */
const scale = 720_720

/** One option and its weight: a whole number of any size, computed from a state's offer and a run's weights. */
export type Share<A> = readonly [weight: number, generator: Gen<A>]

/** A class's variants, each weighing its share of the class's weight. */
const weighted = <T>(
	variants: ReadonlyArray<Variant<T>>,
	weight: number
): ReadonlyArray<Share<Tagged<T>>> =>
	weight === 0 || variants.length === 0
		? []
		: Arr.map(variants, (v): Share<Tagged<T>> => [
				Math.max(1, Math.round((weight * scale) / variants.length)),
				map(v.gen, (value): Tagged<T> => ({ kind: "invalid", invalid: v.invalid, value }))
			])

/**
 * A boundary's value under a run's validity weights: live, stale and wild in the weights' shares, each class split
 * evenly among its variants. Live comes first, so a failure shrinks toward it. A class without weight or without a
 * variant in this state is never drawn; when nothing is left, the value is live: no weighting is a dead end.
 */
const underValidity = <T>(arms: BoundaryArms<T>, validity: ValidityWeights): Gen<Tagged<T>> => {
	const live = map(arms.live, (value): Tagged<T> => ({ kind: "live", value }))
	const invalid = [...weighted(arms.stale, validity.stale), ...weighted(arms.wild, validity.wild)]
	const [first, ...rest] = [
		...(validity.live === 0 ? [] : [[validity.live * scale, live] as const]),
		...invalid
	]
	return first === undefined ? live : proportional([first, ...rest])
}

/**
 * A value of a boundary that has no live value in this state (every session of the kind an action needs is closed):
 * its stale and wild variants in the weights' shares, evenly when the weights give them nothing, since one of them is
 * the only value there is.
 */
const invalidOnly = <T>(
	stale: ReadonlyArray<Variant<T>>,
	wild: ReadonlyArray<Variant<T>>,
	validity: ValidityWeights
): Gen<Tagged<T>> => {
	const weightedOnes = [...weighted(stale, validity.stale), ...weighted(wild, validity.wild)]
	const even = [...weighted(stale, 1), ...weighted(wild, 1)]
	const [first, ...rest] = weightedOnes.length > 0 ? weightedOnes : even
	if (first === undefined) {
		throw new Error("a boundary with no value to draw: its caller offered it where nothing applies")
	}
	return proportional([first, ...rest])
}

/**
 * What an action kind draws from in one state, stratified by invalid kind: the ways it draws an action carrying no
 * invalid input (none when the state offers none, as when every session the kind needs is closed, or when every action
 * of the kind carries one), and its strata, each a way of drawing an action that carries one invalid kind, the rest of
 * the action live. A kind the state cannot offer has no stratum.
 */
export interface Strata<T> {
	readonly live: ReadonlyArray<Gen<T>>
	readonly stale: ReadonlyArray<Variant<T>>
	readonly wild: ReadonlyArray<Variant<T>>
}

/** A boundary's arms as strata: its one live draw and its variants. */
export const armsStrata = <T>(arms: BoundaryArms<T>): Strata<T> => ({
	live: [arms.live],
	stale: arms.stale,
	wild: arms.wild
})

const variantsThrough = <T, A>(
	variants: ReadonlyArray<Variant<T>>,
	through: (gen: Gen<T>) => Gen<A>
): ReadonlyArray<Variant<A>> =>
	Arr.map(variants, (v) => ({ invalid: v.invalid, gen: through(v.gen) }))

/** A draw carried on into a larger value by `f`, which draws the rest of it from the same decisions. */
const carried =
	<T, A>(f: (value: T) => Gen<A>) =>
	(gen: Gen<T>): Gen<A> =>
	(source) =>
		source.draw(f(source.draw(gen)))

/** Strata whose every draw is carried on into a larger value by `f`, which draws the rest of it live. */
export const chainStrata = <T, A>(strata: Strata<T>, f: (value: T) => Gen<A>): Strata<A> => ({
	live: Arr.map(strata.live, carried(f)),
	stale: variantsThrough(strata.stale, carried(f)),
	wild: variantsThrough(strata.wild, carried(f))
})

/** Strata whose every draw is made into a larger value by `f`. */
export const mapStrata = <T, A>(strata: Strata<T>, f: (value: T) => A): Strata<A> => ({
	live: Arr.map(strata.live, (gen) => map(gen, f)),
	stale: variantsThrough(strata.stale, (gen) => map(gen, f)),
	wild: variantsThrough(strata.wild, (gen) => map(gen, f))
})

/** The ways several strata draw one value, as one: every live draw and every stratum of each. */
export const unionStrata = <T>(all: ReadonlyArray<Strata<T>>): Strata<T> => ({
	live: Arr.flatMap(all, (s) => s.live),
	stale: Arr.flatMap(all, (s) => s.stale),
	wild: Arr.flatMap(all, (s) => s.wild)
})

/** A boundary's strata beside an action drawn live elsewhere: its strata alone, its live draws left out. */
export const offLive = <T>(strata: Strata<T>): Strata<T> => ({
	live: [],
	stale: strata.stale,
	wild: strata.wild
})

/** Each invalid kind once in a class: the ways that carry one kind become one stratum, drawn evenly among them. */
const byKind = <T>(variants: ReadonlyArray<Variant<T>>): ReadonlyArray<Variant<T>> => {
	const ways = new Map<InvalidKind, Arr.NonEmptyArray<Gen<T>>>()
	for (const v of variants) {
		const known = ways.get(v.invalid)
		if (known === undefined) {
			ways.set(v.invalid, [v.gen])
		} else {
			known.push(v.gen)
		}
	}
	return Arr.map([...ways], ([invalid, gens]): Variant<T> => ({ invalid, gen: anyOf(gens) }))
}

/**
 * A value of strata under a run's validity weights: live in the live share; each class in its share, split evenly among
 * the invalid kinds the state offers in it, so a rare kind weighs what a common one does. With no live draw, the strata
 * alone (invalidOnly).
 */
export const underStrata = <T>(strata: Strata<T>, validity: ValidityWeights): Gen<T> => {
	const stale = byKind(strata.stale)
	const wild = byKind(strata.wild)
	const tagged = Arr.match(strata.live, {
		onEmpty: () => invalidOnly(stale, wild, validity),
		onNonEmpty: (live) => underValidity({ live: anyOf(live), stale, wild }, validity)
	})
	return map(tagged, (t) => t.value)
}

/** One of several generators, equally often: the generator itself when it is the only one, which draws nothing more. */
export const anyOf = <T>(gens: Arr.NonEmptyReadonlyArray<Gen<T>>): Gen<T> => {
	const [first, ...rest] = gens
	return Arr.isReadonlyArrayNonEmpty(rest) ? oneOf(gens) : first
}

/** The draws of strata that carry one invalid kind, of either class; none when no stratum carries it. */
export const strataOf = <T>(strata: Strata<T>, kind: InvalidKind): ReadonlyArray<Gen<T>> =>
	Arr.flatMap([...strata.stale, ...strata.wild], (v) => (v.invalid === kind ? [v.gen] : []))
