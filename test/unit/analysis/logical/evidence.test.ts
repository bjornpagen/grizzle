import { describe, it } from "@effect/vitest"
import { drawn, explore, type Kept } from "@grizzle/testing/explore"
import { required, type Situations } from "@grizzle/testing/features"
import { array, boolean, constant, element, type Gen, map } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Duration, Effect, Formatter, Option, Record as Rec } from "effect"
import type { TestContext } from "vitest"
import { makeIdSupply } from "#compiler/core/ids.ts"
import { DagBuilder } from "#compiler/ir/builder.ts"
import { toTable } from "#compiler/ir/dag.ts"
import type { EvidenceContext, TemplateContext } from "#compiler/ir/evidence.ts"
import type { ScalarExpr } from "#compiler/ir/expr.ts"
import {
	conservativeMeta,
	type Heading,
	type HeadingColumn,
	type RelNode,
	type VarDecl
} from "#compiler/ir/rel.ts"
import { typeLabel } from "#compiler/ir/scalar.ts"
import { analyzeLogical, type LogicalEnv } from "#compiler/logical/annotate.ts"
import type { ContainmentFact } from "#compiler/logical/attach.ts"
import { assert, defined } from "#test/support/assert.ts"
import { validateDag } from "#test/support/oracle/dag-validate.ts"
import {
	defaultGenConfig,
	type GenConfig,
	type QueryCase,
	type QueryCaseSketch,
	queryCaseGen,
	queryCaseSketchGen,
	resolveQueryCase,
	soundnessGenConfig
} from "#test/support/oracle/gen/case.ts"
import { bool } from "#test/support/oracle/gen/domain.ts"
import { compareOpId, notOp } from "#test/support/oracle/gen/ops.ts"
import { printQueryCase } from "#test/support/oracle/gen/print.ts"
import { undrawn } from "#test/support/oracle/gen/query.ts"
import {
	closedHeading,
	type GenRelation,
	relationHeading,
	relationNamed
} from "#test/support/oracle/gen/schema.ts"
import { nonEmptyList } from "#test/support/oracle/pick.ts"
import { unobserved } from "#test/support/oracle/reference/evaluate.ts"
import { pickFrom, pickGen } from "#test/support/pick.ts"
import {
	kernelRefusesCorruptions,
	type LogicalFeature,
	logicalUnsound
} from "#test/unit/analysis/logical/support.ts"

/**
 * The logical analysis's claims hold on the facts.
 *
 * Every generated query is annotated with its schema's declared keys and containments, under a drawn execution context
 * and drawn containment contexts, and evaluated by the reference evaluator, every evaluation recorded: a correlated
 * node once per outer tuple it was evaluated under. On every relation a node denoted, its claimed cardinality bounds its
 * rows (at most one row unless `many`, exactly one when `one`) and no two rows agree on a claimed logical key; and for
 * every attachment, the children each parent row receives
 * respect the child's claims relative to the parent and the delivered type: at most one for an Option, exactly one for
 * a bare child. A read inside a transaction may see facts that break a containment only checked at commit, so there
 * the cases drop a target relation's facts and leave its sources orphaned: evidence the context does not admit must
 * prove nothing. An unsound claim here would let get, an Option attachment or a dropped DISTINCT change an answer.
 */

const runs = 1500

const both = [false, true] as const

/**
 * Shapes the generated queries do not reach, over a generated case's schema and facts: along each declared
 * containment, the target relation's plain scan attached by its key to a parent that reads the source's fields from one
 * fact of it, the attachment the containment proof types bare, or from one fact of another relation with fields of the
 * same names and types, which the containment says nothing about; and a filter directly over each closed relation,
 * which may drop the one fact it has. Each pick chooses among a shape's variants; the case's own query is replaced,
 * and kept when its schema offers neither shape.
 */
const provingCase = (c: QueryCase, picks: ReadonlyArray<number>): QueryCase => {
	const b = new DagBuilder(makeIdSupply())
	const pick = (i: number) => picks[i % picks.length] ?? 0
	const column = (node: RelNode, h: HeadingColumn): ScalarExpr =>
		b.expr({
			kind: "column",
			column: { node: node.id, name: h.name },
			args: [],
			type: h.type,
			nonNull: "storage"
		})
	/** A plain scan: one occurrence binding every column, every column kept or projected onto the named ones. */
	type Kept =
		| { readonly kind: "every column" }
		| { readonly kind: "only"; readonly columns: ReadonlyArray<string> }
	const scan = (relation: GenRelation, keep: Kept): RelNode => {
		const heading = relationHeading(relation)
		const base = b.node({
			kind: "Base",
			relation: relation.name,
			occurrence: b.ids.occurrence(),
			primaryKey: nonEmptyList(relation.primaryKey, "a primary key"),
			keys: Arr.map(relation.keys, (k) => nonEmptyList(k, "a candidate key")),
			relationKind: "relation",
			heading,
			loc: undefined,
			meta: conservativeMeta
		})
		const vars = Arr.map(heading, (h): VarDecl => ({ id: b.ids.var(), name: h.name, type: h.type }))
		const regionHeading: Heading = Arr.map(vars, (v) => ({ name: v.name, type: v.type }))
		const region = b.node({
			kind: "MatchRegion",
			scope: b.ids.scope(),
			vars,
			occurrences: [
				{
					id: b.ids.occurrence(),
					source: base,
					bindings: Arr.map(vars, (v) => ({ column: v.name, var: v })),
					constants: []
				}
			],
			equalities: [],
			correlated: [],
			heading: regionHeading,
			loc: undefined,
			meta: conservativeMeta
		})
		if (keep.kind === "every column") {
			return region
		}
		const out = Arr.filter(regionHeading, (h) => keep.columns.includes(h.name))
		return b.node({
			kind: "ProjectSet",
			input: region,
			out: Arr.map(out, (h) => ({ name: h.name, expr: column(region, h) })),
			heading: Arr.map(out, (h) => ({ name: h.name, type: h.type })),
			loc: undefined,
			meta: conservativeMeta
		})
	}
	const roots: Array<RelNode> = []
	/** Another relation holding the source's fields under their names and types, which no containment may cover. */
	const lookalike = (k: (typeof c.schema.containments)[number]): Option.Option<GenRelation> => {
		const from = relationNamed(c.schema, k.from.relation)
		const typeOf = (r: GenRelation, f: string) =>
			Option.map(
				Arr.findFirst(r.columns, (col) => col.name === f),
				(col) => col.type
			)
		return Arr.findFirst(
			c.schema.relations,
			(r) =>
				r.name !== from.name &&
				Arr.every(k.from.fields, (f) =>
					Option.exists(
						Option.all([typeOf(r, f), typeOf(from, f)]),
						([mine, theirs]) => typeLabel(mine) === typeLabel(theirs)
					)
				)
		)
	}
	for (const [i, k] of c.schema.containments.entries()) {
		const declared = relationNamed(c.schema, k.from.relation)
		const variant = {
			lookalike: pickFrom([false, false, false, true], pick(3 * i)),
			projectParent: pickFrom(both, pick(3 * i + 1)),
			projectChild: pickFrom(both, pick(3 * i + 2))
		}
		const from = variant.lookalike ? Option.getOrElse(lookalike(k), () => declared) : declared
		const to = relationNamed(c.schema, k.to.relation)
		const every = { kind: "every column" } as const
		const parent = scan(
			from,
			variant.projectParent ? { kind: "only", columns: k.from.fields } : every
		)
		const child = scan(
			to,
			variant.projectChild
				? { kind: "only", columns: Arr.map(to.columns, (col) => col.name) }
				: every
		)
		roots.push(
			b.node({
				kind: "Attach",
				parent,
				child,
				name: `contained${i}`,
				correlation: Arr.map(k.from.fields, (f, j) => ({
					parent: f,
					child: defined(k.to.fields[j])
				})),
				delivered: "array",
				heading: parent.heading,
				order: undefined,
				loc: undefined,
				meta: conservativeMeta
			})
		)
	}
	const offset = 3 * c.schema.containments.length
	for (const [i, closed] of c.schema.closed.entries()) {
		const [firstRow, ...restRows] = closed.rows
		if (firstRow === undefined) {
			continue
		}
		const heading = closedHeading(closed)
		const facts = b.node({
			kind: "Closed",
			closed: closed.name,
			rows: closed.rows,
			heading,
			loc: undefined,
			meta: conservativeMeta
		})
		const id = defined(heading[0], "the closed relation's id column")
		const handle = defined(pickFrom([firstRow, ...restRows], pick(offset + 3 * i))[0], "a handle")
		const other = pickFrom(both, pick(offset + 3 * i + 1))
			? column(facts, id)
			: b.expr({
					kind: "literal",
					value: handle,
					args: [],
					type: id.type,
					nonNull: "literal"
				})
		const eq = b.expr({
			kind: "op",
			op: compareOpId(id.type, "eq"),
			args: [column(facts, id), other],
			type: bool,
			nonNull: "strict",
			volatility: "immutable"
		})
		const pred = pickFrom(both, pick(offset + 3 * i + 2))
			? b.expr({
					kind: "op",
					op: notOp,
					args: [eq],
					type: bool,
					nonNull: "strict",
					volatility: "immutable"
				})
			: eq
		roots.push(
			b.node({
				kind: "Filter",
				input: facts,
				pred,
				heading,
				loc: undefined,
				meta: conservativeMeta
			})
		)
	}
	if (!Arr.isArrayNonEmpty(roots)) {
		return c
	}
	return { ...c, query: { dag: validateDag(b.build(roots)), params: {} } }
}

/**
 * A case under its contexts: the execution context the analysis proves for, each containment's validity context, and,
 * inside a transaction, which containments the in-transaction facts break by losing their target's facts.
 */
interface Contexted {
	readonly c: QueryCase
	readonly execution: TemplateContext
	readonly containments: ReadonlyArray<ContainmentFact>
	readonly orphaned: ReadonlyArray<string>
}

interface ContextSketch {
	readonly transaction: boolean
	/** Per containment: its context and, where the transaction admits breaking it, whether its target loses its facts. */
	readonly containments: ReadonlyArray<{
		readonly context: EvidenceContext
		readonly orphan: boolean
	}>
}

const containmentContexts: readonly [EvidenceContext, EvidenceContext] = [
	"immediate",
	"committedSnapshot"
]

const contextSketchGen: Gen<ContextSketch> = (source) => ({
	transaction: source.draw(boolean),
	containments: source.draw(
		array(
			(containment) => ({
				context: containment.draw(element(containmentContexts)),
				orphan: containment.draw(boolean)
			}),
			{ min: 0, max: 4 }
		)
	)
})

/**
 * The containments a generated schema declares, each a native foreign key, immediate or checked at commit; inside a
 * transaction, the facts may break one checked at commit, whose target then holds none of its facts.
 */
const contexted = (c: QueryCase, s: ContextSketch): Contexted => {
	const execution: TemplateContext = s.transaction ? "transaction" : "snapshot"
	const placed = Arr.map(c.schema.containments, (k, i) => {
		const sketch = s.containments[i]
		const context = sketch === undefined ? "immediate" : sketch.context
		return {
			k,
			context,
			orphan: execution === "transaction" && context !== "immediate" && sketch?.orphan === true
		}
	})
	/**
	 * A target loses its facts only when no immediate containment reads it, since an immediate one holds at every
	 * statement.
	 */
	const kept = new Set(
		Arr.map(
			Arr.filter(placed, (d) => d.context === "immediate"),
			(d) => d.k.to.relation
		)
	)
	const orphaned = [
		...new Set(
			Arr.map(
				Arr.filter(placed, (d) => d.orphan && !kept.has(d.k.to.relation)),
				(d) => d.k.to.relation
			)
		)
	]
	const facts = {
		...c.facts,
		...Rec.fromEntries(Arr.map(orphaned, (relation) => [relation, []] as const))
	}
	return {
		c: { ...c, facts },
		execution,
		containments: Arr.map(placed, ({ k, context }) => ({
			from: { relation: k.from.relation, fields: k.from.fields, selection: [] },
			to: { relation: k.to.relation, fields: k.to.fields, selection: [] },
			coverage: false,
			statement: "contained",
			context
		})),
		orphaned
	}
}

/**
 * What a case of this suite reaches: the logical claims the evaluation checked, the execution context, each
 * containment's context, and an orphaned containment.
 */
type EvidenceFeature =
	| LogicalFeature
	| `execution ${TemplateContext}`
	| `${EvidenceContext} containment`
	| "an orphaned containment inside a transaction"

/**
 * What a suite draws: a sketch and the contexts drawn for it, and how the property resolves the sketch to its case,
 * drawing the swarms' thinning decisions from the case's tape. A failure reports the sketch to keep.
 */
interface CaseDraw<S> {
	readonly generator: Gen<readonly [S, ContextSketch]>
	readonly resolve: (sketch: S) => Gen<QueryCase>
}

/** The cases of `config`, each under drawn contexts, sketched so a failure reports the sketch to keep. */
const sketchedCases = (config: GenConfig): CaseDraw<QueryCaseSketch> => {
	const sketch = queryCaseSketchGen(config)
	return {
		generator: (source) => [source.draw(sketch), source.draw(contextSketchGen)] as const,
		resolve: (drawnSketch) => resolveQueryCase(drawnSketch, config)
	}
}

/** The proving shapes over generated cases of the default configuration, each under drawn contexts. */
const provingCases: CaseDraw<QueryCase> = {
	generator: (source) =>
		[
			source.draw(
				map(
					(inner) =>
						[
							inner.draw(queryCaseGen(defaultGenConfig)),
							inner.draw(array(pickGen, { min: 1, max: 12 }))
						] as const,
					([c, picks]) => provingCase(c, picks)
				)
			),
			source.draw(contextSketchGen)
		] as const,
	resolve: constant
}

/**
 * A take of one row over a closed relation of one fact, correlated on a
 * column of an outer scan no fact of it matches, so it has no row for that outer tuple. A correlated take filters its
 * input per outer row, so its input's exactly one row bounds it to at most one, never exactly one.
 */
const correlatedTakeOverOneRow: Kept<readonly [QueryCaseSketch, ContextSketch], EvidenceFeature> = {
	note: "a correlated take over one fact was claimed exactly one row and had none",
	sketch: [
		{
			schema: {
				palette: [2, 0],
				closed: [
					{
						handles: 1,
						payload: [
							{
								type: 10,
								values: [
									{ cls: 0, sp: 0 },
									{ cls: 0, sp: 0 },
									{ cls: 0, sp: 0 }
								]
							}
						]
					}
				],
				relations: [
					{
						columns: [0],
						pkMask: 0,
						pure: false,
						keyMasks: [],
						mutable: false,
						fk: { enabled: false, target: 0, typed: false },
						spanKey: false
					}
				]
			},
			facts: [
				[
					{
						values: [
							{ cls: 1, sp: 0 },
							{ cls: 0, sp: 0 },
							{ cls: 0, sp: 0 },
							{ cls: 0, sp: 0 },
							{ cls: 0, sp: 0 },
							{ cls: 0, sp: 0 },
							{ cls: 0, sp: 0 },
							{ cls: 0, sp: 0 }
						],
						target: 0
					}
				],
				[],
				[],
				[]
			],
			/** Picks a parameter name only under the dictionary spelling of names, which the soundness population leaves off. */
			paramNames: [0, 0, 0, 0, 0, 0, 0, 0],
			root: {
				tag: "plain",
				body: {
					tag: "filter",
					input: {
						tag: "project",
						input: {
							tag: "match",
							occurrences: [
								{
									source: { tag: "relation", pick: 0 },
									columns: [
										{ mode: 0, pick: 0, value: { cls: 0, sp: 0 } },
										{ mode: 0, pick: 0, value: { cls: 0, sp: 0 } },
										{ mode: 0, pick: 0, value: { cls: 0, sp: 0 } },
										{ mode: 0, pick: 0, value: { cls: 0, sp: 0 } },
										{ mode: 0, pick: 0, value: { cls: 0, sp: 0 } },
										{ mode: 0, pick: 0, value: { cls: 0, sp: 0 } }
									]
								},
								{
									source: { tag: "closed", pick: 0 },
									columns: [
										{ mode: 0, pick: 0, value: { cls: 0, sp: 0 } },
										{ mode: 0, pick: 0, value: { cls: 0, sp: 0 } },
										{ mode: 0, pick: 0, value: { cls: 0, sp: 0 } },
										{ mode: 0, pick: 0, value: { cls: 0, sp: 0 } },
										{ mode: 0, pick: 0, value: { cls: 0, sp: 0 } },
										{ mode: 0, pick: 0, value: { cls: 0, sp: 0 } }
									]
								},
								{
									source: { tag: "relation", pick: 0 },
									columns: [
										{ mode: 0, pick: 0, value: { cls: 0, sp: 0 } },
										{ mode: 0, pick: 0, value: { cls: 0, sp: 0 } },
										{ mode: 0, pick: 0, value: { cls: 0, sp: 0 } },
										{ mode: 0, pick: 0, value: { cls: 0, sp: 0 } },
										{ mode: 0, pick: 0, value: { cls: 0, sp: 0 } },
										{ mode: 0, pick: 0, value: { cls: 0, sp: 0 } }
									]
								}
							],
							equalities: [],
							lateral: { kind: "drawn", value: 0 }
						},
						out: [{ literal: true, pick: 0, value: { cls: 0, sp: 0 }, term: undrawn }]
					},
					pred: {
						tag: "compare",
						column: 0,
						op: 0,
						rhs: { tag: "literal", value: { cls: 0, sp: 0 } }
					}
				},
				order: undrawn
			},
			swarm: { closed: 3 },
			data: { closed: 1 },
			rewrite: {},
			soundness: { "correlated take": 1 }
		},
		{ transaction: false, containments: [] }
	],
	/** The swarm's thinning decision: "correlated take" kept at the one place it can appear, the take over the closed relation. */
	draws: "2",
	/**
	 * Its one outer fact evaluates the take once, which the reference counts as no correlated evaluation; the take's
	 * claim, at most one row, is what the case reaches.
	 */
	reaches: ["claimed at most one row"]
}

/**
 * The evidence a contexted case is annotated under: its containments under their drawn contexts, and the execution
 * context. Its sources' declared keys are their nodes' own.
 */
const envOf = (contexted: Pick<Contexted, "execution" | "containments">): LogicalEnv => ({
	context: contexted.execution,
	containments: contexted.containments,
	keyedViews: false
})

/** What an idempotence case reaches: the claims and delivered types its annotation states. */
type IdempotenceFeature =
	| "claimed at most one row"
	| "claimed one row"
	| "claimed a logical key"
	| "delivered array"
	| "delivered option"
	| "delivered one"

/** Every case of `draw`, annotated and checked against its facts, `kept` replayed first. */
const holdsOn = <S>(
	ctx: TestContext,
	suite: string,
	draw: CaseDraw<S>,
	kept: ReadonlyArray<Kept<readonly [S, ContextSketch], EvidenceFeature>>,
	situations: Situations<EvidenceFeature>
) =>
	searched(
		ctx,
		explore(
			{
				suite,
				draw: drawn(draw.generator),
				literal: Formatter.format,
				coverage: required<EvidenceFeature>(situations, { cases: runs, sense: notesOnly }),
				kept,
				runs,
				shrink: completeShrink,
				concurrency: 1,
				steerEvery: 16,
				caseHang: Duration.minutes(2)
			},
			([drawnSketch, sketch], c) =>
				Effect.sync(() => {
					const generated = c.draw(draw.resolve(drawnSketch))
					const {
						c: contextedCase,
						execution,
						containments,
						orphaned
					} = contexted(generated, sketch)
					c.note(`execution ${execution}`)
					for (const k of containments) {
						c.note(`${k.context} containment`)
					}
					if (orphaned.length > 0) {
						c.note("an orphaned containment inside a transaction")
					}
					const env = envOf({ execution, containments })
					const analysis = analyzeLogical(contextedCase.query.dag, env)
					if (!analysis.ok) {
						throw new Error(`annotation refused: ${analysis.error.message}`)
					}
					const soundness = logicalUnsound(
						analysis.value.dag,
						{
							schema: contextedCase.schema,
							facts: contextedCase.facts,
							params: contextedCase.query.params,
							observer: unobserved
						},
						c.note,
						env
					)
					if (soundness.kind === "unsound") {
						throw new Error(`${soundness.why}\n${printQueryCase(contextedCase)}`)
					}
					const refuses = kernelRefusesCorruptions(analysis.value.dag, env)
					if (refuses.kind === "unsound") {
						throw new Error(`${refuses.why}\n${printQueryCase(contextedCase)}`)
					}
				})
		)
	)

describe("the logical analysis's claims hold on the facts", () => {
	it.effect(
		`keys and cardinality bounds over ${runs} generated cases`,
		(ctx) =>
			holdsOn(
				ctx,
				"unit/analysis/logical/evidence-keys",
				sketchedCases(defaultGenConfig),
				[],
				["claimed at most one row", "claimed one row", "delivered option", "execution transaction"]
			),
		120_000
	)

	it.effect(
		`keys, cardinality and determinism over ${runs} cases with lateral sources, shared nodes, windows and approximate searches`,
		(ctx) =>
			holdsOn(
				ctx,
				"unit/analysis/logical/evidence-soundness",
				sketchedCases(soundnessGenConfig),
				[correlatedTakeOverOneRow],
				[
					"claimed at most one row",
					"a correlated MatchRegion evaluated per outer tuple",
					"a correlated Take evaluated per outer tuple",
					"an approximate search"
				]
			),
		120_000
	)

	it.effect(
		`delivered types over ${runs} cases rooted at attachments, under every context`,
		(ctx) =>
			holdsOn(
				ctx,
				"unit/analysis/logical/evidence-attachments",
				sketchedCases({
					...defaultGenConfig,
					query: {
						...defaultGenConfig.query,
						roots: {
							...defaultGenConfig.query.roots,
							plain: 0,
							attach: 1,
							hetero: 0
						}
					}
				}),
				[],
				[
					"delivered option",
					"committedSnapshot containment",
					"an orphaned containment inside a transaction"
				]
			),
		120_000
	)

	it.effect(
		`bare children along declared containments and filters over one fact, over ${runs} cases`,
		(ctx) =>
			holdsOn(
				ctx,
				"unit/analysis/logical/evidence-bare-children",
				provingCases,
				[],
				["delivered one", "a filter over one row", "an orphaned containment inside a transaction"]
			),
		120_000
	)
})

/** Every case of `draw` annotated twice under the evidence it draws: the second annotation states what the first did. */
const idempotentOn = <S>(
	ctx: TestContext,
	suite: string,
	draw: CaseDraw<S>,
	situations: Situations<IdempotenceFeature>
) =>
	searched(
		ctx,
		explore(
			{
				suite,
				draw: drawn(draw.generator),
				literal: Formatter.format,
				coverage: required<IdempotenceFeature>(situations, { cases: runs, sense: notesOnly }),
				kept: [],
				runs,
				shrink: completeShrink,
				concurrency: 1,
				steerEvery: 16,
				caseHang: Duration.minutes(2)
			},
			([drawnSketch, sketch], c) =>
				Effect.sync(() => {
					const generated = c.draw(draw.resolve(drawnSketch))
					const env = envOf(contexted(generated, sketch))
					const once = analyzeLogical(generated.query.dag, env)
					if (!once.ok) {
						throw new Error(`annotation refused: ${once.error.message}`)
					}
					const twice = analyzeLogical(once.value.dag, env)
					if (!twice.ok) {
						throw new Error(`a second annotation refused: ${twice.error.message}`)
					}
					const onceTable = toTable(once.value.dag)
					const twiceTable = toTable(twice.value.dag)
					if (!onceTable.ok || !twiceTable.ok) {
						throw new Error("an annotated DAG with one node per label")
					}
					for (const node of Rec.values(onceTable.value.nodes)) {
						if (node.meta.card !== "many") {
							c.note("claimed at most one row")
						}
						if (node.meta.card === "one") {
							c.note("claimed one row")
						}
						if (node.meta.logicalKeys.length > 0) {
							c.note("claimed a logical key")
						}
						if (node.kind === "Attach") {
							c.note(`delivered ${node.delivered}`)
						}
						assert.deepEqual(
							Rec.get(twiceTable.value.nodes, node.id),
							Option.some(node),
							`${node.id} (${node.kind}) annotated again`
						)
					}
				})
		)
	)

describe("the logical analysis is idempotent", () => {
	it.effect(
		`annotating twice states what annotating once states, over ${runs} cases rooted at plain rows, attachments and unions, and the proving shapes`,
		(ctx) =>
			Effect.andThen(
				idempotentOn(
					ctx,
					"unit/analysis/logical/evidence-idempotent",
					sketchedCases({
						...defaultGenConfig,
						query: {
							...defaultGenConfig.query,
							roots: {
								...defaultGenConfig.query.roots,
								plain: 1,
								attach: 2,
								hetero: 1
							}
						}
					}),
					[
						"claimed at most one row",
						"claimed one row",
						"claimed a logical key",
						"delivered array",
						"delivered option"
					]
				),
				idempotentOn(ctx, "unit/analysis/logical/evidence-idempotent-bare", provingCases, [
					"delivered one"
				])
			),
		120_000
	)
})
