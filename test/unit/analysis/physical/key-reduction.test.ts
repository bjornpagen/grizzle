/**
 * The physical analysis's key reduction (analysis/physical/fds.ts Dependencies keyAmong, identification) against the
 * reduction at 94aa830e1, over the small generated tables of dependencies.test.ts (dependencies.fixtures.ts specGen):
 * every start among the heading's columns.
 *
 * - The key and its proof, and the identification's proof and key, are the reference's: the greedy reduction from the
 *   end of the heading, a column dropped while the rest still identifies a row on a proof no more demanding, each
 *   narrower key proved by the strongest proof over every stage (Dependencies proof) and its context compared.
 * - A removal closes only through the key's current stage, since a proof's stage orders proofs as their contexts do:
 *   a reduction of a key of k columns from a candidate proved at stage c (counted from 0) runs at most S + k(c + 1)
 *   closures over a table of S stages, where the reference ran S for every removal it refused. And the key's proof is
 *   explained once, where the reference explained every narrower key it proved: one explanation per question.
 *
 * Features: a key narrower than its candidate; a removal refused, and one over a table of two stages whose proof is at
 * the first.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { type EvidenceContext, evidenceContexts, lessDemanding } from "#compiler/ir/evidence.ts"
import { inHeadingOrder } from "#compiler/logical/closure.ts"
import { specGen, subsetsOf, tableOf } from "#test/unit/analysis/physical/dependencies.fixtures.ts"
import { referenceKeyAmong } from "#test/unit/analysis/physical/key-reduction.fixtures.ts"

type Situation =
	| "narrowed"
	| "a removal refused"
	| "a refusal over two stages, the proof at the first"

/** The key reduction is the reference's, closes each removal only through the key's stage, and explains once. */
export const theKeyReductionIsTheReferencesClosesEachRemovalOnlyThroughTheKeysStageAndExplainsOnce =
	property.explore(specGen, {
		needs: {},
		situations: [
			"narrowed",
			"a removal refused",
			"a refusal over two stages, the proof at the first"
		] satisfies ReadonlyArray<Reached<Situation>>,
		check: (_, c: Case<Situation>) => (s) =>
			Effect.sync(() => {
				const table = tableOf(s)
				const used = new Set([
					...Arr.map(table.implications, (i) => i.just.context),
					...Arr.map(table.points, (p) => p.just.context)
				])
				const stages = Arr.filter(evidenceContexts, (x) => used.has(x))
				/** A context's stage: how many of the table's stages are less demanding than it. */
				const stageOf = (context: EvidenceContext): number =>
					Arr.filter(stages, (x) => lessDemanding(x, context)).length
				for (const start of subsetsOf(s.heading)) {
					const candidate = inHeadingOrder(table.columns, start)
					const reference = referenceKeyAmong(table, candidate)
					const referenceProof = table.proof(candidate)
					const asked = (question: () => unknown) => {
						const closures = table.closures
						const explanations = table.explanations
						const answer = question()
						return {
							answer,
							closures: table.closures - closures,
							explanations: table.explanations - explanations
						}
					}
					const key = asked(() => table.keyAmong(start))
					const identified = asked(() => table.identification(start))
					assert.deepEqual(
						key.answer,
						reference,
						`the key among ${Arr.join(start, ", ")} is the reference's`
					)
					assert.deepEqual(
						identified.answer,
						reference === undefined ? undefined : { just: referenceProof, key: reference.columns },
						`the identification of ${Arr.join(start, ", ")} is the reference's`
					)
					if (reference === undefined) {
						continue
					}
					const stage = stageOf(reference.just.context)
					const bound = stages.length + candidate.length * (stage + 1)
					for (const [question, work] of [
						["key", key],
						["identification", identified]
					] as const) {
						assert.ok(
							work.closures <= bound,
							`the ${question} of ${Arr.join(start, ", ")} runs ${work.closures} closures, at most ${bound}`
						)
						assert.equal(
							work.explanations,
							1,
							`the ${question} of ${Arr.join(start, ", ")} explains its proof once`
						)
					}
					if (reference.columns.length < candidate.length) {
						c.note("narrowed")
					}
					if (reference.columns.length > 0) {
						c.note("a removal refused")
						if (stages.length === 2 && stage === 0) {
							c.note("a refusal over two stages, the proof at the first")
						}
					}
				}
			}),
		oracle: {
			kind: "second-implementation",
			name: "the key reduction at 94aa830e1, every narrower key proved over every stage (referenceKeyAmong)"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/physical/fds.ts",
				original:
					"\t\t\tconst narrower = this.#staged(without, proof.stage)\n\t\t\tif (narrower !== undefined) {\n",
				replacement:
					"\t\t\tconst narrower = this.#staged(without, this.#stages.length - 1)\n\t\t\tif (narrower !== undefined && narrower.stage <= proof.stage) {\n",
				why: "Each removal closes through every stage and refuses a proof more demanding than the key's, as the reduction at 94aa830e1 did: the same keys, but a refused removal runs every stage's closure, past the bound, and the search fails."
			},
			{
				file: "packages/engine/src/analysis/physical/fds.ts",
				original:
					"\t\t\tif (closure.columns.has(rowAttribute)) {\n\t\t\t\treturn { stage, closure }\n",
				replacement:
					"\t\t\tif (closure.columns.has(rowAttribute)) {\n\t\t\t\tthis.explain(closure, [rowAttribute])\n\t\t\t\treturn { stage, closure }\n",
				why: "Every staged proof is explained as it is found, as proof() did for each narrower key at 94aa830e1: the reduction explains every key it proves, more than once per question, and the search fails."
			}
		]
	})

type ReadSituation = "a candidate column no dependency reads" | "every candidate column read"

/**
 * A key reduction closes only to try the columns some dependency reads (analysis/physical/fds.ts Dependencies `#reads`):
 * a column no implication or point rule reads fires nothing, so the rest of the key reaches what the key did and the
 * column is dropped with no closure. A reduction of a candidate whose r columns are read, proved at stage c, runs at
 * most S + r(c + 1) closures over a table of S stages; its key and proof are the reference's, by the property above.
 */
export const aKeyReductionClosesOnlyToTryTheColumnsSomeDependencyReads = property.explore(specGen, {
	needs: {},
	situations: [
		"a candidate column no dependency reads",
		"every candidate column read"
	] satisfies ReadonlyArray<Reached<ReadSituation>>,
	check: (_, c: Case<ReadSituation>) => (s) =>
		Effect.sync(() => {
			const table = tableOf(s)
			const used = new Set([
				...Arr.map(table.implications, (i) => i.just.context),
				...Arr.map(table.points, (p) => p.just.context)
			])
			const stages = Arr.filter(evidenceContexts, (x) => used.has(x))
			const read = new Set([
				...Arr.flatMap(table.implications, (i) => [...i.from, ...i.at]),
				...Arr.flatMap(table.points, (p) => p.from)
			])
			for (const start of subsetsOf(s.heading)) {
				const candidate = inHeadingOrder(table.columns, start)
				const proof = table.proof(candidate)
				if (proof === undefined) {
					continue
				}
				const stage = Arr.filter(stages, (x) => lessDemanding(x, proof.context)).length
				const reads = Arr.filter(candidate, (column) => read.has(column)).length
				const closures = table.closures
				table.keyAmong(start)
				const bound = stages.length + reads * (stage + 1)
				assert.ok(
					table.closures - closures <= bound,
					`the key among ${Arr.join(start, ", ")} runs ${table.closures - closures} closures, at most ${bound}`
				)
				c.note(
					reads < candidate.length
						? "a candidate column no dependency reads"
						: "every candidate column read"
				)
			}
		}),
	oracle: {
		kind: "universal",
		name: "a bound: a key reduction's closures are at most the stages and, for each candidate column some dependency reads, one closure per stage through the key's"
	},
	kept: [],
	kills: [
		{
			file: "packages/engine/src/analysis/physical/fds.ts",
			original:
				'\t\t\tif (!this.#reads(defined(key[i], "a column of the key"))) {\n\t\t\t\tkey = without\n\t\t\t\tcontinue\n\t\t\t}\n',
			replacement: "",
			why: "Every column is tried by a closure through each stage up to the key's, read or not, as the reduction did at d422b835a: a candidate with a column no dependency reads runs past the bound, and the property fails."
		}
	]
})
