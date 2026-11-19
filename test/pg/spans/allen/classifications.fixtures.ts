/** What the properties of classifications.test.ts read: its spaces, models and helpers. */

import { defined, nonEmpty } from "@bjornpagen/testing/assert"
import { type Situations } from "@bjornpagen/testing/features"
import { element, type Gen, int } from "@bjornpagen/testing/gen"
import { exact, ordered } from "@bjornpagen/testing/oracle"
import { Array as Arr, Effect, Option, Order, Predicate, Record as Rec } from "effect"
import { fullAllenMask } from "#compiler/allen/mask.ts"
import { type AllenRelation, allenRelations } from "#compiler/core/allen.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import { jsonText } from "#compiler/core/trusted.ts"
import { ALLEN } from "#compiler/public/allen.ts"
import { contract, pg, span } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import {
	compileSpanQuery,
	compileSpans,
	rowsAs,
	runArtifact
} from "#test/pg/spans/allen/support.ts"
import { templateNamed } from "#test/support/install-migrate.ts"
import {
	classify,
	type HalfOpen,
	type RangeType,
	rangeLimits,
	rangeTypes,
	relationBit,
	spanText,
	spellingText,
	universe,
	universeSpellings
} from "#test/support/oracle/allen.ts"
import { type ScriptInstall, filledScriptTemplate } from "#test/support/script-template.ts"
import { type RawSession } from "#test/support/substrate/session.ts"
import { Substrate, worldSession, type SubstrateCase } from "#test/support/substrate/substrate.ts"

/** Text rows in one total order: cell by cell, a row before every longer row it begins. */
export const rowOrder: Order.Order<ReadonlyArray<string>> = Order.Array(Order.String)

const Instant = contract("Instant", pg.bigint)

const U4 = relation("U4", { id: pg.integer, s: span(pg.integer) }, ["id"])

const U8 = relation("U8", { id: pg.integer, s: span(pg.bigint) }, ["id"])

const P4 = relation("P4", { p: pg.integer }, ["p"])

const P8 = relation("P8", { p: pg.bigint }, ["p"])

const Stay = relation("Stay", { id: pg.integer, stay: span(Instant) }, ["id"])

const Moment = relation("Moment", { at: Instant }, ["at"])

const Universe = schema("Universe", [U4, U8, P4, P8, Stay, Moment], [])

/** The pairs of stored spans in a mask's relations, over the relation of each range type. */
const pairQuery = (type: RangeType, mask: number) =>
	type === "int4range"
		? query(Universe).rule((r) => {
				const { s } = v(U4, "u4")
				const { s: theirs } = v(U4, "theirs")
				return r
					.match(U4, { s })
					.match(U4, { s: theirs })
					.where(r.allen(s, mask, theirs))
					.find({ s, theirs })
			})
		: query(Universe).rule((r) => {
				const { s } = v(U8, "u8")
				const { s: theirs } = v(U8, "theirs")
				return r
					.match(U8, { s })
					.match(U8, { s: theirs })
					.where(r.allen(s, mask, theirs))
					.find({ s, theirs })
			})

/** The stored spans and the stored points they contain. */
const pointQuery = (type: RangeType) =>
	type === "int4range"
		? query(Universe).rule((r) => {
				const { s } = v(U4, "u4")
				const { p } = v(P4, "p4")
				return r.match(U4, { s }).match(P4, { p }).where(r.pointIn(p, s)).find({ s, p })
			})
		: query(Universe).rule((r) => {
				const { s } = v(U8, "u8")
				const { p } = v(P8, "p8")
				return r.match(U8, { s }).match(P8, { p }).where(r.pointIn(p, s)).find({ s, p })
			})

const contractPointQuery = query(Universe).rule((r) => {
	const { stay } = v(Stay, "stay")
	const { at } = v(Moment, "moment")
	return r.match(Stay, { stay }).match(Moment, { at }).where(r.pointIn(at, stay)).find({ stay, at })
})

/** The stored points inside a window parameter, which takes its type from the point. */
const windowQuery = (type: RangeType) =>
	type === "int4range"
		? query(Universe).rule((r) => {
				const { p } = v(P4, "p4")
				return r
					.match(P4, { p })
					.where(r.pointIn(p, r.param("window", span(pg.integer))))
					.find({ p })
			})
		: query(Universe).rule((r) => {
				const { p } = v(P8, "p8")
				return r
					.match(P8, { p })
					.where(r.pointIn(p, r.param("window", span(pg.bigint))))
					.find({ p })
			})

const contractWindowQuery = query(Universe).rule((r) => {
	const { at } = v(Moment, "moment")
	return r
		.match(Moment, { at })
		.where(r.pointIn(at, r.param("window", span(Instant))))
		.find({ at })
})

/** Every mask ALLEN names: the basic relations and the named unions. */
const named = Object.freeze(Arr.filter(Rec.values({ ...ALLEN }), Predicate.isNumber))

/** The masks every run checks: every mask ALLEN names, each one's complement and converse, and the full mask. */
export const fixedMasks: Arr.NonEmptyReadonlyArray<number> = nonEmpty(
	Arr.dedupe([
		...named,
		...Arr.map(named, (m) => ALLEN.complement(m)),
		...Arr.map(named, (m) => ALLEN.converse(m)),
		fullAllenMask
	]),
	"the fixed masks"
)

/** What an explored mask reaches: each basic relation it includes. */
export type MaskFeature = `includes ${AllenRelation}`

/**
 * Two answers' rows, each deduplicated and in rowOrder, which rowsAs gives an answer and the classifier's are by
 * construction: equal in order exactly when they are the same set, compared in one pass.
 */
const sameSortedRows = ordered(ordered(exact))

/**
 * How one mask's pair query departs from the brute-force classifier over the stored spans of one range type, in both
 * artifacts: a repeated row in either answer, or another set of pairs.
 */
export const checkMask = (
	installed: ScriptInstall,
	reader: RawSession,
	type: RangeType,
	mask: number
) =>
	Effect.gen(function* () {
		const spans = universe(type)
		/** In rowsAs's order, each pair once. */
		const expected = Arr.sort(
			Arr.flatMap(spans, (a: HalfOpen) =>
				Arr.flatMap(spans, (b: HalfOpen) =>
					(mask & (1 << relationBit(classify(a, b)))) !== 0 ? [[spanText(a), spanText(b)]] : []
				)
			),
			rowOrder
		)
		const failures: Array<string> = []
		const template = compileSpanQuery(pairQuery(type, mask), installed.schema)
		for (const artifact of ["optimized", "conservative"] as const) {
			const spec = template[artifact][0]
			if (spec === undefined || template[artifact].length !== 1) {
				throw new Error("one statement per artifact")
			}
			const [rows] = yield* runArtifact(reader, template, artifact, {})
			const got = rowsAs(spec, rows ?? [], ["s", "theirs"])
			if (got.repeats > 0) {
				failures.push(`${type} ${mask} ${artifact}: ${got.repeats} repeated rows`)
			}
			const difference = sameSortedRows(got.rows, expected)
			if (Option.isSome(difference)) {
				failures.push(`${type} mask ${mask} (${artifact}): ${difference.value}`)
			}
		}
		return failures
	})

const pointsOf = (type: RangeType): ReadonlyArray<bigint> => {
	const { min, max } = rangeLimits[type]
	const out: Array<bigint> = []
	for (let p = -5n; p <= 10n; p++) {
		out.push(p)
	}
	out.push(min, min + 1n, max - 1n, max, rangeLimits.int4range.max - 1n, rangeLimits.int4range.max)
	return [...new Set(out)]
}

/** A pointIn window's relation: P4's int4 points, P8's int8 points, or Moment's contract points over int8. */
type WindowType = RangeType | "contract"

export const windowTypes: Arr.NonEmptyReadonlyArray<WindowType> = [...rangeTypes, "contract"]

/** Where a window lies: from its type's lower limit, up to its upper limit, over one point, or inside both limits. */
export const windowEdges = [
	"from the lower limit",
	"to the upper limit",
	"one point",
	"inside"
] as const

type WindowEdge = (typeof windowEdges)[number]

export type WindowFeature = `${WindowType} window ${WindowEdge}`

export const windowLimits = (type: WindowType) =>
	rangeLimits[type === "contract" ? "int8range" : type]

/** The points stored in a window type's relation. */
export const windowPoints = (type: WindowType): ReadonlyArray<bigint> => {
	const { min, max } = windowLimits(type)
	return Arr.filter(pointsOf(type === "contract" ? "int8range" : type), (p) => p >= min && p <= max)
}

/** A window drawn as the edge it is planted at and two picks among the stored points. */
interface WindowSketch {
	readonly type: WindowType
	readonly edge: WindowEdge
	readonly a: number
	readonly b: number
}

export const windowSketchGen: Gen<WindowSketch> = (source) => ({
	type: source.draw(element(windowTypes)),
	edge: source.draw(element(windowEdges)),
	a: source.draw(int(0, 2 ** 31 - 1)),
	b: source.draw(int(0, 2 ** 31 - 1))
})

const pick = (from: ReadonlyArray<bigint>, i: number) =>
	defined(from[i % from.length], "a stored point")

/** The nonempty half-open window [lo, hi) a sketch plants: its ends are the limits or stored points between them. */
export const resolveWindow = (
	sketch: WindowSketch
): { readonly type: WindowType; readonly lo: bigint; readonly hi: bigint } => {
	const { type } = sketch
	const { min, max } = windowLimits(type)
	const inner = Arr.filter(windowPoints(type), (p) => p > min && p < max)
	switch (sketch.edge) {
		case "from the lower limit":
			return { type, lo: min, hi: pick([...inner, max], sketch.a) }
		case "to the upper limit":
			return { type, lo: pick([min, ...inner], sketch.a), hi: max }
		case "one point": {
			const lo = pick([min, ...inner], sketch.a)
			return { type, lo, hi: lo + 1n }
		}
		case "inside": {
			const x = pick(inner, sketch.a)
			const y = pick(
				Arr.filter(inner, (p) => p !== x),
				sketch.b
			)
			return x < y ? { type, lo: x, hi: y } : { type, lo: y, hi: x }
		}
	}
}

/** The two artifacts every query compiles to. */
export const artifacts = ["optimized", "conservative"] as const

/** A pointIn check reached: its point relation's type, in one artifact. */
export type PointFeature = `${WindowType} ${(typeof artifacts)[number]}`

/**
 * The pointIn query of a point type over every stored span, and the pairs it must deliver: each span with each point
 * it contains. A contract point is compared as its base, the cast on the probe, never on the span.
 */
export const pointCase = (point: WindowType, installed: ScriptInstall) => {
	const type = point === "contract" ? "int8range" : point
	const spans = universe(type)
	const points =
		point === "contract"
			? pointsOf(type)
			: Arr.filter(pointsOf(type), (p) => p >= rangeLimits[type].min && p <= rangeLimits[type].max)
	const expected = Arr.sort(
		Arr.flatMap(spans, (span) =>
			Arr.flatMap(points, (p) => (span.lo <= p && p < span.hi ? [[spanText(span), String(p)]] : []))
		),
		rowOrder
	)
	return point === "contract"
		? {
				template: compileSpanQuery(contractPointQuery, installed.schema),
				columns: ["stay", "at"],
				expected
			}
		: {
				template: compileSpanQuery(pointQuery(point), installed.schema),
				columns: ["s", "p"],
				expected
			}
}

/**
 * The universe of stored spans and points installed and filled once per member: the template every case's seat clones.
 */
export const universeTemplate = filledScriptTemplate({
	declaredIn: import.meta,
	name: "allen",
	label: "allen",
	compile: (schema) => compileSpans(Universe, schema, { label: "allen", extensions: [] }),
	fill: (installed) =>
		Effect.gen(function* () {
			const s = yield* Substrate
			const table = (relation: string) => {
				const n = installed.installation.names.relation(relation)
				return `${quoteIdent(n.schema)}.${quoteIdent(n.name)}`
			}
			yield* Effect.forEach(
				rangeTypes,
				(type) =>
					Effect.gen(function* () {
						const spellings = universeSpellings(type)
						yield* s.admin.queryValues(
							`INSERT INTO ${table(type === "int4range" ? "U4" : "U8")} ("id", "s") SELECT j.id, j.t::${type} FROM jsonb_to_recordset($1::text::jsonb) AS j(id int4, t text)`,
							[jsonText(Arr.map(spellings, (spelling, id) => ({ id, t: spellingText(spelling) })))]
						)
						const points = Arr.filter(
							pointsOf(type),
							(p) => p >= rangeLimits[type].min && p <= rangeLimits[type].max
						)
						yield* s.admin.queryValues(
							`INSERT INTO ${table(type === "int4range" ? "P4" : "P8")} ("p") SELECT j.p::${type === "int4range" ? "int4" : "int8"} FROM jsonb_to_recordset($1::text::jsonb) AS j(p text)`,
							[jsonText(Arr.map(points, (p) => ({ p: String(p) })))]
						)
					}),
				{ discard: true }
			)
			yield* s.admin.queryValues(
				`INSERT INTO ${table("Stay")} ("id", "stay") SELECT j.id, j.t::int8range FROM jsonb_to_recordset($1::text::jsonb) AS j(id int4, t text)`,
				[jsonText(Arr.map(universe("int8range"), (span, id) => ({ id, t: spanText(span) })))]
			)
			yield* s.admin.queryValues(
				`INSERT INTO ${table("Moment")} ("at") SELECT j.p::int8 FROM jsonb_to_recordset($1::text::jsonb) AS j(p text)`,
				[jsonText(Arr.map(pointsOf("int8range"), (p) => ({ p: String(p) })))]
			)
		})
})

/** A case's installation over its seat of the universe, and the reader's session of its world there. */
export const universeIn = (taken: SubstrateCase<ScriptInstall>) =>
	Effect.provideService(
		Effect.map(
			Effect.flatMap(Substrate, (s) =>
				s.session({ ...worldSession(taken.value.world), label: "reader" })
			),
			(reader) => ({ installed: taken.value, reader })
		),
		Substrate,
		taken.substrate
	)

/** The window queries, compiled once per worker under the universe template's schema name. */
export const windowTemplates = templateNamed(
	"test/pg/spans/allen/classifications windowTemplates",
	universeTemplate,
	(names) => ({
		int4range: compileSpanQuery(windowQuery("int4range"), names.schema),
		int8range: compileSpanQuery(windowQuery("int8range"), names.schema),
		contract: compileSpanQuery(contractWindowQuery, names.schema)
	})
)

export const noteMask = (mask: number, c: { readonly note: (f: MaskFeature) => void }) => {
	for (const r of allenRelations) {
		if ((mask & (1 << relationBit(r))) !== 0) {
			c.note(`includes ${r}`)
		}
	}
}

export const maskFeatures: Situations<MaskFeature> = Arr.map(
	allenRelations,
	(r): MaskFeature => `includes ${r}`
)
