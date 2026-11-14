import { array, boolean, element, type Gen, int, map, oneOf } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Option, type Scope, String as Str } from "effect"
import { ALLEN, fullAllenMask } from "#compiler/allen/mask.ts"
import type { FieldDesc, QueryDesc } from "#compiler/ir/desc.ts"
import {
	decodedQuery,
	type AuthoredExprDesc as ExprDesc,
	type HeadTermDesc,
	type AuthoredRelationDesc as RelationDesc,
	relation as storedRelation,
	type RuleDesc,
	type SchemaDesc
} from "#test/support/fixtures/ir/desc.ts"

import { jsonText } from "#compiler/core/trusted.ts"
import {
	type CalendarDate,
	dateOfDayNumber,
	dayNumber,
	lastCalendarDate
} from "#compiler/ir/date.ts"
import {
	classify,
	compareSpans,
	type HalfOpen,
	limitSpansWithin,
	rangeLimits,
	relationBit,
	type SpanLimits
} from "#test/support/oracle/allen.ts"
import { cyclicAt, elementAt } from "#test/support/oracle/pick.ts"
import type { SqlError } from "#test/support/pg.ts"
import type { RawSession } from "#test/support/substrate/session.ts"
import { freshSchema, Substrate } from "#test/support/substrate/substrate.ts"

export const spanEndpointKinds = ["integer", "bigint", "contract", "date"] as const
export type SpanEndpointKind = (typeof spanEndpointKinds)[number]

/** The range type of a span field: int4range, int8range or daterange. */
type SpanRangeType = "int4range" | "int8range" | "daterange"

/**
 * int4range for pg.integer endpoints, int8range for pg.bigint and contracts over it, daterange for date endpoints.
 */
const rangeTypeOf = (endpoint: SpanEndpointKind): SpanRangeType => {
	switch (endpoint) {
		case "integer":
			return "int4range"
		case "bigint":
		case "contract":
			return "int8range"
		case "date":
			return "daterange"
	}
}

/** The endpoint's base type name in SQL. */
const endpointSqlType = (endpoint: SpanEndpointKind): "int4" | "int8" | "date" => {
	switch (endpoint) {
		case "integer":
			return "int4"
		case "bigint":
		case "contract":
			return "int8"
		case "date":
			return "date"
	}
}

/**
 * The day a date span's endpoint 0 is: a span of dates is held as a span of day offsets from it, so the window
 * [-3, 8] is 2024-02-24 to 2024-03-06, across a leap day and a month's end.
 */
const dateOrigin = BigInt(dayNumber("2024-02-27"))

/** The calendar date of a day offset from dateOrigin. */
const dateAt = (offset: bigint): CalendarDate => dateOfDayNumber(dateOrigin + offset)

/**
 * The limits of a span field's stored domain, in its endpoint's offsets: the range type's for an integer endpoint; for
 * a date, the days a CalendarDate spells, 0001-01-01 to 9999-12-31, the span shape CHECK's bounds.
 */
export const endpointLimits = (endpoint: SpanEndpointKind): SpanLimits => {
	switch (endpoint) {
		case "integer":
			return rangeLimits.int4range
		case "bigint":
		case "contract":
			return rangeLimits.int8range
		case "date":
			return { min: -dateOrigin, max: BigInt(dayNumber(lastCalendarDate)) - dateOrigin }
	}
}

/** An endpoint's text as its type's output function writes it: the integer, or the date of its day offset. */
const pointTextOf =
	(endpoint: SpanEndpointKind) =>
	(point: bigint): string =>
		endpoint === "date" ? dateAt(point) : String(point)

/** A span's canonical text, `[start,end)`, as its range type's output function writes it. */
export const spanTextOf =
	(endpoint: SpanEndpointKind) =>
	(span: HalfOpen): string =>
		`[${pointTextOf(endpoint)(span.lo)},${pointTextOf(endpoint)(span.hi)})`

/**
 * The Tick contract: epoch-free ticks over bigint, no smaller than -100. Its predicate is the one
 * endpoint check a generated span carries.
 */
export const tickContract = { name: "Tick", low: -100n } as const

const endpointFieldDesc = (endpoint: SpanEndpointKind): FieldDesc => {
	switch (endpoint) {
		case "integer":
			return { kind: "pg", type: "integer" }
		case "bigint":
			return { kind: "pg", type: "bigint" }
		case "date":
			return { kind: "pg", type: "date" }
		case "contract":
			return {
				kind: "contract",
				name: tickContract.name,
				base: { kind: "pg", type: "bigint" },
				predicate: {
					kind: "compare",
					op: "ge",
					left: { kind: "value" },
					right: { kind: "literal", value: tickContract.low }
				},
				facts: []
			}
	}
}

const spanFieldDesc = (endpoint: SpanEndpointKind): FieldDesc => ({
	kind: "span",
	endpoint: endpointFieldDesc(endpoint),
	width: undefined
})

/**
 * The host value of an endpoint: a JavaScript integer for pg.integer, a bigint for pg.bigint and the Tick contract, the
 * CalendarDate of its day offset for a date.
 */
const endpointHost = (
	endpoint: SpanEndpointKind,
	value: bigint
): number | bigint | CalendarDate => {
	switch (endpoint) {
		case "integer":
			return Number(value)
		case "bigint":
		case "contract":
			return value
		case "date":
			return dateAt(value)
	}
}

/** The host value of a span, `{ start, end }`. */
const spanHost = (
	endpoint: SpanEndpointKind,
	span: HalfOpen
): {
	readonly start: number | bigint | CalendarDate
	readonly end: number | bigint | CalendarDate
} => ({
	start: endpointHost(endpoint, span.lo),
	end: endpointHost(endpoint, span.hi)
})

/** The small window around zero. */
const spanWindow = { lo: -3n, hi: 8n } as const

/**
 * A span drawn from the window, or, when `limit` is set and the endpoint admits it, one of the limit spans
 * for the endpoint's range type. Every field is reduced modulo what is available.
 */
interface SpanSketch {
	readonly limit: boolean
	readonly start: number
	readonly length: number
}

/** One span in four is a limit span; shrinking moves toward the window. */
const limitSpanGen: Gen<boolean> = map(int(0, 3), (n) => n === 3)

const spanSketchGen: Gen<SpanSketch> = (source) => ({
	limit: source.draw(limitSpanGen),
	start: source.draw(int(0, 23)),
	length: source.draw(int(0, 11))
})

/** Whether an endpoint draws limit spans: not the Tick contract, whose predicate refuses the type's minimum. */
const drawsLimits = (endpoint: SpanEndpointKind): boolean => endpoint !== "contract"

const resolveSpan = (endpoint: SpanEndpointKind, sketch: SpanSketch): HalfOpen => {
	if (sketch.limit && drawsLimits(endpoint)) {
		const limits = limitSpansWithin(endpointLimits(endpoint))
		return cyclicAt(limits, sketch.start, "the limit spans")
	}
	const width = spanWindow.hi - spanWindow.lo
	const lo = spanWindow.lo + (BigInt(sketch.start) % width)
	const room = spanWindow.hi - lo
	return { lo, hi: lo + 1n + (BigInt(sketch.length) % room) }
}

/** A point: in the window widened by one on each side, or at a limit of the endpoint type. */
interface PointSketch {
	readonly limit: boolean
	readonly pick: number
}

const pointSketchGen: Gen<PointSketch> = (source) => ({
	limit: source.draw(boolean),
	pick: source.draw(int(0, 23))
})

const resolvePoint = (endpoint: SpanEndpointKind, sketch: PointSketch): bigint => {
	if (sketch.limit && drawsLimits(endpoint)) {
		const { min, max } = endpointLimits(endpoint)
		const points = [min, min + 1n, max - 1n, max]
		return cyclicAt(points, sketch.pick, "the limit points")
	}
	const width = spanWindow.hi - spanWindow.lo + 3n
	return spanWindow.lo - 1n + (BigInt(sketch.pick) % width)
}

/** The named masks first, then the basic relations, then any nonempty mask, the full mask included. */
const namedMasks: Arr.NonEmptyReadonlyArray<number> = [
	ALLEN.intersects,
	ALLEN.covers,
	ALLEN.within,
	ALLEN.precedes,
	ALLEN.overlaps,
	fullAllenMask
]

const maskGen: Gen<number> = oneOf([
	element(namedMasks),
	map(int(0, 12), (bit) => 1 << bit),
	int(1, fullAllenMask)
])

export const spanRelationNames = ["Left", "Right"] as const
type SpanRelationName = (typeof spanRelationNames)[number]

interface SpanRelation {
	readonly name: SpanRelationName
	/** Primary key ["group", "during"], a nonoverlap rule per group; otherwise primary key ["id"]. */
	readonly spanKeyed: boolean
}

export interface SpanSchema {
	readonly endpoint: SpanEndpointKind
	readonly relations: Readonly<Record<SpanRelationName, SpanRelation>>
}

const spanSchemaName = "Spans"

/** The fields of a relation, in declaration order. */
const spanRelationFields = (relation: SpanRelation): ReadonlyArray<"id" | "group" | "during"> =>
	relation.spanKeyed ? ["group", "during"] : ["id", "group", "during"]

const spanPrimaryKey = (relation: SpanRelation): readonly [string, ...Array<string>] =>
	relation.spanKeyed ? ["group", "during"] : ["id"]

/** The schema's Description, as relation(...) and schema(...) record it. */
export const spanSchemaDesc = (schema: SpanSchema): SchemaDesc => {
	const relationDesc = (relation: SpanRelation): RelationDesc => {
		const fields: Record<string, FieldDesc> = {}
		for (const field of spanRelationFields(relation)) {
			fields[field] =
				field === "during" ? spanFieldDesc(schema.endpoint) : { kind: "pg", type: "integer" }
		}
		return storedRelation(relation.name, fields, spanPrimaryKey(relation))
	}
	return {
		name: spanSchemaName,
		relations: Arr.map(spanRelationNames, (name) => relationDesc(schema.relations[name])),
		statements: [],
		extends: undefined
	}
}

export interface SpanFact {
	/** Present on every fact; a column only of id-keyed relations. */
	readonly id: number
	readonly group: number
	readonly during: HalfOpen
}

/** A row the fact generator dropped from a span-keyed relation, and the kept fact of its group it overlaps. */
interface DroppedFact {
	readonly relation: SpanRelationName
	readonly fact: SpanFact
	readonly overlaps: SpanFact
}

type SpanFacts = Readonly<Record<SpanRelationName, ReadonlyArray<SpanFact>>>

interface RowSketch {
	readonly group: number
	readonly span: SpanSketch
}

const spanGroups = 3

const rowSketchGen: Gen<RowSketch> = (source) => ({
	group: source.draw(int(0, spanGroups - 1)),
	span: source.draw(spanSketchGen)
})

/** Whether two spans share a point (`&&`). */
export const overlaps = (a: HalfOpen, b: HalfOpen): boolean => a.lo < b.hi && b.lo < a.hi

const resolveFacts = (
	schema: SpanSchema,
	sketch: Readonly<Record<SpanRelationName, ReadonlyArray<RowSketch>>>
): { readonly facts: SpanFacts; readonly dropped: ReadonlyArray<DroppedFact> } => {
	const dropped: Array<DroppedFact> = []
	const resolve = (name: SpanRelationName): ReadonlyArray<SpanFact> => {
		const relation = schema.relations[name]
		const kept: Array<SpanFact> = []
		for (const [i, row] of sketch[name].entries()) {
			const fact: SpanFact = {
				id: i,
				group: row.group % spanGroups,
				during: resolveSpan(schema.endpoint, row.span)
			}
			if (relation.spanKeyed) {
				const clash = Arr.findFirst(
					kept,
					(k) => k.group === fact.group && overlaps(k.during, fact.during)
				)
				if (Option.isSome(clash)) {
					dropped.push({ relation: name, fact, overlaps: clash.value })
					continue
				}
			}
			kept.push(fact)
		}
		return kept
	}
	return { facts: { Left: resolve("Left"), Right: resolve("Right") }, dropped }
}

/** A span operand of r.allen: a span-typed parameter or a span literal. */
interface SpanOperand {
	readonly kind: "param" | "literal"
	readonly span: HalfOpen
}

interface PointOperand {
	readonly kind: "param" | "literal"
	readonly point: bigint
}

export type SpanQuery =
	| {
			readonly kind: "allenFilter"
			readonly relation: SpanRelationName
			readonly mask: number
			readonly window: SpanOperand
	  }
	| { readonly kind: "allenJoin"; readonly mask: number }
	| { readonly kind: "pointIn"; readonly relation: SpanRelationName; readonly point: PointOperand }
	| { readonly kind: "intersection" }
	| { readonly kind: "difference" }
	| { readonly kind: "pack"; readonly relation: SpanRelationName }

export const spanQueryKinds = [
	"allenFilter",
	"allenJoin",
	"pointIn",
	"intersection",
	"difference",
	"pack"
] as const
export type SpanQueryKind = (typeof spanQueryKinds)[number]

interface QuerySketch {
	readonly kind: number
	readonly relation: number
	readonly mask: number
	readonly literal: boolean
	readonly span: SpanSketch
	readonly point: PointSketch
}

const querySketchGen =
	(kinds: ReadonlyArray<SpanQueryKind>): Gen<QuerySketch> =>
	(source) => ({
		kind: source.draw(int(0, kinds.length - 1)),
		relation: source.draw(int(0, 1)),
		mask: source.draw(maskGen),
		literal: source.draw(boolean),
		span: source.draw(spanSketchGen),
		point: source.draw(pointSketchGen)
	})

const resolveQuery = (
	endpoint: SpanEndpointKind,
	sketch: QuerySketch,
	kinds: ReadonlyArray<SpanQueryKind>
): SpanQuery => {
	const kind = cyclicAt(kinds, sketch.kind, "the span query kinds")
	const relation = elementAt(spanRelationNames, sketch.relation % 2, "the span relation names")
	const operand = sketch.literal ? "literal" : "param"
	switch (kind) {
		case "allenFilter":
			return {
				kind,
				relation,
				mask: sketch.mask,
				window: { kind: operand, span: resolveSpan(endpoint, sketch.span) }
			}
		case "allenJoin":
			return { kind, mask: sketch.mask }
		case "pointIn":
			return {
				kind,
				relation,
				point: { kind: operand, point: resolvePoint(endpoint, sketch.point) }
			}
		case "pack":
			return { kind, relation }
		case "intersection":
		case "difference":
			return { kind }
	}
}

/**
 * Span generators for the oracle.
 *
 * A span case is a small two-relation schema with span fields, its stored facts, and one span query, with everything
 * the differential harness needs to judge a lowering of it:
 *
 * - the schema and query as Descriptions (SchemaDesc, QueryDesc), the frozen boundary the compiler consumes,
 *   so the span lowerings compile the same case the reference judges;
 * - the facts and parameter values as host values, the form the codecs encode (a span is `{ start, end }`);
 * - the expected rows by brute force (`referenceRows`), from the endpoints alone: the Allen relation of a pair from
 *   the endpoint classifier of test/support/oracle/allen.ts, never from the shipped mask table, and the producers by
 *   endpoint arithmetic that the pg suite cross-checks against point sets;
 * - an independent handwritten SQL evaluation (`inSpanCase`, `referenceSql`), which classifies Allen
 *   relations from lower() and upper() and uses PostgreSQL's own range operators and functions for the producers, so
 *   the reference is checked against PostgreSQL itself (test/pg/spans/oracle).
 *
 * The schema: two relations, Left and Right, each with a scalar `group` and a span
 * field `during` over pg.integer, pg.bigint, the contract Tick over pg.bigint, or date. Each relation is
 * either span-keyed, primary key ["group", "during"], a pointwise nonoverlap rule per group, or keyed by
 * an integer `id`, so its facts overlap freely and repeat a (group, during) pair under different ids (facts
 * with different identities are distinct). The fact generator keeps a span-keyed relation lawful: a row that
 * overlaps a kept row of its group is dropped and recorded, so the pg suite can show PostgreSQL refuses exactly those
 * rows (23P01), while touching neighbours such as [9, 10) and [10, 11) are kept.
 *
 * The values: endpoints in the small window [-3, 8] around zero, so adjacent, nested, overlapping
 * and equal-bound pairs and negative endpoints are common, and, for the integer, bigint and date endpoints, spans at
 * the stored domain's limits, a start at its minimum and an exclusive end at its maximum included: int4's, int8's, and
 * a date's 0001-01-01 and 9999-12-31. A date endpoint is a day offset from 2024-02-27 (dateOrigin), written as its
 * date, so its spans are those of day numbers and its texts daterange's. The Tick contract's predicate VALUE >= -100
 * becomes endpoint checks on lower() and upper(), so Tick spans stay in the window.
 *
 * The queries:
 *
 * - allenFilter: the facts of one relation whose span stands in a mask's relations to a window, a span parameter or a
 *   span literal (r.allen(during, mask, window));
 * - allenJoin: the pairs of Left and Right facts of one group whose spans stand in a mask's relations;
 * - pointIn: the facts whose span contains a point, a parameter or a literal (r.pointIn(t, during));
 * - intersection: the intersections of the overlapping Left and Right spans of one group, zero or one per pair;
 * - difference: the binary differences of Left and Right spans of one group, zero, one or two per pair
 *   (range_minus_multi);
 * - pack: the maximal covered segments of one relation's spans per group.
 *
 * Every query keeps set semantics: the expected rows are a set, the same pieces from different pairs are one row,
 * and adjacent stored facts are never coalesced outside pack.
 *
 * Everything is generated as a sketch of plain numbers resolved by pure functions, so every sketch is a valid case
 * and shrinking any number toward zero keeps it valid.
 */
export interface SpanCase {
	readonly schema: SpanSchema
	readonly facts: SpanFacts
	readonly dropped: ReadonlyArray<DroppedFact>
	readonly query: SpanQuery
}

interface SpanCaseSketch {
	readonly endpoint: number
	readonly spanKeyed: readonly [boolean, boolean]
	readonly rows: Readonly<Record<SpanRelationName, ReadonlyArray<RowSketch>>>
	readonly query: QuerySketch
}

interface SpanCaseLimits {
	readonly maxRows: number
	readonly kinds: ReadonlyArray<SpanQueryKind>
	readonly endpoints: ReadonlyArray<SpanEndpointKind>
}

export const defaultSpanCaseLimits: SpanCaseLimits = {
	maxRows: 6,
	kinds: spanQueryKinds,
	endpoints: spanEndpointKinds
}

const spanCaseSketchGen = (limits: SpanCaseLimits): Gen<SpanCaseSketch> => {
	const rows = array(rowSketchGen, { min: 0, max: limits.maxRows })
	const query = querySketchGen(limits.kinds)
	return (source) => ({
		endpoint: source.draw(int(0, limits.endpoints.length - 1)),
		spanKeyed: [source.draw(boolean), source.draw(boolean)],
		rows: { Left: source.draw(rows), Right: source.draw(rows) },
		query: source.draw(query)
	})
}

const resolveSpanCase = (sketch: SpanCaseSketch, limits: SpanCaseLimits): SpanCase => {
	const endpoint = cyclicAt(limits.endpoints, sketch.endpoint, "the span endpoints")
	const schema: SpanSchema = {
		endpoint,
		relations: {
			Left: { name: "Left", spanKeyed: sketch.spanKeyed[0] },
			Right: { name: "Right", spanKeyed: sketch.spanKeyed[1] }
		}
	}
	const { facts, dropped } = resolveFacts(schema, sketch.rows)
	return { schema, facts, dropped, query: resolveQuery(endpoint, sketch.query, limits.kinds) }
}

export const spanCaseGen = (limits: SpanCaseLimits): Gen<SpanCase> =>
	map(spanCaseSketchGen(limits), (s) => resolveSpanCase(s, limits))

const variable = (id: string): ExprDesc => ({ kind: "var", var: id })

const spanOperandDesc = (endpoint: SpanEndpointKind, operand: SpanOperand): ExprDesc =>
	operand.kind === "param"
		? { kind: "param", name: "window", type: spanFieldDesc(endpoint) }
		: { kind: "literal", value: { span: spanHost(endpoint, operand.span) } }

const pointOperandDesc = (endpoint: SpanEndpointKind, operand: PointOperand): ExprDesc =>
	operand.kind === "param"
		? { kind: "param", name: "point", type: endpointFieldDesc(endpoint) }
		: { kind: "literal", value: endpointHost(endpoint, operand.point) }

/** One rule over one relation: its group and span bound to variables `g` and `s`. */
const oneRelationRule = (
	relation: SpanRelationName,
	where: ReadonlyArray<ExprDesc>,
	head: Readonly<Record<string, HeadTermDesc>>
): RuleDesc => ({
	vars: [
		{ id: "g", origin: { relation, field: "group" } },
		{ id: "s", origin: { relation, field: "during" } }
	],
	matches: [
		{
			source: { kind: "relation", name: relation },
			bindings: { group: variable("g"), during: variable("s") }
		}
	],
	where,
	head,
	interiors: [],
	attach: []
})

/**
 * One rule over a Left and a Right fact of one group: the shared group `g`, the Left span `a` and the Right span `b`.
 */
const pairRule = (
	where: ReadonlyArray<ExprDesc>,
	head: Readonly<Record<string, HeadTermDesc>>
): RuleDesc => ({
	vars: [
		{ id: "g", origin: { relation: "Left", field: "group" } },
		{ id: "a", origin: { relation: "Left", field: "during" } },
		{ id: "b", origin: { relation: "Right", field: "during" } }
	],
	matches: [
		{
			source: { kind: "relation", name: "Left" },
			bindings: { group: variable("g"), during: variable("a") }
		},
		{
			source: { kind: "relation", name: "Right" },
			bindings: { group: variable("g"), during: variable("b") }
		}
	],
	where,
	head,
	interiors: [],
	attach: []
})

const rules = (rule: RuleDesc): QueryDesc => decodedQuery({ kind: "rules", arms: [rule] })

/**
 * The query as query(Spans).rule(...) records it. A producer's head groups by the head's other terms, as an aggregate
 * does.
 */
export const spanQueryDesc = (c: SpanCase): QueryDesc => {
	const endpoint = c.schema.endpoint
	const q = c.query
	switch (q.kind) {
		case "allenFilter":
			return rules(
				oneRelationRule(
					q.relation,
					[
						{
							kind: "allen",
							left: variable("s"),
							mask: q.mask,
							right: spanOperandDesc(endpoint, q.window)
						}
					],
					{ group: variable("g"), during: variable("s") }
				)
			)
		case "allenJoin":
			return rules(
				pairRule([{ kind: "allen", left: variable("a"), mask: q.mask, right: variable("b") }], {
					group: variable("g"),
					left: variable("a"),
					right: variable("b")
				})
			)
		case "pointIn":
			return rules(
				oneRelationRule(
					q.relation,
					[{ kind: "pointIn", point: pointOperandDesc(endpoint, q.point), span: variable("s") }],
					{ group: variable("g"), during: variable("s") }
				)
			)
		case "intersection":
		case "difference":
			return rules(
				pairRule([], {
					group: variable("g"),
					piece: { kind: "producer", fn: q.kind, args: [variable("a"), variable("b")] }
				})
			)
		case "pack":
			return rules(
				oneRelationRule(q.relation, [], {
					group: variable("g"),
					piece: { kind: "producer", fn: "pack", args: [variable("s")] }
				})
			)
	}
}

/** The parameter values the query binds, as host values (a span parameter is `{ start, end }`). */
export const spanQueryParams = (c: SpanCase): Readonly<Record<string, unknown>> => {
	const q = c.query
	if (q.kind === "allenFilter" && q.window.kind === "param") {
		return { window: spanHost(c.schema.endpoint, q.window.span) }
	}
	if (q.kind === "pointIn" && q.point.kind === "param") {
		return { point: endpointHost(c.schema.endpoint, q.point.point) }
	}
	return {}
}

/** The output heading, in order. */
export const spanQueryHeading = (q: SpanQuery): ReadonlyArray<string> => {
	switch (q.kind) {
		case "allenFilter":
		case "pointIn":
			return ["group", "during"]
		case "allenJoin":
			return ["group", "left", "right"]
		case "intersection":
		case "difference":
		case "pack":
			return ["group", "piece"]
	}
}

/** Whether the pair's basic relation, by the endpoint classifier, is in the mask. */
const allenHolds = (a: HalfOpen, mask: number, b: HalfOpen): boolean =>
	(mask & (1 << relationBit(classify(a, b)))) !== 0

/** a * b under a && b: zero or one span. */
export const spanIntersection = (a: HalfOpen, b: HalfOpen): ReadonlyArray<HalfOpen> =>
	overlaps(a, b) ? [{ lo: a.lo > b.lo ? a.lo : b.lo, hi: a.hi < b.hi ? a.hi : b.hi }] : []

/** range_minus_multi(a, b): zero, one or two disjoint nonempty spans, a itself when they share no point. */
export const spanDifference = (a: HalfOpen, b: HalfOpen): ReadonlyArray<HalfOpen> => {
	if (!overlaps(a, b)) {
		return [a]
	}
	const out: Array<HalfOpen> = []
	if (a.lo < b.lo) {
		out.push({ lo: a.lo, hi: b.lo })
	}
	if (b.hi < a.hi) {
		out.push({ lo: b.hi, hi: a.hi })
	}
	return out
}

/** The maximal covered segments of a set of spans: overlapping and adjacent spans merge, real gaps stay. */
export const spanPack = (spans: ReadonlyArray<HalfOpen>): ReadonlyArray<HalfOpen> => {
	const out: Array<HalfOpen> = []
	for (const span of Arr.sort(spans, compareSpans)) {
		const last = out[out.length - 1]
		if (last !== undefined && span.lo <= last.hi) {
			out[out.length - 1] = { lo: last.lo, hi: span.hi > last.hi ? span.hi : last.hi }
		} else {
			out.push(span)
		}
	}
	return out
}

export type RawRow = ReadonlyArray<string>

/** Raw rows in lexicographic order, cell by cell, a row before every longer row it begins. */
const rowOrder = (a: RawRow, b: RawRow): -1 | 0 | 1 => {
	for (const [i, x] of a.entries()) {
		const y = b[i]
		if (y === undefined) {
			return 1
		}
		if (x !== y) {
			return x < y ? -1 : 1
		}
	}
	return a.length < b.length ? -1 : 0
}

/** A set of raw text rows in a fixed order. */
export const rowSet = (rows: ReadonlyArray<RawRow>): ReadonlyArray<RawRow> =>
	Arr.dedupeAdjacentWith(Arr.sort(rows, rowOrder), (a, b) => rowOrder(a, b) === 0)

const pairs = (c: SpanCase): ReadonlyArray<readonly [SpanFact, SpanFact]> =>
	Arr.flatMap(c.facts.Left, (l) =>
		Arr.map(
			Arr.filter(c.facts.Right, (r) => r.group === l.group),
			(r) => [l, r] as const
		)
	)

const groupsOf = (facts: ReadonlyArray<SpanFact>): ReadonlyMap<number, ReadonlyArray<HalfOpen>> => {
	const out = new Map<number, Array<HalfOpen>>()
	for (const fact of facts) {
		const list = out.get(fact.group)
		if (list === undefined) {
			out.set(fact.group, [fact.during])
		} else {
			list.push(fact.during)
		}
	}
	return out
}

/**
 * The expected rows of the case's query, as raw text in heading order: integers in decimal and spans as their
 * canonical '[start,end)' text. A set, in a fixed order.
 */
export const referenceRows = (c: SpanCase): ReadonlyArray<RawRow> => {
	const q = c.query
	const g = (fact: SpanFact): string => String(fact.group)
	const spanText = spanTextOf(c.schema.endpoint)
	switch (q.kind) {
		case "allenFilter":
			return rowSet(
				Arr.map(
					Arr.filter(c.facts[q.relation], (fact) => allenHolds(fact.during, q.mask, q.window.span)),
					(fact) => [g(fact), spanText(fact.during)]
				)
			)
		case "allenJoin":
			return rowSet(
				Arr.map(
					Arr.filter(pairs(c), ([l, r]) => allenHolds(l.during, q.mask, r.during)),
					([l, r]) => [g(l), spanText(l.during), spanText(r.during)]
				)
			)
		case "pointIn":
			return rowSet(
				Arr.map(
					Arr.filter(
						c.facts[q.relation],
						(fact) => fact.during.lo <= q.point.point && q.point.point < fact.during.hi
					),
					(fact) => [g(fact), spanText(fact.during)]
				)
			)
		case "intersection":
			return rowSet(
				Arr.flatMap(pairs(c), ([l, r]) =>
					Arr.map(spanIntersection(l.during, r.during), (p) => [g(l), spanText(p)])
				)
			)
		case "difference":
			return rowSet(
				Arr.flatMap(pairs(c), ([l, r]) =>
					Arr.map(spanDifference(l.during, r.during), (p) => [g(l), spanText(p)])
				)
			)
		case "pack":
			return rowSet(
				Arr.flatMap([...groupsOf(c.facts[q.relation])], ([group, spans]) =>
					Arr.map(spanPack(spans), (p) => [String(group), spanText(p)])
				)
			)
	}
}

const q = (name: string): string => `"${Str.replaceAll('"', '""')(name)}"`

/** The table of a relation, by the installer's identifier mapping (Left -> left). */
const spanTableName = (relation: SpanRelationName): string => Str.toLowerCase(relation)

const table = (schema: string, relation: SpanRelationName): string =>
	`${q(schema)}.${q(spanTableName(relation))}`

/**
 * The statements a span schema's PostgreSQL schema holds: the Tick domain with its constraint, and the tables of its two
 * relations: NOT NULL columns, the span shape CHECK, the Tick endpoint checks with lower() and upper() substituted for
 * VALUE, and the primary key, WITHOUT OVERLAPS on the span of a span key. The reference names its own objects, without
 * the naming rule's markers: nothing compares them with grizzle's.
 */
const spanSchemaStatements = (schema: string, spans: SpanSchema): ReadonlyArray<string> => [
	`CREATE DOMAIN ${q(schema)}.${q("tick")} AS int8 CONSTRAINT ${q("tick_check")} CHECK ((VALUE >= '${tickContract.low}'::int8) IS TRUE)`,
	...Arr.map(spanRelationNames, (name) => {
		const relation = spans.relations[name]
		const t = spanTableName(name)
		const range = rangeTypeOf(spans.endpoint)
		const columns = [
			...(relation.spanKeyed ? [] : [`${q("id")} int4 NOT NULL`]),
			`${q("group")} int4 NOT NULL`,
			`${q("during")} ${range} NOT NULL`,
			`CONSTRAINT ${q(`${t}_during_shape`)} CHECK ((NOT isempty(${q("during")}) AND NOT lower_inf(${q("during")}) AND NOT upper_inf(${q("during")}) AND lower_inc(${q("during")}) AND NOT upper_inc(${q("during")})) IS TRUE)`,
			...(spans.endpoint === "contract"
				? [
						`CONSTRAINT ${q(`${t}_during_tick`)} CHECK ((lower(${q("during")}) >= '${tickContract.low}'::int8 AND upper(${q("during")}) >= '${tickContract.low}'::int8) IS TRUE)`
					]
				: []),
			relation.spanKeyed
				? `CONSTRAINT ${q(`${t}_key`)} PRIMARY KEY (${q("group")}, ${q("during")} WITHOUT OVERLAPS)`
				: `CONSTRAINT ${q(`${t}_key`)} PRIMARY KEY (${q("id")})`
		]
		return `CREATE TABLE ${table(schema, name)} (${Arr.join(columns, ", ")})`
	})
]

/** A value for each keying of a relation: span-keyed, or keyed by an integer id. */
interface ByKeying<A> {
	readonly spanKeyed: A
	readonly idKeyed: A
}

const keyingOf = (relation: SpanRelation): keyof ByKeying<unknown> =>
	relation.spanKeyed ? "spanKeyed" : "idKeyed"

/**
 * The PostgreSQL schema each span schema is installed under, by its endpoint and the keying of Left and then Right:
 * every span schema a case can have, each installed and committed once.
 */
type SpanInstallations = Readonly<Record<SpanEndpointKind, ByKeying<ByKeying<string>>>>

/**
 * Installs every span schema once, each under a schema of its own that the test's scope drops, after btree_gist,
 * which supplies the scalar components of a span key.
 */
export const installSpanSchemas = (
	db: RawSession,
	label: string
): Effect.Effect<SpanInstallations, SqlError, Scope.Scope | Substrate> =>
	Effect.gen(function* () {
		const s = yield* Substrate
		yield* db.query("CREATE EXTENSION IF NOT EXISTS btree_gist", [])
		const installed = (endpoint: SpanEndpointKind, left: boolean, right: boolean) =>
			Effect.gen(function* () {
				const schema = yield* s.schema({ ...freshSchema, label })
				const spans: SpanSchema = {
					endpoint,
					relations: {
						Left: { name: "Left", spanKeyed: left },
						Right: { name: "Right", spanKeyed: right }
					}
				}
				for (const statement of spanSchemaStatements(schema, spans)) {
					yield* db.query(statement, [])
				}
				return schema
			})
		const byKeying = <A, E, R>(
			f: (spanKeyed: boolean) => Effect.Effect<A, E, R>
		): Effect.Effect<ByKeying<A>, E, R> => Effect.all({ spanKeyed: f(true), idKeyed: f(false) })
		const ofEndpoint = (endpoint: SpanEndpointKind) =>
			byKeying((left) => byKeying((right) => installed(endpoint, left, right)))
		return yield* Effect.all({
			integer: ofEndpoint("integer"),
			bigint: ofEndpoint("bigint"),
			contract: ofEndpoint("contract"),
			date: ofEndpoint("date")
		} satisfies Record<SpanEndpointKind, unknown>)
	})

/** One INSERT of a list of facts through jsonb_to_recordset, with its one parameter. */
export const spanInsert = (
	schema: string,
	c: SpanCase,
	relation: SpanRelationName,
	facts: ReadonlyArray<SpanFact>
): { readonly sql: string; readonly params: ReadonlyArray<string> } => {
	const range = rangeTypeOf(c.schema.endpoint)
	const keyed = c.schema.relations[relation].spanKeyed
	const columns = keyed ? [q("group"), q("during")] : [q("id"), q("group"), q("during")]
	const values = keyed ? ["j.g", `j.d::${range}`] : ["j.id", "j.g", `j.d::${range}`]
	return {
		sql: `INSERT INTO ${table(schema, relation)} (${Arr.join(columns, ", ")}) SELECT ${Arr.join(values, ", ")} FROM jsonb_to_recordset($1::text::jsonb) AS j(id int4, g int4, d text)`,
		params: [
			jsonText(
				Arr.map(facts, (f) => ({
					id: f.id,
					g: f.group,
					d: spanTextOf(c.schema.endpoint)(f.during)
				}))
			)
		]
	}
}

/**
 * `body` run on `db` with the PostgreSQL schema the case's span schema is installed under, inside one transaction that
 * stores the case's facts and is rolled back however `body` ends, so every case starts from empty tables.
 */
export const inSpanCase = <A, E, R>(
	db: RawSession,
	installations: SpanInstallations,
	c: SpanCase,
	body: (schema: string) => Effect.Effect<A, E, R>
): Effect.Effect<A, E | SqlError, R> => {
	const schema =
		installations[c.schema.endpoint][keyingOf(c.schema.relations.Left)][
			keyingOf(c.schema.relations.Right)
		]
	return Effect.gen(function* () {
		yield* db.begin
		return yield* Effect.gen(function* () {
			for (const name of spanRelationNames) {
				if (c.facts[name].length > 0) {
					const insert = spanInsert(schema, c, name, c.facts[name])
					yield* db.query(insert.sql, insert.params)
				}
			}
			return yield* body(schema)
		}).pipe(Effect.ensuring(Effect.ignore(db.rollback)))
	})
}

/**
 * The basic relation of (A, B) from the endpoints, bit 0 (before) to bit 12 (finishedBy), as a CASE over lower() and
 * upper(); 13, a bit no mask has, if no condition held. This is the oracle's classifier, never a
 * lowering: grizzle's own Allen predicates use the range operators only.
 */
const endpointClassifierSql = (a: string, b: string): string => {
	const a0 = `lower(${a})`
	const a1 = `upper(${a})`
	const b0 = `lower(${b})`
	const b1 = `upper(${b})`
	return `(CASE WHEN ${a1} < ${b0} THEN 0 WHEN ${a1} = ${b0} THEN 1 WHEN ${a0} < ${b0} AND ${b0} < ${a1} AND ${a1} < ${b1} THEN 2 WHEN ${a0} = ${b0} AND ${a1} < ${b1} THEN 3 WHEN ${b0} < ${a0} AND ${a1} < ${b1} THEN 4 WHEN ${b0} < ${a0} AND ${a1} = ${b1} THEN 5 WHEN ${a0} = ${b0} AND ${a1} = ${b1} THEN 6 WHEN ${b1} < ${a0} THEN 7 WHEN ${b1} = ${a0} THEN 8 WHEN ${b0} < ${a0} AND ${a0} < ${b1} AND ${b1} < ${a1} THEN 9 WHEN ${b0} = ${a0} AND ${b1} < ${a1} THEN 10 WHEN ${a0} < ${b0} AND ${b1} < ${a1} THEN 11 WHEN ${a0} < ${b0} AND ${b1} = ${a1} THEN 12 ELSE 13 END)`
}

const maskTest = (mask: number, a: string, b: string): string =>
	`((${mask}::int4 >> ${endpointClassifierSql(a, b)}) & 1) = 1`

/**
 * How a mask is evaluated in the handwritten SQL: the oracle's endpoint classifier, or a predicate supplied by the
 * caller over the two span column references (the shipped table's formula, for instance).
 */
export type MaskPredicate = (
	mask: number,
	left: { table: string; column: string },
	right: { table: string; column: string }
) => string

/** The mask predicate of the span pair's own endpoints (maskTest). */
export const endpointMaskPredicate = (
	mask: number,
	left: { table: string; column: string },
	right: { table: string; column: string }
): string =>
	maskTest(mask, `${q(left.table)}.${q(left.column)}`, `${q(right.table)}.${q(right.column)}`)

/**
 * The handwritten SQL that evaluates the case's query on the installed tables, with its parameters as text. The
 * columns are cast to text in heading order; the rows are compared as a set.
 */
export const referenceSql = (
	schema: string,
	c: SpanCase,
	mask: MaskPredicate
): { readonly sql: string; readonly params: ReadonlyArray<string> } => {
	const query = c.query
	const range = rangeTypeOf(c.schema.endpoint)
	const point = endpointSqlType(c.schema.endpoint)
	const left = table(schema, "Left")
	const right = table(schema, "Right")
	const g = (alias: string) => `${q(alias)}.${q("group")}`
	const d = (alias: string) => `${q(alias)}.${q("during")}`
	const pairFrom = `${left} AS ${q("l")} JOIN ${right} AS ${q("r")} ON ${g("r")} = ${g("l")}`
	switch (query.kind) {
		case "allenFilter":
			return {
				sql: `SELECT DISTINCT ${g("l")}::text, ${d("l")}::text FROM ${table(schema, query.relation)} AS ${q("l")} CROSS JOIN (SELECT $1::text::${range}) AS ${q("w")}(${q("v")}) WHERE ${mask(query.mask, { table: "l", column: "during" }, { table: "w", column: "v" })}`,
				params: [spanTextOf(c.schema.endpoint)(query.window.span)]
			}
		case "allenJoin":
			return {
				sql: `SELECT DISTINCT ${g("l")}::text, ${d("l")}::text, ${d("r")}::text FROM ${pairFrom} WHERE ${mask(query.mask, { table: "l", column: "during" }, { table: "r", column: "during" })}`,
				params: []
			}
		case "pointIn":
			return {
				sql: `SELECT DISTINCT ${g("l")}::text, ${d("l")}::text FROM ${table(schema, query.relation)} AS ${q("l")} WHERE ${d("l")} @> $1::text::${point}`,
				params: [pointTextOf(c.schema.endpoint)(query.point.point)]
			}
		case "intersection":
			return {
				sql: `SELECT DISTINCT ${g("l")}::text, (${d("l")} * ${d("r")})::text FROM ${pairFrom} WHERE ${d("l")} && ${d("r")}`,
				params: []
			}
		case "difference":
			return {
				sql: `SELECT DISTINCT ${g("l")}::text, ${q("p")}.${q("piece")}::text FROM ${pairFrom} CROSS JOIN LATERAL range_minus_multi(${d("l")}, ${d("r")}) AS ${q("p")}(${q("piece")})`,
				params: []
			}
		case "pack":
			return {
				sql: `SELECT ${q("x")}.${q("g")}::text, ${q("u")}.${q("piece")}::text FROM (SELECT ${g("l")}, range_agg(${d("l")}) FROM ${table(schema, query.relation)} AS ${q("l")} GROUP BY ${g("l")}) AS ${q("x")}(${q("g")}, ${q("m")}) CROSS JOIN LATERAL unnest(${q("x")}.${q("m")}) AS ${q("u")}(${q("piece")})`,
				params: []
			}
	}
}

const queryText = (endpoint: SpanEndpointKind, query: SpanQuery): string => {
	switch (query.kind) {
		case "allenFilter":
			return `${query.relation} where allen(during, ${query.mask}, ${query.window.kind} ${spanTextOf(endpoint)(query.window.span)})`
		case "allenJoin":
			return `Left x Right where allen(left, ${query.mask}, right)`
		case "pointIn":
			return `${query.relation} where pointIn(${query.point.kind} ${pointTextOf(endpoint)(query.point.point)}, during)`
		case "pack":
			return `pack(${query.relation}.during) by group`
		case "difference":
		case "intersection":
			return query.kind
	}
}

export const printSpanCase = (c: SpanCase): string =>
	Arr.join(
		[
			`endpoint ${c.schema.endpoint}`,
			...Arr.map(
				spanRelationNames,
				(name) =>
					`${name}${c.schema.relations[name].spanKeyed ? " (group, during WITHOUT OVERLAPS)" : " (id)"}: ${Arr.join(
						Arr.map(
							c.facts[name],
							(f) =>
								`${c.schema.relations[name].spanKeyed ? "" : `#${f.id} `}${f.group} ${spanTextOf(c.schema.endpoint)(f.during)}`
						),
						"; "
					)}`
			),
			`query ${queryText(c.schema.endpoint, c.query)}`
		],
		"\n"
	)
