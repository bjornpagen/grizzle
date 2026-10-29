/**
 * Summary statistics for benchmark samples (a record carries its samples and what was measured). The timings of
 * this machine, a virtual machine, are treated as noisy.
 *
 * Every summary keeps its sample count beside nearest-rank percentiles, so a p99 over three samples reads as what it
 * is, the largest of three, and never as a tail measurement. Times are milliseconds rounded to microseconds.
 */
import { Array as Arr, Order, Record as Rec } from "effect"
export interface Summary {
	readonly n: number
	readonly min: number
	readonly p50: number
	readonly p95: number
	readonly p99: number
	readonly max: number
	readonly mean: number
}

const round = (x: number): number => Math.round(x * 1000) / 1000

/**
 * The nearest-rank percentile of sorted samples: the smallest sample with at least p percent of the samples at or below
 * it. p is in (0, 100].
 */
const nearestRank = (sorted: ReadonlyArray<number>, p: number): number => {
	if (sorted.length === 0) {
		throw new Error("nearestRank: no samples")
	}
	if (!(p > 0 && p <= 100)) {
		throw new Error(`nearestRank: percentile ${p} outside (0, 100]`)
	}
	const rank = Math.ceil((p / 100) * sorted.length)
	return sampleAt(sorted, Math.min(sorted.length, Math.max(1, rank)) - 1)
}

/** The sample at index i of nonempty samples. */
const sampleAt = (xs: ReadonlyArray<number>, i: number): number => {
	const x = xs[i]
	if (x === undefined) {
		throw new Error(`no sample ${i} of ${xs.length}`)
	}
	return x
}

/** The summary of a nonempty list of finite samples. */
export const summarize = (samples: ReadonlyArray<number>): Summary => {
	if (samples.length === 0) {
		throw new Error("summarize: no samples")
	}
	for (const s of samples) {
		if (!Number.isFinite(s)) {
			throw new Error(`summarize: a sample that is not finite: ${s}`)
		}
	}
	const sorted = Arr.sort(samples, Order.Number)
	const total = Arr.reduce(sorted, 0, (sum, s) => sum + s)
	return {
		n: sorted.length,
		min: round(sampleAt(sorted, 0)),
		p50: round(nearestRank(sorted, 50)),
		p95: round(nearestRank(sorted, 95)),
		p99: round(nearestRank(sorted, 99)),
		max: round(sampleAt(sorted, sorted.length - 1)),
		mean: round(total / sorted.length)
	}
}

/**
 * The summary of each named phase over a list of per-sample phase records. A phase missing from some sample is a defect
 * of the probe, never a gap to skip.
 */
export const summarizePhases = (
	samples: ReadonlyArray<Readonly<Record<string, number>>>
): Readonly<Record<string, Summary>> => {
	const first = samples[0]
	if (first === undefined) {
		throw new Error("summarizePhases: no samples")
	}
	const names = Rec.keys(first)
	const out: Record<string, Summary> = {}
	for (const name of names) {
		out[name] = summarize(
			Arr.map(samples, (s, i) => {
				const value = s[name]
				if (value === undefined) {
					throw new Error(`summarizePhases: sample ${i} has no phase ${name}`)
				}
				return value
			})
		)
	}
	for (const [i, s] of samples.entries()) {
		for (const name of Rec.keys(s)) {
			if (!names.includes(name)) {
				throw new Error(`summarizePhases: sample ${i} has an extra phase ${name}`)
			}
		}
	}
	return out
}

/** Milliseconds since `start`, a performance.now() reading. */
export const elapsed = (start: number): number => round(performance.now() - start)
