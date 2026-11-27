/** What the properties of generated.test.ts read: its spaces, models and helpers. */

import { type Reached } from "@bjornpagen/testing/features"
import { aimed, type Gen } from "@bjornpagen/testing/gen"
import {
	type Case,
	type Kept,
	type Kill,
	type Oracle,
	type Property,
	property,
	type Space,
	type Budget
} from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import type { NodeId } from "#compiler/core/ids.ts"
import type { CertificateRule } from "#compiler/ir/certificate.ts"
import { nodesByLabel, topoOrder } from "#compiler/ir/dag.ts"
import type { Pass } from "#compiler/ir/pass.ts"
import type { LogicalQuery } from "#compiler/ir/products.ts"
import type { RelDag, RelKind } from "#compiler/ir/rel.ts"
import { closedPass } from "#compiler/lower/optimize/closed/index.ts"
import {
	relationalRewrites,
	semanticSimplification
} from "#compiler/lower/optimize/demand/phases.ts"
import { eliminatePass } from "#compiler/lower/optimize/eliminate/index.ts"
import { existencePass } from "#compiler/lower/optimize/existence/index.ts"
import { fusePass } from "#compiler/lower/optimize/fuse/index.ts"
import { lateFetchPass } from "#compiler/lower/optimize/late-fetch/index.ts"
import { prunePass } from "#compiler/lower/optimize/prune/index.ts"
import { simplifyPass } from "#compiler/lower/optimize/simplify/index.ts"
import { succeeded } from "#test/support/assert.ts"
import { genCatalog } from "#test/support/evidence.ts"
import {
	type GenConfig,
	type QueryCase,
	type QueryCaseSketch,
	queryCaseSketchGen,
	resolveQueryCase,
	rewriteGenConfig
} from "#test/support/oracle/gen/case.ts"
import { schemaCodes } from "#test/support/oracle/gen/schema.ts"
import {
	agrees,
	caseQuery,
	lowerConservatively,
	narrowedTo,
	passContext,
	type QueryForm,
	type RewriteAgreement,
	runPasses
} from "#test/unit/lower/rewrite/support.ts"

/**
 * The optimizer's population for the rewrite passes: wide payload of unbounded text alone (the reference evaluator
 * computes no vector), and filters drawn directly over groups, unions and set comparisons.
 */
export const population: GenConfig = rewriteGenConfig

/** A sequence of rewrite passes. */
type Passes = ReadonlyArray<Pass<LogicalQuery, LogicalQuery>>

/** The composed rewrite phases: semantic simplification, then the relational rewrites. */
export const fullPipeline: Passes = [semanticSimplification, relationalRewrites]

/**
 * The rule families the composed pipeline must keep firing on the population, every one but late fetch, which the
 * wide-payload cases must fire, simplify.mergeProjections, which the composed pipeline's property requires beside
 * these, aimed at the population's projections, and those the population fires a few times a run, which that
 * property's kept cases plant.
 */
export const pipelineRules = [
	"R01.fusion",
	"R02.semiJoin",
	"R02.antiJoin",
	"prune.heading",
	"simplify.fold",
	"simplify.empty",
	"simplify.identityProjection",
	"simplify.mergeFilters"
] as const satisfies ReadonlyArray<CertificateRule>

/**
 * What a case of the rewrite suites reaches: each kind of node its query holds, each rule a pass fired (alone, and
 * paired with the kind of node it rewrote), and whether the reference judged it.
 */
export type RewriteFeature = `node ${RelKind}` | CertificateRule | `reference ${RewriteAgreement}`

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
export const preserves = (
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
	succeeded(lowerConservatively(ran.query, schemaCodes(q.schema)))
}

/** A case of the population, drawn as its sketch, which a failure prints and a kept case states. */
export const sketchGen: Gen<QueryCaseSketch> = queryCaseSketchGen(population)

/** The oracle every search of the generated cases states. */
const delivery: Oracle = {
	kind: "second-implementation",
	name: "the reference evaluator's delivery of the query before the passes"
}

/**
 * Explores the population through `passes`, each sketch resolved in the property, steered toward `situations`, a case
 * aimed at a pending situation of `aims` drawn from the population narrowed to the forms beside it (support.ts
 * narrowedTo); `kept` and `kills` are the calling property's.
 */
export const exploreSteered = (spec: {
	readonly passes: Passes
	readonly evidence: "snapshot" | "transaction"
	readonly situations: ReadonlyArray<Reached<RewriteFeature>>
	readonly aims: ReadonlyArray<
		readonly [Reached<RewriteFeature>, Arr.NonEmptyReadonlyArray<QueryForm>]
	>
	readonly budget: Budget
	readonly kept: ReadonlyArray<Kept>
	readonly kills: ReadonlyArray<Kill>
}): Property =>
	property.explore(
		aimed(
			sketchGen,
			Arr.map(
				spec.aims,
				([situation, forms]) =>
					[situation, queryCaseSketchGen(narrowedTo(population, forms))] as const
			)
		),
		{
			needs: {},
			budget: spec.budget,
			situations: spec.situations,
			check: (_, c: Case<RewriteFeature>) => (sketch) =>
				Effect.sync(() => {
					preserves(c.draw(resolveQueryCase(sketch, population)), spec.passes, spec.evidence, c)
				}),
			oracle: delivery,
			kept: spec.kept,
			kills: spec.kills
		}
	)

/** Explores ready-made cases through `passes`; `kept` and `kills` are the calling property's. */
export const exploreCases = (spec: {
	readonly cases: Space<QueryCase>
	readonly passes: Passes
	readonly evidence: "snapshot" | "transaction"
	readonly situations: ReadonlyArray<Reached<RewriteFeature>>
	readonly budget: Budget
	readonly kept: ReadonlyArray<Kept>
	readonly kills: ReadonlyArray<Kill>
}): Property =>
	property.explore(spec.cases, {
		needs: {},
		budget: spec.budget,
		situations: spec.situations,
		check: (_, c: Case<RewriteFeature>) => (q) =>
			Effect.sync(() => {
				preserves(q, spec.passes, spec.evidence, c)
			}),
		oracle: delivery,
		kept: spec.kept,
		kills: spec.kills
	})

/** The passes judged alone, by name. */
export const singlePasses = {
	simplify: [simplifyPass],
	fuse: [fusePass],
	prune: [prunePass],
	eliminate: [prunePass, eliminatePass],
	existence: [prunePass, existencePass],
	closed: [closedPass],
	lateFetch: [lateFetchPass]
} as const satisfies Readonly<Record<string, Passes>>

/** A pass judged alone, by name. */
type PassName = keyof typeof singlePasses

/** Every pass judged alone. */
export const passNames: Arr.NonEmptyReadonlyArray<PassName> = [
	"simplify",
	"fuse",
	"prune",
	"eliminate",
	"existence",
	"closed",
	"lateFetch"
]

/** What a case of the single-pass suite reaches: the pass it ran, and what the pass reached on it. */
export type SinglePassFeature = `pass ${PassName}` | RewriteFeature
