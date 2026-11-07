import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, codePoint, type Gen, int, string, weighted } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter } from "effect"
import { constantColumn } from "#compiler/core/decoder.ts"
import { closed } from "#compiler/schema/api.ts"
import { carrierUnion } from "#compiler/schema/record.ts"
import type { Carrier } from "#compiler/types/core/phantom.ts"
import { throwsRefused } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import {
	type SketchedField,
	fieldOf,
	fieldSketchGen,
	type DrawnRoster
} from "#test/unit/schema/field-sketch.ts"

/**
 * Caller input a builder refuses as such, never as an internal defect: a union of carriers no column reads.
 *
 * Each case draws one or two rosters, their names from two so they may meet, and two carriers: a field of any drawn
 * type, a contract over a closed id among them, a closed id or a set over a drawn roster, each also an arm of its own,
 * or a head literal's constant column. Oracle: the column rule stated over the carriers' sketches alone, a second statement of schema/record.ts
 * columnsMeet: a set meets only a set of a roster of its name, since no head literal is a set; a closed id, its
 * contract's included, meets only a closed id of a roster of its name or a head literal; and any other two meet here
 * (the checker judges their SQL types).
 *
 * That a context's claims are scalar fields its caller writes is the worlds suite's (test/unit/schema/worlds.test.ts,
 * context admission), over every drawn field type, serial forms included.
 */
interface RosterSketch {
	readonly name: number
	readonly handles: number
}

type CarrierSketch =
	| { readonly kind: "field"; readonly field: SketchedField }
	| { readonly kind: "literal"; readonly text: string }

interface UnionCase {
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

const rosterName = (r: RosterSketch): string => `Kind${r.name}`

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

const unionCaseGen: Gen<UnionCase> = (source) => {
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

/** The kind of a carrier: a contract's is its base's. */
const kindOf = (
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
const meet = (x: CarrierKind, y: CarrierKind): boolean => {
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
const literalCarrier = (text: string): Carrier =>
	Object.freeze({
		column: constantColumn(
			text,
			(cell: string) => cell,
			(literal: unknown, host: unknown) => literal === host
		),
		sql: "text"
	})

type UnionFeature =
	| "united"
	| "refused"
	| "a set meets a set of its roster's name"
	| "a closed id meets a head literal"
	| "a contract over a closed id"
	| "two rosters of one name"

describe("caller input", () => {
	it.effect("refuses a union of carriers that meet no column, and unites every other pair", (ctx) =>
		searched(
			ctx,
			explore(
				{
					suite: "unit/schema/caller-input-union",
					draw: drawn(unionCaseGen),
					literal: Formatter.format,
					oracle: {
						kind: "specification",
						name: "a set meets only a set of its roster, a closed id only one of its roster or a head literal, any other pair here"
					},
					coverage: required<UnionFeature>(
						[
							"united",
							"refused",
							"a set meets a set of its roster's name",
							"a closed id meets a head literal",
							"a contract over a closed id",
							"two rosters of one name"
						],
						{ cases: 200, sense: notesOnly }
					),
					kept: [],
					runs: 200,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang
				},
				(c, k) =>
					Effect.sync(() => {
						const rosters: Arr.NonEmptyReadonlyArray<DrawnRoster> = Arr.map(c.rosters, (r) =>
							closed(
								rosterName(r),
								Arr.prepend(
									Arr.map(Arr.range(1, r.handles - 1), (h) => `h${h}`),
									"h0"
								)
							)
						)
						const carrierOf = (s: CarrierSketch): Carrier =>
							s.kind === "literal" ? literalCarrier(s.text) : fieldOf(s.field, rosters)
						const [x, y] = [kindOf(c.x, c.rosters), kindOf(c.y, c.rosters)]
						if (
							c.rosters.length > 1 &&
							Arr.every(c.rosters, (r) => r.name === Arr.headNonEmpty(c.rosters).name)
						) {
							k.note("two rosters of one name")
						}
						for (const s of [c.x, c.y]) {
							if (
								s.kind === "field" &&
								s.field.kind === "contract" &&
								s.field.base.kind === "closedId"
							) {
								k.note("a contract over a closed id")
							}
						}
						const united = () => carrierUnion({ v: carrierOf(c.x) }, { v: carrierOf(c.y) })
						if (meet(x, y)) {
							k.note("united")
							if (x.kind === "bits") {
								k.note("a set meets a set of its roster's name")
							}
							if (
								(x.kind === "code" && y.kind === "literal") ||
								(x.kind === "literal" && y.kind === "code")
							) {
								k.note("a closed id meets a head literal")
							}
							united()
							return
						}
						k.note("refused")
						throwsRefused(united, "MalformedDescription")
					})
			)
		)
	)
})
