import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { exact } from "@grizzle/testing/oracle"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Duration, Effect, Formatter, Option } from "effect"
import type { CompileError } from "#compiler/core/errors.ts"
import { formatLoc } from "#compiler/core/loc.ts"
import { type BudgetKind, compileBudgets } from "#compiler/core/policy.ts"
import * as Result from "#compiler/core/result.ts"
import { flight } from "#compiler/lower/conservative/types.ts"
import { type QueryTemplate, queryInput } from "#compiler/program/compile.ts"
import { type ExecutionRequest, templateFor } from "#compiler/program/template.ts"
import { refusalLoc } from "#test/support/assert.ts"
import {
	compileTemplateUnder,
	schemaInputOf,
	testArtifacts,
	testCompile
} from "#test/support/compile.ts"
import {
	type BudgetFeature,
	budgetFeatures,
	budgetRefusal,
	budgetsGen
} from "#test/support/kernel/policy.ts"
import { buildRoot, buildSchema } from "#test/support/oracle/public/build.ts"
import { caseGen } from "#test/support/oracle/public/generate.ts"
import { printCase } from "#test/support/oracle/public/print.ts"

/**
 * Compiler resource bounds, through the compilation the runtime runs, over generated programs built through the public
 * builders.
 *
 * The contract: a compilation never truncates. Under any budgets it either succeeds with exactly the statements it
 * emits under grizzle's compile budgets (core/policy.ts compileBudgets), or refuses with a ResourceBound that names the
 * budget it crossed at that budget's limit, located where the charge crossed it (core/budget.ts, read by
 * kernel/policy.ts budgetRefusal). No budget decides anything, so the reference compilation is under compileBudgets.
 * The budgets are compileQuery's own parameter (CompileQueryOptions.budgets), never a global.
 *
 * Each case draws a public program (oracle/public/generate.ts) and budgets (kernel/policy.ts budgetsGen), and compiles
 * every query read:
 *
 * 1. under the reference budgets and under the drawn ones (test/support/compile.ts compileTemplateUnder). The reference
 *    succeeds or refuses by a budget. Under the drawn budgets the read succeeds only where the reference succeeds, with
 *    byte-identical statements; or it refuses by a drawn budget;
 * 2. as a Db compiles it (program/template.ts templateFor), under compileBudgets: a template or a budget's refusal;
 * 3. the same way again, after the case's other reads compiled in between, which must reach the same outcome and the
 *    same statements: nothing one compilation leaves behind answers another.
 *
 * How every read here is compiled: as a Db's reads are, for the snapshot context, read as rows.
 */
const request: ExecutionRequest = {
	context: "snapshot",
	read: "rows"
}

/** The specs of a template's optimized statements' large forms. */
const largeSpecs = (t: QueryTemplate) =>
	Arr.flatMap(flight(t.programs.optimized.roots), (s) =>
		s.forms.kind === "chosen" ? [s.forms.large.spec] : []
	)

/** The statements a template emits, as text. */
const statementsOf = (t: QueryTemplate) => ({
	optimized: Arr.map(t.optimized, (s) => s.sql),
	conservative: Arr.map(t.conservative, (s) => s.sql),
	variants: Arr.map(largeSpecs(t), (s) => s.sql)
})

const refusalOf = (e: CompileError) => ({
	reason: e.reason._tag,
	location: formatLoc(refusalLoc(e))
})

/**
 * What a case reaches: a compiled read under drawn budgets or production's, each budget's refusal under the reference
 * and the drawn budgets, and the drawn budgets.
 */
type BudgetsFeature =
	| "compiled"
	| "compiled under drawn budgets"
	| `reference refused budgets.${BudgetKind}`
	| `refused budgets.${BudgetKind}`
	| BudgetFeature

describe("compile budgets", () => {
	it.effect(
		"a compilation under drawn budgets succeeds as under compileBudgets or refuses with a located ResourceBound, and compiling it again gives the same template",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/program/budgets",
						draw: drawn((source) => ({
							c: source.draw(caseGen),
							budgets: source.draw(budgetsGen)
						})),
						literal: Formatter.format,
						coverage: required<BudgetsFeature>(
							["compiled", "compiled under drawn budgets", "refused budgets.nodes"],
							{ cases: 200, sense: notesOnly }
						),
						kept: [],
						runs: 200,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang: Duration.minutes(2)
					},
					({ c, budgets }, notes) =>
						Effect.sync(() => {
							const drawnFeatures = budgetFeatures(budgets)
							const named =
								drawnFeatures.length === 0 ? "compileBudgets" : Arr.join(drawnFeatures, ", ")
							const fail = (why: string): never => {
								throw new Error(`${why}\n${named}\n${printCase(c)}`)
							}
							notes.noteAll(drawnFeatures)
							const reference = compileBudgets
							const built = buildSchema(c.schema)
							const schema = built.schema
							const input = schemaInputOf(schema)
							const artifacts = testArtifacts(input, testCompile)
							const asDb = (query: unknown) =>
								Result.flatMap(artifacts, (a) =>
									Result.flatMap(queryInput(query), (q) => templateFor(q, input, a, request))
								)
							const queries = Arr.flatMap(c.reads, (read) =>
								read.kind === "query" ? [buildRoot(built, schema, read.query)] : []
							)
							const first = Arr.map(queries, asDb)
							for (const [i, query] of queries.entries()) {
								/** Under the reference budgets and the drawn ones. */
								const expected = compileTemplateUnder(query, schema, testCompile, reference)
								const under = compileTemplateUnder(query, schema, testCompile, budgets)
								if (!expected.ok) {
									const crossed = budgetRefusal(expected.error, reference)
									if (!crossed.ok) {
										return fail(`under the reference budgets the compilation ${crossed.error}`)
									}
									notes.note(`reference refused budgets.${crossed.value}`)
								}
								if (under.ok) {
									const template = under.value
									if (!expected.ok) {
										return fail(
											"the compilation succeeds under the drawn budgets and refuses under larger ones"
										)
									}
									if (Option.isSome(exact(statementsOf(template), statementsOf(expected.value)))) {
										fail("the drawn budgets changed the statements a compilation emits")
									}
									if (drawnFeatures.length > 0) {
										notes.note("compiled under drawn budgets")
									}
								} else {
									const crossed = budgetRefusal(under.error, budgets)
									if (!crossed.ok) {
										return fail(`under the drawn budgets the compilation ${crossed.error}`)
									}
									notes.note(`refused budgets.${crossed.value}`)
								}
								/** As a Db compiles it, under compileBudgets. */
								const outcome = first[i]
								if (outcome === undefined) {
									return fail(`the outcome of read ${i}`)
								}
								if (!outcome.ok) {
									const crossed = budgetRefusal(outcome.error, compileBudgets)
									if (!crossed.ok) {
										return fail(`under compileBudgets the compilation ${crossed.error}`)
									}
								} else {
									notes.note("compiled")
								}
								const fresh = asDb(query)
								if (fresh.ok !== outcome.ok) {
									fail("a compilation reaches another outcome after other reads compiled")
								}
								if (fresh.ok && outcome.ok) {
									const [a, b] = [fresh.value.template, outcome.value.template]
									if (Option.isSome(exact(statementsOf(a), statementsOf(b)))) {
										fail("a compilation compiles another template after other reads compiled")
									}
								}
								if (
									!fresh.ok &&
									!outcome.ok &&
									Option.isSome(exact(refusalOf(fresh.error), refusalOf(outcome.error)))
								) {
									fail("a compilation refuses otherwise after other reads compiled")
								}
							}
						})
				)
			)
	)
})
