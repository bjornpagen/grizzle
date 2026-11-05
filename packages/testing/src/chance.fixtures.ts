import { Array as Arr, Option } from "effect"
import { type Enumerated, enumerated, firstBranch } from "#enumerate.ts"
import type { Gen } from "#gen.ts"
import type { Generated } from "#source.ts"
import type { Tape } from "#tape.ts"

/** Every case of a bounded generator, in enumeration order, each with the tape that determines it. */
export const everyCase = <A>(generator: Gen<A>): ReadonlyArray<Generated<A>> => {
	const cases: Array<Generated<A>> = []
	let step: Enumerated<A> = enumerated(generator, firstBranch)
	cases.push(step.generated)
	while (Option.isSome(step.next)) {
		step = enumerated(generator, step.next.value)
		cases.push(step.generated)
	}
	return cases
}

/** Every value of a bounded generator, in enumeration order. */
export const everyValue = <A>(generator: Gen<A>): ReadonlyArray<A> =>
	Arr.map(everyCase(generator), (generated) => generated.value)

/** A probability held exactly, in lowest terms: its numerator and its denominator. */
export type Fraction = readonly [numerator: bigint, denominator: bigint]

const gcd = (a: bigint, b: bigint): bigint => (b === 0n ? (a < 0n ? -a : a) : gcd(b, a % b))

/** `numerator / denominator` in lowest terms. */
export const fraction = (numerator: bigint, denominator: bigint): Fraction => {
	const divisor = gcd(numerator, denominator)
	return divisor === 0n ? [0n, 1n] : [numerator / divisor, denominator / divisor]
}

/** The sum of two fractions. */
export const plus = (left: Fraction, right: Fraction): Fraction =>
	fraction(left[0] * right[1] + right[0] * left[1], left[1] * right[1])

/** The product of two fractions. */
export const times = (left: Fraction, right: Fraction): Fraction =>
	fraction(left[0] * right[0], left[1] * right[1])

/**
 * The chance a random search draws a tape: one over each decision's range, multiplied. That is the random chooser's
 * chance for a decision it draws uniformly, every option a generator picks and every magnitude of at most 256 values,
 * so a test states a distribution exactly by enumeration only of a generator whose decisions are of those kinds.
 */
const chanceOf = (tape: Tape): Fraction => {
	let denominator = 1n
	for (let at = 0; at < tape.length; at += 1) {
		denominator *= BigInt((tape.hi[at] ?? 0) - (tape.lo[at] ?? 0) + 1)
	}
	return [1n, denominator]
}

/** The chance a random search draws a case `holds` accepts. */
export const shareOf = <A>(
	cases: ReadonlyArray<Generated<A>>,
	holds: (value: A) => boolean
): Fraction =>
	Arr.reduce(
		Arr.filter(cases, (generated) => holds(generated.value)),
		fraction(0n, 1n),
		(sum, generated) => plus(sum, chanceOf(generated.tape))
	)
