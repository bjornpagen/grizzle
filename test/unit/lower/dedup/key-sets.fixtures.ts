/** What the properties of key-sets.test.ts read: its spaces, models and helpers. */

import * as Engine from "@bjornpagen/grizzle-text/base/result"
import { assert } from "@bjornpagen/testing/assert"
import { type Aimed, aimed } from "@bjornpagen/testing/gen"
import type { Need } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Record as Rec } from "effect"
import type { CompileError } from "#compiler/core/errors.ts"
import { NodeId } from "#compiler/core/ids.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { deliverySpine, relNode, rooted } from "#compiler/ir/dag.ts"
import type { EvidenceCatalog } from "#compiler/ir/evidence.ts"
import type { PhysicalNames } from "#compiler/ir/physical.ts"
import type { LogicalQuery } from "#compiler/ir/products.ts"
import type { RelNode, RootedDag } from "#compiler/ir/rel.ts"
import { checkerEvidence } from "#compiler/logical/annotate.ts"
import {
	carriesNothing,
	evaluatedAsItStands,
	LowerContext
} from "#compiler/lower/conservative/context.ts"
import { dispatchNode } from "#compiler/lower/conservative/dispatch.ts"
import { keySetOf, type KeySetProof, parentFixed } from "#compiler/lower/conservative/keys.ts"
import type { ConservativeParamSlot } from "#compiler/lower/conservative/types.ts"
import {
	lowerOptimized,
	optimizedInput,
	type OptimizedProgram
} from "#compiler/lower/optimize/pipeline.ts"
import type { DeliveredPart, StatementParts } from "#compiler/lower/shapes/index.ts"
import { compilePage } from "#compiler/lower/shapes/page/compile.ts"
import type { PageVariant } from "#compiler/lower/shapes/page/seek.ts"
import { discardCertificates, shapeFactsFromPlan } from "#compiler/lower/shapes/share/physical.ts"
import { isOrderedValue, isQueryValue } from "#compiler/query/build/query.ts"
import { keyColumns, type RowsRole, type StatementRoots } from "#compiler/runtime/lower/tree.ts"
import { hasCapability } from "#compiler/scalar/registry.ts"
import { succeeded } from "#test/support/assert.ts"
import { fixtureNeedBudget } from "#test/support/budgets.ts"
import { admitGenerated, testArtifacts, testCompile } from "#test/support/compile.ts"
import { genCatalog } from "#test/support/evidence.ts"
import * as P from "#test/support/fixtures/api/platform.ts"
import { standInNames } from "#test/support/kernel/naming.ts"
import {
	correlatedChildUnderNestedAttachment,
	type KeySetSite,
	keySetSites
} from "#test/support/key-sets.ts"
import {
	type GenConfig,
	perEvaluationGenConfig,
	type QueryCase,
	queryCaseGen
} from "#test/support/oracle/gen/case.ts"
import { printQueryCase } from "#test/support/oracle/gen/print.ts"
import { genParamDecls } from "#test/support/oracle/gen/query.ts"
import { schemaCodes } from "#test/support/oracle/gen/schema.ts"
import { perParentNestedGen } from "#test/unit/lower/dedup/cases.ts"

/**
 * What a program's key sets reached: a set proved and one unproved; a nested set proved across parents by the
 * correlation that fixes its parent; a nested set whose key holds within one parent only, deduplicated; the shape that
 * puts one there, a correlated child under a nested attachment (key-sets.ts); and a page request's set.
 */
export type KeySetFeature =
	| "a proved key set"
	| "an unproved key set"
	| "a key set proved across parents by the correlation that fixes them"
	| "a key of one parent, deduplicated across parents"
	| "a correlated child under a nested attachment"
	| "a page request's key set"
	| "a query the optimized lowering refuses"

/** The per-evaluation population with every root attached: a plain or heterogeneous root holds no key set. */
const keySetConfig: GenConfig = {
	...perEvaluationGenConfig,
	query: {
		...perEvaluationGenConfig.query,
		roots: { plain: 0, attach: 1, hetero: 0 }
	}
}

/**
 * The per-evaluation population with every root attached, aimed: a case whose turn aims at a nested key set of one
 * parent, or at one proved across parents, draws the page/generated-optimized counterexample's shape with its nested
 * attachment's correlation drawn (cases.ts perParentNestedGen), which the population seldom builds.
 */
export const keySetCases: Aimed<QueryCase, KeySetFeature> = aimed(queryCaseGen(keySetConfig), [
	["a key of one parent, deduplicated across parents", perParentNestedGen],
	["a key set proved across parents by the correlation that fixes them", perParentNestedGen]
])

/** The page requests, each a program of its own. */
const pageVariants: Arr.NonEmptyReadonlyArray<PageVariant> = ["first", "last", "after", "before"]

/**
 * The node whose rows a rows part of `dag`'s program delivers, and its attachments' key sets read: the delivered
 * relation, an ordered result's input; for a heading group, the heterogeneous union its rows are a group of.
 */
const rowsOrigin = (dag: RootedDag, role: RowsRole): RelNode => {
	const root = dag.roots[0]
	const rows = root.kind === "OrderedResult" ? root.input : root
	if (role.kind === "main") {
		return rows
	}
	const union = deliverySpine(rows).arms?.union
	if (union === undefined) {
		throw new Error(`heading group ${role.group} of a program over no heterogeneous union`)
	}
	return union
}

/** One program to judge: its statement's parts and tree, the DAG it lowers and the placement it lowers under. */
interface Judged {
	readonly where: string
	readonly program: {
		readonly parts: StatementParts<ConservativeParamSlot>
		readonly roots: StatementRoots<DeliveredPart>
	}
	readonly optimized: OptimizedProgram
	readonly names: PhysicalNames
}

/**
 * Each key set of a program against keySetOf at the rows it reads, the features it reached noted, and how many it
 * judged. The facts are the placement's the program was lowered under, and the free references the program's DAG's.
 */
export const judge = (j: Judged, note: (feature: KeySetFeature) => void): number => {
	const dag = j.optimized.query.dag
	const facts = shapeFactsFromPlan(j.optimized.plan, {
		derivedDefinition: false,
		certify: discardCertificates
	})
	const cx = new LowerContext(
		dag,
		{ names: j.names, params: j.optimized.query.params, subject: { kind: "query" } },
		dispatchNode,
		evaluatedAsItStands,
		carriesNothing
	)
	const proofOf = (site: KeySetSite): KeySetProof => {
		const parent = site.parent
		if (parent.kind === "rows") {
			const node = rowsOrigin(dag, parent.role)
			return keySetOf(site.demand, facts.keyedBy(node, site.demand), cx.freeRefs(node), undefined)
		}
		const node = parent.attach.child
		return keySetOf(
			site.demand,
			facts.keyedBy(node, site.demand),
			cx.freeRefs(node),
			parentFixed(parent.attach, keyColumns(parent.part.role))
		)
	}
	const sites = keySetSites(j.program)
	for (const site of sites) {
		const proof = proofOf(site)
		assert.equal(
			site.deduplicates,
			proof.kind === "unproved",
			`${j.where}: the key set of ${site.attach.name} over (${Arr.join(site.demand, ", ")}) ${
				site.deduplicates ? "deduplicates" : "is read as it is"
			}, and keySetOf finds it ${proof.kind}`
		)
		if (proof.kind === "proved") {
			note("a proved key set")
			if (proof.key.across.kind === "parentFixed") {
				note("a key set proved across parents by the correlation that fixes them")
			}
			continue
		}
		note("an unproved key set")
		if (
			site.parent.kind === "children" &&
			facts.keyedBy(site.parent.attach.child, site.demand) !== undefined
		) {
			note("a key of one parent, deduplicated across parents")
		}
	}
	return sites.length
}

/** The query of a generated case, as a compilation hands it to the optimized lowering. */
const optimizedOf = (
	query: LogicalQuery,
	names: PhysicalNames,
	catalog: EvidenceCatalog
): Engine.Result<OptimizedProgram, CompileError> =>
	Engine.flatMap(
		Engine.flatMap(admitGenerated(query), (q) => optimizedInput(q, checkerEvidence)),
		(input) =>
			lowerOptimized(input, { names, catalog, subject: { kind: "query" }, context: "snapshot" })
	)

/** The case's query ordered by its root's heading, ascending, or none where a column of it has no admitted order. */
const orderedQuery = (c: QueryCase): LogicalQuery | undefined => {
	const top = c.query.dag.roots[0]
	if (
		!Arr.every(
			top.heading,
			(col) => hasCapability(col.type, "ordering") && hasCapability(col.type, "equality")
		)
	) {
		return undefined
	}
	const node = relNode(NodeId("ordered"), {
		kind: "OrderedResult",
		input: top,
		order: { keys: Arr.map(top.heading, (col) => ({ column: col.name, dir: "asc" as const })) },
		heading: top.heading,
		meta: top.meta,
		loc: undefined
	})
	return { dag: rooted([node]), params: genParamDecls(c.query) }
}

/**
 * A generated case's programs judged: its query's, and, where its root is ordered, its page's four requests'. A query
 * the optimized lowering refuses holds no key set, and is noted as such: the lowering's totality is the page and
 * lowering suites'; a page the page compiler refuses has no requests to judge.
 */
export const judgeCase = (c: QueryCase, note: (feature: KeySetFeature) => void): void => {
	const names = standInNames(c.schema.name, schemaCodes(c.schema))
	const catalog = genCatalog(c.schema)
	const query = { dag: c.query.dag, params: genParamDecls(c.query) }
	const optimized = optimizedOf(query, names, catalog)
	if (!optimized.ok) {
		note("a query the optimized lowering refuses")
		return
	}
	const where = printQueryCase(c)
	judge({ where, program: optimized.value, optimized: optimized.value, names }, note)
	if (correlatedChildUnderNestedAttachment(optimized.value.query.dag)) {
		note("a correlated child under a nested attachment")
	}
	const ordered = orderedQuery(c)
	const orderedProgram = ordered === undefined ? undefined : optimizedOf(ordered, names, catalog)
	if (ordered === undefined || orderedProgram === undefined || !orderedProgram.ok) {
		return
	}
	const page = compilePage({
		checked: ordered,
		optimized: orderedProgram.value,
		names,
		stated: { keys: [], at: SourceLoc("generated orderBy", []) }
	})
	if (!page.ok) {
		return
	}
	for (const variant of pageVariants) {
		const judged = judge(
			{
				where: `the ${variant} request of the page over ${where}`,
				program: page.value.artifact.requests[variant].program,
				optimized: orderedProgram.value,
				names
			},
			note
		)
		if (judged > 0) {
			note("a page request's key set")
		}
	}
}

/** The platform's reads, by name: every program of its workload that is a query. */
export const billingReads = Object.freeze(
	Arr.filter(
		Rec.toEntries(P.platformWorkload.programs),
		([, value]) => isQueryValue(value) || isOrderedValue(value)
	)
)

export const artifacts = succeeded(testArtifacts(P.Billing, testCompile), "the billing artifacts")

/** What the search built once before its cases (reads), now once per worker: every case on it reads them. */
export const readsNeed = {
	key: "test/unit/lower/dedup/key-sets.fixtures.ts readsNeed",
	budget: fixtureNeedBudget,
	runNeeds: [],
	open: Effect.sync(() => {
		const reads = new Map(billingReads)
		return Effect.succeed(reads)
	})
} as const satisfies Need<unknown>
