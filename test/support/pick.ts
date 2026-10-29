import { type Gen, int } from "@grizzle/testing/gen"
import { Array as Arr } from "effect"

/**
 * Picks: how a sketch chooses among options it does not know when it is drawn. A pick is a whole number in 0..0xffff,
 * and the index it selects among n options is ⌊pick·n/65536⌋: within one part in 65536 of uniform for every n up to
 * the options a generator has, where a small integer reduced modulo n favours the low options by up to a whole step. A
 * pick shrinks toward 0, toward the first option. A sketch whose options are known when it is drawn draws the option
 * itself (`element`), and a kept case states it; a pick is for a list its resolver computes.
 *
 * The span of a pick: 0..0xffff.
 */
export const pickSpan = 0x1_0000

/** A pick: a whole number in 0..0xffff. */
export const pickGen: Gen<number> = int(0, pickSpan - 1)

/** The index a pick selects among `n` options: ⌊pick·n/65536⌋, so pick 0 is the first option. */
export const pickIndex = (pick: number, n: number): number => {
	if (!Number.isInteger(n) || n < 1) {
		throw new Error(`a pick selects among at least one option, not ${n}`)
	}
	return Math.floor((pick * n) / pickSpan)
}

/**
 * The least pick that selects option `index` of `count`, pickIndex's inverse: what a kept sketch writes where a drawn
 * one holds a pick.
 */
export const pickOf = (index: number, count: number): number => {
	if (!Number.isInteger(index) || index < 0 || index >= count) {
		throw new Error(`no option ${index} of ${count}`)
	}
	return Math.ceil((index * pickSpan) / count)
}

/** The option a pick selects. */
export const pickFrom = <A>(options: Arr.NonEmptyReadonlyArray<A>, pick: number): A => {
	const option = options[pickIndex(pick, options.length)]
	if (option === undefined) {
		throw new Error(`the pick ${pick} lies outside 0..0xffff`)
	}
	return option
}
