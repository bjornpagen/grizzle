import { type Reached } from "@bjornpagen/testing/features"
import { aimed, finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter } from "effect"
import { navigateMember } from "#compiler/analysis/theory/navigate.ts"
import { assert } from "#test/support/assert.ts"
import { caseSketchGen, resolveCase } from "#test/support/oracle/public/generate.ts"
import {
	type Feature,
	gateCaseGen,
	type GateFeature,
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

/** Navigation keeps every generated read's answer, by the reference over the checked IR. */
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
			kept: [],
			kills: [
				{
					file: "packages/engine/src/analysis/theory/navigate.ts",
					original: "\t\t\t\t\t\t\t\twhere: inner,",
					replacement: "\t\t\t\t\t\t\t\twhere: [],",
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
				const navigated = navigateMember(gateQueryOf(c), loc)
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
		kills: []
	})
