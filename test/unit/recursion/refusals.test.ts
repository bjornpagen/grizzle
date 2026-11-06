import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { boolean, element, filter, type Gen } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Order, Record as Rec } from "effect"
import { checkQuery } from "#compiler/check/index.ts"
import type { RecursionRefusal } from "#compiler/core/causes.ts"
import type { CompileReasonTag } from "#compiler/core/errors.ts"
import { int8Max, int8Min } from "#compiler/core/limits.ts"
import { formatLoc } from "#compiler/core/loc.ts"
import { DecimalText } from "#compiler/ir/decimal.ts"
import type { FieldDesc } from "#compiler/ir/desc.ts"
import type { LogicalQuery } from "#compiler/ir/products.ts"
import { pg, span, uuid } from "#compiler/public/fields.ts"
import { type Rule, type SelfSource, v } from "#compiler/public/query.ts"
import { schema, relation as table } from "#compiler/public/schema.ts"
import { queryOver as untypedQuery } from "#compiler/query/build/query.ts"
import { assert, containsEqual, containsText, defined, succeeded } from "#test/support/assert.ts"
import {
	type AuthoredExprDesc as ExprDesc,
	type HeadTermDesc,
	type MatchDesc,
	type QueryDesc,
	type RuleDesc,
	textDesc,
	type VarDesc
} from "#test/support/fixtures/ir/desc.ts"

import { caseHang } from "#test/support/limits.ts"
import { argumentsOf } from "#test/support/list.ts"
import { checking, checkOptions } from "#test/support/policy.ts"
import {
	approximateNearest,
	cast,
	compute,
	count,
	eq,
	gt,
	imported,
	lt,
	match,
	narrowed,
	ne,
	not,
	or,
	param,
	plainVar,
	queryDesc,
	ref,
	relationSource,
	rule,
	typedLit,
	varRef,
	vars
} from "#test/unit/check/dsl.ts"
import { descOf, Graph, lower, nodes, reads, theRecursive } from "#test/unit/recursion/fixtures.ts"

/**
 * What recursion admission refuses, each with its typed cause (core/causes.ts RecursionRefusal), judged by planted
 * bounded-exhaustive properties: each family's rule, as check/recursion states it, restated as a model over a small
 * space of definitions that breaks it in every way the rule names and keeps it in the controls beside them. A refusal is
 * compared by its cause, never its prose; where several rules refuse one definition, the cause is one of theirs, since
 * admission states no priority among them.
 *
 * - an arm whose head misses or adds a state column, at that arm's head (scan.ts);
 * - a state column an arm delivers at another identity, another numeric typmod or an unproved text refinement, and a
 *   state column with no hashing (state.ts); an exact conversion is cast;
 * - feedback read twice, self outside a recursive arm's own matches, r.not(self), an aggregate or r.pack over self,
 *   an approximate stage below an arm (scan.ts); an aggregate in the base, and a recursive arm reading no self, are
 *   admitted;
 * - a state column computed from its own value with no admitted bound, directly, through a cycle of computed columns
 *   or through an import whose bind map reads the state; a countdown seeded by data counts its carrier
 *   (termination.ts).
 *
 * These definitions are built by hand because no generator draws them: the generated recursions
 * (unit/recursion/certificates) seed literals over one integer counter, a tag and a mark, and never break a head, a
 * type, the feedback's shape or an import.
 */

/**
 * The outcome of checking a definition over Graph: admitted, refused by recursion admission with its
 * cause and where, or refused by another rule with its reason.
 */
type Outcome =
	| { readonly kind: "admitted"; readonly query: LogicalQuery }
	| { readonly kind: "refused"; readonly cause: RecursionRefusal; readonly location: string }
	| { readonly kind: "malformed"; readonly reason: CompileReasonTag }

const outcomeOf = (desc: QueryDesc): Outcome => {
	const r = checkQuery(checking(Graph), desc, checkOptions("query"))
	if (r.ok) {
		return { kind: "admitted", query: r.value }
	}
	if (r.error.reason._tag === "RecursionRefused") {
		return { kind: "refused", cause: r.error.reason.cause, location: formatLoc(r.error.reason.at) }
	}
	return { kind: "malformed", reason: r.error.reason._tag }
}

const admitted = (o: Outcome): LogicalQuery => {
	if (o.kind === "admitted") {
		return o.query
	}
	return assert.fail(
		o.kind === "refused" ? `refused: ${o.cause.kind} at ${o.location}` : `refused as ${o.reason}`
	)
}

const refusedFor = (
	o: Outcome
): { readonly cause: RecursionRefusal; readonly location: string } => {
	if (o.kind === "refused") {
		return o
	}
	return assert.fail(
		o.kind === "admitted"
			? "admitted, where the rule refuses"
			: `refused as ${o.reason}, not by recursion admission`
	)
}

/** A recursive definition as a JavaScript author states it, unlocated: the checker's entry point locates it. */
const recursive = (
	name: string,
	row: Readonly<Record<string, FieldDesc>>,
	base: Arr.NonEmptyReadonlyArray<RuleDesc>,
	rec: Arr.NonEmptyReadonlyArray<RuleDesc>
): QueryDesc => ({ stage: { kind: "recursive", recursive: { name, row, base, rec } } })

const uuidField: FieldDesc = { kind: "uuid" }
const integer: FieldDesc = { kind: "pg", type: "integer" }
const bigint: FieldDesc = { kind: "pg", type: "bigint" }

/** A state column of the feedback, and the variable a recursive arm reads it into. */
const s = (column: string): ExprDesc => varRef(`self.${column}`)
const selfVars = (...columns: ReadonlyArray<string>): ReadonlyArray<VarDesc> =>
	Arr.map(columns, (c) => plainVar(`self.${c}`))

const readSelf = (...columns: ReadonlyArray<string>): MatchDesc =>
	match({ kind: "self" }, Rec.fromEntries(Arr.map(columns, (c) => [c, s(c)])))

/** The base arm seeding from the root vertex a parameter names. */
const seed = (
	head: Readonly<Record<string, HeadTermDesc>>,
	more: ReadonlyArray<string>
): RuleDesc =>
	rule({
		vars: vars("Vertex", "id", ...argumentsOf(more)),
		matches: [
			match(
				relationSource("Vertex"),
				Rec.fromEntries(Arr.map(["id", ...more], (f) => [f, ref("Vertex", f)]))
			)
		],
		where: [eq(ref("Vertex", "id"), param("start", { kind: "uuid" }))],
		head,
		interiors: [],
		attach: []
	})

/** A recursive arm reading the state columns, then an edge from the state's node. */
const step = (
	columns: ReadonlyArray<string>,
	where: ReadonlyArray<ExprDesc>,
	head: Readonly<Record<string, HeadTermDesc>>,
	more: { readonly vars: ReadonlyArray<VarDesc>; readonly matches: ReadonlyArray<MatchDesc> }
): RuleDesc =>
	rule({
		vars: [...selfVars(...argumentsOf(columns)), ...vars("Edge", "to", "cost"), ...more.vars],
		matches: [
			readSelf(...argumentsOf(columns)),
			match(relationSource("Edge"), {
				from: s("node"),
				to: ref("Edge", "to"),
				cost: ref("Edge", "cost")
			}),
			...more.matches
		],
		where,
		head,
		interiors: [],
		attach: []
	})
const nothingMore = { vars: [], matches: [] }

type Head = "exact" | "missing" | "extra"

const shaped = (
	head: Head,
	node: ExprDesc,
	hops: ExprDesc
): Readonly<Record<string, HeadTermDesc>> =>
	head === "exact" ? { node, hops } : head === "missing" ? { node } : { node, hops, more: node }

describe("arm heads", () => {
	/** Each arm delivers the declared row exactly, misses its counter, or adds a column. */
	type HeadFeature = "admitted" | `${"base" | "rec"} ${Exclude<Head, "exact">}` | "both arms broken"
	it.effect(
		"refuses an arm whose head misses or adds a state column, at that arm's head, naming what it misses and adds",
		(ctx) =>
			Effect.gen(function* () {
				const heads = element<Head>(["exact", "missing", "extra"])
				yield* searched(
					ctx,
					exhaust(
						{
							suite: "unit/recursion/arm-heads",
							generator: (source) => [source.draw(heads), source.draw(heads)] as const,
							literal: Formatter.format,
							limit: 9,
							coverage: requiredInSpace<HeadFeature>([
								"admitted",
								"base missing",
								"base extra",
								"rec missing",
								"rec extra",
								"both arms broken"
							]),
							caseHang
						},
						([baseHead, recHead], c) =>
							Effect.sync(() => {
								const desc = recursive(
									"Walks",
									{ node: uuidField, hops: integer },
									[seed(shaped(baseHead, ref("Vertex", "id"), typedLit(0, integer)), [])],
									[
										step(
											["node", "hops"],
											[lt(s("hops"), typedLit(4, integer))],
											shaped(
												recHead,
												ref("Edge", "to"),
												compute("add", s("hops"), typedLit(1, integer))
											),
											nothingMore
										)
									]
								)
								const outcome = outcomeOf(desc)
								const broken = Arr.filter(
									[
										["base", baseHead],
										["rec", recHead]
									] as const,
									([, head]) => head !== "exact"
								)
								if (broken.length === 0) {
									c.note("admitted")
									admitted(outcome)
									return
								}
								for (const [arm, head] of broken) {
									if (head !== "exact") {
										c.note(`${arm} ${head}`)
									}
								}
								if (broken.length === 2) {
									c.note("both arms broken")
								}
								const { cause, location } = refusedFor(outcome)
								containsEqual(
									Arr.map(broken, ([arm, head]): RecursionRefusal => ({
										kind: "armHead",
										recursion: "Walks",
										arm,
										row: ["hops", "node"],
										missing: head === "missing" ? ["hops"] : [],
										extra: head === "extra" ? ["more"] : []
									})),
									cause
								)
								if (cause.kind === "armHead") {
									containsText(location, `recursive.${cause.arm}[0].head`)
								}
							})
					)
				)
			})
	)
})

describe("the state heading", () => {
	/**
	 * A state column's type: its identity class, and within it its numeric typmod or text refinement, a refinement by
	 * the language its pattern recognizes.
	 */
	interface Typed {
		readonly label: string
		readonly field: FieldDesc
		readonly identity: "int4" | "int8" | "numeric" | "text" | "money"
		/** The typmod or refinement within the class; "none" for a carrier with neither, and the wildcard. */
		readonly within: string
	}
	const wildcard: FieldDesc = textDesc("^.*$", "su")
	const label: FieldDesc = textDesc("^v[0-9]+$", "u")
	/** The label's language spelled otherwise. */
	const respelledLabel: FieldDesc = textDesc("^v[0-9][0-9]*$", "u")
	/** Two text refinements of one language whose patterns are spelled apart: one type each. */
	const respelled = (d: Typed, a: Typed): boolean =>
		d.field.kind === "text" &&
		a.field.kind === "text" &&
		(d.field.source !== a.field.source || d.field.flags !== a.field.flags)
	const declared: Arr.NonEmptyReadonlyArray<Typed> = [
		{ label: "integer", field: integer, identity: "int4", within: "none" },
		{ label: "bigint", field: bigint, identity: "int8", within: "none" },
		{
			label: "numeric(1000,0)",
			field: { kind: "numeric", precision: 1000, scale: 0 },
			identity: "numeric",
			within: "1000,0"
		},
		{
			label: "numeric(10,2)",
			field: { kind: "numeric", precision: 10, scale: 2 },
			identity: "numeric",
			within: "10,2"
		},
		{
			label: "numeric(12,2)",
			field: { kind: "numeric", precision: 12, scale: 2 },
			identity: "numeric",
			within: "12,2"
		},
		{ label: "the label pattern", field: label, identity: "text", within: "^v[0-9]+$" },
		{
			label: "the label pattern respelled",
			field: respelledLabel,
			identity: "text",
			within: "^v[0-9]+$"
		},
		{ label: "wildcard text", field: wildcard, identity: "text", within: "none" },
		{ label: "money", field: { kind: "pg", type: "money" }, identity: "money", within: "none" }
	]
	/** What the base arm delivers for the column: a typed literal or a Vertex column, with its type. */
	interface Delivered extends Typed {
		readonly term: ExprDesc
		readonly reads: ReadonlyArray<string>
	}
	const delivered: Arr.NonEmptyReadonlyArray<Delivered> = [
		{
			label: "an integer literal",
			field: integer,
			identity: "int4",
			within: "none",
			term: typedLit(3, integer),
			reads: []
		},
		{
			label: "a bigint literal",
			field: bigint,
			identity: "int8",
			within: "none",
			term: typedLit(3n, bigint),
			reads: []
		},
		{
			label: "Vertex.weight",
			field: { kind: "numeric", precision: 10, scale: 2 },
			identity: "numeric",
			within: "10,2",
			term: ref("Vertex", "weight"),
			reads: ["weight"]
		},
		{
			label: "Vertex.label",
			field: label,
			identity: "text",
			within: "^v[0-9]+$",
			term: ref("Vertex", "label"),
			reads: ["label"]
		},
		{
			label: "a wildcard literal",
			field: wildcard,
			identity: "text",
			within: "none",
			term: typedLit("v1", wildcard),
			reads: []
		},
		{
			label: "Vertex.price",
			field: { kind: "pg", type: "money" },
			identity: "money",
			within: "none",
			term: ref("Vertex", "price"),
			reads: ["price"]
		}
	]
	/**
	 * The author casts the delivered term to the declared type, where a numeric cast is one and total: a cast from
	 * numeric into an integer needs its value proved finite, a partial operation the column's own rule never reads.
	 */
	type Spelled = "as delivered" | "cast by the author"
	const numericIdentities: ReadonlyArray<Typed["identity"]> = ["int4", "int8", "numeric"]
	const totalCast = (d: Typed, a: Typed): boolean =>
		numericIdentities.includes(d.identity) &&
		numericIdentities.includes(a.identity) &&
		!(a.identity === "numeric" && d.identity !== "numeric")

	/**
	 * The rule (check/recursion/state.ts): every state column hashes, so money is refused at the row; an arm's column
	 * converts when it has the declared identity and the conversion is exact: the same type, or a text refinement the
	 * declared column drops, or the declared refinement's language spelled otherwise, which admission casts. Another
	 * identity, another typmod (every declared numeric has one, and a typmod cast rounds), or a declared refinement the
	 * arm does not carry is refused.
	 */
	type Expected =
		| { readonly kind: "admitted"; readonly conversion: "same" | "cast" }
		| { readonly kind: "unhashable" }
		| {
				readonly kind: "inexact"
				readonly conversion: "anotherType" | "anotherTypmod" | "unprovedRefinement"
		  }
	const expected = (d: Typed, a: Typed): Expected => {
		if (d.identity === "money") {
			return { kind: "unhashable" }
		}
		if (d.identity !== a.identity) {
			return { kind: "inexact", conversion: "anotherType" }
		}
		if (d.within === a.within) {
			return { kind: "admitted", conversion: respelled(d, a) ? "cast" : "same" }
		}
		if (d.within === "none") {
			return { kind: "admitted", conversion: "cast" }
		}
		return {
			kind: "inexact",
			conversion: d.identity === "numeric" ? "anotherTypmod" : "unprovedRefinement"
		}
	}
	type StateFeature =
		| `admitted ${"same" | "cast"}`
		| "refused unhashable"
		| `refused ${"anotherType" | "anotherTypmod" | "unprovedRefinement"}`
		| "cast by the author"

	it.effect(
		"admits a column of the declared type, casts an exact conversion, and refuses an inexact one or an unhashable column",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/recursion/state-heading",
						generator: filter(
							(source) =>
								[
									source.draw(element(declared)),
									source.draw(element(delivered)),
									source.draw(element<Spelled>(["as delivered", "cast by the author"]))
								] as const,
							([d, a, spelled]) => spelled === "as delivered" || totalCast(d, a),
							1
						),
						literal: Formatter.format,
						limit: 200,
						coverage: requiredInSpace<StateFeature>([
							"admitted same",
							"admitted cast",
							"refused unhashable",
							"refused anotherType",
							"refused anotherTypmod",
							"refused unprovedRefinement",
							"cast by the author"
						]),
						caseHang
					},
					([d, a, spelled], c) =>
						Effect.sync(() => {
							const term = spelled === "cast by the author" ? cast(a.term, d.field) : a.term
							const desc = recursive(
								"Labels",
								{ node: uuidField, c: d.field },
								[seed({ node: ref("Vertex", "id"), c: term }, a.reads)],
								[step(["node", "c"], [], { node: ref("Edge", "to"), c: s("c") }, nothingMore)]
							)
							const outcome = outcomeOf(desc)
							/** A cast by the author delivers the declared type itself. */
							const want = spelled === "cast by the author" ? expected(d, d) : expected(d, a)
							if (spelled === "cast by the author") {
								c.note("cast by the author")
							}
							switch (want.kind) {
								case "unhashable": {
									c.note("refused unhashable")
									const { cause, location } = refusedFor(outcome)
									assert.deepEqual(cause, {
										kind: "unhashableState",
										recursion: "Labels",
										column: "c",
										type: "money"
									})
									containsText(location, "recursive.row.c")
									return
								}
								case "inexact": {
									c.note(`refused ${want.conversion}`)
									const { cause } = refusedFor(outcome)
									assert.ok(cause.kind === "inexactConversion", `refused for ${cause.kind}`)
									/**
									 * The delivered and declared type labels are the types' own; the rule's contract is the arm, the
									 * column and the conversion.
									 */
									const { recursion, arm, column, conversion } = cause
									assert.deepEqual(
										{ recursion, arm, column, conversion },
										{
											recursion: "Labels",
											arm: "base",
											column: "c",
											conversion: want.conversion
										}
									)
									return
								}
								case "admitted": {
									c.note(`admitted ${want.conversion}`)
									const q = admitted(outcome)
									const rec = theRecursive(q)
									const base = rec.base
									assert.ok(base.kind === "ProjectSet", "the base arm is projected to the state")
									assert.deepEqual(base.heading, rec.heading)
									const column = Option.getOrThrow(Arr.findFirst(base.out, (o) => o.name === "c"))
									const kind = column.expr.kind
									/**
									 * The author's cast is a cast where it changes the type; a cast to the type the term has already
									 * restates it.
									 */
									const casts =
										spelled === "cast by the author"
											? a.identity !== d.identity || a.within !== d.within
											: want.conversion === "cast"
									assert.equal(
										kind === "cast",
										casts,
										"the column is cast exactly where its type changes"
									)
								}
							}
						})
				)
			)
	)
})

describe("the feedback's shape", () => {
	/**
	 * The base arm: seeded from the root vertex, an aggregate over the edges, the seed beside an approximate stage, or
	 * the seed reading self.
	 */
	type Base = "seed" | "aggregate" | "approximate" | "self"
	/** A further recursive arm beside the main one: none, one reading no self, or the reverse transition. */
	type Extra = "none" | "no self" | "reverse"
	/** The main recursive arm: how often it reads self, and what else it does. */
	interface Main {
		readonly selfReads: 1 | 2
		readonly negatesSelf: boolean
		readonly aggregates: boolean
		readonly nestsSelf: boolean
		readonly approximate: boolean
		readonly negatesBlocked: boolean
		readonly avoids: boolean
	}
	const vertices = queryDesc(
		rule({
			vars: vars("Vertex", "id"),
			matches: [match(relationSource("Vertex"), { id: ref("Vertex", "id") })],
			where: [],
			head: { node: ref("Vertex", "id") },
			interiors: [],
			attach: []
		})
	)
	const nearest = imported(approximateNearest(vertices, "node", 5), {})
	const zero = typedLit(0n, bigint)
	const baseArm = (base: Base): RuleDesc => {
		switch (base) {
			case "seed":
				return seed({ node: ref("Vertex", "id"), n: zero }, [])
			case "aggregate":
				return rule({
					vars: vars("Edge", "from", "to"),
					matches: [
						match(relationSource("Edge"), { from: ref("Edge", "from"), to: ref("Edge", "to") })
					],
					where: [],
					head: { node: ref("Edge", "from"), n: count() },
					interiors: [],
					attach: []
				})
			case "approximate": {
				const arm = seed({ node: ref("Vertex", "id"), n: zero }, [])
				return { ...arm, matches: [...arm.matches, match(nearest, {})] }
			}
			case "self": {
				const arm = seed({ node: ref("Vertex", "id"), n: zero }, [])
				return {
					...arm,
					vars: [...arm.vars, plainVar("fed.node")],
					matches: [...arm.matches, match({ kind: "self" }, { node: varRef("fed.node") })]
				}
			}
		}
	}
	const mainArm = (m: Main): RuleDesc => {
		const nested = imported(
			queryDesc(
				rule({
					vars: [plainVar("inner.node")],
					matches: [match({ kind: "self" }, { node: varRef("inner.node") })],
					where: [],
					head: { node: varRef("inner.node") },
					interiors: [],
					attach: []
				})
			),
			{}
		)
		return step(
			["node", "n"],
			[
				...(m.negatesSelf ? [not({ kind: "self" }, { node: ref("Edge", "to") })] : []),
				...(m.negatesBlocked ? [not(relationSource("Blocked"), { id: ref("Edge", "to") })] : []),
				...(m.avoids ? [ne(ref("Edge", "to"), param("avoid", { kind: "uuid" }))] : [])
			],
			{ node: ref("Edge", "to"), n: m.aggregates ? count() : s("n") },
			{
				vars: m.selfReads === 2 ? [plainVar("again.n")] : [],
				matches: [
					...(m.selfReads === 2
						? [match({ kind: "self" }, { node: ref("Edge", "to"), n: varRef("again.n") })]
						: []),
					...(m.nestsSelf ? [match(nested, { node: ref("Edge", "to") })] : []),
					...(m.approximate ? [match(nearest, {})] : [])
				]
			}
		)
	}
	const extraArms = (extra: Extra): ReadonlyArray<RuleDesc> => {
		switch (extra) {
			case "none":
				return []
			case "no self":
				return [
					rule({
						vars: vars("Blocked", "id"),
						matches: [match(relationSource("Blocked"), { id: ref("Blocked", "id") })],
						where: [],
						head: { node: ref("Blocked", "id"), n: zero },
						interiors: [],
						attach: []
					})
				]
			case "reverse":
				return [
					rule({
						vars: [...selfVars("node", "n"), ...vars("Edge", "from")],
						matches: [
							readSelf("node", "n"),
							match(relationSource("Edge"), { from: ref("Edge", "from"), to: s("node") })
						],
						where: [],
						head: { node: ref("Edge", "from"), n: s("n") },
						interiors: [],
						attach: []
					})
				]
		}
	}

	/**
	 * The rules (check/recursion/scan.ts): a recursive arm reads self once; never negates or aggregates over it; self
	 * is a source only of a recursive arm's own matches, refused anywhere else before the checker runs; no
	 * approximate stage lies below an arm. What one of them refuses, with its cause.
	 */
	type Verdict =
		| { readonly kind: "cause"; readonly cause: RecursionRefusal; readonly feature: ShapeFeature }
		| { readonly kind: "misplaced self" }
	const verdicts = (base: Base, m: Main): ReadonlyArray<Verdict> => {
		const out: Array<Verdict> = []
		const cause = (
			c: Extract<
				RecursionRefusal,
				{
					readonly kind:
						| "approximateSource"
						| "nonlinearFeedback"
						| "selfNegation"
						| "recursiveAggregation"
				}
			>
		) => out.push({ kind: "cause", cause: c, feature: `refused ${c.kind}` })
		const approximate: RecursionRefusal = {
			kind: "approximateSource",
			recursion: "Reach"
		}
		if (base === "approximate" || m.approximate) {
			cause(approximate)
		}
		if (base === "self" || m.nestsSelf) {
			out.push({ kind: "misplaced self" })
		}
		if (m.selfReads === 2) {
			cause({ kind: "nonlinearFeedback", recursion: "Reach", selfReads: 2 })
		}
		if (m.negatesSelf) {
			cause({ kind: "selfNegation", recursion: "Reach" })
		}
		if (m.aggregates) {
			cause({ kind: "recursiveAggregation", recursion: "Reach", fold: "count" })
		}
		return out
	}
	/**
	 * What an outcome is in the rules' terms: a self misplaced, refused before the checker runs or by admission's own
	 * reason, or a refusal's cause.
	 */
	type Observed =
		| { readonly kind: "cause"; readonly cause: RecursionRefusal }
		| { readonly kind: "misplaced self" }
	const observed = (o: Outcome): Observed | "admitted" | "another refusal" => {
		if (o.kind === "admitted") {
			return "admitted"
		}
		if (o.kind === "malformed") {
			return o.reason === "MalformedDescription" ? { kind: "misplaced self" } : "another refusal"
		}
		return o.cause.kind === "baseSelf" || o.cause.kind === "nestedSelf"
			? { kind: "misplaced self" }
			: { kind: "cause", cause: o.cause }
	}

	type ShapeFeature =
		| "admitted"
		| "admitted with an aggregate base"
		| "admitted with an arm reading no self"
		| "admitted with two transition arms"
		| "admitted negating a fixed relation"
		| "admitted with an importer's parameter"
		| `refused ${"approximateSource" | "nonlinearFeedback" | "selfNegation" | "recursiveAggregation"}`
		| "refused misplaced self"
		| "several rules refuse"

	it.effect(
		"refuses feedback read twice, negated, aggregated, misplaced or below an approximate stage, and factors every admitted arm into one feedback read",
		(ctx) =>
			Effect.gen(function* () {
				const mains: Gen<Main> = (source) => ({
					selfReads: source.draw(element<1 | 2>([1, 2])),
					negatesSelf: source.draw(boolean),
					aggregates: source.draw(boolean),
					nestsSelf: source.draw(boolean),
					approximate: source.draw(boolean),
					negatesBlocked: source.draw(boolean),
					avoids: source.draw(boolean)
				})
				yield* searched(
					ctx,
					exhaust(
						{
							suite: "unit/recursion/feedback-shape",
							generator: (source) =>
								[
									source.draw(element<Base>(["seed", "aggregate", "approximate", "self"])),
									source.draw(element<Extra>(["none", "no self", "reverse"])),
									source.draw(mains)
								] as const,
							literal: Formatter.format,
							limit: 2000,
							coverage: requiredInSpace<ShapeFeature>([
								"admitted",
								"admitted with an aggregate base",
								"admitted with an arm reading no self",
								"admitted with two transition arms",
								"admitted negating a fixed relation",
								"admitted with an importer's parameter",
								"refused approximateSource",
								"refused nonlinearFeedback",
								"refused selfNegation",
								"refused recursiveAggregation",
								"refused misplaced self",
								"several rules refuse"
							]),
							caseHang
						},
						([base, extra, m], c) =>
							Effect.sync(() => {
								const desc = recursive(
									"Reach",
									{ node: uuidField, n: bigint },
									[baseArm(base)],
									[mainArm(m), ...extraArms(extra)]
								)
								const outcome = outcomeOf(desc)
								const want = verdicts(base, m)
								if (want.length > 0) {
									const seen = observed(outcome)
									assert.ok(
										seen !== "admitted" && seen !== "another refusal",
										`${Formatter.format(seen)}, where the rules refuse`
									)
									containsEqual<Observed>(
										Arr.map(want, (verdict): Observed =>
											verdict.kind === "misplaced self"
												? verdict
												: { kind: "cause", cause: verdict.cause }
										),
										seen
									)
									for (const verdict of want) {
										c.note(
											verdict.kind === "misplaced self" ? "refused misplaced self" : verdict.feature
										)
									}
									if (want.length > 1) {
										c.note("several rules refuse")
									}
									return
								}
								const q = admitted(outcome)
								c.note("admitted")
								const rec = theRecursive(q)
								assert.equal(reads(q, rec.self), 1, "one feedback read")
								assert.equal(
									rec.base.kind === "Union",
									extra === "no self",
									"the base is a union exactly when an arm reads no self"
								)
								assert.equal(
									Arr.some(nodes(q), (n) => n.kind === "AntiJoin"),
									m.negatesBlocked,
									"a fixed relation is negated exactly where the step negates it"
								)
								assert.deepEqual(
									Arr.sort(
										Arr.map(q.params, (p) => p.name),
										Order.String
									),
									Arr.sort(
										[...(base === "seed" ? ["start"] : []), ...(m.avoids ? ["avoid"] : [])],
										Order.String
									)
								)
								lower(q)
								if (base === "aggregate") {
									c.note("admitted with an aggregate base")
								}
								if (extra === "no self") {
									c.note("admitted with an arm reading no self")
								}
								if (extra === "reverse") {
									c.note("admitted with two transition arms")
								}
								if (m.negatesBlocked) {
									c.note("admitted negating a fixed relation")
								}
								if (m.avoids) {
									c.note("admitted with an importer's parameter")
								}
							})
					)
				)
			})
	)
})

describe("r.pack over a recursive arm", () => {
	/** r.pack needs a span state, which Graph has none of: the rule is planted over a schema of spanned links. */
	const Link = table("Link", { from: uuid, to: uuid, during: span(pg.bigint) }, [
		"from",
		"to",
		"during"
	])
	const Spans = schema("Spans", { Link }, [])
	const row = { node: uuid, during: span(pg.bigint) }
	/**
	 * The step's head term is chosen at run time, a producer or a term, which the typed recursive cannot state as the
	 * row's span: the definition is given to the builder runtime's recursive.
	 */
	const covered = (pack: boolean) =>
		untypedQuery(Spans).recursive("Covered", {
			row,
			base: [
				(r: Rule<typeof Spans>) => {
					const { from, during } = v(Link, "link")
					return r
						.match(Link, { from, during })
						.where(r.eq(from, r.param("start", uuid)))
						.find({ node: from, during })
				}
			],
			rec: [
				(r: Rule<typeof Spans>, self: SelfSource<typeof row>) => {
					const { node } = v(self, "self")
					const { to, during } = v(Link, "link")
					return r
						.match(self, { node })
						.match(Link, { from: node, to, during })
						.find({ node: to, during: pack ? r.pack(during) : during })
				}
			]
		})
	it.effect(
		"refuses r.pack over self as an aggregate, at its head term, and admits the arm without it",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/recursion/pack",
						generator: boolean,
						literal: Formatter.format,
						limit: 2,
						coverage: requiredInSpace<"packed" | "plain">(["packed", "plain"]),
						caseHang
					},
					(pack, c) =>
						Effect.sync(() => {
							c.note(pack ? "packed" : "plain")
							const r = checkQuery(checking(Spans), descOf(covered(pack)), checkOptions("query"))
							if (!pack) {
								succeeded(r)
								return
							}
							assert.ok(
								!r.ok && r.error.reason._tag === "RecursionRefused",
								"refused by recursion admission"
							)
							assert.deepEqual(r.error.reason.cause, {
								kind: "recursiveAggregation",
								recursion: "Covered",
								fold: "pack"
							})
							containsText(formatLoc(r.error.reason.at), "head.during")
						})
				)
			)
	)
})

/** The refusal of a hop counter computed from its own current value with no admitted bound. */
const unboundedHops: RecursionRefusal = {
	kind: "unboundedState",
	recursion: "Walks",
	column: "hops",
	reads: ["hops"]
}

describe("unbounded computed state", () => {
	/**
	 * A walk's hop counter: its carrier, how its step bounds it, and how it advances. The numeric carrier is
	 * numeric(1000,0), whose every value is an integer, and still no integer carrier a counter counts in.
	 */
	type Carrier = "integer" | "numeric"
	type Bound = "current below" | "current above" | "either of two" | "next below"
	type Advance = "plus one" | "times two"
	type UnboundedFeature = "a bounded counter" | `refused ${Carrier} ${Bound} ${Advance}`

	it.effect(
		"admits only a counter over an integer carrier bounded on the side it moves towards, and refuses every other computed feedback",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/recursion/unbounded-counter",
						generator: (source) =>
							[
								source.draw(element<Carrier>(["integer", "numeric"])),
								source.draw(
									element<Bound>(["current below", "current above", "either of two", "next below"])
								),
								source.draw(element<Advance>(["plus one", "times two"]))
							] as const,
						literal: Formatter.format,
						limit: 16,
						coverage: requiredInSpace<UnboundedFeature>([
							"a bounded counter",
							"refused integer current above plus one",
							"refused integer either of two plus one",
							"refused integer next below plus one",
							"refused integer current below times two",
							"refused numeric current below plus one"
						]),
						caseHang
					},
					([carrier, bound, advance], c) =>
						Effect.sync(() => {
							const type: FieldDesc =
								carrier === "integer" ? integer : { kind: "numeric", precision: 1000, scale: 0 }
							const k = (n: number) =>
								carrier === "integer"
									? typedLit(n, type)
									: typedLit(defined(DecimalText.parse(String(n))), type)
							const hops = s("hops")
							const guard: ExprDesc =
								bound === "current below"
									? lt(hops, k(4))
									: bound === "current above"
										? gt(hops, k(4))
										: bound === "either of two"
											? or(lt(hops, k(4)), lt(hops, k(5)))
											: lt(compute("add", hops, k(1)), k(4))
							const desc = recursive(
								"Walks",
								{ node: uuidField, hops: type },
								[seed({ node: ref("Vertex", "id"), hops: k(0) }, [])],
								[
									step(
										["node", "hops"],
										[guard],
										{
											node: ref("Edge", "to"),
											hops: compute(
												advance === "plus one" ? "add" : "mul",
												hops,
												k(advance === "plus one" ? 1 : 2)
											)
										},
										nothingMore
									)
								]
							)
							const outcome = outcomeOf(desc)
							if (carrier === "integer" && bound === "current below" && advance === "plus one") {
								c.note("a bounded counter")
								assert.equal(theRecursive(admitted(outcome)).termination.kind, "boundedState")
								return
							}
							c.note(`refused ${carrier} ${bound} ${advance}`)
							assert.deepEqual(refusedFor(outcome).cause, unboundedHops)
						})
				)
			)
	)

	/** Two integer columns, each bounded by its arm's filter, and what each becomes in the step. */
	type Term = "the other plus one" | "itself plus one" | "copied" | "a literal"
	it.effect(
		"refuses a cycle of computed columns, each computed from the other, and admits every acyclic pairing",
		(ctx) =>
			Effect.gen(function* () {
				const terms = element<Term>([
					"the other plus one",
					"itself plus one",
					"copied",
					"a literal"
				])
				yield* searched(
					ctx,
					exhaust(
						{
							suite: "unit/recursion/computed-cycle",
							generator: (source) => [source.draw(terms), source.draw(terms)] as const,
							literal: Formatter.format,
							limit: 16,
							coverage: requiredInSpace<"a cycle" | "acyclic">(["a cycle", "acyclic"]),
							caseHang
						},
						([aTerm, bTerm], c) =>
							Effect.sync(() => {
								const term = (column: "a" | "b", t: Term): ExprDesc => {
									const other = column === "a" ? "b" : "a"
									switch (t) {
										case "the other plus one":
											return narrowed(compute("add", s(other), typedLit(1, integer)), "integer")
										case "itself plus one":
											return compute("add", s(column), typedLit(1, integer))
										case "copied":
											return s(column)
										case "a literal":
											return typedLit(1, integer)
									}
								}
								const desc = recursive(
									"Swap",
									{ a: integer, b: integer },
									[
										rule({
											vars: vars("Edge", "cost"),
											matches: [match(relationSource("Edge"), { cost: ref("Edge", "cost") })],
											where: [],
											head: { a: typedLit(0, integer), b: typedLit(0, integer) },
											interiors: [],
											attach: []
										})
									],
									[
										rule({
											vars: selfVars("a", "b"),
											matches: [readSelf("a", "b")],
											where: [lt(s("a"), typedLit(10, integer)), lt(s("b"), typedLit(10, integer))],
											head: { a: term("a", aTerm), b: term("b", bTerm) },
											interiors: [],
											attach: []
										})
									]
								)
								const outcome = outcomeOf(desc)
								if (aTerm === "the other plus one" && bTerm === "the other plus one") {
									c.note("a cycle")
									containsEqual<RecursionRefusal>(
										[
											{
												kind: "unboundedState",
												recursion: "Swap",
												column: "a",
												reads: ["b"]
											},
											{
												kind: "unboundedState",
												recursion: "Swap",
												column: "b",
												reads: ["a"]
											}
										],
										refusedFor(outcome).cause
									)
									return
								}
								c.note("acyclic")
								admitted(outcome)
							})
					)
				)
			})
	)
})

/**
 * Inc.bind({ x, at }) delivers the vertex `at` with y = 1 + x; Echo.bind({ x }) every vertex with y = 0 + x; each
 * narrows its exact sum into an integer under the guard that it fits.
 */
const vertexRule = (where: ReadonlyArray<ExprDesc>, y: ExprDesc): QueryDesc =>
	queryDesc(
		rule({
			vars: vars("Vertex", "id"),
			matches: [match(relationSource("Vertex"), { id: ref("Vertex", "id") })],
			where,
			head: { id: ref("Vertex", "id"), y },
			interiors: [],
			attach: []
		})
	)

describe("unbounded computed state through a correlated import", () => {
	const Inc = vertexRule(
		[eq(ref("Vertex", "id"), param("at", { kind: "uuid" }))],
		narrowed(compute("add", typedLit(1, integer), param("x", integer)), "integer")
	)
	const Echo = vertexRule(
		[],
		narrowed(compute("add", typedLit(0, integer), param("x", integer)), "integer")
	)
	/** What the step binds an import's x to, and Inc's at. */
	type X = "the hop count" | "the edge's cost" | "a parameter"
	type At = "the state's node" | "the edge's end"
	/**
	 * How the step computes the next hop count: Inc's output, Inc's output fed by Echo's, or a counter beside an Echo
	 * bound to it.
	 */
	type Via = "Inc" | "Echo then Inc" | "a counter beside Echo"
	type ImportFeature = `${"admitted" | "refused"} ${Via}` | "unproved a counter beside Echo"

	it.effect(
		"refuses a counter laundered through an import whose bind map reads the state, through a chain, and admits one bound to data",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/recursion/import-laundering",
						generator: (source) =>
							[
								source.draw(
									(source) =>
										[
											source.draw(element<Via>(["Inc", "Echo then Inc", "a counter beside Echo"])),
											source.draw(element<X>(["the hop count", "the edge's cost", "a parameter"]))
										] as const
								),
								source.draw(
									(source) =>
										[
											source.draw(element<At>(["the state's node", "the edge's end"])),
											source.draw(boolean)
										] as const
								)
							] as const,
						literal: Formatter.format,
						limit: 50,
						coverage: requiredInSpace<ImportFeature>([
							"admitted Inc",
							"refused Inc",
							"admitted Echo then Inc",
							"refused Echo then Inc",
							"admitted a counter beside Echo",
							"refused a counter beside Echo",
							"unproved a counter beside Echo"
						]),
						caseHang
					},
					([[via, x], [at, guarded]], c) =>
						Effect.sync(() => {
							const xTerm =
								x === "the hop count"
									? s("hops")
									: x === "the edge's cost"
										? ref("Edge", "cost")
										: param("x0", integer)
							const atTerm = at === "the state's node" ? s("node") : ref("Edge", "to")
							const guard = guarded ? [lt(s("hops"), typedLit(4, integer))] : []
							/** The step reads the state and any edge: no data match binds the state's node, so it stays state. */
							const more =
								via === "Inc"
									? {
											vars: [plainVar("inc.y")],
											matches: [
												match(imported(Inc, { x: xTerm, at: atTerm }), {
													id: atTerm,
													y: varRef("inc.y")
												})
											]
										}
									: via === "Echo then Inc"
										? {
												vars: [plainVar("echo.id"), plainVar("echo.y"), plainVar("inc.y")],
												matches: [
													match(imported(Echo, { x: xTerm }), {
														id: varRef("echo.id"),
														y: varRef("echo.y")
													}),
													match(imported(Inc, { x: varRef("echo.y"), at: atTerm }), {
														id: atTerm,
														y: varRef("inc.y")
													})
												]
											}
										: {
												vars: [plainVar("echo.id")],
												matches: [
													match(imported(Echo, { x: xTerm }), {
														id: varRef("echo.id"),
														y: s("hops")
													})
												]
											}
							const next =
								via === "a counter beside Echo"
									? compute("add", s("hops"), typedLit(1, integer))
									: varRef("inc.y")
							const desc = recursive(
								"Walks",
								{ node: uuidField, hops: integer },
								[seed({ node: ref("Vertex", "id"), hops: typedLit(0, integer) }, [])],
								[
									rule({
										vars: [
											...selfVars("node", "hops"),
											...vars("Edge", "to", "cost"),
											...more.vars
										],
										matches: [
											readSelf("node", "hops"),
											match(relationSource("Edge"), {
												to: ref("Edge", "to"),
												cost: ref("Edge", "cost")
											}),
											...more.matches
										],
										where: guard,
										head: { node: ref("Edge", "to"), hops: next },
										interiors: [],
										attach: []
									})
								]
							)
							const outcome = outcomeOf(desc)
							/**
							 * Beside an Echo bound to data, the Echo's output binds the hop count, which is then data, so its successor
							 * is an exact integer no counter's bound proves fits the column: a narrowing left unproved.
							 */
							const dataHops = via === "a counter beside Echo" && x !== "the hop count"
							if (dataHops) {
								c.note("unproved a counter beside Echo")
								assert.deepEqual(outcome, { kind: "malformed", reason: "PartialOperation" })
								return
							}
							/**
							 * The state columns the next hop count is computed from: through an import, those its bind maps read. A
							 * counter is computed from itself, admitted under its bound.
							 */
							const reads =
								via === "a counter beside Echo"
									? guarded
										? []
										: ["hops"]
									: [
											...(x === "the hop count" ? ["hops"] : []),
											...(at === "the state's node" ? ["node"] : [])
										]
							if (!reads.includes("hops")) {
								c.note(`admitted ${via}`)
								admitted(outcome)
								return
							}
							c.note(`refused ${via}`)
							assert.deepEqual(refusedFor(outcome).cause, {
								...unboundedHops,
								reads: Arr.sort([...reads], Order.String)
							})
						})
				)
			)
	)
})

describe("the seen-state estimate", () => {
	/**
	 * A countdown over a bigint by n - 1 while n > 0, seeded by data (a count over the vertices) or by a literal. A seed
	 * of a literal s from 0 to bigint's greatest counts the s + 1 states from s down to 0, recorded and never refused
	 * however many no store holds, the step's least value, -1, within bigint. A seed admission cannot read is any bigint,
	 * and a literal at bigint's least value is that value: either puts bigint's least value among the states, where the
	 * step may compute n - 1 before its filter drops the row (check/recursion/state.ts counterNarrowing), so the
	 * narrowing of the step into n is PartialOperation, naming n and the fits precondition.
	 */
	type Seed = "data" | bigint
	const seeds: Arr.NonEmptyReadonlyArray<Seed> = [
		"data",
		0n,
		2n,
		2n ** 40n,
		2n ** 62n,
		int8Max.value,
		int8Min.value
	]
	it.effect(
		"counts a countdown from its seed to its bound and admits every estimate, and refuses the step over a seed that may be bigint's least value",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/recursion/countdown",
						generator: element<Seed>(seeds),
						literal: Formatter.format,
						limit: seeds.length,
						coverage: requiredInSpace<"admitted literal" | "refused data" | "refused literal">([
							"admitted literal",
							"refused data",
							"refused literal"
						]),
						caseHang
					},
					(seeded, c) =>
						Effect.sync(() => {
							const desc = recursive(
								"Countdown",
								{ n: bigint },
								[
									rule({
										vars: vars("Vertex", "id"),
										matches: [match(relationSource("Vertex"), { id: ref("Vertex", "id") })],
										where: [],
										head: { n: seeded === "data" ? count() : typedLit(seeded, bigint) },
										interiors: [],
										attach: []
									})
								],
								[
									rule({
										vars: selfVars("n"),
										matches: [readSelf("n")],
										where: [gt(s("n"), typedLit(0n, bigint))],
										head: { n: compute("sub", s("n"), typedLit(1n, bigint)) },
										interiors: [],
										attach: []
									})
								]
							)
							if (seeded !== "data" && seeded >= 0n) {
								c.note("admitted literal")
								const cert = theRecursive(admitted(outcomeOf(desc))).termination
								assert.equal(cert.kind, "wellFounded")
								assert.equal(cert.stateEstimate, seeded + 1n)
								return
							}
							c.note(seeded === "data" ? "refused data" : "refused literal")
							const r = checkQuery(checking(Graph), desc, checkOptions("query"))
							assert.ok(!r.ok, "the step over bigint's least value is refused")
							const reason = r.error.reason
							assert.ok(reason._tag === "PartialOperation", `refused as ${reason._tag}`)
							assert.deepEqual(
								{ precondition: reason.precondition, operand: reason.operand },
								{ precondition: "fits", operand: "n" }
							)
						})
				)
			)
	)
})
