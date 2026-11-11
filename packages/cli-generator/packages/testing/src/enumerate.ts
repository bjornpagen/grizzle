import { Option } from "effect"
import type { Gen } from "#gen.ts"
import {
	type Generated,
	generate,
	prefixChooser,
	type Recorder,
	recorder,
	simplestChooser
} from "#source.ts"
import type { Tape } from "#tape.ts"

/** A point in enumeration order: the first `length` decisions fixed to `values`, every later one at its simplest. */
export type Branch = Readonly<{ values: Float64Array; length: number }>

/** The first branch of every enumeration: no decision fixed yet. */
export const firstBranch: Branch = { values: new Float64Array(0), length: 0 }

/**
 * The branch after a case in enumeration order: the last decision that can still grow takes its next value, and every
 * decision after it starts again from its simplest. The first decision is outermost and each decision counts up from
 * its simplest, so cases come smallest first and every case of a bounded generator comes exactly once.
 */
export const nextBranch = (tape: Tape): Option.Option<Branch> => {
	for (let at = tape.length - 1; at >= 0; at -= 1) {
		const value = tape.values[at] ?? 0
		if (value >= (tape.hi[at] ?? 0)) {
			continue
		}
		const values = tape.values.slice(0, at + 1)
		values[at] = value + 1
		return Option.some({ values, length: at + 1 })
	}
	return Option.none()
}

/** One step of an enumeration: the case at a branch, and the branch after it, if there is one. */
export type Enumerated<A> = Readonly<{ generated: Generated<A>; next: Option.Option<Branch> }>

/** The case at `branch`, every decision past it at its simplest, and the branch that follows, recorded on `recorded`'s
 * buffers. */
export const enumerated = <A>(
	recorded: Recorder,
	generator: Gen<A>,
	branch: Branch
): Enumerated<A> => {
	const generated = generate(
		recorded,
		generator,
		prefixChooser(branch.values, branch.length, simplestChooser)
	)
	return { generated, next: nextBranch(generated.tape) }
}

/**
 * How many cases a generator has, counted by generating alone, before any property runs: within the limit, or
 * beyond it. Discarded cases do not count, because they never run. A space larger than its limit is refused up front,
 * never silently sampled, so an exhaustive check is a proof inside its box or nothing.
 */
export type Counted =
	| Readonly<{ kind: "within"; cases: number }>
	| Readonly<{ kind: "beyond"; limit: number }>

/** Counts a generator's cases up to `limit`, every case on one recorder's buffers. */
export const count = (generator: Gen<unknown>, limit: number): Counted => {
	const recorded = recorder()
	let cases = 0
	let branch: Option.Option<Branch> = Option.some(firstBranch)
	while (Option.isSome(branch)) {
		const step = enumerated(recorded, generator, branch.value)
		if (step.generated.tape.status !== "discarded") {
			cases += 1
			if (cases > limit) {
				return { kind: "beyond", limit }
			}
		}
		branch = step.next
	}
	return { kind: "within", cases }
}
