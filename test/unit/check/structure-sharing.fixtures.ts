/** What the properties of structure-sharing.test.ts read: their box, the descriptions it draws and their reads. */

import { array, element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import { SourceLoc } from "#compiler/core/loc.ts"
import type {
	InferredExpr,
	InferredQuery,
	InferredRule,
	InferredSource
} from "#compiler/ir/desc.ts"

/**
 * What the query at the bottom of a box's chain holds: nothing amiss; or, read wherever it is entered, a variable its
 * rule does not declare, a parent variable, which only an attachment's child may read, or a self source outside a
 * recursive step, each MalformedDescription.
 */
const plants = ["none", "a stranger variable", "a parent variable", "a self source"] as const

export type Plant = (typeof plants)[number]

/** How a reader reads the query below it: an import, a match of it; or an attachment of it to the reader's rows. */
export type Read = "import" | "attachment"

/**
 * A box: a chain of two to seven queries, each above the bottom one reading the query below it one to three times,
 * each read an import or an attachment, and the bottom query's plant.
 */
export interface Box {
	readonly levels: ReadonlyArray<ReadonlyArray<Read>>
	readonly plant: Plant
}

export const boxGen: Gen<Box> = (source) => ({
	levels: source.draw(
		array(array(element(["import", "attachment"] as const), { min: 1, max: 3 }), {
			min: 1,
			max: 6
		})
	),
	plant: source.draw(element(plants))
})

/** A located node's location, its label the node's place in the box. */
const at = (label: string): SourceLoc => SourceLoc(label, [])

const x: InferredExpr = { kind: "var", var: "x" }

const relation: InferredSource = { kind: "relation", name: "R" }

/** The bottom query: x read from a relation, its head x, and its plant. */
const bottomOf = (plant: Plant): InferredQuery => {
	const head: InferredExpr =
		plant === "a stranger variable"
			? { kind: "var", var: "stranger" }
			: plant === "a parent variable"
				? { kind: "parent", column: "p" }
				: x
	const rule: InferredRule = {
		loc: at("bottom"),
		vars: [{ loc: at("bottom x"), id: "x", origin: undefined }],
		matches: [
			{
				loc: at("bottom match"),
				source: plant === "a self source" ? { kind: "self" } : relation,
				bindings: { a: x }
			}
		],
		where: [],
		head: { a: head },
		interiors: [],
		attach: []
	}
	return { stage: { kind: "rules", loc: at("bottom rules"), arms: [rule] } }
}

/**
 * The query at `level` over `below`: x read from a relation, and each of `reads` an import of `below`, its column
 * bound to x, or an attachment of it to the rule's rows. A rule reads its matches before its attachments.
 */
const readerOf = (
	below: InferredQuery,
	reads: ReadonlyArray<Read>,
	level: number
): InferredQuery => {
	const imported: InferredSource = { kind: "query", query: below, bind: {} }
	const rule: InferredRule = {
		loc: at(`level ${level}`),
		vars: [{ loc: at(`level ${level} x`), id: "x", origin: undefined }],
		matches: [
			{ loc: at(`level ${level} match`), source: relation, bindings: { a: x } },
			...Arr.flatMap(reads, (read, i) =>
				read === "import"
					? [{ loc: at(`level ${level} import ${i}`), source: imported, bindings: { a: x } }]
					: []
			)
		],
		where: [],
		head: { a: x },
		interiors: [],
		attach: Arr.flatMap(reads, (read, i) =>
			read === "attachment"
				? [{ loc: at(`level ${level} attach ${i}`), name: `c${i}`, child: below }]
				: []
		)
	}
	return { stage: { kind: "rules", loc: at(`level ${level} rules`), arms: [rule] } }
}

/** `q`, with each read of its stage counted into `reads`: how many times a walk enters it. */
const counted = (q: InferredQuery, reads: { count: number }): InferredQuery =>
	new Proxy(q, {
		get: (target, property, receiver): unknown => {
			if (property === "stage") {
				reads.count += 1
			}
			const value: unknown = Reflect.get(target, property, receiver)
			return value
		}
	})

/**
 * The box's description, each query one value its reader shares, each entry of a query counted into `reads`; and its
 * bottom query alone, uncounted.
 */
export const descriptionOf = (
	box: Box,
	reads: { count: number }
): { readonly root: InferredQuery; readonly bottom: InferredQuery } => {
	const bottom = bottomOf(box.plant)
	const root = Arr.reduce(box.levels, counted(bottom, reads), (below, level, i) =>
		counted(readerOf(below, level, i + 1), reads)
	)
	return { root, bottom }
}

/** The `i`th member of a compile over `shared`: a query of its own that imports `shared` once, its entries counted. */
export const memberOf = (
	shared: InferredQuery,
	i: number,
	reads: { count: number }
): InferredQuery => counted(readerOf(shared, ["import"], 100 + i), reads)

/**
 * The entries a walk of the box's description makes when it refuses nothing: the root as a query, and each query
 * below once for each way its reader reads it, an import's entry a query's and an attachment's an attachment's.
 */
export const entriesOf = (box: Box): number =>
	1 + Arr.reduce(box.levels, 0, (n, reads) => n + new Set(reads).size)

/** The paths from the root to every query: what a walk that enters a query on each path to it makes. */
export const pathsOf = (box: Box): number =>
	Arr.reduce(Arr.reverse(box.levels), { paths: 1, total: 1 }, ({ paths, total }, reads) => ({
		paths: paths * reads.length,
		total: total + paths * reads.length
	})).total

/**
 * Whether the bottom query is refused where the box reads it: a stranger variable and a self source wherever it is,
 * and a parent variable where some read of it is an import, which enters it as a query of its own.
 */
export const refusedAt = (box: Box): boolean => {
	switch (box.plant) {
		case "none":
			return false
		case "a stranger variable":
		case "a self source":
			return true
		case "a parent variable":
			return Arr.contains(box.levels[0] ?? [], "import")
	}
}
