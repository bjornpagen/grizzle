/** What the properties of soundness.test.ts read: its spaces, models and helpers. */

import { assert, nonEmpty } from "@bjornpagen/testing/assert"
import { type Aimed, aimed, boolean, element, type Gen, map, oneOf } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Record as Rec, Result } from "effect"
import { NodeId } from "#compiler/core/ids.ts"
import { nodesByLabel, relNode, rooted } from "#compiler/ir/dag.ts"
import type { EvidenceCatalog, TemplateContext } from "#compiler/ir/evidence.ts"
import { deliveredInput, metaSpecOf, type RelDag } from "#compiler/ir/rel.ts"
import { placeDeduplication } from "#compiler/lower/optimize/dedup/place.ts"
import { succeeded } from "#test/support/assert.ts"
import { Identities, type Interned } from "#test/support/kernel/identity.ts"
import { validateDag } from "#test/support/oracle/dag-validate.ts"
import { defaultGenConfig, type QueryCase, queryCaseGen } from "#test/support/oracle/gen/case.ts"
import {
	closureRoot,
	existsOverTakeRoot,
	fanoutJoinRoot,
	groupRoot,
	keyedJoinRoot,
	noninjectiveKeyCaseGen,
	projectGroupRoot,
	projectRoot,
	rootedCaseGen,
	taggedUnionRoot,
	untaggedUnionRoot,
	witnessRoot
} from "#test/support/oracle/mutants/cases.ts"
import {
	noBindings,
	Reference,
	type ReferenceInput
} from "#test/support/oracle/reference/evaluate.ts"
import { ReferenceUnsupported, rowIdentity } from "#test/support/oracle/reference/values.ts"
import { isElisionRule, verifyMultiplicity } from "#test/support/oracle/verify/multiplicity.ts"
import { FragmentReference, uniqueOn } from "#test/unit/analysis/physical/support.ts"
import { present } from "#test/unit/lower/support.ts"

/** What placement reads: the context a case is read in, its catalog, and its result as the only root. */
interface Env {
	readonly context: TemplateContext
	readonly catalog: EvidenceCatalog
	readonly roots: "result"
}

/** The rooted counterexample forms, by name. */
const rootedForms = {
	"a projection": projectRoot,
	"a keyed join": keyedJoinRoot,
	"a fan-out join": fanoutJoinRoot,
	"a witness": witnessRoot,
	"a group": groupRoot,
	"a projected group": projectGroupRoot,
	"a tagged union": taggedUnionRoot,
	"an untagged union": untaggedUnionRoot,
	"a bound under EXISTS": existsOverTakeRoot,
	"a closure": closureRoot(false),
	"an acyclic closure": closureRoot(true)
} as const

type RootedForm = keyof typeof rootedForms

/** Where a case was drawn from: the generator's own query, a rooted form, or noninjective key expressions. */
type CaseSource = "a generated query" | `a rooted ${RootedForm}` | "noninjective key expressions"

/** A case of the population: its source, its query case, the context it is read in and whether it is ordered. */
interface SoundCase {
	readonly source: CaseSource
	readonly c: QueryCase
	readonly context: TemplateContext
	readonly ordered: boolean
}

/** A source of cases, under its name. */
type Sourced = readonly [CaseSource, Gen<QueryCase>]

/** The generator's own queries. */
const generatedSource: Sourced = ["a generated query", queryCaseGen(defaultGenConfig)]

/** The rooted forms, each built at a root of the generator's cases. */
const rootedSources: Arr.NonEmptyReadonlyArray<Sourced> = nonEmpty(
	Arr.map(Rec.toEntries(rootedForms), ([name, root]): Sourced => [
		`a rooted ${name}`,
		rootedCaseGen(root, defaultGenConfig)
	]),
	"a rooted form"
)

/** Noninjective key expressions. */
const noninjectiveSource: Sourced = ["noninjective key expressions", noninjectiveKeyCaseGen]

/** A source's cases, each under the source's name. */
const named = ([name, cases]: Sourced): Gen<readonly [CaseSource, QueryCase]> =>
	map(cases, (c) => [name, c] as const)

/** A case's source, each of the three as often, the rooted forms sharing theirs. */
const sourceGen: Gen<readonly [CaseSource, QueryCase]> = oneOf([
	named(generatedSource),
	oneOf(Arr.map(rootedSources, named)),
	named(noninjectiveSource)
])

/** A case drawn from `sources`, read in either context, ordered or not. */
const soundCaseOf =
	(sources: Gen<readonly [CaseSource, QueryCase]>): Gen<SoundCase> =>
	(source) => {
		const [from, c] = source.draw(sources)
		return {
			source: from,
			c,
			context: source.draw(element<TemplateContext>(["snapshot", "transaction"])),
			ordered: source.draw(boolean)
		}
	}

/**
 * The population, aimed at its sources: a case whose turn aims at a source no case has reached yet draws from that
 * source alone, so every rooted form, an eleventh of a third of the population each, is reached within the witnesses.
 */
export const soundCases: Aimed<SoundCase, DedupFeature> = aimed(
	soundCaseOf(sourceGen),
	Arr.map(
		[generatedSource, ...rootedSources, noninjectiveSource],
		(sourced) => [sourced[0], soundCaseOf(named(sourced))] as const
	)
)

/**
 * What a checked case reached: its source, its context, an ordered delivery, a placed duplicate elimination, an elided
 * one, and a delivery the reference evaluated.
 */
export type DedupFeature =
	| CaseSource
	| TemplateContext
	| "an ordered delivery"
	| "a duplicate elimination placed"
	| "a duplicate elimination elided"
	| "a delivery evaluated"

export const dedupFeatures: Arr.NonEmptyReadonlyArray<DedupFeature> = [
	"a generated query",
	...Arr.map(Rec.keys(rootedForms), (name): DedupFeature => `a rooted ${name}`),
	"noninjective key expressions",
	"snapshot",
	"transaction",
	"an ordered delivery",
	"a duplicate elimination placed",
	"a duplicate elimination elided",
	"a delivery evaluated"
]

export const sound = (
	dag: RelDag,
	input: ReferenceInput,
	env: Env,
	c: Case<DedupFeature>
): void => {
	const plan = succeeded(placeDeduplication(dag, env), "the placement")
	const verified = succeeded(verifyMultiplicity(dag, plan, env), "the verification")
	assert.deepEqual(verified.problems, [])
	if (plan.placements.length > 0) {
		c.note("a duplicate elimination placed")
	}
	if (Arr.some(plan.certificates, (cert) => isElisionRule(cert.rule))) {
		c.note("a duplicate elimination elided")
	}
	/**
	 * The repeats the emitted SQL delivers: a node that only delivers another node's rows (an attachment, a law query,
	 * an ordered result) lowers as that node, so a DISTINCT realized on it is never emitted.
	 */
	const fragments = FragmentReference.delivered(dag, input, (node) =>
		deliveredInput(node) !== undefined ? "plain" : (plan.realization[node.id] ?? "plain")
	)
	const reference = Reference.of(dag, input)
	const evaluated = Result.try({
		try: (): void => {
			for (const root of dag.roots) {
				if (root.kind === "Forbid" || !fragments.closed(root)) {
					continue
				}
				const delivered = fragments.eval(root, noBindings)
				const columns = Arr.map(delivered.heading, (h) => h.name)
				if (!uniqueOn(delivered.heading, delivered.rows, columns)) {
					throw new Error(`repeated rows delivered at ${root.id}`)
				}
				const expected = reference.eval(root, noBindings)
				const identities = new Identities()
				const counts = (rows: typeof delivered.rows): ReadonlyMap<Interned, number> => {
					const out = new Map<Interned, number>()
					for (const r of rows) {
						const key = identities.of(rowIdentity(r, delivered.heading))
						out.set(key, (out.get(key) ?? 0) + 1)
					}
					return out
				}
				assert.deepEqual(counts(delivered.rows), counts(expected.rows))
			}
			for (const o of plan.analysis.obligations) {
				if (o.edge.consumer.kind === "result" || !fragments.closed(o.edge.input)) {
					continue
				}
				const rel = fragments.eval(o.edge.input, noBindings)
				if (!uniqueOn(rel.heading, rel.rows, o.heading)) {
					throw new Error(
						`${o.edge.consumer.node.id} observes repeats of ${o.edge.input.id} on (${Arr.join(o.heading, ", ")})`
					)
				}
			}
			c.note("a delivery evaluated")
		},
		catch: (thrown): unknown => thrown
	})
	if (Result.isFailure(evaluated) && !(evaluated.failure instanceof ReferenceUnsupported)) {
		throw evaluated.failure
	}
}

/** The same query delivered in order: its root under an OrderedResult over the whole heading, a total order. */
export const orderedRoot = (dag: RelDag): RelDag => {
	const input = present(dag.roots[0], "the root")
	const labels = nodesByLabel(dag)
	let k = labels.size
	while (labels.has(NodeId(`n${k}`))) {
		k++
	}
	const node = relNode(NodeId(`n${k}`), {
		kind: "OrderedResult",
		input,
		orders: [{ keys: Arr.map(input.heading, (c) => ({ column: c.name, dir: "asc" as const })) }],
		heading: input.heading,
		meta: metaSpecOf(input.meta),
		loc: undefined
	})
	return validateDag(rooted([node]))
}
