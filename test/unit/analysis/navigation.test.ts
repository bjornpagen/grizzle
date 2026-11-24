import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { aimed, finite } from "@bjornpagen/testing/gen"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter } from "effect"
import {
	type ImportSharing,
	Navigation,
	navigateQuery
} from "#compiler/analysis/theory/navigate.ts"
import type { InferredRule } from "#compiler/ir/desc.ts"
import { caseSketchGen, resolveCase } from "#test/support/oracle/public/generate.ts"
import {
	type Feature,
	gateCaseGen,
	type GateFeature,
	gateColumns,
	gateFacts,
	gateQueryOf,
	isGate,
	judged,
	loc,
	navigatedSketchGen,
	negatedThroughSteps,
	negationsOf,
	oneColumnNegationSketchGen,
	overStepsCaseGen,
	overStepsOf,
	situations,
	type Slot,
	type StepsFeature,
	steppedRelations,
	type UnreadCase,
	unreadCaseGen,
	unreadQueryOf,
	unwrapped
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
						"a navigated read whose region holds a variable correlated with an attachment's parent, __p0_0 fixed to the parent's Bool, beside an occurrence whose source is correlated with the region and reads that variable: the reference fixed a correlated variable only once every occurrence was bound, so the source read a column the region did not yet hold and the reference refused the case (PERFWRITE2's replay at 0eaba136c). Since 32d761c10 the checker binds an attachment's import at the parent's own column (check/checker.ts #bindValue), so the read holds no region variable an occurrence's source reads; the reference fixes every correlated variable once, at the region's start (evaluate.ts correlatedStart), and the head reads __p0_0 there",
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
					original: "\t\t\tstart.set(c.var, this.expr(c.expr, scope))",
					replacement: "\t\t\tstart.delete(c.var)",
					why: "A region fixes none of its correlated variables, so a read of an attachment's parent through a parent variable no match binds, the kept case's __p0_0 among them, finds no value for it, and the reference refuses the read."
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
						"\t\t\t\t\tObject.entries(a.bindings).map(\n\t\t\t\t\t\t([column, e]) => [column, passing.expr(pinned(e))] as const\n\t\t\t\t\t)",
					replacement:
						"\t\t\t\t\tObject.entries(a.bindings).slice(1).map(\n\t\t\t\t\t\t([column, e]) => [column, passing.expr(pinned(e))] as const\n\t\t\t\t\t)",
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
				const navigated = navigateQuery(
					gateQueryOf(c),
					loc,
					gateColumns,
					{ kind: "perRead" },
					new Navigation(gateFacts)
				)
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

/**
 * A rule over a chain of steps keeps its relational filters as written in a write member's navigation, and has each
 * that reads a variable navigated after the chain in a rule statement's (analysis/theory/navigate.ts
 * filteredOverSteps): the judge's rows over a region of keys and their meeting part stand so, and a write member's
 * compile is never moved by it. Navigated in a write member, the ledger's recordEvaluations read a step's filter whose
 * import binds parameters partly, refused as a bind map that binds its parameter incompletely. A filter navigation
 * reads no part of (`#readable`), a negation of an import whose rule reads a text's split, stays the rule's condition
 * as written in a rule statement too, as after a chain (#chain `asWritten`): navigated, its split was refused as no
 * navigation, and so was every stored relation whose upkeep negated a split's import over a chain, edullm's WalkFloat
 * and WalkRef over their tolerance's tokens.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const aRuleOverStepsKeepsItsFiltersAsWrittenInAWriteMemberAndNavigatesThemInARuleStatement =
	property.exhaust(finite(overStepsCaseGen), {
		needs: {},
		situations: [
			"a gate by a parameter",
			"a gate by a literal",
			"a gate declared after a correlated negation",
			"two gates",
			"a negation of a split's import"
		] satisfies ReadonlyArray<Reached<StepsFeature>>,
		check: (_, k: Case<StepsFeature>) => (c) =>
			Effect.sync(() => {
				const rule = overStepsOf(c)
				const navigatedAs = (sharing: ImportSharing): InferredRule => {
					const navigated = navigateQuery(
						{ stage: { kind: "rules", arms: [rule], loc } },
						loc,
						gateColumns,
						sharing,
						new Navigation(gateFacts)
					)
					return navigated.stage.kind === "rules"
						? navigated.stage.arms[0]
						: assert.fail("a navigated rule is one rules stage")
				}
				const member = navigatedAs({ kind: "perRead" })
				assert.deepEqual(
					member.where,
					rule.where,
					`${Formatter.format(c)}: a write member's rule over steps keeps its filters as written`
				)
				const statement = navigatedAs({ kind: "perStatement", extent: "units" })
				const names = ["N0", "N1", "N2"] as const
				const slotted = (keep: (slot: Slot) => boolean): ReadonlyArray<string> =>
					Arr.flatMap(names, (name, i) => (keep(c[i] ?? "none") ? [name] : []))
				assert.deepEqual(
					negatedThroughSteps(statement),
					{
						navigated: slotted((slot) => slot !== "none" && slot !== "correlated over a split"),
						asWritten: slotted((slot) => slot === "correlated over a split")
					},
					`${Formatter.format(c)}: a rule statement's rule over steps navigates each filter navigation reads, a split's import's left as written`
				)
				if (Arr.contains(c, "correlated over a split")) {
					k.note("a negation of a split's import")
				}
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
			name: "navigation's rule over a chain of steps restated: a write member's filters as written, a rule statement's gates among the chain's own conditions and every other a wrapper, each in declared order, but a negation of a split's import, as written"
		},
		box: "every assignment of three negations' slots, each none, a gate by the parameter, a gate by a literal, correlated, or correlated over the tokens of the negated relation's lists, over one step of A at the parameter joined to B",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/theory/navigate.ts",
				original:
					"\t\tconst filters = rule.where.filter(isFiltered).filter((a) => this.#readable(a))\n",
				replacement: "\t\tconst filters = rule.where.filter(isFiltered)\n",
				why: "A rule over steps has a filter navigation reads no part of navigated after it as a readable one: its import's split is refused as no navigation, as edullm's stored WalkFloat was at its upkeep."
			},
			{
				file: "packages/engine/src/analysis/theory/navigate.ts",
				original: '\t\tsharing.kind === "perStatement" && interned.overSteps(read)\n',
				replacement: "\t\tinterned.overSteps(read)\n",
				why: "A write member's rule over steps has its filters navigated too, as the navigation fix first had it: its filters are no longer as written, as edullm's ledger's recordEvaluations refused; the property fails."
			},
			{
				file: "packages/engine/src/analysis/theory/navigate.ts",
				original: '\t\tsharing.kind === "perStatement" && interned.overSteps(read)\n',
				replacement:
					'\t\tsharing.kind === "perStatement" && interned.overSteps(read) && read.where.length < 0\n',
				why: "A rule statement's rule over steps keeps its filters as written, as before the navigation fix: no wrapper navigates a correlated negation; the property fails."
			}
		]
	})

/**
 * A rule statement's rule that joins is navigated whatever relational filter it holds that navigation reads no part of
 * (analysis/theory/navigate.ts RuleReads): its reads are a chain of steps, and that filter stays its condition as
 * written after them (Navigator #chain `asWritten`). Such a filter left the whole rule as written, every relation it
 * reads one flat join PostgreSQL ordered by its estimates: the ledger's key of a limited test attempt, which negates the
 * unlimited members, whose max-attempts in force negate a fold's nearest scope, joined every learner's attempts and
 * item sessions and the written test session's (child, stage) last, a filter of 1,401,075 rows at each start (metis,
 * 24 s), and every test session of a package for each of its attempts at each answer (edullm, 1.5 s of 1.7 s).
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const aRuleThatJoinsIsNavigatedPastAFilterNavigationReadsNoPartOfWhichStaysAsWritten =
	property.exhaust(finite(unreadCaseGen), {
		needs: {},
		situations: ["an aggregate", "a union negating an aggregate"] satisfies ReadonlyArray<
			Reached<UnreadCase>
		>,
		check: (_, k: Case<UnreadCase>) => (c) =>
			Effect.sync(() => {
				const navigated = navigateQuery(
					unreadQueryOf(c),
					loc,
					gateColumns,
					{ kind: "perStatement", extent: "units" },
					new Navigation(gateFacts)
				)
				const rule: InferredRule =
					navigated.stage.kind === "rules"
						? navigated.stage.arms[0]
						: assert.fail("a navigated rule is one rules stage")
				assert.ok(
					Arr.every(rule.matches, (m) => m.source.kind === "step"),
					`${c}: the navigated rule reads no relation but through steps`
				)
				assert.deepEqual(
					Arr.filter(steppedRelations(rule), (name) => name === "A" || name === "B"),
					["A", "B"],
					`${c}: A and B are each read by a step of the chain`
				)
				assert.deepEqual(
					Arr.flatMap(unwrapped(rule).where, (w) => (w.kind === "absent" ? [w.source.kind] : [])),
					c === "an aggregate" ? ["query"] : [],
					c === "an aggregate"
						? `${c}: the negation of the fold, which navigation reads no part of, stays the chain's condition as written`
						: `${c}: the negation of the union, whose rules navigation reads, is navigated after the chain`
				)
				k.note(c)
			}),
		oracle: {
			kind: "specification",
			name: "navigation restated over the case: A and B each read by a step, the fold's negation the chain's own condition as written, the union's navigated after the chain"
		},
		box: "A at p joined to B by k, beside a negation at k of N0's greatest key, a fold, or of a union of N1's keys and N2's not N0's greatest",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/theory/navigate.ts",
				original: "\t\tif (arms.some((arm) => arm.every === undefined)) {\n\t\t\tcontinue\n\t\t}",
				replacement:
					"\t\tif (arms.some((arm) => arm.every === undefined)) {\n\t\t\treturn unread\n\t\t}",
				why: "A filter navigation reads no part of leaves the whole rule as written: A and B one flat join, as the ledger's limited attempts were read at every start and answer."
			},
			{
				file: "packages/engine/src/analysis/theory/navigate.ts",
				original: "\t\t\t\t;(this.#readable(c) ? filters : asWritten).push(c)",
				replacement: "\t\t\t\tfilters.push(c)",
				why: "A filter navigation reads no part of is navigated after the chain as a readable one is: its rule, a fold, is read as a chain it is not."
			}
		]
	})
