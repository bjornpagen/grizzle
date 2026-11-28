/**
 * The host's fill of a concat fold (runtime/write/fill.ts `filler`, combineHost's concat): every member's before and
 * after, and the owner's end, over an ordered family whose (before, after) pair is named, stepping over every member
 * or those a selection holds of.
 *
 * The oracle: a naive left fold of the slots' texts, the empty text first, each after its before then its piece where
 * the member is selected and its before elsewhere, the end the last after, the empty text for no member. The box,
 * exhausted: families of up to three members, each piece the empty text, an ASCII letter or a supplementary-plane
 * character, each selected or not, under a fold that selects and one that does not.
 *
 * Features: an empty family, a member stepped over, a supplementary character joined.
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { StoredRelationName } from "#compiler/core/ids.ts"
import { columnKey, columnKeyOf } from "#compiler/ir/law.ts"
import { fillsWhole, type HostNode } from "#compiler/runtime/write/fill.ts"
import { succeeded } from "#test/support/assert.ts"
import { cellAt, cellsOf } from "#test/support/cells.ts"
import { uuidOf } from "#test/support/unit/write/changeset/fixtures.ts"
import { caseGen, type FillFeature, fills } from "#test/unit/write/concat-fill.fixtures.ts"

/** The host fill of a concat fold draws the naive left fold of its slots' texts. */
export const theHostFillOfAConcatFoldDrawsTheNaiveLeftFoldOfItsSlotsTexts = property.exhaust(
	finite(caseGen),
	{
		needs: {},
		situations: [
			"an empty family",
			"a member stepped over",
			"a supplementary character joined"
		] satisfies ReadonlyArray<Reached<FillFeature>>,
		check: (_, k: Case<FillFeature>) => (c) =>
			Effect.sync(() => {
				const { family, columns, fill } = defined(fills[c.selected ? 1 : 0])
				const nesting: HostNode = {
					relation: StoredRelationName("Owner"),
					values: cellsOf(columns, "Owner", [[columnKeyOf("id"), uuidOf(0)]]),
					texts: [],
					families: [
						{
							family: { owner: "Owner", count: "n" },
							members: Arr.map(c.members, (m, i) => ({
								relation: StoredRelationName("Member"),
								values: cellsOf(columns, "Member", [
									[columnKeyOf("id"), uuidOf(i + 1)],
									[columnKeyOf("piece"), m.piece],
									[columnKeyOf("flag"), m.flag]
								]),
								texts: [],
								families: []
							}))
						}
					]
				}
				const filled = succeeded(
					fill(nesting, { kind: "top" }, fillsWhole),
					"a family of texts fills"
				)
				const plane = defined(defined(family.folds[0]).planes[0])
				const rows = defined(filled.families[0], "the owner's family").members
				let running = ""
				for (const [slot, m] of c.members.entries()) {
					const row = defined(rows[slot], `slot ${slot}`)
					const stepped = !c.selected || m.flag
					const after = stepped ? `${running}${m.piece}` : running
					assert.equal(
						cellAt(columns, row, columnKey(plane.before)),
						running,
						`slot ${slot}'s before`
					)
					assert.equal(cellAt(columns, row, columnKey(plane.after)), after, `slot ${slot}'s after`)
					if (!stepped) {
						k.note("a member stepped over")
					}
					if (stepped && m.piece === "\u{1F600}") {
						k.note("a supplementary character joined")
					}
					running = after
				}
				if (c.members.length === 0) {
					k.note("an empty family")
				}
				assert.equal(cellAt(columns, filled, columnKeyOf("joined")), running, "the owner's end")
			}),
		oracle: { kind: "second-implementation", name: "a naive left fold of the slots' texts" },
		box: "families of up to three members, pieces '', 'a' and U+1F600, each selected or not, under a selecting fold and one that does not select",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/ir/monoid.ts",
				original: "\t\treturn build.apply(plane.fn, before, delta)",
				replacement: "\t\treturn build.apply(plane.fn, delta, before)",
				why: "A combine puts its step before its before (ir/monoid.ts, which every site reads), so a concat step puts its piece before the running text, not after it."
			}
		]
	}
)
