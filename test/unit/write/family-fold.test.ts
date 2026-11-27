/**
 * The host's fills of a fold (runtime/write/fill.ts `filler`, W3.P2): every member's index and successor, each
 * plane's before and after, named or hidden, and the owner's count and ends, from one family's members in
 * slot order.
 *
 * The oracles: NP's reference fold (test/support/families/fold.ts `folded`), a second implementation in exact bigint
 * arithmetic, which the fills must equal slot for slot and at the end; and the monoid's identity, which every base must
 * equal: each plane's before at the first slot, and an empty family's end.
 *
 * Bound: every monoid on every carrier it admits (count on natural; sum on int2, int4, int8, natural and numeric(4, 1);
 * or and twos on a two-handle roster's sets; max on int2, int4, int8, natural, a closed id and money), over an ordered
 * family with named accumulators or hidden ones and a counted family with hidden ones, stepping over every member or
 * those a selection holds of, a boolean's or two vectors' comparison, v <> w, which the host evaluates over the vectors'
 * own host values: 126 folds, each over every family of up to three members drawn from the carrier's small
 * values (three a plane, four a set), each member selected or not. A sum over money is refused at the fold's typing,
 * so it has no fill. The named mutant, the base seeded from the first member, is a first before that is no identity,
 * which the identity assertion refuses wherever the first member's value is not the identity.
 *
 * Features: each monoid, an empty family, a member stepped over, a member a vector comparison steps over, hidden
 * accumulators, a counted family.
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { columnKey, columnKeyOf } from "#compiler/ir/law.ts"
import { fillsWhole } from "#compiler/runtime/write/fill.ts"
import { succeeded } from "#test/support/assert.ts"
import { cellAt } from "#test/support/cells.ts"
import { folded, identityOf } from "#test/support/families/fold.ts"
import {
	caseGen,
	compiledFills,
	expectedAt,
	type FoldFeature,
	foldMonoid,
	nestingOf,
	shapeKey,
	planesAt
} from "#test/unit/write/family-fold.fixtures.ts"

/** The host fold, exhaustively fills every fold's accumulators and ends as the reference fold does, and starts every base at its monoid's identity. */
export const theHostFoldExhaustivelyFillsEveryFoldsAccumulatorsAndEndsAsTheReferenceFoldDoesAndStartsEveryBaseAtItsMonoidsIdentity =
	property.exhaust(finite(caseGen), {
		needs: { fills: compiledFills },
		situations: [
			"monoid count",
			"monoid sum",
			"monoid or",
			"monoid twos",
			"monoid max",
			"an empty family",
			"a member stepped over",
			"a member a vector comparison steps over",
			"hidden accumulators",
			"a counted family"
		] satisfies ReadonlyArray<Reached<FoldFeature>>,
		check: (resources, note: Case<FoldFeature>) => (c) =>
			Effect.map(resources.fills, (compiled) => {
				const fills = compiled.get(shapeKey(c.shape))
				if (fills === undefined) {
					return
				}
				note.note(`monoid ${c.shape.monoid}`)
				const filled = succeeded(
					fills.fill(nestingOf(c, fills.columns), { kind: "top" }, fillsWhole),
					"a family of admitted values fills"
				)
				const m = foldMonoid(c.shape)
				const steps = Arr.map(c.members, (member) => ({
					x: member.x,
					selected: c.shape.selection === "none" || member.flag
				}))
				const expected = folded(m, steps)
				const [fold] = fills.family.folds
				const plain = defined(fold, "the family's one fold")
				const befores = Arr.map(plain.planes, (p) => columnKey(p.before))
				const afters = Arr.map(plain.planes, (p) => columnKey(p.after))
				const ends = Arr.map(plain.planes, (p) => columnKeyOf(p.end.name))
				const members = defined(filled.families[0], "the owner's family").members
				assert.equal(members.length, c.members.length, "every member is filled")
				assert.equal(
					cellAt(fills.columns, filled, columnKeyOf("n")),
					BigInt(c.members.length),
					"the count is drawn"
				)
				for (const [slot, row] of members.entries()) {
					const reference = defined(expected.slots[slot], "a reference slot")
					assert.deepEqual(
						planesAt(fills.columns, row, befores),
						expectedAt(c.shape.carrier, reference.before),
						`slot ${slot}'s before`
					)
					assert.deepEqual(
						planesAt(fills.columns, row, afters),
						expectedAt(c.shape.carrier, reference.after),
						`slot ${slot}'s after`
					)
					assert.equal(
						cellAt(fills.columns, row, columnKey(fills.family.shape.index)),
						BigInt(slot),
						"the index is the slot"
					)
					assert.equal(
						cellAt(fills.columns, row, columnKeyOf(fills.family.next)),
						BigInt(slot + 1 < c.members.length ? slot + 1 : slot),
						"every member's successor is the slot after it, its own at the last"
					)
					if (c.shape.selection !== "none" && c.members[slot]?.flag === false) {
						note.note("a member stepped over")
						if (c.shape.selection === "vectors") {
							note.note("a member a vector comparison steps over")
						}
					}
				}
				assert.deepEqual(
					planesAt(fills.columns, filled, ends),
					expectedAt(c.shape.carrier, expected.end),
					"the end is the last after"
				)
				const identity = identityOf(m)
				const first = members[0]
				if (first === undefined) {
					note.note("an empty family")
					assert.deepEqual(
						planesAt(fills.columns, filled, ends),
						expectedAt(c.shape.carrier, identity),
						"an empty family ends at the identity"
					)
				} else {
					assert.deepEqual(
						planesAt(fills.columns, first, befores),
						expectedAt(c.shape.carrier, identity),
						"the first before is the identity"
					)
				}
				if (c.shape.accumulators === "hidden") {
					note.note("hidden accumulators")
				}
				if (c.shape.order === "counted") {
					note.note("a counted family")
				}
			}),
		oracle: {
			kind: "second-implementation",
			name: "folded (test/support/families/fold.ts)"
		},
		box: "every admitted fold of the 126 shapes over every family of up to three members of each carrier's small values",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/ir/monoid.ts",
				original: '\t\t{ fn: "union", delta: "met" }',
				replacement: '\t\t{ fn: "union", delta: "step" }',
				why: "twos' second plane takes the union of the member's set, not of its meet with the ones before it (ir/monoid.ts, which every site reads); the reference fold disagrees."
			},
			{
				file: "packages/engine/src/runtime/write/fill.ts",
				original:
					'\t\tcase "predecessor":\n\t\t\treturn row.place.kind !== "member" || row.place.predecessor === undefined\n\t\t\t\t? Result.ok(rule.base)\n\t\t\t\t: filledBefore(row.place.predecessor, rule.to, row, evaluate)',
				replacement:
					'\t\tcase "predecessor": {\n\t\t\tconst after = row.layout.byPosition.get(rule.to)?.rule\n\t\t\tconst predecessor = row.place.kind === "member" ? row.place.predecessor : undefined\n\t\t\tif (predecessor === undefined && after?.kind === "after" && after.fold.monoid === "max" && after.step.kind === "value") {\n\t\t\t\treturn valueOf(row, after.step.x, evaluate)\n\t\t\t}\n\t\t\treturn predecessor === undefined\n\t\t\t\t? Result.ok(rule.base)\n\t\t\t\t: filledBefore(predecessor, rule.to, row, evaluate)\n\t\t}',
				why: "A max fold's first before is seeded from the first member's value, not the identity; the fills disagree with the reference fold at slot 0's before."
			},
			{
				file: "packages/engine/src/runtime/write/fill.ts",
				original: "\t\t\t\t\t\t: evaluatedValue(type, value)",
				replacement:
					'\t\t\t\t\t\t: baseOf(type).carrier === "vector"\n\t\t\t\t\t\t\t? undefined\n\t\t\t\t\t\t\t: evaluatedValue(type, value)',
				why: "The host evaluator reads no vector column, as it did before one host value form, so a fold stepping over v <> w refuses every member as factShape; the fills disagree with the reference fold."
			}
		]
	})
