/**
 * A containment's reverse index never refuses it: its reverse probe binds every referencing column by equality, and an
 * index over a leading run of them serves it, PostgreSQL rechecking the rest. The law model plans a B-tree over the
 * longest leading run of the referencing columns whose datum is bounded, in their order, whose entry fits BTMaxItemSize,
 * else a hash index on one column, which no byte bound limits.
 *
 * Each case is a containment drawn as test/support/laws/reverse.ts draws them, compiled alone. The oracle is the rule
 * restated there: the schema compiles, its one reverse index is the B-tree over the longest leading bounded run that
 * fits, else the hash index on the first column a hash index takes, and every index the installation creates is a
 * B-tree, a hash or a GiST index. Where that run is every referencing column, the drafted DDL holds the structural
 * property (test/support/laws/referencing.ts): an index led by exactly them, or a unique one within them, serves the
 * foreign key, never the interleaved key a case declares, led by the first of them and holding the rest further in. A
 * selected source's reverse index holds law columns, each its field's where the selection holds, so its width is
 * checked; a whole source's holds the fields themselves, so its columns are. PostgreSQL's plan of the probe is
 * test/pg/laws/reverse-probe.test.ts's.
 *
 * Features: free text first, between or last, or only free text; a run cut short by width; a B-tree; a hash index;
 * covered by a declared key; a selected source; into a superkey; a set, and a run it cuts short; a key led by a prefix
 * of the referencing columns.
 */
import { assert, defined } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { firstCodebook } from "#compiler/ir/codes.ts"
import { completeInstallOptions } from "#compiler/physical/complete.ts"
import { compileInstallation } from "#compiler/program/install.ts"
import { installationsOf } from "#compiler/schema/own.ts"
import { rostersOf } from "#compiler/schema/own.ts"
import { succeeded } from "#test/support/assert.ts"
import { assertReferencesServed } from "#test/support/laws/referencing.ts"
import {
	columnNames,
	expectedOf,
	featuresOf,
	type ReverseFeature,
	reverseCaseGen,
	reverseFeatures,
	reverseSchema
} from "#test/support/laws/reverse.ts"
import { ownedInput } from "#test/support/policy.ts"

/** A containment's reverse index is a B-tree over the longest leading bounded run that fits, else a hash index, and never refuses the containment. Its budget is its suite's before it was a property (test/unit/laws/model/reverse-index.test.ts at 4ca3036a): 300 runs and 300 steered cases. */
export const aContainmentsReverseIndexIsABTreeOverTheLongestLeadingBoundedRunThatFitsElseAHashIndexAndNeverRefusesTheContainment =
	property.explore(reverseCaseGen, {
		needs: {},
		budget: { runs: 300, steered: 300 },
		situations: reverseFeatures satisfies ReadonlyArray<Reached<ReverseFeature>>,
		check: (_, k: Case<ReverseFeature>) => (c) =>
			Effect.sync(() => {
				const owned = succeeded(ownedInput(reverseSchema([c])))
				const installation = succeeded(
					compileInstallation(
						owned,
						completeInstallOptions(
							owned,
							installationsOf(owned),
							[],
							[],
							firstCodebook(rostersOf(owned))
						)
					),
					"the containment compiles whatever its referencing columns"
				)
				const reverse = Arr.filter(
					Arr.map(installation.laws.natives, (n) => n.object),
					(o) => o.kind === "ReverseIndex"
				)
				assert.equal(reverse.length, 1, "one reverse index")
				const planned = defined(reverse[0], "the reverse index")
				const plannedNames = Arr.map(planned.columns, (col) =>
					col.kind === "field" ? col.field.name : col.column
				)
				const names = columnNames(c)
				const nameAt = (i: number): string => defined(names[i], "a column name")
				const expected = expectedOf(c)
				assert.equal(planned.method, expected.method, "the reverse index's method")
				const expectedNames: ReadonlyArray<string> =
					expected.method === "btree"
						? Arr.map(expected.positions, nameAt)
						: [nameAt(expected.position)]
				if (c.selected) {
					assert.equal(plannedNames.length, expectedNames.length, "the reverse index's width")
				} else {
					assert.deepEqual<ReadonlyArray<string>>(
						plannedNames,
						expectedNames,
						"the reverse index's columns"
					)
				}
				if (expected.method === "btree" && expected.positions.length === c.types.length) {
					assertReferencesServed(installation.statements)
				}
				k.noteAll(featuresOf(c))
				for (const index of installation.indexes) {
					assert.ok(
						index.method === "btree" || index.method === "hash" || index.method === "gist",
						`an index the installation creates is a B-tree, a hash or a GiST index, not ${index.method}`
					)
				}
			}),
		oracle: {
			kind: "specification",
			name: "test/support/laws/reverse.ts's rule: the B-tree over the longest leading bounded run that fits, else the hash index on the first hashable column"
		},
		kept: [
			{
				token: ReplayToken(
					"test/unit/laws/model/reverse-index.test.ts#aContainmentsReverseIndexIsABTreeOverTheLongestLeadingBoundedRunThatFitsElseAHashIndexAndNeverRefusesTheContainment:-:0.1.0.2.0.0.0.0.0.1"
				),
				reason:
					"Attr(id, value) contained in Ref(id, value), Ref keyed by its id alone and Attr's value text of no bound: the reverse index is the B-tree over the id, which a value of no bound beside it never refuses",
				since: "2026-11-06"
			}
		],
		kills: [
			{
				file: "packages/engine/src/laws/model/plan.ts",
				original:
					"const createdDatum = (c: PlannedColumn): DatumBound | undefined => datumBound(plannedField(c).desc)",
				replacement:
					"const createdDatum = (c: PlannedColumn): DatumBound | undefined => plannedDatum(c) ?? datumBound(plannedField(c).desc)",
				why: "The reverse run is chosen by the law model's bound from below for a set, its roster's handles, so a run holding a set fits by it and the index engine refuses it at the most codes a roster numbers: the containment of A0(c0 uuid, c1 set) is refused."
			},
			{
				file: "packages/engine/src/laws/model/plan.ts",
				original: "\tfor (let n = Math.min(bounded.length, indexMaxKeys); n > 0; n--) {",
				replacement: "\tfor (let n = 1; n <= Math.min(bounded.length, indexMaxKeys); n++) {",
				why: "The B-tree over the shortest leading run that fits, its first column alone (laws/model/plan.ts btreeRun)."
			}
		]
	})
