import { TupleMap, TupleSet } from "#lint/fixtures/tuple-identity/tuple-map.ts"

type Identity = ReadonlyArray<string>

type Pair = readonly [string, number]

declare const left: Identity
declare const right: Identity
declare const pair: Pair
declare const maybe: Identity | undefined
declare const name: string
declare const nodes: ReadonlyArray<{ readonly kind: string }>
declare const rewritten: ReadonlyArray<{ readonly kind: string }>

/** A JSON value: a recursive type whose lists may hold records, so a list of them is no list of values. */
type JsonValue =
	| string
	| number
	| boolean
	| ReadonlyArray<JsonValue>
	| { readonly [key: string]: JsonValue }

declare const document: ReadonlyArray<JsonValue>
declare const revised: ReadonlyArray<JsonValue>

export const byElements = new TupleMap<Identity, number>()

export const pairs = new TupleSet<Pair>()

export const firstSame = left[0] === right[0]

export const absent = maybe === undefined

export const lengths = left.length === right.length

export const named = name === "a"

export const byName = new Map<string, Identity>()

export const names = new Set<string>()

export const elements = pair[0] === name

export const shortcut =
	left === right || (left.length === right.length && left.every((x, i) => x === right[i]))

export const shared = nodes === rewritten

export const sharedDocument = document === revised
