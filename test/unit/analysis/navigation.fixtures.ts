/** What the properties of navigation.test.ts read: its spaces, models and helpers. */

import { appendAll } from "@bjornpagen/grizzle-text/base/array"
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
import { equalityIsIdentity } from "#compiler/ir/scalar.ts"
import { lowerConservative } from "#compiler/lower/conservative/index.ts"
import { conservativeInput } from "#compiler/lower/conservative/types.ts"
import { queryInput } from "#compiler/program/input.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { succeeded } from "#test/support/assert.ts"
import { testArtifacts, testCompile } from "#test/support/compile.ts"
import { validateDag } from "#test/support/oracle/dag-validate.ts"
import { float8, valueClasses } from "#test/support/oracle/gen/domain.ts"
import { answerEquivalence, answersReport, shapeOf } from "#test/support/oracle/public/answer.ts"
import { buildRoot, buildSchema } from "#test/support/oracle/public/build.ts"
import {
	type CaseSketch,
	caseSketchGen,
	type SwarmFeature
} from "#test/support/oracle/public/generate.ts"
import { expectedFrom } from "#test/support/oracle/public/meaning.ts"
import { printCase } from "#test/support/oracle/public/print.ts"
import {
	fieldKinds,
	type ProgramCase,
	type ProgramRead
} from "#test/support/oracle/public/program.ts"
import { unobserved } from "#test/support/oracle/reference/evaluate.ts"
import { pickOf } from "#test/support/pick.ts"
import { checking, checkOptions } from "#test/support/policy.ts"

type QueryRead = Extract<ProgramRead, { readonly kind: "query" }>

export type Feature =
	| "a read navigated"
	| "a navigated read inlining an imported query"
	| "a navigated read keyed by a parameter"
	| "a navigated read with a negation"
	| "a navigated read joining a float variable through an inlined import"
	| "a navigated read keeping a row beside a one-column negation of a relation that holds a fact"
	| "a navigated read of three steps or more"

export const situations: Arr.NonEmptyReadonlyArray<Feature> = [
	"a read navigated",
	"a navigated read inlining an imported query",
	"a navigated read keyed by a parameter",
	"a navigated read with a negation",
	"a navigated read joining a float variable through an inlined import",
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
 * Whether a read's checked IR joins a float variable through an import where a stored relation holds -0: a region
 * binding a variable whose equality is no identity at an import's column and at a stored relation's, a fact of which
 * holds -0 there. Navigation inlines the import into one binding of the variable (analysis/theory/navigate.ts #inline),
 * and the written rule's merge delivers the variable's canonical +0, so a navigated rule that bound it at the relation's
 * read alone would deliver that -0.
 */
const joinsAFloatThroughAnImport = (
	c: ProgramCase,
	dag: Parameters<typeof topoOrder>[0]
): boolean => {
	const holdsNegativeZero = (relation: string, column: string): boolean => {
		const at = Arr.findFirstIndex(
			Arr.findFirst(c.schema.relations, (r) => r.name === relation).pipe(
				Option.match({ onNone: () => [], onSome: (r) => r.fields })
			),
			(f) => f.name === column
		)
		return (
			Option.isSome(at) &&
			Arr.some(c.facts.get(relation) ?? [], (fact) => {
				const value = fact[at.value]?.literal
				return value?.kind === "floatSpecial" && value.value === "-0"
			})
		)
	}
	return Arr.some(
		topoOrder(dag),
		(n) =>
			n.kind === "MatchRegion" &&
			Arr.some(n.vars, (v) => {
				const binders = Arr.filter(n.occurrences, (o) =>
					Arr.some(o.bindings, (b) => b.var.id === v.id)
				)
				return (
					!equalityIsIdentity(v.type) &&
					Arr.some(binders, (o) => o.source.kind !== "Base") &&
					Arr.some(binders, (o) => {
						const source = o.source
						return (
							source.kind === "Base" &&
							Arr.some(
								o.bindings,
								(b) => b.var.id === v.id && holdsNegativeZero(source.relation, b.column)
							)
						)
					})
				)
			})
	)
}

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
	if (
		joinsAFloatThroughAnImport(c, as.dag) &&
		Result.isSuccess(meant) &&
		meant.success.length > 0
	) {
		note("a navigated read joining a float variable through an inlined import")
	}
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

/**
 * One negation slot of a gate case: none, a gate by the parameter p, a gate by a literal, or correlated through k; or,
 * in a rule over steps, correlated through k with the tokens of N's lists, an import whose rule reads a split, which
 * navigation reads no part of (analysis/theory/navigate.ts RuleReads), as edullm's WalkFloat negates its tolerance's
 * third token.
 */
export type Slot =
	| "none"
	| "gate by a parameter"
	| "gate by a literal"
	| "correlated"
	| "correlated over a split"

/** A gate case: the slots of N0, N1 and N2, declared in that order. */
type GateCase = readonly [Slot, Slot, Slot]

export type GateFeature =
	| "a gate by a parameter"
	| "a gate by a literal"
	| "a gate declared after a correlated negation"
	| "two gates"

/** A rule over steps' features: a gate case's, and a negation of a split's import, left as written. */
export type StepsFeature = GateFeature | "a negation of a split's import"

const slotGen: Gen<Slot> = element<Slot>([
	"none",
	"gate by a parameter",
	"gate by a literal",
	"correlated"
])

export const gateCaseGen: Gen<GateCase> = (s) => [s.draw(slotGen), s.draw(slotGen), s.draw(slotGen)]

/** A slot of a rule over steps: a gate case's, or a negation of the tokens of N's lists. */
const stepSlotGen: Gen<Slot> = element<Slot>([
	"none",
	"gate by a parameter",
	"gate by a literal",
	"correlated",
	"correlated over a split"
])

/** A rule over steps' case: the slots of N0, N1 and N2, a negation of a split's import among them. */
export const overStepsCaseGen: Gen<GateCase> = (s) => [
	s.draw(stepSlotGen),
	s.draw(stepSlotGen),
	s.draw(stepSlotGen)
]

export const isGate = (slot: Slot): boolean =>
	slot === "gate by a parameter" || slot === "gate by a literal"

const A = relation("A", { id: pg.integer, k: pg.integer }, ["id"])

const B = relation("B", { k: pg.integer, v: pg.integer }, ["k"])

/** A list of any text, which a negation over a split reads the tokens of. */
const List = str.regex("^.*$", "su")

const N0 = relation("N0", { k: pg.integer, list: List }, ["k"])

const N1 = relation("N1", { k: pg.integer, list: List }, ["k"])

const N2 = relation("N2", { k: pg.integer, list: List }, ["k"])

/** The keys of N whose list holds a token: an import whose rule reads a split (r.tokens), which navigation reads no part of. */
const tokened = (N: typeof N0 | typeof N1 | typeof N2) =>
	query(Gates).rule((r) => {
		const { k, list } = v(N, "listed")
		const split = r.tokens(list)
		const { token } = v(split, "token")
		return r.match(N, { k, list }).match(split, { token }).find({ k })
	})

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
							case "correlated over a split":
								return [r.not(tokened(N), { k })]
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

/** The pick of a double precision field among the drawn kinds (program.ts fieldKinds). */
const float8Kind = pickOf(fieldKinds.indexOf("float8"), fieldKinds.length)

/** The pick of -0 among a double precision field's values, every one a case draws where it is not dense. */
const negativeZero = ((values) =>
	pickOf(
		Arr.findFirstIndex(values, (l) => l.kind === "floatSpecial" && l.value === "-0").pipe(
			Option.getOrThrowWith(() => new Error("-0 among double precision's values"))
		),
		values.length
	))(valueClasses(float8, true))

/**
 * A case sketch of navigatedSketchGen over an import and a join, never dense, every field of every relation but its
 * first double precision and every fact holding -0 there: a float variable joined through an inlined import where a
 * stored relation holds -0, whose written rule's merge delivers +0 (joinsAFloatThroughAnImport), which the plain
 * population reached in none of 2,500 cases over five seeds.
 */
export const floatImportJoinSketchGen: Gen<CaseSketch> = (source) => {
	const sketch = source.draw(navigatedSketchGen(["import", "bind join"]))
	return {
		...sketch,
		swarm: Rec.fromEntries(
			Arr.flatMap(Struct.keys(sketch.swarm), (feature) => {
				const weight = sketch.swarm[feature]
				return weight === undefined || feature === "dense" ? [] : [[feature, weight] as const]
			})
		),
		relations: Arr.map(sketch.relations, (r) => ({
			...r,
			fields: Arr.map(r.fields, (f, i) => (i === 0 ? f : { ...f, kind: float8Kind })),
			facts: Arr.map(r.facts, (fact) => ({
				values: Arr.map(fact.values, (value, i) => (i === 0 ? value : { cls: negativeZero, sp: 0 }))
			}))
		}))
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
 * The relation a negation left as written reads: the negated relation itself, or each an import's rule matches; none
 * for any other condition.
 */
const writtenRelation = (e: InferredExpr): ReadonlyArray<string> => {
	if (e.kind !== "absent") {
		return []
	}
	const source = e.source
	if (source.kind === "relation") {
		return [source.name]
	}
	return source.kind === "query" && source.query.stage.kind === "rules"
		? Arr.flatMap(source.query.stage.arms[0].matches, (m) =>
				m.source.kind === "relation" ? [m.source.name] : []
			)
		: []
}

/**
 * The negations a navigated rule over steps holds along its chain of steps, its own and each step's rule's, at any depth:
 * those navigated (a step reading the negated relation, `negatedRelation`) and those left as written (a negation of
 * the relation itself, or of an import, by the relation its rule matches), each by its relation, sorted.
 */
export const negatedThroughSteps = (
	rule: InferredRule
): { readonly navigated: ReadonlyArray<string>; readonly asWritten: ReadonlyArray<string> } => {
	const navigated: Array<string> = []
	const asWritten: Array<string> = []
	const visit = (r: InferredRule): void => {
		for (const w of r.where) {
			appendAll(asWritten, writtenRelation(w))
			appendAll(navigated, negatedRelation(w))
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
 * How an unread case reaches a filter navigation reads no part of (analysis/theory/navigate.ts RuleReads, Navigator
 * #readable): it negates an aggregating rule at its fold, the greatest value B holds or N0's greatest key for each list,
 * each a fold of no successor, whose rule navigation reads no part of; or N0's greatest key at its folded field, a
 * successor's fold, which navigation reads by one descent of N0's key since 1beed3dbb3 (successorFold) but at no step
 * the filter's terms restrict, its fold over N0 whole, whose aggregate no filter's step equates; or a union one rule of
 * which negates the greatest key, as the ledger's limited attempts negate the unlimited members, whose max-attempts in
 * force negate the nearest scope that states one, a fold.
 */
export type UnreadCase =
	| "a value's fold"
	| "an aggregate"
	| "a successor's fold"
	| "a union negating an aggregate"

export const unreadCaseGen: Gen<UnreadCase> = element([
	"a value's fold",
	"an aggregate",
	"a successor's fold",
	"a union negating an aggregate"
] as const)

/** The greatest value B holds: a fold of a column no key ends with, no successor, which navigation reads no part of. */
const highest = query(Gates).rule((r) => {
	const { k, v: value } = v(B, "highest")
	return r.match(B, { k, v: value }).find({ k: r.max(value) })
})

/**
 * The greatest key N0 holds for each list: a fold whose head reads N0's list beside it, so no successor
 * (analysis/theory/successor.ts successorOf), which navigation reads no part of.
 */
const greatestOfList = query(Gates).rule((r) => {
	const { k, list } = v(N0, "greatestOfList")
	return r.match(N0, { k, list }).find({ list, k: r.max(k) })
})

/** The greatest key N0 holds: a successor's fold, read by one descent of N0's key (navigate.ts extremeOf). */
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
					.where(
						c === "a value's fold"
							? r.not(highest, { k })
							: c === "an aggregate"
								? r.not(greatestOfList, { k })
								: c === "a successor's fold"
									? r.not(greatest, { k })
									: r.not(ungreatest, { k })
					)
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
