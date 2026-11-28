import { array, boolean, element, type Gen, int, map, oneOf } from "@bjornpagen/testing/gen"
import { Array as Arr, String as Str } from "effect"
import { ALLEN, fullAllenMask } from "#compiler/allen/mask.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import { jsonText } from "#compiler/core/trusted.ts"
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

import {
	type CalendarDate,
	dateOfDayNumber,
	dayNumber,
	lastCalendarDate
} from "#compiler/ir/date.ts"
import {
	classify,
	type HalfOpen,
	limitSpansWithin,
	rangeLimits,
	relationBit,
	type SpanLimits
} from "#test/support/oracle/allen.ts"
import { cyclicAt, elementAt } from "#test/support/oracle/pick.ts"

export const spanEndpointKinds = ["int4", "int8", "contract", "date"] as const
export type SpanEndpointKind = (typeof spanEndpointKinds)[number]

/** The range type of a span field: int4range, int8range or daterange. */
type SpanRangeType = "int4range" | "int8range" | "daterange"

/**
 * int4range for int4 endpoints, int8range for int8 and contracts over it, daterange for date endpoints.
 */
const rangeTypeOf = (endpoint: SpanEndpointKind): SpanRangeType => {
	switch (endpoint) {
		case "int4":
			return "int4range"
		case "int8":
		case "contract":
			return "int8range"
		case "date":
			return "daterange"
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
const endpointLimits = (endpoint: SpanEndpointKind): SpanLimits => {
	switch (endpoint) {
		case "int4":
			return rangeLimits.int4range
		case "int8":
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
const spanTextOf =
	(endpoint: SpanEndpointKind) =>
	(span: HalfOpen): string =>
		`[${pointTextOf(endpoint)(span.lo)},${pointTextOf(endpoint)(span.hi)})`

/**
 * The Tick contract: epoch-free ticks over bigint, no smaller than -100. Its predicate is the one
 * endpoint check a generated span carries.
 */
const tickContract = { name: "Tick", low: -100n } as const

const endpointFieldDesc = (endpoint: SpanEndpointKind): FieldDesc => {
	switch (endpoint) {
		case "int4":
			return { kind: "pg", type: "int4" }
		case "int8":
			return { kind: "pg", type: "int8" }
		case "date":
			return { kind: "pg", type: "date" }
		case "contract":
			return {
				kind: "contract",
				name: tickContract.name,
				base: { kind: "pg", type: "int8" },
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
 * The host value of an endpoint: a JavaScript integer for int4, a bigint for int8 and the Tick contract, the
 * CalendarDate of its day offset for a date.
 */
const endpointHost = (
	endpoint: SpanEndpointKind,
	value: bigint
): number | bigint | CalendarDate => {
	switch (endpoint) {
		case "int4":
			return Number(value)
		case "int8":
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
				field === "during" ? spanFieldDesc(schema.endpoint) : { kind: "pg", type: "int4" }
		}
		return storedRelation(relation.name, fields, spanPrimaryKey(relation))
	}
	return {
		name: spanSchemaName,
		relations: Arr.map(spanRelationNames, (name) => relationDesc(schema.relations[name])),
		statements: [],
		bases: []
	}
}

export interface SpanFact {
	/** Present on every fact; a column only of id-keyed relations. */
	readonly id: number
	readonly group: number
	readonly during: HalfOpen
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
const overlaps = (a: HalfOpen, b: HalfOpen): boolean => a.lo < b.hi && b.lo < a.hi

/** The facts of each relation, a span-keyed relation's row dropped where it overlaps a kept fact of its group. */
const resolveFacts = (
	schema: SpanSchema,
	sketch: Readonly<Record<SpanRelationName, ReadonlyArray<RowSketch>>>
): SpanFacts => {
	const resolve = (name: SpanRelationName): ReadonlyArray<SpanFact> => {
		const relation = schema.relations[name]
		const kept: Array<SpanFact> = []
		for (const [i, row] of sketch[name].entries()) {
			const fact: SpanFact = {
				id: i,
				group: row.group % spanGroups,
				during: resolveSpan(schema.endpoint, row.span)
			}
			if (
				!relation.spanKeyed ||
				!Arr.some(kept, (k) => k.group === fact.group && overlaps(k.during, fact.during))
			) {
				kept.push(fact)
			}
		}
		return kept
	}
	return { Left: resolve("Left"), Right: resolve("Right") }
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

const spanQueryKinds = ["allenFilter", "allenJoin", "pointIn"] as const

interface QuerySketch {
	readonly kind: number
	readonly relation: number
	readonly mask: number
	readonly literal: boolean
	readonly span: SpanSketch
	readonly point: PointSketch
}

const querySketchGen: Gen<QuerySketch> = (source) => ({
	kind: source.draw(int(0, spanQueryKinds.length - 1)),
	relation: source.draw(int(0, 1)),
	mask: source.draw(maskGen),
	literal: source.draw(boolean),
	span: source.draw(spanSketchGen),
	point: source.draw(pointSketchGen)
})

const resolveQuery = (endpoint: SpanEndpointKind, sketch: QuerySketch): SpanQuery => {
	const kind = cyclicAt(spanQueryKinds, sketch.kind, "the span query kinds")
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
 *   the endpoint classifier of test/support/oracle/allen.ts, never from the shipped mask table.
 *
 * The schema: two relations, Left and Right, each with a scalar `group` and a span
 * field `during` over int4, int8, the contract Tick over int8, or date. Each relation is
 * either span-keyed, primary key ["group", "during"], a pointwise nonoverlap rule per group, or keyed by
 * an integer `id`, so its facts overlap freely and repeat a (group, during) pair under different ids (facts
 * with different identities are distinct). The fact generator keeps a span-keyed relation lawful: a row that
 * overlaps a kept row of its group is dropped, while touching neighbours such as [9, 10) and [10, 11) are kept.
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
 * - pointIn: the facts whose span contains a point, a parameter or a literal (r.pointIn(t, during)).
 *
 * Every query keeps set semantics: the expected rows are a set, and adjacent stored facts are never coalesced.
 *
 * Everything is generated as a sketch of plain numbers resolved by pure functions, so every sketch is a valid case
 * and shrinking any number toward zero keeps it valid.
 */
export interface CaseOf<Q> {
	readonly schema: SpanSchema
	readonly facts: SpanFacts
	readonly query: Q
}

export type SpanCase = CaseOf<SpanQuery>

interface CaseSketch<S> {
	readonly endpoint: number
	readonly spanKeyed: readonly [boolean, boolean]
	readonly rows: Readonly<Record<SpanRelationName, ReadonlyArray<RowSketch>>>
	readonly query: S
}

/** The most facts a case stores in each relation. */
const maxRows = 6

const caseSketchGen =
	<S>(query: Gen<S>): Gen<CaseSketch<S>> =>
	(source) => {
		const rows = array(rowSketchGen, { min: 0, max: maxRows })
		return {
			endpoint: source.draw(int(0, spanEndpointKinds.length - 1)),
			spanKeyed: [source.draw(boolean), source.draw(boolean)],
			rows: { Left: source.draw(rows), Right: source.draw(rows) },
			query: source.draw(query)
		}
	}

/** A case's schema, its facts and its query, each resolved from its sketch, the query by `resolve`. */
const resolveCase =
	<S, Q>(resolve: (endpoint: SpanEndpointKind, sketch: S) => Q) =>
	(sketch: CaseSketch<S>): CaseOf<Q> => {
		const endpoint = cyclicAt(spanEndpointKinds, sketch.endpoint, "the range endpoints")
		const schema: SpanSchema = {
			endpoint,
			relations: {
				Left: { name: "Left", spanKeyed: sketch.spanKeyed[0] },
				Right: { name: "Right", spanKeyed: sketch.spanKeyed[1] }
			}
		}
		return {
			schema,
			facts: resolveFacts(schema, sketch.rows),
			query: resolve(endpoint, sketch.query)
		}
	}

export const spanCaseGen: Gen<SpanCase> = map(
	caseSketchGen(querySketchGen),
	resolveCase(resolveQuery)
)

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

/** The query as query(Spans).rule(...) records it. */
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
	}
}

/** Whether the pair's basic relation, by the endpoint classifier, is in the mask. */
const allenHolds = (a: HalfOpen, mask: number, b: HalfOpen): boolean =>
	(mask & (1 << relationBit(classify(a, b)))) !== 0

type RawRow = ReadonlyArray<string>

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
const rowSet = (rows: ReadonlyArray<RawRow>): ReadonlyArray<RawRow> =>
	Arr.dedupeAdjacentWith(Arr.sort(rows, rowOrder), (a, b) => rowOrder(a, b) === 0)

const pairs = (c: CaseOf<unknown>): ReadonlyArray<readonly [SpanFact, SpanFact]> =>
	Arr.flatMap(c.facts.Left, (l) =>
		Arr.map(
			Arr.filter(c.facts.Right, (r) => r.group === l.group),
			(r) => [l, r] as const
		)
	)

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
	}
}
/** The table of a relation, by the installer's identifier mapping (Left -> left). */
const spanTableName = (relation: SpanRelationName): string => Str.toLowerCase(relation)

const table = (schema: string, relation: SpanRelationName): string =>
	`${quoteIdent(schema)}.${quoteIdent(spanTableName(relation))}`

/** How a relation of a span schema is keyed: by its span, or by an integer id. */
export type Keying = "span" | "id"

const keyingOf = (relation: SpanRelation): Keying => (relation.spanKeyed ? "span" : "id")

/** A span schema a case can have, by its endpoint and the keying of Left and then Right. */
export type SpanVariant = `${SpanEndpointKind} ${Keying} ${Keying}`

/** The span schema of a case: its variant (SpanVariant). */
export const spanVariantOf = (c: { readonly schema: SpanSchema }): SpanVariant =>
	`${c.schema.endpoint} ${keyingOf(c.schema.relations.Left)} ${keyingOf(c.schema.relations.Right)}`

/** A value for every span schema a case can have, by its variant, `make` given its endpoint and keyings. */
export const bySpanVariant = <A>(
	make: (endpoint: SpanEndpointKind, left: Keying, right: Keying) => A
): Readonly<Record<SpanVariant, A>> => ({
	"int4 span span": make("int4", "span", "span"),
	"int4 span id": make("int4", "span", "id"),
	"int4 id span": make("int4", "id", "span"),
	"int4 id id": make("int4", "id", "id"),
	"int8 span span": make("int8", "span", "span"),
	"int8 span id": make("int8", "span", "id"),
	"int8 id span": make("int8", "id", "span"),
	"int8 id id": make("int8", "id", "id"),
	"contract span span": make("contract", "span", "span"),
	"contract span id": make("contract", "span", "id"),
	"contract id span": make("contract", "id", "span"),
	"contract id id": make("contract", "id", "id"),
	"date span span": make("date", "span", "span"),
	"date span id": make("date", "span", "id"),
	"date id span": make("date", "id", "span"),
	"date id id": make("date", "id", "id")
})

/** One INSERT of a list of facts through jsonb_to_recordset, with its one parameter. */
export const spanInsert = (
	schema: string,
	c: { readonly schema: SpanSchema },
	relation: SpanRelationName,
	facts: ReadonlyArray<SpanFact>
): { readonly sql: string; readonly params: ReadonlyArray<string> } => {
	const range = rangeTypeOf(c.schema.endpoint)
	const keyed = c.schema.relations[relation].spanKeyed
	const columns = keyed
		? [quoteIdent("group"), quoteIdent("during")]
		: [quoteIdent("id"), quoteIdent("group"), quoteIdent("during")]
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

const queryText = (endpoint: SpanEndpointKind, query: SpanQuery): string => {
	switch (query.kind) {
		case "allenFilter":
			return `${query.relation} where allen(during, ${query.mask}, ${query.window.kind} ${spanTextOf(endpoint)(query.window.span)})`
		case "allenJoin":
			return `Left x Right where allen(left, ${query.mask}, right)`
		case "pointIn":
			return `${query.relation} where pointIn(${query.point.kind} ${pointTextOf(endpoint)(query.point.point)}, during)`
	}
}

/** A case's endpoint and each relation's keying and facts, a line each. */
const factsText = (c: CaseOf<unknown>): string =>
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
			)
		],
		"\n"
	)

export const printSpanCase = (c: SpanCase): string =>
	Arr.join([factsText(c), `query ${queryText(c.schema.endpoint, c.query)}`], "\n")

/**
 * A range from its ends (r.range): over a Left and a Right fact of one group, from the Left span's start to the Right
 * span's end (`join`); or over one relation's facts, from each span's start to a point, a parameter or a literal of the
 * endpoint's type, a typed constant (`to`). Each yields a fact where its start lies before its end and none elsewhere, so
 * it reaches the empty and the reversed pair as often as the nonempty one.
 */
export type EndsQuery =
	| { readonly kind: "join" }
	| { readonly kind: "to"; readonly relation: SpanRelationName; readonly end: PointOperand }

export type EndsCase = CaseOf<EndsQuery>

interface EndsSketch {
	readonly join: boolean
	readonly relation: number
	readonly literal: boolean
	readonly point: PointSketch
}

const endsSketchGen: Gen<EndsSketch> = (source) => ({
	join: source.draw(boolean),
	relation: source.draw(int(0, 1)),
	literal: source.draw(boolean),
	point: source.draw(pointSketchGen)
})

const resolveEnds = (endpoint: SpanEndpointKind, sketch: EndsSketch): EndsQuery =>
	sketch.join
		? { kind: "join" }
		: {
				kind: "to",
				relation: elementAt(spanRelationNames, sketch.relation % 2, "the span relation names"),
				end: {
					kind: sketch.literal ? "literal" : "param",
					point: resolvePoint(endpoint, sketch.point)
				}
			}

export const endsCaseGen: Gen<EndsCase> = map(
	caseSketchGen(endsSketchGen),
	resolveCase(resolveEnds)
)

/** r.range(lower(start), end), the endpoint descriptor reading the span's ends. */
const endsHead = (start: ExprDesc, end: ExprDesc): HeadTermDesc => ({
	kind: "producer",
	fn: "span",
	args: [{ kind: "compute", fn: "lower", args: [start] }, end]
})

/** The query as query(Spans).rule(...) records it, its span produced from its ends (EndsQuery). */
export const endsQueryDesc = (c: EndsCase): QueryDesc => {
	const q = c.query
	switch (q.kind) {
		case "join":
			return rules(
				pairRule([], {
					group: variable("g"),
					left: variable("a"),
					right: variable("b"),
					span: endsHead(variable("a"), { kind: "compute", fn: "upper", args: [variable("b")] })
				})
			)
		case "to":
			return rules(
				oneRelationRule(q.relation, [], {
					group: variable("g"),
					during: variable("s"),
					span: endsHead(
						variable("s"),
						q.end.kind === "param"
							? { kind: "param", name: "end", type: endpointFieldDesc(c.schema.endpoint) }
							: {
									kind: "literal",
									value: endpointHost(c.schema.endpoint, q.end.point),
									type: endpointFieldDesc(c.schema.endpoint)
								}
					)
				})
			)
	}
}

/** The parameter values an ends query binds, as host values. */
export const endsQueryParams = (c: EndsCase): Readonly<Record<string, unknown>> =>
	c.query.kind === "to" && c.query.end.kind === "param"
		? { end: endpointHost(c.schema.endpoint, c.query.end.point) }
		: {}

/** An ends query's output heading, in order. */
export const endsQueryHeading = (q: EndsQuery): ReadonlyArray<string> =>
	q.kind === "join" ? ["group", "left", "right", "span"] : ["group", "during", "span"]

/** The span from `start` to `end`, start included and end excluded, where the start lies before the end. */
const spanFrom = (start: bigint, end: bigint): ReadonlyArray<HalfOpen> =>
	start < end ? [{ lo: start, hi: end }] : []

/**
 * The expected rows of an ends query, as raw text in heading order: each binding's span from its ends, [start, end)
 * where its start lies before its end, and no row for a binding whose end does not. A set, in a fixed order.
 */
export const endsReferenceRows = (c: EndsCase): ReadonlyArray<RawRow> => {
	const q = c.query
	const spanText = spanTextOf(c.schema.endpoint)
	switch (q.kind) {
		case "join":
			return rowSet(
				Arr.flatMap(pairs(c), ([l, r]) =>
					Arr.map(spanFrom(l.during.lo, r.during.hi), (span) => [
						String(l.group),
						spanText(l.during),
						spanText(r.during),
						spanText(span)
					])
				)
			)
		case "to":
			return rowSet(
				Arr.flatMap(c.facts[q.relation], (fact) =>
					Arr.map(spanFrom(fact.during.lo, q.end.point), (span) => [
						String(fact.group),
						spanText(fact.during),
						spanText(span)
					])
				)
			)
	}
}

/** An ends case, for a report. */
export const printEndsCase = (c: EndsCase): string =>
	Arr.join(
		[
			factsText(c),
			c.query.kind === "join"
				? "query Left x Right find span(lower(left), upper(right))"
				: `query ${c.query.relation} find span(lower(during), ${c.query.end.kind} ${pointTextOf(c.schema.endpoint)(c.query.end.point)})`
		],
		"\n"
	)
