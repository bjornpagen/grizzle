/**
 * Endpoint spellings of span relations on PostgreSQL 19: the optimized artifact's normal form of a predicate over
 * spans' endpoints (lower, upper, a computed span, the window parameter) selects exactly what PostgreSQL selects for the
 * predicate as spelled.
 *
 * - Exhausted: every endpoint predicate over a pair of spans, its negation, and every two of them joined, on each range
 *   type, over facts at the window and at the type's limits.
 * - Searched: generated trees of span predicates, Allen formulas beside endpoint predicates over the same pair, the
 *   window parameter, comparisons within one span, predicates over no span, negations, and two pairs alike but for
 *   their computed span.
 *
 * The oracle is PostgreSQL evaluating the predicate as spelled, over the same facts and parameters.
 *
 * Features: each type rewritten, and selecting every fact, none and some; each tree shape above.
 *
 * Plants (~/.cache/grizzle-release/BR13/plants): endpoints-upper-inclusive.patch (pointIn of an upper endpoint read as
 * inclusive).
 */
import { layer } from "@effect/vitest"
import { drawn, exhaust } from "@grizzle/testing/explore"
import { required, requiredInSpace } from "@grizzle/testing/features"
import {
	array,
	boolean,
	constant,
	element,
	type Gen,
	int,
	map,
	oneOf,
	weighted
} from "@grizzle/testing/gen"
import { exact, ordered, set, structuralHash } from "@grizzle/testing/oracle"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Order, pipe, String as Str } from "effect"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { jsonText } from "#compiler/core/trusted.ts"
import { Compute, type Predicate } from "#compiler/public/compute.ts"
import { pg, span } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { quoteIdent } from "#compiler/sql/print.ts"
import {
	compileSpanQuery,
	type InstalledSpans,
	installSpans,
	optimizedRules,
	runArtifact
} from "#test/pg/spans/allen/support.ts"
import { defined, nonEmpty } from "#test/support/assert.ts"
import { parsedName } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { argumentsOf } from "#test/support/list.ts"
import {
	type HalfOpen,
	type RangeType,
	rangeLimits,
	rangeTypes,
	spanText
} from "#test/support/oracle/allen.ts"
import { endpointMaskPredicate } from "#test/support/oracle/gen/spans.ts"
import { oracleCheck, PropertyFailed } from "#test/support/oracle/runner.ts"
import type { RawSession } from "#test/support/substrate/session.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"

const IntPairs = relation(
	"IntPairs",
	{ id: pg.integer, a: span(pg.integer), b: span(pg.integer) },
	["id"]
)

const BigPairs = relation("BigPairs", { id: pg.integer, a: span(pg.bigint), b: span(pg.bigint) }, [
	"id"
])
const Pairs = schema("EndpointPairs", { IntPairs, BigPairs }, [])

const relationOf: Readonly<Record<RangeType, string>> = {
	int4range: "IntPairs",
	int8range: "BigPairs"
}

/** The facts' spans: the window [0, 5] and three at the type's limits. */
const spansOf = (carrier: RangeType): ReadonlyArray<HalfOpen> => {
	const out: Array<HalfOpen> = []
	for (let lo = 0n; lo < 5n; lo++) {
		for (let hi = lo + 1n; hi <= 5n; hi++) {
			out.push({ lo, hi })
		}
	}
	const { min, max } = rangeLimits[carrier]
	out.push({ lo: min, hi: min + 2n }, { lo: max - 2n, hi: max }, { lo: min, hi: max })
	return out
}

/** Every ordered pair of the spans, by id. */
const factsOf = (
	carrier: RangeType
): ReadonlyArray<{ readonly id: number; readonly a: HalfOpen; readonly b: HalfOpen }> => {
	const all = spansOf(carrier)
	return Arr.flatMap(all, (a, i) => Arr.map(all, (b, j) => ({ id: i * all.length + j, a, b })))
}

type Endpoint = "lower" | "upper"
type Comparison = "eq" | "ne" | "lt" | "le" | "gt" | "ge"
type Column = "a" | "b"
/** A span the row computes from both columns: `ab` is a where `id >= k` and b elsewhere, `ba` the other way round. */
type Computed = "ab" | "ba"
/** A span of the row: one of its span columns, or a span it computes. */
type RowSpan = Column | Computed
/** A span operand: a span of the row, or the span parameter w. */
type Operand = RowSpan | "w"
/** An Allen formula's operand: one of the relation's span columns, or the span parameter w. */
type FormulaOperand = Column | "w"

const endpoints: Arr.NonEmptyReadonlyArray<Endpoint> = ["lower", "upper"]
const comparisons: Arr.NonEmptyReadonlyArray<Comparison> = ["eq", "ne", "lt", "le", "gt", "ge"]
const symbols: Readonly<Record<Comparison, string>> = {
	eq: "=",
	ne: "<>",
	lt: "<",
	le: "<=",
	gt: ">",
	ge: ">="
}

/** A predicate as a case states it. */
type Pred =
	| {
			readonly kind: "compare"
			readonly x: Endpoint
			readonly of: RowSpan
			readonly cmp: Comparison
			readonly y: Endpoint
			readonly against: RowSpan
	  }
	| {
			readonly kind: "pointIn"
			readonly x: Endpoint
			readonly of: RowSpan
			readonly within: Operand
	  }
	| {
			readonly kind: "allen"
			readonly left: Column
			readonly mask: number
			readonly right: FormulaOperand
	  }
	| { readonly kind: "and" | "or"; readonly parts: ReadonlyArray<Pred> }
	| { readonly kind: "not"; readonly arg: Pred }
	| { readonly kind: "id" }

/** A case: the carrier, the predicate, and the window and the bound its parameters take. */
interface EndpointCase {
	readonly carrier: RangeType
	readonly pred: Pred
	readonly window: number
	readonly at: number
}

const other = (c: Column): Column => (c === "a" ? "b" : "a")

/** Every endpoint predicate over the pair (a, b), each span's endpoint on the left in turn. */
const pairLeaves: Arr.NonEmptyReadonlyArray<Pred> = nonEmpty(
	Arr.flatMap(["a", "b"] as const, (of): ReadonlyArray<Pred> => [
		...Arr.flatMap(endpoints, (x) =>
			Arr.flatMap(comparisons, (cmp) =>
				Arr.map(endpoints, (y): Pred => ({ kind: "compare", x, of, cmp, y, against: other(of) }))
			)
		),
		...Arr.map(endpoints, (x): Pred => ({ kind: "pointIn", x, of, within: other(of) }))
	]),
	"the endpoint predicates over the pair"
)

/**
 * What spelling a predicate needs of one rule: the endpoint terms of its columns, of type E, and the predicates the rule
 * builds over them and its span operands.
 */
interface Spelling<E> {
	readonly endpoint: (x: Endpoint, of: RowSpan) => E
	readonly compare: (cmp: Comparison, x: E, y: E) => Predicate<never>
	readonly pointIn: (point: E, within: Operand) => Predicate<never>
	readonly allen: (left: Column, mask: number, right: FormulaOperand) => Predicate<never>
	readonly and: (parts: ReadonlyArray<Predicate<never>>) => Predicate<never>
	readonly or: (parts: ReadonlyArray<Predicate<never>>) => Predicate<never>
	readonly id: () => Predicate<never>
}

/** The predicate through one rule's builders. */
const spell = <E>(p: Pred, s: Spelling<E>): Predicate<never> => {
	switch (p.kind) {
		case "compare":
			return s.compare(p.cmp, s.endpoint(p.x, p.of), s.endpoint(p.y, p.against))
		case "pointIn":
			return s.pointIn(s.endpoint(p.x, p.of), p.within)
		case "allen":
			return s.allen(p.left, p.mask, p.right)
		case "and":
			return s.and(Arr.map(p.parts, (q) => spell(q, s)))
		case "or":
			return s.or(Arr.map(p.parts, (q) => spell(q, s)))
		case "not":
			return Compute.not(spell(p.arg, s))
		case "id":
			return s.id()
	}
}

/** The case's query over the int4range pairs: the facts satisfying its predicate, delivering their ids. */
const intQuery = (pred: Pred) =>
	query(Pairs).rule((r) => {
		const { id, a, b } = v(IntPairs, "intPairs")
		const column = (c: Column) => (c === "a" ? a : b)
		const atLeastK = () => r.ge(id, r.param("k", pg.integer))
		const rowSpan = (s: RowSpan) => {
			switch (s) {
				case "a":
				case "b":
					return column(s)
				case "ab":
					return Compute.cond(atLeastK(), a, b)
				case "ba":
					return Compute.cond(atLeastK(), b, a)
			}
		}
		const window = () => r.param("w", IntPairs.fields.a)
		const span = (o: Operand) => (o === "w" ? window() : rowSpan(o))
		const where = spell(pred, {
			endpoint: (x, s) => {
				switch (s) {
					case "a":
						return x === "lower" ? Compute.lower(a, pg.integer) : Compute.upper(a, pg.integer)
					case "b":
						return x === "lower" ? Compute.lower(b, pg.integer) : Compute.upper(b, pg.integer)
					case "ab": {
						const ab = Compute.cond(atLeastK(), a, b)
						return x === "lower" ? Compute.lower(ab, pg.integer) : Compute.upper(ab, pg.integer)
					}
					case "ba": {
						const ba = Compute.cond(atLeastK(), b, a)
						return x === "lower" ? Compute.lower(ba, pg.integer) : Compute.upper(ba, pg.integer)
					}
				}
			},
			compare: (cmp, x, y) => {
				switch (cmp) {
					case "eq":
						return r.eq(x, y)
					case "ne":
						return r.ne(x, y)
					case "lt":
						return r.lt(x, y)
					case "le":
						return r.le(x, y)
					case "gt":
						return r.gt(x, y)
					case "ge":
						return r.ge(x, y)
				}
			},
			pointIn: (point, within) => r.pointIn(point, span(within)),
			allen: (left, mask, right) =>
				r.allen(column(left), mask, right === "w" ? window() : column(right)),
			and: (parts) => r.and(...argumentsOf(parts)),
			or: (parts) => r.or(...argumentsOf(parts)),
			id: atLeastK
		})
		return r.match(IntPairs, { id, a, b }).where(where).find({ id })
	})

/** The case's query over the int8range pairs. */
const bigQuery = (pred: Pred) =>
	query(Pairs).rule((r) => {
		const { id, a, b } = v(BigPairs, "bigPairs")
		const column = (c: Column) => (c === "a" ? a : b)
		const atLeastK = () => r.ge(id, r.param("k", pg.integer))
		const rowSpan = (s: RowSpan) => {
			switch (s) {
				case "a":
				case "b":
					return column(s)
				case "ab":
					return Compute.cond(atLeastK(), a, b)
				case "ba":
					return Compute.cond(atLeastK(), b, a)
			}
		}
		const window = () => r.param("w", BigPairs.fields.a)
		const span = (o: Operand) => (o === "w" ? window() : rowSpan(o))
		const where = spell(pred, {
			endpoint: (x, s) => {
				switch (s) {
					case "a":
						return x === "lower" ? Compute.lower(a, pg.bigint) : Compute.upper(a, pg.bigint)
					case "b":
						return x === "lower" ? Compute.lower(b, pg.bigint) : Compute.upper(b, pg.bigint)
					case "ab": {
						const ab = Compute.cond(atLeastK(), a, b)
						return x === "lower" ? Compute.lower(ab, pg.bigint) : Compute.upper(ab, pg.bigint)
					}
					case "ba": {
						const ba = Compute.cond(atLeastK(), b, a)
						return x === "lower" ? Compute.lower(ba, pg.bigint) : Compute.upper(ba, pg.bigint)
					}
				}
			},
			compare: (cmp, x, y) => {
				switch (cmp) {
					case "eq":
						return r.eq(x, y)
					case "ne":
						return r.ne(x, y)
					case "lt":
						return r.lt(x, y)
					case "le":
						return r.le(x, y)
					case "gt":
						return r.gt(x, y)
					case "ge":
						return r.ge(x, y)
				}
			},
			pointIn: (point, within) => r.pointIn(point, span(within)),
			allen: (left, mask, right) =>
				r.allen(column(left), mask, right === "w" ? window() : column(right)),
			and: (parts) => r.and(...argumentsOf(parts)),
			or: (parts) => r.or(...argumentsOf(parts)),
			id: atLeastK
		})
		return r.match(BigPairs, { id, a, b }).where(where).find({ id })
	})

/**
 * The oracle's parameters: the window and the bound, each bound once as a column of the one row "w" every predicate reads
 * them from, so the statement's placeholders and its values are one list.
 */
interface OracleParam {
	readonly column: "v" | "k"
	readonly type: string
	readonly text: string
}

const oracleParams = (
	carrier: RangeType,
	window: HalfOpen,
	at: number
): ReadonlyArray<OracleParam> => [
	{ column: "v", type: carrier, text: spanText(window) },
	{ column: "k", type: "int4", text: String(at) }
]

/** The parameters' row: each placeholder cast from its text to its type, named by its column. */
const paramsRow = (params: ReadonlyArray<OracleParam>): string =>
	`(SELECT ${Arr.join(
		Arr.map(params, (q, i) => `$${i + 1}::text::${q.type}`),
		", "
	)}) AS "w"(${Arr.join(
		Arr.map(params, (q) => `"${q.column}"`),
		", "
	)})`

/** A span of the fact `p` as the oracle evaluates it, a computed one by the bound `w.k`. */
const rowSpanSql = (s: RowSpan): string => {
	switch (s) {
		case "a":
		case "b":
			return `"p"."${s}"`
		case "ab":
			return `(CASE WHEN "p"."id" >= "w"."k" THEN "p"."a" ELSE "p"."b" END)`
		case "ba":
			return `(CASE WHEN "p"."id" >= "w"."k" THEN "p"."b" ELSE "p"."a" END)`
	}
}

const operand = (o: Operand): string => (o === "w" ? `"w"."v"` : rowSpanSql(o))

const ref = (o: FormulaOperand) =>
	o === "w" ? { table: "w", column: "v" } : { table: "p", column: o }

/**
 * The predicate as the oracle evaluates it, over the fact `p` and the parameters' row `w`: the window `w.v` and the
 * bound `w.k`.
 */
const predSql = (p: Pred): string => {
	switch (p.kind) {
		case "compare":
			return `(${p.x}(${operand(p.of)}) ${symbols[p.cmp]} ${p.y}(${operand(p.against)}))`
		case "pointIn":
			return `(${operand(p.within)} @> ${p.x}(${operand(p.of)}))`
		case "allen":
			return `(${endpointMaskPredicate(p.mask, ref(p.left), ref(p.right))})`
		case "and":
		case "or":
			return `(${Arr.join(Arr.map(p.parts, predSql), p.kind === "and" ? " AND " : " OR ")})`
		case "not":
			return `(NOT ${predSql(p.arg)})`
		case "id":
			return `("p"."id" >= "w"."k")`
	}
}

const printPred = (p: Pred): string => pipe(predSql(p), Str.replaceAll('"', ""))

const sameRowSet = set(structuralHash, ordered(exact))

/** The host value of a span of the carrier: JavaScript integers for int4range, bigints for int8range. */
const spanHost = (carrier: RangeType, s: HalfOpen) =>
	carrier === "int4range" ? { start: Number(s.lo), end: Number(s.hi) } : { start: s.lo, end: s.hi }

/** Installs the schema once and fills both relations. */
const installPairs = Effect.gen(function* () {
	const s = yield* Substrate
	const installed = yield* installSpans(Pairs, { label: "endpoints", extensions: [] })
	for (const carrier of rangeTypes) {
		const facts = factsOf(carrier)
		yield* s.admin.queryValues(
			`INSERT INTO ${tableOf(installed, carrier)} ("id", "a", "b") SELECT j.id, j.a::${carrier}, j.b::${carrier} FROM jsonb_to_recordset($1::text::jsonb) AS j(id int4, a text, b text)`,
			[jsonText(Arr.map(facts, (f) => ({ id: f.id, a: spanText(f.a), b: spanText(f.b) })))]
		)
	}
	return installed
})

const tableOf = (installed: InstalledSpans, carrier: RangeType): string =>
	`${quoteIdent(installed.schema)}.${quoteIdent(identifierOf(identity.table(parsedName(relationOf[carrier]))))}`

/** What one case ran to: the ids the oracle selects, and whether the optimized artifact rests on the normal form. */
interface Ran {
	readonly selected: number
	readonly rewritten: boolean
}

const runCase = (installed: InstalledSpans, db: RawSession, c: EndpointCase) =>
	Effect.gen(function* () {
		const spans = spansOf(c.carrier)
		const window = defined(spans[c.window % spans.length], "a window among the facts' spans")
		const template = compileSpanQuery(
			c.carrier === "int4range" ? intQuery(c.pred) : bigQuery(c.pred),
			installed.schema
		)
		const where = `${c.carrier} ${printPred(c.pred)} over the window ${spanText(window)}`
		const statements = yield* runArtifact(db, template, "optimized", {
			w: spanHost(c.carrier, window),
			k: c.at
		})
		const [rows, ...more] = statements
		if (rows === undefined || more.length > 0) {
			return yield* new PropertyFailed({ report: `${where}: one optimized statement` })
		}
		const params = oracleParams(c.carrier, window, c.at)
		const oracle = yield* db.values(
			`SELECT "p"."id"::text FROM ${tableOf(installed, c.carrier)} AS "p" CROSS JOIN ${paramsRow(params)} WHERE ${predSql(c.pred)}`,
			Arr.map(params, (q) => q.text)
		)
		const expected = Arr.map(oracle, (row) => Arr.map(row, (cell) => String(cell)))
		const difference = sameRowSet(rows, expected)
		if (Option.isSome(difference)) {
			return yield* new PropertyFailed({ report: `${where}: ${difference.value}` })
		}
		const ran: Ran = {
			selected: expected.length,
			rewritten: optimizedRules(template).has("simplify.allen")
		}
		return ran
	})

/**
 * Every endpoint predicate over the pair, its negation, and the conjunction and disjunction of every two distinct ones:
 * the second leaf of a pair always after the first, so each pair is drawn once.
 */
const pairPredicates: Gen<Pred> = oneOf<Pred>([
	element(pairLeaves),
	map(element(pairLeaves), (arg): Pred => ({ kind: "not", arg })),
	(source) => {
		const i = source.draw(int(0, pairLeaves.length - 2))
		const j = source.draw(int(i + 1, pairLeaves.length - 1))
		return {
			kind: source.draw(element(["and", "or"] as const)),
			parts: [defined(pairLeaves[i], "a leaf"), defined(pairLeaves[j], "a leaf")]
		}
	}
])

const exhaustiveCases: Gen<EndpointCase> = (source) => ({
	carrier: source.draw(element(rangeTypes)),
	pred: source.draw(pairPredicates),
	window: 0,
	at: 0
})
/** 52 leaves, 52 negations and 2 x 1,326 pairs, for each carrier. */
const exhaustiveLimit = 2 * (52 + 52 + 2 * 1326)

type Selection = "every fact" | "no fact" | "some facts"
type ExhaustiveFeature = `${RangeType} rewritten` | `${RangeType} ${Selection}`

const selection = (carrier: RangeType, selected: number): Selection =>
	selected === 0 ? "no fact" : selected === factsOf(carrier).length ? "every fact" : "some facts"

type GeneratedFeature =
	| "rewritten"
	| "an endpoint predicate beside an Allen formula over its pair"
	| "a pair with the parameter"
	| "a comparison within one span"
	| "a predicate over no span"
	| "under a negation"
	| "two pairs alike but for their computed span"

const columnGen: Gen<Column> = element(["a", "b"] as const)
const rowSpanGen: Gen<RowSpan> = element(["a", "b", "ab", "ba"] as const)
const operandGen: Gen<Operand> = element(["a", "b", "ab", "ba", "w"] as const)
const formulaOperandGen: Gen<FormulaOperand> = element(["a", "b", "w"] as const)

const leafGen: Gen<Pred> = weighted<Pred>([
	[6, element(pairLeaves)],
	[
		2,
		(source) => ({
			kind: "compare",
			x: source.draw(element(endpoints)),
			of: source.draw(rowSpanGen),
			cmp: source.draw(element(comparisons)),
			y: source.draw(element(endpoints)),
			against: source.draw(rowSpanGen)
		})
	],
	[
		2,
		(source) => ({
			kind: "pointIn",
			x: source.draw(element(endpoints)),
			of: source.draw(rowSpanGen),
			within: source.draw(operandGen)
		})
	],
	[
		2,
		(source) => ({
			kind: "allen",
			left: source.draw(columnGen),
			mask: source.draw(int(1, 8191)),
			right: source.draw(formulaOperandGen)
		})
	],
	[1, constant({ kind: "id" })]
])

/** An endpoint predicate over a computed span and a column: a comparison or a membership, either one first. */
const besideGen = (computed: Computed, beside: Column): Gen<Pred> =>
	oneOf<Pred>([
		(source) => {
			const [of, against]: readonly [RowSpan, RowSpan] = source.draw(boolean)
				? [computed, beside]
				: [beside, computed]
			return {
				kind: "compare",
				x: source.draw(element(endpoints)),
				of,
				cmp: source.draw(element(comparisons)),
				y: source.draw(element(endpoints)),
				against
			}
		},
		(source) => {
			const [of, within]: readonly [RowSpan, RowSpan] = source.draw(boolean)
				? [computed, beside]
				: [beside, computed]
			return { kind: "pointIn", x: source.draw(element(endpoints)), of, within }
		}
	])

/** A connective over two endpoint predicates whose pairs share a column and differ in the computed span beside it. */
const alikeGen: Gen<Pred> = (source) => {
	const beside = source.draw(columnGen)
	return {
		kind: source.draw(element(["and", "or"] as const)),
		parts: [source.draw(besideGen("ab", beside)), source.draw(besideGen("ba", beside))]
	}
}

/**
 * Trees of span predicates at most `depth` connectives deep, a leaf most often at every level, so trees stay small and
 * shrink toward a leaf.
 */
const predGen = (depth: number): Gen<Pred> => {
	if (depth === 0) {
		return leafGen
	}
	const sub = predGen(depth - 1)
	return weighted<Pred>([
		[4, leafGen],
		[
			2,
			(source) => ({
				kind: source.draw(element(["and", "or"] as const)),
				parts: source.draw(array(sub, { min: 2, max: 3 }))
			})
		],
		[1, alikeGen],
		[1, (source) => ({ kind: "not", arg: source.draw(sub) })]
	])
}

const caseGen: Gen<EndpointCase> = (source) => ({
	carrier: source.draw(element(rangeTypes)),
	pred: source.draw(predGen(3)),
	window: source.draw(int(0, 17)),
	at: source.draw(int(0, 400))
})

/** The two spans a leaf reads, or none: `id >= k` reads no span. */
const leafSpans = (p: Pred): readonly [Operand, Operand] | undefined => {
	switch (p.kind) {
		case "compare":
			return [p.of, p.against]
		case "pointIn":
			return [p.of, p.within]
		case "allen":
			return [p.left, p.right]
		case "and":
		case "or":
		case "not":
		case "id":
			return undefined
	}
}

/** The unordered pair of spans a leaf is over, or none: a comparison within one span and `id >= k` are over no pair. */
const leafPair = (p: Pred): string | undefined => {
	const spans = leafSpans(p)
	return spans === undefined || spans[0] === spans[1]
		? undefined
		: Arr.join(Arr.sort(spans, Order.String), " ")
}

const isComputed = (o: Operand): boolean => o === "ab" || o === "ba"

/** Each computed span a leaf pairs with another span, beside that other span. */
const besideComputed = (
	p: Pred
): ReadonlyArray<{ readonly computed: Operand; readonly beside: Operand }> => {
	const spans = leafSpans(p)
	if (spans === undefined) {
		return []
	}
	const [x, y] = spans
	return Arr.filter(
		[
			{ computed: x, beside: y },
			{ computed: y, beside: x }
		],
		(e) => isComputed(e.computed) && e.beside !== e.computed
	)
}

/** Whether two parts are over pairs that share one span and differ in the computed span beside it. */
const alikeButComputed = (p: Pred, q: Pred): boolean =>
	Arr.some(besideComputed(p), (e) =>
		Arr.some(besideComputed(q), (f) => f.beside === e.beside && f.computed !== e.computed)
	)

const generatedFeatures = (p: Pred, negated: boolean, out: Set<GeneratedFeature>): void => {
	if (negated && p.kind !== "not") {
		out.add("under a negation")
	}
	switch (p.kind) {
		case "compare":
			if (p.of === p.against) {
				out.add("a comparison within one span")
			}
			return
		case "pointIn":
			if (p.within === "w") {
				out.add("a pair with the parameter")
			}
			return
		case "allen":
			return
		case "id":
			out.add("a predicate over no span")
			return
		case "not":
			generatedFeatures(p.arg, true, out)
			return
		case "and":
		case "or": {
			const allen = new Set(Arr.flatMap(p.parts, (q) => (q.kind === "allen" ? [leafPair(q)] : [])))
			if (
				Arr.some(p.parts, (q) => q.kind !== "allen" && q.kind !== "id" && allen.has(leafPair(q)))
			) {
				out.add("an endpoint predicate beside an Allen formula over its pair")
			}
			if (
				Arr.some(p.parts, (q, i) => Arr.some(p.parts.slice(i + 1), (o) => alikeButComputed(q, o)))
			) {
				out.add("two pairs alike but for their computed span")
			}
			for (const q of p.parts) {
				generatedFeatures(q, negated, out)
			}
		}
	}
}

layer(Substrate.layer)("endpoint spellings of span relations on PostgreSQL 19", (it) => {
	it.effect(
		"select in the optimized artifact exactly what PostgreSQL selects for the spelling, for every endpoint predicate over a pair, its negation and every two of them joined",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const s = yield* Substrate
					const installed = yield* installPairs
					const db = yield* s.session({ ...ownerSession(), label: "owner" })
					return yield* exhaust(
						{
							box: "every endpoint predicate over a pair, its negation and every two of them joined, on each range type",
							oracle: {
								kind: "postgresql",
								name: "the predicate as spelled, evaluated by PostgreSQL over the same facts"
							},
							suite: "spans/endpoint-normal-form",
							generator: exhaustiveCases,
							literal: Formatter.format,
							limit: exhaustiveLimit,
							coverage: requiredInSpace<ExhaustiveFeature>(
								Arr.flatMap(rangeTypes, (carrier): Arr.NonEmptyReadonlyArray<ExhaustiveFeature> => [
									`${carrier} rewritten`,
									`${carrier} every fact`,
									`${carrier} no fact`,
									`${carrier} some facts`
								])
							),
							caseHang
						},
						(c, k) =>
							Effect.map(runCase(installed, db, c), (ran) => {
								k.note(`${c.carrier} ${selection(c.carrier, ran.selected)}`)
								if (ran.rewritten) {
									k.note(`${c.carrier} rewritten`)
								}
							})
					)
				})
			)
	)

	it.effect(
		"select in the optimized artifact exactly what PostgreSQL selects for generated trees of span predicates",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const s = yield* Substrate
					const installed = yield* installPairs
					const db = yield* s.session({ ...ownerSession(), label: "owner" })
					return yield* oracleCheck(
						drawn(caseGen),
						{
							suite: "spans/endpoint-normal-form-trees",
							oracle: {
								kind: "postgresql",
								name: "the predicate as spelled, evaluated by PostgreSQL over the same facts"
							},
							literal: Formatter.format,
							coverage: required<GeneratedFeature>(
								[
									"rewritten",
									"an endpoint predicate beside an Allen formula over its pair",
									"a pair with the parameter",
									"a comparison within one span",
									"a predicate over no span",
									"under a negation",
									"two pairs alike but for their computed span"
								],
								{ cases: 300, sense: notesOnly }
							),
							kept: [],
							runs: 300,
							shrink: completeShrink,
							perturb: "none"
						},
						(c, k) =>
							Effect.map(runCase(installed, db, c), (ran) => {
								const reached = new Set<GeneratedFeature>()
								generatedFeatures(c.pred, false, reached)
								if (ran.rewritten) {
									reached.add("rewritten")
								}
								k.noteAll(reached)
							})
					)
				})
			)
	)
})
