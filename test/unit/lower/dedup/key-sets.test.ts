/**
 * An attachment's parent key set deduplicates exactly where the rows it reads prove no key over it: in every
 * attachment part of an optimized program, the set's core is SELECT DISTINCT exactly when keys.ts keySetOf leaves it
 * unproved, and a plain core where it proves it, so no statement deduplicates a set its parent's keys already make one
 * and none reads as it is a set they do not. Compile-only.
 *
 * - Over generated programs: the oracle generator's per-evaluation population (test/support/oracle/gen/case.ts
 *   perEvaluationGenConfig), every root attached, with chains of attachments nested below a child under its own
 *   per-parent take, each compiled as a query is (admitted, annotated, lowerOptimized) and, where every column of its
 *   root is ordered, ordered by its heading and compiled as a page, whose four requests' programs hold key sets of their
 *   own (lower/shapes/page/compile.ts).
 * - Over the platform's billing reads: every read of the platform's workload (test/support/fixtures/api/platform.ts
 *   platformWorkload), compiled as billing compiles it.
 *
 * Oracle: keySetOf over the physical analysis of the program's own placement (shapes/share/physical.ts
 * shapeFactsFromPlan), at the rows each set reads (test/support/key-sets.ts keySetSites): a rows part's, the delivered
 * relation's (an ordered result's input) or a heterogeneous union's, with the free references that say whether they are
 * evaluated once; or an attachment's children, whose key within one parent holds across parents only through the
 * correlation that fixes their parent (keys.ts parentFixed). That a set the statement reads as it is holds no repeated
 * key on PostgreSQL is the optimized differential's (test/pg/oracle/optimized/support.ts, keySetRepeats).
 *
 * Plants: every key set read through DISTINCT (conservative/deliver.ts keysOf) fails a proved set, which both
 * populations reach; a key set read as it is where keySetOf leaves it unproved fails an unproved one. Kept: the
 * page/generated-optimized case at TEST_SEED=28094260, whose nested key set holds a key within one parent only, and its
 * twin paired on the column that fixes the parent, whose nested key set is proved across parents (cases.ts).
 */
import { describe, it } from "@effect/vitest"
import { drawn, exhaust, explore, type Kept } from "@grizzle/testing/explore"
import { required, requiredInSpace } from "@grizzle/testing/features"
import { element } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Record as Rec } from "effect"
import type { CompileError } from "#compiler/core/errors.ts"
import { NodeId } from "#compiler/core/ids.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import * as Engine from "#compiler/core/result.ts"
import { deliverySpine, relNode, rooted } from "#compiler/ir/dag.ts"
import type { EvidenceCatalog } from "#compiler/ir/evidence.ts"
import type { PhysicalNames } from "#compiler/ir/physical.ts"
import type { LogicalQuery } from "#compiler/ir/products.ts"
import type { RelNode, RootedDag } from "#compiler/ir/rel.ts"
import { checkerEvidence } from "#compiler/logical/annotate.ts"
import { LowerContext } from "#compiler/lower/conservative/context.ts"
import { dispatchNode } from "#compiler/lower/conservative/dispatch.ts"
import { type KeySetProof, keySetOf, parentFixed } from "#compiler/lower/conservative/keys.ts"
import type { ConservativeParamSlot } from "#compiler/lower/conservative/types.ts"
import {
	lowerOptimized,
	type OptimizedProgram,
	optimizedInput
} from "#compiler/lower/optimize/pipeline.ts"
import type { DeliveredPart, StatementParts } from "#compiler/lower/shapes/index.ts"
import { compilePage } from "#compiler/lower/shapes/page/compile.ts"
import type { PageVariant } from "#compiler/lower/shapes/page/seek.ts"
import { discardCertificates, shapeFactsFromPlan } from "#compiler/lower/shapes/share/physical.ts"
import { isOrderedValue, isQueryValue } from "#compiler/query/build/query.ts"
import { keyColumns, type RowsRole, type StatementRoots } from "#compiler/runtime/lower/tree.ts"
import { hasCapability } from "#compiler/scalar/registry.ts"
import { assert, nonEmpty, succeeded } from "#test/support/assert.ts"
import {
	admitGenerated,
	compileTemplateOver,
	testArtifacts,
	testCompile
} from "#test/support/compile.ts"
import { genCatalog } from "#test/support/evidence.ts"
import * as P from "#test/support/fixtures/api/platform.ts"
import { standInNames } from "#test/support/kernel/naming.ts"
import {
	correlatedChildUnderNestedAttachment,
	type KeySetSite,
	keySetSites
} from "#test/support/key-sets.ts"
import { caseHang } from "#test/support/limits.ts"
import {
	type GenConfig,
	perEvaluationGenConfig,
	type QueryCase,
	queryCaseGen
} from "#test/support/oracle/gen/case.ts"
import { printQueryCase } from "#test/support/oracle/gen/print.ts"
import { genParamDecls } from "#test/support/oracle/gen/query.ts"
import { schemaCodes } from "#test/support/oracle/gen/schema.ts"
import { acrossParentsCase, withinOneParentCase } from "#test/unit/lower/dedup/cases.ts"

/**
 * What a program's key sets reached: a set proved and one unproved; a nested set proved across parents by the
 * correlation that fixes its parent; a nested set whose key holds within one parent only, deduplicated; the shape that
 * puts one there, a correlated child under a nested attachment (key-sets.ts); and a page request's set.
 */
type KeySetFeature =
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
const judge = (j: Judged, note: (feature: KeySetFeature) => void): number => {
	const dag = j.optimized.query.dag
	const facts = shapeFactsFromPlan(j.optimized.plan, {
		derivedDefinition: false,
		certify: discardCertificates
	})
	const cx = new LowerContext(
		dag,
		{ names: j.names, params: j.optimized.query.params, subject: { kind: "query" } },
		dispatchNode
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
const judgeCase = (c: QueryCase, note: (feature: KeySetFeature) => void): void => {
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

const keptCases: ReadonlyArray<Kept<QueryCase, KeySetFeature>> = [
	{
		note: "page/generated-optimized, TEST_SEED=28094260: a nested key set whose parent rows are a take of one row per parent, keyed by a within one parent only",
		sketch: withinOneParentCase(),
		draws: "",
		reaches: ["a key of one parent, deduplicated across parents"]
	},
	{
		note: "the TEST_SEED=28094260 case with its nested attachment paired on the column that fixes the parent too",
		sketch: acrossParentsCase(),
		draws: "",
		reaches: ["a key set proved across parents by the correlation that fixes them"]
	}
]

/** The platform's reads, by name: every program of its workload that is a query. */
const billingReads = Object.freeze(
	Arr.filter(
		Rec.toEntries(P.platformWorkload.programs),
		([, value]) => isQueryValue(value) || isOrderedValue(value)
	)
)

describe("an attachment's parent key set deduplicates exactly where it is unproved", () => {
	it.effect("on generated programs, their pages' included", (ctx) =>
		searched(
			ctx,
			explore(
				{
					oracle: {
						kind: "specification",
						name: "keys.ts keySetOf over the program's own placement"
					},
					suite: "unit/lower/dedup/key-sets",
					literal: Formatter.format,
					kept: keptCases,
					draw: drawn(queryCaseGen(keySetConfig)),
					runs: 200,
					shrink: completeShrink,
					coverage: required<KeySetFeature>(
						[
							"a proved key set",
							"an unproved key set",
							"a correlated child under a nested attachment",
							"a page request's key set"
						],
						{ cases: 200, sense: notesOnly }
					),
					concurrency: 1,
					steerEvery: 16,
					caseHang
				},
				(c, k) => Effect.sync(() => judgeCase(c, k.note))
			)
		)
	)

	it.effect("on every billing read of the platform", (ctx) =>
		searched(
			ctx,
			Effect.gen(function* () {
				const artifacts = succeeded(testArtifacts(P.Billing, testCompile), "the billing artifacts")
				const reads = new Map(billingReads)
				return yield* exhaust(
					{
						box: "every read of the platform's workload",
						oracle: {
							kind: "specification",
							name: "keys.ts keySetOf over the read's own placement"
						},
						suite: "unit/lower/dedup/key-sets-billing",
						generator: element(
							nonEmpty(
								Arr.map(billingReads, ([name]) => name),
								"a read"
							)
						),
						literal: Formatter.format,
						coverage: requiredInSpace<KeySetFeature>(["a proved key set"]),
						caseHang
					},
					(name, c) =>
						Effect.sync(() => {
							const template = succeeded(
								compileTemplateOver(reads.get(name), P.Billing, artifacts, testCompile),
								`${name} compiles`
							)
							judge(
								{
									where: name,
									program: template.programs.optimized,
									optimized: template.programs.optimized,
									names: artifacts.names
								},
								c.note
							)
						})
				)
			})
		)
	)
})
