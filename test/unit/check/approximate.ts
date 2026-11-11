import { element, type Gen, int, oneOf, weighted } from "@grizzle/testing/gen"
import { matching } from "@grizzle/testing/pattern"
import { Array as Arr } from "effect"
import { hnswPolicy } from "#compiler/check/approximate/policy.ts"
import type { CompileReasonTag } from "#compiler/core/errors.ts"
import {
	type AuthoredExprDesc,
	f,
	type HeadTermDesc,
	type QueryDesc,
	relation,
	type RuleDesc,
	type SchemaDesc
} from "#test/support/fixtures/ir/desc.ts"
import {
	approximateNearest,
	attach,
	compute,
	count,
	eq,
	imported,
	match,
	min,
	orderBy,
	param,
	parent,
	plainVar,
	queryDesc,
	ref,
	relationSource,
	rule,
	take,
	varRef,
	vars
} from "#test/unit/check/dsl.ts"

import { regex } from "arkregex"

/**
 * Approximate nearest-neighbour searches over a small schema of embeddings, and their eligibility rule restated as a
 * model: `by` names a column of the source and `take` is a positive integer (MalformedDescription), and the source is
 * one rule, read once per execution, whose `by` is the cosine distance between a stored vector HNSW indexes and a query
 * vector, with no aggregate (UnsupportedOperation); and the provenance rule: a result is approximate exactly when a
 * search lies among what it is computed from.
 */

/**
 * The embeddings E(id, owner, value), the scores F(id, weight, value) with a second vector of E's dimensions, and the
 * owners P(id): E's vectors of `dimensions`.
 */
export const searchSchema = (dimensions: number): SchemaDesc => ({
	name: "Search",
	relations: [
		relation("E", { id: f.uuid, owner: f.uuid, value: { kind: "vector", dimensions } }, ["id"]),
		relation(
			"F",
			{ id: f.uuid, weight: f.pg("double precision"), value: { kind: "vector", dimensions } },
			["id"]
		),
		relation("P", { id: f.uuid }, ["id"])
	],
	statements: [],
	extends: undefined
})

/** The dimensions a case's vectors have: a few, and either side of HNSW's bound, which the eligibility check reads. */
const dimensionsGen: Gen<number> = element([
	3,
	hnswPolicy.maxDimensions.value,
	hnswPolicy.maxDimensions.value + 1
])

/**
 * What a source's rule scores by: the cosine distance of E's vector to a query vector; F's double precision weight;
 * the distance between E's and F's stored vectors; or the least distance of each owner's vectors, an aggregate.
 */
export type Score = "query distance" | "a stored weight" | "two stored vectors" | "an aggregate"

/**
 * How the source is read: as the query itself; inside an attachment's child under each P, filtering or binding its
 * owner to the parent's id; or imported by a rule over P that binds the source's owner parameter to its own P.id or to
 * a parameter of its own.
 */
export type Reading =
	| "the query"
	| "an attachment filtering by its parent"
	| "an attachment binding its parent"
	| "an import bound to an outer variable"
	| "an import bound to a parameter"

export interface SearchCase {
	readonly dimensions: number
	readonly score: Score
	/** Two arms of the source rule, each its own query vector: a union. */
	readonly union: boolean
	readonly by: string
	readonly take: number
	readonly reading: Reading
}

/**
 * The source's heading: the scored id and its distance, or each owner and its least distance; inside an attachment,
 * also the correlation column that delivers the parent's id (check/checker.ts #attach): the head key owner where an
 * aggregate's head is the parent's id, else, where the child binds it at E's owner, a column named by owner, and where
 * a filter compares it, a column named by the parent's id, id_2 where the heading already has an id (check/scan.ts
 * freshColumnName).
 */
const headingOf = (c: SearchCase): ReadonlyArray<string> => {
	const own = c.score === "an aggregate" ? ["owner", "distance"] : ["id", "distance"]
	switch (c.reading) {
		case "an attachment binding its parent":
			return c.score === "an aggregate" ? own : [...own, "owner"]
		case "an attachment filtering by its parent":
			return [...own, Arr.contains(own, "id") ? "id_2" : "id"]
		case "the query":
		case "an import bound to an outer variable":
		case "an import bound to a parameter":
			return own
	}
}

/** Whether the source reads the owner parameter `o`: an import binds it. */
const readsOwner = (c: SearchCase): boolean =>
	c.reading === "an import bound to an outer variable" ||
	c.reading === "an import bound to a parameter"

export type SearchRule =
	| "by naming no column"
	| "a bound that is no positive integer"
	| "a source read per parent row"
	| "a source read per outer row"
	| "a score that is no query distance"
	| "a union"
	| "an aggregate"
	| "an indexed vector past HNSW's bound"
	| "by naming another column"

export type SearchVerdict =
	| { readonly kind: "admitted" }
	| {
			readonly kind: "refused"
			readonly reason: CompileReasonTag
			readonly rules: Arr.NonEmptyReadonlyArray<SearchRule>
	  }

/**
 * The model: the description's own faults first, then every eligibility fault the source has, the order the checker
 * states (check/approximate/index.ts), restated here as the oracle it is held to.
 */
export const searchVerdict = (c: SearchCase): SearchVerdict => {
	const malformed: ReadonlyArray<SearchRule> = [
		...(Arr.contains(headingOf(c), c.by) ? [] : ["by naming no column" as const]),
		...(Number.isSafeInteger(c.take) && c.take >= 1
			? []
			: ["a bound that is no positive integer" as const])
	]
	const [m, ...ms] = malformed
	if (m !== undefined) {
		return { kind: "refused", reason: "MalformedDescription", rules: [m, ...ms] }
	}
	const unsupported: ReadonlyArray<SearchRule> = [
		...(c.reading === "an attachment filtering by its parent" ||
		c.reading === "an attachment binding its parent"
			? ["a source read per parent row" as const]
			: []),
		...(c.reading === "an import bound to an outer variable"
			? ["a source read per outer row" as const]
			: []),
		...(c.score === "a stored weight" || c.score === "two stored vectors"
			? ["a score that is no query distance" as const]
			: []),
		...(c.union ? ["a union" as const] : []),
		...(c.score === "an aggregate" ? ["an aggregate" as const] : []),
		...(c.dimensions > hnswPolicy.maxDimensions.value
			? ["an indexed vector past HNSW's bound" as const]
			: []),
		...(c.by !== "distance" ? ["by naming another column" as const] : [])
	]
	const [u, ...us] = unsupported
	return u === undefined
		? { kind: "admitted" }
		: { kind: "refused", reason: "UnsupportedOperation", rules: [u, ...us] }
}

const queryVector = (c: SearchCase, name: string): AuthoredExprDesc =>
	param(name, { kind: "vector", dimensions: c.dimensions })

/** One arm of the source, scoring by `vector`, the owner filtered or bound as its reading asks. */
const sourceArm = (c: SearchCase, vector: string): RuleDesc => {
	const owner: AuthoredExprDesc = readsOwner(c)
		? param("o", f.uuid)
		: c.reading === "an attachment binding its parent"
			? parent("id")
			: ref("E", "owner")
	const ownedBy: ReadonlyArray<AuthoredExprDesc> =
		c.reading === "an attachment filtering by its parent"
			? [eq(ref("E", "owner"), parent("id"))]
			: []
	const distance = compute("cosineDistance", ref("E", "value"), queryVector(c, vector))
	const declared =
		owner.kind === "var" ? vars("E", "id", "owner", "value") : vars("E", "id", "value")
	const e = match(relationSource("E"), {
		id: ref("E", "id"),
		owner,
		value: ref("E", "value")
	})
	const head = (terms: Record<string, HeadTermDesc>): RuleDesc =>
		rule({ vars: declared, matches: [e], where: ownedBy, head: terms, interiors: [], attach: [] })
	switch (c.score) {
		case "query distance":
			return head({ id: ref("E", "id"), distance })
		case "an aggregate":
			return head({
				owner: owner.kind === "var" ? ref("E", "owner") : owner,
				distance: min(distance)
			})
		case "a stored weight":
			return rule({
				vars: [...declared, ...vars("F", "weight")],
				matches: [
					e,
					match(relationSource("F"), { id: ref("E", "id"), weight: ref("F", "weight") })
				],
				where: ownedBy,
				head: { id: ref("E", "id"), distance: ref("F", "weight") },
				interiors: [],
				attach: []
			})
		case "two stored vectors":
			return rule({
				vars: [...declared, ...vars("F", "value")],
				matches: [e, match(relationSource("F"), { id: ref("E", "id"), value: ref("F", "value") })],
				where: ownedBy,
				head: {
					id: ref("E", "id"),
					distance: compute("cosineDistance", ref("E", "value"), ref("F", "value"))
				},
				interiors: [],
				attach: []
			})
	}
}

/** The search: its source's arms, nearest by `by`, bounded by `take`. */
const searchOf = (c: SearchCase): QueryDesc => {
	const source = c.union
		? queryDesc(sourceArm(c, "q"), sourceArm(c, "other"))
		: queryDesc(sourceArm(c, "q"))
	return approximateNearest(source, c.by, c.take)
}

/** Each P, matched by a rule that delivers its id, and `matches`, which bind the variable `found`, or none. */
const owners = (matches: ReadonlyArray<ReturnType<typeof match>>): QueryDesc =>
	queryDesc(
		rule({
			vars: [...vars("P", "id"), ...(matches.length > 0 ? [plainVar("found")] : [])],
			matches: [match(relationSource("P"), { id: ref("P", "id") }), ...matches],
			where: [],
			head: { id: ref("P", "id") },
			interiors: [],
			attach: []
		})
	)

/** The case's query: the search read as the case reads it. */
export const searchCaseDesc = (c: SearchCase): QueryDesc => {
	const search = searchOf(c)
	switch (c.reading) {
		case "the query":
			return search
		case "an attachment filtering by its parent":
		case "an attachment binding its parent":
			return attach(owners([]), "near", search)
		case "an import bound to an outer variable":
		case "an import bound to a parameter": {
			const bind = {
				o:
					c.reading === "an import bound to an outer variable"
						? ref("P", "id")
						: param("o", f.uuid),
				q: queryVector(c, "q"),
				...(c.union ? { other: queryVector(c, "other") } : {})
			}
			return owners([match(imported(search, bind), { [headingOf(c)[0] ?? "id"]: varRef("found") })])
		}
	}
}

/** A name of no column of the source: an identifier led by a z, which no column of E, F or P, nor distance, is. */
const strayGen: Gen<string> = matching(regex("^z[a-zA-Z]{0,7}$"))

export const searchCaseGen: Gen<SearchCase> = (source) => {
	const score = source.draw(
		weighted<Score>([
			[4, element(["query distance"] as const)],
			[1, element(["a stored weight", "two stored vectors", "an aggregate"] as const)]
		])
	)
	return {
		dimensions: source.draw(dimensionsGen),
		score,
		union: source.draw(
			weighted([
				[1, element([true])],
				[5, element([false])]
			])
		),
		by: source.draw(
			weighted<string>([
				[6, element(["distance"])],
				[1, element(["id", "owner"])],
				[1, strayGen]
			])
		),
		take: source.draw(
			weighted([
				[8, int(1, 10)],
				[1, int(-2, 0)]
			])
		),
		reading: source.draw(
			oneOf<Reading>([
				element(["the query"] as const),
				element(["the query"] as const),
				element([
					"an attachment filtering by its parent",
					"an attachment binding its parent",
					"an import bound to an outer variable",
					"an import bound to a parameter"
				] as const)
			])
		)
	}
}

/**
 * What reads an admitted search: the search itself; an import of it, matched by a rule over P or folded by a count
 * over its key, the candidate's id and distance;
 * or, exactly, its source ordered by distance and bounded, or its source alone.
 */
export type Composition =
	| "the search"
	| "an import of the search"
	| "a count over the search"
	| "the source ordered by distance"
	| "the source"

export interface Provenance {
	readonly search: SearchCase
	readonly composition: Composition
}

/** Whether a composition is computed from the search. */
export const approximate = (composition: Composition): boolean => {
	switch (composition) {
		case "the search":
		case "an import of the search":
		case "a count over the search":
			return true
		case "the source ordered by distance":
		case "the source":
			return false
	}
}

export const provenanceDesc = (p: Provenance): QueryDesc => {
	const search = searchOf(p.search)
	const source = queryDesc(sourceArm(p.search, "q"))
	switch (p.composition) {
		case "the search":
			return search
		case "an import of the search":
			return owners([
				match(imported(search, { q: queryVector(p.search, "q") }), { id: varRef("found") })
			])
		case "a count over the search":
			return queryDesc(
				rule({
					vars: [plainVar("found"), plainVar("near")],
					matches: [
						match(imported(search, { q: queryVector(p.search, "q") }), {
							id: varRef("found"),
							distance: varRef("near")
						})
					],
					where: [],
					head: { n: count() },
					interiors: [],
					attach: []
				})
			)
		case "the source ordered by distance":
			return take(orderBy(source, ["distance", "asc"]), p.search.take)
		case "the source":
			return source
	}
}

/** An admitted search, its vectors indexable, and what reads it. */
export const provenanceGen: Gen<Provenance> = (source) => ({
	search: {
		dimensions: source.draw(element([3, hnswPolicy.maxDimensions.value])),
		score: "query distance",
		union: false,
		by: "distance",
		take: source.draw(int(1, 10)),
		reading: "the query"
	},
	composition: source.draw(
		element([
			"the search",
			"an import of the search",
			"a count over the search",
			"the source ordered by distance",
			"the source"
		] as const)
	)
})
