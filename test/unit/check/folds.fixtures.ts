/** What the properties of folds.test.ts read: its spaces, models and helpers. */

import { array, boolean, element, type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr, Option, Order, Record as Rec } from "effect"
import type { CompileReason } from "#compiler/core/errors.ts"
import type { TypedLiteral } from "#compiler/ir/expr.ts"
import type { RelNode } from "#compiler/ir/rel.ts"
import { Numeric } from "#compiler/scalar/values/decimal.ts"
import { f, relation, type SchemaDesc } from "#test/support/fixtures/ir/desc.ts"
import type {
	BindingsDesc,
	HeadTermDesc,
	MatchDesc,
	QueryDesc
} from "#test/support/fixtures/ir/desc.ts"
import { int4 } from "#test/support/oracle/gen/domain.ts"
import { canonicalFacts } from "#test/support/oracle/gen/facts.ts"
import type { GenSchema } from "#test/support/oracle/gen/schema.ts"
import { noBindings, Reference, unobserved } from "#test/support/oracle/reference/evaluate.ts"
import { noFunctions } from "#test/support/oracle/reference/functions.ts"
import type { Value } from "#test/support/oracle/reference/values.ts"
import {
	attach,
	count,
	lit,
	match,
	max,
	min,
	parent,
	queryDesc,
	ref,
	relationSource,
	rule,
	sum
} from "#test/support/unit/check/dsl.ts"

/**
 * A fold reads each fact its rule matches once, by a key (ir/rel.ts FoldInput, check/checker.ts foldInput), one rule
 * for every aggregate: count, sum, mean, min and max alike.
 *
 * The search draws every rule over Post(id, org, views), keyed by id, and Comment(id, post, author), keyed by id or
 * by (post, id), drawn, so a match can bind a key of two fields in part, of these
 * shapes: one match of either relation binding a nonempty subset of its fields; a join of Post bound by (id, org) with
 * Comment bound by its post, with or without Comment's id; and an attached child of Comment under each post, with or
 * without Comment's id. Each folds by an aggregate, grouped by a bound variable or not, with a constant beside the fold
 * or not, over a drawn database: up to four facts of each relation over small value domains, so equal values on
 * distinct facts (two posts of one org with equal views, two comments of one author on one post), a comment of no post
 * and no facts at all are all frequent.
 *
 * Two oracles judge it:
 *
 * - the rule turned into a checker: a fold is refused (FoldOverProjection) exactly when some match binds no key of its
 *   source whole, at that match, naming its source and the key to bind (its primary key), and admitted otherwise;
 * - a second implementation, the host's fold: every admitted fold's answer from the reference evaluator over the
 *   checked IR equals the host's fold over the matched facts, each matched fact tuple once, so equal values on distinct
 *   facts both contribute. A mean is compared to meanDigits places, every other fold exactly (foldText).
 *
 * Features: each shape and aggregate, refused and admitted; equal values summed twice; a constant beside the fold; a
 * match binding a key of two fields in part, refused, and whole, admitted.
 */

/** Comment's primary key: its id, or its post and id, so a match can bind a key of two fields in part. */
type CommentKey = readonly ["id"] | readonly ["post", "id"]

const commentKeys: Arr.NonEmptyReadonlyArray<CommentKey> = [["id"], ["post", "id"]]

/** The box's schema, Comment keyed by `commentKey`. */
export const blogOf = (commentKey: CommentKey): SchemaDesc => ({
	name: "Blog",
	relations: [
		relation("Post", { id: f.integer, org: f.integer, views: f.integer }, ["id"]),
		relation("Comment", { id: f.integer, post: f.integer, author: f.integer }, commentKey)
	],
	statements: [],
	bases: []
})

/** Blog as the reference reads its Base nodes: each relation's columns in declared order, Comment keyed by `commentKey`. */
const blogFactsOf = (commentKey: CommentKey): GenSchema => ({
	name: "Blog",
	relations: [
		{
			name: "Post",
			columns: [
				{ name: "id", type: int4 },
				{ name: "org", type: int4 },
				{ name: "views", type: int4 }
			],
			primaryKey: ["id"],
			keys: [],
			mutable: false
		},
		{
			name: "Comment",
			columns: [
				{ name: "id", type: int4 },
				{ name: "post", type: int4 },
				{ name: "author", type: int4 }
			],
			primaryKey: commentKey,
			keys: [],
			mutable: false
		}
	],
	closed: [],
	containments: []
})

type RelationName = "Post" | "Comment"

type Field = "id" | "org" | "views" | "post" | "author"

const fieldsOf: Readonly<Record<RelationName, readonly [Field, Field, Field]>> = {
	Post: ["id", "org", "views"],
	Comment: ["id", "post", "author"]
}

type Fn = "count" | "sum" | "mean" | "min" | "max"

const fns: Arr.NonEmptyReadonlyArray<Fn> = ["count", "sum", "mean", "min", "max"]

/** A fact row of three integer columns, in its relation's declared order. */
type Fact = readonly [number, number, number]

/** A database of the search: each relation's facts, keyed by their positions. */
type Database = Readonly<Record<RelationName, ReadonlyArray<Fact>>>

/** Up to four facts of a relation, its id its position, its other fields from small domains. */
const factsGen =
	(other: readonly [Gen<number>, Gen<number>]): Gen<ReadonlyArray<Fact>> =>
	(source) =>
		Arr.map(
			source.draw(array((s) => [s.draw(other[0]), s.draw(other[1])] as const, { min: 0, max: 4 })),
			([a, b], i): Fact => [i + 1, a, b]
		)

/** Posts of one of two orgs with up to two views, and comments on one of five posts by one of two authors. */
const databaseGen: Gen<Database> = (source) => ({
	Post: source.draw(factsGen([int(10, 11), int(0, 2)])),
	Comment: source.draw(factsGen([int(1, 5), int(100, 101)]))
})

/**
 * A rule shape of the box: a match of one relation binding `bound`; Post by (id, org) joined to Comment by its post,
 * Comment's id bound or not; or Comment attached under each post, its id bound or not.
 */
type Shape =
	| { readonly kind: "one"; readonly relation: RelationName; readonly bound: ReadonlyArray<Field> }
	| { readonly kind: "join"; readonly commentId: boolean }
	| { readonly kind: "attached"; readonly commentId: boolean }

interface FoldCase {
	readonly commentKey: CommentKey
	readonly shape: Shape
	readonly fn: Fn
	readonly grouped: boolean
	/** A constant head term beside the fold, which is no group key: one value delivered in every group's row. */
	readonly constant: boolean
	readonly database: Database
}

/** Every rule shape: one relation's match binding a nonempty subset of its fields, a join or an attachment. */
const shapeGen: Gen<Shape> = (source) => {
	const kind = source.draw(int(0, 2))
	if (kind === 0) {
		const relation = source.draw(boolean) ? "Comment" : "Post"
		const mask = source.draw(int(1, 7))
		return {
			kind: "one",
			relation,
			bound: Arr.filter(fieldsOf[relation], (_, i) => ((mask >> i) & 1) === 1)
		}
	}
	return { kind: kind === 1 ? "join" : "attached", commentId: source.draw(boolean) }
}

export const caseGen: Gen<FoldCase> = (source) => ({
	commentKey: source.draw(element(commentKeys)),
	shape: source.draw(shapeGen),
	fn: source.draw(element(fns)),
	grouped: source.draw(boolean),
	constant: source.draw(boolean),
	database: source.draw(databaseGen)
})

/** The constant a case's head delivers beside its fold, where it states one. */
const constantValue = 7

/** The constant head term of a case, under `k`, or none. */
const constantTerm = (c: FoldCase): Record<string, HeadTermDesc> =>
	c.constant ? { k: lit(constantValue) } : {}

/** The variables a rule declares at a relation's fields, each named by its relation and field (dsl.ts vars). */
const varsOf = (relation: RelationName, fields: ReadonlyArray<Field>) =>
	Arr.map(fields, (field) => ({ id: `${relation}.${field}`, origin: { relation, field } }))

/** The variable a match binds at a relation's field, named by its relation and field (dsl.ts vars). */
const v = (relation: RelationName, field: Field) => ref(relation, field)

/** The aggregate of a case over its argument: count over none, every other over the argument. */
const aggregate = (fn: Fn, arg: ReturnType<typeof ref>): HeadTermDesc => {
	switch (fn) {
		case "count":
			return count()
		case "sum":
			return sum(arg)
		case "mean":
			return { kind: "aggregate", fn: "mean", arg }
		case "min":
			return min(arg)
		case "max":
			return max(arg)
	}
}

/** A match of `relation` binding each of `bound` to its own variable. */
const matchOf = (relation: RelationName, bound: ReadonlyArray<Field>): MatchDesc =>
	match(
		relationSource(relation),
		Rec.fromEntries(
			Arr.map(bound, (field) => [field, v(relation, field)] as const)
		) satisfies BindingsDesc
	)

/**
 * What a case folds: the query, the match the oracle refuses at (its relation) or none, and the relation and fields the
 * head groups by and folds.
 */
interface Built {
	readonly query: QueryDesc
	/** The relation of the first match that binds no key whole, which the checker must name. */
	readonly refusedAt: RelationName | undefined
	readonly group: { readonly relation: RelationName; readonly field: Field } | undefined
	readonly arg: { readonly relation: RelationName; readonly field: Field }
}

/** A relation's primary key in a case: Post's id, Comment's drawn key. */
export const keyOf = (c: FoldCase, relation: RelationName): ReadonlyArray<Field> =>
	relation === "Comment" ? c.commentKey : ["id"]

/** A key is bound when the match binds every one of its fields. */
const binds = (key: ReadonlyArray<Field>, bound: ReadonlyArray<Field>): boolean =>
	Arr.every(key, (field) => bound.includes(field))

export const built = (c: FoldCase): Built => {
	switch (c.shape.kind) {
		case "one": {
			const relation = c.shape.relation
			const bound = c.shape.bound
			/** A grouped fold groups by its first bound field but the key, where it binds another to fold. */
			const groupField = c.grouped
				? Option.getOrUndefined(
						Arr.findFirst(bound, (field, i) => field !== "id" && i < bound.length - 1)
					)
				: undefined
			const argField = Option.getOrElse(
				Arr.findLast(bound, (field) => field !== groupField),
				(): Field => "id"
			)
			const group = groupField === undefined ? undefined : { relation, field: groupField }
			const head: Record<string, HeadTermDesc> = {
				...(groupField === undefined ? {} : { g: v(relation, groupField) }),
				x: aggregate(c.fn, v(relation, argField)),
				...constantTerm(c)
			}
			return {
				query: queryDesc(
					rule({
						vars: varsOf(relation, bound),
						matches: [matchOf(relation, bound)],
						where: [],
						head,
						interiors: [],
						attach: []
					})
				),
				refusedAt: binds(keyOf(c, relation), bound) ? undefined : relation,
				group,
				arg: { relation, field: argField }
			}
		}
		case "join": {
			const commentBound: ReadonlyArray<Field> = c.shape.commentId ? ["id", "author"] : ["author"]
			const head: Record<string, HeadTermDesc> = {
				...(c.grouped ? { g: v("Post", "org") } : {}),
				x: aggregate(c.fn, v("Comment", "author")),
				...constantTerm(c)
			}
			return {
				query: queryDesc(
					rule({
						vars: [...varsOf("Post", ["id", "org"]), ...varsOf("Comment", commentBound)],
						matches: [
							matchOf("Post", ["id", "org"]),
							match(relationSource("Comment"), {
								post: v("Post", "id"),
								...Rec.fromEntries(
									Arr.map(commentBound, (field) => [field, v("Comment", field)] as const)
								)
							})
						],
						where: [],
						head,
						interiors: [],
						attach: []
					})
				),
				refusedAt: binds(keyOf(c, "Comment"), ["post", ...commentBound]) ? undefined : "Comment",
				group: c.grouped ? { relation: "Post", field: "org" } : undefined,
				arg: { relation: "Comment", field: "author" }
			}
		}
		case "attached": {
			const commentBound: ReadonlyArray<Field> = c.shape.commentId ? ["id", "author"] : ["author"]
			const child = queryDesc(
				rule({
					vars: varsOf("Comment", commentBound),
					matches: [
						match(relationSource("Comment"), {
							post: parent("id"),
							...Rec.fromEntries(
								Arr.map(commentBound, (field) => [field, v("Comment", field)] as const)
							)
						})
					],
					where: [],
					head: {
						...(c.grouped ? { g: v("Comment", "author") } : {}),
						x: aggregate(c.fn, v("Comment", "author")),
						...constantTerm(c)
					},
					interiors: [],
					attach: []
				})
			)
			return {
				query: attach(
					queryDesc(
						rule({
							vars: varsOf("Post", ["id"]),
							matches: [matchOf("Post", ["id"])],
							where: [],
							head: { id: v("Post", "id") },
							interiors: [],
							attach: []
						})
					),
					"comments",
					child
				),
				refusedAt: binds(keyOf(c, "Comment"), ["post", ...commentBound]) ? undefined : "Comment",
				group: c.grouped ? { relation: "Comment", field: "author" } : undefined,
				arg: { relation: "Comment", field: "author" }
			}
		}
	}
}

/** A fact's value at a field of its relation. */
const at = (relation: RelationName, fact: Fact, field: Field): number =>
	fact[fieldsOf[relation].indexOf(field)] ?? Number.NaN

/** The matched fact tuples of a root rule: each fact of its one relation, or each (post, comment) a comment names. */
const matched = (c: FoldCase): ReadonlyArray<(relation: RelationName) => Fact | undefined> => {
	const db = c.database
	if (c.shape.kind === "one") {
		const relation = c.shape.relation
		return Arr.map(db[relation], (fact) => (r: RelationName) => (r === relation ? fact : undefined))
	}
	return Arr.flatMap(db.Post, (post) =>
		Arr.flatMap(db.Comment, (comment) =>
			at("Comment", comment, "post") === at("Post", post, "id")
				? [(r: RelationName) => (r === "Post" ? post : comment)]
				: []
		)
	)
}

/** The host's fold of one group's matched tuples by the case's aggregate, as a canonical text. */
const folded = (fn: Fn, values: Arr.NonEmptyReadonlyArray<number>): string => {
	const total = Arr.reduce(values, 0, (a, b) => a + b)
	switch (fn) {
		case "count":
			return String(values.length)
		case "sum":
			return String(total)
		case "mean":
			return (total / values.length).toFixed(meanDigits)
		case "min":
			return String(Arr.reduce(values, values[0], (a, b) => Math.min(a, b)))
		case "max":
			return String(Arr.reduce(values, values[0], (a, b) => Math.max(a, b)))
	}
}

/**
 * The host's answer to a root fold: one row per group of the matched tuples, its group value (or none) and its fold,
 * as canonical texts in a sorted list; no row for an aggregate-only fold over nothing.
 */
export const hostAnswer = (c: FoldCase, b: Built): ReadonlyArray<string> => {
	const tuples = matched(c)
	const groupOf = (t: (relation: RelationName) => Fact | undefined): string => {
		if (b.group === undefined) {
			return ""
		}
		const fact = t(b.group.relation)
		return fact === undefined ? "" : String(at(b.group.relation, fact, b.group.field))
	}
	const groups = Arr.groupBy(tuples, groupOf)
	return Arr.sort(
		Arr.flatMap(Rec.toEntries(groups), ([g, members]) => {
			const values = Arr.flatMap(members, (t) => {
				const fact = t(b.arg.relation)
				return fact === undefined ? [] : [at(b.arg.relation, fact, b.arg.field)]
			})
			const constant = c.constant ? `|${constantValue}` : ""
			return Arr.isReadonlyArrayNonEmpty(values)
				? [
						b.group === undefined
							? `${folded(c.fn, values)}${constant}`
							: `${g}|${folded(c.fn, values)}${constant}`
					]
				: []
		}),
		Order.String
	)
}

/**
 * The digits a mean is compared to: its exact value is the total over the count, which the reference holds as a numeric
 * of some scale and the host as a double, and a contribution counted twice or dropped moves it far more than either's
 * rounding at this many digits.
 */
const meanDigits = 9

/**
 * A reference value as the host's canonical text, exactly: an integer's digits, or a numeric's one text (a sum over
 * integers is an exact numeric of scale 0, scalar/aggregate.ts widenedSum, so a sum of 1 is "1").
 */
const exactText = (value: Value): string =>
	typeof value === "bigint" || value instanceof Numeric
		? value.toString()
		: `a value of no fold this box folds: ${typeof value}`

/** A mean as the host's canonical text: its numeric to meanDigits places. */
const meanText = (value: Value): string =>
	value instanceof Numeric
		? Number(value.toString()).toFixed(meanDigits)
		: `a mean that is no numeric: ${typeof value}`

/**
 * How each fold's answer is compared, read by the fold that answered it and never by its value's class: a mean to
 * meanDigits places, every other fold exactly.
 */
const foldText: Readonly<Record<Fn, (value: Value) => string>> = {
	count: exactText,
	sum: exactText,
	mean: meanText,
	min: exactText,
	max: exactText
}

/** The reference evaluator's answer to the checked root, in the host's canonical form. */
export const referenceAnswer = (
	root: RelNode,
	dag: Parameters<typeof Reference.of>[0],
	c: FoldCase,
	b: Built
): ReadonlyArray<string> => {
	const literals = (rows: ReadonlyArray<Fact>): ReadonlyArray<ReadonlyArray<TypedLiteral>> =>
		Arr.map(rows, (row) => Arr.map(row, (n): TypedLiteral => ({ kind: "int", value: BigInt(n) })))
	const db = c.database
	const reference = Reference.of(dag, {
		schema: blogFactsOf(c.commentKey),
		facts: canonicalFacts({ Post: literals(db.Post), Comment: literals(db.Comment) }),
		params: {},
		functions: noFunctions,
		observer: unobserved
	})
	const relation = reference.eval(root, noBindings)
	const index = (name: string) => Arr.findFirstIndex(relation.heading, (h) => h.name === name)
	const x = index("x")
	const g = index("g")
	const k = index("k")
	return Arr.sort(
		Arr.map(relation.rows, (row) => {
			const fold = Option.match(x, {
				onNone: () => "no x",
				onSome: (i) => foldText[c.fn](row[i] ?? Number.NaN)
			})
			const constant = c.constant
				? `|${Option.match(k, { onNone: () => "no k", onSome: (i) => exactText(row[i] ?? Number.NaN) })}`
				: ""
			return b.group === undefined
				? `${fold}${constant}`
				: `${Option.match(g, { onNone: () => "no g", onSome: (i) => exactText(row[i] ?? Number.NaN) })}|${fold}${constant}`
		}),
		Order.String
	)
}

/** What a case reached: the oracle's verdict by shape kind, and every aggregate refused and admitted. */
export type Feature =
	| `refused ${Fn}`
	| `admitted ${Fn}`
	| `refused ${Shape["kind"]}`
	| `admitted ${Shape["kind"]}`
	| "equal values summed twice"
	| "a constant beside the fold"
	| "refused a key of two fields bound in part"
	| "admitted a key of two fields"

export const situations: Arr.NonEmptyReadonlyArray<Feature> = [
	"refused one",
	"admitted one",
	"refused join",
	"admitted join",
	"refused attached",
	"admitted attached",
	"equal values summed twice",
	"a constant beside the fold",
	"refused a key of two fields bound in part",
	"admitted a key of two fields",
	...Arr.flatMap(fns, (fn): ReadonlyArray<Feature> => [`refused ${fn}`, `admitted ${fn}`])
]

export const refusalOf = (
	reason: CompileReason
): Extract<CompileReason, { _tag: "FoldOverProjection" }> | undefined =>
	reason._tag === "FoldOverProjection" ? reason : undefined

/** Whether a case's rule matches Comment. */
export const matchesComment = (c: FoldCase): boolean =>
	c.shape.kind !== "one" || c.shape.relation === "Comment"

/** Whether a case's one match of Comment binds some field of its key of two fields but not every one. */
export const boundPart = (c: FoldCase): boolean => {
	if (c.shape.kind !== "one" || c.shape.relation !== "Comment") {
		return false
	}
	const bound = c.shape.bound
	return Arr.some(c.commentKey, (field) => bound.includes(field)) && !binds(c.commentKey, bound)
}

/** Whether some group of a case's matched tuples holds two of them whose folded values are equal. */
export const equalValuesTwice = (c: FoldCase, b: Built): boolean => {
	const values = Arr.flatMap(matched(c), (t) => {
		const arg = t(b.arg.relation)
		const group = b.group === undefined ? undefined : t(b.group.relation)
		return arg === undefined
			? []
			: [
					`${group === undefined || b.group === undefined ? "" : at(b.group.relation, group, b.group.field)}|${at(b.arg.relation, arg, b.arg.field)}`
				]
	})
	return new Set(values).size < values.length
}
