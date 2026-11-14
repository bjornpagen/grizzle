import { type Case, drawn, explore } from "@bjornpagen/testing/explore"
import { required } from "@bjornpagen/testing/features"
import { boolean, element, type Gen, map, oneOf } from "@bjornpagen/testing/gen"
import { notesOnly } from "@bjornpagen/testing/sense"
import { completeShrink } from "@bjornpagen/testing/shrink"
import { searched } from "@bjornpagen/testing/vitest"
import { describe, it } from "@effect/vitest"
import { Array as Arr, Effect, Formatter, Record as Rec, Result } from "effect"
import { NodeId } from "#compiler/core/ids.ts"
import { nodesByLabel, relNode, rooted } from "#compiler/ir/dag.ts"
import type { EvidenceCatalog, TemplateContext } from "#compiler/ir/evidence.ts"
import { deliveredInput, metaSpecOf, type RelDag } from "#compiler/ir/rel.ts"
import { placeDeduplication } from "#compiler/lower/optimize/dedup/place.ts"
import { assert, nonEmpty, succeeded } from "#test/support/assert.ts"
import { genCatalog } from "#test/support/evidence.ts"
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

import { Identities, type Interned } from "#test/support/kernel/identity.ts"
import { caseHang } from "#test/support/limits.ts"
import {
	noBindings,
	Reference,
	type ReferenceInput,
	unobserved
} from "#test/support/oracle/reference/evaluate.ts"
import { ReferenceUnsupported, rowIdentity } from "#test/support/oracle/reference/values.ts"
import { isElisionRule, verifyMultiplicity } from "#test/support/oracle/verify/multiplicity.ts"
import { FragmentReference, uniqueOn } from "#test/unit/analysis/physical/support.ts"
import { present } from "#test/unit/lower/support.ts"

/**
 * Placement is sound on the rows themselves.
 *
 * One population: the oracle generator's query cases, its rooted counterexample cases for what it seldom builds at a
 * root (projections, keyed and fan-out joins, witnesses, groups, projected groups, unions told apart by their tags and
 * not, bounds under EXISTS, closures acyclic or not), and noninjective key expressions; each read in a snapshot or a
 * transaction, its root delivered as it is or as an ordered result over its whole heading, every choice drawn with the
 * case. The plan's realization is evaluated by the fragment evaluator, which keeps exactly the repeats each fragment's
 * SQL would deliver (test/unit/analysis/physical/support.ts FragmentReference), and checked against the brute-force
 * reference, which deduplicates every node as the conservative lowering does:
 *
 * - the program's result has no repeated row and is exactly the reference set;
 * - every consumer that observes repeats, a fold, a bound, a page, an attachment, sees an input with one row per value
 *   of the heading it needs; a fold reads every row its input's fragment delivers, so a repeat that reaches one also
 *   changes the program's result;
 * - the kernel verification's recomputation (oracle/verify/multiplicity.ts) finds no problem in the plan.
 *
 * The population must reach every source, every rooted form, both contexts, an ordered delivery, a placed and an elided
 * duplicate elimination, and a delivery the reference evaluated, so a search that silently checks nothing fails.
 * "Unknown evidence gets conservative duplicate elimination, never guessed uniqueness": one counterexample fails the
 * suite.
 */

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

/** A case's source, each of the three as often, the rooted forms sharing theirs. */
const sourceGen: Gen<readonly [CaseSource, QueryCase]> = oneOf<readonly [CaseSource, QueryCase]>([
	map(queryCaseGen(defaultGenConfig), (c) => ["a generated query", c] as const),
	oneOf(
		nonEmpty(
			Arr.map(Rec.toEntries(rootedForms), ([name, root]) =>
				map(rootedCaseGen(root, defaultGenConfig), (c) => [`a rooted ${name}`, c] as const)
			),
			"a rooted form"
		)
	),
	map(noninjectiveKeyCaseGen, (c) => ["noninjective key expressions", c] as const)
])

const soundCaseGen: Gen<SoundCase> = (source) => {
	const [from, c] = source.draw(sourceGen)
	return {
		source: from,
		c,
		context: source.draw(element<TemplateContext>(["snapshot", "transaction"])),
		ordered: source.draw(boolean)
	}
}

/**
 * What a checked case reached: its source, its context, an ordered delivery, a placed duplicate elimination, an elided
 * one, and a delivery the reference evaluated.
 */
type DedupFeature =
	| CaseSource
	| TemplateContext
	| "an ordered delivery"
	| "a duplicate elimination placed"
	| "a duplicate elimination elided"
	| "a delivery evaluated"

const dedupFeatures: Arr.NonEmptyReadonlyArray<DedupFeature> = [
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

const sound = (dag: RelDag, input: ReferenceInput, env: Env, c: Case<DedupFeature>): void => {
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
const orderedRoot = (dag: RelDag): RelDag => {
	const input = present(dag.roots[0], "the root")
	const labels = nodesByLabel(dag)
	let k = labels.size
	while (labels.has(NodeId(`n${k}`))) {
		k++
	}
	const node = relNode(NodeId(`n${k}`), {
		kind: "OrderedResult",
		input,
		order: { keys: Arr.map(input.heading, (c) => ({ column: c.name, dir: "asc" as const })) },
		heading: input.heading,
		meta: metaSpecOf(input.meta),
		loc: undefined
	})
	return validateDag(rooted([node]))
}

describe("placement delivers the reference set with no repeats", () => {
	it.effect(
		"on generated, rooted and noninjective cases in either context, ordered or not",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "second-implementation",
							name: "the brute-force reference, which deduplicates every node"
						},
						suite: "unit/lower/dedup/soundness",
						literal: Formatter.format,
						kept: [],
						draw: drawn(soundCaseGen),
						runs: 1_000,
						shrink: completeShrink,
						coverage: required<DedupFeature>(dedupFeatures, { cases: 1_000, sense: notesOnly }),
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(k, c) =>
						Effect.sync(() => {
							const input = {
								schema: k.c.schema,
								facts: k.c.facts,
								params: k.c.query.params,
								observer: unobserved
							}
							const dag = k.ordered ? orderedRoot(k.c.query.dag) : k.c.query.dag
							sound(
								dag,
								input,
								{ context: k.context, catalog: genCatalog(input.schema), roots: "result" },
								c
							)
							c.note(k.source)
							c.note(k.context)
							if (k.ordered) {
								c.note("an ordered delivery")
							}
						})
				)
			)
	)
})
