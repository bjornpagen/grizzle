/**
 * A compiled write holds the nodes its frontend names and none of the analyses its compile read them from
 * (write/frontend/compile.ts restatedIn, WriteFrontend `restate`): the restated form's counterpart of each node the
 * write names is a map of nodes, where a Counterpart closed over the restatement's two analyses held their folds, every
 * node's logical properties with its functional dependencies and their bitsets, for as long as the compiled write
 * lived, which a generate holds for every write of every login to its end.
 *
 * The box, exhausted: a write of one member and of eight reading one call of eight bound imports, a chain of eight
 * levels of bound queries (shared-imports.fixtures.ts), the worked example's put, delete and insert over Work, and eight
 * readers of a take bound to a variable, whose restatement analyzes the write again (analyzed-once.test.ts).
 *
 * Property, per case: the folds alive once the write is compiled, the compiled write held, are those alive before its
 * compile, counted by V8 after a full collection (node:v8 queryObjects over ir/fold.ts Fold). Oracle: specification, a
 * compile's folds are its own. Kill: the frontend holds the counterpart that read the analyses beside its map, as it
 * did, so every compiled write holds its restatement's folds.
 *
 * And a write's compile holds one analysis at a time (write/frontend/compile.ts): the served DAG and the write's first
 * analysis are made and read inside the helper that reads its queries (analyzedQueries), in no frame or scope of the
 * compile's, so when the restatement analyzes the DAG again, which it does where it restates a take
 * (analyzed-once.test.ts), neither is reachable, where the compile's scope held the first beside the second, every
 * node's properties twice (edullm's qti generate: 1.63 GB of its 3.44 GB live at the 4 GiB heap's limit), and held
 * the served DAG's folds to its end. Per case: the folds alive when the restatement's analysis starts outnumber those
 * alive before the compile by fewer than one analysis holds, counted by V8 after a full collection, before the compile
 * and at each read of the evidence the analyses are made under (the laws' theory `evidence`, read once by each); what
 * one analysis holds is counted in the case, the folds alive with an analysis of the compiled write's DAG held, less
 * those alive before it. Fewer, not none: the fold the restatement's own rewrite holds (lower/shapes/take/decorrelate.ts,
 * its editor's finish) is alive at its analysis's start. Its box: one and eight readers of a take bound to a variable of
 * the reading rule, which the restatement restates (shared-imports.fixtures.ts boundTakeWriteOf). Kill: the compile's
 * scope holding every analysis it makes, so the first is alive while the second is made.
 *
 * Both properties read the heap over a compile run on cold code (onColdCode), its frames the interpreter's: what a
 * frame keeps of a value it no longer reads is the engine's to decide where an optimizing compiler built the frame, so
 * a warm worker kept the first analysis's folds alive at the restatement's start once (the unit tier on 0be68193,
 * 0 then 2 against an analysis's 2), where cold the count is the compile's own.
 *
 * Features: one member, several members.
 */

import { queryObjects } from "node:v8"
import { assert } from "@bjornpagen/testing/assert"
import { element, finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { Fold } from "#compiler/ir/fold.ts"
import { analyzeLogical, everyNode } from "#compiler/logical/annotate.ts"
import { compileChangeSet } from "#compiler/write/frontend/compile.ts"
import { compileWrite } from "#compiler/write/program/compile.ts"
import { succeeded } from "#test/support/assert.ts"
import {
	type FixtureSchema,
	frontendOptions,
	realityWrite,
	testArtifacts,
	testCompile
} from "#test/support/compile.ts"
import { Work } from "#test/support/fixtures/api/work.ts"
import { callCounts } from "#test/support/kernel/calls.ts"
import { checking } from "#test/support/policy.ts"
import { descOf, switchToManual } from "#test/unit/write/changeset/fixtures.ts"
import {
	boundTakeWriteOf,
	chainWriteOf,
	readersOf,
	Shared
} from "#test/unit/write/shared-imports.fixtures.ts"

type Feature = "one member" | "several members"

/** A case's write: the shared-imports writes over Shared, or the worked example over Work. */
type Shape =
	| "one reader of a call"
	| "eight readers of a call"
	| "a chain of eight levels"
	| "the worked example"
	| "eight readers of a bound take"

/** A case's schema, its ChangeSet and how many members it writes. */
interface Written {
	readonly schema: FixtureSchema
	readonly change: unknown
	readonly members: number
}

const writtenOf = (shape: Shape): Written => {
	switch (shape) {
		case "one reader of a call":
			return { schema: Shared, change: readersOf(1), members: 1 }
		case "eight readers of a call":
			return { schema: Shared, change: readersOf(8), members: 8 }
		case "a chain of eight levels":
			return { schema: Shared, change: chainWriteOf(8), members: 1 }
		case "the worked example":
			return { schema: Work, change: switchToManual(), members: 3 }
		case "eight readers of a bound take":
			return { schema: Shared, change: boundTakeWriteOf(8), members: 8 }
	}
}

/** The folds alive, counted by V8 after a full collection. */
const foldsAlive = (): number => queryObjects(Fold, { format: "count" })

/**
 * `measure`, run on cold code: the call counter's restart (test/support/kernel/calls.ts callCounts) deoptimizes every
 * function and clears its invocation counts first, and nothing is counted, so a case's folds are read over a compile
 * whose frames are the interpreter's whatever the worker ran before it. A fold a frame no longer reads is otherwise kept
 * or dropped as the worker's optimizing compilers left the frames that held it: the unit tier on 0be68193 read one
 * analysis's two folds alive at the restatement's start (0 then 2, an analysis 2) where a worker that had run nothing
 * else read 0 then 1.
 */
const onColdCode = <A>(measure: () => A): Effect.Effect<A> =>
	Effect.map(callCounts(Effect.sync(measure), {}), ([measured]) => measured)

/** A compiled write holds none of its compile's folds: those alive while it is held are those alive before its compile. */
export const aCompiledWriteHoldsNoneOfItsCompilesFoldsThoseAliveWhileItIsHeldAreThoseAliveBeforeItsCompile =
	property.exhaust(
		finite((source) =>
			source.draw(
				element<Shape>([
					"one reader of a call",
					"eight readers of a call",
					"a chain of eight levels",
					"the worked example",
					"eight readers of a bound take"
				])
			)
		),
		{
			needs: {},
			situations: ["one member", "several members"],
			check: (_, k: Case<Feature>) => (shape) =>
				Effect.gen(function* () {
					const written = writtenOf(shape)
					k.note(written.members === 1 ? "one member" : "several members")
					const reality = realityWrite(succeeded(testArtifacts(written.schema, testCompile)))
					const desc = descOf(written.change)
					const { before, after, program } = yield* onColdCode(() => {
						const counted = foldsAlive()
						const compiled = succeeded(compileWrite(checking(written.schema), desc, reality))
						return { before: counted, after: foldsAlive(), program: compiled }
					})
					assert.equal(after, before, `${shape}: the compiled write holds no fold`)
					assert.ok(program.frontend.restate.size > 0, `${shape}: the write names nodes`)
				}),
			oracle: { kind: "specification", name: "a compile's folds are its own" },
			box: "one and eight readers of one call of eight bound imports, a chain of eight bound levels, the worked example's put, delete and insert, and eight readers of a take bound to a variable",
			kept: [],
			kills: [
				{
					file: "packages/engine/src/write/frontend/compile.ts",
					original: "\tObject.freeze({\n\t\tir: Object.freeze({\n\t\t\tdag,\n",
					replacement: "\tObject.freeze({\n\t\tat,\n\t\tir: Object.freeze({\n\t\t\tdag,\n",
					why: "Each form of the write's queries holds the counterpart it was read through, so the compiled write holds the first analysis's, and through it that analysis, its judged twin and the served DAG, every node's properties for as long as it lives."
				}
			]
		}
	)

/**
 * The folds alive before a write's frontend compiles and at each read of the evidence its analyses are made under as it
 * does, and the folds one analysis holds: alive with an analysis of the compiled write's DAG held, less those alive
 * before it.
 */
const foldsAtAnalyses = (
	written: Written
): {
	readonly before: number
	readonly counts: ReadonlyArray<number>
	readonly held: number
} => {
	const options = frontendOptions(written.schema)
	const { theory } = options.laws
	const counts: Array<number> = []
	const watched = {
		...theory,
		get evidence() {
			counts.push(foldsAlive())
			return theory.evidence
		}
	}
	const checked = checking(written.schema)
	const desc = descOf(written.change)
	const compiled = foldsAlive()
	const frontend = succeeded(
		compileChangeSet(checked, desc, {
			...options,
			laws: { ...options.laws, theory: watched }
		})
	)
	const before = foldsAlive()
	const analysis = succeeded(
		analyzeLogical(
			frontend.ir.dag,
			{ context: "transaction", containments: [], keyedViews: true },
			everyNode
		)
	)
	const held = foldsAlive() - before
	assert.ok(analysis.dag.roots.length >= 0, "the analysis is held while its folds are counted")
	return { before: compiled, counts, held }
}

/** A write's compile holds one analysis at a time: when its restatement's analysis starts, no analysis of its own and no served DAG is alive. */
export const aWritesCompileHoldsOneAnalysisAtATimeWhenItsRestatementsAnalysisStartsNoEarlierAnalysisNorTheServedDagIsAlive =
	property.exhaust(
		finite((source) => source.draw(element<1 | 8>([1, 8]))),
		{
			needs: {},
			situations: ["one member", "several members"],
			check: (_, k: Case<Feature>) => (members) =>
				Effect.gen(function* () {
					const shape = `${members} reader(s) of a bound take`
					const written: Written = { schema: Shared, change: boundTakeWriteOf(members), members }
					k.note(written.members === 1 ? "one member" : "several members")
					const { before, counts, held } = yield* onColdCode(() => foldsAtAnalyses(written))
					const [first, second, ...rest] = counts
					assert.equal(rest.length, 0, `${shape}: two analyses, the first and the restatement's`)
					assert.ok(held > 0, `${shape}: an analysis holds folds`)
					assert.ok(
						first !== undefined && second !== undefined && second - before < held,
						`${shape}: the first analysis or the served DAG is alive at the second (${before} before the compile, ${first} at the first, ${second} at the second, an analysis ${held})`
					)
				}),
			oracle: { kind: "specification", name: "an analysis read is an analysis dropped" },
			box: "one and eight readers of a take bound to a variable of the reading rule",
			kept: [],
			kills: [
				{
					file: "packages/engine/src/write/frontend/compile.ts",
					original:
						"\tconst analyzed = (structure: ValidDag): LogicalAnalysis =>\n\t\tunwrap(analyzeLogical(structure, transactionEvidence(laws), keptNodes([])))\n",
					replacement:
						"\tconst made: Array<LogicalAnalysis> = []\n\tconst analyzed = (structure: ValidDag): LogicalAnalysis => {\n\t\tconst analysis = unwrap(analyzeLogical(structure, transactionEvidence(laws), keptNodes([])))\n\t\tmade.push(analysis)\n\t\treturn analysis\n\t}\n",
					why: "The compile's scope holds every analysis it makes, so the first is alive while the restatement analyzes the DAG again: two analyses alive at once, the folds alive at the second outnumbering those at the first."
				}
			]
		}
	)
