import { indices } from "@bjornpagen/grizzle-text/base/array"
import { assert, defined } from "@bjornpagen/testing/assert"
import { Array as Arr, Effect, Option } from "effect"
import { jsonText } from "#compiler/core/trusted.ts"
import { type PreludeAt, preludeProgram } from "#test/support/prelude.ts"
import {
	assertClean,
	type Measured,
	type Measuring,
	measuredEach
} from "#test/support/types/batch/measured.ts"

/**
 * The depth programs (depth.test.ts): a chain of levels, each a schema.extend over the one below it, as qti-pie's
 * pantry and ledger stack theirs (QtiBase, QtiViews, Qti, QtiMediaPolicy, QtiMedia, QtiLomVocabulary and QtiLom, module
 * constants in pantry; RegistryRoster, Registry, Ledger and Delivery, built in the ledger by functions over the level
 * below and read through `ReturnType`, as `DeliveryLevel = ReturnType<typeof deliveryOf>`). A chain is measured at
 * three depths, n, 2n and 4n levels above its root, the root L0 one level of the chain's relations.
 *
 * Each level holds its own relations R<k>_0 …, four fields each, keyed by their id, the first contained in the root's
 * first relation by its parent, read off the record of the level below (`below.relations.R0_0`), as every level reads
 * the relations it states its laws over. A level of the ledger's content also holds a derived relation D<k>, a query
 * over the level below matching the root's first relation and the first relation of the level below, and a check over
 * it, as pantry's views and the Delivery level's derived relations read the levels below them. Each level is built as
 * its shape's period says: a module constant over the constant below, `L<k> = schema.extend([L<k-1>], …)`, typed
 * `typeof`; or a function over the type of the level below, `level<k> = (below: Level<k-1>) => schema.extend([below],
 * …)`, typed `ReturnType<typeof level<k>>` and installed over the level below's value. A reader over the top reads its
 * record.
 *
 * The laws (depthCost) read each count as a quadratic in the depth L, a + bL + cL², whose second difference over n, 2n
 * and 4n, (f(4n) − f(2n)) − 2(f(2n) − f(n)) = 6cn², is the quadratic term alone, zero for a linear count; each chain
 * holds both its counts' second differences at their measured values (DepthShape's quadratics), so neither term grows
 * unnoticed. The types a chain makes, the checker's memory, are linear but for a term of its fresh type parameters, the
 * anonymous ones the checker makes as it instantiates (at 8, 16 and 32 module constants 100 for the first 8 levels and
 * 366 for the next 16, the program's every other type linear, as its trace's types diffed by declaration show): 172 of
 * a second difference of 6,840 made over 16 levels, about 0.45 a level for each level below, and 603 at qti-pie's chain
 * at 10, 20 and 40, about one, some 100 types at the ledger's depth of 10. A per-level copy of the levels below makes a
 * type for each relation below at each level, a second difference in the thousands. Its instantiations are quadratic:
 * each extension resolves again every property of the record of the levels below, as `Base extends AnySchema` relates
 * the base's record to `Record<string, AnyRelation | AnyClosed | AnyDerived>` and RecordOver reads each name of the
 * record below through its conditional, and the derived relations' constraint walks the levels below (extend's DerivedAt
 * over LevelsOf), each a hit of the type cache that makes no type: a level costs a fixed part and a part for each
 * relation and each level below it, about 22 and 30.
 *
 * Known gap: instantiations linear in depth need a level whose record the checker does not resolve again at each level
 * above it. Two levers were measured and ruled out (TYPECOST, 2026-11-27, a chain of 6 relations a level at depths 8,
 * 16 and 32 in a copy of grizzle main whose sources were @ts-nocheck): AnySchema's relations as `object`, which removes
 * the base's record check and about 37% of the growth (162 to 102 instantiations a level for each level below), and
 * weakens every reader of `S["relations"][…]`, which the no-compromise rule refuses; and the record over its base as an
 * intersection, `B & L`, which removes the same 37% here and, as RecordOver's own doc records, costs a level its every
 * relation below again where a lookup by name asks whether the intersection reduces. LevelsOf in extend's DerivedAt
 * constraint is about 10% more; the remaining 85 of the 162 were not isolated. An interface cannot extend a type
 * parameter, so no record type inherits the levels below without resolving them. At qti-pie's chain (about 11 levels,
 * about 700 relations) the term is about 80,000 of the ledger's 25.5 million instantiations, 0.3%; the ledger's cost is
 * its levels' content, not their depth.
 */

/** How a level is built: a module constant over the constant below it, or a function over the type of the level below. */
type LevelKind = "constant" | "function"

/** What each level above the root holds: its relations alone, or the ledger's, a derived relation and a check besides. */
type LevelContent = "relations" | "derived relation and check"

/** The second differences of a chain's two counts over its depths, measured. */
interface Quadratics {
	readonly types: number
	readonly instantiations: number
}

/**
 * A chain: its name; the kinds of its levels above the root, a period the chain repeats; each level's own relations and
 * its content; the depths it is measured at, n, 2n and 4n levels above the root, n a whole number of periods; and the
 * second differences of its types and its instantiations over them, measured.
 */
interface DepthShape {
	readonly name: string
	readonly period: Arr.NonEmptyReadonlyArray<LevelKind>
	readonly relations: number
	readonly content: LevelContent
	readonly depths: readonly [number, number, number]
	readonly quadratics: Quadratics
}

/** The depths n, 2n and 4n levels above the root. */
const doubling = (n: number): readonly [number, number, number] => [n, 2 * n, 4 * n]

/**
 * The second differences of the types and the instantiations of a chain of module constants, a level of six relations,
 * over 8, 16 and 32 levels above the root.
 *
 * @limitKind measured
 * @owner grizzle's schema types (types/schema/schema.ts, schema/api.ts extend), as tsgo checks a chain of them
 * @unit types and instantiations, each the second difference (f(32) − f(16)) − 2(f(16) − f(8)) of a chain's whole
 *   program's count
 * @scope each depth program of test/types/schema/budget/depth.ts, checked alone by one checker against the engine's and
 *   the shell's declarations (test/support/types/batch/measured.ts)
 * @evidence the gate's own counts, which it prints in each failure: `pnpm exec toolchain-test run
 *   test/types/schema/budget/depth.test.ts` with the chain's quadratics set to -1, in ~/.cache/grizzle/TYPECOST (lane
 *   TYPECOST's workspace)
 * @observed 2026-11-27, 23:30 to 23:45 UTC
 * @environment cassowary, Ubuntu 26.04 arm64, 64 cores, Node 26.13.1, TypeScript 7.1.0-beta (tsgo), grizzle main
 *   b77d3e04 with this gate
 * @workload the chain's program at 8, 16 and 32 levels above the root, each checked once; the counts are the compiler's
 *   and deterministic
 * @result types 20,390, 23,810 and 30,822, a second difference of 172; instantiations 83,837, 130,849 and 260,393, a
 *   second difference of 35,520, a quadratic of about 92 instantiations a level for each level below, 15 for each of its
 *   relations
 * @decision the measured values themselves: the counts are deterministic, so any growth of either quadratic term is a
 *   change of grizzle's types, which this holds
 * @revalidate a change of grizzle's schema or level types that moves the counts, a TypeScript 7 or tsgo upgrade
 */
const UNIFORM_CONSTANTS_QUADRATICS: Quadratics = { types: 172, instantiations: 35_520 }

/**
 * The same, for a chain of function levels. Evidence as UNIFORM_CONSTANTS_QUADRATICS's, but its result: types 20,445,
 * 23,913 and 31,021, a second difference of 172; instantiations 87,320, 142,932 and 305,036, a second difference of
 * 50,880.
 */
const UNIFORM_FUNCTIONS_QUADRATICS: Quadratics = { types: 172, instantiations: 50_880 }

/**
 * The same, for qti-pie's chain, over 10, 20 and 40 levels above the root. Evidence as UNIFORM_CONSTANTS_QUADRATICS's,
 * but its result: types 41,301, 50,760 and 70,281, a second difference of 603; instantiations 190,069, 335,044 and
 * 748,294, a second difference of 123,300.
 */
const LEDGER_CHAIN_QUADRATICS: Quadratics = { types: 603, instantiations: 123_300 }

/**
 * The chains, each measured at its depths: two uniform chains of six relations a level, every level a module constant,
 * and every level a function; and qti-pie's chain, the kept case of consumer evidence, its period ten levels above the
 * root as pantry and the ledger stack them, six module constants and then four functions read by ReturnType, each
 * level holding its relations, a derived relation over the level below and a check over it, measured at one, two and
 * four periods.
 */
export const depthShapesItems: Arr.NonEmptyReadonlyArray<DepthShape> = [
	{
		name: "a chain of module constants, six relations a level",
		period: ["constant"],
		relations: 6,
		content: "relations",
		depths: doubling(8),
		quadratics: UNIFORM_CONSTANTS_QUADRATICS
	},
	{
		name: "a chain of functions read by ReturnType, six relations a level",
		period: ["function"],
		relations: 6,
		content: "relations",
		depths: doubling(8),
		quadratics: UNIFORM_FUNCTIONS_QUADRATICS
	},
	{
		name: "qti-pie's chain: six module constants, then four functions read by ReturnType, each level with a derived relation and a check",
		period: [
			"constant",
			"constant",
			"constant",
			"constant",
			"constant",
			"constant",
			"function",
			"function",
			"function",
			"function"
		],
		relations: 6,
		content: "derived relation and check",
		depths: doubling(10),
		quadratics: LEDGER_CHAIN_QUADRATICS
	}
]

/** The kind of level k, one or more above the root, as the shape's period cycles. */
const kindAt = (shape: DepthShape, k: number): LevelKind =>
	defined(shape.period[(k - 1) % shape.period.length], `the kind of level ${k}`)

/** Level k's own relations, declared where the level is built. */
const relationsOf = (k: number, count: number, indent: string): string =>
	Arr.join(
		Arr.map(
			indices(count),
			(i) =>
				`${indent}const R${k}_${i} = relation("R${k}_${i}", { id: Id, parent: Id, n: natural, label: Label }, ["id"])`
		),
		"\n"
	)

/**
 * Level k's derived relation, a query over the level `below` matching the root's first relation and the first relation
 * of the level under k, and its own relations' names, its derived relation's after them.
 */
const derivedOf = (k: number, below: string, indent: string): string =>
	`${indent}const D${k} = derived("D${k}", query(${below}).rule((r) => {
${indent}	const { id, n } = v(${below}.relations.R0_0, "a")
${indent}	const { label } = v(${below}.relations.R${k - 1}_0, "b")
${indent}	return r.match(${below}.relations.R0_0, { id, n }).match(${below}.relations.R${k - 1}_0, { id, label }).find({ id, n, label })
${indent}}))`

/** Level k's extension of the level `below`, as its shape's content says, every line at `indent`. */
const extensionOf = (shape: DepthShape, k: number, below: string, indent: string): string => {
	const own = Arr.map(indices(shape.relations), (i) => `R${k}_${i}`)
	const contained = `contained(on(R${k}_0, "parent"), on(${below}.relations.R0_0, "id"))`
	switch (shape.content) {
		case "relations":
			return `${relationsOf(k, shape.relations, indent)}
${indent}return schema.extend([${below}], "L${k}", [${Arr.join(own, ", ")}], [${contained}])`
		case "derived relation and check":
			return `${relationsOf(k, shape.relations, indent)}
${derivedOf(k, below, indent)}
${indent}return schema.extend([${below}], "L${k}", [${Arr.join([...own, `D${k}`], ", ")}], [${contained}, check("D${k}_n", D${k}, (x) => x.ge(x.n, 0n))])`
	}
}

/** Level k, built as its kind says, its type Level<k> and its value L<k>. */
const levelOf = (shape: DepthShape, k: number): string => {
	switch (kindAt(shape, k)) {
		case "constant":
			return `export const L${k} = (() => {
${extensionOf(shape, k, `L${k - 1}`, "\t")}
})()
export type Level${k} = typeof L${k}`
		case "function":
			return `export const level${k} = (below: Level${k - 1}) => {
${extensionOf(shape, k, "below", "\t")}
}
export type Level${k} = ReturnType<typeof level${k}>
export const L${k}: Level${k} = level${k}(L${k - 1})`
	}
}

/** The chain's program at `depth` levels above its root, its imports read through the gates' prelude. */
const depthSource = (shape: DepthShape, depth: number, entries: PreludeAt): string =>
	preludeProgram(
		`// Generated by test/types/schema/budget/depth.ts at ${jsonText({ name: shape.name, depth })}.`,
		entries,
		`const Label = str.regex("^[a-z]{1,32}$")
export const L0 = (() => {
${relationsOf(0, shape.relations, "\t")}
	return schema("L0", [${Arr.join(
		Arr.map(indices(shape.relations), (i) => `R0_${i}`),
		", "
	)}], [])
})()
export type Level0 = typeof L0
${Arr.join(
	Arr.map(indices(depth), (i) => levelOf(shape, i + 1)),
	"\n"
)}
export const top = (level: Level${depth}) => level.relations
`
	)

/**
 * A chain's cost at its depths, n, 2n and 4n above the root, and the laws over them: every program typechecks with no
 * diagnostic, and the second differences of its types and of its instantiations are each at most its measured one.
 */
export const depthCost = (at: Measuring, shape: DepthShape) =>
	Effect.gen(function* () {
		const measured = yield* measuredEach(
			at,
			Arr.map(shape.depths, (depth) => ({
				size: depth,
				source: (entries: PreludeAt) => depthSource(shape, depth, entries)
			}))
		)
		for (const m of measured) {
			assertClean(m, shape.name)
		}
		const sized = (depth: number): Measured =>
			defined(
				Option.getOrUndefined(Arr.findFirst(measured, (m) => m.size === depth)),
				`${shape.name} is measured at ${depth} levels`
			)
		const [n, n2, n4] = shape.depths
		const secondOf = (of: (m: Measured) => number) =>
			of(sized(n4)) - of(sized(n2)) - 2 * (of(sized(n2)) - of(sized(n)))
		const countsOf = (of: (m: Measured) => number) =>
			`${of(sized(n))} at ${n}, ${of(sized(n2))} at ${n2}, ${of(sized(n4))} at ${n4} levels`
		const types = secondOf((m) => m.types)
		const instantiations = secondOf((m) => m.instantiations)
		assert.ok(
			types <= shape.quadratics.types && instantiations <= shape.quadratics.instantiations,
			`${shape.name}: the second differences of its types, ${types}, and of its instantiations, ${instantiations}, are at most its measured ${shape.quadratics.types} and ${shape.quadratics.instantiations} (types ${countsOf((m) => m.types)}; instantiations ${countsOf((m) => m.instantiations)})`
		)
	})
