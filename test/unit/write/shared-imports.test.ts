/**
 * A closed import, an import whose bind map binds each of its query's parameters to a parameter or a constant, reads the
 * same rows wherever it stands, so the checks of one compile build it once and a write's DAG holds it once
 * (check/session.ts CheckSession, check/checker.ts importedKey, write/frontend/dag.ts QueryMerger): a Description shares
 * the queries it imports by reference, and the write DAG is linear in its distinct parts, where a node built at every
 * import, in every member, expanded that sharing into a tree.
 *
 * The boxes, exhausted: a ChangeSet of 1, 2, 4 or 8 inserts, each reading one field of one call of a declared function
 * of eight rows arguments, each argument an import of one bound query over Item and Done (GRADING-SQL's
 * gradeAttemptOf, its every insert reading the one `run`); and one insert of the top of a chain of 1, 4 or 8 bound queries,
 * each level two rules that read the level below.
 *
 * Properties, per case, counting the write DAG's nodes (write/frontend/compile.ts WriteFrontend `ir.dag`): the bound
 * query's scans of Item and of Done are one each, whatever the members, the arguments or the depth; and every member's
 * call reads the same eight argument nodes. Oracle: specification, one node per distinct closed import. Kills: the
 * checker's memo (an import built at every occurrence), the merger's stand-ins (every member's imports its own), and the
 * one resolution of an imported query (each import a resolution of its own, its key its own).
 *
 * Features: one member and several; a chain of one level and of several.
 */

import { assert } from "@bjornpagen/testing/assert"
import { finite } from "@bjornpagen/testing/gen"
import { property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { topoOrder } from "#compiler/ir/dag.ts"
import type { RelNode } from "#compiler/ir/rel.ts"
import { compiled } from "#test/unit/write/changeset/fixtures.ts"
import {
	chainWriteOf,
	depthGen,
	readersGen,
	readersOf,
	Shared
} from "#test/unit/write/shared-imports.fixtures.ts"

/** The scans of `relation` among `nodes`. */
const scansOf = (nodes: ReadonlyArray<RelNode>, relation: string): number =>
	Arr.filter(nodes, (n) => n.kind === "Base" && n.relation === relation).length

const kills = Object.freeze([
	{
		file: "packages/engine/src/check/checker.ts",
		original: "\t\t\timportedKey(this.options.session, src.query, values, false)\n",
		replacement: "\t\t\tundefined\n",
		why: "Every import is built where it stands, so each member's eight arguments read eight scans of Item, and each level of the chain two of the level below: the DAG is a tree of the Description's sharing, and the scans are many."
	},
	{
		file: "packages/engine/src/write/frontend/dag.ts",
		original: "\t\t\treturn key === undefined ? undefined : this.#imports.get(key)\n",
		replacement: "\t\t\treturn undefined\n",
		why: "Each member's closed imports are its own nodes, so two members' calls read two copies of the arguments, and the scans of Item are as many as the members."
	},
	{
		file: "packages/engine/src/ir/desc.ts",
		original: "\t\tconst known = this.#imported.get(q)\n",
		replacement: "\t\tconst known = undefined\n",
		why: "Each import of a query is resolved apart, so no two share a resolved query and no key is any other's: every import is built again, and the scans are many."
	}
])

/** A closed import read by every member of a write is one node of its DAG, its every reader's call reading the same arguments. */
export const aClosedImportReadByEveryMemberOfAWriteIsOneNodeOfItsDagItsEveryReadersCallReadingTheSameArguments =
	property.exhaust(finite(readersGen), {
		needs: {},
		situations: ["one member", "several members"],
		check: (_, k) => (members) =>
			Effect.sync(() => {
				k.note(members === 1 ? "one member" : "several members")
				const nodes = topoOrder(compiled(Shared, readersOf(members)).ir.dag)
				assert.equal(scansOf(nodes, "Item"), 1, "Item is scanned once")
				assert.equal(scansOf(nodes, "Done"), 1, "Done is scanned once")
				const calls = Arr.filter(nodes, (n) => n.kind === "Call")
				assert.equal(calls.length, members, "each member reads one call")
				const argumentsOf = (n: RelNode): ReadonlyArray<RelNode> =>
					n.kind === "Call" ? Arr.flatMap(n.args, (a) => (a.kind === "rows" ? [a.rows] : [])) : []
				const [first, ...rest] = calls
				for (const call of rest) {
					assert.ok(
						Arr.every(argumentsOf(call), (a, i) => a === argumentsOf(first ?? call)[i]),
						"every call reads the same argument nodes"
					)
				}
			}),
		oracle: { kind: "specification", name: "one node per distinct closed import" },
		box: "1, 2, 4 and 8 inserts, each reading one field of one call of eight rows arguments, each an import of one bound query",
		kept: [],
		kills
	})

/** A chain of bound queries, each level reading the one below in two rules, is one node per level in a write's DAG. */
export const aChainOfBoundQueriesEachLevelReadingTheOneBelowInTwoRulesIsOneNodePerLevelInAWritesDag =
	property.exhaust(finite(depthGen), {
		needs: {},
		situations: ["one level", "several levels"],
		check: (_, k) => (depth) =>
			Effect.sync(() => {
				k.note(depth === 1 ? "one level" : "several levels")
				const nodes = topoOrder(compiled(Shared, chainWriteOf(depth)).ir.dag)
				assert.equal(scansOf(nodes, "Item"), 1, `Item is scanned once at depth ${depth}`)
				assert.equal(scansOf(nodes, "Done"), 1, `Done is scanned once at depth ${depth}`)
			}),
		oracle: { kind: "specification", name: "one node per distinct closed import" },
		box: "one insert of the top of a chain of 1, 4 and 8 bound queries, each level two rules reading the level below",
		kept: [],
		kills: Arr.filter(kills, (kill) => kill.file !== "packages/engine/src/write/frontend/dag.ts")
	})
