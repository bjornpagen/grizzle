import { Brand } from "effect"

/**
 * The 32-bit finalizer of MurmurHash3: a bijection that spreads every input bit over the output. Stream seeds are mixed
 * from seeds with it, so neighbouring seeds draw unrelated streams.
 */
export const mix = (input: number): number => {
	let h = input >>> 0
	h ^= h >>> 16
	h = Math.imul(h, 0x85eb_ca6b)
	h ^= h >>> 13
	h = Math.imul(h, 0xc2b2_ae35)
	h ^= h >>> 16
	return h >>> 0
}

const utf8 = new TextEncoder()

/** FNV-1a over a label's UTF-8 bytes: the digest a floor seed is mixed from, so the label alone fixes it. */
export const fnv1a32 = (label: string): number => {
	let h = 0x811c_9dc5
	for (const byte of utf8.encode(label)) {
		h ^= byte
		h = Math.imul(h, 0x0100_0193)
	}
	return h >>> 0
}

/** A stream the suite's label alone fixes: the same cases on every run seed. */
export type LabelStream = number & Brand.Brand<"LabelStream">

/** A stream the run's seed draws: new cases on every run. */
export type RunStream = number & Brand.Brand<"RunStream">

/** Either kind of stream, where a case only needs one to regenerate from. */
export type Stream = LabelStream | RunStream

const labelStream = Brand.nominal<LabelStream>()

const runStream = Brand.nominal<RunStream>()

/** Separates the steered phase's stream from the floor stream it grows from. */
const STEER_SALT = 0x5bd1_e995

/** Separates a fuzz run's stream from the rotating stream it is derived from. */
const FUZZ_SALT = 0x27d4_eb2f

/** A suite's floor seed: derived from its label alone, the same on every run, so its floor stream is a fixed baseline. */
export const floorSeed = (label: string): LabelStream => labelStream(mix(fnv1a32(label)))

/** The steered phase's stream: derived from the floor's, so a suite's label fixes it too. */
export const steeredSeed = (floor: LabelStream): LabelStream => labelStream(mix(floor ^ STEER_SALT))

/** A suite's rotating seed: a different stream for every run seed and every floor seed. */
export const rotatingSeed = (run: number, floor: LabelStream): RunStream =>
	runStream(mix(mix(run) ^ Math.imul(floor >>> 0, 0x9e37_79b1)))

/** A fuzz run's stream: derived from the rotating one, so every fuzz run searches afresh. */
export const fuzzSeed = (rotating: RunStream): RunStream => runStream(mix(rotating ^ FUZZ_SALT))

/** One case's seed within a stream: every case regenerates from its stream's seed and its index alone. */
export const caseSeed = (stream: Stream, index: number): number =>
	mix(stream ^ Math.imul(index + 1, 0x9e37_79b9))

/** A deterministic source of unsigned 32-bit words. */
export type Words = Readonly<{ next: () => number }>

const rotl = (x: number, k: number): number => (x << k) | (x >>> (32 - k))

/**
 * xoshiro128** seeded through splitmix32: fast, small-state, and the same generator Effect's own property runner uses.
 * https://prng.di.unimi.it/xoshiro128starstar.c
 */
export const wordsOf = (seed: number): Words => {
	let split = seed >>> 0
	const splitmix = (): number => {
		split = (split + 0x9e37_79b9) >>> 0
		let z = split
		z = Math.imul(z ^ (z >>> 16), 0x85eb_ca6b)
		z = Math.imul(z ^ (z >>> 13), 0xc2b2_ae35)
		return (z ^ (z >>> 16)) >>> 0
	}
	let a = splitmix()
	let b = splitmix()
	let c = splitmix()
	let d = splitmix()
	return {
		next: () => {
			const result = Math.imul(rotl(Math.imul(b, 5), 7), 9) >>> 0
			const t = b << 9
			c ^= a
			d ^= b
			b ^= c
			a ^= d
			c ^= t
			d = rotl(d, 11)
			return result
		}
	}
}

const WORD_RANGE = 0x1_0000_0000

/**
 * A whole number between `lo` and `hi`, inclusive, uniformly: rejection sampling keeps every value equally likely, so
 * no option is favoured by the encoding. A range of one value draws no word. A range is at most 2^32 values; wider values
 * are composed from several choices.
 */
export const between = (words: Words, lo: number, hi: number): number => {
	const range = hi - lo + 1
	if (range === 1) {
		return lo
	}
	if (range >= WORD_RANGE) {
		return lo + words.next()
	}
	const limit = WORD_RANGE - (WORD_RANGE % range)
	let word = words.next()
	while (word >= limit) {
		word = words.next()
	}
	return lo + (word % range)
}

/** The widest range a random search draws uniformly; a wider one leans toward its ends. */
const EVEN_RANGE = 256

/**
 * A whole number between `lo` and `hi`, inclusive, as a random search draws it. A range of at most 256 values is drawn
 * uniformly. A wider one sends one draw in eight to one of its ends, at a distance drawn on a logarithmic scale, so
 * zero, one, the extremes and the values next to them come up in every run, where a uniform draw over a wide range
 * almost never reaches them, and they are where code branches. Only the random search leans: a replay, an enumeration
 * and a shrink see the same decision with the same bounds.
 */
export const biased = (words: Words, lo: number, hi: number): number => {
	const range = hi - lo + 1
	if (range <= EVEN_RANGE || (words.next() & 7) !== 0) {
		return between(words, lo, hi)
	}
	const fromHigh = (words.next() & 1) === 1
	const distance = between(words, 0, 2 ** between(words, 0, Math.floor(Math.log2(range))) - 1)
	return fromHigh ? hi - distance : lo + distance
}
