/** What the properties of values.test.ts read: its spaces, models and helpers. */

import { assert } from "@bjornpagen/testing/assert"
import { constant, element, type Gen, int, shuffled, weighted } from "@bjornpagen/testing/gen"
import { Array as Arr, Option } from "effect"
import {
	callError,
	type KeyFields,
	KeyedList,
	keyOf,
	type ListChange,
	type ListEvent,
	type ReadState,
	type RowKey,
	type ShapeFailure
} from "#compiler/live/index.ts"
import { Decimal } from "#compiler/scalar/values/decimal.ts"
import { upTo } from "#test/support/up-to.ts"

/** A row as the model holds it: its key value's index and its payload's. */
export interface Spec {
	readonly i: number
	readonly p: number
}

/** A row as a read delivers it: a constant head field, its key value, its payload, and its spec. */
export interface Row {
	readonly t: number
	readonly k: unknown
	readonly v: unknown
	readonly i: number
	readonly p: number
}

/** The key values, pairwise distinct keys, each built anew at each use: one of every form a key value takes. */
const keyValues: Arr.NonEmptyReadonlyArray<() => unknown> = [
	() => 0,
	() => Number.NaN,
	() => 1n,
	() => "a",
	() => "",
	() => true,
	() => Decimal.of("1.5"),
	() => Decimal.of("15"),
	() => ({ start: 1, end: 2 }),
	() => ({ start: 1, end: 3 }),
	() => new Set(["x", "y"]),
	() => Uint8Array.of(1, 2),
	() => Float32Array.of(1, 2),
	() => [1, 2]
]

/** The payloads, pairwise distinct deliveries, each built anew at each use. */
const payloads: Arr.NonEmptyReadonlyArray<() => unknown> = [
	() => 0,
	() => 1,
	() => Decimal.of("1"),
	() => [0, "a"],
	() => ({ n: new Set(["x"]) })
]

const made = (makers: ReadonlyArray<() => unknown>, at: number): unknown => {
	const make = makers[at]
	assert.ok(make !== undefined, `a maker at ${at}`)
	return make()
}

const rowOf = (spec: Spec): Row => ({
	t: 0,
	k: made(keyValues, spec.i),
	v: made(payloads, spec.p),
	i: spec.i,
	p: spec.p
})

const specOf = (row: Row): Spec => ({ i: row.i, p: row.p })

/** The key fields a value is keyed by: its key value's, behind a constant field, or a whole row's, key and payload. */
const fieldsGen: Gen<KeyFields> = element([["k"], ["t", "k"], ["k", "v"]] as const)

/** The key fields of keys that hold no payload, which a drawn change names by its key value's index alone. */
const indexFieldsGen: Gen<KeyFields> = element([["k"], ["t", "k"]] as const)

/** A spec's key as the model compares it: the key value's index, and the payload's where the key holds it. */
export const modelKey = (fields: KeyFields, spec: Spec): string =>
	fields.includes("v") ? `${spec.i}/${spec.p}` : `${spec.i}`

const keyIndices = Object.freeze(upTo(keyValues.length, (i) => i))

const payloadGen: Gen<number> = int(0, payloads.length - 1)

/** Up to seven rows of distinct keys, in a drawn order. */
const specsGen: Gen<ReadonlyArray<Spec>> = (source) =>
	Arr.map(shuffled(keyIndices, { min: 0, max: 7 })(source), (i) => ({ i, p: payloadGen(source) }))

/**
 * A value drawn from `previous`: each row kept, its payload kept or changed, or dropped; new keys added; and the order
 * kept or shuffled.
 */
const nextGen =
	(previous: ReadonlyArray<Spec>): Gen<ReadonlyArray<Spec>> =>
	(source) => {
		const kept = Arr.flatMap(previous, (spec) =>
			weighted<ReadonlyArray<Spec>>([
				[4, constant([spec])],
				[2, (s) => [{ i: spec.i, p: payloadGen(s) }]],
				[1, constant([])]
			])(source)
		)
		const free = Arr.filter(keyIndices, (i) => !Arr.some(previous, (spec) => spec.i === i))
		const fresh = Arr.map(
			shuffled(free, { min: 0, max: Math.min(3, free.length) })(source),
			(i) => ({
				i,
				p: payloadGen(source)
			})
		)
		const pool = [...kept, ...fresh]
		return weighted<ReadonlyArray<Spec>>([
			[1, constant(pool)],
			[1, shuffled(pool, { min: pool.length, max: pool.length })]
		])(source)
	}

/** A change as the model draws it: a remove of a key's index, or an upsert of a spec after a key's index, null first. */
type ChangeSpec =
	| { readonly kind: "remove"; readonly i: number }
	| { readonly kind: "upsert"; readonly spec: Spec; readonly after: number | null }

/** The model's list after `change`: a second implementation of KeyedList's applying, over specs keyed by index. */
export const modelApply = (model: ReadonlyArray<Spec>, change: ChangeSpec): ReadonlyArray<Spec> => {
	if (change.kind === "remove") {
		return Arr.filter(model, (spec) => spec.i !== change.i)
	}
	const rest = Arr.filter(model, (spec) => spec.i !== change.spec.i)
	const after = change.after
	const place =
		after === null
			? 0
			: Option.match(
					Arr.findFirstIndex(rest, (spec) => spec.i === after),
					{ onNone: () => rest.length, onSome: (at) => at + 1 }
				)
	return [...Arr.take(rest, place), change.spec, ...Arr.drop(rest, place)]
}

/** The key of a key value's index under keys that hold no payload. */
const keyAt = (fields: KeyFields, i: number): RowKey => keyOf(fields, rowOf({ i, p: 0 }))

/** A read's events: its reset, its ready, its error and its end. */
const reset = (fields: KeyFields): ListEvent<Row> => ({ kind: "reset", key: fields })
export const ready: ListEvent<Row> = { kind: "ready" }
export const failed = (error: ShapeFailure<"list">): ListEvent<Row> => ({ kind: "error", error })
export const end: ListEvent<Row> = { kind: "end" }

/** The upserts of a first run's rows, in their order, each after the row before it, null first. */
const rowsOf = (fields: KeyFields, specs: ReadonlyArray<Spec>): ReadonlyArray<ListChange<Row>> =>
	Arr.map(specs, (spec, n) => {
		const before = specs[n - 1]
		return {
			kind: "upsert",
			row: rowOf(spec),
			after: before === undefined ? null : keyOf(fields, rowOf(before))
		}
	})

/** A drawn change as the read's change. */
export const changeOf = (fields: KeyFields, change: ChangeSpec): ListChange<Row> =>
	change.kind === "remove"
		? { kind: "remove", key: keyAt(fields, change.i) }
		: {
				kind: "upsert",
				row: rowOf(change.spec),
				after: change.after === null ? null : keyAt(fields, change.after)
			}

export const valueOf = (fields: KeyFields, specs: ReadonlyArray<Spec>): KeyedList<Row> =>
	KeyedList.of(fields, Arr.map(specs, rowOf))

export const specsIn = (value: KeyedList<Row>): ReadonlyArray<Spec> => Arr.map([...value], specOf)

/** The specs of a state's value, which must be ready. */
export const readySpecs = (state: ReadState<Row>): ReadonlyArray<Spec> => {
	assert.equal(state.kind, "ready")
	return state.kind === "ready" ? specsIn(state.value) : []
}

/** The events of a read whose first run delivered `specs`, up to its ready. */
export const openedEvents = (
	fields: KeyFields,
	specs: ReadonlyArray<Spec>
): ReadonlyArray<ListEvent<Row>> => [reset(fields), ...rowsOf(fields, specs)]

/** What a drawn change did to the model: features of the search. */
export type Applied =
	| "a remove of a present key"
	| "a remove of an absent key"
	| "a new upsert"
	| "an upsert in place"
	| "a move"
	| "a re-sent upsert"

/** Whether two drawn changes are one: a re-sent change is the change before it again. */
const sameChange = (a: ChangeSpec, b: ChangeSpec): boolean =>
	a.kind === "remove"
		? b.kind === "remove" && a.i === b.i
		: b.kind === "upsert" && a.spec.i === b.spec.i && a.spec.p === b.spec.p && a.after === b.after

/** What `change` does to `model`, read off the model before it. */
export const appliedOf = (
	model: ReadonlyArray<Spec>,
	change: ChangeSpec,
	previous: ChangeSpec | undefined
): Applied => {
	if (change.kind === "upsert" && previous !== undefined && sameChange(change, previous)) {
		return "a re-sent upsert"
	}
	if (change.kind === "remove") {
		return Arr.some(model, (spec) => spec.i === change.i)
			? "a remove of a present key"
			: "a remove of an absent key"
	}
	return Option.match(
		Arr.findFirstIndex(model, (spec) => spec.i === change.spec.i),
		{
			onNone: (): Applied => "a new upsert",
			onSome: (at): Applied =>
				(model[at - 1]?.i ?? null) !== change.after ? "a move" : "an upsert in place"
		}
	)
}

/** How a diff's rows stood against the value before it: features of the search. */
export type Diffed =
	| "a key gone"
	| "a new key"
	| "a changed row"
	| "an unchanged row moved"
	| "a whole-row key"

/** The length of a longest strictly increasing subsequence of `places`: a quadratic program, a second count. */
export const longestIncreasing = (places: ReadonlyArray<number>): number => {
	const best: Array<number> = []
	for (const [n, place] of places.entries()) {
		best.push(
			Arr.reduce(Arr.take(places, n), 1, (longest, earlier, m) =>
				earlier < place ? Math.max(longest, (best[m] ?? 0) + 1) : longest
			)
		)
	}
	return Arr.reduce(best, 0, (longest, length) => Math.max(longest, length))
}

/** How two batches met: a key the first added and the second removed, or none. */
export type Coalesced = "a key added then removed" | "batches over other keys"

/** A read's stream as it ended: the paths fold must tell apart. */
export type Path =
	| "an error before reset"
	| "an error before ready"
	| "provisional at its end"
	| "ready, then live batches"
	| "an error after ready"

export const cut = callError("transport", { message: "the exchange broke" })

/** How two forms stood: one delivery, one key of two deliveries, or two keys. */
export type Compared = "one delivery" | "one key, two deliveries" | "two keys"

/** A case of the fold: its key fields, a first run's specs and the changes after it. */
interface FoldCase {
	readonly fields: KeyFields
	readonly start: ReadonlyArray<Spec>
	readonly changes: ReadonlyArray<ChangeSpec>
}

/** A case of the diff: its key fields, and two values. */
interface DiffCase {
	readonly fields: KeyFields
	readonly previous: ReadonlyArray<Spec>
	readonly next: ReadonlyArray<Spec>
}

/** A case of coalesce: its key fields, and three values in turn. */
interface CoalesceCase {
	readonly fields: KeyFields
	readonly base: ReadonlyArray<Spec>
	readonly middle: ReadonlyArray<Spec>
	readonly last: ReadonlyArray<Spec>
}

/** A case of a read's lifecycle. */
interface LifecycleCase {
	readonly start: ReadonlyArray<Spec>
	readonly ready: boolean
	readonly batches: ReadonlyArray<ReadonlyArray<Spec>>
	readonly error: "none" | "before reset" | "at the end"
}

/** A read's first run, then drawn changes, each a remove or an upsert after a key or first, or the last upsert re-sent. */
export const foldModelGen: Gen<FoldCase> = (s) => {
	const start = s.draw(specsGen)
	let model = start
	const changes: Array<ChangeSpec> = []
	const count = s.draw(int(0, 8))
	for (let n = 0; n < count; n++) {
		const last = changes.at(-1)
		const change: ChangeSpec =
			last?.kind === "upsert" && s.draw(int(0, 3)) === 0
				? last
				: s.draw(
						weighted<ChangeSpec>([
							[1, (t) => ({ kind: "remove", i: t.draw(int(0, keyValues.length - 1)) })],
							[
								3,
								(t) => {
									const spec = {
										i: t.draw(int(0, keyValues.length - 1)),
										p: t.draw(payloadGen)
									}
									const others = Arr.map(
										Arr.filter(model, (m) => m.i !== spec.i),
										(m) => m.i
									)
									return {
										kind: "upsert",
										spec,
										after: t.draw(element([null, ...others]))
									}
								}
							]
						])
					)
		changes.push(change)
		model = modelApply(model, change)
	}
	return { fields: s.draw(indexFieldsGen), start, changes }
}

/** A value, and the next one drawn from it, of drawn key fields. */
export const diffGen: Gen<DiffCase> = (s) => {
	const previous = s.draw(specsGen)
	return {
		fields: s.draw(fieldsGen),
		previous,
		next: s.draw(nextGen(previous))
	}
}

/** A value, the one drawn from it, and the last drawn from that, of drawn key fields. */
export const coalesceGen: Gen<CoalesceCase> = (s) => {
	const base = s.draw(specsGen)
	const middle = s.draw(nextGen(base))
	return {
		fields: s.draw(fieldsGen),
		base,
		middle,
		last: s.draw(nextGen(middle))
	}
}

/** A read's first run, then whether it was ready, its live batches, and where an error ended it, if one did. */
export const lifecycleGen: Gen<LifecycleCase> = (s) => {
	const start = s.draw(specsGen)
	const ready = s.draw(element([true, false] as const))
	let at = start
	const batches: Array<ReadonlyArray<Spec>> = []
	const count = ready ? s.draw(int(0, 3)) : 0
	for (let n = 0; n < count; n++) {
		at = s.draw(nextGen(at))
		batches.push(at)
	}
	return {
		start,
		ready,
		batches,
		error: s.draw(element(["none", "before reset", "at the end"] as const))
	}
}
