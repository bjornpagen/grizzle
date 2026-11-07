/**
 * A containment's reverse index never refuses it: its reverse probe binds every referencing column by equality, and an
 * index over a leading run of them serves it, PostgreSQL rechecking the rest. The law model plans a B-tree over the
 * longest leading run of the referencing columns whose datum is bounded, in their order, whose entry fits BTMaxItemSize,
 * else a hash index on one column, which no byte bound limits.
 *
 * Each case is a containment drawn as test/support/laws/reverse.ts draws them, compiled alone. The oracle is the rule
 * restated there: the schema compiles, its one reverse index is the B-tree over the longest leading bounded run that
 * fits, else the hash index on the first column, and every index the installation creates is a B-tree, a hash or a
 * GiST index. A selected source's reverse index holds law columns, each its field's where the selection holds, so its
 * width is checked; a whole source's holds the fields themselves, so its columns are. PostgreSQL's plan of the probe is
 * test/pg/laws/reverse-probe.test.ts's.
 */
import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter } from "effect"
import { firstCodebook } from "#compiler/ir/codes.ts"
import { completeInstallOptions } from "#compiler/physical/complete.ts"
import { compileInstallation } from "#compiler/physical/install/compile.ts"
import { rostersOf } from "#compiler/schema/own.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import {
	columnNames,
	expectedOf,
	featuresOf,
	type ReverseFeature,
	reverseCaseGen,
	reverseFeatures,
	reverseSchema
} from "#test/support/laws/reverse.ts"
import { caseHang } from "#test/support/limits.ts"
import { ownedInput } from "#test/support/policy.ts"

describe("a containment's reverse index", () => {
	it.effect(
		"is a B-tree over the longest leading bounded run that fits, else a hash index, and never refuses the containment",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: { kind: "unstated" },
						suite: "unit/laws/model/reverse-index",
						draw: drawn(reverseCaseGen),
						literal: Formatter.format,
						coverage: required<ReverseFeature>(reverseFeatures, { cases: 300, sense: notesOnly }),
						kept: [
							{
								note: "Attr(id, value) contained in Ref(id, value), Ref keyed by its id alone and Attr's value text of no bound: the reverse index is the B-tree over the id, which a value of no bound beside it never refuses",
								sketch: {
									types: [{ kind: "uuid" }, { kind: "free" }],
									covered: false,
									selected: false,
									superkey: true
								},
								draws: "",
								reaches: ["free text last", "a B-tree", "into a superkey"]
							}
						],
						runs: 300,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(c, k) =>
						Effect.sync(() => {
							const owned = succeeded(ownedInput(reverseSchema([c])))
							const installation = succeeded(
								compileInstallation(
									owned,
									completeInstallOptions(
										owned,
										owned.installation,
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
							k.noteAll(featuresOf(c))
							for (const index of installation.indexes) {
								assert.ok(
									index.method === "btree" || index.method === "hash" || index.method === "gist",
									`an index the installation creates is a B-tree, a hash or a GiST index, not ${index.method}`
								)
							}
						})
				)
			)
	)
})
