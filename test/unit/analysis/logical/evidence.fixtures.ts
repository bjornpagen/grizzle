/** What the properties of evidence.test.ts read: the proving shapes, the contexts a case is read under, and the harnesses each property is one call of. */

import { assert, defined } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import {
	aimed,
	array,
	boolean,
	element,
	type Gen,
	int,
	map,
	type Space
} from "@bjornpagen/testing/gen"
import {
	type Case,
	type Kept,
	type Kill,
	type Property,
	property,
	type Budget
} from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option, Record as Rec } from "effect"
import { makeIdSupply } from "#compiler/core/ids.ts"
import { DagBuilder } from "#compiler/ir/builder.ts"
import { assembledDag, edgeValues, relNode, topoOrder, unchangedEdges } from "#compiler/ir/dag.ts"
import type { EvidenceContext, TemplateContext } from "#compiler/ir/evidence.ts"
import { type ScalarExpr, storedColumn } from "#compiler/ir/expr.ts"
import { Fold } from "#compiler/ir/fold.ts"
import {
	conservativeMeta,
	type Heading,
	type HeadingColumn,
	headingOrder,
	inputsOf,
	mapRoots,
	metaSpecOf,
	type RelNode,
	type ValidDag,
	type VarDecl
} from "#compiler/ir/rel.ts"
import { typeLabel } from "#compiler/ir/scalar.ts"
import {
	analyzeLogical,
	everyNode,
	keptNodes,
	type LogicalAnalysis,
	type LogicalEnv,
	SharedAnalyses,
	withLogicalMeta
} from "#compiler/logical/annotate.ts"
import type { ContainmentFact } from "#compiler/logical/attach.ts"
import { fixedColumns, type Props } from "#compiler/logical/props.ts"
import { succeeded } from "#test/support/assert.ts"
import { toTable } from "#test/support/dag.ts"
import { validateDag } from "#test/support/oracle/dag-validate.ts"
import {
	defaultGenConfig,
	type GenConfig,
	type QueryCase,
	type QueryCaseSketch,
	queryCaseSketchGen,
	resolveQueryCase
} from "#test/support/oracle/gen/case.ts"
import {
	allTypeSpecs,
	bool,
	canonicallySpelled,
	literalRowKey
} from "#test/support/oracle/gen/domain.ts"
import { type GenFacts, rowValues, type StoredRow } from "#test/support/oracle/gen/facts.ts"
import { compareOpId, notOp } from "#test/support/oracle/gen/ops.ts"
import { printQueryCase } from "#test/support/oracle/gen/print.ts"
import {
	closedHeading,
	type GenContainment,
	type GenRelation,
	keyIndices,
	relationHeading,
	relationNamed,
	type SchemaSketch,
	spanCoverage
} from "#test/support/oracle/gen/schema.ts"
import { nonEmptyList } from "#test/support/oracle/pick.ts"
import { unobserved } from "#test/support/oracle/reference/evaluate.ts"
import { noFunctions } from "#test/support/oracle/reference/functions.ts"
import { pickFrom, pickGen, pickOf } from "#test/support/pick.ts"
import {
	fixedNamesUnscoped,
	kernelRefusesCorruptions,
	type LogicalFeature,
	logicalUnsound
} from "#test/unit/analysis/logical/support.ts"

const both = [false, true] as const

/**
 * Shapes the generated queries do not reach, over a generated case's schema and facts: along each declared
 * containment, the target relation's plain scan attached by its key to a parent that reads the source's fields from one
 * fact of it, the attachment the containment proof types bare, or from one fact of another relation with fields of the
 * same names and types, which the containment says nothing about; and a filter directly over each closed relation,
 * which may drop the one fact it has. Along a span coverage (a PERIOD foreign key into a span key), a variant narrows
 * every source fact's span to its first point where it has another (narrowedFacts): the target fact still covers it,
 * and none has its span, so its parent has no child. Each pick chooses among a shape's variants; the case's own query
 * is replaced, and kept when its schema offers neither shape.
 */
const provingCase = (c: QueryCase, picks: ReadonlyArray<number>): QueryCase => {
	const b = new DagBuilder(makeIdSupply())
	const pick = (i: number) => picks[i % picks.length] ?? 0
	const column = (node: RelNode, h: HeadingColumn): ScalarExpr =>
		b.expr(storedColumn(node.id, h.name, h.type))
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
			generated: [],
			unit: [],
			determined: [],
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
	/** The span coverages whose source facts the case narrows. */
	const narrowed: Array<GenContainment> = []
	for (const [i, k] of c.schema.containments.entries()) {
		const declared = relationNamed(c.schema, k.from.relation)
		const variant = {
			lookalike: pickFrom([false, false, false, true], pick(4 * i)),
			projectParent: pickFrom(both, pick(4 * i + 1)),
			projectChild: pickFrom(both, pick(4 * i + 2)),
			narrowed: pickFrom(both, pick(4 * i + 3))
		}
		if (variant.narrowed && spanCoverage(c.schema, k)) {
			narrowed.push(k)
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
				judged: "array",
				delivered: "array",
				heading: parent.heading,
				order: headingOrder(child.heading),
				loc: undefined,
				meta: conservativeMeta
			})
		)
	}
	const offset = 4 * c.schema.containments.length
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
	return {
		...c,
		facts: narrowedFacts(c, narrowed),
		query: { dag: validateDag(b.build(roots)), params: {} }
	}
}

/**
 * The case's facts with every source fact of each span coverage of `narrowed` covering the first point of its span
 * alone, where its span holds another. The target fact it copied still covers it, so the containment holds, and no
 * target fact of its scalar fields has its span: target spans of one scalar value never overlap.
 */
const narrowedFacts = (c: QueryCase, narrowed: ReadonlyArray<GenContainment>): GenFacts =>
	Arr.reduce(narrowed, c.facts, (facts, k) => {
		const source = relationNamed(c.schema, k.from.relation)
		const [span] = keyIndices(source, k.from.fields.slice(-1))
		const rows = facts[source.name] ?? []
		return {
			...facts,
			[source.name]: Arr.map(rows, (row) =>
				Arr.map(row, (v, i) =>
					i === span && v.literal.kind === "span" && v.literal.end - v.literal.start > 1n
						? canonicallySpelled({
								kind: "span",
								start: v.literal.start,
								end: v.literal.start + 1n
							})
						: v
				)
			)
		}
	})

/**
 * Whether a span coverage holds a source fact that a target fact of its scalar fields covers and none equals on the
 * whole key: the parent reading it along the containment has no child.
 */
const coveredApart = (c: QueryCase, k: GenContainment): boolean => {
	const source = relationNamed(c.schema, k.from.relation)
	const target = relationNamed(c.schema, k.to.relation)
	const scalars = k.from.fields.length - 1
	const keyOf = (r: GenRelation, fields: ReadonlyArray<string>, row: StoredRow) =>
		literalRowKey(rowValues(row), keyIndices(r, fields))
	const targets = c.facts[target.name] ?? []
	const whole = new Set(Arr.map(targets, (t) => keyOf(target, k.to.fields, t)))
	const met = new Set(Arr.map(targets, (t) => keyOf(target, k.to.fields.slice(0, scalars), t)))
	return Arr.some(
		c.facts[source.name] ?? [],
		(f) =>
			met.has(keyOf(source, k.from.fields.slice(0, scalars), f)) &&
			!whole.has(keyOf(source, k.from.fields, f))
	)
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
			from: {
				relation: k.from.relation,
				fields: nonEmptyList(k.from.fields, "a containment's fields"),
				selection: []
			},
			to: {
				relation: k.to.relation,
				fields: nonEmptyList(k.to.fields, "a containment's referenced fields"),
				selection: []
			},
			coverage: spanCoverage(c.schema, k),
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
	| "a span coverage's fact covered apart from its target's spans"

/**
 * What a suite draws: a sketch and the contexts drawn for it, and how the property resolves the sketch to its case,
 * drawing the swarms' thinning decisions from the case's tape. A failure reports the sketch to keep.
 */
interface CaseDraw<S> {
	readonly generator: Gen<readonly [S, ContextSketch]>
	readonly resolve: (sketch: S) => Gen<QueryCase>
}

/** The cases of `config`, each under drawn contexts, sketched so a failure reports the sketch to keep. */
export const sketchedCases = (config: GenConfig): CaseDraw<QueryCaseSketch> => {
	const sketch = queryCaseSketchGen(config)
	return {
		generator: (source) => [source.draw(sketch), source.draw(contextSketchGen)] as const,
		resolve: (drawnSketch) => resolveQueryCase(drawnSketch, config)
	}
}

/** The generator's own population, every root an attachment: the delivered types' cases. */
export const attachmentRooted: GenConfig = {
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
}

/**
 * The proving shapes' population: the generator's own, whose relations may be keyed by a span key, so a containment
 * into one is a span coverage (a PERIOD foreign key).
 */
const provingConfig: GenConfig = {
	...defaultGenConfig,
	schema: { ...defaultGenConfig.schema, keys: "spanKeys" }
}

const provingSketch = queryCaseSketchGen(provingConfig)

/** A proving case's sketch: its generated case's sketch and the picks among its shapes' variants. */
type ProvingSketch = readonly [QueryCaseSketch, ReadonlyArray<number>]

/**
 * The proving shapes over generated cases of the proving configuration, each under drawn contexts, sketched so a
 * failure reports the sketch to keep.
 */
export const provingCases: CaseDraw<ProvingSketch> = {
	generator: (source) =>
		[
			[source.draw(provingSketch), source.draw(array(pickGen, { min: 1, max: 12 }))] as const,
			source.draw(contextSketchGen)
		] as const,
	resolve: ([sketch, picks]) =>
		map(resolveQueryCase(sketch, provingConfig), (c) => provingCase(c, picks))
}

/**
 * The context that orphans every containment it can: inside a transaction, each containment a schema may declare checked
 * at commit and its target's facts lost (contexted), so every one no immediate containment reads is orphaned.
 */
const orphaning: ContextSketch = {
	transaction: true,
	containments: Arr.makeBy(4, () => ({ context: "committedSnapshot", orphan: true }))
}

/** `config` with schemas that most often declare a containment, each a typed foreign key (schema.ts SchemaLimits). */
const contained = (config: GenConfig): GenConfig => ({
	...config,
	schema: { ...config.schema, containments: "often" }
})

/**
 * The cases of `config` over schemas that most often declare a containment, each under the context that orphans every
 * containment it can: what "an orphaned containment inside a transaction" needs, which drawn schemas and contexts meet
 * about one case in a hundred. `sketchedCases(config)` resolves them, since resolving a sketch reads no schema limit.
 */
export const orphanedCases = (
	config: GenConfig
): Space<readonly [QueryCaseSketch, ContextSketch]> => {
	const sketch = queryCaseSketchGen(contained(config))
	return (source) => [source.draw(sketch), orphaning] as const
}

/** The picks of the span types among the type specs a schema sketch's palette picks from (schema.ts isSpanType). */
const spanPicks = nonEmptyList(
	Arr.flatMap(allTypeSpecs, (spec, at) =>
		spec.carrier === "range4" || spec.carrier === "range8" ? [at] : []
	),
	"the span type specs"
)

/**
 * A drawn schema sketch made to declare a span coverage: `span`, a span type's pick, first in its palette; its first
 * relation keyed by a span key, a column of that type before its drawn ones; its second, that column before its own
 * drawn ones, contained in the first by a typed foreign key (one the first relation's key fields retype the columns of).
 * Every other pick is the drawn sketch's; a sketch of one relation reads it as both.
 */
const spanCovered = (schema: SchemaSketch, span: number): SchemaSketch => {
	const [target, ...rest] = nonEmptyList(schema.relations, "a schema sketch's relations")
	const [source, ...others] = Arr.isReadonlyArrayNonEmpty(rest) ? rest : [target]
	return {
		...schema,
		palette: [span, ...schema.palette],
		relations: [
			{ ...target, columns: [0, ...target.columns], spanKey: true },
			{ ...source, columns: [0, ...source.columns], fk: { enabled: true, target: 0, typed: true } },
			...others
		]
	}
}

/**
 * Proving cases whose schema declares a span coverage (spanCovered), each under one pick that narrows every span
 * coverage's source facts (narrowedFacts), projects both sides and reads no lookalike, under drawn contexts: what "a
 * span coverage's fact covered apart from its target's spans" needs, which no drawn proving case of three hundred
 * meets. `provingCases` resolves them.
 */
export const narrowedProvingCases: Space<readonly [ProvingSketch, ContextSketch]> = (source) => {
	const sketch = source.draw(provingSketch)
	const covered = { ...sketch, schema: spanCovered(sketch.schema, source.draw(element(spanPicks))) }
	const narrowing = source.draw(int(pickOf(1, 2), pickOf(3, 4) - 1))
	return [[covered, [narrowing]] as const, source.draw(contextSketchGen)] as const
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

/** What a restating case reaches: a node the analysis restated (an attachment's judged delivery) and one it did not. */
type RestatedFeature = "a node the analysis restated" | "a node the analysis restated nothing of"

/**
 * `dag` with every node carrying the metadata `analysis` computed for it and its own body, each node built again
 * where its metadata or an input changed (withLogicalMeta as it stood at 018bf56dc): what withLogicalMeta must state.
 */
const rebuiltWithMeta = (dag: ValidDag, analysis: LogicalAnalysis): ValidDag => {
	const rebuilt = new Fold<RelNode, RelNode>(function* (node) {
		const body = yield* edgeValues<RelNode>(node)
		const annotated = analysis.of(node).node
		return annotated === node && unchangedEdges(node, body)
			? node
			: relNode(node.id, { ...body, meta: metaSpecOf(annotated.meta) })
	})
	return assembledDag(mapRoots(dag.roots, (root) => rebuilt.of(root)))
}

/**
 * Every case of `draw` annotated under the evidence it draws, its DAG restated with the analysis's metadata
 * (withLogicalMeta, each node's own body): the restated DAG states every node as building each node again does, and
 * each node the analysis restated nothing of in its sub-DAG is the analysis's annotated node itself, none built again.
 */
export const restatedOn = <S>(draw: CaseDraw<S>, stated: Stated<RestatedFeature>): Property =>
	property.explore(draw.generator, {
		needs: {},
		budget: evidenceBudget,
		situations: stated.situations,
		check:
			(_, c: Case<RestatedFeature>) =>
			([drawnSketch, sketch]) =>
				Effect.sync(() => {
					const generated = c.draw(draw.resolve(drawnSketch))
					const dag = generated.query.dag
					const analysis = succeeded(
						analyzeLogical(dag, envOf(contexted(generated, sketch)), everyNode),
						"the annotation"
					)
					const restatedDag = withLogicalMeta(dag, analysis, (node) => node, new Set())
					const restated = toTable(restatedDag)
					const rebuilt = toTable(rebuiltWithMeta(dag, analysis))
					if (!restated.ok || !rebuilt.ok) {
						throw new Error("a restated DAG with one node per label")
					}
					assert.deepEqual(restated.value.nodes, rebuilt.value.nodes, "the restated DAG's nodes")
					const restatedNodes = new Map(Arr.map(topoOrder(restatedDag), (n) => [n.id, n] as const))
					/** The nodes no node of whose sub-DAG the analysis restated: each is its annotated node, none built again. */
					const asAnnotated = new Set<RelNode>()
					for (const node of topoOrder(dag)) {
						const annotation = analysis.of(node)
						if (annotation.restated) {
							c.note("a node the analysis restated")
							continue
						}
						if (!Arr.every(inputsOf(node), (input) => asAnnotated.has(input))) {
							continue
						}
						asAnnotated.add(node)
						c.note("a node the analysis restated nothing of")
						assert.equal(
							restatedNodes.get(node.id) === annotation.node,
							true,
							`${node.id} (${node.kind}) is the analysis's annotated node`
						)
					}
				}),
		oracle: {
			kind: "second-implementation",
			name: "each node built again with the analysis's metadata, as withLogicalMeta did at 018bf56dc"
		},
		kept: stated.kept,
		kills: stated.kills
	})

/** What an idempotence case reaches: the claims and delivered types its annotation states. */
type IdempotenceFeature =
	| "claimed at most one row"
	| "claimed one row"
	| "claimed a logical key"
	| "delivered array"
	| "delivered option"
	| "delivered one"

/**
 * What a shared-analyses case reaches: an analysis reading an annotation an earlier one recorded, a recorded sub-DAG
 * holding an attachment, read where its child has another reader too or none, and a DAG rooted at a recorded node
 * inside a shared node's sub-DAG.
 */
type SharedFeature =
	| "a recorded annotation read again"
	| "a shared sub-DAG holding an attachment"
	| "a DAG rooted inside a shared sub-DAG"

/**
 * The budget each property of evidence.test.ts searches with, holdsOn's and idempotentOn's alike: what its suite
 * stated before it became a property, 1500 runs and as many steered cases (test/unit/analysis/logical/evidence.test.ts:93
 * at 8cad5bce, `const runs = 1500`, which every search read as its runs and as its coverage's cases).
 */
const evidenceBudget: Budget = { runs: 1500, steered: 1500 }

/**
 * What a property of a harness states beside its draw: the situations its witnesses must reach, its kept cases and
 * the bugs it must kill.
 */
interface Stated<F extends string> {
	readonly situations: ReadonlyArray<Reached<F>>
	readonly kept: ReadonlyArray<Kept>
	readonly kills: ReadonlyArray<Kill>
}

/**
 * Where a property's space aims: each situation still pending, and the space of cases constructed to reach it, which
 * the draw's own resolve resolves. None for a property its draw reaches unaimed.
 */
type Aims<S> = ReadonlyArray<
	readonly [Reached<EvidenceFeature>, Space<readonly [S, ContextSketch]>]
>

/** Every case of `draw`, aimed by `aims`, annotated and checked against its facts. */
export const holdsOn = <S>(
	draw: CaseDraw<S>,
	stated: Stated<EvidenceFeature> & Readonly<{ aims: Aims<S> }>
): Property =>
	property.explore(aimed(draw.generator, stated.aims), {
		needs: {},
		budget: evidenceBudget,
		situations: stated.situations,
		check:
			(_, c: Case<EvidenceFeature>) =>
			([drawnSketch, sketch]) =>
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
					if (
						Arr.some(
							contextedCase.schema.containments,
							(k) => spanCoverage(contextedCase.schema, k) && coveredApart(contextedCase, k)
						)
					) {
						c.note("a span coverage's fact covered apart from its target's spans")
					}
					const env = envOf({ execution, containments })
					const analysis = analyzeLogical(contextedCase.query.dag, env, everyNode)
					if (!analysis.ok) {
						throw new Error(`annotation refused: ${analysis.error.message}`)
					}
					const scoped = fixedNamesUnscoped(contextedCase.query.dag, analysis.value.props)
					if (scoped.kind === "unsound") {
						throw new Error(`${scoped.why}\n${printQueryCase(contextedCase)}`)
					}
					const soundness = logicalUnsound(
						analysis.value.dag,
						{
							schema: contextedCase.schema,
							facts: contextedCase.facts,
							params: contextedCase.query.params,
							functions: noFunctions,
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
				}),
		oracle: {
			kind: "second-implementation",
			name: "the reference evaluator's every evaluation of every node, each claim judged on every relation it denoted"
		},
		kept: stated.kept,
		kills: stated.kills
	})

/**
 * What an analysis claims of a node, besides its annotated node: the properties a reader of the analysis reads of it,
 * each a value, never a function or the node itself.
 */
const claimsOf = (props: Props) => ({
	columns: props.columns,
	keys: props.keys,
	card: props.card,
	context: props.context,
	discriminant: props.discriminant,
	classes: [...props.classes],
	fixed: fixedColumns(props),
	outer: [...props.outer],
	whole: props.whole()
})

/**
 * Every case of `draw` analyzed as a compile analyzes its queries under one environment (logical/annotate.ts
 * SharedAnalyses): three DAGs over the case's nodes, the case's own, the case with every attachment's child a root too,
 * which gives each such child another reader, and one rooted at drawn nodes of the case, analyzed in each of three
 * orders by one SharedAnalyses sharing drawn nodes. Every analysis annotates every node as an analysis of its DAG alone
 * does: the same annotated and judged DAGs, and the same claims of each node.
 */
export const sharedOn = <S>(draw: CaseDraw<S>, stated: Stated<SharedFeature>): Property =>
	property.explore(draw.generator, {
		needs: {},
		budget: evidenceBudget,
		situations: stated.situations,
		check:
			(_, c: Case<SharedFeature>) =>
			([drawnSketch, sketch]) =>
				Effect.sync(() => {
					const generated = c.draw(draw.resolve(drawnSketch))
					const env = envOf(contexted(generated, sketch))
					const own = generated.query.dag
					const nodes = topoOrder(own)
					const size = { min: nodes.length, max: nodes.length }
					const sharedMarks = c.draw(array(boolean, size))
					const rootMarks = c.draw(array(boolean, size))
					const shared = new Set(Arr.filter(nodes, (_, i) => sharedMarks[i] === true))
					const children = Arr.flatMap(nodes, (n) => (n.kind === "Attach" ? [n.child] : []))
					const dags: readonly [ValidDag, ValidDag, ValidDag] = [
						own,
						assembledDag([...own.roots, ...children]),
						assembledDag(Arr.filter(nodes, (_, i) => rootMarks[i] === true))
					]
					const below = (root: RelNode): ReadonlyArray<RelNode> => topoOrder(assembledDag([root]))
					const inside = new Set(Arr.flatMap([...shared], (n) => Arr.dropRight(below(n), 1)))
					if (Arr.some([...shared], (n) => Arr.some(below(n), (m) => m.kind === "Attach"))) {
						c.note("a shared sub-DAG holding an attachment")
					}
					if (Arr.some(dags[2].roots, (n) => inside.has(n) && !shared.has(n))) {
						c.note("a DAG rooted inside a shared sub-DAG")
					}
					for (const sequence of [
						[0, 1, 2, 0],
						[1, 0, 2, 1],
						[2, 0, 1, 2]
					] as const) {
						const analyses = new SharedAnalyses(env, (n) => shared.has(n))
						/** The annotated nodes the sequence's analyses made so far, each rebuilt under the claims made of it. */
						const made = new Set<RelNode>()
						for (const at of sequence) {
							const dag = dags[at]
							/** A caller reads its roots' properties: every other node's are dropped once its readers are built. */
							const kept = keptNodes(dag.roots)
							const reading = succeeded(analyzeLogical(dag, analyses, kept), "a shared analysis")
							const alone = succeeded(
								analyzeLogical(dag, env, kept),
								"an analysis of the DAG alone"
							)
							assert.deepEqual(toTable(reading.dag), toTable(alone.dag), "the annotated DAG")
							assert.deepEqual(toTable(reading.judged), toTable(alone.judged), "the judged DAG")
							const order = topoOrder(dag)
							for (const node of order) {
								const annotated = reading.of(node).node
								if (annotated !== node && made.has(annotated)) {
									c.note("a recorded annotation read again")
								}
							}
							for (const root of dag.roots) {
								assert.deepEqual(
									claimsOf(defined(reading.props.get(root), "a root's properties, kept")),
									claimsOf(defined(alone.props.get(root), "a root's properties, kept")),
									`${root.id} (${root.kind}) claimed alike`
								)
							}
							for (const node of order) {
								made.add(reading.of(node).node)
							}
						}
					}
				}),
		oracle: {
			kind: "second-implementation",
			name: "an analysis of each DAG alone, which reads no other analysis"
		},
		kept: stated.kept,
		kills: stated.kills
	})

/** What a case of versionsOn reaches. */
type VersionFeature =
	| "a version of the case's own nodes"
	| "a version built from annotated nodes"
	| "a version rooted at an annotated attachment's child"
	| "an annotated node read as its own annotation"

/**
 * Every case of `draw` analyzed as a compile analyzes its DAG's versions: one store of shared analyses under the case's
 * evidence sharing every node (SharedAnalyses, `() => true`), the case's DAG first, then a version of its own nodes
 * rooted again (its roots and its attachments' children, or drawn nodes) and versions built from the first analysis's
 * annotated nodes (all of them, or drawn ones, as a write's restatement and its rewrites build theirs), each analyzed
 * through the store and alone: every version's annotated DAG, judged DAG and roots' claims are the analysis alone's.
 */
export const versionsOn = <S>(draw: CaseDraw<S>, stated: Stated<VersionFeature>): Property =>
	property.explore(draw.generator, {
		needs: {},
		budget: evidenceBudget,
		situations: stated.situations,
		check:
			(_, c: Case<VersionFeature>) =>
			([drawnSketch, sketch]) =>
				Effect.sync(() => {
					const generated = c.draw(draw.resolve(drawnSketch))
					const env = envOf(contexted(generated, sketch))
					const analyses = new SharedAnalyses(env, () => true)
					const through = (dag: ValidDag, what: string) => {
						const kept = keptNodes(dag.roots)
						const reading = succeeded(
							analyzeLogical(dag, analyses, kept),
							`${what}, through the store`
						)
						const alone = succeeded(analyzeLogical(dag, env, kept), `${what}, alone`)
						assert.deepEqual(toTable(reading.dag), toTable(alone.dag), `${what}: the annotated DAG`)
						assert.deepEqual(
							toTable(reading.judged),
							toTable(alone.judged),
							`${what}: the judged DAG`
						)
						for (const root of dag.roots) {
							assert.deepEqual(
								claimsOf(defined(reading.props.get(root), "a root's properties, kept")),
								claimsOf(defined(alone.props.get(root), "a root's properties, kept")),
								`${what}: ${root.id} (${root.kind}) claimed alike`
							)
						}
						return reading
					}
					const own = generated.query.dag
					const first = through(own, "the case's DAG")
					const nodes = topoOrder(own)
					const children = Arr.flatMap(nodes, (n) => (n.kind === "Attach" ? [n.child] : []))
					const ownMarks = c.draw(array(boolean, { min: nodes.length, max: nodes.length }))
					c.note("a version of the case's own nodes")
					through(assembledDag([...own.roots, ...children]), "its own nodes, its children rooted")
					const ownDrawn = Arr.filter(nodes, (_, i) => ownMarks[i] === true)
					if (Arr.isReadonlyArrayNonEmpty(ownDrawn)) {
						through(assembledDag(ownDrawn), "its own drawn nodes")
					}
					const annotated = topoOrder(first.dag)
					if (Arr.some(annotated, (n) => analyses.state.selves.has(n))) {
						c.note("an annotated node read as its own annotation")
					}
					const marks = c.draw(array(boolean, { min: annotated.length, max: annotated.length }))
					c.note("a version built from annotated nodes")
					through(first.dag, "its annotated DAG")
					const drawn = Arr.filter(annotated, (_, i) => marks[i] === true)
					if (Arr.isReadonlyArrayNonEmpty(drawn)) {
						through(assembledDag(drawn), "its drawn annotated nodes")
					}
					const annotatedChildren = Arr.flatMap(annotated, (n) =>
						n.kind === "Attach" ? [n.child] : []
					)
					if (Arr.isReadonlyArrayNonEmpty(annotatedChildren)) {
						c.note("a version rooted at an annotated attachment's child")
						through(
							assembledDag([...first.dag.roots, ...annotatedChildren]),
							"its annotated children rooted"
						)
					}
				}),
		oracle: {
			kind: "second-implementation",
			name: "an analysis of each version alone, which reads no other analysis"
		},
		kept: stated.kept,
		kills: stated.kills
	})

/** Every case of `draw` annotated twice under the evidence it draws: the second annotation states what the first did. */
export const idempotentOn = <S>(draw: CaseDraw<S>, stated: Stated<IdempotenceFeature>): Property =>
	property.explore(draw.generator, {
		needs: {},
		budget: evidenceBudget,
		situations: stated.situations,
		check:
			(_, c: Case<IdempotenceFeature>) =>
			([drawnSketch, sketch]) =>
				Effect.sync(() => {
					const generated = c.draw(draw.resolve(drawnSketch))
					const env = envOf(contexted(generated, sketch))
					const once = analyzeLogical(generated.query.dag, env, everyNode)
					if (!once.ok) {
						throw new Error(`annotation refused: ${once.error.message}`)
					}
					const twice = analyzeLogical(once.value.dag, env, everyNode)
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
				}),
		oracle: { kind: "universal", name: "a second annotation states what the first did" },
		kept: stated.kept,
		kills: stated.kills
	})
