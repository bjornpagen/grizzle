import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { noCoverage, requiredInSpace } from "@grizzle/testing/features"
import { element } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Duration, Effect, Formatter } from "effect"
import { hnswPolicy } from "#compiler/check/approximate/policy.ts"
import { approximateMisuse, approximatePageMisuse } from "#compiler/check/approximate/provenance.ts"
import { checkQuery } from "#compiler/check/index.ts"
import type { CompileError, CompileReasonTag } from "#compiler/core/errors.ts"
import * as Result from "#compiler/core/result.ts"
import { topoOrder } from "#compiler/ir/dag.ts"
import type { LogicalQuery } from "#compiler/ir/products.ts"
import type { NodeOf, RelDag } from "#compiler/ir/rel.ts"
import { queryInput } from "#compiler/program/compile.ts"
import { Compute } from "#compiler/public/compute.ts"
import { pg, uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { isQueryValue, type QueryValue, queryValueDesc } from "#compiler/query/build/query.ts"
import { assert, defined, matchesObject, refused, succeeded } from "#test/support/assert.ts"
import { queryFromDesc } from "#test/support/describe.ts"
import {
	byDistance,
	candidates,
	Document,
	DocumentCurrent,
	DocumentEmbedding,
	Search,
	scoredDocuments,
	titles
} from "#test/support/fixtures/api/search.ts"
import { checking, checkOptions } from "#test/support/policy.ts"

const check = (s: unknown, q: unknown): Result.Result<LogicalQuery, CompileError> =>
	Result.flatMap(queryInput(q), (input) =>
		checkQuery(checking(s), input.desc, checkOptions("query"))
	)

const checked = (s: unknown, q: unknown): LogicalQuery =>
	succeeded(check(s, q), "the search checks")

const searches = (dag: RelDag): ReadonlyArray<NodeOf<"ApproximateNearest">> =>
	Arr.filter(
		topoOrder(dag),
		(n): n is NodeOf<"ApproximateNearest"> => n.kind === "ApproximateNearest"
	)

/**
 * A query over Search rebuilt from its Description, untyped: how a JavaScript caller reaches what the typed signatures
 * refuse.
 */
const untypedOf = (q: unknown): QueryValue => {
	const untyped = succeeded(queryFromDesc(queryValueDesc(q), Search), "the rebuild")
	assert.ok(isQueryValue(untyped), "an unordered query value")
	return untyped
}

/** The approximate retrieval of the five nearest by distance. */
const scored = <R>(source: {
	readonly approximateNearest: (spec: { readonly by: "distance"; readonly take: number }) => R
}): R => source.approximateNearest({ by: "distance", take: 5 })

/**
 * A schema with an unrelated double precision field beside a second embedding, and vectors at HNSW's dimension bound
 * and one above it.
 */
const Ranked = relation("Ranked", { id: uuid, weight: pg.float8, value: pg.vector(4) }, ["id"])
const AtBound = relation("AtBound", { id: uuid, value: pg.vector(hnswPolicy.maxDimensions) }, [
	"id"
])

const PastBound = relation(
	"PastBound",
	{ id: uuid, value: pg.vector(hnswPolicy.maxDimensions + 1) },
	["id"]
)

const Lab = schema(
	"Lab",
	{ Document, DocumentCurrent, DocumentEmbedding, Ranked, AtBound, PastBound },
	[]
)

/** The five nearest of each vector relation's rows to a parameter. */
const nearestAtBound = () =>
	scored(
		query(Lab).rule((r) => {
			const { id, value } = v(AtBound, "atBound")
			return r
				.match(AtBound, { id, value })
				.find({ id, distance: Compute.cosineDistance(value, r.param("q", AtBound.fields.value)) })
		})
	)

const nearestPastBound = () =>
	scored(
		query(Lab).rule((r) => {
			const { id, value } = v(PastBound, "pastBound")
			return r
				.match(PastBound, { id, value })
				.find({ id, distance: Compute.cosineDistance(value, r.param("q", PastBound.fields.value)) })
		})
	)

/** The distance of each embedding to a parameter. */
const distances = (vector: string) =>
	query(Search).rule((r) => {
		const { document, revision, value } = v(DocumentEmbedding, "documentEmbedding")
		return r.match(DocumentEmbedding, { document, revision, value }).find({
			document,
			distance: Compute.cosineDistance(value, r.param(vector, DocumentEmbedding.fields.value))
		})
	})

/** A search the eligibility check refuses with its reason, or admits; and why. */
interface Planted {
	readonly what: string
	readonly schema: unknown
	readonly search: () => unknown
	readonly outcome: CompileReasonTag | "admitted"
}

const planted: Arr.NonEmptyReadonlyArray<Planted> = [
	{
		what: "an arbitrary score named distance, even a double precision column",
		schema: Lab,
		search: () =>
			scored(
				query(Lab).rule((r) => {
					const { id, weight } = v(Ranked, "ranked")
					return r.match(Ranked, { id, weight }).find({ id, distance: weight })
				})
			),
		outcome: "UnsupportedOperation"
	},
	{
		/**
		 * The typed approximateNearest takes a number column only (test/types/skeleton/fixtures/vector.ts), so a
		 * JavaScript caller's by on a uuid column reaches the builder runtime of the same query, rebuilt from its
		 * Description.
		 */
		what: "a by on a uuid column",
		schema: Search,
		search: () => untypedOf(scoredDocuments).approximateNearest({ by: "document", take: 3 }),
		outcome: "UnsupportedOperation"
	},
	{
		what: "a nonlinear aggregate of distances",
		schema: Search,
		search: () =>
			scored(
				query(Search).rule((r) => {
					const { document, revision, value } = v(DocumentEmbedding, "documentEmbedding")
					const { account } = v(Document, "document")
					return r
						.match(DocumentEmbedding, { document, revision, value })
						.match(Document, { id: document, account })
						.find({
							account,
							distance: r.min(
								Compute.cosineDistance(value, r.param("vector", DocumentEmbedding.fields.value))
							)
						})
				})
			),
		outcome: "UnsupportedOperation"
	},
	{
		/**
		 * The typed approximateNearest refuses a union of rules (SearchSource), so a JavaScript caller's reaches the
		 * checker through the union rebuilt from its Description.
		 */
		what: "a union of rules, which no single index orders",
		schema: Search,
		search: () => {
			const twice = query(Search)
				.rule((r) => {
					const { document, revision, value } = v(DocumentEmbedding, "documentEmbedding")
					return r.match(DocumentEmbedding, { document, revision, value }).find({
						document,
						distance: Compute.cosineDistance(
							value,
							r.param("vector", DocumentEmbedding.fields.value)
						)
					})
				})
				.rule((r) => {
					const { document, revision, value } = v(DocumentEmbedding, "documentEmbedding")
					return r.match(DocumentEmbedding, { document, revision, value }).find({
						document,
						distance: Compute.cosineDistance(
							value,
							r.param("other", DocumentEmbedding.fields.value)
						)
					})
				})
			return scored(untypedOf(twice))
		},
		outcome: "UnsupportedOperation"
	},
	{
		what: "a distance between two stored vectors",
		schema: Lab,
		search: () =>
			scored(
				query(Lab).rule((r) => {
					const { document, revision, value } = v(DocumentEmbedding, "documentEmbedding")
					const other = v(Ranked, "ranked")
					return r
						.match(DocumentEmbedding, { document, revision, value })
						.match(Ranked, { id: other.id, value: other.value })
						.find({
							document,
							revision,
							id: other.id,
							distance: Compute.cosineDistance(value, other.value)
						})
				})
			),
		outcome: "UnsupportedOperation"
	},
	{
		what: "an indexed vector at HNSW's dimension bound",
		schema: Lab,
		search: nearestAtBound,
		outcome: "admitted"
	},
	{
		what: "an indexed vector above HNSW's dimension bound, never truncated or quantized",
		schema: Lab,
		search: nearestPastBound,
		outcome: "UnsupportedOperation"
	},
	{
		what: "a source read once per outer row: an attachment child correlated to its parent",
		schema: Search,
		search: () =>
			query(Search)
				.rule((r) => {
					const { id } = v(Document, "document")
					return r.match(Document, { id }).find({ id })
				})
				.attach(
					"near",
					(parent) =>
						scored(
							query(Search).rule((r) => {
								const { document, revision, value } = v(DocumentEmbedding, "documentEmbedding")
								return r
									.match(DocumentEmbedding, { document, revision, value })
									.where(r.eq(document, parent.id))
									.find({
										revision,
										distance: Compute.cosineDistance(
											value,
											r.param("vector", DocumentEmbedding.fields.value)
										)
									})
							})
						),
					"array"
				),
		outcome: "UnsupportedOperation"
	},
	{
		what: "a source whose match binds the parent variable: one global search filtered per parent is no substitute",
		schema: Search,
		search: () =>
			query(Search)
				.rule((r) => {
					const { id } = v(Document, "document")
					return r.match(Document, { id }).find({ id })
				})
				.attach(
					"near",
					(parent) =>
						scored(
							query(Search).rule((r) => {
								const { revision, value } = v(DocumentEmbedding, "documentEmbedding")
								return r.match(DocumentEmbedding, { document: parent.id, revision, value }).find({
									revision,
									distance: Compute.cosineDistance(
										value,
										r.param("vector", DocumentEmbedding.fields.value)
									)
								})
							})
						),
					"array"
				),
		outcome: "UnsupportedOperation"
	},
	{
		/**
		 * The import's own subgraph reads the enclosing rule's region, reserved and not yet built when the import is
		 * checked: its search would run once per row of that region.
		 */
		what: "an import bound to an outer variable, which would search once per outer row",
		schema: Search,
		search: () =>
			query(Search).rule((r) => {
				const { id, account } = v(Document, "document")
				const near = candidates.bind({
					account,
					vector: r.param("vector", DocumentEmbedding.fields.value)
				})
				const { document } = v(near, "near")
				return r.match(Document, { id, account }).match(near, { document }).find({ id, document })
			}),
		outcome: "UnsupportedOperation"
	},
	{
		what: "the distances of one rule, five nearest",
		schema: Search,
		search: () => scored(distances("vector")),
		outcome: "admitted"
	}
]

describe("approximateNearest's eligibility", () => {
	it.effect(
		"refuses each shape no index serves as it asks, and admits the eligible ones",
		(ctx) => {
			type Outcome = "refused" | "admitted"
			return searched(
				ctx,
				exhaust(
					{
						suite: "unit/check/approximate-eligibility",
						generator: element(planted),
						literal: Formatter.format,
						limit: planted.length,
						coverage: requiredInSpace<Outcome>(["refused", "admitted"]),
						caseHang: Duration.minutes(2)
					},
					(p, c) =>
						Effect.sync(() => {
							const r = check(p.schema, p.search())
							if (p.outcome === "admitted") {
								assert.equal(searches(succeeded(r, p.what).dag).length, 1, p.what)
								c.note("admitted")
							} else {
								refused(r, p.outcome, p.what)
								c.note("refused")
							}
						})
				)
			)
		}
	)

	it.effect("refuses a by naming no column as MalformedDescription", (ctx) => {
		const desc = succeeded(queryInput(candidates), "the candidates query").desc
		return searched(
			ctx,
			exhaust(
				{
					suite: "unit/check/approximate-by",
					generator: element(["nope", "", "distance ", "Distance"]),
					literal: Formatter.format,
					limit: 4,
					coverage: noCoverage,
					caseHang: Duration.minutes(2)
				},
				(by) =>
					Effect.sync(() => {
						refused(
							checkQuery(
								checking(Search),
								{ ...desc, stage: { ...desc.stage, by } },
								checkOptions("query")
							),
							"MalformedDescription",
							`by ${by}`
						)
					})
			)
		)
	})
})

/** A program over the search fixtures and whether its result is computed from approximate candidates. */
const programs: Arr.NonEmptyReadonlyArray<{
	readonly name: string
	readonly program: unknown
	readonly approximate: boolean
}> = [
	{ name: "titles", program: titles, approximate: true },
	{ name: "candidates", program: candidates, approximate: true },
	{ name: "byDistance", program: byDistance, approximate: false },
	{ name: "scoredDocuments", program: scoredDocuments, approximate: false }
]

describe("approximate provenance", () => {
	it.effect(
		"bans a page over, and a derived definition of, exactly the results computed from candidates",
		(ctx) => {
			type Provenance = "approximate" | "exact"
			return searched(
				ctx,
				exhaust(
					{
						suite: "unit/check/approximate-provenance",
						generator: element(programs),
						literal: Formatter.format,
						limit: programs.length,
						coverage: requiredInSpace<Provenance>(["approximate", "exact"]),
						caseHang: Duration.minutes(2)
					},
					(p, c) =>
						Effect.sync(() => {
							const q = checked(Search, p.program)
							const page = approximatePageMisuse(q.dag.roots[0])
							const derived = approximateMisuse(q.dag, { derivedDefinition: true })
							if (p.approximate) {
								const ann = defined(searches(q.dag)[0], "the search")
								const misuse = defined(page, `${p.name}: a page over candidates`)
								assert.equal(misuse.use, "page")
								assert.equal(misuse.consumer, q.dag.roots[0])
								assert.equal(misuse.approximate, ann)
								matchesObject(defined(derived, `${p.name}: a derived definition over candidates`), {
									use: "derived"
								})
								c.note("approximate")
							} else {
								assert.equal(page, undefined, p.name)
								assert.equal(derived, undefined, p.name)
								c.note("exact")
							}
						})
				)
			)
		}
	)
})
