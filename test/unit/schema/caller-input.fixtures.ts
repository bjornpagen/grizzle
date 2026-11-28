/** What the properties of caller-input.test.ts read: its spaces, models and helpers. */

import { array, codePoint, type Gen, int, string, weighted } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import { constantColumn } from "#compiler/core/decoder.ts"
import type { Carrier } from "#compiler/types/core/phantom.ts"
import { fieldSketchGen, type SketchedField } from "#test/support/unit/schema/field-sketch.ts"

interface RosterSketch {
	readonly name: number
	readonly handles: number
}

export type CarrierSketch =
	| { readonly kind: "field"; readonly field: SketchedField }
	| { readonly kind: "literal"; readonly text: string }

export interface UnionCase {
	readonly rosters: Arr.NonEmptyReadonlyArray<RosterSketch>
	readonly x: CarrierSketch
	readonly y: CarrierSketch
}

/** What the column rule reads of a carrier: a closed id's code or a set over a roster by its name, a literal, or other. */
type CarrierKind =
	| { readonly kind: "code"; readonly roster: string }
	| { readonly kind: "bits"; readonly roster: string }
	| { readonly kind: "plain" }
	| { readonly kind: "literal" }

export const rosterName = (r: RosterSketch): string => `Kind${r.name}`

const carrierGen =
	(rosters: number): Gen<CarrierSketch> =>
	(source) =>
		source.draw(
			weighted<CarrierSketch>([
				[
					3,
					(s) => ({
						kind: "field",
						field: s.draw(fieldSketchGen(rosters, (n) => `C${n.draw(int(0, 1))}`))
					})
				],
				[
					1,
					(s) => ({
						kind: "field",
						field: { kind: "closedId", roster: s.draw(int(0, rosters - 1)) }
					})
				],
				[
					1,
					(s) => ({ kind: "field", field: { kind: "bits", roster: s.draw(int(0, rosters - 1)) } })
				],
				[
					1,
					(s) => ({
						kind: "literal",
						text: s.draw(string(codePoint(0x61, 0x63), { min: 0, max: 2 }))
					})
				]
			])
		)

export const unionCaseGen: Gen<UnionCase> = (source) => {
	const first: RosterSketch = { name: source.draw(int(0, 1)), handles: source.draw(int(1, 3)) }
	const rest = source.draw(
		array((s) => ({ name: s.draw(int(0, 1)), handles: s.draw(int(1, 3)) }), { min: 0, max: 1 })
	)
	const rosters: Arr.NonEmptyReadonlyArray<RosterSketch> = [first, ...rest]
	return {
		rosters,
		x: source.draw(carrierGen(rosters.length)),
		y: source.draw(carrierGen(rosters.length))
	}
}

/**
 * Two rosters of distinct names and a closed id over each, in either order: the pair the rule refuses because their
 * rosters differ, which unionCaseGen draws about once in two hundred cases.
 */
export const closedIdsOfTwoRostersGen: Gen<UnionCase> = (source) => {
	const first = source.draw(int(0, 1))
	const rosters: Arr.NonEmptyReadonlyArray<RosterSketch> = [
		{ name: first, handles: source.draw(int(1, 3)) },
		{ name: 1 - first, handles: source.draw(int(1, 3)) }
	]
	const at = source.draw(int(0, 1))
	return {
		rosters,
		x: { kind: "field", field: { kind: "closedId", roster: at } },
		y: { kind: "field", field: { kind: "closedId", roster: 1 - at } }
	}
}

/** The kind of a carrier: a contract's is its base's. */
export const kindOf = (
	c: CarrierSketch,
	rosters: Arr.NonEmptyReadonlyArray<RosterSketch>
): CarrierKind => {
	if (c.kind === "literal") {
		return { kind: "literal" }
	}
	const f = c.field
	const roster = (at: number): string => rosterName(Arr.getUnsafe(rosters, at))
	switch (f.kind) {
		case "closedId":
			return { kind: "code", roster: roster(f.roster) }
		case "bits":
			return { kind: "bits", roster: roster(f.roster) }
		case "contract":
			return f.base.kind === "closedId"
				? { kind: "code", roster: roster(f.base.roster) }
				: { kind: "plain" }
		case "pg":
		case "numeric":
		case "uuid":
		case "text":
		case "span":
		case "vector":
			return { kind: "plain" }
	}
}

/** The rule as a checker: whether two carrier kinds meet in one union field. */
export const meet = (x: CarrierKind, y: CarrierKind): boolean => {
	if (x.kind === "bits" || y.kind === "bits") {
		return x.kind === "bits" && y.kind === "bits" && x.roster === y.roster
	}
	if (x.kind === "literal" || y.kind === "literal") {
		return true
	}
	if (x.kind === "code" || y.kind === "code") {
		return x.kind === "code" && y.kind === "code" && x.roster === y.roster
	}
	return true
}

/** A head literal's carrier: the constant column a union's literal arm delivers. */
export const literalCarrier = (text: string): Carrier =>
	Object.freeze({
		column: constantColumn(text, { carrier: "text" }),
		sql: "text"
	})

export type UnionFeature =
	| "united"
	| "refused"
	| "a set meets a set of its roster's name"
	| "a closed id meets a head literal"
	| "a contract over a closed id"
	| "two rosters of one name"
	| "closed ids of two rosters"
