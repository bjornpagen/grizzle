import { Array as Arr, Option } from "effect"
import type { SteeringPhase, Tally } from "#features.ts"
import { between, type Words } from "#random.ts"
import { TRACE_CLASSES } from "#sense.ts"
import type { Tape } from "#tape.ts"

/** A note some case noted, and the seeds that hold it, by their place among the seeds. */
type Noted = Readonly<{ kind: "note"; note: string; seeds: Array<number> }>

/** A class of a range some case perceived, the seeds that hold it, and how many cases perceived it, kept or not. */
type Perceived = { readonly kind: "perceived"; readonly seeds: Array<number>; cases: number }

/** Something a seed holds, in the order its search first saw it. */
type Held = Noted | Perceived

const WORD_SCALE = 0x1_0000_0000

/**
 * The seeds a steered search keeps, and what each holds. `keep` keeps a passing case as a seed when it noted a
 * situation or perceived a class of a range no earlier case had, or when no seed is kept yet, and says whether it was
 * new; `picker` freezes what the search has seen so far into the pick of one window. Nothing a seed perceived is stored
 * with it: as AFL's virgin map marks each edge and bucket once, a run-wide table numbers each class of each range the
 * first time a case perceives it, and a kept seed is appended once to the holders of each thing it holds.
 */
export type Seeds = Readonly<{
	keep: (tape: Tape, notes: ReadonlySet<string>, trace: Uint8Array) => boolean
	picker: (
		tallies: ReadonlyArray<Tally<SteeringPhase>>
	) => (words: Words) => Option.Option<readonly [seed: Tape, donor: Tape]>
	size: () => number
}>

/**
 * A steered search's seeds, none kept yet. A pick chooses something seen first, each in inverse proportion to how many
 * cases reached it, then a seed that holds it, as AFL favours the inputs that cover its rarest edges: the frontier stays
 * favoured however often it is reached, since it is still rarer than what every case reaches, and a seed that merely
 * came first does not crowd out the one that went deeper. A note's count is its tallies', a class's the cases that
 * perceived it. Seeds that hold nothing are picked evenly, and so is the donor a mutation splices from.
 */
export const seedsOf = (): Seeds => {
	const corpus: Array<Tape> = []
	const held: Array<Held> = []
	const notes = new Map<string, Noted>()
	const classes: Array<Perceived> = []
	let slots = new Int32Array(0)
	const notedAs = (note: string): Noted => {
		const known = notes.get(note)
		if (known !== undefined) {
			return known
		}
		const first: Noted = { kind: "note", note, seeds: [] }
		notes.set(note, first)
		held.push(first)
		return first
	}
	const perceivedAt = (slot: number) => Arr.getUnsafe(classes, (slots[slot] ?? 0) - 1)
	const keep = (tape: Tape, noted: ReadonlySet<string>, trace: Uint8Array): boolean => {
		let novel = false
		const holding: Array<Array<number>> = []
		for (const note of noted) {
			novel = novel || !notes.has(note)
			holding.push(notedAs(note).seeds)
		}
		if (trace.length * TRACE_CLASSES > slots.length) {
			const grown = new Int32Array(Math.max(trace.length * TRACE_CLASSES, slots.length * 2))
			grown.set(slots)
			slots = grown
		}
		for (let range = 0; range < trace.length; range += 1) {
			const traced = trace[range] ?? 0
			if (traced === 0) {
				continue
			}
			const slot = range * TRACE_CLASSES + traced - 1
			if ((slots[slot] ?? 0) === 0) {
				novel = true
				const first: Perceived = { kind: "perceived", seeds: [], cases: 0 }
				classes.push(first)
				held.push(first)
				slots[slot] = classes.length
			}
			perceivedAt(slot).cases += 1
		}
		if (novel || corpus.length === 0) {
			const index = corpus.length
			corpus.push(tape)
			for (const seeds of holding) {
				seeds.push(index)
			}
			for (let range = 0; range < trace.length; range += 1) {
				const traced = trace[range] ?? 0
				if (traced !== 0) {
					perceivedAt(range * TRACE_CLASSES + traced - 1).seeds.push(index)
				}
			}
		}
		return novel
	}
	const picker = (tallies: ReadonlyArray<Tally<SteeringPhase>>) => {
		const reached = (holder: Held) =>
			holder.kind === "perceived"
				? holder.cases
				: Arr.reduce(tallies, 0, (total, tally) => total + (tally.counts.get(holder.note) ?? 0))
		const weighted = Arr.map(
			held,
			(holder) => [holder.seeds, 1 / Math.max(1, reached(holder))] as const
		)
		const total = Arr.reduce(weighted, 0, (sum, [, weight]) => sum + weight)
		return (words: Words): Option.Option<readonly [seed: Tape, donor: Tape]> => {
			if (corpus.length === 0) {
				return Option.none()
			}
			const donor = Arr.getUnsafe(corpus, between(words, 0, corpus.length - 1))
			let rest = (words.next() / WORD_SCALE) * total
			for (const [holders, weight] of weighted) {
				if (rest < weight) {
					return Option.some([
						Arr.getUnsafe(corpus, Arr.getUnsafe(holders, between(words, 0, holders.length - 1))),
						donor
					])
				}
				rest -= weight
			}
			return Option.some([Arr.getUnsafe(corpus, between(words, 0, corpus.length - 1)), donor])
		}
	}
	return { keep, picker, size: () => corpus.length }
}
