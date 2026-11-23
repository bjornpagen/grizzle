/** What the properties of navigation.test.ts read: its spaces, models and helpers. */

import { assert } from "@bjornpagen/testing/assert"
import { element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, Option, Record as Rec, Result, String as Str, Struct } from "effect"
import { queryColumns } from "#compiler/analysis/theory/columns.ts"
import { varRef } from "#compiler/analysis/theory/leaves.ts"
import { Navigation, navigateQuery } from "#compiler/analysis/theory/navigate.ts"
import { buildTheory } from "#compiler/analysis/theory/theory.ts"
import { checkQuery } from "#compiler/check/index.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { topoOrder } from "#compiler/ir/dag.ts"
import type { InferredExpr, InferredQuery, InferredRule } from "#compiler/ir/desc.ts"
import { lowerConservative } from "#compiler/lower/conservative/index.ts"
import { conservativeInput } from "#compiler/lower/conservative/types.ts"
import { queryInput } from "#compiler/program/input.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { succeeded } from "#test/support/assert.ts"
import { testArtifacts, testCompile } from "#test/support/compile.ts"
import { validateDag } from "#test/support/oracle/dag-validate.ts"
import { answerEquivalence, answersReport, shapeOf } from "#test/support/oracle/public/answer.ts"
import { buildRoot, buildSchema } from "#test/support/oracle/public/build.ts"
import {
	type CaseSketch,
	caseSketchGen,
	type SwarmFeature
} from "#test/support/oracle/public/generate.ts"
import { expectedFrom } from "#test/support/oracle/public/meaning.ts"
import { printCase } from "#test/support/oracle/public/print.ts"
import type { ProgramCase, ProgramRead } from "#test/support/oracle/public/program.ts"
import { unobserved } from "#test/support/oracle/reference/evaluate.ts"
import { checking, checkOptions } from "#test/support/policy.ts"

type QueryRead = Extract<ProgramRead, { readonly kind: "query" }>

export type Feature =
	| "a read navigated"
	| "a navigated read inlining an imported query"
	| "a navigated read keyed by a parameter"
	| "a navigated read with a negation"
	| "a navigated read keeping a row beside a one-column negation of a relation that holds a fact"
	| "a navigated read of three steps or more"

export const situations: Arr.NonEmptyReadonlyArray<Feature> = [
	"a read navigated",
	"a navigated read inlining an imported query",
	"a navigated read keyed by a parameter",
	"a navigated read with a negation",
	"a navigated read keeping a row beside a one-column negation of a relation that holds a fact",
	"a navigated read of three steps or more"
]

export const loc = SourceLoc("navigation property", [])

/** The steps a navigated query reads, through every negation and every rule it fences. */
const stepsOf = (q: InferredQuery): number =>
	q.stage.kind === "rules"
		? Arr.reduce(q.stage.arms, 0, (n, rule) =>
				Arr.reduce(rule.matches, n, (m, match) =>
					match.source.kind === "step" ? m + 1 + stepsOf(match.source.query) : m
				)
			)
		: 0

/**
 * One query read and its navigation, each checked and evaluated by the reference, which must agree. A navigation that
 * builds steps keeps them through the checker; one of a rule that joins nothing changes the read only by restricting an
 * import it reads whole to the values the rule fixes (navigate.ts navigatedRule, boundInside), and builds none.
 */
export const judged = (c: ProgramCase, read: QueryRead, note: (f: Feature) => void): void => {
	const built = buildSchema(c.schema)
	const desc = succeeded(queryInput(buildRoot(built, built.schema, read.query))).desc
	const checked = checking(built.schema)
	const navigated = navigateQuery(
		desc,
		loc,
		queryColumns(checked, loc),
		{ kind: "perStatement", extent: "units" },
		new Navigation(succeeded(buildTheory(checked)).regionFacts)
	)
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
	/**
	 * Whether the read negates a relation that holds a fact by one column: a negation that binds none of it, as a step
	 * that reads less than its negation binds would, refuses every row.
	 */
	const negatesHeld = Arr.some(original, (r) =>
		Arr.some(
			r.where,
			(w) =>
				w.kind === "absent" &&
				w.source.kind === "relation" &&
				Rec.size(w.bindings) === 1 &&
				(c.facts.get(w.source.name) ?? []).length > 0
		)
	)
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
	if (stepsOf(navigated) > 0 && !Arr.some(topoOrder(nav.dag), (n) => n.kind === "Step")) {
		throw new Error(
			`a navigated read's IR holds none of the steps its navigation built\n${printCase(c)}`
		)
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
	if (negatesHeld && Result.isSuccess(meant) && meant.success.length > 0) {
		note(
			"a navigated read keeping a row beside a one-column negation of a relation that holds a fact"
		)
	}
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

/** One negation slot of a gate case: none, a gate by the parameter p, a gate by a literal, or correlated through k. */
export type Slot = "none" | "gate by a parameter" | "gate by a literal" | "correlated"

/** A gate case: the slots of N0, N1 and N2, declared in that order. */
type GateCase = readonly [Slot, Slot, Slot]

export type GateFeature =
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

export const gateCaseGen: Gen<GateCase> = (s) => [s.draw(slotGen), s.draw(slotGen), s.draw(slotGen)]

export const isGate = (slot: Slot): boolean =>
	slot === "gate by a parameter" || slot === "gate by a literal"

const A = relation("A", { id: pg.integer, k: pg.integer }, ["id"])

const B = relation("B", { k: pg.integer, v: pg.integer }, ["k"])

const N0 = relation("N0", { k: pg.integer }, ["k"])

const N1 = relation("N1", { k: pg.integer }, ["k"])

const N2 = relation("N2", { k: pg.integer }, ["k"])

const Gates = schema("Gates", [A, B, N0, N1, N2], [])

/** The columns of each query a gate case's navigation imports, over Gates. */
export const gateColumns = queryColumns(checking(Gates), loc)

/** The containments Gates's theory holds: none, its schema stating none. */
export const gateFacts = succeeded(buildTheory(checking(Gates))).regionFacts

/** A write member's query of a gate case: A at p joined to B by k, then each slot's negation, in slot order. */
export const gateQueryOf = (c: GateCase): InferredQuery =>
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
export const negationsOf = (
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

/**
 * The swarm features under which a generated read is seldom or never a join navigation reads (navigate.ts
 * navigateQuery): an aggregate head, an attachment, an interior, a match of a relation parameter or a closure, a key
 * read, and a root of several arms (a union, literal heads), a take or a name. With them off, about half the aimed cases
 * hold a navigated read, against one in thirty of the plain population.
 */
const unnavigated: ReadonlyArray<SwarmFeature> = [
	"aggregate",
	"attach",
	"interior",
	"recursive",
	"relation param",
	"key read",
	"union",
	"literal head",
	"take",
	"named"
]

/**
 * A case sketch of the plain swarm population whose swarm holds `on` at full weight and none of `unnavigated`, every other
 * feature as the drawn sketch's own swarm holds it: a case whose reads are joins navigation reads far more often than
 * the plain population's, each with `on` wherever it fits.
 */
export const navigatedSketchGen =
	(on: ReadonlyArray<SwarmFeature>): Gen<CaseSketch> =>
	(source) => {
		const sketch = source.draw(caseSketchGen)
		const kept = Arr.flatMap(Struct.keys(sketch.swarm), (feature) => {
			const weight = sketch.swarm[feature]
			return weight === undefined || unnavigated.includes(feature) || on.includes(feature)
				? []
				: [[feature, weight] as const]
		})
		return {
			...sketch,
			population: "swarm",
			swarm: Rec.fromEntries([...kept, ...Arr.map(on, (feature) => [feature, 3] as const)])
		}
	}

/**
 * A case sketch of navigatedSketchGen over dense values, every read's negation binding one column (its first pick
 * alone, where the drawn sketch picks two): a case whose navigated read keeps a row beside a one-column negation of a
 * relation that holds a fact, which the plain population reaches in about one case of a hundred.
 */
export const oneColumnNegationSketchGen: Gen<CaseSketch> = (source) => {
	const sketch = source.draw(navigatedSketchGen(["negation", "bind fresh"]))
	return {
		...sketch,
		reads: Arr.map(sketch.reads, (read) => ({
			...read,
			rule: {
				...read.rule,
				negation: { ...read.rule.negation, picks: read.rule.negation.picks.slice(0, 1) }
			}
		}))
	}
}

/**
 * A gate case's query (`gateQueryOf`) as a rule over a chain of steps: its reads, A at p joined to B, one step its rule
 * matches, delivering the variables the negations read, and the slots' negations the rule's own filters, as written. A
 * probe's row over a region of keys and the meeting part over such rows stand so (analysis/theory/query.ts overRegion).
 */
export const overStepsOf = (c: GateCase): InferredRule => {
	const stage = gateQueryOf(c).stage
	if (stage.kind !== "rules") {
		return assert.fail("a gate case's query is one rules stage")
	}
	const [rule] = stage.arms
	const p = Arr.findFirst(rule.matches, (m) => m.bindings["id"]?.kind === "param").pipe(
		Option.flatMap((m) => Option.fromUndefinedOr(m.bindings["id"]))
	)
	if (Option.isNone(p)) {
		return assert.fail("a gate case's A is matched at the parameter p")
	}
	const delivered = Rec.fromEntries(Arr.map(rule.vars, (d) => [d.id, varRef(d.id)] as const))
	const inner: InferredRule = {
		...rule,
		where: Arr.filter(rule.where, (w) => w.kind !== "absent"),
		head: delivered
	}
	return {
		...rule,
		matches: [
			{
				source: {
					kind: "step",
					query: { stage: { kind: "rules", arms: [inner], loc } },
					bind: { p: p.value }
				},
				bindings: delivered,
				loc
			}
		],
		where: Arr.filter(rule.where, (w) => w.kind === "absent")
	}
}

/**
 * The negations a navigated rule over steps holds along its chain of steps, its own and each step's rule's, at any depth:
 * those navigated (a step reading the negated relation, `negatedRelation`) and those left as written (a negation of
 * the relation itself), each by its relation, sorted.
 */
export const negatedThroughSteps = (
	rule: InferredRule
): { readonly navigated: ReadonlyArray<string>; readonly asWritten: ReadonlyArray<string> } => {
	const navigated: Array<string> = []
	const asWritten: Array<string> = []
	const visit = (r: InferredRule): void => {
		for (const w of r.where) {
			if (w.kind === "absent") {
				if (w.source.kind === "relation") {
					asWritten.push(w.source.name)
				}
				for (const name of negatedRelation(w)) {
					navigated.push(name)
				}
			}
		}
		for (const m of r.matches) {
			if (m.source.kind === "step" && m.source.query.stage.kind === "rules") {
				for (const arm of m.source.query.stage.arms) {
					visit(arm)
				}
			}
		}
	}
	visit(rule)
	return {
		navigated: Arr.sort(navigated, Str.Order),
		asWritten: Arr.sort(asWritten, Str.Order)
	}
}

/**
 * How an unread case reaches a rule navigation reads no part of (analysis/theory/navigate.ts RuleReads): it negates an
 * aggregating rule itself, or a union one rule of which negates it, as the ledger's limited attempts negate the
 * unlimited members, whose max-attempts in force negate the nearest scope that states one, a fold.
 */
export type UnreadCase = "an aggregate" | "a union negating an aggregate"

export const unreadCaseGen: Gen<UnreadCase> = element([
	"an aggregate",
	"a union negating an aggregate"
] as const)

/** The greatest key N0 holds: a fold, which navigation reads no part of. */
const greatest = query(Gates).rule((r) => {
	const { k } = v(N0, "greatest")
	return r.match(N0, { k }).find({ k: r.max(k) })
})

/** N1's keys, and N2's that are not N0's greatest: a union one rule of which negates the fold. */
const ungreatest = query(Gates)
	.rule((r) => {
		const { k } = v(N1, "kept")
		return r.match(N1, { k }).find({ k })
	})
	.rule((r) => {
		const { k } = v(N2, "ungreatest")
		return r.match(N2, { k }).where(r.not(greatest, { k })).find({ k })
	})

/** A rule statement's query of an unread case: A at p joined to B by k, beside the case's negation at k. */
export const unreadQueryOf = (c: UnreadCase): InferredQuery =>
	succeeded(
		queryInput(
			query(Gates).rule((r) => {
				const { k } = v(A, "a")
				const { v: value } = v(B, "b")
				const p = r.param("p", pg.integer)
				return r
					.match(A, { id: p, k })
					.match(B, { k, v: value })
					.where(c === "an aggregate" ? r.not(greatest, { k }) : r.not(ungreatest, { k }))
					.find({ k, v: value })
			})
		)
	).desc

/** The relations a navigated rule's steps read, at any depth of its steps and wrappers, each step's rule's own matches, sorted. */
export const steppedRelations = (rule: InferredRule): ReadonlyArray<string> => {
	const out: Array<string> = []
	const visit = (r: InferredRule, inStep: boolean): void => {
		for (const m of r.matches) {
			if (m.source.kind === "relation" && inStep) {
				out.push(m.source.name)
			} else if (m.source.kind === "step" && m.source.query.stage.kind === "rules") {
				for (const arm of m.source.query.stage.arms) {
					visit(arm, true)
				}
			}
		}
	}
	visit(rule, false)
	return Arr.sort(out, Str.Order)
}

/** The rule of a navigated rule's chain, through every wrapper that holds it (`wrapped`), the innermost. */
export const unwrapped = (rule: InferredRule): InferredRule => {
	const inner = wrapped(rule)
	return inner === undefined ? rule : unwrapped(inner)
}
