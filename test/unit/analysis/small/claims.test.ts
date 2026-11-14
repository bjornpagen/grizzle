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
 * and for the bare child a scanned child relation the root does not read (reading it proves existence by itself, which
 * no containment states; C's declared facts cover the universe's values by accident), or the root's ordinal, whose
 * group its own fact keeps nonempty. A root or a child no database gives a row owes nothing.
 *
 * The bare child is judged over every shape a rule proves it by: a containment of one field, of two fields into a
 * whole-heading key (correlated by both, an attachment by both fields), and of a selected source (the scan of S's facts
 * whose a is 1, where a scan of every fact of S owes an Option); and the root's ordinal, inclusive and with no further
 * conjunct, where a strict ordinal or one beside a conjunct owes an Option, so a claim of one there is unsound.
 *
 * Plants (~/.cache/grizzle-release/BR03/plants): filter-keeps-exactly-one (a filter over an input of exactly one row
 * claims exactly one) and closed-distinct-column-guessed (a closed relation's column of one repeated value claimed a
 * key), each unsound on some database of the universe; bare-child-source-selection-ignored (a bare child proved from a
 * containment whose source selection the parent's fact need not satisfy), unsound for the scan of every fact of S under
 * the selected containment; reflexive-filters-unread (a filter the root's own fact leaves unknown counts as
 * satisfied), unsound for an ordinal beside a conjunct; bare-child-one-field-containments (a containment of two fields
 * proves no child), imprecise for the attachment by both fields; selection-filter-ignored (a source selection satisfied
 * only by the scan's region, never by the filter above it, as the selected scan of S states it), imprecise for the bare
 * child of a selected source; shared-child-keys-widened (a child read twice claims
 * its whole heading as its key), inexact for every shared child.
 *
 * Shared children: each plan whose attachment scans a source is annotated again with that child read twice, as the
 * attachment's child and as a root of its own, and the child claims exactly the universe's minimal keys of its own
 * rows: the column sets of its heading no two of its rows agree on on any database, neither a sound superset nor the
 * attachment's relative evidence.
 *
 * Features: every claim checked, every precision situation each grammar must reach, and each elision reason
 * (ClaimFeature).
 */
import { describe, it } from "@effect/vitest"
import { type Case, exhaust } from "@grizzle/testing/explore"
import { requiredInSpace, type Situations } from "@grizzle/testing/features"
import { element, type Gen } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Order, String as Str } from "effect"
import type { TestContext } from "vitest"
import {
	analyzePhysical,
	type Obligation,
	type PhysicalAnalysis,
	type PhysicalEnv,
	unplaced
} from "#compiler/analysis/physical/analyze.ts"
import { keyedBy } from "#compiler/analysis/physical/props.ts"
import { checkQuery } from "#compiler/check/index.ts"
import type { NodeId } from "#compiler/core/ids.ts"
import type { ElisionReason } from "#compiler/ir/certificate.ts"
import { assembledDag, topoOrder } from "#compiler/ir/dag.ts"
import type { TemplateContext } from "#compiler/ir/evidence.ts"
import type { Card, NodeOf, RelDag, RelNode } from "#compiler/ir/rel.ts"
import { analyzeLogical } from "#compiler/logical/annotate.ts"
import {
	noBindings,
	type Bindings,
	Reference,
	type ReferenceInput,
	unobserved
} from "#test/support/oracle/reference/evaluate.ts"
import { equal } from "#test/support/oracle/reference/values.ts"
import { checking, checkOptions } from "#test/support/policy.ts"
import {
	claimedVariants,
	type LogicalFeature,
	logicalUnsound
} from "#test/unit/analysis/logical/support.ts"
import {
	FragmentReference,
	propsOf,
	soundness,
	uniqueOn
} from "#test/unit/analysis/physical/support.ts"
import {
	type Child,
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

import { unorderedEqual } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import {
	closedName,
	contextsOf,
	databases,
	type Installed,
	installed,
	parameterValues,
	seen,
	subsetsOf,
	type Variant,
	variants
} from "#test/unit/analysis/small/universe.ts"

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
/**
 * The children each parent row of an attachment receives, by the reference, as counts. A child that reads its parent's
 * columns, as an ordinal's comparison does, is evaluated once per parent row, under that row as its outer tuple; a
 * closed child is evaluated once, whatever the tuple.
 */
const childCounts = (ref: Reference, a: NodeOf<"Attach">): ReadonlyArray<number> => {
	const parent = ref.eval(a.parent, noBindings)
	const at = (heading: typeof parent.heading, name: string): number =>
		Option.getOrThrowWith(
			Arr.findFirstIndex(heading, (h) => h.name === name),
			() => new Error("a column the case's own heading holds")
		)
	return Arr.map(parent.rows, (prow) => {
		const outer: Bindings = new Map([
			[
				a.parent.id,
				{
					get: (name: string) =>
						Option.getOrUndefined(
							Option.flatMap(
								Arr.findFirstIndex(parent.heading, (h) => h.name === name),
								(column) => Option.fromNullishOr(prow[column])
							)
						),
					has: (name: string) => Arr.some(parent.heading, (h) => h.name === name)
				}
			]
		])
		const child = ref.eval(a.child, outer)
		return Arr.filter(child.rows, (crow) =>
			Arr.every(a.correlation, (link) => {
				const p = at(parent.heading, link.parent)
				const c = at(child.heading, link.child)
				const type = parent.heading[p]?.type
				const pv = prow[p]
				const cv = crow[c]
				return type !== undefined && pv !== undefined && cv !== undefined && equal(pv, cv, type)
			})
		).length
	})
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
	| `reason ${ElisionReason}`
	| "a plain form not unique"
	| `placement ${Placement}`
	| `context ${TemplateContext}`
	| "a dangling reference seen in a transaction"
	| `precision: ${"get" | "elision" | "obligation" | "option" | "bare child" | "bare ordinal"}`
	| "precision: bare child of two fields"
	| "precision: bare child of a selected source"
	| "a shared child"
	| "a shared child of several minimal keys"

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
		const strongest = keyedBy(p, p.columns)
		for (const reason of strongest === undefined ? [] : strongest.just.reasons) {
			out.push(`reason ${reason}`)
		}
		if (p.uniqueness.kind !== "plain") {
			out.push("a plain form not unique")
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

/** A column set of a shared child's heading, and whether no two of its rows have agreed on it on any database yet. */
interface Candidate {
	readonly columns: ReadonlyArray<string>
	holds: boolean
}

/** An attachment whose child the shared DAG reads twice, as the attachment's child and as a root of its own. */
interface SharedChild {
	readonly attach: NodeOf<"Attach">
	readonly candidates: ReadonlyArray<Candidate>
}

/** The plan's DAG with each scan child also a root, annotated, and its shared children. */
interface Sharing {
	readonly dag: RelDag
	readonly children: ReadonlyArray<SharedChild>
}

/**
 * The plan's checked DAG with the child of each attachment that scans a source also a root of its own, so the child is
 * read twice, as the old fixture's notes were (an attachment's child the result reads too), annotated in `context`: a
 * shared child, which keeps its own evidence, never the attachment's relative one. An ordinal's child reads its parent's
 * columns, so it is no root and is left alone. None where the plan attaches no scan.
 */
const sharingOf = (
	inst: Installed,
	plan: Plan,
	dag: RelDag,
	context: TemplateContext,
	at: string
): Option.Option<Sharing> => {
	const scans = Arr.filter(attachmentsOf(dag), (a) =>
		Arr.some(plan.children, (child) => child.kind === "scan" && child.name === a.name)
	)
	const [root] = dag.roots
	if (root === undefined || !Arr.isReadonlyArrayNonEmpty(scans)) {
		return Option.none()
	}
	const annotated = analyzeLogical(
		assembledDag([root, ...Arr.map(scans, (a) => a.child)]),
		inst.logical(context)
	)
	if (!annotated.ok) {
		throw new Error(
			`the logical analysis refuses the plan with its children shared: ${annotated.error.message}\n${at}`
		)
	}
	return Option.some({
		dag: annotated.value.dag,
		children: Arr.flatMap(attachmentsOf(annotated.value.dag), (attach) =>
			Arr.some(scans, (a) => a.id === attach.id)
				? [
						{
							attach,
							candidates: Arr.map(
								subsetsOf(Arr.map(attach.child.heading, (h) => h.name)),
								(columns): Candidate => ({ columns, holds: true })
							)
						}
					]
				: []
		)
	})
}

/** The minimal sets of `sets`, each sorted, each once: those no other set of them is a proper subset of. */
const minimalSets = (
	sets: ReadonlyArray<ReadonlyArray<string>>
): ReadonlyArray<ReadonlyArray<string>> =>
	Arr.dedupeWith(
		Arr.map(
			Arr.filter(
				sets,
				(k) => !Arr.some(sets, (o) => o.length < k.length && Arr.every(o, (c) => k.includes(c)))
			),
			(k) => Arr.sort(k, Order.String)
		),
		Arr.makeEquivalence(Str.Equivalence)
	)

/**
 * A shared child's claimed keys are exactly the universe's: the minimal column sets of its heading no two of its rows
 * agreed on on any database, its own rows read whole as a root reads them. A key widened past the minimal one, or one
 * the attachment's relative evidence states, is no claim of the child's own.
 */
const keysExact = (shared: SharedChild, c: Case<ClaimFeature>, at: string): void => {
	const truth = minimalSets(Arr.flatMap(shared.candidates, (k) => (k.holds ? [k.columns] : [])))
	const claimed = minimalSets(Arr.flatMap(shared.attach.child.meta.logicalKeys, claimedVariants))
	c.note("a shared child")
	if (truth.length > 1) {
		c.note("a shared child of several minimal keys")
	}
	unorderedEqual(
		claimed,
		truth,
		`the shared child of ${shared.attach.name} claims exactly the minimal keys the universe shows\n${at}`
	)
}

/** One plan under one installed variant, in every context it can be read in. */
const judge = (inst: Installed, plan: Plan, c: Case<ClaimFeature>): void => {
	const where = `${inst.variant.name}: ${printPlan(plan)}`
	const checked = checkQuery(checking(inst.desc), descOf(plan), checkOptions("query"))
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
		const sharing = sharingOf(inst, plan, checked.value.dag, context, at)
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
					const fragments = FragmentReference.delivered(
						dag,
						input,
						(node) => p.analysis.of(node).realization
					)
					const violations = soundness(p.analysis, fragments)
					if (violations.length > 0) {
						throw new Error(
							`unsound physical claims (${p.placement}) ${Formatter.format(violations)}\n${at}${facts()}`
						)
					}
					const delivered = fragments.eval(root, noBindings)
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
						const rels = fragments.evaluations.of(o.edge.input)
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
				for (const shared of Option.toArray(sharing)) {
					const reference = Reference.of(shared.dag, input)
					for (const child of shared.children) {
						const rows = reference.eval(child.attach.child, noBindings)
						for (const k of child.candidates) {
							if (k.holds && !uniqueOn(rows.heading, rows.rows, k.columns)) {
								k.holds = false
							}
						}
					}
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
					if (a.delivered !== "array" && Arr.some(counts, (n) => n > 1)) {
						throw new Error(
							`${a.name} delivers ${a.delivered} and a parent receives two children or more\n${at}${facts()}`
						)
					}
					if (a.delivered === "one" && Arr.some(counts, (n) => n === 0)) {
						throw new Error(`${a.name} delivers one and a parent receives none\n${at}${facts()}`)
					}
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
		precise(inst.variant, plan, dag, root, physicals, truth, c, at)
		for (const shared of Option.toArray(sharing)) {
			for (const child of shared.children) {
				keysExact(child, c, at)
			}
		}
	}
}

/** The precision half: what the universe proved, the claims state. */
const precise = (
	variant: Variant,
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
			if (propsOf(p.analysis, root).uniqueness.kind === "none") {
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
					`an obligation on ${o.edge.input.id} (${o.edge.consumer.kind === "node" ? `${o.edge.consumer.node.kind} ${o.edge.consumer.role}` : "result"}) over (${Arr.join(o.heading, ", ")}) is outstanding, and its input, two rows or more on some database, repeats on none (${p.placement})\n${at}`
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
		const child = Arr.findFirst(plan.children, (x) => x.name === a.name)
		if (!shown.atLeastOne || plan.union || Option.isNone(child) || !bareOwed(plan, child.value)) {
			continue
		}
		c.noteAll(bareFeatures(variant, child.value))
		if (a.delivered !== "one") {
			throw new Error(
				`every parent of ${a.name} receives exactly one child, and it delivers ${a.delivered}\n${at}`
			)
		}
	}
}

/**
 * Whether a child every parent receives exactly one of is owed the bare type: a scan of a stored relation the root does
 * not read, which only a containment proves exactly one of, or the root's ordinal, whose group the root's own fact
 * keeps nonempty. A scan of the closed relation, or of a relation the root reads, is exactly one by the universe's
 * values alone where no rule proves it (R(a) S(a): scan S, attach S by a gives each parent its own fact).
 */
const bareOwed = (plan: Plan, child: Child): boolean => {
	switch (child.kind) {
		case "scan":
			return child.source !== closedName && !plan.reads.includes(child.source)
		case "ordinal":
			return true
	}
}

/** What a bare child judged reached: its shape, and the containment that proves a scan of a selected source. */
const bareFeatures = (variant: Variant, child: Child): ReadonlyArray<ClaimFeature> => {
	switch (child.kind) {
		case "scan":
			return [
				"precision: bare child",
				...(child.links === 2 ? (["precision: bare child of two fields"] as const) : []),
				...(Arr.some(variant.containments, (k) => k.selected.length > 0)
					? (["precision: bare child of a selected source"] as const)
					: [])
			]
		case "ordinal":
			return ["precision: bare ordinal"]
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
	"a plain form not unique",
	"placement root distinct",
	"reason exactDeduplication",
	"precision: get",
	"precision: elision",
	"precision: obligation",
	"precision: option",
	"precision: bare child",
	"precision: bare ordinal",
	"a shared child",
	"ordinal strict",
	"ordinal beside a conjunct"
]

/** What the core grammar's population must reach in a transaction context, which only evidence held at commit opens. */
const transactionRequired: Arr.NonEmptyReadonlyArray<ClaimFeature> = [
	"context transaction",
	"a dangling reference seen in a transaction"
]

/**
 * What the core grammar's population must reach over the variants the extended one is not read under: a bare child
 * proved by a containment of two fields, and by one of a selected source.
 */
const coreVariantsRequired: Arr.NonEmptyReadonlyArray<ClaimFeature> = [
	"precision: bare child of two fields",
	"precision: bare child of a selected source",
	"a shared child of several minimal keys"
]

const coreRequired: Situations<ClaimFeature> = Arr.appendAll(
	Arr.appendAll(coreSnapshotRequired, transactionRequired),
	coreVariantsRequired
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
	"reason injectiveRepresentation"
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
	situations: Situations<ClaimFeature>
) => {
	const generator = space(grammar, among, operators)
	return searched(
		ctx,
		exhaust(
			{
				box: `every plan of up to ${operators} operators of the ${grammar.name} grammar under ${among.length} key and containment variants, on every database of at most two facts per relation its context may see, under every binding of its parameters`,
				oracle: {
					kind: "second-implementation",
					name: "the reference evaluator on every database of the small universe"
				},
				suite: `unit/analysis/small/claims-${grammar.name}-${among.length}-${operators}`,
				generator,
				literal: ([inst, plan]) =>
					Formatter.format({ variant: inst.variant.name, scan: plan.scan, steps: plan.steps }),
				coverage: requiredInSpace<ClaimFeature>(situations),
				caseHang,
				concurrency: 1
			},
			([inst, plan], c) =>
				Effect.sync(() => {
					judge(inst, plan, c)
				})
		)
	)
}

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
		(ctx) => exhaustUpTo(ctx, coreGrammar, variants, 2, coreRequired)
	)

	it.effect(
		"every extended query of up to two operators over single keys, with a containment and without",
		(ctx) => exhaustUpTo(ctx, extendedGrammar, extendedVariants, 2, extendedRequired)
	)
})
