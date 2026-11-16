/** What the properties of analysis-once.test.ts read: its spaces, models and helpers. */

import { array, boolean, type Gen, int, shuffled } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import { defined } from "#test/support/assert.ts"
import { upTo } from "#test/support/up-to.ts"

/** A pattern a field may declare, with a value of its language that a closed row may hold. */
export interface FieldPattern {
	readonly source: string
	readonly flags: "u" | "su"
	readonly member: string
	/** Whether its language bounds its bytes, so a key may hold it. */
	readonly bounded: boolean
}

export const patterns: Arr.NonEmptyReadonlyArray<FieldPattern> = [
	{ source: "^[a-z]{0,8}$", flags: "u", member: "abc", bounded: true },
	{ source: "^.{0,40}$", flags: "su", member: "x\ny", bounded: true },
	{ source: "^(?:yes|no)$", flags: "u", member: "yes", bounded: true },
	{ source: "^[A-Z]{3}$", flags: "u", member: "ABC", bounded: true },
	{ source: "^.*$", flags: "su", member: "", bounded: false }
]

interface CountCase {
	/** The distinct patterns the schema declares, by their place in `patterns`, each once. */
	readonly chosen: Arr.NonEmptyReadonlyArray<number>
	/** Each relation's text fields, by their pattern's place in `chosen`. */
	readonly relations: Arr.NonEmptyReadonlyArray<Arr.NonEmptyReadonlyArray<number>>
	readonly containment: boolean
	readonly closedRows: number
}

export const caseGen: Gen<CountCase> = (source) => {
	const [firstPattern, ...otherPatterns] = source.draw(
		shuffled(
			upTo(patterns.length, (i) => i),
			{ min: 1, max: 4 }
		)
	)
	const chosen: Arr.NonEmptyReadonlyArray<number> = [
		defined(firstPattern, "a drawn pattern"),
		...otherPatterns
	]
	const fieldsOf: Gen<Arr.NonEmptyReadonlyArray<number>> = (inner) => [
		inner.draw(int(0, chosen.length - 1)),
		...inner.draw(array(int(0, chosen.length - 1), { min: 0, max: 2 }))
	]
	const first = source.draw(fieldsOf)
	const rest = source.draw(array(fieldsOf, { min: 0, max: 11 }))
	const containment = source.draw(boolean)
	const [second, ...others] = rest
	return {
		chosen,
		relations:
			containment && second !== undefined
				? [first, [first[0], ...Arr.drop(second, 1)], ...others]
				: [first, ...rest],
		containment,
		closedRows: source.draw(int(0, 2))
	}
}

/**
 * Whether a case's containment is declared: from its first relation's (id, t0) into its second's, which share t0's
 * pattern, one that bounds its bytes, so the UNIQUE it references is representable.
 */
export const containmentOf = (c: CountCase, bounded: (t: number) => boolean): boolean => {
	const [source, target] = c.relations
	return c.containment && target !== undefined && source[0] === target[0] && bounded(source[0])
}

export type CountFeature =
	| "one pattern"
	| "several patterns"
	| "a pattern several relations read"
	| "a containment"
	| "closed rows"
	| "an unbounded pattern"
