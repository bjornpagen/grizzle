import { Array as Arr, Order } from "effect"

/**
 * The scale invariance of a budget program, its oracle a twin: the program declares, beside its schema at scale, a
 * twin, the same declarations over the neighbourhood of the relations it probes alone, each identifier under the
 * twin's prefix and each relation under its own name. A probe written over the program at scale must state what it
 * states over the twin: a type identical to the twin's, and a refusal raising at scale exactly what it raises over the
 * twin. A type or a refusal that widens, narrows or lapses at scale fails; none is written by hand.
 */

/** A probe's text over the declarations under a prefix: "" for the program at scale, the twin's for the twin. */
export type Over = (prefix: string) => string

/** A refusal probe: its twin label, why it is refused, and its statement, one line, over a prefix. */
export interface RefusalProbe {
	readonly label: string
	readonly why: string
	readonly line: Over
}

/**
 * The relations a twin of a program over relations R0 … R`relations - 1` declares, where the program probes the first
 * and the last: each, and the relation before and after it, round the relations.
 */
export const neighbourhood = (relations: number): ReadonlyArray<number> =>
	Arr.sort(
		Arr.dedupe(
			Arr.flatMap([0, relations - 1], (i) => [
				(i + relations - 1) % relations,
				i,
				(i + 1) % relations
			])
		),
		Order.Number
	)

/** The twin's prefix. */
export const twinPrefix = "t_"

/** The identity the probes compare types by, and its assertion. */
const equalsLines: ReadonlyArray<string> = [
	"type Equals<A, B> = (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false",
	"type Expect<T extends true> = T"
]

/** Each type probe at scale identical to the twin's, then each refusal probe at scale and over the twin as twins. */
export const twinProbes = (
	types: ReadonlyArray<Over>,
	refusals: ReadonlyArray<RefusalProbe>
): string =>
	Arr.join(
		[
			...equalsLines,
			...Arr.map(
				types,
				(probe, k) => `export type Same${k} = Expect<Equals<${probe("")}, ${probe(twinPrefix)}>>`
			),
			...Arr.flatMap(refusals, ({ label, why, line }) => [
				`// @ts-expect-error -- twin ${label}: ${why}`,
				line(""),
				`// @ts-expect-error -- twin ${label}: ${why}`,
				line(twinPrefix)
			]),
			""
		],
		"\n"
	)
