/** What the properties of evaluator-reads.test.ts read: its spaces, models and helpers. */

import { boolean, element, type Gen } from "@bjornpagen/testing/gen"
import { int4 } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { derived, relation, schema } from "#compiler/public/schema.ts"

/** The stored relation every case reads: a key k and a payload x. */
export const R = relation("R", { k: int4, x: int4 }, ["k"])

const Base = schema("Base", [R], [])

/** A live derived relation's definition: every row of R as its own. */
const copied = query(Base).rule((r) => {
	const { k, x } = v(R, "r")
	return r.match(R, { k, x }).find({ k, x })
})

/** The derived relations a case's schema holds, each R copied; a case reads at most D1. */
export const D1 = derived("D1", copied)
const D2 = derived("D2", copied)
const D3 = derived("D3", copied)

/**
 * The schemas a case is drawn over, by their copies: R beneath one, two or three live derived relations D1 to D3 over
 * it, a level above, each a relation an evaluator over the schema may read, of which a case reads at most D1.
 */
export const schemasOfCopies = [
	{ copies: 1, schema: schema.extend([Base], "Upper", [D1], []) },
	{ copies: 2, schema: schema.extend([Base], "Upper", [D1, D2], []) },
	{ copies: 3, schema: schema.extend([Base], "Upper", [D1, D2, D3], []) }
] as const

/** What a case evaluates: rows of R, of D1, or of both, each through its relation alone or beside a selection of it. */
export interface ReadsCase {
	readonly stored: "none" | "relation" | "and a selection"
	readonly copy: "none" | "relation" | "and a selection"
}

const reads = ["none", "relation", "and a selection"] as const

export const readsCaseGen: Gen<ReadsCase> = (s) => {
	const stored = s.draw(element(reads))
	const copy = s.draw(element(reads))
	return stored === "none" && copy === "none"
		? { stored: s.draw(boolean) ? "relation" : "and a selection", copy }
		: { stored, copy }
}

export type ReadsFeature =
	| "a stored relation read"
	| "a derived relation read"
	| "a relation read by two sources"
	| "both read"

/** The relations a case reads, each once whatever reads it: R where it evaluates R, D1 where it evaluates D1. */
export const readsOf = (c: ReadsCase): number =>
	(c.stored === "none" ? 0 : 1) + (c.copy === "none" ? 0 : 1)

/** The definitions a case checks: D1's alone, where it evaluates D1. */
export const checksOf = (c: ReadsCase): number => (c.copy === "none" ? 0 : 1)

/** Each feature a case reaches. */
export const featuresOf = (c: ReadsCase): ReadonlyArray<ReadsFeature> => [
	...(c.stored === "none" ? [] : ["a stored relation read" as const]),
	...(c.copy === "none" ? [] : ["a derived relation read" as const]),
	...(c.stored === "and a selection" || c.copy === "and a selection"
		? ["a relation read by two sources" as const]
		: []),
	...(c.stored !== "none" && c.copy !== "none" ? ["both read" as const] : [])
]

/**
 * The evaluator's reads, counted (kernel/calls.ts callCounts): a relation read as its sources read it
 * (program/evaluate.ts relationReadingOf), and a derived relation's definition checked (check/index.ts checkDefinition).
 */
export const readSites = Object.freeze({
	read: { file: "packages/engine/src/program/evaluate.ts", name: "relationReadingOf" },
	checked: { file: "packages/engine/src/check/index.ts", name: "checkDefinition" }
})
