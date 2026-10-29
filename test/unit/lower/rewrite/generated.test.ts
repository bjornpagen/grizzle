import { describe, it } from "@effect/vitest"
import { type Case, drawn, explore, type Kept } from "@grizzle/testing/explore"
import { features } from "@grizzle/testing/features"
import { element, type Gen } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Duration, Effect, Formatter } from "effect"
import type { NodeId } from "#compiler/core/ids.ts"
import type { CertificateRule } from "#compiler/ir/certificate.ts"
import { nodesByLabel, topoOrder } from "#compiler/ir/dag.ts"
import type { Pass } from "#compiler/ir/pass.ts"
import type { LogicalQuery } from "#compiler/ir/products.ts"
import type { RelDag, RelKind } from "#compiler/ir/rel.ts"
import {
	relationalRewrites,
	semanticSimplification
} from "#compiler/lower/optimize/demand/phases.ts"
import { eliminatePass } from "#compiler/lower/optimize/eliminate/index.ts"
import { existencePass } from "#compiler/lower/optimize/existence/index.ts"
import { finitePass } from "#compiler/lower/optimize/finite/index.ts"
import { fusePass } from "#compiler/lower/optimize/fuse/index.ts"
import { lateFetchPass } from "#compiler/lower/optimize/late-fetch/index.ts"
import { prunePass } from "#compiler/lower/optimize/prune/index.ts"
import { pushdownPass } from "#compiler/lower/optimize/pushdown/index.ts"
import { simplifyPass } from "#compiler/lower/optimize/simplify/index.ts"
import { succeeded } from "#test/support/assert.ts"
import { genCatalog } from "#test/support/evidence.ts"
import {
	defaultGenConfig,
	fullCaseSwarms,
	type GenConfig,
	type QueryCase,
	type QueryCaseSketch,
	queryCaseSketchGen,
	resolveQueryCase,
	rewriteGenConfig
} from "#test/support/oracle/gen/case.ts"
import { spellingChoiceCount } from "#test/support/oracle/gen/domain.ts"
import { type QuerySketch, undrawn } from "#test/support/oracle/gen/query.ts"
import {
	existsOverTakeRoot,
	fanoutJoinRoot,
	groupRoot,
	keyedJoinRoot,
	projectGroupRoot,
	projectRoot,
	rootedCaseGen,
	taggedUnionRoot,
	untaggedUnionRoot,
	witnessRoot
} from "#test/support/oracle/mutants/cases.ts"
import { indices } from "#test/support/oracle/pick.ts"
import {
	type RewriteAgreement,
	agrees,
	caseQuery,
	passContext,
	lowerConservatively,
	runPasses
} from "#test/unit/lower/rewrite/support.ts"
import { wideCaseGen } from "#test/unit/lower/rewrite/wide.ts"

/**
 * Every rewrite pass, alone and composed, preserves what the query delivers over generated cases: the rewritten DAG
 * validates, lowers conservatively with every statement passing the structural audit, and the reference evaluator
 * computes the same statements, headings and row sets for it as for the original.
 *
 * The cases are the optimizer's population for the rewrite passes (gen/case.ts rewriteGenConfig), without vectors and
 * with filters drawn directly over groups, unions and set comparisons, whose schemas declare
 * containments as native foreign keys that their facts satisfy (gen/schema.ts) and whose queries read through them, so
 * R03 runs against the immediate foreign keys a generated installation has; its wide payload under takes with stated
 * orders lets R06 late fetch fire on generated cases, and the hand-built wide-payload cases (wide.ts) hold it to the
 * transaction context too. No pass and no lowering refuses a generated case: a refusal fails it.
 *
 * The population is steered: while a required feature is unreached, a case that reached a feature or pair no earlier
 * case reached is kept, and later cases mutate kept ones. The features are semantic: each rule fired, each rule paired
 * with the kind of node it rewrote, and each kind of node the query holds. The rule families the population must reach
 * are the composed pipeline's required features; those it reaches only a few times a run are planted, as kept cases of
 * the same population.
 */

/**
 * The optimizer's population for the rewrite passes: wide payload of unbounded text alone (the reference evaluator
 * computes no vector), and filters drawn directly over the stages the pushdown rules move a filter into.
 */
const population: GenConfig = rewriteGenConfig

type Passes = ReadonlyArray<Pass<LogicalQuery, LogicalQuery>>

const fullPipeline: Passes = [semanticSimplification, relationalRewrites]

/**
 * The rule families the composed pipeline must keep firing on the population, every one but late fetch, which the
 * wide-payload cases must fire, and those the population fires a few times a run, which kept cases plant (keptRules).
 */
const pipelineRules = [
	"R01.fusion",
	"R02.semiJoin",
	"R02.antiJoin",
	"prune.heading",
	"pushdown.left",
	"pushdown.project",
	"pushdown.semiGroup",
	"pushdown.semiSource",
	"pushdown.source",
	"pushdown.union",
	"simplify.fold",
	"simplify.empty",
	"simplify.identityProjection",
	"simplify.mergeFilters"
] as const satisfies ReadonlyArray<CertificateRule>

/**
 * What a case of the rewrite suites reaches: each kind of node its query holds, each rule a pass fired (alone, and
 * paired with the kind of node it rewrote), and whether the reference judged it.
 */
type RewriteFeature = `node ${RelKind}` | CertificateRule | `reference ${RewriteAgreement}`

/**
 * The kind of the first of `ids` some DAG defines: the node a certificate's rule met, looked up in the query before the
 * passes and after them, since a pass may replace the node it rewrote.
 */
const kindOf = (dags: ReadonlyArray<RelDag>, ids: ReadonlyArray<NodeId>): RelKind | undefined => {
	const labels = Arr.map(dags, (dag) => nodesByLabel(dag))
	for (const id of ids) {
		for (const byLabel of labels) {
			const node = byLabel.get(id)
			if (node !== undefined) {
				return node.kind
			}
		}
	}
	return undefined
}

/**
 * Runs `passes` over one case and holds them to the contract, noting the case's features: the passes and the
 * conservative lowering of their result never refuse, and the rewrite preserves the delivery.
 */
const preserves = (
	q: QueryCase,
	passes: Passes,
	evidence: "snapshot" | "transaction",
	c: Case<RewriteFeature>
): void => {
	const query = caseQuery(q)
	for (const node of topoOrder(query.dag)) {
		c.note(`node ${node.kind}`)
	}
	const ran = succeeded(
		runPasses(query, passes, passContext({ catalog: genCatalog(q.schema), evidence }))
	)
	for (const certificate of ran.certificates) {
		c.note(certificate.rule)
		const kind = kindOf([query.dag, ran.query.dag], certificate.inputs)
		if (kind !== undefined) {
			c.pair(certificate.rule, `node ${kind}`)
		}
	}
	c.note(`reference ${agrees(q, ran.query)}`)
	succeeded(lowerConservatively(ran.query))
}

/** A case of the population, drawn as its sketch, which a failure prints and a kept case states. */
const sketchGen: Gen<QueryCaseSketch> = queryCaseSketchGen(population)

/** A search's budget: its rotating stream's cases, and the features it must reach. */
interface Budget {
	readonly runs: number
	readonly required: ReadonlyArray<RewriteFeature>
}

/**
 * Explores the population through `passes`, each sketch resolved in the property, steered toward `required` for up to
 * as many cases again.
 */
const exploreSteered = (
	suite: string,
	passes: Passes,
	evidence: "snapshot" | "transaction",
	budget: Budget,
	kept: ReadonlyArray<Kept<QueryCaseSketch, RewriteFeature>>
) =>
	explore(
		{
			suite,
			draw: drawn(sketchGen),
			literal: Formatter.format,
			features: features<RewriteFeature>(budget.required),
			kept,
			runs: budget.runs,
			shrink: completeShrink,
			concurrency: 1,
			steerEvery: 16,
			steering: { kind: "mutate", cases: budget.runs, sense: notesOnly },
			caseHang: Duration.minutes(2)
		},
		(sketch, c) =>
			Effect.sync(() => {
				preserves(c.draw(resolveQueryCase(sketch, population)), passes, evidence, c)
			})
	)

/** Explores ready-made cases through `passes`. */
const exploreCases = (
	suite: string,
	cases: Gen<QueryCase>,
	passes: Passes,
	evidence: "snapshot" | "transaction",
	budget: Budget
) =>
	explore(
		{
			suite,
			draw: drawn(cases),
			literal: Formatter.format,
			features: features<RewriteFeature>(budget.required),
			kept: [],
			runs: budget.runs,
			shrink: completeShrink,
			concurrency: 1,
			steerEvery: 16,
			steering: { kind: "none" },
			caseHang: Duration.minutes(2)
		},
		(q, c) =>
			Effect.sync(() => {
				preserves(q, passes, evidence, c)
			})
	)

const column = (pick: number) => ({ literal: false, pick, value: { cls: 0, sp: 0 }, term: undrawn })

/** A fact of `width` values, the classes from `cls` up. */
const fact = (cls: number, width: number) => ({
	values: Arr.map(indices(width), (i) => ({ cls: cls + i, sp: 0 })),
	target: 0
})

const relation = (
	columns: ReadonlyArray<number>,
	contained: boolean
): QueryCaseSketch["schema"]["relations"][number] => ({
	columns,
	pkMask: 0,
	pure: false,
	keyMasks: [],
	mutable: false,
	fk: { enabled: contained, target: 0, typed: true },
	spanKey: false
})

const bind = (mode: number) => ({ mode, pick: 0, value: { cls: 0, sp: 0 } })

/**
 * Planted: the rules the composed pipeline's search fires a few times a run (simplify.equality 3 to 23 times on four
 * seeds). Each is a smallest sketch of the population that fires it, over
 * R0 of one or two integer columns holding three facts (finite membership: of the roster's enum, holding both
 * handles):
 * - finite membership: the roster's occurrence matched with R0 on one variable, the roster first;
 * - a filter equating R0's two variables (simplify.equality);
 * - a projection of R0's (b, a) to its first column (simplify.mergeProjections);
 * - R1 matched through its containment into R0, which the foreign key makes redundant (R03.elimination);
 * - a filter on the key of a group of R0 by a (pushdown.group);
 * - a semi-join against R0 on the key of a region reading a group of R0 by a, the platform's nearCap shape
 *   (pushdown.semiSource onto the group's occurrence, then pushdown.semiGroup below the group), which the population's
 *   semiOver form reaches too.
 */
const keptRules: ReadonlyArray<Kept<QueryCaseSketch, RewriteFeature>> = (() => {
	type Sketch = QueryCaseSketch["schema"]
	const facts = (width: number) => [fact(0, width), fact(1, width), fact(2, width)]
	const read = (width: number): QuerySketch => ({
		tag: "match",
		occurrences: [
			{
				source: { tag: "relation", pick: 0 },
				columns: Array.from({ length: width }, () => bind(0))
			}
		],
		equalities: [],
		lateral: { kind: "none" }
	})
	const planted = (
		rules: readonly [CertificateRule, ...ReadonlyArray<CertificateRule>],
		note: string,
		schema: Sketch,
		rows: QueryCaseSketch["facts"],
		body: QuerySketch
	): Kept<QueryCaseSketch, RewriteFeature> => ({
		note,
		sketch: {
			schema,
			facts: rows,
			spelling: Array.from({ length: spellingChoiceCount }, () => 0),
			root: { tag: "plain", body, order: undrawn },
			paramNames: [],
			...fullCaseSwarms
		},
		draws: "",
		reaches: rules
	})
	const pair: Sketch = { palette: [0], closed: [], relations: [relation([0, 0], false)] }
	/** A group of R0 by its first column, counting. */
	const grouped: QuerySketch = {
		tag: "group",
		input: read(2),
		full: false,
		boundMask: 1,
		keyMask: 1,
		aggs: [{ fn: 0, column: 1 }]
	}
	return [
		planted(
			["R07.finiteMembership"],
			"a roster occurrence joined to a relation on its handle",
			{ palette: [0], closed: [{ handles: 2, payload: [] }], relations: [relation([1], false)] },
			[[fact(0, 1), fact(1, 1)]],
			{
				tag: "match",
				occurrences: [
					{ source: { tag: "closed", pick: 0 }, columns: [bind(0)] },
					{ source: { tag: "relation", pick: 0 }, columns: [bind(5)] }
				],
				equalities: [],
				lateral: { kind: "none" }
			}
		),
		planted(["simplify.equality"], "a filter equating two variables", pair, [facts(2)], {
			tag: "filter",
			input: read(2),
			pred: { tag: "equate", left: 0, right: 1 }
		}),
		planted(["simplify.mergeProjections"], "a projection of a projection", pair, [facts(2)], {
			tag: "project",
			input: { tag: "project", input: read(2), out: [column(1), column(0)] },
			out: [column(0)]
		}),
		planted(
			["R03.elimination"],
			"a match through a containment its foreign key makes redundant",
			{ palette: [0], closed: [], relations: [relation([0], false), relation([0], true)] },
			[[fact(0, 1), fact(1, 1)], [fact(0, 1)]],
			{
				tag: "match",
				occurrences: [
					{ source: { tag: "relation", pick: 1 }, columns: [bind(0)] },
					{ source: { tag: "follow", pick: 0 }, columns: [bind(0)] }
				],
				equalities: [],
				lateral: { kind: "none" }
			}
		),
		planted(["pushdown.group"], "a filter on a group's key", pair, [facts(2)], {
			tag: "filter",
			input: grouped,
			pred: { tag: "compare", column: 0, op: 0, rhs: { tag: "literal", value: { cls: 0, sp: 0 } } }
		}),
		planted(
			["pushdown.semiSource", "pushdown.semiGroup"],
			"a semi-join on the key of a region reading a group",
			pair,
			[facts(2)],
			{
				tag: "semi",
				left: {
					tag: "match",
					occurrences: [{ source: { tag: "query", query: grouped }, columns: [bind(0), bind(0)] }],
					equalities: [],
					lateral: { kind: "none" }
				},
				right: read(2),
				on: [0],
				shared: undrawn
			}
		)
	]
})()

/** The passes judged alone, by name. */
const singlePasses = {
	simplify: [simplifyPass],
	fuse: [fusePass],
	prune: [prunePass],
	eliminate: [prunePass, eliminatePass],
	existence: [prunePass, existencePass],
	pushdown: [pushdownPass],
	finite: [finitePass],
	lateFetch: [lateFetchPass]
} as const satisfies Readonly<Record<string, Passes>>

type PassName = keyof typeof singlePasses

const passNames: Arr.NonEmptyReadonlyArray<PassName> = [
	"simplify",
	"fuse",
	"prune",
	"eliminate",
	"existence",
	"pushdown",
	"finite",
	"lateFetch"
]

/** What a case of the single-pass suite reaches: the pass it ran, and what the pass reached on it. */
type SinglePassFeature = `pass ${PassName}` | RewriteFeature

describe("each rewrite pass preserves the delivered result on generated cases", () => {
	it.effect("every pass alone, on cases of the population", (ctx) =>
		searched(
			ctx,
			explore(
				{
					suite: "unit/lower/rewrite/pass-alone",
					draw: drawn((source) => ({
						pass: source.draw(element(passNames)),
						sketch: source.draw(sketchGen)
					})),
					literal: Formatter.format,
					features: features<SinglePassFeature>(
						Arr.map(passNames, (name): SinglePassFeature => `pass ${name}`)
					),
					kept: [],
					runs: 150 * passNames.length,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					steering: { kind: "none" },
					caseHang: Duration.minutes(2)
				},
				({ pass, sketch }, c) =>
					Effect.sync(() => {
						c.note(`pass ${pass}`)
						preserves(
							c.draw(resolveQueryCase(sketch, population)),
							singlePasses[pass],
							"snapshot",
							c
						)
					})
			)
		)
	)

	it.effect("lateFetch over wide payload, where it fires", (ctx) =>
		Effect.andThen(
			searched(
				ctx,
				exploreCases(
					"unit/lower/rewrite/late-fetch-wide",
					wideCaseGen,
					[lateFetchPass],
					"snapshot",
					{
						runs: 200,
						required: ["R06.lateFetch"]
					}
				)
			),
			searched(
				ctx,
				exploreCases(
					"unit/lower/rewrite/pipeline-wide-transaction",
					wideCaseGen,
					fullPipeline,
					"transaction",
					{ runs: 100, required: [] }
				)
			)
		)
	)
})

describe("the composed rewrite phases preserve the delivered result", () => {
	it.effect(
		"demand, semantic simplification and relational rewrites in a snapshot read, firing every rule family",
		(ctx) =>
			Effect.andThen(
				searched(
					ctx,
					exploreSteered(
						"unit/lower/rewrite/pipeline-snapshot",
						fullPipeline,
						"snapshot",
						{ runs: 400, required: pipelineRules },
						[]
					)
				),
				searched(
					ctx,
					exploreSteered(
						"unit/lower/rewrite/pipeline-snapshot-planted",
						fullPipeline,
						"snapshot",
						{ runs: 20, required: [] },
						keptRules
					)
				)
			)
	)

	it.effect("the same in a transaction, where only immediate evidence holds", (ctx) =>
		searched(
			ctx,
			exploreSteered(
				"unit/lower/rewrite/pipeline-transaction",
				fullPipeline,
				"transaction",
				{ runs: 200, required: [] },
				[]
			)
		)
	)
})

describe("the mutant suite's counterexample shapes", () => {
	const roots = [
		["projections that drop keys", projectRoot],
		["keyed joins", keyedJoinRoot],
		["fanout joins", fanoutJoinRoot],
		["existential witnesses", witnessRoot],
		["groups", groupRoot],
		["projections before a fold", projectGroupRoot],
		["tagged unions", taggedUnionRoot],
		["untagged unions", untaggedUnionRoot],
		["bounds under EXISTS", existsOverTakeRoot]
	] as const
	for (const [i, [name, root]] of roots.entries()) {
		it.effect(name, (ctx) =>
			searched(
				ctx,
				exploreCases(
					`unit/lower/rewrite/root-${i}`,
					rootedCaseGen(root, defaultGenConfig),
					fullPipeline,
					"snapshot",
					{ runs: 120, required: [] }
				)
			)
		)
	}
})
