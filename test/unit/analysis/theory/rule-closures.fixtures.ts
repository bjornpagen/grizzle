/**
 * What the property of rule-closures.test.ts reads: the definitions of the box over a place's marks, each stored at the
 * place under the unit of the document, the closure of its one rule from the start a case draws, read through
 * analysis/theory/unit.ts ruleClosures, and the closure the rule restated gives.
 */

import { element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, Option, Record as Rec } from "effect"
import { liveReading } from "#compiler/analysis/theory/query.ts"
import { type RegionRead, ruleClosures } from "#compiler/analysis/theory/unit.ts"
import type { SchemaArtifacts } from "#compiler/program/schema.ts"
import { Num } from "#compiler/public/compute.ts"
import { int4 } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { derived, relation, schema, unit } from "#compiler/public/schema.ts"

/** A place's marks, each by its number under the place, keyed by the document, the place and the number. */
const Mark = relation("Mark", { doc: int4, at: int4, n: int4, v: int4 }, ["doc", "at", "n"])

/** The base: the marks, in the unit of the document, which each definition's place is wider than. */
const base = schema("RuleClosures", [Mark], [unit("Document", { doc: int4 })])

/**
 * A derived relation's definition, one rule over a place's marks, stored at the place:
 *
 * - `mark naming no mark`: each place a mark of which names by its value no mark of the place, the value read by the
 *   negation alone beside the head, which delivers neither it nor the mark's number: metis's AssignmentStatus rule 2,
 *   each sitting whose start event names a next step no event of the sitting stands at (lane DELTAUP2's lost fact);
 * - `previous number's mark`: each mark beside the mark numbered one less, delivered at the later number, the earlier
 *   number bound by the equality solved backwards: ledger's SittingOrder, the suspension of session k read from the
 *   visit of session k + 1.
 */
export type Shape = "mark naming no mark" | "previous number's mark"

/** Where a closure starts: the head's variables (lane DELTAUP2's dispatch), or a root's, a match of the rule read at the
 * unit with every variable it binds (unitRooted). */
export type Start = { readonly kind: "head" } | { readonly kind: "root"; readonly match: 0 | 1 }

/** A case: a shape and a start of its rule's closure. */
export interface ClosureCase {
	readonly shape: Shape
	readonly start: Start
}

const head: Start = { kind: "head" }

export const closureCase: Gen<ClosureCase> = (s) => {
	const shape = s.draw(element<Shape>(["mark naming no mark", "previous number's mark"]))
	switch (shape) {
		case "mark naming no mark":
			return { shape, start: s.draw(element<Start>([head, { kind: "root", match: 0 }])) }
		case "previous number's mark":
			return {
				shape,
				start: s.draw(
					element<Start>([head, { kind: "root", match: 0 }, { kind: "root", match: 1 }])
				)
			}
	}
}

/** The name of the case's derived relation. */
const derivedName = "Closed"

/** The derived relation of shape `shape` over the base. */
const derivedOf = (shape: Shape) => {
	switch (shape) {
		case "mark naming no mark":
			return derived(
				derivedName,
				query(base).rule((r) => {
					const { doc, at, n, v: x } = v(Mark, "start")
					return r
						.match(Mark, { doc, at, n, v: x })
						.where(r.not(Mark, { doc, at, n: x }))
						.find({ doc, at })
				})
			)
		case "previous number's mark":
			return derived(
				derivedName,
				query(base).rule((r) => {
					const { doc, at, n, v: x } = v(Mark, "earlier")
					const { n: later, v: y } = v(Mark, "later")
					return r
						.match(Mark, { doc, at, n, v: x })
						.match(Mark, { doc, at, n: later, v: y })
						.where(r.eq(later, Num.add(n, 1)))
						.find({ doc, at, n: later, v: y, w: x })
				})
			)
	}
}

/** The case's schema: the base and above it the derived relation of its shape. */
export const closureSchemaOf = (shape: Shape) =>
	schema.extend([base], "RuleClosuresTop", [derivedOf(shape)], [])

/**
 * A rule's closure, each match by its place among the rule's matches: each it reaches, in order, with how; those it
 * leaves; and the number of each match an equality binds, with the match whose number it was solved from where it was
 * solved backwards, and the inverse.
 */
export interface Closed {
	readonly steps: ReadonlyArray<string>
	readonly unreached: ReadonlyArray<number | "no match">
	readonly equalities: ReadonlyArray<string>
}

/**
 * The closure the rule restated gives (a specification): each round binds what an equality of the bound variables
 * binds, forwards from its right side's variables or solved backwards from its left, then reaches the first match in
 * the rule's order a key of which its bindings hold; a match left is a probe of one witness only where no variable of
 * it is delivered by the head or read by a negation, which runs once for each of its rows.
 *
 * - `mark naming no mark`: a root binds the mark's number, and the mark is reached by its key; from the head neither
 *   its number nor its value is bound, and the negation reads the value, so the mark is left.
 * - `previous number's mark`: the head and the later root bind the later number, which the equality solved backwards
 *   binds the earlier one from, less one; the earlier root binds the earlier number, which the equality binds the later
 *   one from forwards; either way each match is reached by its key, the earlier first.
 */
export const closureOf = (c: ClosureCase): Closed => {
	switch (c.shape) {
		case "mark naming no mark":
			return c.start.kind === "root"
				? { steps: ["0 by key"], unreached: [], equalities: [] }
				: { steps: [], unreached: [0], equalities: [] }
		case "previous number's mark":
			return {
				steps: ["0 by key", "1 by key"],
				unreached: [],
				equalities: [
					c.start.kind === "root" && c.start.match === 0
						? "1's number"
						: "0's number, solved from 1's by sub"
				]
			}
	}
}

/**
 * The closure the installation reads (`Closed`): the stored relation's one rule, read live as its admission reads it
 * (analysis/schema.ts CheckedSchema, storage.ts HoldingInput `definition`), closed from `start` through ruleClosures.
 */
export const closureStated = (
	artifacts: SchemaArtifacts,
	start: Start
): Closed | `other ${string}` => {
	const checked = artifacts.laws.checked
	const holding = checked.holdings.get(derivedName)
	const subject = checked.canonicalNamed(derivedName)?.subject
	if (
		holding?.kind !== "stored" ||
		holding.relation.unit.kind !== "unit" ||
		subject === undefined
	) {
		return `other ${holding?.kind ?? "no"} holding`
	}
	const [rule, ...more] = ruleClosures(
		liveReading(
			() => undefined,
			() => undefined
		).query(subject.query),
		checked.relations,
		holding.relation.unit
	)
	if (rule === undefined || more.length > 0) {
		return "other not one rule"
	}
	const root = start.kind === "root" ? rule.occurrences[start.match] : undefined
	if (start.kind === "root" && root === undefined) {
		return `other no match ${start.match}`
	}
	const placeOf = (at: (o: { readonly read: RegionRead }) => boolean): number | "no match" =>
		Option.getOrElse(Arr.findFirstIndex(rule.occurrences, at), () => "no match" as const)
	const matchOf = (read: RegionRead): number | "no match" => placeOf((o) => o.read === read)
	const numberOf = (variable: string): number | "no match" =>
		placeOf((o) => o.read.bound["n"] === variable)
	const closure = rule.close(
		new Set(
			root === undefined
				? Arr.flatMap(Rec.values(rule.rule.head), (h) => (h.kind === "var" ? [h.var] : []))
				: [...Arr.flatMap(rule.occurrences, (o) => [...o.unitVars]), ...Rec.values(root.read.bound)]
		)
	)
	return {
		steps: Arr.map(closure.steps, (s) => `${matchOf(s.read)} by ${s.by}`),
		unreached: Arr.map(closure.unreached, matchOf),
		equalities: Arr.map(
			closure.equalities,
			(e) =>
				`${numberOf(e.bound)}'s number${e.solved === undefined ? "" : `, solved from ${numberOf(e.solved.from)}'s by ${e.solved.inverse.fn}`}`
		)
	}
}
