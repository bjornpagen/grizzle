import { Array as Arr, Effect } from "effect"
import { type Phase, type Phases, silentPhases } from "#compiler/plan/common.ts"

/**
 * The process's readings at a phase boundary, as the bin reads them (main.ts): the seconds since it started, the CPU
 * seconds it spent, user and system together, and its memory in bytes, V8's heap used and reserved, its resident set and
 * the memory of C++ objects bound to JavaScript ones.
 */
export interface PhaseReading {
	readonly seconds: number
	readonly cpuSeconds: number
	readonly heapUsed: number
	readonly heapTotal: number
	readonly rss: number
	readonly external: number
}

/** What a run whose phases are reported reads at each boundary, and where it writes each line: the bin's stderr. */
export interface PhaseMeter {
	readonly read: () => PhaseReading
	readonly write: (line: string) => void
}

/**
 * A run's phase reporter, and what it does once the command has run: the reporter every phase reports to, and the last
 * line, with the most heap used any boundary read.
 */
export interface PhaseRun {
	readonly phases: Phases
	readonly done: () => void
}

/**
 * The bytes of the unit a line prints memory in, a mebibyte, which Node's own heap limits (`--max-old-space-size`) are
 * given in.
 *
 * @formatConstant a phase line's memory unit: 2^20 bytes
 */
const bytesPerMegabyte = 1_048_576

/** A memory reading in megabytes, to a tenth. */
const megabytes = (bytes: number): string => (bytes / bytesPerMegabyte).toFixed(1)

/** A reading's fields as a phase line ends: its seconds, CPU seconds and memory. */
const readingText = (r: PhaseReading): string =>
	`t=${r.seconds.toFixed(3)} cpu=${r.cpuSeconds.toFixed(3)} heapUsed=${megabytes(r.heapUsed)} heapTotal=${megabytes(r.heapTotal)} rss=${megabytes(r.rss)} external=${megabytes(r.external)}`

/** A phase as its line names it: its name, then what it is of, each after a slash. */
const phaseLabel = (phase: Phase): string => Arr.join([phase.name, ...phase.of], "/")

/**
 * The phases of a run reported to `meter` when the command line asks (`--phases`), else to silentPhases: each boundary
 * a line `grizzle phase <phase> <start|end> <reading>`, and once the command has run, `grizzle phase done <reading>
 * peakHeapUsed=<MB>`, the most heap used any boundary read. Nothing samples between boundaries.
 */
export const phaseRun = (meter: PhaseMeter, reported: boolean): PhaseRun => {
	if (!reported) {
		return { phases: silentPhases, done: () => undefined }
	}
	let peak = 0
	const reading = (): PhaseReading => {
		const r = meter.read()
		peak = Math.max(peak, r.heapUsed)
		return r
	}
	return {
		phases: {
			report: (phase, edge) =>
				meter.write(`grizzle phase ${phaseLabel(phase)} ${edge} ${readingText(reading())}`)
		},
		done: () => {
			const r = reading()
			meter.write(`grizzle phase done ${readingText(r)} peakHeapUsed=${megabytes(peak)}`)
		}
	}
}

/**
 * `effect`, its start and its end reported to `phases` around it (engine phased's, for the shell's steps). An effect
 * that fails reports no end, so the last phase started is the one the run stopped in.
 */
export const phasedEffect = <A, E, R>(
	phases: Phases,
	phase: Phase,
	effect: Effect.Effect<A, E, R>
): Effect.Effect<A, E, R> =>
	Effect.sync(() => phases.report(phase, "start")).pipe(
		Effect.andThen(effect),
		Effect.tap(() => Effect.sync(() => phases.report(phase, "end")))
	)
