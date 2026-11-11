/**
 * A refined output the optimized delivery casts to its domain and orders by (lower/shapes/refined castOutputs): the ORDER
 * BY item that reads the output reads its cast, the expression the output list holds, never the uncast value. Under
 * SELECT DISTINCT the uncast item is PostgreSQL's 42P10 ("for SELECT DISTINCT, ORDER BY expressions must appear in
 * select list", parse_clause.c), which the generated suites met before the delivery cast the item alike.
 *
 * The oracle is the specification turned into a checker, over every query of every statement of the optimized program:
 * no ORDER BY item is, canonically, the uncast value of an output its core casts; and under SELECT DISTINCT every ORDER
 * BY item is one of the core's outputs.
 *
 * Bound: a refined value from each source the delivery's trace judges, a derived relation's column, which it casts, and
 * a declared parameter, which its bind proves (lower/conservative/refined Tracer), emitted alone or beside a projected
 * field that keeps no key, so the delivery deduplicates, ordered by the value alone or after the projected field, either
 * direction. Exhausted.
 *
 * Features: ordered by a cast output, ordered by two outputs, the tag alone.
 *
 * Plant, failing the search: a cast output's ORDER BY item left uncast (refined-order-uncast).
 */
import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import { checkQuery } from "#compiler/check/index.ts"
import { canonicalEquals, everyProperty } from "#compiler/core/canonical.ts"
import { identity } from "#compiler/core/identity.ts"
import { type Direction, directions } from "#compiler/core/order.ts"
import { compileInstallation, installOptions } from "#compiler/physical/install/compile.ts"
import { queryInput } from "#compiler/program/compile.ts"
import { uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { derived, relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import type { Expr, OrderItem, SqlStatement, Target } from "#compiler/sql/ast.ts"
import { identityHooks, transformStatement } from "#compiler/sql/transform.ts"
import { assert, succeeded } from "#test/support/assert.ts"
import { allocatedLevels, lowerAligned, programAsts } from "#test/support/compile.ts"
import { installedCatalog } from "#test/support/evidence.ts"
import { parsedSchemaName } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { checking, checkOptions, owning } from "#test/support/policy.ts"

const Slug = str.regex("^[a-z][a-z0-9-]*$")
const Prose = str.regex("^.*$", "su")
const Article = relation("Article", { id: uuid, slug: Slug, title: Prose }, ["id"])
const Stored = schema("RefinedOrder", { Article }, [])
const Listed = derived.materialized(
	"Listed",
	query(Stored).rule((r) => {
		const { id, slug, title } = v(Article, "article")
		return r.match(Article, { id, slug, title }).find({ id, slug, title })
	})
)
const Refined = schema.extend(Stored, "Refined", { Listed }, [])

const owned = owning(Refined)
const installation = succeeded(
	compileInstallation(owned, {
		...installOptions(owned, "grizzle_dev"),
		levels: allocatedLevels(identity.schema(parsedSchemaName("refined_order")), owned.levels)
	})
)
const catalog = installedCatalog(installation)

type Source = "a derived relation's column" | "a declared parameter"
type Shape =
	| "the tag alone"
	| "the title and the tag, by the tag"
	| "the title and the tag, by both"

/**
 * Each listed article's slug, a derived relation's column, alone or with its title, deduplicated and ordered as drawn.
 */
const listedTags = (shape: Shape, direction: Direction) => {
	if (shape === "the tag alone") {
		return query(Refined)
			.rule((r) => {
				const { slug } = v(Listed, "listed")
				return r.match(Listed, { slug }).find({ tag: slug })
			})
			.orderBy(["tag", direction])
	}
	const read = query(Refined).rule((r) => {
		const { slug, title } = v(Listed, "listed")
		return r.match(Listed, { slug, title }).find({ title, tag: slug })
	})
	return shape === "the title and the tag, by the tag"
		? read.orderBy(["tag", direction])
		: read.orderBy(["title", direction], ["tag", direction])
}

/**
 * The tag the caller passes, a declared parameter, alone or with each listed article's title, deduplicated and ordered
 * as drawn.
 */
const passedTags = (shape: Shape, direction: Direction) => {
	if (shape === "the tag alone") {
		return query(Refined)
			.rule((r) => {
				const { title } = v(Listed, "listed")
				return r.match(Listed, { title }).find({ tag: r.param("tag", Slug) })
			})
			.orderBy(["tag", direction])
	}
	const read = query(Refined).rule((r) => {
		const { title } = v(Listed, "listed")
		return r.match(Listed, { title }).find({ title, tag: r.param("tag", Slug) })
	})
	return shape === "the title and the tag, by the tag"
		? read.orderBy(["tag", direction])
		: read.orderBy(["title", direction], ["tag", direction])
}

/** The query each source of the tag reads. */
const tagged = Object.freeze({
	"a derived relation's column": listedTags,
	"a declared parameter": passedTags
} satisfies Record<Source, (shape: Shape, direction: Direction) => unknown>)

/** A query over a core: its ORDER BY, the core's targets, and whether the core is SELECT DISTINCT. */
interface OrderedCore {
	readonly orderBy: ReadonlyArray<OrderItem>
	readonly targets: ReadonlyArray<Target>
	readonly distinct: boolean
}

/** Every query of a statement, at any depth, whose body is a core. */
const orderedCores = (statement: SqlStatement): ReadonlyArray<OrderedCore> => {
	const found: Array<OrderedCore> = []
	transformStatement(statement, {
		...identityHooks,
		select: (s) => {
			if (s.body.kind === "core") {
				found.push({
					orderBy: s.orderBy,
					targets: s.body.targets,
					distinct: s.body.distinct === true
				})
			}
			return s
		}
	})
	return found
}

type Feature = "ordered by a cast output" | "ordered by two outputs" | "the tag alone"

describe("a refined output the delivery casts", () => {
	it.effect("is ordered by its cast, the expression the output list holds", (ctx) =>
		searched(
			ctx,
			exhaust(
				{
					suite: "unit/lower/refined-order",
					generator: (source) => ({
						source: source.draw(
							element(["a derived relation's column", "a declared parameter"] as const)
						),
						shape: source.draw(
							element([
								"the tag alone",
								"the title and the tag, by the tag",
								"the title and the tag, by both"
							] as const)
						),
						direction: source.draw(element(directions))
					}),
					literal: Formatter.format,
					limit: 12,
					coverage: requiredInSpace<Feature>([
						"ordered by a cast output",
						"ordered by two outputs",
						"the tag alone"
					]),
					caseHang,
					box: "a refined derived column or parameter emitted alone or beside a key-less projected field, ordered by it alone or after the field, either direction",
					oracle: {
						kind: "specification",
						name: "an ORDER BY item reads a cast output's cast, and under SELECT DISTINCT one of the outputs (42P10)"
					}
				},
				(box, c) =>
					Effect.sync(() => {
						const input = succeeded(queryInput(tagged[box.source](box.shape, box.direction)))
						const checked = succeeded(
							checkQuery(checking(Refined), input.desc, checkOptions("query"))
						)
						const program = succeeded(
							lowerAligned(checked, "query", {
								names: installation.names,
								context: "snapshot",
								catalog
							})
						)
						for (const q of Arr.flatMap(programAsts(program), orderedCores)) {
							const uncast = Arr.flatMap(q.targets, (t) =>
								t.expr.kind === "cast" ? [t.expr.expr] : []
							)
							for (const item of q.orderBy) {
								const same = (e: Expr) => canonicalEquals(e, item.expr, everyProperty)
								assert.ok(
									!Arr.some(uncast, same),
									"no ORDER BY item reads a cast output's uncast value"
								)
								const output = Arr.findFirst(q.targets, (t) => same(t.expr))
								if (q.distinct) {
									assert.ok(
										Option.isSome(output),
										"each ORDER BY item under SELECT DISTINCT is one of its outputs"
									)
								}
								if (Option.isSome(output) && output.value.expr.kind === "cast") {
									c.note("ordered by a cast output")
								}
							}
							if (q.orderBy.length > 1) {
								c.note("ordered by two outputs")
							}
						}
						if (box.shape === "the tag alone") {
							c.note("the tag alone")
						}
					})
			)
		)
	)
})
