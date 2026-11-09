import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { boolean, element } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option } from "effect"
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
import { uuid } from "#compiler/public/fields.ts"
import { type QueryValue, queryOver, varsOver } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { compute } from "#compiler/scalar/compute/builders.ts"
import type { OperandSelect, SqlStatement } from "#compiler/sql/ast.ts"
import {
	type AstHooks,
	identityHooks,
	transformOperand,
	transformStatement
} from "#compiler/sql/transform.ts"
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
import { caseHang } from "#test/support/limits.ts"
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
 * The rule, over every placement of a search a parent and its child make (the checker builds only some of them; the
 * others are hand-built DAGs the lowering must refuse on its own): a program the lowering admits computes each search
 * node once, in one statement and outside any sublink, which runs per row of the query around it; a search whose own
 * source reads the parent variable would run once per parent, and is refused; every refusal is UnsupportedOperation,
 * by the checker or by the lowering. The placements must reach both: a search the parent delivers or only its child
 * reads is admitted, and one a statement of its own would compute again (an attachment of a child over candidates, a
 * root reading it beside the child) is refused. A search in a derived relation's definition is refused, and the lowering traces the search
 * again on the DAG it lowers, refusing a score that is no longer the cosine distance.
 */

const ownedSearch = owning(Search)
const installation = succeeded(
	compileInstallation(ownedSearch, {
		...installOptions(ownedSearch, "grizzle_dev"),
		levels: [identity.schema(parsedSchemaName("search"))]
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
const searchesIn = (ast: OperandSelect | SqlStatement): number => {
	let searches = 0
	const hooks: AstHooks = {
		...identityHooks,
		select: (s) => {
			if (Arr.some(s.orderBy, (item) => item.expr.kind === "binary" && item.expr.op === "<=>")) {
				searches++
			}
			return s
		}
	}
	if (ast.kind === "select") {
		transformOperand(ast, hooks)
	} else {
		transformStatement(ast, hooks)
	}
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

/** Who delivers the parents: the documents, a parent of no search, or the candidates, a search itself. */
type Parent = "documents" | "candidates"

/**
 * The child each parent row has: its document's account and title, the same with the account's current revisions
 * attached below it, its own candidate's distance (a search only the child reads), or the distances of its document's
 * own embeddings, whose source binds the parent's document or compares it, wrapped in a search by hand, since the
 * checker never builds a search over a correlated source.
 */
type Child =
	| "titled"
	| "titled, with an attachment of its own"
	| "its own candidate"
	| "a search over a source that binds the parent"
	| "a search over a source that compares the parent"

/** Which field of the parent's rows names its document. */
const documentField = (parent: Parent): string => (parent === "documents" ? "id" : "document")

/**
 * The fixture's candidates (fixtures/api/search.ts), built by the runtime builder, so a placement composes them with
 * the parents and children it draws: the approximate nearest of an account's current embeddings to a vector.
 */
const searchCandidates = queryOver(Search)
	.rule((r: RuleValue) => {
		const { document, revision, value } = varsOver(DocumentEmbedding, "documentEmbedding")
		return r
			.match(DocumentEmbedding, { document, revision, value })
			.match(DocumentCurrent, { document, revision })
			.match(Document, { id: document, account: r.param("account", Document.fields.account) })
			.find({
				document,
				revision,
				distance: compute.cosineDistance(value, r.param("vector", DocumentEmbedding.fields.value))
			})
	})
	.approximateNearest({ by: "distance", take: 20 })

/** The candidates of a parameter's account and vector, bound in a rule. */
const candidatesIn = (r: RuleValue) =>
	searchCandidates.bind({
		account: r.param("account", uuid),
		vector: r.param("vector", DocumentEmbedding.fields.value)
	})

const childQuery = (child: Child, document: unknown): QueryValue => {
	switch (child) {
		case "titled":
		case "titled, with an attachment of its own": {
			const titled = queryOver(Search).rule((r: RuleValue) => {
				const { account, title } = varsOver(Document, "document")
				return r.match(Document, { id: document, account, title }).find({ account, title })
			})
			return child === "titled"
				? titled
				: titled.attach(
						"current",
						(d: Readonly<Record<string, unknown>>) =>
							queryOver(Search).rule((r: RuleValue) => {
								const { document: current, revision } = varsOver(DocumentCurrent, "documentCurrent")
								return r
									.match(DocumentCurrent, { document: current, revision })
									.match(Document, { id: current, account: d["account"] })
									.find({ document: current, revision })
							}),
						"array"
					)
		}
		case "its own candidate":
			return queryOver(Search).rule((r: RuleValue) => {
				const near = candidatesIn(r)
				const { distance } = varsOver(near, "near")
				return r.match(near, { document, distance }).find({ distance })
			})
		case "a search over a source that binds the parent":
		case "a search over a source that compares the parent":
			return queryOver(Search).rule((r: RuleValue) => {
				const {
					document: embedded,
					revision,
					value
				} = varsOver(DocumentEmbedding, "documentEmbedding")
				const distance = compute.cosineDistance(
					value,
					r.param("vector", DocumentEmbedding.fields.value)
				)
				return child === "a search over a source that binds the parent"
					? r.match(DocumentEmbedding, { document, revision, value }).find({ revision, distance })
					: r
							.match(DocumentEmbedding, { document: embedded, revision, value })
							.where(r.eq(embedded, document))
							.find({ revision, distance })
			})
	}
}

/** The parents, each with its child attached, delivered as an option of one row or an array. */
const placed = (parent: Parent, child: Child): QueryValue => {
	const parents =
		parent === "documents"
			? queryOver(Search).rule((r: RuleValue) => {
					const { id } = varsOver(Document, "document")
					return r.match(Document, { id }).find({ id })
				})
			: searchCandidates
	return parents.attach(
		"near",
		(p: Readonly<Record<string, unknown>>) => childQuery(child, p[documentField(parent)]),
		child === "titled" || child === "titled, with an attachment of its own" ? "option" : "array"
	)
}

/** The searches of a DAG, each node once. */
const searchesOf = (q: LogicalQuery): number =>
	Arr.filter(topoOrder(q.dag), (n) => n.kind === "ApproximateNearest").length

/** Where a placement's searches sit. */
type PlacementShape =
	| "a search the parent delivers"
	| "a search only the child reads"
	| "a search over a source that reads the parent"
	| "a search a root reads again"

/** What a placement reaches: where its searches sit, and whether the lowering admitted it, each shape paired with it. */
type PlacementFeature = PlacementShape | "admitted" | "refused"

describe("attachments: one search per execution, never one per parent", () => {
	it.effect(
		"admits a placement only where one execution computes each search once, outside any per-row subquery",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						box: { kind: "unstated" },
						oracle: { kind: "unstated" },
						suite: "unit/lower/vector/placements",
						/**
						 * Every parent with every child, the DAG's first search read by a root of its own as well where
						 * drawn, so a statement of its own would compute it again; a search over a source correlated with
						 * the parent is no root's, its outer reference out of scope there.
						 */
						generator: (source) => ({
							parent: source.draw(element<Parent>(["documents", "candidates"])),
							child: source.draw(
								element<Child>([
									"titled",
									"titled, with an attachment of its own",
									"its own candidate",
									"a search over a source that binds the parent",
									"a search over a source that compares the parent"
								])
							),
							again: source.draw(boolean)
						}),
						literal: Formatter.format,
						limit: 20,
						coverage: requiredInSpace<PlacementFeature>([
							["a search the parent delivers", "admitted"],
							["a search only the child reads", "admitted"],
							["a search the parent delivers", "refused"],
							["a search over a source that reads the parent", "refused"],
							["a search a root reads again", "refused"]
						]),
						caseHang
					},
					({ parent, child, again }, c) =>
						Effect.sync(() => {
							const perParent =
								child === "a search over a source that binds the parent" ||
								child === "a search over a source that compares the parent"
							const shapes: Array<PlacementShape> = []
							if (parent === "candidates") {
								shapes.push("a search the parent delivers")
							} else if (child === "its own candidate") {
								shapes.push("a search only the child reads")
							}
							if (perParent) {
								shapes.push("a search over a source that reads the parent")
							}
							const reached = (outcome: "admitted" | "refused") => {
								c.note(outcome)
								for (const shape of shapes) {
									c.pair(shape, outcome)
								}
							}
							const checkedPlacement = checkedResult(placed(parent, child))
							if (!checkedPlacement.ok) {
								refused(checkedPlacement, "UnsupportedOperation", `${parent}, ${child}`)
								reached("refused")
								return
							}
							const wrapped = perParent
								? searchUnderAttach(checkedPlacement.value)
								: checkedPlacement.value
							const readAgain = again && !perParent && searchesOf(wrapped) > 0
							const shaped = readAgain ? searchAlsoOutside(wrapped) : wrapped
							if (readAgain) {
								shapes.push("a search a root reads again")
							}
							const program = lowered(shaped, "query")
							if (!program.ok || perParent) {
								refused(program, "UnsupportedOperation", `${parent}, ${child}`)
								reached("refused")
								return
							}
							const statements = flight(program.value.roots)
							assert.equal(
								Arr.reduce(statements, 0, (n, st) => n + searchesIn(st.ast)),
								searchesOf(shaped),
								"each search computed once"
							)
							assert.equal(
								Arr.reduce(statements, 0, (n, st) => n + searchesPerRow(st.ast)),
								0,
								"no search under a sublink"
							)
							reached("admitted")
						})
				)
			)
	)
})

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
						box: { kind: "unstated" },
						oracle: { kind: "unstated" },
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
						caseHang
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
