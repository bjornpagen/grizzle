type Identity = ReadonlyArray<string>

type Pair = readonly [string, number]

declare const left: Identity
declare const right: Identity
declare const pair: Pair
declare const other: Pair
declare const maybe: Identity | undefined
declare const branded: Identity & { readonly brand: "key" }
declare const nested: ReadonlyArray<Identity>
declare const deeper: ReadonlyArray<Identity>
declare const name: string

export const same = left === right // violation

export const differ = pair !== other // violation

export const loose = left == right // violation

export const maybeSame = maybe === right // violation

export const brandedSame = branded === left // violation

export const byIdentity = new Map<Identity, number>() // violation

export const byPair = new Set<Pair>() // violation

export const weak = new WeakMap<Pair, string>() // violation

export const fromEntries = new Map([[pair, 1]]) // violation

export const annotated: Map<Identity, number> = new Map() // violation

export const nestedSame = nested === deeper // violation

export const notShortcut = left === right || name === "a" // violation

export const byNodes = new Map<ReadonlyArray<{ readonly kind: string }>, number>() // violation

export const memo = new WeakMap<ReadonlyArray<{ readonly kind: string }>, string>() // violation
