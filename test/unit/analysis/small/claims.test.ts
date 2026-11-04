import { describe, it } from "@effect/vitest"
import { type Case, exhaust } from "@grizzle/testing/explore"
import { requiredInSpace, type Situations } from "@grizzle/testing/features"
import { element, type Gen } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Duration, Effect, Formatter, Option } from "effect"
import type { TestContext } from "vitest"
import type { MultiplicityReason } from "#compiler/analysis/certificates/reasons.ts"
import {
	analyzePhysical,
	type Obligation,
	type PhysicalAnalysis,
	type PhysicalEnv,
	unplaced
} from "#compiler/analysis/physical/analyze.ts"
import { isUnique, plainLosses, strongestKey } from "#compiler/analysis/physical/props.ts"
import { checkQuery } from "#compiler/check/index.ts"
import type { NodeId } from "#compiler/core/ids.ts"
import { topoOrder } from "#compiler/ir/dag.ts"
import type { TemplateContext } from "#compiler/ir/evidence.ts"
import type { Card, NodeOf, RelDag, RelNode } from "#compiler/ir/rel.ts"
import { analyzeLogical } from "#compiler/logical/annotate.ts"
import { schemaDesc } from "#test/support/oracle/gen/schema.ts"
import {
	noBindings,
	Reference,
	type ReferenceInput,
	unobserved
} from "#test/support/oracle/reference/evaluate.ts"
import { equal } from "#test/support/oracle/reference/values.ts"
import { checking, checkOptions } from "#test/support/policy.ts"
import { type LogicalFeature, logicalUnsound } from "#test/unit/analysis/logical/support.ts"
import { BagReference, propsOf, soundness, uniqueOn } from "#test/unit/analysis/physical/support.ts"
import {
	coreGrammar,
	descOf,
	extendedGrammar,
	type Grammar,
	type Plan,
	type PlanFeature,
	planOps,
	plansUpTo,
	printPlan
} from "#test/unit/analysis/small/plans.ts"

import {
	contextsOf,
	databases,
	type Installed,
	installed,
	parameterValues,
	seen,
	type Variant,
	variants
} from "#test/unit/analysis/small/universe.ts"

/**
 * The analyses' claims against the truth of a small closed universe, exhaustively.
 *
 * Every query of a grammar (plans.ts) of up to two operators (the scan counted as one) over the small universe, under every key and containment variant and every execution context it can be read in
 * (universe.ts), is checked by the checker, annotated by the logical analysis and analyzed by the physical analysis
 * exactly as a compiled template is, unplaced and with a DISTINCT placed on its root, and then evaluated by the
 * reference on every database of at most two facts per relation the context may see, under every binding of the
 * parameters it reads. The core grammar reads R and S; the extended one adds the closed relation C, the relation
 * parameter P, the recursive closure of R, casts and computed columns, sums and unions of different headings.
 *
 * Soundness: on every database, every claim holds on every relation a node denotes: logical keys and cardinality,
 * determinism, an attachment's delivered type and its child's claims per parent (logical/support.ts logicalUnsound);
 * physical keys, maximum cardinality, every node said to owe nothing and every discharged obligation, on the rows the
 * realized SQL delivers (physical/support.ts soundness).
 *
 * Precision: what the universe proves, the analysis claims, where a claim decides what the user gets.
 * - get eligibility: a root that has at most one row on every database is claimed atMostOne or one, so get reads it;
 * - delivered types: an attachment whose every parent receives at most one child delivers an Option, and one whose every
 *   parent receives exactly one delivers the bare child;
 * - elision: a root whose realized rows are a set on every database is proved unique, so no DISTINCT is placed on it;
 * - obligations: an obligation left outstanding, which places a DISTINCT, is one whose input repeats on its heading on
 *   some database.
 * Precision is owed only where the universe is faithful: no varied source read twice by the root (two facts per
 * relation then bound one side of a self-join only), no computed column the universe's two values collapse to one, no
 * union for get eligibility, nor, for any of the four, a negation: excluding one of the universe's two values leaves
 * one, where a third value shows a second row, a second child or a repeated row (precise states a witness of each);
 * and for the bare child a stored child relation the root does not read (reading it proves existence by itself, which
 * no containment states; C's declared facts cover the universe's values by accident). A root or a child no database
 * gives a row owes nothing.
 */

/** What the universe showed of one plan in one context, accumulated over every database it may see. */
interface Truth {
	/** The root's rows by the reference: never more than one, and some database gave one. */
	rootAtMostOne: boolean
	rootSeen: boolean
	/** Per attachment: every parent row received at most one child, at least one, and some parent row existed. */
	readonly children: Map<NodeId, { atMostOne: boolean; atLeastOne: boolean; parents: number }>
}

/**
 * What an outstanding obligation's input showed: it repeated on its heading on some database, or it held two rows or
 * more on some database and repeated on none. An input never seen with two rows shows nothing.
 */
type Witnessed = "repeats" | "unique"

/**
 * What the universe showed of one physical analysis: whether the root's realized rows were a set on every database,
 * and what each outstanding obligation's input showed.
 */
interface PhysicalTruth {
	readonly analysis: PhysicalAnalysis
	readonly placement: string
	rootSet: boolean
	readonly witnessed: Map<Obligation, Witnessed>
}

const attachmentsOf = (dag: RelDag): ReadonlyArray<NodeOf<"Attach">> =>
	Arr.filter(topoOrder(dag), (n): n is NodeOf<"Attach"> => n.kind === "Attach")

/** The children each parent row of an attachment receives, by the reference, as counts. */
const childCounts = (ref: Reference, a: NodeOf<"Attach">): ReadonlyArray<number> => {
	const parent = ref.eval(a.parent, noBindings)
	const child = ref.eval(a.child, noBindings)
	const at = (heading: typeof parent.heading, name: string): number =>
		Option.getOrThrowWith(
			Arr.findFirstIndex(heading, (h) => h.name === name),
			() => new Error("a column the case's own heading holds")
		)
	return Arr.map(
		parent.rows,
		(prow) =>
			Arr.filter(child.rows, (crow) =>
				Arr.every(a.correlation, (link) => {
					const p = at(parent.heading, link.parent)
					const c = at(child.heading, link.child)
					const type = parent.heading[p]?.type
					const pv = prow[p]
					const cv = crow[c]
					return type !== undefined && pv !== undefined && cv !== undefined && equal(pv, cv, type)
				})
			).length
	)
}

/** A physical analysis's placement: none, or a DISTINCT on the root. */
type Placement = "unplaced" | "root distinct"

/**
 * What a case of the universe reaches: the plan's operators, the logical evidence it checked, each claim the analyses
 * made and its reason, the placement and context it ran under, the databases a transaction may see, and each claim the
 * precision half judged.
 */
type ClaimFeature =
	| PlanFeature
	| LogicalFeature
	| `claimed ${Card | "nothing"}`
	| `reason ${MultiplicityReason}`
	| `loss ${MultiplicityReason}`
	| `placement ${Placement}`
	| `context ${TemplateContext}`
	| "a dangling reference seen in a transaction"
	| `precision: ${"get" | "elision" | "obligation" | "option" | "bare child"}`

/** The features the analyses' claims reached, by name. */
const claimFeatures = (
	dag: RelDag,
	root: RelNode,
	physical: PhysicalAnalysis
): ReadonlyArray<ClaimFeature> => {
	const out: Array<ClaimFeature> = [`claimed ${root.meta.card}`]
	for (const a of attachmentsOf(dag)) {
		out.push(`delivered ${a.delivered}`)
	}
	for (const node of physical.order) {
		const p = propsOf(physical, node)
		const strongest = strongestKey(p.keys)
		for (const reason of strongest === undefined ? [] : strongest.just.reasons) {
			out.push(`reason ${reason}`)
		}
		for (const loss of plainLosses(p)) {
			out.push(`loss ${loss.reason}`)
		}
	}
	return out
}

/**
 * The placements a plan's physical analysis runs under: none, and a DISTINCT on a root that selects or unions, which a
 * placement may put there.
 */
const placementsOf = (
	root: RelNode
): ReadonlyArray<readonly [Placement, PhysicalEnv["realization"]]> =>
	root.kind === "ProjectSet" || root.kind === "Union"
		? [
				["unplaced", unplaced],
				["root distinct", (id: NodeId) => (id === root.id ? "distinct" : undefined)]
			]
		: [["unplaced", unplaced]]

/** One plan under one installed variant, in every context it can be read in. */
const judge = (inst: Installed, plan: Plan, c: Case<ClaimFeature>): void => {
	const where = `${inst.variant.name}: ${printPlan(plan)}`
	const checked = checkQuery(checking(schemaDesc(inst.schema)), descOf(plan), checkOptions("query"))
	if (!checked.ok) {
		throw new Error(
			`the checker refuses a plan the space offers: ${checked.error.message}\n${where}`
		)
	}
	c.noteAll(planOps(plan))
	for (const context of contextsOf(inst.variant)) {
		const at = `${where} (${context})`
		const annotated = analyzeLogical(checked.value.dag, inst.logical(context))
		if (!annotated.ok) {
			throw new Error(`the logical analysis refuses: ${annotated.error.message}\n${at}`)
		}
		const dag = annotated.value.dag
		const root = dag.roots[0]
		const physicals = Arr.map(placementsOf(root), ([placement, realization]): PhysicalTruth => {
			const analyzed = analyzePhysical(dag, { ...inst.physical(context), realization })
			c.noteAll(claimFeatures(dag, root, analyzed))
			c.note(`placement ${placement}`)
			return { analysis: analyzed, placement, rootSet: true, witnessed: new Map() }
		})
		c.note(`context ${context}`)
		const truth: Truth = { rootAtMostOne: true, rootSeen: false, children: new Map() }
		for (const db of databases(inst.variant)) {
			if (!seen(db, context)) {
				continue
			}
			if (db.dangles) {
				c.note("a dangling reference seen in a transaction")
			}
			for (const params of parameterValues(plan.params)) {
				const input: ReferenceInput = {
					schema: inst.schema,
					facts: db.facts,
					params,
					observer: unobserved
				}
				/** The database and the parameters, printed only for a failure's report. */
				const facts = () =>
					`\nR: ${Formatter.format(db.facts["R"])} S: ${Formatter.format(db.facts["S"])} params: ${Formatter.format(params)}`
				for (const p of physicals) {
					const bag = BagReference.bag(dag, input, (node) => p.analysis.of(node).realization)
					const violations = soundness(p.analysis, bag)
					if (violations.length > 0) {
						throw new Error(
							`unsound physical claims (${p.placement}) ${Formatter.format(violations)}\n${at}${facts()}`
						)
					}
					const delivered = bag.eval(root, noBindings)
					if (
						!uniqueOn(
							delivered.heading,
							delivered.rows,
							Arr.map(delivered.heading, (h) => h.name)
						)
					) {
						p.rootSet = false
					}
					for (const o of p.analysis.obligations) {
						if (o.discharged || p.witnessed.get(o) === "repeats") {
							continue
						}
						const rels = bag.evaluations.of(o.edge.input)
						if (Arr.some(rels, (rel) => !uniqueOn(rel.heading, rel.rows, o.heading))) {
							p.witnessed.set(o, "repeats")
						} else if (Arr.some(rels, (rel) => rel.rows.length > 1)) {
							p.witnessed.set(o, "unique")
						}
					}
				}
				const claims = logicalUnsound(dag, input, c.note, inst.logical(context))
				if (claims.kind === "unsound") {
					throw new Error(`unsound logical claim: ${claims.why}\n${at}${facts()}`)
				}
				const ref = Reference.of(dag, input)
				const rows = ref.eval(root, noBindings).rows.length
				if (rows > 1) {
					truth.rootAtMostOne = false
				}
				if (rows > 0) {
					truth.rootSeen = true
				}
				for (const a of attachmentsOf(dag)) {
					const counts = childCounts(ref, a)
					const known = truth.children.get(a.id) ?? {
						atMostOne: true,
						atLeastOne: true,
						parents: 0
					}
					truth.children.set(a.id, {
						atMostOne: known.atMostOne && Arr.every(counts, (n) => n <= 1),
						atLeastOne: known.atLeastOne && Arr.every(counts, (n) => n >= 1),
						parents: known.parents + counts.length
					})
				}
			}
		}
		precise(plan, dag, root, physicals, truth, c, at)
	}
}

/** The precision half: what the universe proved, the claims state. */
const precise = (
	plan: Plan,
	dag: RelDag,
	root: RelNode,
	physicals: ReadonlyArray<PhysicalTruth>,
	truth: Truth,
	c: Case<ClaimFeature>,
	at: string
): void => {
	const faithful = new Set(plan.reads).size === plan.reads.length && !plan.collapsed
	/**
	 * A negated step needs more distinct values than the universe holds to show a second row or a second child:
	 * excluding one of its two values leaves one, so a negating plan's at most one row, or one child per parent, is the
	 * universe's (R(a) S(a): scan R → negate S on a → attach S on b over R=[(0,0)] and S=[(1,0),(2,0)] gives the parent
	 * two children, which two values never show), and so is its rows being a set, which elision and obligation
	 * precision read (scan S → negate R on a → project [] over R=[(0,0)] and S=[(0,0),(1,0),(2,0)] delivers two
	 * identical rows). Precision is unknowable there. Soundness is checked on every plan.
	 */
	const negating = Arr.some(plan.steps, (s) => s.op === "negate")
	const getOwed = faithful && !plan.union && !negating
	if (getOwed && truth.rootSeen && truth.rootAtMostOne) {
		c.note("precision: get")
		if (root.meta.card === "many") {
			throw new Error(`the root has at most one row on every database, and is claimed many\n${at}`)
		}
	}
	for (const p of physicals) {
		if (!faithful || negating) {
			continue
		}
		if (truth.rootSeen && p.rootSet) {
			c.note("precision: elision")
			if (!isUnique(propsOf(p.analysis, root))) {
				throw new Error(
					`the root's rows are a set on every database, and no uniqueness is proved (${p.placement})\n${at}`
				)
			}
		}
		for (const o of p.analysis.obligations) {
			if (o.discharged || p.witnessed.get(o) === undefined) {
				continue
			}
			c.note("precision: obligation")
			if (p.witnessed.get(o) === "unique") {
				throw new Error(
					`an obligation on ${o.edge.input.id} (${o.edge.consumer.kind === "node" ? o.edge.consumer.role : "result"}, ${o.edge.why}) over (${Arr.join(o.heading, ", ")}) is outstanding, and its input, two rows or more on some database, repeats on none (${p.placement})\n${at}`
				)
			}
		}
	}
	for (const a of attachmentsOf(dag)) {
		const shown = truth.children.get(a.id)
		if (!faithful || negating || shown === undefined || shown.parents === 0 || !shown.atMostOne) {
			continue
		}
		c.note("precision: option")
		if (a.delivered === "array") {
			throw new Error(
				`every parent of ${a.name} receives at most one child, and it delivers an array\n${at}`
			)
		}
		const stored = Option.flatMap(
			Arr.findFirst(plan.children, (child) => child.name === a.name),
			(child) =>
				child.source === "R" || child.source === "S" ? Option.some(child.source) : Option.none()
		)
		if (
			!shown.atLeastOne ||
			plan.union ||
			Option.isNone(stored) ||
			plan.reads.includes(stored.value)
		) {
			continue
		}
		c.note("precision: bare child")
		if (a.delivered !== "one") {
			throw new Error(
				`every parent of ${a.name} receives exactly one child, and it delivers ${a.delivered}\n${at}`
			)
		}
	}
}

/**
 * The features every exhaustion must reach: each claim the precision half judges, each evidence shape the universe
 * varies, and the inference rules the operators exercise.
 */
/** What the core grammar's population must reach in any context. */
const coreSnapshotRequired: Arr.NonEmptyReadonlyArray<ClaimFeature> = [
	"claimed atMostOne",
	"delivered option",
	"delivered one",
	"reason retainedPrimaryKey",
	"reason fixedKeyComponent",
	"reason groupedOutputKey",
	"reason disjointArms",
	"loss projectedKeyLoss",
	"placement root distinct",
	"reason exactDeduplication",
	"precision: get",
	"precision: elision",
	"precision: obligation",
	"precision: option",
	"precision: bare child"
]

/** What the core grammar's population must reach in a transaction context, which only evidence held at commit opens. */
const transactionRequired: Arr.NonEmptyReadonlyArray<ClaimFeature> = [
	"context transaction",
	"a dangling reference seen in a transaction"
]

const coreRequired: Situations<ClaimFeature> = Arr.appendAll(
	coreSnapshotRequired,
	transactionRequired
)

/** What the extended grammar adds: its sources, scans and operators, and the rules they turn on. */
const extendedAdded: Arr.NonEmptyReadonlyArray<ClaimFeature> = [
	"scan C",
	"scan P",
	"scan reach",
	"join C head",
	"join P witness",
	"negate P",
	"attach C",
	"compute widen",
	"compute halve",
	"sum",
	"hunion",
	"reason finiteFacts",
	"reason deduplicatedInput",
	"reason globalRecursiveClosure",
	"reason injectiveRepresentation",
	"loss noninjectiveExpression"
]

/**
 * Every plan of up to `operators` operators of a grammar under each of `among`, each variant installed once, before the
 * space is enumerated.
 */
const space = (
	grammar: Grammar,
	among: Arr.NonEmptyReadonlyArray<Variant>,
	operators: number
): Gen<readonly [Installed, Plan]> => {
	const installations = Arr.map(among, installed)
	const plans = plansUpTo(grammar, operators)
	return (source) => [source.draw(element(installations)), source.draw(plans)] as const
}

const exhaustUpTo = (
	ctx: TestContext,
	grammar: Grammar,
	among: Arr.NonEmptyReadonlyArray<Variant>,
	operators: number,
	limit: number,
	situations: Situations<ClaimFeature>
) =>
	searched(
		ctx,
		exhaust(
			{
				suite: `unit/analysis/small/claims-${grammar.name}-${among.length}-${operators}`,
				generator: space(grammar, among, operators),
				literal: ([inst, plan]) =>
					Formatter.format({ variant: inst.variant.name, scan: plan.scan, steps: plan.steps }),
				limit,
				coverage: requiredInSpace<ClaimFeature>(situations),
				caseHang: Duration.minutes(2)
			},
			([inst, plan], c) =>
				Effect.sync(() => {
					judge(inst, plan, c)
				})
		)
	)

const variantNamed = (name: string): Variant =>
	Option.getOrThrowWith(
		Arr.findFirst(variants, (x) => x.name === name),
		() => new Error(`no variant ${name}`)
	)

/**
 * The extended grammar reads two variants: single keys, and single keys with a containment held at every statement,
 * which a bare child needs.
 */
const extendedVariants: Arr.NonEmptyReadonlyArray<Variant> = [
	variantNamed("R(a) S(a)"),
	variantNamed("R(a) S(a), S.b ⊆ R.a")
]

/**
 * What the extended variants must reach: the core's and the extended grammar's own, but never a transaction context,
 * which only evidence held at commit opens and these variants cannot.
 */
const extendedRequired: Situations<ClaimFeature> = Arr.appendAll(
	coreSnapshotRequired,
	extendedAdded
)

describe("the analyses over a small closed universe", () => {
	it.effect(
		"every core query of up to two operators: sound on every database, precise where the universe proves",
		(ctx) => exhaustUpTo(ctx, coreGrammar, variants, 2, 1_000, coreRequired)
	)

	it.effect(
		"every extended query of up to two operators over single keys, with a containment and without",
		(ctx) => exhaustUpTo(ctx, extendedGrammar, extendedVariants, 2, 1_000, extendedRequired)
	)
})
