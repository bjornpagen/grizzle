import { Array as Arr, Order, String as Str } from "effect"
import { type PreludeAt, preludeModule } from "#test/support/prelude.ts"
import { batchOwned, caseOwned, type Entry, type Program } from "#test/support/types/batch/batch.ts"

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

/**
 * One probe of a program at scale against its twin, a cell of the program's box: a type the program states at scale
 * exactly as over the twin (`same`), or a refusal it raises at scale exactly as over the twin (`refused`), both lines
 * the probe's own.
 */
export type TwinProbe =
	| Readonly<{ kind: "same"; probe: Over }>
	| Readonly<{ kind: "refused"; probe: RefusalProbe }>

/** The probes of a program: each type probe, then each refusal probe. */
export const twinProbesOf = (
	types: Arr.NonEmptyReadonlyArray<Over>,
	refusals: ReadonlyArray<RefusalProbe>
): Arr.NonEmptyReadonlyArray<TwinProbe> =>
	Arr.appendAll(
		Arr.map(types, (probe): TwinProbe => ({ kind: "same", probe })),
		Arr.map(refusals, (probe): TwinProbe => ({ kind: "refused", probe }))
	)

/**
 * The identity the probes compare types by, and its assertion, exported so a batch of refusal probes alone, which reads
 * neither, raises no unused declaration.
 */
const equalsLines: ReadonlyArray<string> = [
	"export type Equals<A, B> = (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false",
	"export type Expect<T extends true> = T"
]

/** A probe's lines at its place among a batch's probes: its type at scale identical to the twin's, or its refusal at scale and over the twin, twins. */
const probeLines = (probe: TwinProbe, at: number): ReadonlyArray<string> => {
	switch (probe.kind) {
		case "same":
			return [
				`export type Same${at} = Expect<Equals<${probe.probe("")}, ${probe.probe(twinPrefix)}>>`
			]
		case "refused": {
			const { label, why, line } = probe.probe
			return [
				`// @ts-expect-error -- twin ${label}: ${why}`,
				line(""),
				`// @ts-expect-error -- twin ${label}: ${why}`,
				line(twinPrefix)
			]
		}
	}
}

/**
 * The program of a batch of a scale program's probes: its declarations at scale and its twin's, which every probe
 * reads, the batch's own, then each probe's lines, its own; imports read through the gates' prelude as `entries`
 * gives it for the program's directory.
 */
export const twinProgram =
	(header: string, entries: (entry: Entry) => PreludeAt, declarations: string) =>
	(probes: Arr.NonEmptyReadonlyArray<TwinProbe>, entry: Entry): Program => [
		preludeModule("index.ts", header, entries(entry), [
			{ owner: batchOwned, lines: [...Str.split(declarations, "\n"), ...equalsLines, ""] },
			...Arr.map(probes, (probe, at) => ({ owner: caseOwned(at), lines: probeLines(probe, at) }))
		])
	]
