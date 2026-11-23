/** What the properties of refined-order.test.ts read: its spaces, models and helpers. */

import { identity } from "#compiler/core/identity.ts"
import { type Direction } from "#compiler/core/order.ts"
import { compileInstallation, installOptions } from "#compiler/physical/install/compile.ts"

import { query, v } from "#compiler/public/query.ts"
import { derived, relation, schema, unit } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import type { OrderItem, SqlStatement, Target } from "#compiler/sql/ast.ts"
import { identityHooks, transformStatement } from "#compiler/sql/transform.ts"
import { succeeded } from "#test/support/assert.ts"
import { allocatedLevels, servingParams } from "#test/support/compile.ts"
import { installedCatalog } from "#test/support/evidence.ts"
import { Id } from "#test/support/ids.ts"
import { parsedSchemaName } from "#test/support/kernel/naming.ts"
import { owning } from "#test/support/policy.ts"

const Slug = str.regex("^[a-z][a-z0-9-]*$")

const Prose = str.regex("^.*$", "su")

const Article = relation("Article", { id: Id, slug: Slug, title: Prose }, ["id"])

/** The articles, each in a unit of its own, keyed by its id. */
const Stored = schema("RefinedOrder", [Article], [unit("Story", { id: Id })])

const Listed = derived.stored(
	"Listed",
	query(Stored).rule((r) => {
		const { id, slug, title } = v(Article, "article")
		return r.match(Article, { id, slug, title }).find({ id, slug, title })
	})
)

export const Refined = schema.extend([Stored], "Refined", [Listed], [])

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
export const tagged = Object.freeze({
	"a derived relation's column": listedTags,
	"a declared parameter": passedTags
} satisfies Record<Source, (shape: Shape, direction: Direction) => unknown>)

const owned = owning(Refined)

/** The installation the queries are compiled over, serving the parameter's program, so its pattern domain is
 * installed (physical/install/plan.ts ParamSource `planned`). */
export const installation = succeeded(
	compileInstallation(
		owned,
		servingParams(
			{
				...installOptions(owned),
				levels: allocatedLevels(identity.schema(parsedSchemaName("refined_order")), owned.levels)
			},
			Refined,
			{ passedTags: passedTags("the tag alone", "asc") }
		)
	)
)

export const catalog = installedCatalog(installation)

/** A query over a core: its ORDER BY, the core's targets, and whether the core is SELECT DISTINCT. */
interface OrderedCore {
	readonly orderBy: ReadonlyArray<OrderItem>
	readonly targets: ReadonlyArray<Target>
	readonly distinct: boolean
}

/** Every query of a statement, at any depth, whose body is a core. */
export const orderedCores = (statement: SqlStatement): ReadonlyArray<OrderedCore> => {
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

export type Feature = "ordered by a cast output" | "ordered by two outputs" | "the tag alone"
