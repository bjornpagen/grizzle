import { drawn, explore } from "@bjornpagen/testing/explore"
import { required } from "@bjornpagen/testing/features"
import { notesOnly } from "@bjornpagen/testing/sense"
import { completeShrink } from "@bjornpagen/testing/shrink"
import { searched } from "@bjornpagen/testing/vitest"
/**
 * Navigation (analysis/theory/navigate.ts) keeps a query's meaning: every generated query read the public generator
 * draws (test/support/oracle/public), navigated as a write member is (navigateMember), answers as the read itself does,
 * each checked and evaluated by the reference over its checked IR, compared by the answer's contract (a set, or ordered
 * where the read delivers in order). The navigated IR is read first by the strict DAG re-reader
 * (test/support/oracle/dag-validate.ts), so a step that reads a column outside every scope that binds it is a defect
 * before any answer is compared, and both lowerings lower it.
 *
 * Oracle: a second implementation, the read as written, through the same checker and the same reference.
 *
 * Features: a read navigated, one whose navigation inlines an imported query, one keyed by a parameter, one with a
 * negation, and one of three steps or more.
 *
 * Plants (~/.cache/grizzle-release/PROBESPLIT/plants), each failing the search in its steered phase:
 * navigate-drops-step-conditions.patch (a condition placed inside a step is dropped) and
 * navigate-negation-drops-a-column.patch (a negated relation's step reads one column fewer than the negation binds).
 */
import { describe, it } from "@effect/vitest"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import { navigateMember } from "#compiler/analysis/theory/navigate.ts"
import { checkQuery } from "#compiler/check/index.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { topoOrder } from "#compiler/ir/dag.ts"
import type { InferredQuery } from "#compiler/ir/desc.ts"
import { lowerConservative } from "#compiler/lower/conservative/index.ts"
import { conservativeInput } from "#compiler/lower/conservative/types.ts"
import { queryInput } from "#compiler/program/compile.ts"
import { succeeded } from "#test/support/assert.ts"
import { testArtifacts, testCompile } from "#test/support/compile.ts"
import { caseHang } from "#test/support/limits.ts"
import { validateDag } from "#test/support/oracle/dag-validate.ts"
import { answerEquivalence, answersReport, shapeOf } from "#test/support/oracle/public/answer.ts"
import { buildRoot, buildSchema } from "#test/support/oracle/public/build.ts"
import { caseSketchGen, resolveCase } from "#test/support/oracle/public/generate.ts"
import { expectedFrom } from "#test/support/oracle/public/meaning.ts"
import { printCase } from "#test/support/oracle/public/print.ts"
import type { ProgramCase, ProgramRead } from "#test/support/oracle/public/program.ts"
import { unobserved } from "#test/support/oracle/reference/evaluate.ts"
import { checking, checkOptions } from "#test/support/policy.ts"

type QueryRead = Extract<ProgramRead, { readonly kind: "query" }>

type Feature =
	| "a read navigated"
	| "a navigated read inlining an imported query"
	| "a navigated read keyed by a parameter"
	| "a navigated read with a negation"
	| "a navigated read of three steps or more"

const situations: Arr.NonEmptyReadonlyArray<Feature> = [
	"a read navigated",
	"a navigated read inlining an imported query",
	"a navigated read keyed by a parameter",
	"a navigated read with a negation",
	"a navigated read of three steps or more"
]

const loc = SourceLoc("navigation property", [])

/** The steps a navigated query reads, through every negation and every rule it fences. */
const stepsOf = (q: InferredQuery): number =>
	q.stage.kind === "rules"
		? Arr.reduce(q.stage.arms, 0, (n, rule) =>
				Arr.reduce(rule.matches, n, (m, match) =>
					match.source.kind === "step" ? m + 1 + stepsOf(match.source.query) : m
				)
			)
		: 0

/** One query read and its navigation, each checked and evaluated by the reference, which must agree. */
const judged = (c: ProgramCase, read: QueryRead, note: (f: Feature) => void): void => {
	const built = buildSchema(c.schema)
	const desc = succeeded(queryInput(buildRoot(built, built.schema, read.query))).desc
	const navigated = navigateMember(desc, loc)
	if (navigated === desc) {
		return
	}
	note("a read navigated")
	const original = desc.stage.kind === "rules" ? desc.stage.arms : []
	if (Arr.some(original, (r) => Arr.some(r.matches, (m) => m.source.kind === "query"))) {
		note("a navigated read inlining an imported query")
	}
	if (read.params.length > 0) {
		note("a navigated read keyed by a parameter")
	}
	if (Arr.some(original, (r) => Arr.some(r.where, (w) => w.kind === "absent"))) {
		note("a navigated read with a negation")
	}
	if (stepsOf(navigated) >= 3) {
		note("a navigated read of three steps or more")
	}
	const options = checkOptions("query")
	const as = succeeded(checkQuery(checking(built.schema), desc, options), printCase(c))
	const nav = succeeded(
		checkQuery(checking(built.schema), navigated, options),
		`the checker refuses a navigated read\n${printCase(c)}`
	)
	validateDag(nav.dag)
	if (!Arr.some(topoOrder(nav.dag), (n) => n.kind === "Step")) {
		throw new Error(`a navigated read's IR holds no step\n${printCase(c)}`)
	}
	const artifacts = succeeded(testArtifacts(built.schema, testCompile))
	succeeded(
		lowerConservative(conservativeInput(nav), {
			names: artifacts.names,
			params: nav.params,
			subject: { kind: "query" }
		}),
		`the conservative lowering refuses a navigated read\n${printCase(c)}`
	)
	const shape = shapeOf(read.query)
	const meant = expectedFrom(c, read, { dag: as.dag, root: as.dag.roots[0] }, unobserved)
	const walked = expectedFrom(c, read, { dag: nav.dag, root: nav.dag.roots[0] }, unobserved)
	const difference = answerEquivalence(shape, read.query.delivery.kind === "ordered")(meant, walked)
	if (Option.isSome(difference)) {
		throw new Error(
			`${answersReport(shape, difference.value, [
				["the read as written", meant],
				["the read navigated", walked]
			])}\n${printCase(c)}`
		)
	}
}

describe("navigation", () => {
	it.effect("keeps every generated read's answer, by the reference over the checked IR", (ctx) =>
		searched(
			ctx,
			explore(
				{
					oracle: {
						kind: "second-implementation",
						name: "the read as written, checked and evaluated by the reference beside its navigation"
					},
					suite: "unit/analysis/navigation",
					draw: drawn(caseSketchGen),
					literal: Formatter.format,
					coverage: required<Feature>(situations, { cases: 400, sense: notesOnly }),
					kept: [],
					runs: 400,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang
				},
				(sketch, k) =>
					Effect.sync(() => {
						const c = k.draw(resolveCase(sketch))
						for (const read of c.reads) {
							if (read.kind === "query") {
								judged(c, read, k.note)
							}
						}
					})
			)
		)
	)
})
