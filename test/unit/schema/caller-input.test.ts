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
 *
 * Features: each pair of carriers the rule tells apart, closed ids of two rosters among them, a meeting and a refusal.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { aimed } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { carrierUnion } from "#compiler/schema/record.ts"
import { closedBuilder } from "#compiler/schema/relation.ts"
import type { Carrier } from "#compiler/types/core/phantom.ts"
import { throwsRefused } from "#test/support/assert.ts"
import { type DrawnRoster, fieldOf } from "#test/support/unit/schema/field-sketch.ts"
import { upTo } from "#test/support/up-to.ts"
import {
	type CarrierSketch,
	closedIdsOfTwoRostersGen,
	kindOf,
	literalCarrier,
	meet,
	rosterName,
	type UnionCase,
	unionCaseGen,
	type UnionFeature
} from "#test/unit/schema/caller-input.fixtures.ts"

/** Caller input refuses a union of carriers that meet no column, and unites every other pair. Its budget is its suite's before it was a property (test/unit/schema/caller-input.test.ts at 4ca3036a): 200 runs and 200 steered cases. */
export const callerInputRefusesAUnionOfCarriersThatMeetNoColumnAndUnitesEveryOtherPair =
	property.explore(
		aimed<UnionCase, UnionFeature>(unionCaseGen, [
			["closed ids of two rosters", closedIdsOfTwoRostersGen]
		]),
		{
			needs: {},
			budget: { runs: 200, steered: 200 },
			situations: [
				"united",
				"refused",
				"a set meets a set of its roster's name",
				"a closed id meets a head literal",
				"a contract over a closed id",
				"two rosters of one name",
				"closed ids of two rosters"
			] satisfies ReadonlyArray<Reached<UnionFeature>>,
			check: (_, k: Case<UnionFeature>) => (c) =>
				Effect.sync(() => {
					const rosters: Arr.NonEmptyReadonlyArray<DrawnRoster> = Arr.map(c.rosters, (r) =>
						closedBuilder(
							rosterName(r),
							Arr.prepend(
								Arr.map(
									upTo(r.handles - 1, (i) => i + 1),
									(h) => `h${h}`
								),
								"h0"
							),
							"ordered",
							[]
						)
					)
					const carrierOf = (s: CarrierSketch): Carrier =>
						s.kind === "literal" ? literalCarrier(s.text) : fieldOf(s.field, rosters)
					const [x, y] = [kindOf(c.x, c.rosters), kindOf(c.y, c.rosters)]
					if (x.kind === "code" && y.kind === "code" && x.roster !== y.roster) {
						k.note("closed ids of two rosters")
					}
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
				}),
			oracle: {
				kind: "specification",
				name: "a set meets only a set of its roster, a closed id only one of its roster or a head literal, any other pair here"
			},
			kept: [],
			kills: [
				{
					file: "packages/engine/src/schema/record.ts",
					original: '\t\treturn x.kind === "code" && y.kind === "code" && x.roster === y.roster',
					replacement: '\t\treturn x.kind === "code" && y.kind === "code"',
					why: "Two closed ids of different rosters meet (schema/record.ts columnsMeet)."
				}
			]
		}
	)
