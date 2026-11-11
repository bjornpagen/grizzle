/**
 * The live model's values (packages/engine/src/live): keys, the values a read's events build, and the evaluators over
 * them. Rows are drawn as specs, a key's index in a dictionary of key values and a payload's index in one of payloads,
 * each made afresh wherever it is used, so no comparison rests on an object's identity, and every row carries its spec,
 * by which a value's rows are read back.
 *
 * - A read's events fold into the model's value: the list or set of specs with each change applied by hand, an upsert
 *   of a list after its key's row, null first, a move for a present key, an upsert of a set in place or last, a remove
 *   of a present or absent key; a re-sent upsert changes nothing. Oracle: the model, a second implementation.
 * - diff carries one value to the other with the least changes: the removes of exactly the keys gone; the upserts of
 *   the new and changed rows, and for a list of the fewest unchanged rows whose order moved, the kept rows off a
 *   longest increasing subsequence of their places, counted by a quadratic program. Oracle: the specification and that
 *   second count.
 * - coalesce is the net change: a value with the coalesced change of two batches is the value after both, and the value
 *   the second batch was diffed to. Oracle: that value.
 * - fold is a read's lifecycle: provisional from reset, a value from ready on, ready on ready changing nothing past its
 *   batch, and an error voiding any value; a write's outcome is its value. Oracle: the specification.
 * - Keys compare by value: two dictionary values are one key exactly when they are of one key class, PostgreSQL's
 *   equality, ±0 one key; and deliver as one exactly when they are of one delivery, Object.is on primitives.
 *
 * Features: removes of present and absent keys, upserts new, in place and moving, re-sent upserts, whole-row keys,
 * unchanged rows moved, and every lifecycle path.
 *
 * Plants (~/.cache/grizzle-release/LIVE-EVENTS/plants): diff-misses-move (a list's diff sends no unchanged row whose
 * order moved), coalesce-keeps-stale-upsert (coalesce keeps a key's upsert past its later remove), and transient-never
 * (unit/live/call-error).
 */
import { describe, it } from "@effect/vitest"
import { drawn, exhaust, explore } from "@grizzle/testing/explore"
import { required, requiredInSpace } from "@grizzle/testing/features"
import { constant, element, type Gen, int, shuffled, weighted } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, type Order } from "effect"
import { TupleMap } from "#compiler/core/tuple-map.ts"
import {
	type CallError,
	callError,
	coalesceList,
	coalesceSet,
	diffList,
	diffSet,
	fold,
	foldWrite,
	formOf,
	type KeyFields,
	Keyed,
	keyOf,
	type ListChange,
	opening,
	type ReadEvent,
	type ReadShape,
	type ReadState,
	RowKey,
	type SetChange,
	sameValue,
	type WriteEvent,
	writeOpening
} from "#compiler/live/index.ts"
import { Decimal } from "#compiler/scalar/values/decimal.ts"
import { assert } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { upTo } from "#test/support/up-to.ts"

/** A row as the model holds it: its key value's index and its payload's. */
interface Spec {
	readonly i: number
	readonly p: number
}

/** A row as a read delivers it: a constant head field, its key value, its payload, and its spec. */
interface Row {
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
const modelKey = (fields: KeyFields, spec: Spec): string =>
	fields.includes("v") ? `${spec.i}/${spec.p}` : `${spec.i}`

const keyIndices = upTo(keyValues.length, (i) => i)

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

/** The model's list or set after `change`: a second implementation of Keyed's applying, over specs keyed by index. */
const modelApply = (
	shape: ReadShape,
	model: ReadonlyArray<Spec>,
	change: ChangeSpec
): ReadonlyArray<Spec> => {
	if (change.kind === "remove") {
		return Arr.filter(model, (spec) => spec.i !== change.i)
	}
	if (shape === "set") {
		return Arr.some(model, (spec) => spec.i === change.spec.i)
			? Arr.map(model, (spec) => (spec.i === change.spec.i ? change.spec : spec))
			: [...model, change.spec]
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

/** The specs of a list or set, in order for a list, by spec for a set, whose order says nothing. */
const bySpec: Order.Order<Spec> = (a, b) =>
	a.i !== b.i ? (a.i < b.i ? -1 : 1) : a.p !== b.p ? (a.p < b.p ? -1 : 1) : 0

const sameSpecs = (
	shape: ReadShape,
	actual: ReadonlyArray<Spec>,
	expected: ReadonlyArray<Spec>
): void =>
	shape === "list"
		? assert.deepEqual(actual, expected)
		: assert.deepEqual(Arr.sort(actual, bySpec), Arr.sort(expected, bySpec))

/** A read's change of shape S. */
type ChangeOf<S extends ReadShape> = {
	readonly set: SetChange<Row>
	readonly list: ListChange<Row>
}[S]

/**
 * What a property needs of a read shape: its events and changes, built as the shape types them, and its evaluators.
 * A property over both shapes is a function of the kit.
 */
interface Kit<S extends ReadShape> {
	readonly shape: S
	readonly reset: (fields: KeyFields) => ReadEvent<S, Row>
	readonly ready: ReadEvent<S, Row>
	readonly failed: (error: CallError) => ReadEvent<S, Row>
	readonly end: ReadEvent<S, Row>
	/** The upserts of a first run's rows, in their order. */
	readonly rows: (fields: KeyFields, specs: ReadonlyArray<Spec>) => ReadonlyArray<ChangeOf<S>>
	readonly change: (fields: KeyFields, change: ChangeSpec) => ChangeOf<S>
	readonly diff: (previous: Keyed<S, Row>, next: Keyed<S, Row>) => ReadonlyArray<ChangeOf<S>>
	readonly coalesce: (
		base: Keyed<S, Row>,
		pending: ReadonlyArray<ChangeOf<S>>
	) => ReadonlyArray<ChangeOf<S>>
}

/** The key of a key value's index under keys that hold no payload. */
const keyAt = (fields: KeyFields, i: number): RowKey => keyOf(fields, rowOf({ i, p: 0 }))

const setKit: Kit<"set"> = {
	shape: "set",
	reset: (fields) => ({ kind: "reset", key: fields }),
	ready: { kind: "ready" },
	failed: (error) => ({ kind: "error", error }),
	end: { kind: "end" },
	rows: (_fields, specs) => Arr.map(specs, (spec) => ({ kind: "upsert", row: rowOf(spec) })),
	change: (fields, change) =>
		change.kind === "remove"
			? { kind: "remove", key: keyAt(fields, change.i) }
			: { kind: "upsert", row: rowOf(change.spec) },
	diff: diffSet,
	coalesce: coalesceSet
}

const listKit: Kit<"list"> = {
	shape: "list",
	reset: (fields) => ({ kind: "reset", key: fields }),
	ready: { kind: "ready" },
	failed: (error) => ({ kind: "error", error }),
	end: { kind: "end" },
	rows: (fields, specs) =>
		Arr.map(specs, (spec, n) => {
			const before = specs[n - 1]
			return {
				kind: "upsert",
				row: rowOf(spec),
				after: before === undefined ? null : keyOf(fields, rowOf(before))
			}
		}),
	change: (fields, change) =>
		change.kind === "remove"
			? { kind: "remove", key: keyAt(fields, change.i) }
			: {
					kind: "upsert",
					row: rowOf(change.spec),
					after: change.after === null ? null : keyAt(fields, change.after)
				},
	diff: diffList,
	coalesce: coalesceList
}

/** `run` with the kit of `shape`. */
const withKit = <A>(shape: ReadShape, run: <S extends ReadShape>(kit: Kit<S>) => A): A =>
	shape === "list" ? run(listKit) : run(setKit)

const valueOf = <S extends ReadShape>(
	kit: Kit<S>,
	fields: KeyFields,
	specs: ReadonlyArray<Spec>
): Keyed<S, Row> => Keyed.of(kit.shape, fields, Arr.map(specs, rowOf))

const specsIn = <S extends ReadShape>(value: Keyed<S, Row>): ReadonlyArray<Spec> =>
	Arr.map([...value], specOf)

/** The specs of a state's value, which must be ready. */
const readySpecs = <S extends ReadShape>(state: ReadState<S, Row>): ReadonlyArray<Spec> => {
	assert.equal(state.kind, "ready")
	return state.kind === "ready" ? specsIn(state.value) : []
}

/** A read's state of the kit's shape before its first event. */
const openingOf = <S extends ReadShape>(kit: Kit<S>): ReadState<S, Row> => opening(kit.shape)

/** The events of a read whose first run delivered `specs`, up to its ready. */
const openedEvents = <S extends ReadShape>(
	kit: Kit<S>,
	fields: KeyFields,
	specs: ReadonlyArray<Spec>
): ReadonlyArray<ReadEvent<S, Row>> => [kit.reset(fields), ...kit.rows(fields, specs)]

describe("the live model's values", () => {
	/** What a drawn change did to the model: features of the search. */
	type Applied =
		| "a remove of a present key"
		| "a remove of an absent key"
		| "a new upsert"
		| "an upsert in place"
		| "a move"
		| "a re-sent upsert"

	/** What `change` does to `model`, read off the model before it. */
	const appliedOf = (
		shape: ReadShape,
		model: ReadonlyArray<Spec>,
		change: ChangeSpec,
		previous: ChangeSpec | undefined
	): Applied => {
		if (change === previous) {
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
					shape === "list" && (model[at - 1]?.i ?? null) !== change.after
						? "a move"
						: "an upsert in place"
			}
		)
	}

	it.effect(
		"a read's events fold into the model's value, and a re-sent upsert changes nothing",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: { kind: "second-implementation", name: "the model's list or set of specs" },
						suite: "unit/live/fold-model",
						draw: drawn((s) => {
							const shape = s.draw(element(["set", "list"] as const))
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
								model = modelApply(shape, model, change)
							}
							return { shape, fields: s.draw(indexFieldsGen), start, changes }
						}),
						literal: Formatter.format,
						kept: [],
						runs: 400,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang,
						coverage: required<Applied>(
							[
								"a remove of a present key",
								"a remove of an absent key",
								"a new upsert",
								"an upsert in place",
								"a move",
								"a re-sent upsert"
							],
							{ cases: 400, sense: notesOnly }
						)
					},
					({ shape, fields, start, changes }, c) =>
						Effect.sync(() => {
							let model = start
							for (const [n, change] of changes.entries()) {
								c.note(appliedOf(shape, model, change, changes[n - 1]))
								model = modelApply(shape, model, change)
							}
							withKit(shape, (kit) => {
								const events = [
									...openedEvents(kit, fields, start),
									kit.ready,
									...Arr.map(changes, (change) => kit.change(fields, change))
								]
								sameSpecs(shape, readySpecs(fold(openingOf(kit), events)), model)
								const last = Arr.findLast(changes, (change) => change.kind === "upsert")
								if (Option.isSome(last)) {
									const again = [...events, kit.change(fields, last.value)]
									sameSpecs(shape, readySpecs(fold(openingOf(kit), again)), model)
								}
							})
						})
				)
			)
	)

	/** How a diff's rows stood against the value before it: features of the search. */
	type Diffed =
		| "a key gone"
		| "a new key"
		| "a changed row"
		| "an unchanged row moved"
		| "a whole-row key"

	/** The length of a longest strictly increasing subsequence of `places`: a quadratic program, a second count. */
	const longestIncreasing = (places: ReadonlyArray<number>): number => {
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

	it.effect("diff carries one value to the other with the least changes", (ctx) =>
		searched(
			ctx,
			explore(
				{
					oracle: {
						kind: "specification",
						name: "the next value, and the least changes counted by a longest increasing subsequence"
					},
					suite: "unit/live/diff",
					draw: drawn((s) => {
						const previous = s.draw(specsGen)
						return {
							shape: s.draw(element(["set", "list"] as const)),
							fields: s.draw(fieldsGen),
							previous,
							next: s.draw(nextGen(previous))
						}
					}),
					literal: Formatter.format,
					kept: [],
					runs: 400,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang,
					coverage: required<Diffed>(
						[
							"a key gone",
							"a new key",
							"a changed row",
							"an unchanged row moved",
							"a whole-row key"
						],
						{ cases: 400, sense: notesOnly }
					)
				},
				({ shape, fields, previous, next }, c) =>
					Effect.sync(() => {
						const was = new Map(
							Arr.map(previous, (spec, place) => [modelKey(fields, spec), { spec, place }] as const)
						)
						const kept = new Set(Arr.map(next, (spec) => modelKey(fields, spec)))
						const gone = Arr.filter(previous, (spec) => !kept.has(modelKey(fields, spec))).length
						let sent = 0
						const places: Array<number> = []
						for (const spec of next) {
							const before = was.get(modelKey(fields, spec))
							if (before === undefined || before.spec.p !== spec.p) {
								sent += 1
								c.note(before === undefined ? "a new key" : "a changed row")
							} else {
								places.push(before.place)
							}
						}
						const moved = shape === "list" ? places.length - longestIncreasing(places) : 0
						if (moved > 0) {
							c.note("an unchanged row moved")
						}
						if (gone > 0) {
							c.note("a key gone")
						}
						if (fields.includes("v")) {
							c.note("a whole-row key")
						}
						withKit(shape, (kit) => {
							const from = valueOf(kit, fields, previous)
							const changes = kit.diff(from, valueOf(kit, fields, next))
							sameSpecs(shape, specsIn(from.applying(changes)), next)
							assert.equal(Arr.filter(changes, (change) => change.kind === "remove").length, gone)
							assert.equal(
								Arr.filter(changes, (change) => change.kind === "upsert").length,
								sent + moved
							)
						})
					})
			)
		)
	)

	/** How two batches met: a key the first added and the second removed, or none. */
	type Coalesced = "a key added then removed" | "batches over other keys"

	it.effect("coalesce is the net change of two batches", (ctx) =>
		searched(
			ctx,
			explore(
				{
					oracle: { kind: "specification", name: "the value the second batch was diffed to" },
					suite: "unit/live/coalesce",
					draw: drawn((s) => {
						const base = s.draw(specsGen)
						const middle = s.draw(nextGen(base))
						return {
							shape: s.draw(element(["set", "list"] as const)),
							fields: s.draw(fieldsGen),
							base,
							middle,
							last: s.draw(nextGen(middle))
						}
					}),
					literal: Formatter.format,
					kept: [],
					runs: 400,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang,
					coverage: required<Coalesced>(["a key added then removed", "batches over other keys"], {
						cases: 400,
						sense: notesOnly
					})
				},
				({ shape, fields, base, middle, last }, c) =>
					Effect.sync(() => {
						const keys = (specs: ReadonlyArray<Spec>) =>
							new Set(Arr.map(specs, (spec) => modelKey(fields, spec)))
						const [inBase, inLast] = [keys(base), keys(last)]
						const passing = Arr.some(
							middle,
							(spec) => !inBase.has(modelKey(fields, spec)) && !inLast.has(modelKey(fields, spec))
						)
						c.note(passing ? "a key added then removed" : "batches over other keys")
						withKit(shape, (kit) => {
							const [from, to, end] = [
								valueOf(kit, fields, base),
								valueOf(kit, fields, middle),
								valueOf(kit, fields, last)
							]
							const [first, second] = [kit.diff(from, to), kit.diff(to, end)]
							sameSpecs(shape, specsIn(from.applying(first).applying(second)), last)
							sameSpecs(
								shape,
								specsIn(from.applying(kit.coalesce(from, [...first, ...second]))),
								last
							)
						})
					})
			)
		)
	)

	/** A read's stream as it ended: the paths fold must tell apart. */
	type Path =
		| "an error before reset"
		| "an error before ready"
		| "provisional at its end"
		| "ready, then live batches"
		| "an error after ready"

	const cut: CallError = callError("transport", { message: "the exchange broke" })

	it.effect("fold is a read's lifecycle, and a write's outcome is its value", (ctx) =>
		searched(
			ctx,
			explore(
				{
					oracle: {
						kind: "specification",
						name: "provisional from reset, a value from ready on, an error voiding any value"
					},
					suite: "unit/live/lifecycle",
					draw: drawn((s) => {
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
							shape: s.draw(element(["set", "list"] as const)),
							start,
							ready,
							batches,
							error: s.draw(element(["none", "before reset", "at the end"] as const))
						}
					}),
					literal: Formatter.format,
					kept: [],
					runs: 300,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang,
					coverage: required<Path>(
						[
							"an error before reset",
							"an error before ready",
							"provisional at its end",
							"ready, then live batches",
							"an error after ready"
						],
						{ cases: 300, sense: notesOnly }
					)
				},
				({ shape, start, ready, batches, error }, c) =>
					Effect.sync(() => {
						const fields: KeyFields = ["k"]
						withKit(shape, (kit) => {
							if (error === "before reset") {
								c.note("an error before reset")
								assert.deepEqual(fold(openingOf(kit), [kit.failed(cut), kit.end]), {
									kind: "failed",
									error: cut
								})
								return
							}
							let value = start
							const events: Array<ReadEvent<typeof kit.shape, Row>> = [
								...openedEvents(kit, fields, start)
							]
							if (ready) {
								events.push(kit.ready)
								for (const batch of batches) {
									for (const change of kit.diff(
										valueOf(kit, fields, value),
										valueOf(kit, fields, batch)
									)) {
										events.push(change)
									}
									events.push(kit.ready)
									value = batch
								}
							}
							if (error === "at the end") {
								events.push(kit.failed(cut), kit.end)
								c.note(ready ? "an error after ready" : "an error before ready")
								assert.deepEqual(fold(openingOf(kit), events), { kind: "failed", error: cut })
								return
							}
							const state = fold(openingOf(kit), events)
							if (ready) {
								c.note("ready, then live batches")
								sameSpecs(shape, readySpecs(state), value)
								sameSpecs(shape, readySpecs(fold(state, [kit.ready, kit.ready])), value)
								return
							}
							c.note("provisional at its end")
							assert.equal(state.kind, "provisional")
							sameSpecs(shape, state.kind === "provisional" ? specsIn(state.value) : [], value)
						})
						const outcome = { kind: "unchanged", reads: start } as const
						const answer: ReadonlyArray<WriteEvent<typeof outcome>> =
							error === "none"
								? [{ kind: "outcome", outcome }, { kind: "end" }]
								: [{ kind: "error", error: cut }, { kind: "end" }]
						assert.deepEqual(
							foldWrite(writeOpening<typeof outcome>(), answer),
							error === "none" ? { kind: "ready", value: outcome } : { kind: "failed", error: cut }
						)
					})
			)
		)
	)

	/**
	 * Values of every form a key takes, each a maker with its key class, PostgreSQL's equality, and its delivery,
	 * Object.is on primitives: ±0 one key of two deliveries, a Decimal one value however written.
	 */
	const forms: Arr.NonEmptyReadonlyArray<{
		readonly key: number
		readonly delivery: number
		readonly make: () => unknown
	}> = [
		{ key: 0, delivery: 0, make: () => 0 },
		{ key: 0, delivery: 1, make: () => -0 },
		{ key: 1, delivery: 2, make: () => Number.NaN },
		{ key: 1, delivery: 2, make: () => Number.parseFloat("x") },
		{ key: 2, delivery: 3, make: () => 1 },
		{ key: 3, delivery: 4, make: () => 1n },
		{ key: 4, delivery: 5, make: () => "1" },
		{ key: 5, delivery: 6, make: () => true },
		{ key: 6, delivery: 7, make: () => Decimal.of("1.5") },
		{ key: 6, delivery: 7, make: () => Decimal.of("1.50") },
		{ key: 7, delivery: 8, make: () => Decimal.of("15") },
		{ key: 8, delivery: 9, make: () => ({ start: 1, end: 2 }) },
		{ key: 9, delivery: 10, make: () => ({ start: 1, end: 3 }) },
		{ key: 10, delivery: 11, make: () => new Set(["x", "y"]) },
		{ key: 11, delivery: 12, make: () => new Set(["x"]) },
		{ key: 12, delivery: 13, make: () => Uint8Array.of(1, 2) },
		{ key: 13, delivery: 14, make: () => Float32Array.of(1, 2) },
		{ key: 14, delivery: 15, make: () => [1, 2] },
		{ key: 15, delivery: 16, make: () => [[1], 2] },
		{ key: 16, delivery: 17, make: () => ({ a: 1 }) },
		{ key: 17, delivery: 18, make: () => ["a", 1] }
	]

	/** How two forms stood: one delivery, one key of two deliveries, or two keys. */
	type Compared = "one delivery" | "one key, two deliveries" | "two keys"

	it.effect("keys compare by value, and rows by what they deliver", (ctx) =>
		searched(
			ctx,
			exhaust(
				{
					suite: "unit/live/key-forms",
					generator: (source) => ({
						left: int(0, forms.length - 1)(source),
						right: int(0, forms.length - 1)(source)
					}),
					literal: Formatter.format,
					limit: forms.length * forms.length,
					box: "every pair of the key forms' makers",
					oracle: {
						kind: "specification",
						name: "the dictionary's key classes and deliveries, by construction"
					},
					coverage: requiredInSpace<Compared>([
						"one delivery",
						"one key, two deliveries",
						"two keys"
					]),
					caseHang
				},
				({ left, right }, c) =>
					Effect.sync(() => {
						const [a, b] = [forms[left], forms[right]]
						assert.ok(a !== undefined && b !== undefined, "two makers")
						const index = new TupleMap<ReadonlyArray<unknown>, true>()
						index.set(formOf(RowKey([a.make()])), true)
						assert.equal(index.has(formOf(RowKey([b.make()]))), a.key === b.key)
						assert.equal(sameValue(a.make(), b.make()), a.delivery === b.delivery)
						c.note(
							a.delivery === b.delivery
								? "one delivery"
								: a.key === b.key
									? "one key, two deliveries"
									: "two keys"
						)
					})
			)
		)
	)
})
