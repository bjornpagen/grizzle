/**
 * A closed relation's rows are indexed for the host's reads of them once, whatever evaluates over them: every write's
 * front end over a schema, or over a role of it, reads one index of each closed relation (runtime/write/fill.ts
 * closedIndexOf over check/schema.ts ClosedRelation `host`), where each front end indexed every closed relation of its
 * schema afresh and held its index (metis's full installation: 261 front ends a workload's plan holds, each with an index
 * of the schema's 261 closed relations, 1.4 GB of its heap as its changes compiled).
 *
 * The box, exhausted: Work (its roster) and Plans (a roster and a closed relation over it), each read as reality and
 * Plans as its reader role over the same base, with one and with eight front ends of a write compiled over reality.
 *
 * Property, per case: each closed relation's index, read through the base's table and through each role's, twice, is
 * one value; and the TupleMaps alive, counted by V8 after a full collection, with every front end held are those alive
 * with the first alone held (ir TupleMap: an index holds two). Oracle: specification, an index is a function of its
 * rows. Kills: the table built of fresh rows each time it is read; the index made at each read.
 *
 * Features: one front end, several front ends, a role over the base.
 */

import { queryObjects } from "node:v8"
import { TupleMap } from "@bjornpagen/grizzle-text/base/tuple-map"
import { assert } from "@bjornpagen/testing/assert"
import { element, finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { type CheckedSchema, checkedRoleOver, closedTableOf } from "#compiler/analysis/schema.ts"
import type { ChangeSetDesc } from "#compiler/ir/desc.ts"
import { parseSchemaInput } from "#compiler/program/input.ts"
import { closedIndexOf } from "#compiler/runtime/write/fill.ts"
import { ownRole } from "#compiler/schema/own.ts"
import {
	compileChangeSet,
	type FrontendOptions,
	type WriteFrontend
} from "#compiler/write/frontend/compile.ts"
import { succeeded } from "#test/support/assert.ts"
import { frontendOptions } from "#test/support/compile.ts"
import { Plans, plansWorlds, Work } from "#test/support/fixtures/api/work.ts"
import { checking } from "#test/support/policy.ts"
import { descOf, switchToManual } from "#test/support/unit/write/changeset/fixtures.ts"

type Feature = "one front end" | "several front ends" | "a role over the base"

type Shape = "Work" | "Plans"

/** The TupleMaps alive, counted by V8 after a full collection. */
const tupleMapsAlive = (): number => queryObjects(TupleMap, { format: "count" })

/** The roles a case reads over its base: Plans' reader, none of Work's. */
const rolesOver = (shape: Shape, base: CheckedSchema): ReadonlyArray<CheckedSchema> => {
	if (shape === "Work") {
		return []
	}
	const input = succeeded(parseSchemaInput(plansWorlds(Plans).reader), "the reader parses")
	if (input.kind !== "role") {
		throw new Error("the reader is a role")
	}
	const role = succeeded(ownRole(input.desc), "the reader owns")
	return [succeeded(checkedRoleOver(role, base), "the reader checks over the base")]
}

/** A write over Work compiled `count` times over one checked schema, its front ends held. */
const frontendsOver =
	(checked: CheckedSchema, options: FrontendOptions, desc: ChangeSetDesc) =>
	(count: number): ReadonlyArray<WriteFrontend> =>
		Array.from({ length: count }, () =>
			succeeded(compileChangeSet(checked, desc, options), "the write's front end")
		)

/** A closed relation's index is made once for its rows, whatever reads them: every front end's and role's is one. */
export const aClosedRelationsIndexIsMadeOnceForItsRowsEveryFrontEndAndRoleOverItsSchemaReadsTheSameOne =
	property.exhaust(
		finite((source) => ({
			shape: source.draw(element<Shape>(["Work", "Plans"])),
			frontends: source.draw(element<1 | 8>([1, 8]))
		})),
		{
			needs: {},
			situations: ["one front end", "several front ends", "a role over the base"],
			check:
				(_, k: Case<Feature>) =>
				({ shape, frontends }) =>
					Effect.sync(() => {
						const base = checking(shape === "Work" ? Work : Plans)
						const roles = rolesOver(shape, base)
						if (roles.length > 0) {
							k.note("a role over the base")
						}
						const first = closedIndexOf(closedTableOf(base))
						assert.ok(first.size > 0, `${shape}: closed relations`)
						for (const schema of [base, ...roles]) {
							const again = closedIndexOf(closedTableOf(schema))
							for (const [name, index] of first) {
								assert.ok(again.get(name) === index, `${shape}: ${name} indexed once`)
							}
						}
						k.note(frontends === 1 ? "one front end" : "several front ends")
						const compiled = frontendsOver(
							checking(Work),
							frontendOptions(Work),
							descOf(switchToManual())
						)
						const one = compiled(1)
						const alone = tupleMapsAlive()
						const held = compiled(frontends)
						assert.equal(
							tupleMapsAlive() - alone,
							0,
							`${frontends} front end(s) held beside the first hold no index of their own`
						)
						assert.ok(one.length + held.length > frontends, "the front ends are held while counted")
					}),
			oracle: {
				kind: "specification",
				name: "a closed relation's index is a function of its rows"
			},
			box: "Work and Plans, each as reality and Plans as its reader over the same base, with one and eight front ends of a write over Work",
			kept: [],
			kills: [
				{
					file: "packages/engine/src/analysis/schema.ts",
					original: "\tnew Map(Array.from(checked.closed, ([name, c]) => [name, c.host] as const))",
					replacement:
						"\tnew Map(Array.from(checked.closed, ([name, c]) => [name, Object.freeze({ ...c.host })] as const))",
					why: "The table is built of fresh rows each time it is read, as closedTableOf built it, so every reader indexes the rows afresh: no index is shared and the front ends' TupleMaps grow with them."
				},
				{
					file: "packages/engine/src/runtime/write/fill.ts",
					original:
						"\t\tArray.from(table, ([name, c]) => [name, indexes.getOrInsertComputed(c, indexedClosed)] as const)",
					replacement: "\t\tArray.from(table, ([name, c]) => [name, indexedClosed(c)] as const)",
					why: "The index is made at each read, as closedIndexOf made it, so each front end holds an index of every closed relation of its schema."
				}
			]
		}
	)
