/** What the property of tuple-map.test.ts reads: its space, its model and its situations. */

import { array, element, type Gen, int, weighted } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"

/**
 * The elements a key is made of: the values a Map's SameValueZero tells apart or joins, so keys share prefixes, end
 * where others go on, and meet NaN, which equals itself, and -0, which equals 0.
 */
const elements = ["a", "b", 0, -0, Number.NaN, 1] as const

type Element = (typeof elements)[number]

/** A key of up to three elements: short, so the keys of one program share prefixes often. */
const keyGen: Gen<ReadonlyArray<Element>> = array(element(elements), { min: 0, max: 3 })

/** One step of a program: set a key to a value, or delete a key. Each step builds its key afresh. */
export type Step =
	| { readonly kind: "set"; readonly key: ReadonlyArray<Element>; readonly value: number }
	| { readonly kind: "delete"; readonly key: ReadonlyArray<Element> }

const stepGen: Gen<Step> = weighted<Step>([
	[3, (source) => ({ kind: "set", key: source.draw(keyGen), value: source.draw(int(0, 9)) })],
	[1, (source) => ({ kind: "delete", key: source.draw(keyGen) })]
])

export const programGen: Gen<ReadonlyArray<Step>> = array(stepGen, { min: 1, max: 24 })

export type TupleMapFeature =
	| "a key that shares a prefix with another"
	| "a key that ends where another goes on"
	| "a key holding NaN found by another array"
	| "a key deleted and set again"
	| "a key set again in place"

/** Two elements as a Map compares its keys: SameValueZero. */
export const sameValueZero = (x: unknown, y: unknown): boolean =>
	x === y || (typeof x === "number" && typeof y === "number" && Number.isNaN(x) && Number.isNaN(y))

/** Two keys as the model compares them: of one length, equal element by element. */
export const sameKey = (a: ReadonlyArray<unknown>, b: ReadonlyArray<unknown>): boolean =>
	a.length === b.length && Arr.every(a, (x, i) => sameValueZero(x, b[i]))

/** Whether `a` is a proper prefix of `b`: `b` goes on where `a` ends. */
export const prefixOf = (a: ReadonlyArray<unknown>, b: ReadonlyArray<unknown>): boolean =>
	a.length < b.length && Arr.every(a, (x, i) => sameValueZero(x, b[i]))

/** Whether two keys are two that begin with one element. */
export const sharePrefix = (a: ReadonlyArray<unknown>, b: ReadonlyArray<unknown>): boolean =>
	a.length > 0 && b.length > 0 && sameValueZero(a[0], b[0]) && !sameKey(a, b)

/** The model: a list of entries in insertion order, each key as it was first set. */
export interface ModelEntry {
	readonly key: ReadonlyArray<Element>
	value: number
}
