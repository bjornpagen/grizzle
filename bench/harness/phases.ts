import { Array as Arr, Data, Effect, Record as Rec } from "effect"

/**
 * Phase timing for the performance gates.
 *
 * A gate records compile and encode, acquire and wake, validate, plan and execute, serialize and transfer, decode,
 * commit, lock wait and retry time, never adding inclusive parent and child values together or counting work
 * twice. A PhaseClock times one operation's phases one after another: a phase that starts while another is
 * running is refused, so no instant is counted in two phases, and every phase a sample names is a phase the record's
 * identity declares (gate.ts recordProblems). A phase entered twice in one sample accumulates, as a retry's second
 * execute does. Times are milliseconds from performance.now(), rounded to microseconds when a sample is taken.
 *
 * The standard phase names, in order: the phases a clock times. A gate may record others it measures itself; these are
 * the vocabulary every gate shares.
 */
export const standardPhases = [
	"compileMs",
	"encodeMs",
	"acquireMs",
	"validateMs",
	"beginMs",
	"executeMs",
	"transferMs",
	"decodeMs",
	"deferredChecksMs",
	"commitMs",
	"rollbackMs",
	"lockWaitMs",
	"retryMs"
] as const

export type StandardPhase = (typeof standardPhases)[number]

/** A figure a measurement takes only when it is asked for, or only when its case arises: none, or the figure. */
export type Observed<T> =
	| { readonly kind: "unobserved" }
	| { readonly kind: "observed"; readonly value: T }

class OverlappingPhase extends Data.TaggedError("OverlappingPhase")<{
	readonly running: StandardPhase
	readonly started: StandardPhase | "take"
}> {}

const round = (x: number): number => Math.round(x * 1000) / 1000

export class PhaseClock {
	#current: Map<StandardPhase, number> = new Map()
	#running: StandardPhase | undefined

	#enter(phase: StandardPhase): number {
		if (this.#running !== undefined) {
			throw new OverlappingPhase({ running: this.#running, started: phase })
		}
		this.#running = phase
		return performance.now()
	}

	#leave(phase: StandardPhase, start: number): void {
		this.add(phase, performance.now() - start)
		this.#running = undefined
	}

	time<A, E, R>(phase: StandardPhase, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> {
		return Effect.suspend(() => {
			const start = this.#enter(phase)
			return Effect.ensuring(
				effect,
				Effect.sync(() => this.#leave(phase, start))
			)
		})
	}

	timeCall<A>(phase: StandardPhase, f: () => A): A {
		const start = this.#enter(phase)
		try {
			return f()
		} finally {
			this.#leave(phase, start)
		}
	}

	/** Adds a duration taken elsewhere, such as a lock wait the server reported. */
	add(phase: StandardPhase, ms: number): void {
		if (!Number.isFinite(ms) || ms < 0) {
			throw new RangeError(`phase ${phase}: ${ms} is not a duration`)
		}
		this.#current.set(phase, (this.#current.get(phase) ?? 0) + ms)
	}

	/**
	 * Declares phases the sample did not enter, at zero, so every sample of a series names the same phases (a retry phase
	 * in a sample that needed none).
	 */
	declare(...phases: ReadonlyArray<StandardPhase>): void {
		for (const phase of phases) {
			if (!this.#current.has(phase)) {
				this.#current.set(phase, 0)
			}
		}
	}

	/** The phases of the sample so far, and a fresh sample. */
	take(): Readonly<Partial<Record<StandardPhase, number>>> {
		if (this.#running !== undefined) {
			throw new OverlappingPhase({ running: this.#running, started: "take" })
		}
		const sample = Rec.fromEntries(Arr.map([...this.#current], ([k, v]) => [k, round(v)]))
		this.#current = new Map()
		return sample
	}
}
