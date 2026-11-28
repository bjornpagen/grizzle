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
 * query's scans of Item and of Done are one each, whatever the members, the arguments or the depth; the members' reads
 * of one field of the call are one node (check/checker.ts #closedCall), every one reading the same eight argument nodes;
 * and every read of a field of the call has one evaluation key (lower/conservative/call/keys.ts EvaluationKeys), each
 * digested only where two reads are of one evaluation shape, and then once for every read of one evaluation. Oracle:
 * specification, one node per distinct closed import. Kills: the
 * checker's memo (an import built at every occurrence), the merger's stand-ins (every member's imports its own), and the
 * one resolution of an imported query (each import a resolution of its own, its key its own).
 *
 * And the checks of one compile check each closed import once (check/checker.ts #closedImport, ClosedImport): its every
 * later reader, in any member, reads the node the first check built and completed, adopting what that check recorded,
 * so the checks of the call's arguments (#importAt) are as many for 1, 2, 4 or 8 readers as for one, where every member
 * built and completed the call's imports again (edullm's evaluate: 97 members each rebuilding 651 imports, 14 times the
 * distinct nodes analyzed). Oracle: specification, a closed import is checked once for its compile. Kill: no check reads
 * another's import, so each member checks the eight arguments again.
 *
 * And the logical analyses of one compile's completions share every closed import's annotations (check/session.ts
 * CheckSession analyses, logical/annotate.ts SharedAnalyses): over a chain of bound queries each of whose levels states a
 * merge, so each level's check completes it under the analysis of its own DAG, the levels below among its nodes, the
 * annotations of the write's compile are linear in the depth, each level annotated a fixed number of times, where each
 * level's completion annotated every level below it again, the work quadratic in the depth. Counted as calls of
 * logical/props.ts logicalPropsOf. Oracle: linearity, read off the chain: every level is alike, so each costs the
 * compile what the third added to the second. Kill: the session's analyses share nothing.
 *
 * And a closed import's record holds what its check recorded beside its own nodes alone (check/checker.ts #ownNodes,
 * #nodeFacts): a closed import it reads stands in it by its root, its own nodes in its own record, which a reader adopts
 * with it, so over the float chain the nodes whose facts the compile's records take are linear in the depth, each level's
 * own taken once, where each level's record took every level below it again, the records' facts quadratic in the depth.
 * Counted as calls of #nodeFacts. Oracle: linearity, as above. Kill: a record walks its import's whole DAG.
 *
 * And a compile's checks' session, which holds every closed import's record and every shared analysis of the compile, is
 * the compile's alone: once a write is compiled and held, the sessions alive are those alive before its compile, counted
 * by V8 after a full collection (node:v8 queryObjects over check/session.ts CheckSession). Oracle: specification. Kill:
 * every session is held by a module.
 *
 * Features: one member and several; a chain of one level and of several; a float chain of two levels and of more.
 */

import { queryObjects } from "node:v8"
import { assert } from "@bjornpagen/testing/assert"
import { finite } from "@bjornpagen/testing/gen"
import { property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, String as Str } from "effect"
import { CheckSession } from "#compiler/check/session.ts"
import { DagTemplates } from "#compiler/ir/dag-digest.ts"
import { topoOrder } from "#compiler/ir/dag.ts"
import type { RelNode } from "#compiler/ir/rel.ts"
import { EvaluationKeys } from "#compiler/lower/conservative/call/keys.ts"
import { callCounts } from "#test/support/kernel/calls.ts"
import { compiled } from "#test/support/unit/write/changeset/fixtures.ts"
import {
	chainWriteOf,
	depthGen,
	type FloatDepth,
	Floats,
	floatChainWriteOf,
	floatDepthGen,
	type Readers,
	readersGen,
	readersOf,
	Shared
} from "#test/support/unit/write/shared-imports.fixtures.ts"

/** The scans of `relation` among `nodes`. */
const scansOf = (nodes: ReadonlyArray<RelNode>, relation: string): number =>
	Arr.filter(nodes, (n) => n.kind === "Base" && n.relation === relation).length

const kills = Object.freeze([
	{
		file: "packages/engine/src/check/checker.ts",
		original:
			"\t\treturn this.#keyedImport(src, values, loc, importedKey(this.options.session, src.query, values))\n",
		replacement: "\t\treturn this.#importAt(src, values, loc)\n",
		why: "Every import is built where it stands, so each member's eight arguments read eight scans of Item, and each level of the chain two of the level below: the DAG is a tree of the Description's sharing, and the scans are many."
	},
	{
		file: "packages/engine/src/write/frontend/dag.ts",
		original: "\t\t\treturn key === undefined ? undefined : this.#imports.get(key)\n",
		replacement: "\t\t\treturn undefined\n",
		why: "Each member's closed imports are its own nodes, so two members' calls read two copies of the arguments, and the scans of Item are as many as the members."
	},
	{
		file: "packages/engine/src/check/checker.ts",
		original: "\t\tif (called.key === undefined) {\n",
		replacement: "\t\tif (true) {\n",
		why: "Every read of a field of a closed call is a call of its own, so the members reading one field read as many call nodes as they are."
	},
	{
		file: "packages/engine/src/lower/conservative/call/keys.ts",
		original: `\t\tconst key = this.#reads.get(shape) === 1 ? \`shape:\${shape}\` : this.#digest(read)\n`,
		replacement: "\t\tconst key = this.#digest(read)\n",
		why: "Every read's evaluation key is digested, its evaluation shape shared or not, so a lone read is digested too."
	},
	{
		file: "packages/engine/src/lower/conservative/call/keys.ts",
		original: "\t\tconst known = this.#evaluations.get(identity)\n",
		replacement: "\t\tconst known = undefined\n",
		why: "Each read of a field of one call digests the evaluation it reads again, as before evaluations were digested once: the members' two reads of one evaluation are digested twice."
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
				const dag = compiled(Shared, readersOf(members)).ir.dag
				const nodes = topoOrder(dag)
				assert.equal(scansOf(nodes, "Item"), 1, "Item is scanned once")
				assert.equal(scansOf(nodes, "Done"), 1, "Done is scanned once")
				const calls = Arr.filter(nodes, (n) => n.kind === "Call")
				assert.equal(
					calls.length,
					Math.min(members, 2),
					"the members' reads of one field of the call are one node"
				)
				const keys = new EvaluationKeys(dag, new DagTemplates("derivation"))
				const evaluations = new Set(Arr.map(calls, (n) => keys.of(n)))
				assert.equal(evaluations.size, 1, "every read of a field of the call reads one evaluation")
				assert.equal(
					keys.digested,
					calls.length > 1 ? 1 : 0,
					"the reads' keys are digested only where two reads are of one evaluation shape, once for each evaluation they read"
				)
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
		kills: Arr.filter(
			kills,
			(kill) =>
				Str.includes("importedKey")(kill.original) || kill.file === "packages/engine/src/ir/desc.ts"
		)
	})

/** The checks of imports (check/checker.ts #importAt) while a write of `members` readers of the call compiles. */
const importChecks = (members: Readers): Effect.Effect<number> =>
	Effect.map(
		callCounts(
			Effect.sync(() => compiled(Shared, readersOf(members))),
			{ imports: { file: "packages/engine/src/check/checker.ts", name: "#importAt" } }
		),
		([, counts]) => counts.imports
	)

/** The checks of one compile check each closed import once, however many members read it. */
export const theChecksOfOneCompileCheckEachClosedImportOnceHoweverManyMembersReadIt =
	property.exhaust(finite(readersGen), {
		needs: {},
		situations: ["one member", "several members"],
		check: (_, k) => (members) =>
			Effect.gen(function* () {
				k.note(members === 1 ? "one member" : "several members")
				const one = yield* importChecks(1)
				const many = yield* importChecks(members)
				assert.ok(one > 0, "one reader checks the call's imports")
				assert.equal(many, one, `${members} readers check the call's imports as one reader does`)
			}),
		oracle: { kind: "specification", name: "a closed import is checked once for its compile" },
		box: "1, 2, 4 and 8 inserts, each reading one field of one call of eight rows arguments, each an import of one bound query",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/check/checker.ts",
				original: "\t\tconst prior = compiled.get(at)\n",
				replacement: "\t\tconst prior = undefined\n",
				why: "No check reads an import another check of the compile built, so every member checks the call's eight arguments again and the checks grow with the members."
			}
		]
	})

/** The annotations (logical/props.ts logicalPropsOf) while a write of the top of a float chain `depth` deep compiles. */
const floatAnnotations = (depth: FloatDepth): Effect.Effect<number> =>
	Effect.map(
		callCounts(
			Effect.sync(() => compiled(Floats, floatChainWriteOf(depth))),
			{ props: { file: "packages/engine/src/logical/props.ts", name: "logicalPropsOf" } }
		),
		([, counts]) => counts.props
	)

/** A compile's completions annotate each level of a chain of closed imports a fixed number of times, however deep. */
export const aCompilesCompletionsAnnotateEachLevelOfAChainOfClosedImportsAFixedNumberOfTimesHoweverDeep =
	property.exhaust(finite(floatDepthGen), {
		needs: {},
		situations: ["two levels", "more levels"],
		check: (_, k) => (depth) =>
			Effect.gen(function* () {
				k.note(depth === 2 ? "two levels" : "more levels")
				const two = yield* floatAnnotations(2)
				const three = yield* floatAnnotations(3)
				const work = yield* floatAnnotations(depth)
				assert.ok(three > two, "a level more annotates more")
				assert.equal(
					work,
					two + (depth - 2) * (three - two),
					`a chain ${depth} deep annotates what two levels and ${depth - 2} levels more of what the third added do`
				)
			}),
		oracle: {
			kind: "universal",
			name: "linearity: the annotations of a chain d deep are its two levels' and d − 2 times what the third level added"
		},
		box: "one insert of the top of a chain of 2, 3, 4, 6 and 8 bound queries over a float relation, each level one rule delivering its float",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/check/session.ts",
				original: "\t\t(node) => this.closedKey(node) !== undefined\n",
				replacement: "\t\t() => false\n",
				why: "The session's analyses share nothing, so each level's completion annotates every level below it again and the annotations grow with the square of the depth."
			}
		]
	})

/** The nodes whose facts a closed import's record takes (check/checker.ts #nodeFacts) while a float chain compiles. */
const recordedNodes = (depth: FloatDepth): Effect.Effect<number> =>
	Effect.map(
		callCounts(
			Effect.sync(() => compiled(Floats, floatChainWriteOf(depth))),
			{ facts: { file: "packages/engine/src/check/checker.ts", name: "#nodeFacts" } }
		),
		([, counts]) => counts.facts
	)

/** A compile's closed-import records take each level of a chain's own nodes once, however deep the chain. */
export const aCompilesClosedImportRecordsTakeEachLevelsOwnNodesOnceHoweverDeepTheChain =
	property.exhaust(finite(floatDepthGen), {
		needs: {},
		situations: ["two levels", "more levels"],
		check: (_, k) => (depth) =>
			Effect.gen(function* () {
				k.note(depth === 2 ? "two levels" : "more levels")
				const two = yield* recordedNodes(2)
				const three = yield* recordedNodes(3)
				const work = yield* recordedNodes(depth)
				assert.ok(three > two, "a level more records more")
				assert.equal(
					work,
					two + (depth - 2) * (three - two),
					`a chain ${depth} deep records what two levels and ${depth - 2} levels more of what the third added do`
				)
			}),
		oracle: {
			kind: "universal",
			name: "linearity: the nodes recorded over a chain d deep are its two levels' and d − 2 times what the third level added"
		},
		box: "one insert of the top of a chain of 2, 3, 4, 6 and 8 bound queries over a float relation, each level one rule delivering its float",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/check/checker.ts",
				original: "\t\t\tif (node !== root && this.#importRoots.has(node)) {\n",
				replacement: "\t\t\tif (false) {\n",
				why: "A record walks its import's whole DAG, the closed imports it reads among its nodes, so each level's record takes every level below it again and the nodes recorded grow with the square of the depth."
			}
		]
	})

/** The checks' sessions alive, counted by V8 after a full collection. */
const sessionsAlive = (): number => queryObjects(CheckSession, { format: "count" })

/** A compiled write holds none of its checks' sessions, nor so the closed-import records and shared analyses they hold. */
export const aCompiledWriteHoldsNoneOfItsChecksSessions = property.exhaust(finite(readersGen), {
	needs: {},
	situations: ["one member", "several members"],
	check: (_, k) => (members) =>
		Effect.sync(() => {
			k.note(members === 1 ? "one member" : "several members")
			const before = sessionsAlive()
			const frontend = compiled(Shared, readersOf(members))
			assert.equal(sessionsAlive(), before, "the compiled write holds no session")
			assert.ok(topoOrder(frontend.ir.dag).length > 0, "the write holds its DAG")
		}),
	oracle: { kind: "specification", name: "a compile's session is its own" },
	box: "1, 2, 4 and 8 inserts, each reading one field of one call of eight rows arguments, each an import of one bound query",
	kept: [],
	kills: [
		{
			file: "packages/engine/src/check/session.ts",
			original: "\treadonly ids = makeIdSupply()\n",
			replacement:
				"\treadonly ids = (globalThis.grizzleHeldSessions ??= []).push(this) > 0 ? makeIdSupply() : makeIdSupply()\n",
			why: "Every session is held by a module, so each compiled write leaves its session alive, its closed-import records and shared analyses with it, and the sessions alive grow with every compile."
		}
	]
})
