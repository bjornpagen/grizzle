/**
 * A steered phase's seeds (seeds.ts): a case is kept exactly when it noted or perceived something no kept case had,
 * and a pick names only what was kept. Oracle: stated in the search.
 *
 * Plant: ~/.cache/grizzle-release/BR07/plants/seeds-keep-every-note.patch (every noted case kept) turns the property
 * red.
 */
import { describe, it } from "@effect/vitest"
import { assertTrue, deepStrictEqual } from "@effect/vitest/utils"
import { Array as Arr, Duration, Effect, Formatter, Option } from "effect"
import { drawn, explore } from "#explore.ts"
import { required } from "#features.ts"
import { array, type Gen, int, subarray } from "#gen.ts"
import { wordsOf } from "#random.ts"
import { seedsOf } from "#seeds.ts"
import { TRACE_CLASSES } from "#sense.ts"
import { notesOnly } from "#sense.ts"
import { completeShrink } from "#shrink.ts"
import { generate, randomChooser, recorder } from "#source.ts"
import type { Tape } from "#tape.ts"
import { searched } from "#vitest/searched.ts"

const NOTES = ["a", "b", "c", "d"] as const

/** One passing case as the seed corpus is handed it: the notes it noted, and the class it perceived at each range. */
type Perceived = Readonly<{ notes: ReadonlyArray<string>; trace: ReadonlyArray<number> }>

const perceived: Gen<Perceived> = (source) => ({
	notes: source.draw(subarray(NOTES)),
	trace: source.draw(array(int(0, TRACE_CLASSES), { min: 0, max: 4 }))
})

/** A tape for the corpus to hold: what it holds does not matter to what it is kept for. */
const tapeOf = (index: number): Tape =>
	generate(recorder(), int(0, 9), randomChooser(wordsOf(index))).tape

describe("the seed corpus", () => {
	it.effect(
		"keeps a case exactly when it noted or perceived something new, and picks only what it kept",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "seed corpus",
						oracle: {
							kind: "second-implementation",
							name: "a set of the notes and of the (range, class) pairs seen so far"
						},
						draw: drawn(array(perceived, { min: 0, max: 8 })),
						literal: Formatter.format,
						coverage: required<
							"a case kept for being first" | "a case new by its trace" | "a case not new"
						>(["a case kept for being first", "a case new by its trace", "a case not new"], {
							cases: 200,
							sense: notesOnly
						}),
						kept: [],
						runs: 200,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang: Duration.minutes(1)
					},
					(cases, c) =>
						Effect.sync(() => {
							const corpus = seedsOf()
							const seenNotes = new Set<string>()
							const seenClasses = new Set<string>()
							const kept: Array<Tape> = []
							for (const [index, { notes, trace }] of cases.entries()) {
								const classes = Arr.flatMap(trace, (traced, range) =>
									traced === 0 ? [] : [`${range} ${traced}`]
								)
								const byTrace = Arr.some(classes, (key) => !seenClasses.has(key))
								const novel = Arr.some(notes, (note) => !seenNotes.has(note)) || byTrace
								const tape = tapeOf(index)
								if (novel || kept.length === 0) {
									kept.push(tape)
								}
								if (!novel) {
									c.note(
										kept.length === 1 && index === 0
											? "a case kept for being first"
											: "a case not new"
									)
								} else if (byTrace) {
									c.note("a case new by its trace")
								}
								deepStrictEqual(corpus.keep(tape, new Set(notes), Uint8Array.from(trace)), novel)
								for (const note of notes) {
									seenNotes.add(note)
								}
								for (const key of classes) {
									seenClasses.add(key)
								}
							}
							deepStrictEqual(corpus.size(), kept.length)
							const pick = corpus.picker([])(wordsOf(cases.length))
							deepStrictEqual(Option.isSome(pick), kept.length > 0)
							if (Option.isSome(pick)) {
								const [seed, donor] = pick.value
								assertTrue(
									Arr.contains(kept, seed) && Arr.contains(kept, donor),
									"a pick is a kept seed and a kept donor"
								)
							}
						})
				)
			)
	)
})
