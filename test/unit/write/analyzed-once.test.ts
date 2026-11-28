/**
 * A write's DAG is analyzed once unless its optimized form restates a take (write/frontend/compile.ts, the
 * restatement): the optimized artifact lowers the write DAG with every take correlated through `bind` restated over
 * every parent (lower/shapes/take/decorrelate.ts everyParentTakes), and where the rewrite restates none, that DAG is
 * the analyzed DAG itself, whose analysis again states what it states (the logical analysis is idempotent,
 * test/unit/analysis/logical/evidence.test.ts). The restatement's analysis ran over every write all the same, the
 * whole write DAG analyzed twice: edullm's ledger's `evaluate`, 20,550 nodes and no take restated, spent 100 s in its
 * first analysis and 181 s in its second.
 *
 * The box, exhausted: one and eight readers of one call of eight bound imports, a chain of eight bound levels
 * (shared-imports.fixtures.ts), the worked example's put, delete and insert over Work, and one and eight readers of a
 * take bound to a variable of the reading rule, which the optimized form restates.
 *
 * Property 1, per case: the analyses the write's frontend makes, counted at each read of the evidence they are made
 * under (the laws' theory `evidence`, read once by each), are one where no take is restated and two where one is, and
 * the optimized form's DAG is the analyzed DAG exactly where none is. Oracle: specification, a DAG the restatement
 * leaves as it is is the analyzed one. Kill: the restatement's analysis made over every write, as it was.
 *
 * Property 2, per case of no restated take: the optimized form the frontend holds, its DAG in table form (every node by
 * its label, with its fields, its claims and their proofs), is the form the restatement's analysis made of it, as it
 * ran over every write: the analyzed DAG analyzed again in the write's own evidence (a transaction, the laws'
 * immediate containments, keyed views) and judged as delivered. Oracle: a second implementation, the restatement's analysis as it
 * ran. Kill: the optimized form read as the write's DAG before its analysis, so it states no claim.
 *
 * Features: no take restated, a take restated; one member, several members.
 */

import { assert } from "@bjornpagen/testing/assert"
import { element, finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { immediateEvidence } from "#compiler/analysis/theory/theory.ts"
import type { RelNode } from "#compiler/ir/rel.ts"
import { analyzeLogical, everyNode, judgedAsDelivered } from "#compiler/logical/annotate.ts"
import { compileChangeSet, type WriteFrontend } from "#compiler/write/frontend/compile.ts"
import { succeeded } from "#test/support/assert.ts"
import { type FixtureSchema, frontendOptions } from "#test/support/compile.ts"
import { toTable } from "#test/support/dag.ts"
import { Work } from "#test/support/fixtures/api/work.ts"
import { checking } from "#test/support/policy.ts"
import { descOf, switchToManual } from "#test/support/unit/write/changeset/fixtures.ts"
import {
	boundTakeWriteOf,
	chainWriteOf,
	readersOf,
	Shared
} from "#test/support/unit/write/shared-imports.fixtures.ts"

type Feature = "no take restated" | "a take restated" | "one member" | "several members"

/** A case's write. */
type Shape =
	| "one reader of a call"
	| "eight readers of a call"
	| "a chain of eight levels"
	| "the worked example"
	| "one reader of a bound take"
	| "eight readers of a bound take"

/** A case's schema, its ChangeSet, how many members it writes and whether its optimized form restates a take. */
interface Written {
	readonly schema: FixtureSchema
	readonly change: unknown
	readonly members: number
	readonly restatesATake: boolean
}

const writtenOf = (shape: Shape): Written => {
	switch (shape) {
		case "one reader of a call":
			return { schema: Shared, change: readersOf(1), members: 1, restatesATake: false }
		case "eight readers of a call":
			return { schema: Shared, change: readersOf(8), members: 8, restatesATake: false }
		case "a chain of eight levels":
			return { schema: Shared, change: chainWriteOf(8), members: 1, restatesATake: false }
		case "the worked example":
			return { schema: Work, change: switchToManual(), members: 3, restatesATake: false }
		case "one reader of a bound take":
			return { schema: Shared, change: boundTakeWriteOf(1), members: 1, restatesATake: true }
		case "eight readers of a bound take":
			return { schema: Shared, change: boundTakeWriteOf(8), members: 8, restatesATake: true }
	}
}

/** The shapes whose optimized form restates no take. */
const unrestated = [
	"one reader of a call",
	"eight readers of a call",
	"a chain of eight levels",
	"the worked example"
] as const satisfies ReadonlyArray<Shape>

const shapes = [
	...unrestated,
	"one reader of a bound take",
	"eight readers of a bound take"
] as const satisfies ReadonlyArray<Shape>

/** The write's frontend, and the analyses it made, counted at each read of the evidence they are made under. */
const frontendOf = (
	written: Written
): { readonly frontend: WriteFrontend; readonly analyses: number } => {
	const options = frontendOptions(written.schema)
	const { theory } = options.laws
	let analyses = 0
	const watched = {
		...theory,
		get evidence() {
			analyses += 1
			return theory.evidence
		}
	}
	const frontend = succeeded(
		compileChangeSet(checking(written.schema), descOf(written.change), {
			...options,
			laws: { ...options.laws, theory: watched }
		})
	)
	return { frontend, analyses }
}

/** A write's DAG is analyzed once where its optimized form restates no take, twice where it restates one. */
export const aWritesDagIsAnalyzedOnceWhereItsOptimizedFormRestatesNoTakeAndTwiceWhereItRestatesOne =
	property.exhaust(
		finite((source) => source.draw(element<Shape>(shapes))),
		{
			needs: {},
			situations: ["no take restated", "a take restated", "one member", "several members"],
			check: (_, k: Case<Feature>) => (shape) =>
				Effect.sync(() => {
					const written = writtenOf(shape)
					k.note(written.restatesATake ? "a take restated" : "no take restated")
					k.note(written.members === 1 ? "one member" : "several members")
					const { frontend, analyses } = frontendOf(written)
					assert.equal(
						analyses,
						written.restatesATake ? 2 : 1,
						`${shape}: the analyses of the write's DAG`
					)
					assert.equal(
						frontend.restated.ir.dag === frontend.ir.dag,
						!written.restatesATake,
						`${shape}: the optimized form's DAG is the analyzed one exactly where no take is restated`
					)
				}),
			oracle: {
				kind: "specification",
				name: "a DAG the restatement leaves as it is is the analyzed one"
			},
			box: "one and eight readers of one call of eight bound imports, a chain of eight bound levels, the worked example's put, delete and insert, and one and eight readers of a take bound to a variable",
			kept: [],
			kills: [
				{
					file: "packages/engine/src/write/frontend/compile.ts",
					original:
						"\t\tif (takes.query === input) {\n\t\t\treturn { dag, at: new Map(analyzedRoots.map((root) => [root, root] as const)) }\n\t\t}\n",
					replacement: "",
					why: "The restatement analyzes the write's DAG again whether or not it restated a take, as it did, so a write with no take restated is analyzed twice and its optimized form is another DAG."
				}
			]
		}
	)

/** Where no take is restated, the optimized form is what the restatement's analysis made of the analyzed DAG. */
export const whereNoTakeIsRestatedTheOptimizedFormIsWhatTheRestatementsAnalysisMadeOfTheAnalyzedDag =
	property.exhaust(
		finite((source) => source.draw(element<Shape>(unrestated))),
		{
			needs: {},
			situations: ["one member", "several members"],
			check: (_, k: Case<Feature>) => (shape) =>
				Effect.sync(() => {
					const written = writtenOf(shape)
					k.note(written.members === 1 ? "one member" : "several members")
					const { frontend } = frontendOf(written)
					const options = frontendOptions(written.schema)
					const again = succeeded(
						analyzeLogical(
							frontend.ir.dag,
							{
								context: "transaction",
								containments: immediateEvidence(options.laws.theory.evidence).containments,
								keyedViews: true
							},
							everyNode
						)
					)
					const judged = judgedAsDelivered(again.dag).dag
					const ids = (roots: ReadonlyArray<RelNode>): ReadonlyArray<string> =>
						Arr.map(roots, (root) => root.id)
					assert.deepEqual(
						ids(frontend.restated.ir.dag.roots),
						ids(judged.roots),
						`${shape}: the roots`
					)
					assert.deepEqual(
						succeeded(toTable(frontend.restated.ir.dag)),
						succeeded(toTable(judged)),
						`${shape}: every node, its fields, claims and proofs`
					)
				}),
			oracle: { kind: "second-implementation", name: "the restatement's analysis as it ran" },
			box: "one and eight readers of one call of eight bound imports, a chain of eight bound levels, and the worked example's put, delete and insert",
			kept: [],
			kills: [
				{
					file: "packages/engine/src/write/frontend/compile.ts",
					original:
						"\t\t\treturn { dag, at: new Map(analyzedRoots.map((root) => [root, root] as const)) }\n",
					replacement:
						"\t\t\treturn { dag: structural, at: new Map(analyzedRoots.map((root) => [root, root] as const)) }\n",
					why: "The optimized form reads the write's DAG as it stood before its analysis, so its nodes claim nothing and its attachments are judged by no analysis: its table is not the restatement's."
				}
			]
		}
	)
