import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Option, Order, Record as Rec } from "effect"
import { checkQuery } from "#compiler/check/index.ts"
import type { CompileReason } from "#compiler/core/errors.ts"
import type { TypedLiteral } from "#compiler/ir/expr.ts"
import type { RelNode } from "#compiler/ir/rel.ts"
import { assert } from "#test/support/assert.ts"
import { f, relation, type SchemaDesc } from "#test/support/fixtures/ir/desc.ts"
import { caseHang } from "#test/support/limits.ts"
import { int4 } from "#test/support/oracle/gen/domain.ts"
import { canonicalFacts } from "#test/support/oracle/gen/facts.ts"
import type { GenSchema } from "#test/support/oracle/gen/schema.ts"
import { noBindings, Reference, unobserved } from "#test/support/oracle/reference/evaluate.ts"
import type { Value } from "#test/support/oracle/reference/values.ts"
import { checking, checkOptions } from "#test/support/policy.ts"
import {
	attach,
	count,
	match,
	max,
	min,
	parent,
	queryDesc,
	ref,
	relationSource,
	rule,
	sum,
	vars
} from "#test/unit/check/dsl.ts"
import type {
	BindingsDesc,
	HeadTermDesc,
	MatchDesc,
	QueryDesc
} from "#test/support/fixtures/ir/desc.ts"

/**
 * A fold reads each fact its rule matches once, by a key (ir/rel.ts FoldInput, check/checker.ts foldInput), one rule
 * for every aggregate: count, sum, mean, min and max alike.
 *
 * The box is every rule over Post(id, org, views) and Comment(id, post, author), both keyed by id, of these shapes:
 * one match of either relation binding each nonempty subset of its fields; a join of Post bound by (id, org) with
 * Comment bound by its post, with or without Comment's id; and an attached child of Comment under each post, with or
 * without Comment's id. Each folds by each aggregate, grouped by a bound variable or not, over each of three
 * databases: equal values on distinct facts (two posts of one org with equal views, two comments of one author on one
 * post), all values distinct, and no facts.
 *
 * Two oracles judge it:
 *
 * - the rule turned into a checker: a fold is refused (FoldOverProjection) exactly when some match binds no key of its
 *   source whole, at that match, naming its source and the key to bind (its primary key), and admitted otherwise;
 * - a second implementation, the host's fold: every admitted fold's answer from the reference evaluator over the
 *   checked IR equals the host's fold over the matched facts, each matched fact tuple once. Two posts of one org with
 *   five views each sum to ten, and two comments on one post count two: equal values on distinct facts both
 *   contribute.
 *
 * Bound: the box is exhausted, 336 cases.
 */

const Blog: SchemaDesc = {
	name: "Blog",
	relations: [
		relation("Post", { id: f.integer, org: f.integer, views: f.integer }, ["id"]),
		relation("Comment", { id: f.integer, post: f.integer, author: f.integer }, ["id"])
	],
	statements: [],
	extends: undefined
}

/** Blog as the reference reads its Base nodes: each relation's columns in declared order, keyed by id. */
const blogFacts: GenSchema = {
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
			primaryKey: ["id"],
			keys: [],
			mutable: false
		}
	],
	closed: [],
	containments: []
}

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

/** The databases of the box: equal values on distinct facts, all values distinct, and none. */
type Database = "equal values" | "distinct values" | "empty"
const databases: Readonly<Record<Database, Readonly<Record<RelationName, ReadonlyArray<Fact>>>>> = {
	"equal values": {
		Post: [
			[1, 10, 5],
			[2, 10, 5],
			[3, 20, 7]
		],
		Comment: [
			[1, 1, 100],
			[2, 1, 100],
			[3, 2, 101]
		]
	},
	"distinct values": {
		Post: [
			[1, 10, 5],
			[2, 20, 6]
		],
		Comment: [
			[1, 1, 100],
			[2, 2, 101]
		]
	},
	empty: { Post: [], Comment: [] }
}

/**
 * A rule shape of the box: a match of one relation binding `bound`; Post by (id, org) joined to Comment by its post,
 * Comment's id bound or not; or Comment attached under each post, its id bound or not.
 */
type Shape =
	| { readonly kind: "one"; readonly relation: RelationName; readonly bound: ReadonlyArray<Field> }
	| { readonly kind: "join"; readonly commentId: boolean }
	| { readonly kind: "attached"; readonly commentId: boolean }

interface FoldCase {
	readonly shape: Shape
	readonly fn: Fn
	readonly grouped: boolean
	readonly database: Database
}

/** Every nonempty subset of a relation's fields, in field order. */
const subsets = (fields: ReadonlyArray<Field>): ReadonlyArray<ReadonlyArray<Field>> =>
	Arr.filter(
		Arr.map(Arr.range(1, (1 << fields.length) - 1), (mask) =>
			Arr.filter(fields, (_, i) => ((mask >> i) & 1) === 1)
		),
		Arr.isReadonlyArrayNonEmpty
	)

const shapes: ReadonlyArray<Shape> = [
	...Arr.flatMap(["Post", "Comment"] as const, (relation) =>
		Arr.map(subsets(fieldsOf[relation]), (bound): Shape => ({ kind: "one", relation, bound }))
	),
	{ kind: "join", commentId: true },
	{ kind: "join", commentId: false },
	{ kind: "attached", commentId: true },
	{ kind: "attached", commentId: false }
]

const cases: Arr.NonEmptyReadonlyArray<FoldCase> = Arr.flatMap(shapes, (shape) =>
	Arr.flatMap(fns, (fn) =>
		Arr.flatMap([false, true], (grouped) =>
			Arr.map(
				Rec.keys(databases),
				(database): FoldCase => ({ shape, fn, grouped, database })
			)
		)
	)
).filter((c) => c.shape.kind !== "attached" || c.database !== "distinct values") as never

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
		Rec.fromEntries(Arr.map(bound, (field) => [field, v(relation, field)] as const)) satisfies BindingsDesc
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

/** A key is bound when the match binds its one field, the relation's id. */
const binds = (bound: ReadonlyArray<Field>): boolean => bound.includes("id")

const built = (c: FoldCase): Built => {
	switch (c.shape.kind) {
		case "one": {
			const relation = c.shape.relation
			const bound = c.shape.bound
			const [first, second] = bound
			const groupField = c.grouped && second !== undefined ? first : undefined
			const argField = Option.getOrElse(
				Arr.findLast(bound, (field) => field !== groupField),
				() => first ?? "id"
			)
			const group = groupField === undefined ? undefined : { relation, field: groupField }
			const head: Record<string, HeadTermDesc> = {
				...(groupField === undefined ? {} : { g: v(relation, groupField) }),
				x: aggregate(c.fn, v(relation, argField))
			}
			return {
				query: queryDesc(
					rule({
						vars: vars(relation, ...bound),
						matches: [matchOf(relation, bound)],
						where: [],
						head,
						interiors: [],
						attach: []
					})
				),
				refusedAt: binds(bound) ? undefined : relation,
				group,
				arg: { relation, field: argField }
			}
		}
		case "join": {
			const commentBound: ReadonlyArray<Field> = c.shape.commentId ? ["id", "author"] : ["author"]
			const head: Record<string, HeadTermDesc> = {
				...(c.grouped ? { g: v("Post", "org") } : {}),
				x: aggregate(c.fn, v("Comment", "author"))
			}
			return {
				query: queryDesc(
					rule({
						vars: [...vars("Post", "id", "org"), ...vars("Comment", ...commentBound)],
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
				refusedAt: c.shape.commentId ? undefined : "Comment",
				group: c.grouped ? { relation: "Post", field: "org" } : undefined,
				arg: { relation: "Comment", field: "author" }
			}
		}
		case "attached": {
			const commentBound: ReadonlyArray<Field> = c.shape.commentId ? ["id", "author"] : ["author"]
			const child = queryDesc(
				rule({
					vars: vars("Comment", ...commentBound),
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
						x: aggregate(c.fn, v("Comment", "author"))
					},
					interiors: [],
					attach: []
				})
			)
			return {
				query: attach(
					queryDesc(
						rule({
							vars: vars("Post", "id"),
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
				refusedAt: c.shape.commentId ? undefined : "Comment",
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
const matched = (
	c: FoldCase
): ReadonlyArray<(relation: RelationName) => Fact | undefined> => {
	const db = databases[c.database]
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
			return String(total / values.length)
		case "min":
			return String(Math.min(...values))
		case "max":
			return String(Math.max(...values))
	}
}

/**
 * The host's answer to a root fold: one row per group of the matched tuples, its group value (or none) and its fold,
 * as canonical texts in a sorted list; no row for an aggregate-only fold over nothing.
 */
const hostAnswer = (c: FoldCase, b: Built): ReadonlyArray<string> => {
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
			return Arr.isReadonlyArrayNonEmpty(values)
				? [b.group === undefined ? folded(c.fn, values) : `${g}|${folded(c.fn, values)}`]
				: []
		}),
		Order.String
	)
}

/** A reference value as the host's canonical text: an integer's digits, a double's shortest spelling. */
const valueText = (value: Value): string =>
	typeof value === "bigint" || typeof value === "number" ? String(value) : `unexpected ${String(value)}`

/** The reference evaluator's answer to the checked root, in the host's canonical form. */
const referenceAnswer = (root: RelNode, dag: Parameters<typeof Reference.of>[0], c: FoldCase, b: Built) => {
	const literals = (rows: ReadonlyArray<Fact>): ReadonlyArray<ReadonlyArray<TypedLiteral>> =>
		Arr.map(rows, (row) => Arr.map(row, (n): TypedLiteral => ({ kind: "int", value: BigInt(n) })))
	const db = databases[c.database]
	const reference = Reference.of(dag, {
		schema: blogFacts,
		facts: canonicalFacts({ Post: literals(db.Post), Comment: literals(db.Comment) }),
		params: {},
		observer: unobserved
	})
	const relation = reference.eval(root, noBindings)
	const index = (name: string) => Arr.findFirstIndex(relation.heading, (h) => h.name === name)
	const x = index("x")
	const g = index("g")
	return Arr.sort(
		Arr.map(relation.rows, (row) => {
			const fold = Option.match(x, {
				onNone: () => "no x",
				onSome: (i) => valueText(row[i] ?? Number.NaN)
			})
			return b.group === undefined
				? fold
				: `${Option.match(g, { onNone: () => "no g", onSome: (i) => valueText(row[i] ?? Number.NaN) })}|${fold}`
		}),
		Order.String
	)
}

/** What a case reached: the oracle's verdict by shape kind, and every aggregate refused and admitted. */
type Feature =
	| `refused ${Fn}`
	| `admitted ${Fn}`
	| `refused ${Shape["kind"]}`
	| `admitted ${Shape["kind"]}`
	| "equal values summed twice"

const required: Arr.NonEmptyReadonlyArray<Feature> = [
	...Arr.flatMap(fns, (fn): ReadonlyArray<Feature> => [`refused ${fn}`, `admitted ${fn}`]),
	"refused one",
	"admitted one",
	"refused join",
	"admitted join",
	"refused attached",
	"admitted attached",
	"equal values summed twice"
]

const refusalOf = (reason: CompileReason): Extract<CompileReason, { _tag: "FoldOverProjection" }> | undefined =>
	reason._tag === "FoldOverProjection" ? reason : undefined

describe("a fold reads each fact it matches once, by a key", () => {
	it.effect(
		`is refused exactly where a match binds no key of its source, and otherwise folds every matched fact, over the box of ${cases.length} cases`,
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/check/folds",
						generator: element(cases),
						literal: (c: FoldCase) => JSON.stringify(c),
						limit: cases.length,
						coverage: requiredInSpace<Feature>(required),
						caseHang
					},
					(c, k) =>
						Effect.sync(() => {
							const b = built(c)
							const checked = checkQuery(checking(Blog), b.query, checkOptions("query"))
							if (b.refusedAt !== undefined) {
								assert.equal(checked.ok, false, "a fold over a projection is refused")
								if (checked.ok) {
									return
								}
								const refusal = refusalOf(checked.error.reason)
								assert.deepEqual(
									refusal === undefined ? undefined : { source: refusal.source, key: refusal.key },
									{ source: b.refusedAt, key: ["id"] },
									"the refusal names the match's source and its key"
								)
								k.note(`refused ${c.fn}`)
								k.note(`refused ${c.shape.kind}`)
								return
							}
							assert.equal(checked.ok, true, "a fold over keyed facts is admitted")
							if (!checked.ok) {
								return
							}
							k.note(`admitted ${c.fn}`)
							k.note(`admitted ${c.shape.kind}`)
							if (c.shape.kind === "attached") {
								return
							}
							const root = checked.value.dag.roots[0]
							const expected = hostAnswer(c, b)
							assert.deepEqual(
								referenceAnswer(root, checked.value.dag, c, b),
								expected,
								"the checked fold's answer is the host's fold over every matched fact"
							)
							if (
								c.fn === "sum" &&
								c.database === "equal values" &&
								c.shape.kind === "one" &&
								c.shape.relation === "Post" &&
								b.arg.field === "views" &&
								b.group?.field === "org"
							) {
								assert.ok(expected.includes("10|10"), "two posts of org 10 with 5 views sum to 10")
								k.note("equal values summed twice")
							}
						})
				)
			)
	)
})
