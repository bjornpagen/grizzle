/** What the properties of refusals.test.ts read: its spaces, models and helpers. */

import { assert, defined } from "@bjornpagen/testing/assert"
import { boolean, constant, element, type Gen, int, map, oneOf } from "@bjornpagen/testing/gen"
import { bigint as bigintIn } from "@bjornpagen/testing/values"
import { Array as Arr, Formatter, Record as Rec, String as Str } from "effect"
import type { RecursionRefusal } from "#compiler/core/causes.ts"
import type { CompileReasonTag } from "#compiler/core/errors.ts"
import { childLoc } from "#compiler/core/loc.ts"
import { int8Max, int8Min } from "#compiler/ir/carriers.ts"
import { decodeDesc, type FieldDesc } from "#compiler/ir/desc.ts"
import type { LogicalQuery } from "#compiler/ir/products.ts"
import { samePatterns } from "#compiler/ir/scalar.ts"
import { pg, span } from "#compiler/public/fields.ts"
import { type Rule, type SelfSource, v } from "#compiler/public/query.ts"
import { schema, relation as table } from "#compiler/public/schema.ts"
import { queryOver as untypedQuery } from "#compiler/query/build/query.ts"
import { type Place, placeOf, succeeded } from "#test/support/assert.ts"
import {
	type AuthoredExprDesc as ExprDesc,
	f,
	type HeadTermDesc,
	type MatchDesc,
	type QueryDesc,
	type RuleDesc,
	textDesc,
	type VarDesc
} from "#test/support/fixtures/ir/desc.ts"
import { Id, idDesc } from "#test/support/ids.ts"
import { argumentsOf } from "#test/support/list.ts"
import { checkAuthored, checking, checkOptions } from "#test/support/policy.ts"
import {
	approximateNearest,
	compute,
	count,
	eq,
	imported,
	match,
	narrowed,
	ne,
	not,
	param,
	plainVar,
	queryDesc,
	ref,
	relationSource,
	rule,
	typedLit,
	varRef,
	vars
} from "#test/support/unit/check/dsl.ts"
import { Graph } from "#test/unit/recursion/fixtures.ts"

/**
 * The outcome of checking a definition over Graph: admitted, refused by recursion admission with its
 * cause and where, or refused by another rule with its reason.
 */
type Outcome =
	| { readonly kind: "admitted"; readonly query: LogicalQuery }
	| { readonly kind: "refused"; readonly cause: RecursionRefusal; readonly place: Place }
	| { readonly kind: "malformed"; readonly reason: CompileReasonTag }

export const outcomeOf = (desc: QueryDesc): Outcome => {
	const r = checkAuthored(checking(Graph), desc, checkOptions("query"))
	if (r.ok) {
		return { kind: "admitted", query: r.value }
	}
	if (r.error.reason._tag === "RecursionRefused") {
		return { kind: "refused", cause: r.error.reason.cause, place: placeOf(r.error.reason.at) }
	}
	return { kind: "malformed", reason: r.error.reason._tag }
}

export const admitted = (o: Outcome): LogicalQuery => {
	if (o.kind === "admitted") {
		return o.query
	}
	return assert.fail(
		o.kind === "refused"
			? `refused: ${o.cause.kind} at ${Formatter.format(o.place)}`
			: `refused as ${o.reason}`
	)
}

export const refusedFor = (
	o: Outcome
): { readonly cause: RecursionRefusal; readonly place: Place } => {
	if (o.kind === "refused") {
		return o
	}
	return assert.fail(
		o.kind === "admitted"
			? "admitted, where the rule refuses"
			: `refused as ${o.reason}, not by recursion admission`
	)
}

/** The recursive stage of `desc`, decoded and located as checkAuthored decodes it before the checker reads it. */
const decodedStage = (desc: QueryDesc) => {
	const stage = succeeded(decodeDesc("query", desc)).stage
	return stage.kind === "recursive" ? stage : assert.fail("a recursive stage")
}

/** The place below the first arm of `arm`'s at `segments`, where admission reports a refusal of that arm. */
export const armPlace = (
	desc: QueryDesc,
	arm: "base" | "rec",
	...segments: ReadonlyArray<string | number>
): Place =>
	placeOf(
		Arr.reduce(
			segments,
			defined(decodedStage(desc).recursive[arm][0], `the first ${arm} arm`).loc,
			(loc, segment) => childLoc(loc, segment)
		)
	)

/** The place of a declared state column, where admission reports a refusal of the column. */
export const rowPlace = (desc: QueryDesc, column: string): Place =>
	placeOf(childLoc(decodedStage(desc).loc, "recursive", "row", column))

/** A recursive definition as a JavaScript author states it, unlocated: the checker's entry point locates it. */
export const recursive = (
	name: string,
	row: Readonly<Record<string, FieldDesc>>,
	base: Arr.NonEmptyReadonlyArray<RuleDesc>,
	rec: Arr.NonEmptyReadonlyArray<RuleDesc>
): QueryDesc => ({ stage: { kind: "recursive", recursive: { name, row, base, rec } } })

export const integer: FieldDesc = { kind: "pg", type: "integer" }

export const bigint: FieldDesc = { kind: "pg", type: "bigint" }

/** natural, a count's type: the hop count a feedback's state holds, seeded at 0 or by a count. */
export const naturalField: FieldDesc = f.natural

/** A state column of the feedback, and the variable a recursive arm reads it into. */
export const s = (column: string): ExprDesc => varRef(`self.${column}`)

export const selfVars = (...columns: ReadonlyArray<string>): ReadonlyArray<VarDesc> =>
	Arr.map(columns, (c) => plainVar(`self.${c}`))

export const readSelf = (...columns: ReadonlyArray<string>): MatchDesc =>
	match({ kind: "self" }, Rec.fromEntries(Arr.map(columns, (c) => [c, s(c)])))

/** The base arm seeding from the root vertex a parameter names. */
export const seed = (
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
		where: [eq(ref("Vertex", "id"), param("start", idDesc))],
		head,
		interiors: [],
		attach: []
	})

/** A recursive arm reading the state columns, then an edge from the state's node. */
export const step = (
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

export const nothingMore = Object.freeze({ vars: [], matches: [] })

type Head = "exact" | "missing" | "extra"

export const shaped = (
	head: Head,
	node: ExprDesc,
	hops: ExprDesc
): Readonly<Record<string, HeadTermDesc>> =>
	head === "exact" ? { node, hops } : head === "missing" ? { node } : { node, hops, more: node }

/** Each arm delivers the declared row exactly, misses its counter, or adds a column. */
export type HeadFeature =
	| "admitted"
	| `${"base" | "rec"} ${Exclude<Head, "exact">}`
	| "both arms broken"

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
	!samePatterns(d.field.patterns, a.field.patterns)

export const declared: Arr.NonEmptyReadonlyArray<Typed> = [
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

export const delivered: Arr.NonEmptyReadonlyArray<Delivered> = [
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
 * numeric into an integer needs its value proved finite, and one from a numeric that holds NaN into numeric(p, 0),
 * whose values are integers, its value proved no NaN, partial operations the column's own rule never reads.
 */
export type Spelled = "as delivered" | "cast by the author"

const numericIdentities: ReadonlyArray<Typed["identity"]> = ["int4", "int8", "numeric"]

/** Whether a column is numeric(p, 0)'s, whose values are integers and never NaN. */
const integerNumeric = (t: Typed): boolean =>
	t.identity === "numeric" && Str.endsWith(",0")(t.within)

export const totalCast = (d: Typed, a: Typed): boolean =>
	numericIdentities.includes(d.identity) &&
	numericIdentities.includes(a.identity) &&
	!(a.identity === "numeric" && d.identity !== "numeric") &&
	!(a.identity === "numeric" && !integerNumeric(a) && integerNumeric(d))

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

export const expected = (d: Typed, a: Typed): Expected => {
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

export type StateFeature =
	| `admitted ${"same" | "cast"}`
	| "refused unhashable"
	| `refused ${"anotherType" | "anotherTypmod" | "unprovedRefinement"}`
	| "cast by the author"

/**
 * The base arm: seeded from the root vertex, an aggregate over the edges, the seed beside an approximate stage, or
 * the seed reading self.
 */
export type Base = "seed" | "aggregate" | "approximate" | "self"

/** A further recursive arm beside the main one: none, one reading no self, or the reverse transition. */
export type Extra = "none" | "no self" | "reverse"

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

const zero = typedLit(0n, naturalField)

export const baseArm = (base: Base): RuleDesc => {
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

export const mainArm = (m: Main): RuleDesc => {
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
			...(m.avoids ? [ne(ref("Edge", "to"), param("avoid", idDesc))] : [])
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

export const extraArms = (extra: Extra): ReadonlyArray<RuleDesc> => {
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

export const verdicts = (base: Base, m: Main): ReadonlyArray<Verdict> => {
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
export type Observed =
	| { readonly kind: "cause"; readonly cause: RecursionRefusal }
	| { readonly kind: "misplaced self" }

export const observed = (o: Outcome): Observed | "admitted" | "another refusal" => {
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

export type ShapeFeature =
	| "admitted"
	| "admitted with an aggregate base"
	| "admitted with an arm reading no self"
	| "admitted with two transition arms"
	| "admitted negating a fixed relation"
	| "admitted with an importer's parameter"
	| `refused ${"approximateSource" | "nonlinearFeedback" | "selfNegation" | "recursiveAggregation"}`
	| "refused misplaced self"
	| "several rules refuse"

/** r.pack needs a span state, which Graph has none of: the rule is planted over a schema of spanned links. */
const Link = table("Link", { from: Id, to: Id, during: span(pg.bigint) }, ["from", "to", "during"])

export const Spans = schema("Spans", [Link], [])

/** The recursion's row: a node and the span it is reached during. */
const row = Object.freeze({ node: Id, during: span(pg.bigint) })

/**
 * The step's head term is chosen at run time, a producer or a term, which the typed recursive cannot state as the
 * row's span: the definition is given to the builder runtime's recursive.
 */
export const covered = (pack: boolean) =>
	untypedQuery(Spans).recursive("Covered", {
		row,
		base: [
			(r: Rule<typeof Spans>) => {
				const { from, during } = v(Link, "link")
				return r
					.match(Link, { from, during })
					.where(r.eq(from, r.param("start", Id)))
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

/** The refusal of a hop counter computed from its own current value with no admitted bound. */
export const unboundedHops: Extract<RecursionRefusal, { readonly kind: "unboundedState" }> = {
	kind: "unboundedState",
	recursion: "Walks",
	column: "hops",
	reads: ["hops"]
}

/**
 * A walk's hop counter: its carrier, how its step bounds it, and how it advances. The numeric carrier is
 * numeric(1000,0), whose every value is an integer, and still no integer carrier a counter counts in.
 */
export type CounterCarrier = "integer" | "numeric"

export type Bound = "current below" | "current above" | "either of two" | "next below"

export type Advance = "plus one" | "times two"

export type UnboundedFeature = "a bounded counter" | `refused ${CounterCarrier} ${Bound} ${Advance}`

/** Two integer columns, each bounded by its arm's filter, and what each becomes in the step. */
export type Term = "the other plus one" | "itself plus one" | "copied" | "a literal"

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

export const Inc = vertexRule(
	[eq(ref("Vertex", "id"), param("at", idDesc))],
	narrowed(compute("add", typedLit(1, integer), param("x", integer)), "integer")
)

export const Echo = vertexRule(
	[],
	narrowed(compute("add", typedLit(0, integer), param("x", integer)), "integer")
)

/** What the step binds an import's x to, and Inc's at. */
export type X = "the hop count" | "the edge's cost" | "a parameter"

export type At = "the state's node" | "the edge's end"

/**
 * How the step computes the next hop count: Inc's output, Inc's output fed by Echo's, or a counter beside an Echo
 * bound to it.
 */
export type Via = "Inc" | "Echo then Inc" | "a counter beside Echo"

export type ImportFeature = `${"admitted" | "refused"} ${Via}` | "unproved a counter beside Echo"

/**
 * A countdown over a bigint by n - 1 while n > 0, seeded by a parameter, a bigint the call states, or by a literal s,
 * drawn near each of bigint's least value, zero and its greatest value, or anywhere between. Its states are s down to
 * 0, s + 1 of them, for s at or above 0, and s alone below it; the step may compute n - 1 on any state before its filter
 * drops the row (check/recursion/state.ts counterNarrowing), so the narrowing of the step into n is proved exactly when
 * the least state less one is a bigint. A literal above bigint's least value is admitted, recording its states however
 * many no store holds; a seed admission cannot read is any bigint, and the literal at bigint's least value is that
 * value, so either is PartialOperation, naming n and the fits precondition. A count is no such seed: it is a natural,
 * never below zero.
 */
type Seed = Readonly<{ kind: "param" }> | Readonly<{ kind: "literal"; value: bigint }>

export type CountdownFeature =
	| "admitted from zero or above"
	| "admitted from below zero"
	| "admitted from bigint's greatest value"
	| "refused a parameter"
	| "refused from bigint's least value"

const literal = (value: bigint): Seed => ({ kind: "literal", value })

export const seedGen: Gen<Seed> = oneOf<Seed>([
	constant<Seed>({ kind: "param" }),
	map(int(0, 3), (d) => literal(int8Min + BigInt(d))),
	map(int(-3, 3), (d) => literal(BigInt(d))),
	map(int(0, 3), (d) => literal(int8Max - BigInt(d))),
	map(bigintIn(int8Min, int8Max), literal)
])

export const heads = element<Head>(["exact", "missing", "extra"])

export const mains: Gen<Main> = (source) => ({
	selfReads: source.draw(element<1 | 2>([1, 2])),
	negatesSelf: source.draw(boolean),
	aggregates: source.draw(boolean),
	nestsSelf: source.draw(boolean),
	approximate: source.draw(boolean),
	negatesBlocked: source.draw(boolean),
	avoids: source.draw(boolean)
})

export const terms = element<Term>(["the other plus one", "itself plus one", "copied", "a literal"])

/**
 * Where a definition reads a source beside self: in its base arm, in its recursive arm, which reads self, or in a
 * recursive arm that reads no self, which joins the base.
 */
export type ReadPlace = "base" | "step" | "arm reading no self"

/**
 * What it reads, each source a heading of one id: a stored relation; a query of one rule over one; a union of two
 * rules; a recursion; a query of one rule over a recursion; and a union whose first rule reads a recursion.
 */
export type ReadSource =
	| "a stored relation"
	| "one rule"
	| "a union"
	| "a recursion"
	| "one rule over a recursion"
	| "a union over a recursion"

export const readSources: Arr.NonEmptyReadonlyArray<ReadSource> = [
	"a stored relation",
	"one rule",
	"a union",
	"a recursion",
	"one rule over a recursion",
	"a union over a recursion"
]

/** How the arm reads the source: matched at the arm's vertex, or negated there. */
export type ReadHow = "matched" | "negated"

const idsOf = (relation: string): RuleDesc =>
	rule({
		vars: vars(relation, "id"),
		matches: [match(relationSource(relation), { id: ref(relation, "id") })],
		where: [],
		head: { id: ref(relation, "id") },
		interiors: [],
		attach: []
	})

/** A recursion of its own: every vertex, and every vertex an edge reaches from one, the inner walk a step may read. */
const inner = recursive(
	"Inner",
	{ id: idDesc },
	[idsOf("Vertex")],
	[
		rule({
			vars: [plainVar("inner.id"), ...vars("Edge", "to")],
			matches: [
				match({ kind: "self" }, { id: varRef("inner.id") }),
				match(relationSource("Edge"), { from: varRef("inner.id"), to: ref("Edge", "to") })
			],
			where: [],
			head: { id: ref("Edge", "to") },
			interiors: [],
			attach: []
		})
	]
)

const overInner = (): RuleDesc =>
	rule({
		vars: [plainVar("over.id")],
		matches: [match(imported(inner, {}), { id: varRef("over.id") })],
		where: [],
		head: { id: varRef("over.id") },
		interiors: [],
		attach: []
	})

const sourceOf = (read: ReadSource) => {
	switch (read) {
		case "a stored relation":
			return relationSource("Blocked")
		case "one rule":
			return imported(queryDesc(idsOf("Blocked")), {})
		case "a union":
			return imported(queryDesc(idsOf("Blocked"), idsOf("Vertex")), {})
		case "a recursion":
			return imported(inner, {})
		case "one rule over a recursion":
			return imported(queryDesc(overInner()), {})
		case "a union over a recursion":
			return imported(queryDesc(overInner(), idsOf("Blocked")), {})
	}
}

/** The definition: the source read at the vertex of the place's arm, matched or negated, beside the seed and the step. */
export const readingDefinition = (place: ReadPlace, read: ReadSource, how: ReadHow): QueryDesc => {
	const source = sourceOf(read)
	const at = (vertex: ExprDesc) =>
		how === "matched"
			? { matches: [match(source, { id: vertex })], where: [] }
			: { matches: [], where: [not(source, { id: vertex })] }
	const seeded = seed({ node: ref("Vertex", "id"), n: zero }, [])
	const reading = at(ref("Vertex", "id"))
	const base =
		place === "base"
			? {
					...seeded,
					matches: [...seeded.matches, ...reading.matches],
					where: [...seeded.where, ...reading.where]
				}
			: seeded
	const stepping = at(ref("Edge", "to"))
	const main = step(
		["node", "n"],
		place === "step" ? stepping.where : [],
		{ node: ref("Edge", "to"), n: s("n") },
		{
			vars: [],
			matches: place === "step" ? stepping.matches : []
		}
	)
	const selfless = rule({
		vars: vars("Vertex", "id"),
		matches: [match(relationSource("Vertex"), { id: ref("Vertex", "id") }), ...reading.matches],
		where: reading.where,
		head: { node: ref("Vertex", "id"), n: zero },
		interiors: [],
		attach: []
	})
	return recursive(
		"Reach",
		{ node: idDesc, n: naturalField },
		[base],
		place === "arm reading no self" ? [main, selfless] : [main]
	)
}

/**
 * The rule (check/recursion/scan.ts): a recursive arm that reads self reads no recursion and no union of rules, at
 * any depth of a source it matches or negates, a recursion before a union where it reads both; a base arm and an arm
 * reading no self read either, once.
 */
export const readVerdict = (
	place: ReadPlace,
	read: ReadSource
): Extract<RecursionRefusal, { readonly kind: "recursiveStep" | "unionStep" }> | undefined => {
	if (place !== "step") {
		return undefined
	}
	switch (read) {
		case "a stored relation":
		case "one rule":
			return undefined
		case "a union":
			return { kind: "unionStep", recursion: "Reach", rules: 2 }
		case "a recursion":
		case "one rule over a recursion":
		case "a union over a recursion":
			return { kind: "recursiveStep", recursion: "Reach", inner: "Inner" }
	}
}

export type ReadFeature =
	| `refused ${"recursiveStep" | "unionStep"} ${ReadHow}`
	| "refused at depth"
	| `admitted ${"a stored relation" | "one rule"} in the step`
	| "admitted in the base"
	| "admitted in an arm reading no self"
