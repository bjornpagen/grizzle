/** What the property of parent-binds.test.ts reads: its facts, the reads it installs and the host's model of them. */

import { type Gen, subset } from "@bjornpagen/testing/gen"
import { Array as Arr, Order, Record as Rec } from "effect"
import { fixtureTemplate } from "#test/support/pg/reads/support.ts"
import {
	attemptsOf,
	type Binder,
	binders,
	type Form,
	forms,
	ParentBinds
} from "#test/support/unit/check/parent-binds.fixtures.ts"

interface AttemptFact {
	readonly child: number
	readonly n: number
	readonly at: number
}

interface MarkFact {
	readonly child: number
	readonly n: number
	readonly mark: number
}

export interface Facts {
	readonly attempts: ReadonlyArray<AttemptFact>
	readonly marks: ReadonlyArray<MarkFact>
}

/** Two children, each at two items: every attempt's and mark's key is one of these. */
const keys = Arr.flatMap([1, 2], (child) => Arr.map([1, 2], (n) => ({ child, n })))

/**
 * Attempts, a subset of the keys at one or two instants, and marks, a subset of the keys with one of two marks, both
 * sets by construction: a child with attempts at both items and marks of the other, and an attempt with no mark, among
 * the draws.
 */
export const factsGen: Gen<Facts> = (source) => {
	const attempts = source.draw(
		subset(
			Arr.flatMap(keys, (k) => Arr.map([1, 2], (at) => ({ ...k, at }))),
			{ min: 1, max: 6 }
		)
	)
	const marks = source.draw(
		subset(
			Arr.flatMap(keys, (k) => Arr.map([1, 2], (mark) => ({ ...k, mark }))),
			{ min: 0, max: 8 }
		)
	)
	return { attempts, marks }
}

/** A read the property installs: the attempts read with their marks, as `binder` and `form` read them. */
export interface BindRead {
	readonly binder: Binder
	readonly form: Form
	readonly name: string
}

export const bindReads: ReadonlyArray<BindRead> = Arr.flatMap(binders, (binder, i) =>
	Arr.map(forms, (form, j) => ({ binder, form, name: `attempts${i}${j}` }))
)

/** Every read of the box, by its name: the programs its login's workload holds. */
export const parentBindsInstall = Object.freeze({
	label: "parentbinds",
	programs: Rec.fromEntries(
		Arr.map(bindReads, (read) => [read.name, attemptsOf(read.binder, read.form)] as const)
	)
})

/** ParentBinds installed as `grizzle generate` drafts it, once per member: the template every case clones. */
export const parentBindsTemplate = fixtureTemplate(import.meta, ParentBinds, parentBindsInstall)

/** One attempt as a read delivers it: its key and its instant, and the marks of its child's item, ascending. */
export interface Delivered {
	readonly child: number
	readonly n: number
	readonly at: number
	readonly marks: ReadonlyArray<number>
}

/** The model: each attempt with the marks of its child at its item, whichever way the read binds the child. */
export const expected = (facts: Facts): ReadonlyArray<Delivered> =>
	Arr.map(facts.attempts, (a) => ({
		...a,
		marks: Arr.sort(
			Arr.flatMap(facts.marks, (m) => (m.child === a.child && m.n === a.n ? [m.mark] : [])),
			Order.Number
		)
	}))

export type BindFeature =
	| `${Binder}, ${Form}`
	| "an attempt with no mark"
	| "an attempt whose child has marks of another item"

/** What the facts reach besides the reads: an attempt with no mark, one whose child's other item has marks. */
export const featuresOf = (facts: Facts): ReadonlyArray<BindFeature> => [
	...(Arr.some(expected(facts), (a) => a.marks.length === 0)
		? (["an attempt with no mark"] as const)
		: []),
	...(Arr.some(facts.attempts, (a) =>
		Arr.some(facts.marks, (m) => m.child === a.child && m.n !== a.n)
	)
		? (["an attempt whose child has marks of another item"] as const)
		: [])
]
