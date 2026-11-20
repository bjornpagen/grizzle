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
 */
import { assert, defined } from "@bjornpagen/testing/assert"
import { word } from "@bjornpagen/testing/dictionary"
import type { Reached } from "@bjornpagen/testing/features"
import { array, boolean, finite, int, subset } from "@bjornpagen/testing/gen"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { TextsMap } from "#compiler/core/text.ts"
import {
	fold,
	foldWrite,
	formOf,
	type KeyFields,
	Keyed,
	type ReadEvent,
	RowKey,
	type SetChange,
	sameValue,
	type WriteEvent,
	writeOpening
} from "#compiler/live/index.ts"
import { lengthHashedKeyings, longFamily } from "#test/support/kernel/long-keys.ts"
import { upTo } from "#test/support/up-to.ts"
import { forms } from "#test/unit/live/values.dictionary.ts"
import {
	type Applied,
	appliedOf,
	coalesceGen,
	type Coalesced,
	type Compared,
	cut,
	type Diffed,
	diffGen,
	foldModelGen,
	lifecycleGen,
	longestIncreasing,
	modelApply,
	modelKey,
	openedEvents,
	openingOf,
	type Path,
	readySpecs,
	type Row,
	sameSpecs,
	type Spec,
	specsIn,
	valueOf,
	withKit
} from "#test/unit/live/values.fixtures.ts"

/**
 * A read's events fold into the live model's value, and a re-sent upsert changes nothing.
 *
 * Budget: its suite's count before the conversion (unit/live/fold-model: 400 independent cases and 0 steered, Vitest
 * at grizzle 4ca3036a).
 */
export const theLiveModelsValuesAReadsEventsFoldIntoTheModelsValueAndAReSentUpsertChangesNothing =
	property.explore(foldModelGen, {
		needs: {},
		situations: [
			"a remove of a present key",
			"a remove of an absent key",
			"a new upsert",
			"an upsert in place",
			"a move",
			"a re-sent upsert"
		] satisfies ReadonlyArray<Reached<Applied>>,
		check:
			(_, c: Case<Applied>) =>
			({ shape, fields, start, changes }) =>
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
						const last = changes.at(-1)
						if (last?.kind !== "upsert") {
							return
						}
						const again = [...events, kit.change(fields, last)]
						sameSpecs(shape, readySpecs(fold(openingOf(kit), again)), model)
					})
				}),
		oracle: { kind: "second-implementation", name: "the model's list or set of specs" },
		budget: { runs: 400, steered: 0 },
		kept: [
			{
				token: ReplayToken(
					"test/unit/live/values.test.ts#theLiveModelsValuesAReadsEventsFoldIntoTheModelsValueAndAReSentUpsertChangesNothing:-:0.0.5.0.0.1.0.0.1.1.0.0.1.1.0.0.1.0.0.0"
				),
				reason:
					"an upsert re-sent twice and then removed: the remove takes its key out, and no upsert is re-sent past a later change",
				since: "2026-11-11"
			},
			{
				token: ReplayToken(
					"test/unit/live/values.test.ts#theLiveModelsValuesAReadsEventsFoldIntoTheModelsValueAndAReSentUpsertChangesNothing:-:1.4.0.0.0.0.0.0.0.0.7.1.0.0.0.1.1.8.0.0.0.1.0.0.0.0.1.0.0.1.1.0.8.0"
				),
				reason:
					"a list's last upsert follows a key a later remove takes out: a re-send is only of the stream's last change",
				since: "2026-11-11"
			}
		],
		kills: [
			{
				file: "packages/engine/src/scalar/values/decimal.ts",
				original: "const isDigit = (code: number): boolean => code >= 0x30 && code <= 0x39",
				replacement: "const isDigit = (code: number): boolean => code < 0x30 && code <= 0x39",
				why: "Operator mutant (comparison) at packages/engine/src/scalar/values/decimal.ts:42 in isDigit: `>=` becomes `<`; the property fails (lane CATCH, grizzle 0baff5d6)."
			}
		]
	})

/**
 * diff carries one value of the live model to the other with the least changes.
 *
 * Budget: its suite's count before the conversion (unit/live/diff: 400 independent cases and 0 steered, Vitest at
 * grizzle 4ca3036a).
 */
export const theLiveModelsValuesDiffCarriesOneValueToTheOtherWithTheLeastChanges = property.explore(
	diffGen,
	{
		needs: {},
		situations: [
			"a key gone",
			"a new key",
			"a changed row",
			"an unchanged row moved",
			"a whole-row key"
		] satisfies ReadonlyArray<Reached<Diffed>>,
		check:
			(_, c: Case<Diffed>) =>
			({ shape, fields, previous, next }) =>
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
				}),
		oracle: {
			kind: "specification",
			name: "the next value, and the least changes counted by a longest increasing subsequence"
		},
		budget: { runs: 400, steered: 0 },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/live/fold.ts",
				original: "\tfor (const k of longestIncreasing(places)) {",
				replacement: "\tfor (const k of places.keys()) {",
				why: "A list's diff sends no unchanged row whose order moved; the diff's property fails."
			},
			{
				file: "packages/engine/src/live/fold.ts",
				original: "\t\tif (next.at(entry.form) === undefined) {",
				replacement: "\t\tif (next.at(entry.form) === null) {",
				why: "A diff sends no remove (live/fold.ts removals reads an absent key as null, never as undefined), so a row the value lost stays folded in; the diff property fails, and coalesce and fold with it."
			}
		]
	}
)

/**
 * coalesce is the net change of two batches of the live model.
 *
 * Budget: its suite's count before the conversion (unit/live/coalesce: 400 independent cases and 0 steered, Vitest at
 * grizzle 4ca3036a).
 */
export const theLiveModelsValuesCoalesceIsTheNetChangeOfTwoBatches = property.explore(coalesceGen, {
	needs: {},
	situations: ["a key added then removed", "batches over other keys"] satisfies ReadonlyArray<
		Reached<Coalesced>
	>,
	check:
		(_, c: Case<Coalesced>) =>
		({ shape, fields, base, middle, last }) =>
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
					sameSpecs(shape, specsIn(from.applying(kit.coalesce(from, [...first, ...second]))), last)
				})
			}),
	oracle: { kind: "specification", name: "the value the second batch was diffed to" },
	budget: { runs: 400, steered: 0 },
	kept: [],
	kills: [
		{
			file: "packages/engine/src/live/fold.ts",
			original: "): ReadonlyArray<SetChange<Row>> => diffSet(base, base.applying(pending))",
			replacement:
				"): ReadonlyArray<SetChange<Row>> => diffSet(base, base.applying([...pending].toReversed()))",
			why: "coalesce applies a set's pending changes last first, so it keeps a key's upsert past its later remove; the coalesce property fails."
		},
		{
			file: "packages/engine/src/live/fold.ts",
			original: "\t\tif (next.at(entry.form) === undefined) {",
			replacement: "\t\tif (next.at(entry.form) === null) {",
			why: "A diff sends no remove (live/fold.ts removals reads an absent key as null, never as undefined), so a row the value lost stays folded in; the diff property fails, and coalesce and fold with it."
		}
	]
})

/**
 * fold is a read's lifecycle, and a write's outcome is its value.
 *
 * Budget: its suite's count before the conversion (unit/live/lifecycle: 300 independent cases and 0 steered, Vitest at
 * grizzle 4ca3036a).
 */
export const theLiveModelsValuesFoldIsAReadsLifecycleAndAWritesOutcomeIsItsValue = property.explore(
	lifecycleGen,
	{
		needs: {},
		situations: [
			"an error before reset",
			"an error before ready",
			"provisional at its end",
			"ready, then live batches",
			"an error after ready"
		] satisfies ReadonlyArray<Reached<Path>>,
		check:
			(_, c: Case<Path>) =>
			({ shape, start, ready, batches, error }) =>
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
				}),
		oracle: {
			kind: "specification",
			name: "provisional from reset, a value from ready on, an error voiding any value"
		},
		budget: { runs: 300, steered: 0 },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/live/fold.ts",
				original: "\t\tif (next.at(entry.form) === undefined) {",
				replacement: "\t\tif (next.at(entry.form) === null) {",
				why: "A diff sends no remove (live/fold.ts removals reads an absent key as null, never as undefined), so a row the value lost stays folded in; the diff property fails, and coalesce and fold with it."
			}
		]
	}
)

/** Keys of the live model compare by value, and rows by what they deliver. */
export const theLiveModelsValuesKeysCompareByValueAndRowsByWhatTheyDeliver = property.exhaust(
	finite((source) => ({ left: source.draw(word(forms)), right: source.draw(word(forms)) })),
	{
		needs: {},
		situations: ["one delivery", "one key, two deliveries", "two keys"] satisfies ReadonlyArray<
			Reached<Compared>
		>,
		check:
			(_, c: Case<Compared>) =>
			({ left, right }) =>
				Effect.sync(() => {
					const [a, b] = [left, right]
					const index = new TextsMap<true>()
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
				}),
		oracle: {
			kind: "specification",
			name: "the dictionary's key classes and deliveries, by construction"
		},
		box: "every pair of the key forms' makers",
		show: ({ left, right }) => `${String(left.make)} beside ${String(right.make)}`,
		kept: [],
		kills: [
			{
				file: "packages/engine/src/core/text.ts",
				original: "\thas(key: TextsId): boolean {\n\t\treturn this.#found(key) !== undefined\n\t}",
				replacement: "\thas(key: TextsId): boolean { return true }",
				why: "A map of forms holds every form: two keys of two classes are one; the property fails."
			},
			{
				file: "packages/engine/src/live/key.ts",
				original: "\t\t\tinto.shape.push(formWords.bigint, value.toString(), formEnd)",
				replacement: "\t\t\tinto.shape.push(formWords.number, value.toString(), formEnd)",
				why: "A bigint's form is spelled as a number's: 1 and 1n, two keys, are one form; the property fails."
			}
		]
	}
)

/** What a case of the long-keys property shows. */
type LongKeyed = "a key upserted again in place" | "a key removed" | "a key added"

/**
 * A live set keys no native Map or Set by a key V8 hashes by its length alone: a set read's value keyed by one text
 * field (live/keyed.ts Keyed), holding rows keyed by a family of two to four distinct texts of one length past 16,383
 * units (kernel/long-keys.ts longFamily) and then a drawn run of upserts and removes of them applied, holds each key's
 * last row exactly where the model of the run does, in place for a key it held, and no native Map or Set was keyed by
 * such a text (kernel/long-keys.ts lengthHashedKeyings): a value's rows are held by their keys' forms in a TextsMap
 * (core/text.ts), which hashes each by its digest, where a trie of the key's values was a native Map per value, one
 * chain of such keys.
 *
 * Budget: 40 independent cases and 0 steered, each a few long keys.
 */
export const aLiveSetKeysNoNativeMapByAKeyV8HashesByItsLength = property.explore(
	(s) => {
		const family = longFamily(s.draw(int(2, 4)))
		const text = int(0, family.length - 1)
		return {
			family,
			start: s.draw(
				subset(
					upTo(family.length, (n) => n),
					{ min: 0, max: family.length }
				)
			),
			changes: s.draw(
				array((t) => ({ remove: t.draw(boolean), at: t.draw(text), payload: t.draw(int(0, 9)) }), {
					min: 1,
					max: 6
				})
			)
		}
	},
	{
		needs: {},
		situations: [
			"a key upserted again in place",
			"a key removed",
			"a key added"
		] satisfies ReadonlyArray<Reached<LongKeyed>>,
		check:
			(_, c: Case<LongKeyed>) =>
			({ family, start, changes }) =>
				Effect.gen(function* () {
					const textOf = (at: number): string => defined(family[at], "a text of the family")
					const fields: KeyFields = ["k"]
					const model = new Map<number, number>(Arr.map(start, (at) => [at, 0] as const))
					for (const change of changes) {
						if (change.remove) {
							c.note("a key removed")
							model.delete(change.at)
						} else {
							c.note(model.has(change.at) ? "a key upserted again in place" : "a key added")
							model.set(change.at, change.payload)
						}
					}
					const [rows, keyings] = yield* lengthHashedKeyings(
						Effect.sync(() =>
							Arr.map(
								[
									...Keyed.of<"set", { readonly k: string; readonly v: number }>(
										"set",
										fields,
										Arr.map(start, (at) => ({ k: textOf(at), v: 0 }))
									).applying(
										Arr.map(
											changes,
											(change): SetChange<{ readonly k: string; readonly v: number }> =>
												change.remove
													? { kind: "remove", key: RowKey([textOf(change.at)]) }
													: { kind: "upsert", row: { k: textOf(change.at), v: change.payload } }
										)
									)
								],
								(row) => [row.k, row.v] as const
							)
						)
					)
					assert.equal(keyings, 0, "no native Map or Set keyed by a key past the hashed length")
					assert.deepEqual(
						rows,
						Arr.map([...model], ([at, v]) => [textOf(at), v] as const),
						"each key's last row, in place where the value held it"
					)
				}),
		oracle: { kind: "specification", name: "a set's rows by key, each upserted in place or last" },
		budget: { runs: 40, steered: 0 },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/core/text.ts",
				original: "\treturn mintTextsId({ texts, digest: digest | 0, belowSurrogates })",
				replacement:
					'\treturn mintTextsId({ texts, digest: texts.join("\\u0000"), belowSurrogates })',
				why: "A TextsMap keys its buckets by an identity's texts joined, a native Map of strings, as the value's trie of key values did: a family of keys past the hashed length keys a native Map by each, one chain."
			}
		]
	}
)
