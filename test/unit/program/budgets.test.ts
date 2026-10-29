import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { features } from "@grizzle/testing/features"
import { exact } from "@grizzle/testing/oracle"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Duration, Effect, Formatter, Option, pipe, String as Str } from "effect"
import type { CompileError } from "#compiler/core/errors.ts"
import { formatLoc } from "#compiler/core/loc.ts"
import { type BudgetKind, type Budgets, compileBudgets } from "#compiler/core/policy.ts"
import * as Result from "#compiler/core/result.ts"
import { utf8Length } from "#compiler/core/sha256.ts"
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
 * kernel/policy.ts budgetRefusal). Only the specialization variants are a decision as well as a bound (the finite pass
 * expands a membership within them), so the reference compilation keeps the drawn variants and lifts every other budget
 * to compileBudgets'. The budgets are compileQuery's own parameter (CompileQueryOptions.budgets), never a global.
 *
 * Each case draws a public program (oracle/public/generate.ts) and budgets (kernel/policy.ts budgetsGen), and compiles
 * every query read:
 *
 * 1. under the reference budgets and under the drawn ones (test/support/compile.ts compileTemplateUnder). The reference
 *    succeeds or refuses by a budget. Under the drawn budgets the read succeeds only where the reference succeeds, with
 *    byte-identical statements, and at least the bytes of its executable statements within sqlBytes (one meter bounds
 *    the whole compilation); or it refuses by a drawn budget, a params refusal located at the author's parameter use in
 *    the builder module;
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

/**
 * The bytes of a template's executable statements, each of which the compilation charges to sqlBytes: a lower bound
 * of what it needs.
 */
const executableBytes = (t: QueryTemplate): number =>
	Arr.reduce(
		[...t.optimized, ...t.conservative, ...largeSpecs(t)],
		0,
		(n, s) => n + utf8Length(s.sql)
	)

const refusalOf = (e: CompileError) => ({
	reason: e.reason._tag,
	location: formatLoc(refusalLoc(e))
})

/** The budgets a drawn read is judged against: its variants, every other budget compileBudgets'. */
const referenceOf = (budgets: Budgets): Budgets =>
	Object.freeze({ ...compileBudgets, variants: budgets.variants })

/** Whether drawn budgets differ from their reference: a budget other than the variants below compileBudgets'. */
const belowReference = (budgets: Budgets): boolean =>
	Arr.some(budgetFeatures(budgets), (f) => !Str.startsWith("budgets.variants=")(f))

/**
 * The module whose builder calls write every generated program: a refusal located at an author's parameter use names a
 * call site in it.
 */
const builderModule = import.meta.resolve("#test/support/oracle/public/build.ts")

/**
 * What a case reaches: a compiled read under drawn budgets or production's, each budget's refusal under the reference
 * and the drawn budgets, a params refusal at the author's call site, and the drawn budgets.
 */
type BudgetsFeature =
	| "compiled"
	| "compiled under drawn budgets"
	| `reference refused budgets.${BudgetKind}`
	| `refused budgets.${BudgetKind}`
	| "refused budgets.params at the author's call site"
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
						features: features<BudgetsFeature>([
							"compiled",
							"compiled under drawn budgets",
							"refused budgets.nodes",
							"refused budgets.fields",
							"refused budgets.sqlBytes"
						]),
						kept: [],
						runs: 200,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						steering: { kind: "none" },
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
							const reference = referenceOf(budgets)
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
									if (executableBytes(template) > budgets.sqlBytes) {
										fail(
											`the executable statements take ${executableBytes(template)} bytes, past budgets.sqlBytes = ${budgets.sqlBytes}`
										)
									}
									if (belowReference(budgets)) {
										notes.note("compiled under drawn budgets")
									}
								} else {
									const crossed = budgetRefusal(under.error, budgets)
									if (!crossed.ok) {
										return fail(`under the drawn budgets the compilation ${crossed.error}`)
									}
									notes.note(`refused budgets.${crossed.value}`)
									if (crossed.value === "params") {
										if (
											!pipe(formatLoc(refusalLoc(under.error)), Str.includes(`${builderModule}:`))
										) {
											fail(
												`a params refusal is located at ${formatLoc(refusalLoc(under.error))}, not at the author's call site in ${builderModule}`
											)
										}
										notes.note("refused budgets.params at the author's call site")
									}
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
