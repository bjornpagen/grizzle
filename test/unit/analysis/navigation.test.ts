import { drawn, exhaust, explore } from "@bjornpagen/testing/explore"
import { required, requiredInSpace } from "@bjornpagen/testing/features"
import { element, type Gen } from "@bjornpagen/testing/gen"
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
 * A second property states the gate (analysis/theory/navigate.ts Navigator.rule) over a write member's shape, a join of
 * A and B keyed by the call's parameter p with up to three negations, each over a relation of its own and declared in
 * order: a negation that reads no variable of its rule, only p or a literal, stands among the conditions of the chain's
 * own rule, in declared order, so PostgreSQL judges it once, before the chain reads a row; a negation that reads a
 * variable wraps the rule before it, in declared order, the first innermost. Its box is every assignment of the three
 * negations' slots: none, a gate by p, a gate by a literal, or correlated through A's k, exhausted. Oracle: the gate's
 * rule restated over the navigated IR, the negated relations found in the chain's rule and in each wrapper. Features: a
 * gate by a parameter, a gate by a literal, a gate declared after a correlated negation, two gates.
 */
import { describe, it } from "@effect/vitest"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import { navigateMember } from "#compiler/analysis/theory/navigate.ts"
import { checkQuery } from "#compiler/check/index.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { topoOrder } from "#compiler/ir/dag.ts"
import type { InferredExpr, InferredQuery, InferredRule } from "#compiler/ir/desc.ts"
import { lowerConservative } from "#compiler/lower/conservative/index.ts"
import { conservativeInput } from "#compiler/lower/conservative/types.ts"
import { queryInput } from "#compiler/program/compile.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { assert, succeeded } from "#test/support/assert.ts"
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

/** One negation slot of a gate case: none, a gate by the parameter p, a gate by a literal, or correlated through k. */
type Slot = "none" | "gate by a parameter" | "gate by a literal" | "correlated"

/** A gate case: the slots of N0, N1 and N2, declared in that order. */
type GateCase = readonly [Slot, Slot, Slot]

type GateFeature =
	| "a gate by a parameter"
	| "a gate by a literal"
	| "a gate declared after a correlated negation"
	| "two gates"

const slotGen: Gen<Slot> = element<Slot>([
	"none",
	"gate by a parameter",
	"gate by a literal",
	"correlated"
])

const gateCaseGen: Gen<GateCase> = (s) => [s.draw(slotGen), s.draw(slotGen), s.draw(slotGen)]

const isGate = (slot: Slot): boolean =>
	slot === "gate by a parameter" || slot === "gate by a literal"

const A = relation("A", { id: pg.integer, k: pg.integer }, ["id"])
const B = relation("B", { k: pg.integer, v: pg.integer }, ["k"])
const N0 = relation("N0", { k: pg.integer }, ["k"])
const N1 = relation("N1", { k: pg.integer }, ["k"])
const N2 = relation("N2", { k: pg.integer }, ["k"])
const Gates = schema("Gates", [A, B, N0, N1, N2], [])

/** A write member's query of a gate case: A at p joined to B by k, then each slot's negation, in slot order. */
const gateQueryOf = (c: GateCase): InferredQuery =>
	succeeded(
		queryInput(
			query(Gates).rule((r) => {
				const { k } = v(A, "a")
				const { v: value } = v(B, "b")
				const p = r.param("p", pg.integer)
				const negations = Arr.flatMap(
					[
						[N0, c[0]],
						[N1, c[1]],
						[N2, c[2]]
					] as const,
					([N, slot]) => {
						switch (slot) {
							case "none":
								return []
							case "gate by a parameter":
								return [r.not(N, { k: p })]
							case "gate by a literal":
								return [r.not(N, { k: 1 })]
							case "correlated":
								return [r.not(N, { k })]
						}
					}
				)
				const matched = r.match(A, { id: p, k }).match(B, { k, v: value })
				const head = { k, v: value }
				const [n0, n1, n2] = negations
				return n0 === undefined
					? matched.find(head)
					: n1 === undefined
						? matched.where(n0).find(head)
						: n2 === undefined
							? matched.where(n0, n1).find(head)
							: matched.where(n0, n1, n2).find(head)
			})
		)
	).desc

/** The relation a navigated negation reads, the one relation its step's rule matches: none for any other condition. */
const negatedRelation = (e: InferredExpr): ReadonlyArray<string> => {
	if (e.kind !== "absent" || e.source.kind !== "step" || e.source.query.stage.kind !== "rules") {
		return []
	}
	const [match] = e.source.query.stage.arms[0].matches
	return match?.source.kind === "relation" ? [match.source.name] : []
}

/** Whether a navigated rule wraps the rule before it: its one match a step whose rule matches only steps. */
const wrapped = (rule: InferredRule): InferredRule | undefined => {
	const [only, ...more] = rule.matches
	if (only === undefined || more.length > 0 || only.source.kind !== "step") {
		return undefined
	}
	const stage = only.source.query.stage
	if (stage.kind !== "rules") {
		return undefined
	}
	const [inner] = stage.arms
	return Arr.every(inner.matches, (m) => m.source.kind === "step") ? inner : undefined
}

/**
 * The negated relations of a navigated rule: those among the conditions of the chain's own rule, and those of each
 * wrapper, the innermost first.
 */
const negationsOf = (
	rule: InferredRule
): { readonly gates: ReadonlyArray<string>; readonly wrappers: ReadonlyArray<string> } => {
	const outer: Array<ReadonlyArray<string>> = []
	let at = rule
	for (let inner = wrapped(at); inner !== undefined; inner = wrapped(at)) {
		outer.push(Arr.flatMap(at.where, negatedRelation))
		at = inner
	}
	return {
		gates: Arr.flatMap(at.where, negatedRelation),
		wrappers: Arr.flatten(Arr.reverse(outer))
	}
}

describe("navigation's gate", () => {
	it.effect(
		"judges a write member's negation that reads no variable among the chain's own conditions, in declared order, and wraps the chain in every other",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/analysis/navigation-gates",
						generator: gateCaseGen,
						literal: Formatter.format,
						box: "every assignment of three negations' slots, each none, a gate by the parameter, a gate by a literal or correlated, over a join of A at the parameter and B",
						oracle: {
							kind: "specification",
							name: "the gate's rule restated: a negation that reads no variable among the chain's own conditions in declared order, every other a wrapper in declared order"
						},
						coverage: requiredInSpace<GateFeature>([
							"a gate by a parameter",
							"a gate by a literal",
							"a gate declared after a correlated negation",
							"two gates"
						]),
						caseHang
					},
					(c, k) =>
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
						})
				)
			)
	)
})
