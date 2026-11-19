/**
 * The map keyed by tuples (packages/engine/src/core/tuple-map.ts): two keys are one exactly when they hold equal
 * elements in order, each pair as a Map compares its keys, whatever array holds them; iteration is in insertion order,
 * each key as it was first set, and an entry set again keeps its place.
 *
 * - Property: over drawn programs of sets and deletes, each key built afresh from a few elements (texts, 0, -0, NaN,
 *   1) and up to three long, so keys share prefixes, end where others go on and hold NaN, after every step the map
 *   answers get, has and size as the model does for every key the program names, and iterates the model's keys, by
 *   reference, and values in its order.
 * - Oracle: a list of entries in insertion order, each key compared element by element by SameValueZero, the
 *   definition a Map keyed by each tuple's elements would give.
 *
 * Features: a key that shares a prefix with another, a key that ends where another goes on, a key holding NaN found by
 * another array, a key deleted and set again, a key set again in place.
 */

import { TupleMap } from "@bjornpagen/grizzle-text/base/tuple-map"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import { assert } from "#test/support/assert.ts"
import {
	type ModelEntry,
	prefixOf,
	programGen,
	sameKey,
	sharePrefix,
	type TupleMapFeature
} from "#test/unit/core/tuple-map.fixtures.ts"

/** A TupleMap answers every program of sets and deletes as a list of entries compared by SameValueZero does. */
export const aTupleMapAnswersEveryProgramOfSetsAndDeletesAsAListOfEntriesComparedBySameValueZeroDoes =
	property.explore(programGen, {
		needs: {},
		situations: [
			"a key that shares a prefix with another",
			"a key that ends where another goes on",
			"a key holding NaN found by another array",
			"a key deleted and set again",
			"a key set again in place"
		] satisfies ReadonlyArray<Reached<TupleMapFeature>>,
		check: (_, c: Case<TupleMapFeature>) => (program) =>
			Effect.sync(() => {
				const map = new TupleMap<ReadonlyArray<unknown>, number>()
				const model: Array<ModelEntry> = []
				const deleted: Array<ReadonlyArray<unknown>> = []
				for (const [at, step] of program.entries()) {
					const held = Option.getOrUndefined(
						Arr.findFirstIndex(model, (e) => sameKey(e.key, step.key))
					)
					const entry = held === undefined ? undefined : model[held]
					if (step.kind === "set") {
						if (Arr.some(model, (e) => sharePrefix(e.key, step.key))) {
							c.note("a key that shares a prefix with another")
						}
						if (Arr.some(model, (e) => prefixOf(e.key, step.key) || prefixOf(step.key, e.key))) {
							c.note("a key that ends where another goes on")
						}
						if (Arr.some(deleted, (k) => sameKey(k, step.key)) && entry === undefined) {
							c.note("a key deleted and set again")
						}
						if (entry === undefined) {
							model.push({ key: step.key, value: step.value })
						} else {
							c.note("a key set again in place")
							if (Arr.some(step.key, (x) => Number.isNaN(x))) {
								c.note("a key holding NaN found by another array")
							}
							entry.value = step.value
						}
						assert.equal(map.set(step.key, step.value), map, "set returns the map")
					} else {
						if (held !== undefined) {
							model.splice(held, 1)
							deleted.push(step.key)
						}
						assert.equal(
							map.delete(step.key),
							entry !== undefined,
							`step ${at}: delete of ${Formatter.format(step.key)}`
						)
					}
					assert.equal(map.size, model.length, `step ${at}: the size`)
					for (const other of program) {
						const found = Option.getOrUndefined(
							Arr.findFirst(model, (e) => sameKey(e.key, other.key))
						)
						assert.equal(
							map.get(other.key),
							found?.value,
							`step ${at}: get of ${Formatter.format(other.key)}`
						)
						assert.equal(
							map.has(other.key),
							found !== undefined,
							`step ${at}: has of ${Formatter.format(other.key)}`
						)
					}
					const keys = Arr.fromIterable(map.keys())
					assert.ok(
						keys.length === model.length && Arr.every(keys, (k, i) => k === model[i]?.key),
						`step ${at}: the keys in insertion order, each as it was first set`
					)
					const values = Arr.fromIterable(map.values())
					assert.ok(
						values.length === model.length && Arr.every(values, (v, i) => v === model[i]?.value),
						`step ${at}: the values in insertion order`
					)
					assert.ok(
						Arr.every(Arr.fromIterable(map), ([k, v], i) =>
							Option.match(Arr.get(model, i), {
								onNone: () => false,
								onSome: (e) => k === e.key && v === e.value
							})
						),
						`step ${at}: the entries in insertion order`
					)
				}
			}),
		oracle: {
			kind: "specification",
			name: "a list of entries in insertion order, each key compared element by element by SameValueZero"
		},
		kept: [],
		kills: [
			{
				file: "packages/text/src/base/tuple-map.ts",
				original: "return sameFrom(child.key, key, depth + 1) ? child : undefined",
				replacement: "return child",
				why: "A key found by its first element alone: a lookup of a key that shares only a prefix with the one held answers that one's value."
			},
			{
				file: "packages/text/src/base/tuple-map.ts",
				original: "Number.isNaN(x) && Number.isNaN(y)",
				replacement: "false",
				why: "NaN unequal to itself past a key's first element: a key holding NaN there is not found by another array."
			},
			{
				file: "packages/text/src/base/tuple-map.ts",
				original: "branch.end = child",
				replacement: "branch.children.set(child.key[depth], child)",
				why: "A key moved below a branch it ends at is held as a child, so a key that ends where another goes on is lost."
			}
		]
	})
