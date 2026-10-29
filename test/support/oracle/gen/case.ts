import { array, constant, type Gen, int } from "@grizzle/testing/gen"
import { type Swarm, swarm } from "@grizzle/testing/swarm"
import type { Array as Arr } from "effect"
import {
	type Spelling,
	type SpellingMode,
	spellingChoiceCount
} from "#test/support/oracle/gen/domain.ts"

import {
	defaultFactLimits,
	type FactLimits,
	type FactsSketch,
	factsSketchGen,
	type GenFacts,
	resolveFacts
} from "#test/support/oracle/gen/facts.ts"

import {
	defaultQueryConfig,
	fullQuerySwarm,
	fullRewriteSwarm,
	fullSoundnessSwarm,
	type GenQuery,
	type QueryConfig,
	type QueryFeature,
	queryFeatures,
	queryGenerators,
	type RewriteFeature,
	type RootSketch,
	resolveQuery,
	rewriteFeatures,
	rewriteSwarmed,
	type SoundnessFeature,
	soundnessFeatures
} from "#test/support/oracle/gen/query.ts"

import {
	type DataFeature,
	dataFeatures,
	defaultSchemaLimits,
	fullDataSwarm,
	type GenSchema,
	resolveSchema,
	type SchemaLimits,
	type SchemaSketch,
	schemaSketchGen
} from "#test/support/oracle/gen/schema.ts"
import { pickGen } from "#test/support/pick.ts"

export interface GenConfig {
	readonly schema: SchemaLimits
	readonly facts: FactLimits
	readonly query: QueryConfig
	/**
	 * "perCase" keeps raw text multisets deterministic (domain.ts); "perFact" mixes spellings within a case; "twinned"
	 * mixes them where merges meet them (domain.ts SpellingMode).
	 */
	readonly spelling: SpellingMode
	/**
	 * Whether each case draws a swarm that turns the generators' features on, off and thins them; off,
	 * every feature is available in every case at the configured weights.
	 */
	readonly swarm: boolean
	/** Whether values are drawn from the edge classes too (domain.ts edgeClasses). */
	readonly edge: boolean
}

export const defaultGenConfig: GenConfig = {
	schema: defaultSchemaLimits,
	facts: defaultFactLimits,
	query: defaultQueryConfig,
	spelling: "perCase",
	swarm: true,
	edge: false
}

/**
 * The optimizer's population: the generator's own, with what each rewrite family of the optimized lowering needs drawn
 * besides, every feature behind a swarm: containments most schemas declare and occurrences that read through them, wide
 * payload (unbounded TOAST-sized text and vectors) under takes whose stated order the checker completes over the
 * logical keys, total computed terms in projections and filters, equations between columns, filters read through a
 * region as the checker builds a where, closures read from one root, and more filters and takes. Computed terms are
 * total, so a runner comparing exact rows may treat an execution error as a defect; failing terms are the frontier
 * runner's, which judges error or rows against the reference.
 * The analysis soundness population: the generator's own, with what the analyses must judge per outer tuple and per
 * reader drawn besides, every feature behind a swarm (query.ts soundnessFeatures), stated orders so nodes carry the
 * logical claims the checker records, and more takes and semi-joins, whose keys and sharing the claims turn on.
 */
export const soundnessGenConfig: GenConfig = {
	...defaultGenConfig,
	query: {
		...defaultQueryConfig,
		soundness: true,
		statedOrders: true,
		imported: 4,
		weights: { ...defaultQueryConfig.weights, take: 3, semi: 3, anti: 2, window: 2, approximate: 1 }
	}
}

/**
 * The approximate-search population: the soundness population's every shape a conservative lowering accepts, its
 * approximate searches four times as often and no window, which no lowering accepts, with more takes; a source of more
 * rows than a search takes then ties at its cutoff wherever its scores do.
 */
export const annGenConfig: GenConfig = {
	...defaultGenConfig,
	query: {
		...defaultQueryConfig,
		soundness: true,
		statedOrders: true,
		imported: 4,
		weights: { ...defaultQueryConfig.weights, approximate: 4, window: 0, take: 3 }
	}
}

/**
 * The spelling control's population: every stored value its own spelling, twinned so that the facts of one relation and
 * the first facts of different relations hold one value class in different spellings ("twinned"), the palette only the
 * numeric types whose value classes have more than one spelling, unions and groups as often as the dense population
 * draws them, and no containment, whose copies of one stored literal never meet two spellings.
 */
export const spellingGenConfig: GenConfig = {
	...defaultGenConfig,
	schema: { ...defaultSchemaLimits, palette: "multiSpelling", containments: "none" },
	spelling: "twinned",
	query: { ...defaultQueryConfig, weights: { ...defaultQueryConfig.weights, union: 3, group: 3 } }
}

export const optimizerGenConfig: GenConfig = {
	...defaultGenConfig,
	schema: { ...defaultSchemaLimits, wide: "textAndVectors", containments: "often" },
	query: {
		...defaultQueryConfig,
		compute: 3,
		failing: false,
		statedOrders: true,
		follow: 3,
		imported: 4,
		equate: 2,
		rooted: true,
		regions: true,
		groupFilter: true,
		weights: {
			...defaultQueryConfig.weights,
			take: 5,
			filter: 5,
			closure: 2,
			union: 3,
			semiOver: 2
		}
	}
}

/**
 * The optimizer's population for the rewrite passes: wide payload of unbounded text alone (the reference evaluator
 * computes no vector), and filters drawn directly over groups, unions and set comparisons besides, the stages the
 * pushdown rules move a filter below or into (pushdown.group, pushdown.union, pushdown.left, pushdown.source), and
 * semi-joins over a keyed group, which pushdown.semiSource and pushdown.semiGroup rewrite.
 */
export const rewriteGenConfig: GenConfig = {
	...optimizerGenConfig,
	schema: { ...optimizerGenConfig.schema, wide: "text" },
	query: {
		...optimizerGenConfig.query,
		weights: { ...optimizerGenConfig.query.weights, filterOver: 14, semiOver: 8 }
	}
}

/**
 * The optimizer's population with failing terms: computed terms that divide, overflow or cast out of range on the
 * generated facts, judged by the frontier reference's must-fail and may-fail verdicts (test/pg/oracle/frontier), so
 * failure preservation is searched by the population that reaches every rewrite family, not only by the frontier's.
 */
export const optimizerFailingGenConfig: GenConfig = {
	...optimizerGenConfig,
	query: { ...optimizerGenConfig.query, failing: true }
}

/**
 * The rewrite passes' population with failing terms: the frontier reference judges, host-side, that a rewrite keeps
 * every failure the answer needs and invents none (test/unit/lower/rewrite/failures.test.ts).
 */
export const rewriteFailingGenConfig: GenConfig = {
	...rewriteGenConfig,
	query: { ...rewriteGenConfig.query, failing: true }
}

/**
 * The optimizer's population with the per-evaluation shapes of the analysis soundness population (query.ts
 * soundnessFeatures, behind its swarm): constants and correlated variables reading an earlier occurrence's source, takes
 * correlated to it, and a semi- or anti-join's right side shared with another reader, so the keys, at-most-one rows and
 * fixed columns that hold within one evaluation of a correlated subtree meet every rewrite and shape of the optimized
 * lowering on PostgreSQL. Windows stay out, as in every optimizer population.
 */
export const perEvaluationGenConfig: GenConfig = {
	...optimizerGenConfig,
	query: { ...optimizerGenConfig.query, soundness: true }
}

/**
 * The optimizer's population with every minted parameter named from the parameter-name dictionary (kernel/dict.ts):
 * names a page, a cursor or the generated SQL might read as its own.
 */
export const paramNameGenConfig: GenConfig = {
	...optimizerGenConfig,
	query: { ...optimizerGenConfig.query, paramNames: "dictionary" }
}

/**
 * Whole oracle cases and their configuration.
 *
 * A query case is a schema, its stored facts, and one checked query over them with the values of its parameters. It is
 * one flat record of sketches and swarms, resolved against each other (schema.ts, facts.ts, query.ts) with the swarms'
 * thinning decisions drawn from the case's tape, so every part of a failing case shrinks at once and the shrunk case is
 * still valid; printQueryCase renders it.
 */
export interface QueryCase {
	readonly schema: GenSchema
	readonly facts: GenFacts
	readonly query: GenQuery
	readonly spelling: Spelling
}

export interface QueryCaseSketch {
	readonly schema: SchemaSketch
	readonly facts: FactsSketch
	readonly spelling: ReadonlyArray<number>
	readonly root: RootSketch
	/** The picks the minted parameters' names take under QueryConfig.paramNames "dictionary", in minting order. */
	readonly paramNames: ReadonlyArray<number>
	/**
	 * The query and data swarms (query.ts queryFeatures, schema.ts dataFeatures), each the full swarm where the
	 * configuration draws none.
	 */
	readonly swarm: Swarm<QueryFeature>
	readonly data: Swarm<DataFeature>
	/** The second query swarm (query.ts rewriteFeatures), drawn where the configuration enables one of its features. */
	readonly rewrite: Swarm<RewriteFeature>
	/**
	 * The third query swarm (query.ts soundnessFeatures), drawn where the configuration draws the soundness population.
	 */
	readonly soundness: Swarm<SoundnessFeature>
}

/** The swarms of a sketch that draws none: every feature on at full weight. */
export const fullCaseSwarms: Pick<QueryCaseSketch, "swarm" | "data" | "rewrite" | "soundness"> = {
	swarm: fullQuerySwarm,
	data: fullDataSwarm,
	rewrite: fullRewriteSwarm,
	soundness: fullSoundnessSwarm
}

/** One spelling choice per value class a case spells (domain.ts spellingChoiceCount), each 0..2. */
export const spellingSketchGen: Gen<ReadonlyArray<number>> = array(int(0, 2), {
	min: spellingChoiceCount,
	max: spellingChoiceCount
})

/** The picks the minted parameters' names take under "dictionary" naming: eight, read in turn as names are minted. */
export const paramNamesSketchGen: Gen<ReadonlyArray<number>> = array(pickGen, { min: 8, max: 8 })

/** A swarm over `features` where `drawn`, the full one otherwise. */
const swarmOrFull = <F extends string>(
	drawn: boolean,
	features: Arr.NonEmptyReadonlyArray<F>,
	full: Swarm<F>
): Gen<Swarm<F>> => (drawn ? swarm(features) : constant(full))

export const queryCaseSketchGen = (config: GenConfig): Gen<QueryCaseSketch> => {
	const schema = schemaSketchGen(config.schema)
	const facts = factsSketchGen(config.facts, config.schema.maxRelations)
	const root = queryGenerators(config.query).root
	const querySwarm = swarmOrFull(config.swarm, queryFeatures, fullQuerySwarm)
	const dataSwarm = swarmOrFull(config.swarm, dataFeatures, fullDataSwarm)
	const rewrite = swarmOrFull(
		config.swarm && rewriteSwarmed(config.query),
		rewriteFeatures,
		fullRewriteSwarm
	)
	const soundness = swarmOrFull(
		config.swarm && config.query.soundness,
		soundnessFeatures,
		fullSoundnessSwarm
	)
	return (source) => ({
		schema: source.draw(schema),
		facts: source.draw(facts),
		spelling: source.draw(spellingSketchGen),
		root: source.draw(root),
		paramNames: source.draw(paramNamesSketchGen),
		swarm: source.draw(querySwarm),
		data: source.draw(dataSwarm),
		rewrite: source.draw(rewrite),
		soundness: source.draw(soundness)
	})
}

/**
 * The case a sketch resolves to, the swarms' thinning decisions drawn from the case's tape: none under full swarms,
 * whose features every place keeps.
 */
export const resolveQueryCase =
	(sketch: QueryCaseSketch, config: GenConfig): Gen<QueryCase> =>
	(source) => {
		const spelling: Spelling = {
			mode: config.spelling,
			choices: sketch.spelling,
			edge: config.edge
		}
		const schema = source.draw(resolveSchema(sketch.schema, spelling, sketch.data))
		const facts = resolveFacts(schema, sketch.facts, spelling, sketch.data)
		const query = source.draw(
			resolveQuery(
				schema,
				sketch.root,
				spelling,
				config.query,
				sketch.paramNames,
				sketch.swarm,
				sketch.rewrite,
				sketch.soundness
			)
		)
		return { schema, facts, query, spelling }
	}

/**
 * Query cases: 1-4 relations with composite and candidate keys, closed rosters and pure sets, small-domain facts, and
 * a well-scoped checked query (the conservative-oracle gate).
 */
export const queryCaseGen = (config: GenConfig): Gen<QueryCase> => {
	const sketch = queryCaseSketchGen(config)
	return (source) => source.draw(resolveQueryCase(source.draw(sketch), config))
}
