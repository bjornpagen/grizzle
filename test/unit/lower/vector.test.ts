import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Duration, Effect, Formatter, Option } from "effect"
import { checkQuery } from "#compiler/check/index.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import { identity } from "#compiler/core/identity.ts"
import { ExprId, NodeId } from "#compiler/core/ids.ts"
import * as Result from "#compiler/core/result.ts"
import { canonicalZero } from "#compiler/ir/carriers.ts"
import { rebuildDag, relNode, rooted, topoOrder, unchangedEdges } from "#compiler/ir/dag.ts"
import { builtExpr } from "#compiler/ir/expr.ts"
import type { LogicalQuery } from "#compiler/ir/products.ts"
import {
	metaSpecOf,
	type NodeOf,
	type NodeOver,
	type RelNode,
	type ValueRefs
} from "#compiler/ir/rel.ts"
import { flight } from "#compiler/lower/conservative/types.ts"
import type { OptimizedProgram } from "#compiler/lower/optimize/pipeline.ts"
import { compileInstallation, installOptions } from "#compiler/physical/install/compile.ts"
import { queryInput } from "#compiler/program/compile.ts"
import { Compute } from "#compiler/public/compute.ts"
import { uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import type { SqlStatement } from "#compiler/sql/ast.ts"
import { identityHooks, transformStatement } from "#compiler/sql/transform.ts"
import { assert, refused, succeeded } from "#test/support/assert.ts"
import { lowerAligned } from "#test/support/compile.ts"
import { installedCatalog } from "#test/support/evidence.ts"
import {
	candidates,
	Document,
	DocumentCurrent,
	DocumentEmbedding,
	Search
} from "#test/support/fixtures/api/search.ts"
import { parsedSchemaName } from "#test/support/kernel/naming.ts"
import { validateDag } from "#test/support/oracle/dag-validate.ts"
import { checking, checkOptions, owning } from "#test/support/policy.ts"
import { nodeOfKind } from "#test/unit/lower/support.ts"

/** A node rebuilt over its rebuilt inputs, the node itself where none changed (ir/dag.ts rebuildDag). */
const kept = (node: RelNode, inputs: NodeOver<ValueRefs<RelNode>>): RelNode =>
	unchangedEdges(node, inputs) ? node : relNode(node.id, { ...inputs, meta: metaSpecOf(node.meta) })

/**
 * approximateNearest in the optimized lowering: one search per execution, never one per parent, and the refusals of
 * placements that would run it more often. The indexed statements run on PostgreSQL in test/pg/vector/ann, which
 * checks their plans; here a search is counted on the AST as a query ranked by the cosine distance.
 *
 * The rule, over a planted space of placements (the checker builds only some of them; the others are hand-built DAGs
 * the lowering must refuse on its own): a search is admitted exactly when one execution computes it once, outside any
 * per-row subquery, so the program holds one search per search node, none under a sublink; a search that a statement
 * of its own would compute again (a child read by its parent too, an attachment of a child over candidates), that a
 * root reads beside the child, or whose own source reads the parent variable (one search per parent), is refused as
 * UnsupportedOperation, by the checker or by the lowering. A search in a derived relation's definition is refused, and
 * the lowering traces the search again on the DAG it lowers, refusing a score that is no longer the cosine distance.
 */

const ownedSearch = owning(Search)
const installation = succeeded(
	compileInstallation(ownedSearch, {
		...installOptions(ownedSearch, "grizzle_dev"),
		installation: identity.schema(parsedSchemaName("search"))
	})
)
/** The installation's own catalog (laws/model/catalog.ts), as compileQuery reads it before admission. */
const catalog = installedCatalog(installation)

const checkedResult = (q: unknown): Result.Result<LogicalQuery, CompileError> =>
	Result.flatMap(queryInput(q), (input) =>
		checkQuery(checking(Search), input.desc, checkOptions("query"))
	)

const checked = (q: unknown): LogicalQuery => succeeded(checkedResult(q))

const lowered = (
	q: LogicalQuery,
	purpose: "query" | "derivedDefinition"
): Result.Result<OptimizedProgram, CompileError> =>
	lowerAligned(q, purpose, {
		names: installation.names,
		context: "snapshot",
		catalog
	})

/** The queries of a statement that rank by the cosine distance: one per approximate search the statement runs. */
const searchesIn = (ast: SqlStatement): number => {
	let searches = 0
	transformStatement(ast, {
		...identityHooks,
		select: (s) => {
			if (Arr.some(s.orderBy, (item) => item.expr.kind === "binary" && item.expr.op === "<=>")) {
				searches++
			}
			return s
		}
	})
	return searches
}

/**
 * The subquery expressions of a statement, at any depth, that run a search: each runs it once per row of the query
 * around it.
 */
const searchesPerRow = (ast: SqlStatement): number => {
	let sublinks = 0
	transformStatement(ast, {
		...identityHooks,
		expr: (e) => {
			if (
				(e.kind === "exists" || e.kind === "subquery" || e.kind === "array") &&
				searchesIn(e.query) > 0
			) {
				sublinks++
			}
			return e
		}
	})
	return sublinks
}

/**
 * The checked DAG of `q`, its attachment child wrapped in an ApproximateNearest node over the child's projection: a
 * DAG the checker refuses to build, which the lowering must refuse on its own.
 */
const searchUnderAttach = (q: LogicalQuery): LogicalQuery => {
	const attach = Option.getOrThrowWith(
		Arr.findFirst(topoOrder(q.dag), (n): n is NodeOf<"Attach"> => n.kind === "Attach"),
		() => new Error("an attachment")
	)
	const dag = validateDag(
		rebuildDag(q.dag, (node, inputs) => {
			if (node !== attach || inputs.kind !== "Attach") {
				return kept(node, inputs)
			}
			const child = inputs.child
			const search = relNode(NodeId("n_search"), {
				kind: "ApproximateNearest",
				source: child,
				score: "distance",
				take: 5n,
				params: child.meta.paramDeps,
				sealed: true,
				heading: child.heading,
				meta: metaSpecOf(child.meta),
				loc: undefined
			})
			return relNode(node.id, { ...inputs, child: search, meta: metaSpecOf(node.meta) })
		})
	)
	return { ...q, dag }
}

const documents = query(Search).rule((r) => {
	const { id } = v(Document, "document")
	return r.match(Document, { id }).find({ id })
})

/**
 * The documents, each with the distance of its own candidate: a search only the child reads, its parent variable bound
 * in the child's rule above it.
 */
const childSearch = documents.attach(
	"near",
	(parent) =>
		query(Search).rule((r) => {
			const near = candidates.bind({
				account: r.param("account", uuid),
				vector: r.param("vector", DocumentEmbedding.fields.value)
			})
			const { distance } = v(near, "near")
			return r.match(near, { document: parent.id, distance }).find({ distance })
		}),
	"array"
)

/**
 * The checked DAG of `q` with its one search a root of the DAG as well: the search an attachment's child reads, read
 * outside that child too.
 */
const searchAlsoOutside = (q: LogicalQuery): LogicalQuery => {
	const search = Option.getOrThrowWith(
		Arr.findFirst(
			topoOrder(q.dag),
			(n): n is NodeOf<"ApproximateNearest"> => n.kind === "ApproximateNearest"
		),
		() => new Error("a search")
	)
	const [root, ...others] = q.dag.roots
	return { ...q, dag: validateDag(rooted([root, ...others, search])) }
}

/**
 * Each document with the distances of its own embeddings to the query vector, ranked: the child's own source reads the
 * parent variable, by binding it or by comparing it, so a search over it would run once per parent.
 */
const perParent = (reads: "binds" | "compares") =>
	documents.attach(
		"near",
		(parent) =>
			query(Search).rule((r) => {
				const { document, revision, value } = v(DocumentEmbedding, "documentEmbedding")
				const distance = Compute.cosineDistance(
					value,
					r.param("vector", DocumentEmbedding.fields.value)
				)
				return reads === "binds"
					? r
							.match(DocumentEmbedding, { document: parent.id, revision, value })
							.find({ revision, distance })
					: r
							.match(DocumentEmbedding, { document, revision, value })
							.where(r.eq(document, parent.id))
							.find({ revision, distance })
			}),
		"array"
	)

/** Each candidate's document account and title: a child over candidates, of two fields. */
const candidatesTitled = candidates.attach(
	"doc",
	(c) =>
		query(Search).rule((r) => {
			const { account, title } = v(Document, "document")
			return r.match(Document, { id: c.document, account, title }).find({ account, title })
		}),
	"option"
)

/**
 * The same, with the current revisions of that account's documents attached to the child: a child with an attachment
 * of its own, which must be a statement of its own and would compute the candidates again.
 */
const candidatesNested = candidates.attach(
	"doc",
	(c) =>
		query(Search)
			.rule((r) => {
				const { account, title } = v(Document, "document")
				return r.match(Document, { id: c.document, account, title }).find({ account, title })
			})
			.attach(
				"current",
				(d) =>
					query(Search).rule((r) => {
						const { document, revision } = v(DocumentCurrent, "documentCurrent")
						return r
							.match(DocumentCurrent, { document, revision })
							.match(Document, { id: document, account: d.account })
							.find({ document, revision })
					}),
				"array"
			),
	"option"
)

/** One search read by the child and by its parent, two statements. */
const childAndParent = query(Search)
	.rule((r) => {
		const near = candidates.bind({
			account: r.param("account", uuid),
			vector: r.param("vector", DocumentEmbedding.fields.value)
		})
		const { document, distance } = v(near, "near")
		return r.match(near, { document, distance }).find({ document, distance })
	})
	.attach(
		"again",
		(parent) =>
			query(Search).rule((r) => {
				const near = candidates.bind({
					account: r.param("account", uuid),
					vector: r.param("vector", DocumentEmbedding.fields.value)
				})
				const { distance } = v(near, "near")
				return r.match(near, { document: parent.document, distance }).find({ distance })
			}),
		"array"
	)

/** Where a search sits relative to an attachment, and whether one execution computes it once. */
type Placement =
	| "candidates delivered, a child joined to each"
	| "a search only the child reads"
	| "candidates delivered, a child with an attachment of its own"
	| "a search the child and its parent read"
	| "a search the child reads and a root delivers"
	| "a search over a child's source that binds the parent"
	| "a search over a child's source that compares the parent"

const placements: Readonly<
	Record<
		Placement,
		{ readonly once: boolean; readonly query: () => Result.Result<LogicalQuery, CompileError> }
	>
> = {
	"candidates delivered, a child joined to each": {
		once: true,
		query: () => checkedResult(candidatesTitled)
	},
	"a search only the child reads": { once: true, query: () => checkedResult(childSearch) },
	"candidates delivered, a child with an attachment of its own": {
		once: false,
		query: () => checkedResult(candidatesNested)
	},
	"a search the child and its parent read": {
		once: false,
		query: () => checkedResult(childAndParent)
	},
	/** Hand-built: the checker refuses this placement over the whole query first. */
	"a search the child reads and a root delivers": {
		once: false,
		query: () => Result.map(checkedResult(childSearch), searchAlsoOutside)
	},
	/** Hand-built: the child wrapped in a search, which the checker never builds over a correlated source. */
	"a search over a child's source that binds the parent": {
		once: false,
		query: () => Result.map(checkedResult(perParent("binds")), searchUnderAttach)
	},
	"a search over a child's source that compares the parent": {
		once: false,
		query: () => Result.map(checkedResult(perParent("compares")), searchUnderAttach)
	}
}

const placementNames: Arr.NonEmptyReadonlyArray<Placement> = [
	"candidates delivered, a child joined to each",
	"a search only the child reads",
	"candidates delivered, a child with an attachment of its own",
	"a search the child and its parent read",
	"a search the child reads and a root delivers",
	"a search over a child's source that binds the parent",
	"a search over a child's source that compares the parent"
]

describe("attachments: one search per execution, never one per parent", () => {
	it.effect(
		"admits exactly the placements one execution computes once, each search once and outside any per-row subquery",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/lower/vector/placements",
						generator: element(placementNames),
						literal: Formatter.format,
						limit: 8,
						coverage: requiredInSpace<"admitted" | "refused">(["admitted", "refused"]),
						caseHang: Duration.minutes(2)
					},
					(placement, c) =>
						Effect.sync(() => {
							const { once, query: built } = placements[placement]
							const program = Result.flatMap(built(), (q) => lowered(q, "query"))
							if (!once) {
								refused(program, "UnsupportedOperation", placement)
								c.note("refused")
								return
							}
							const statements = flight(succeeded(program, placement).roots)
							assert.equal(
								Arr.reduce(statements, 0, (n, s) => n + searchesIn(s.ast)),
								1,
								placement
							)
							assert.equal(
								Arr.reduce(statements, 0, (n, s) => n + searchesPerRow(s.ast)),
								0,
								placement
							)
							c.note("admitted")
						})
				)
			)
	)
})

/**
 * The candidates' distance replaced by a literal: the DAG no longer ranks by the cosine distance, though its search
 * node still names the score column. A planted DAG: the checker only builds a search over the distance it traced.
 */
const literalScore = (q: LogicalQuery): LogicalQuery => {
	const ann = nodeOfKind(q.dag.roots[0], "ApproximateNearest")
	const projection = nodeOfKind(ann.source, "ProjectSet")
	const distance = Option.getOrThrowWith(
		Arr.findFirst(projection.out, (o) => o.name === "distance"),
		() => new Error("the distance output")
	)
	const literal = builtExpr(
		{
			kind: "literal",
			value: { kind: "float", value: canonicalZero(0.5) },
			args: [],
			type: distance.expr.type,
			nonNull: "literal"
		},
		ExprId("e_literal")
	)
	/**
	 * The query vector is no longer read: its parameter leaves the search's bindings, and the dependencies of the
	 * projection and the search, which construction computes.
	 */
	const account = Arr.filter(projection.meta.paramDeps, (p) => p !== "vector")
	const dag = validateDag(
		rebuildDag(q.dag, (node, inputs) => {
			if (node === projection && inputs.kind === "ProjectSet") {
				const out = Arr.map(inputs.out, (o) =>
					o.name === "distance" ? { ...o, expr: literal } : o
				)
				return relNode(node.id, { ...inputs, out, meta: metaSpecOf(node.meta) })
			}
			if (node === ann && inputs.kind === "ApproximateNearest") {
				return relNode(node.id, { ...inputs, params: account, meta: metaSpecOf(node.meta) })
			}
			return kept(node, inputs)
		})
	)
	return { ...q, dag }
}

describe("refusals in the lowering", () => {
	it.effect(
		"lowers a search only in a query, and only while it ranks by the cosine distance it traces",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/lower/vector/traced",
						generator: (source) =>
							[
								source.draw(element<"query" | "derivedDefinition">(["query", "derivedDefinition"])),
								source.draw(
									element<"the cosine distance" | "a literal">(["the cosine distance", "a literal"])
								)
							] as const,
						literal: Formatter.format,
						limit: 4,
						coverage: requiredInSpace<"admitted" | "refused">(["admitted", "refused"]),
						caseHang: Duration.minutes(2)
					},
					([purpose, score], c) =>
						Effect.sync(() => {
							const q = checked(candidates)
							const r = lowered(score === "a literal" ? literalScore(q) : q, purpose)
							if (purpose === "query" && score === "the cosine distance") {
								assert.equal(
									Arr.reduce(flight(succeeded(r).roots), 0, (n, s) => n + searchesIn(s.ast)),
									1
								)
								c.note("admitted")
							} else {
								refused(r, "UnsupportedOperation", `${purpose}, ${score}`)
								c.note("refused")
							}
						})
				)
			)
	)
})
