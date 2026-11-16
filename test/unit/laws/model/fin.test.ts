/**
 * A family's natives are exactly fin.md §5.2's lemmas on w4-w7 §2.1's three axes, read from the law model's native
 * objects, never from SQL text. The oracle is the specification turned into a checker: §2.1's table states, for each
 * shape, the foreign keys (their pairs as a set, their update action and their deferral), the keys and the CHECKs, and
 * the checker builds that expectation from the shape alone.
 *
 * - **owner:** Member(g…, ‹n›, carried…) → Owner(k…, n, carried…), ON UPDATE CASCADE, immediate (the owner is
 *   immutable, so no cascade feeds its target);
 * - **predecessor:** Member(g…, ‹p›, carried…) → Member(g…, i, carried…), immediate when ordered and deferred when
 *   counted;
 * - **last:** Owner(k…, ‹pn›, carried…) → Member(g…, i, carried…), deferred (the owner ↔ family cycle);
 * - **keys:** `UNIQUE (g…, i)`, a superkey per distinct carried set on each target, and no other;
 * - **merging:** every containment that rides an axis has no native of its own: its pairs are the axis's, its law is
 *   among the axis's laws after the family's, and its lowering lists the axis's foreign key;
 * - **the bound:** the family's CHECK accepts exactly the rows where `i < ‹n›`, and for a counted index `0 ≤ i < ‹n›`,
 *   since a law column has no natural domain;
 * - **the pins:** an accumulated copy's containment states the base pin `base > 0 OR f = start` on its source, the
 *   index on the predecessor axis and the count on the last; the owner axis of a family over every fact has no base;
 * - **the generated columns:** ‹p› is pred of the index and ‹pn› pred of the count, NULL at 0.
 *
 * Bound: every family of group width 1 or 2, ordered or counted, with a caller copy or none and an accumulated copy or
 * none on each axis it admits: 2 × 4³ ordered and 2 × 4 counted, 136 schemas, exhausted. A CHECK is judged on every
 * index and count in 0 … 3, the index from −1 when counted, and a pin on every base in 0 … 2 against its start and
 * another value. A lemma restated on an axis is judged on every family of either order and width, on each axis its
 * sides can name.
 *
 * Features: the shapes' orders, widths and copies on each axis; each axis a lemma is restated on; one to three counted
 * families, folded and unfolded.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import type { NativeOf } from "#compiler/ir/law.ts"
import { assert } from "#test/support/assert.ts"
import {
	checkDisjoint,
	checkShape,
	type DisjointFeature,
	disjointFeatures,
	disjointGen,
	expectedForeignKeys,
	type Feature,
	features,
	lemmaOf,
	type RestatedFeature,
	restatedGen,
	schemaOf,
	shapeGen
} from "#test/unit/laws/model/fin.fixtures.ts"
import {
	familyLaw,
	foreignKeyShapes,
	loweringOf,
	modelOf,
	ridingLaws
} from "#test/unit/laws/model/natives.ts"

/** A family's natives are §2.1's three axes every family of group width 1 or 2, ordered or counted, with 0 to 2 copies on each axis. */
export const aFamilysNativesAre21sThreeAxesEveryFamilyOfGroupWidth1Or2OrderedOrCountedWith0To2CopiesOnEachAxis =
	property.exhaust(finite(shapeGen), {
		needs: {},
		situations: features satisfies ReadonlyArray<Reached<Feature>>,
		check: (_, c: Case<Feature>) => (s) =>
			Effect.sync(() => {
				c.note(s.order)
				if (s.width === 2) {
					c.note("two group fields")
				}
				for (const [axis, feature] of [
					["owner", "an owner copy"],
					["predecessor", "a predecessor copy"],
					["last", "a last copy"]
				] as const) {
					if (s[axis].length > 0) {
						c.note(feature)
					}
					if (s[axis].length > 1) {
						c.note("two copies on one axis")
					}
					if (Arr.contains(s[axis], "accumulated")) {
						c.note("an accumulated copy")
					}
				}
				checkShape(s)
			}),
		oracle: {
			kind: "specification",
			name: "w4-w7 §2.1's axis table as a checker, its CHECKs by the reference evaluator"
		},
		box: "every family of group width 1 or 2, ordered or counted, with a caller copy or none and an accumulated copy or none on each axis it admits",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/laws/model/plan.ts",
				original: '\t\t\t\t\t? "immediate"',
				replacement: '\t\t\t\t\t? "deferred"',
				why: "An ordered family's predecessor axis deferred (laws/model/plan.ts family axes); the axis table fails."
			}
		]
	})

/** A family's natives are §2.1's three axes a restated lemma rides its axis with no pair: its law is on the axis's foreign key, which names it. */
export const aFamilysNativesAre21sThreeAxesARestatedLemmaRidesItsAxisWithNoPairItsLawIsOnTheAxissForeignKeyWhichNamesIt =
	property.exhaust(finite(restatedGen), {
		needs: {},
		situations: [
			"owner",
			"predecessor",
			"last",
			"counted",
			"two group fields"
		] satisfies ReadonlyArray<Reached<RestatedFeature>>,
		check: (_, c: Case<RestatedFeature>) => (r) =>
			Effect.sync(() => {
				c.note(r.axis)
				if (r.shape.order === "counted") {
					c.note("counted")
				}
				if (r.shape.width === 2) {
					c.note("two group fields")
				}
				const desc = schemaOf(r.shape)
				const model = modelOf({
					...desc,
					statements: [...desc.statements, lemmaOf(r)]
				})
				assert.deepEqual(
					foreignKeyShapes(model),
					expectedForeignKeys(r.shape),
					"a restated lemma adds no foreign key"
				)
				const law = familyLaw(model, { owner: "Owner", count: "n" })
				const [riding, ...more] = ridingLaws(model, r.axis)
				assert.ok(
					riding !== undefined && more.length === 0,
					`the restated ${r.axis} lemma rides its axis`
				)
				const [fk, ...others] = Arr.filter(
					loweringOf(model, riding),
					(o): o is NativeOf<"ForeignKey"> => o.kind === "ForeignKey"
				)
				assert.ok(
					fk !== undefined && others.length === 0,
					`the restated ${r.axis} lemma lowers to its axis's foreign key`
				)
				assert.equal(fk.lawIds[0], law, "the axis reports the family's law first")
				assert.ok(Arr.contains(fk.lawIds, riding), `the ${r.axis} axis names the restated lemma`)
			}),
		oracle: { kind: "specification", name: "w4-w7 §2.1's merging rule" },
		box: "a family of either order and width with its lemma restated on each axis its sides can name",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/theory/families.ts",
				original: "\t\t\t\tpairs.length >= width &&",
				replacement: "\t\t\t\tpairs.length > width &&",
				why: "A containment rides an axis only beside a carried pair, so a restated lemma lowers to its own foreign key; the restated lemmas fail."
			}
		]
	})

/** A family's natives are §2.1's three axes a member in several counted families: every family's columns and axes its own. */
export const aFamilysNativesAre21sThreeAxesAMemberInSeveralCountedFamiliesEveryFamilysColumnsAndAxesItsOwn =
	property.exhaust(finite(disjointGen), {
		needs: {},
		situations: disjointFeatures satisfies ReadonlyArray<Reached<DisjointFeature>>,
		check: (_, c: Case<DisjointFeature>) => (d) =>
			Effect.sync(() => {
				c.note(d.length === 1 ? "1 counted" : d.length === 2 ? "2 counted" : "3 counted")
				if (Arr.contains(d, true)) {
					c.note("a folded family")
				}
				if (Arr.contains(d, false)) {
					c.note("an unfolded family")
				}
				if (Arr.contains(d, true) && Arr.contains(d, false)) {
					c.pair("a folded family", "an unfolded family")
				}
				checkDisjoint(d)
			}),
		oracle: {
			kind: "specification",
			name: "rows-first §1: each family's drawn columns and axes distinct by identity"
		},
		box: "a member in 1 to 3 counted families, each folded by a sum or not",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/theory/families.ts",
				original: '\t\tcopy: drawnColumn("copy", id, law),\n\t\tmembers\n\t})',
				replacement:
					'\t\tcopy: drawnColumn(indexField === undefined ? "index" : "copy", id, law),\n\t\tmembers\n\t})',
				why: "A counted family's copy drawn as its index column (analysis/theory/families.ts familyShape); the disjoint families fail."
			}
		]
	})
