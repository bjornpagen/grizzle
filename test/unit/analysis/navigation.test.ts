import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { aimed, finite } from "@bjornpagen/testing/gen"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter } from "effect"
import { navigateQuery } from "#compiler/analysis/theory/navigate.ts"
import { caseSketchGen, resolveCase } from "#test/support/oracle/public/generate.ts"
import {
	type Feature,
	gateCaseGen,
	type GateFeature,
	gateColumns,
	gateQueryOf,
	isGate,
	judged,
	loc,
	navigatedSketchGen,
	negationsOf,
	oneColumnNegationSketchGen,
	situations,
	type Slot
} from "#test/unit/analysis/navigation.fixtures.ts"

/**
 * Navigation keeps every generated read's answer, by the reference over the checked IR.
 *
 * Budget: 400 runs and 400 steered cases, what its suite stated before it became a property
 * (test/unit/analysis/navigation.test.ts:140 at 8cad5bce, its runs and its coverage's cases).
 */
export const navigationKeepsEveryGeneratedReadsAnswerByTheReferenceOverTheCheckedIR =
	property.explore(
		aimed(caseSketchGen, [
			["a navigated read inlining an imported query", navigatedSketchGen(["import", "bind join"])],
			["a navigated read with a negation", navigatedSketchGen(["negation", "bind join"])],
			[
				"a navigated read keeping a row beside a one-column negation of a relation that holds a fact",
				oneColumnNegationSketchGen
			]
		]),
		{
			needs: {},
			budget: { runs: 400, steered: 400 },
			situations: situations satisfies ReadonlyArray<Reached<Feature>>,
			check: (_, k: Case<Feature>) => (sketch) =>
				Effect.sync(() => {
					const c = k.draw(resolveCase(sketch))
					for (const read of c.reads) {
						if (read.kind === "query") {
							judged(c, read, k.note)
						}
					}
				}),
			oracle: {
				kind: "second-implementation",
				name: "the read as written, checked and evaluated by the reference beside its navigation"
			},
			kept: [
				{
					token: ReplayToken(
						"test/unit/analysis/navigation.test.ts#navigationKeepsEveryGeneratedReadsAnswerByTheReferenceOverTheCheckedIR:-:2.1.0.1.0.0.1.0.1.0.0.1.0.1.0.1.0.1.2.1.0.1.0.1.0.1.0.1.2.1.2.1.2.0.0.1.0.0.1.0.1.0.1.0.0.1.0.1.0.1.0.1.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.1.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.2.2.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.pa8.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.2.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.pa8.pa8.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.pa8.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0"
					),
					reason:
						"a navigated read whose region holds a variable correlated with an attachment's parent, __p0_0 fixed to the parent's Bool, beside an occurrence whose source is correlated with the region and reads that variable: the reference fixed a correlated variable only once every occurrence was bound, so the source read a column the region did not yet hold and the reference refused the case (PERFWRITE2's replay at 0eaba136c)",
					since: "2026-11-20"
				},
				{
					token: ReplayToken(
						"test/unit/analysis/navigation.test.ts#navigationKeepsEveryGeneratedReadsAnswerByTheReferenceOverTheCheckedIR:-:0.a.0.0.1.0.0.1.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.3.0.0.0.0.0.0.1.3.1.0.0.0.0.0.1.0.0.1.1.0.3.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.1.0.0.0.0.0.3.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.pa8.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.pa8.0.0.0.0.0.0.0.0.0.1.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.pa8.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.1.1.0.0.0"
					),
					reason:
						"a read over Rel0x0 that matches q1 bound at its key column and negates q1 at the same binding, q1 one rule over Rel0x0 alone: no rule of it joins, so navigation builds no step and changes the read only by restricting the matched import inside to the parameter its column0 is bound at (navigate.ts navigatedRule, boundInside), where the property required a step of every read navigation changed (VALIDCOST2's rotating stream, seed 0x847460d3, case 200)",
					since: "2026-11-21"
				}
			],
			kills: [
				{
					file: "test/support/oracle/reference/evaluate.ts",
					original: "\t\t\tif (Arr.every(c.expr.deps.nodes, (n) => !own.has(n))) {",
					replacement: "\t\t\tif (false) {",
					why: "A region holds no correlated variable from its start, so an occurrence's source correlated with the region reads a column the region does not hold yet, and the reference refuses the kept navigated read."
				},
				{
					file: "packages/engine/src/analysis/theory/navigate.ts",
					original: "\t\t\t\twhere: inner,",
					replacement: "\t\t\t\twhere: [],",
					why: "A condition placed inside a step is dropped; the search fails in its steered phase."
				},
				{
					file: "packages/engine/src/analysis/theory/navigate.ts",
					original:
						"\t\t\t\t\tObject.entries(a.bindings).map(([column, e]) => [column, passing.expr(e)] as const)",
					replacement:
						"\t\t\t\t\tObject.entries(a.bindings).slice(1).map(([column, e]) => [column, passing.expr(e)] as const)",
					why: "A negated relation's step reads one column fewer than the negation binds; the search fails in its steered phase."
				}
			]
		}
	)

/** Navigation's gate judges a write member's negation that reads no variable among the chain's own conditions, in declared order, and wraps the chain in every other. */
export const navigationsGateJudgesAWriteMembersNegationThatReadsNoVariableAmongTheChainsOwnConditionsInDeclaredOrderAndWrapsTheChainInEveryOther =
	property.exhaust(finite(gateCaseGen), {
		needs: {},
		situations: [
			"a gate by a parameter",
			"a gate by a literal",
			"a gate declared after a correlated negation",
			"two gates"
		] satisfies ReadonlyArray<Reached<GateFeature>>,
		check: (_, k: Case<GateFeature>) => (c) =>
			Effect.sync(() => {
				const navigated = navigateQuery(gateQueryOf(c), loc, gateColumns, { kind: "perRead" })
				if (navigated.stage.kind !== "rules") {
					return assert.fail("a navigated member is one rules stage")
				}
				const names = ["N0", "N1", "N2"] as const
				const expected = (keep: (slot: Slot) => boolean): ReadonlyArray<string> =>
					Arr.flatMap(names, (name, i) => (keep(c[i] ?? "none") ? [name] : []))
				assert.deepEqual(
					negationsOf(navigated.stage.arms[0]),
					{ gates: expected(isGate), wrappers: expected((s) => s === "correlated") },
					`${Formatter.format(c)}: gates among the chain's conditions, the rest wrappers, each in declared order`
				)
				if (Arr.contains(c, "gate by a parameter")) {
					k.note("a gate by a parameter")
				}
				if (Arr.contains(c, "gate by a literal")) {
					k.note("a gate by a literal")
				}
				if (Arr.filter(c, isGate).length >= 2) {
					k.note("two gates")
				}
				const firstCorrelated = c.indexOf("correlated")
				if (firstCorrelated >= 0 && Arr.some(c.slice(firstCorrelated + 1), isGate)) {
					k.note("a gate declared after a correlated negation")
				}
			}),
		oracle: {
			kind: "specification",
			name: "the gate's rule restated: a negation that reads no variable among the chain's own conditions in declared order, every other a wrapper in declared order"
		},
		box: "every assignment of three negations' slots, each none, a gate by the parameter, a gate by a literal or correlated, over a join of A at the parameter and B",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/theory/navigate.ts",
				original: `\t\t\tconst delivered = Object.fromEntries(outputs.map((id, i) => [\`o\${i}\`, varRef(id)] as const))`,
				replacement: `\t\t\tconst delivered = Object.fromEntries(outputs.map((id, i) => [\`o\${i}\`] as const))`,
				why: `Operator mutant (element) at packages/engine/src/analysis/theory/navigate.ts:462 in place: \`[\`o\${i}\`, varRef(id)]\` becomes \`[\`o\${i}\`]\`; the property fails (lane CATCH, grizzle 0baff5d6).`
			},
			{
				file: "packages/engine/src/analysis/theory/navigate.ts",
				original: `\t\t\tconst delivered = Object.fromEntries(outputs.map((id, i) => [\`o\${i}\`, varRef(id)] as const))`,
				replacement: `\t\t\tconst delivered = Object.fromEntries(outputs.map((id, i) => [\`o\${i}\`] as const))`,
				why: `Operator mutant (element) at packages/engine/src/analysis/theory/navigate.ts:462 in place: \`[\`o\${i}\`, varRef(id)]\` becomes \`[\`o\${i}\`]\`; the property fails (lane CATCH, grizzle 0baff5d6).`
			}
		]
	})
