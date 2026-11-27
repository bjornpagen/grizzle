/** What the properties of vector.test.ts read: its spaces, models and helpers. */

import * as Result from "@bjornpagen/grizzle-text/base/result"
import { boolean, element, finite } from "@bjornpagen/testing/gen"
import { Array as Arr, Option } from "effect"
import { checkQuery } from "#compiler/check/index.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import { identity } from "#compiler/core/identity.ts"
import { ExprId, NodeId } from "#compiler/core/ids.ts"
import { floatLiteral } from "#compiler/ir/carriers.ts"
import { relNode, rooted, topoOrder, unchangedEdges } from "#compiler/ir/dag.ts"
import { builtExpr } from "#compiler/ir/expr.ts"
import type { LogicalQuery } from "#compiler/ir/products.ts"
import {
	metaSpecOf,
	type NodeOf,
	type NodeOver,
	type RelNode,
	type ValueRefs
} from "#compiler/ir/rel.ts"
import type { OptimizedProgram } from "#compiler/lower/optimize/pipeline.ts"
import { installOptions } from "#compiler/physical/install/compile.ts"
import { queryInput } from "#compiler/program/input.ts"
import { compileInstallation } from "#compiler/program/install.ts"
import { costChosen } from "#compiler/sql/emit.ts"

import { Distance, Type } from "#compiler/public/compute.ts"
import { query, v } from "#compiler/public/query.ts"
import { queryOver, type QueryValue, varsOver } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { compute } from "#compiler/scalar/compute/builders.ts"
import type { OperandSelect, SqlStatement } from "#compiler/sql/ast.ts"
import { type AstHooks, identityHooks, transformStatement } from "#compiler/sql/transform.ts"
import {
	Agree,
	Cents,
	Item,
	Owned,
	Slot,
	Tag,
	Tone,
	Tones,
	toCents
} from "#test/support/agreement/schema.ts"
import { succeeded } from "#test/support/assert.ts"
import { lowerAligned } from "#test/support/compile.ts"
import { rebuildDag } from "#test/support/dag.ts"
import { installedCatalog } from "#test/support/evidence.ts"
import {
	Document,
	DocumentCurrent,
	DocumentEmbedding,
	Search
} from "#test/support/fixtures/api/search.ts"
import { Id, toId } from "#test/support/ids.ts"
import { parsedSchemaName } from "#test/support/kernel/naming.ts"
import { validateDag } from "#test/support/oracle/dag-validate.ts"
import { checking, checkOptions, owning } from "#test/support/policy.ts"
import { transformOperand } from "#test/support/sql.ts"
import { nodeOfKind } from "#test/unit/lower/support.ts"

/** A node rebuilt over its rebuilt inputs, the node itself where none changed (ir/dag.ts rebuildDag). */
const kept = (node: RelNode, inputs: NodeOver<ValueRefs<RelNode>>): RelNode =>
	unchangedEdges(node, inputs) ? node : relNode(node.id, { ...inputs, meta: metaSpecOf(node.meta) })

const ownedSearch = owning(Search)

const installation = succeeded(
	compileInstallation(ownedSearch, {
		...installOptions(ownedSearch),
		levels: [identity.schema(parsedSchemaName("search"))]
	})
)

/** The installation's own catalog (laws/model/catalog.ts), as compileQuery reads it before admission. */
const catalog = installedCatalog(installation)

export const checkedResult = (q: unknown): Result.Result<LogicalQuery, CompileError> =>
	Result.flatMap(queryInput(q), (input) =>
		checkQuery(checking(Search), input.desc, checkOptions("query"))
	)

export const checked = (q: unknown): LogicalQuery => succeeded(checkedResult(q))

export const lowered = (
	q: LogicalQuery,
	purpose: "query" | "derivedDefinition"
): Result.Result<OptimizedProgram, CompileError> =>
	lowerAligned(q, purpose, {
		binding: costChosen(),
		names: installation.names,
		context: "snapshot",
		catalog
	})

/** The queries of a statement that rank by the cosine distance: one per approximate search the statement runs. */
export const searchesIn = (ast: OperandSelect | SqlStatement): number => {
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
export const searchesPerRow = (ast: SqlStatement): number => {
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
export const searchUnderAttach = (q: LogicalQuery): LogicalQuery => {
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
export type Parent = "documents" | "candidates"

/**
 * The child each parent row has: its document's account and title, the same with the account's current revisions
 * attached below it, its own candidate's distance (a search only the child reads), or the distances of its document's
 * own embeddings, whose source binds the parent's document or compares it, wrapped in a search by hand, since the
 * checker never builds a search over a correlated source.
 */
export type Child =
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
		account: r.param("account", Id),
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
export const placed = (parent: Parent, child: Child): QueryValue => {
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
export const searchesOf = (q: LogicalQuery): number =>
	Arr.filter(topoOrder(q.dag), (n) => n.kind === "ApproximateNearest").length

/** Where a placement's searches sit. */
export type PlacementShape =
	| "a search the parent delivers"
	| "a search only the child reads"
	| "a search over a source that reads the parent"
	| "a search a root reads again"

/** What a placement reaches: where its searches sit, and whether the lowering admitted it, each shape paired with it. */
export type PlacementFeature = PlacementShape | "admitted" | "refused"

/**
 * The checked DAG of `q` with its one search a root of the DAG as well: the search an attachment's child reads, read
 * outside that child too.
 */
export const searchAlsoOutside = (q: LogicalQuery): LogicalQuery => {
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
 * node still names the score column. A planted DAG: the checker only builds a search over the distance it traced. The
 * search is the input of the root's order, the candidates' key, which every served read is delivered in.
 */
export const literalScore = (q: LogicalQuery): LogicalQuery => {
	const ann = nodeOfKind(nodeOfKind(q.dag.roots[0], "OrderedResult").input, "ApproximateNearest")
	const projection = nodeOfKind(ann.source, "ProjectSet")
	const distance = Option.getOrThrowWith(
		Arr.findFirst(projection.out, (o) => o.name === "distance"),
		() => new Error("the distance output")
	)
	const literal = builtExpr(
		{
			kind: "literal",
			value: floatLiteral(0.5),
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

/**
 * Every parent with every child, the DAG's first search read by a root of its own as well where
 * drawn, so a statement of its own would compute it again; a search over a source correlated with
 * the parent is no root's, its outer reference out of scope there.
 */
export const placements = finite((source) => ({
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
}))

/**
 * Searches whose rule's existential witness the semi-join rewrite takes out of the region (lower/optimize/existence
 * R02.semiJoin), its restoring projection then left between the region and the rule's filters, each the agreement's
 * shrunk counterexample (test/types/evidence/agreement.test.ts kept): an interior stage of Item equated to the item by
 * a `where`, beside a range filter (#evidence, floor seed 0xa72d70a7); a second match of Slot ranked beside a tag
 * equated to the first Slot's item, a union of rosters and Item pinned at a handle (#reordered, seed 0xe1d76d2e); and
 * Item pinned by its key beside Owned bound at a parameter and an interior stage equated to its n, which a parameter
 * fixes, so the restoring projection copies n under its class's other name and constant propagation then makes it the
 * parameter, a column that stands for no variable of the region (#reordered, seed 0x80ae3f4d).
 */
export const narrowedSearches = {
	"an interior stage the rule equates to its item": () =>
		query(Agree)
			.rule((r) => {
				const stageSource = r.interior((r) => {
					const inner = v(Item, "inner")
					return r
						.match(Item, { id: inner.id, owner: r.param("p0", Item.fields.owner), n: inner.n })
						.find({ id: inner.id, n: inner.n })
				})
				const item = v(Item, "item")
				const stage = v(stageSource, "stage")
				const slot = v(Slot, "slot")
				return r
					.match(Item, {
						id: item.id,
						owner: item.owner,
						n: item.n,
						m: item.m,
						tone: item.tone,
						cost: item.cost
					})
					.match(stageSource, { id: stage.id, n: stage.n })
					.match(Slot, { item: slot.item, during: slot.during, embedding: slot.embedding })
					.where(r.eq(item.id, stage.id), r.pointIn(item.n, r.param("p1", Slot.fields.during)))
					.find({
						h0: item.id,
						h1: Distance.cosine(slot.embedding, r.param("p2", Slot.fields.embedding))
					})
			})
			.approximateNearest({ by: "h1", take: 1 }),
	"a second match of the searched relation beside a tag equated to the first's item": () =>
		query(Agree)
			.rule((r) => {
				const item = v(Item, "item")
				const tag = v(Tag, "tag")
				const slot = v(Slot, "slot")
				const secondSlot = v(Slot, "secondSlot")
				return r
					.match(Item, {
						id: item.id,
						owner: item.owner,
						n: item.n,
						m: item.m,
						tone: Tone.handle("low"),
						cost: item.cost
					})
					.match(Tag, { item: tag.item, label: tag.label, w: tag.w })
					.match(Slot, {
						item: slot.item,
						during: slot.during,
						budget: slot.budget,
						raw: slot.raw,
						day: slot.day,
						when: slot.when
					})
					.match(Slot, {
						item: secondSlot.item,
						during: secondSlot.during,
						embedding: secondSlot.embedding
					})
					.match(Tones, { tone: Tone.handle("low") })
					.where(r.eq(tag.item, slot.item))
					.find({
						h0: Tone.handle("low"),
						h1: Distance.cosine(secondSlot.embedding, r.param("p0", Slot.fields.embedding))
					})
			})
			.approximateNearest({ by: "h1", take: 1 }),
	"an item pinned by its key beside an interior stage equated to its fixed n": () =>
		query(Agree)
			.rule((r) => {
				const stageSource = r.interior((r) => {
					const inner = v(Item, "inner")
					return r
						.match(Item, {
							id: inner.id,
							owner: toId("00000000-0000-4000-8000-000000000000"),
							n: inner.n
						})
						.find({ id: inner.id, n: inner.n })
				})
				const item = v(Item, "item")
				const stage = v(stageSource, "stage")
				const slot = v(Slot, "slot")
				const ownedSource = Owned.bind({ owner: r.param("p2", Item.fields.id) })
				const owned = v(ownedSource, "owned")
				return r
					.match(Item, {
						id: r.param("p0", Item.fields.id),
						owner: r.param("p1", Item.fields.owner),
						n: item.n,
						m: item.n,
						tone: item.tone,
						cost: Type.literal(Cents, toCents(0n))
					})
					.match(ownedSource, { id: owned.id, n: item.n })
					.match(stageSource, { id: item.id, n: stage.n })
					.match(Slot, { item: slot.item, during: slot.during, embedding: slot.embedding })
					.match(Tones, { tone: Tone.handle("low") })
					.where(
						r.eq(Tone.handle("low"), item.tone),
						r.eq(item.n, r.param("p3", Item.fields.n)),
						r.eq(item.n, stage.n)
					)
					.find({
						h0: item.n,
						h1: Distance.cosine(slot.embedding, r.param("p4", Slot.fields.embedding))
					})
			})
			.approximateNearest({ by: "h1", take: 1 })
} as const

/** Each narrowed search, by its shape. */
export type NarrowedSearch = keyof typeof narrowedSearches
