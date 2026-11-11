/**
 * Allen masks and pointIn on stored spans, against PostgreSQL 19, in both artifacts (optimized and conservative).
 *
 * The universe's every spelling is stored in a relation of each range type, and points around the window and at the
 * limits beside them. Properties:
 *
 * - every mask ALLEN names, its complement and converse, and the full mask, exhausted, and drawn masks searched: a pair
 *   query's answer holds each pair of stored spans once, exactly the pairs the brute-force classifier relates by a
 *   relation in the mask;
 * - pointIn over every stored span and point, exhausted over the point's type (int4, int8, a contract over int8) and
 *   the artifact: exactly the pairs whose span contains the point, half-open;
 * - a pointIn window parameter, drawn at each limit, over one point and inside, binds as the point's base range type:
 *   exactly the stored points inside it.
 *
 * Features: every basic relation a mask includes; each point type in each artifact; each window type at each edge.
 *
 * Plants (~/.cache/grizzle-release/BR13/plants): allen-table-meets-swapped.patch, classifications-point-in-closed.patch
 * (pointIn lowered as a closed containment, lo <= p <= hi).
 */
import { layer } from "@effect/vitest"
import { drawn, exhaust, explore } from "@grizzle/testing/explore"
import { required, requiredInSpace, type Situations } from "@grizzle/testing/features"
import { element, type Gen, int } from "@grizzle/testing/gen"
import { exact, ordered } from "@grizzle/testing/oracle"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Order, Predicate, Record as Rec } from "effect"
import { fullAllenMask } from "#compiler/allen/mask.ts"
import { type AllenRelation, allenRelations } from "#compiler/core/allen.ts"
import { jsonText } from "#compiler/core/trusted.ts"
import { ALLEN } from "#compiler/public/allen.ts"
import { contract, pg, span } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { quoteIdent } from "#compiler/sql/print.ts"
import {
	compileSpanQuery,
	type InstalledSpans,
	installSpans,
	rowsAs,
	runArtifact
} from "#test/pg/spans/allen/support.ts"
import { assert, defined, nonEmpty } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
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
import type { RawSession } from "#test/support/substrate/session.ts"
import { Substrate, worldSession } from "#test/support/substrate/substrate.ts"

/** Text rows in one total order: cell by cell, a row before every longer row it begins. */
const rowOrder: Order.Order<ReadonlyArray<string>> = Order.Array(Order.String)

const Instant = contract("Instant", pg.bigint)
const U4 = relation("U4", { id: pg.integer, s: span(pg.integer) }, ["id"])
const U8 = relation("U8", { id: pg.integer, s: span(pg.bigint) }, ["id"])
const P4 = relation("P4", { p: pg.integer }, ["p"])
const P8 = relation("P8", { p: pg.bigint }, ["p"])
const Stay = relation("Stay", { id: pg.integer, stay: span(Instant) }, ["id"])
const Moment = relation("Moment", { at: Instant }, ["at"])
const Universe = schema("Universe", { U4, U8, P4, P8, Stay, Moment }, [])

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
const named = Arr.filter(Rec.values({ ...ALLEN }), Predicate.isNumber)
/** The masks every run checks: every mask ALLEN names, each one's complement and converse, and the full mask. */
const fixedMasks: Arr.NonEmptyReadonlyArray<number> = nonEmpty(
	Arr.dedupe([
		...named,
		...Arr.map(named, (m) => ALLEN.complement(m)),
		...Arr.map(named, (m) => ALLEN.converse(m)),
		fullAllenMask
	]),
	"the fixed masks"
)

/** What an explored mask reaches: each basic relation it includes. */
type MaskFeature = `includes ${AllenRelation}`

/**
 * Two answers' rows, each deduplicated and in rowOrder, which rowsAs gives an answer and the classifier's are by
 * construction: equal in order exactly when they are the same set, compared in one pass.
 */
const sameSortedRows = ordered(ordered(exact))

/**
 * How one mask's pair query departs from the brute-force classifier over the stored spans of one range type, in both
 * artifacts: a repeated row in either answer, or another set of pairs.
 */
const checkMask = (installed: InstalledSpans, reader: RawSession, type: RangeType, mask: number) =>
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
const windowTypes: Arr.NonEmptyReadonlyArray<WindowType> = [...rangeTypes, "contract"]
/** Where a window lies: from its type's lower limit, up to its upper limit, over one point, or inside both limits. */
const windowEdges = ["from the lower limit", "to the upper limit", "one point", "inside"] as const
type WindowEdge = (typeof windowEdges)[number]
type WindowFeature = `${WindowType} window ${WindowEdge}`

const windowLimits = (type: WindowType) => rangeLimits[type === "contract" ? "int8range" : type]

/** The points stored in a window type's relation. */
const windowPoints = (type: WindowType): ReadonlyArray<bigint> => {
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

const windowSketchGen: Gen<WindowSketch> = (source) => ({
	type: source.draw(element(windowTypes)),
	edge: source.draw(element(windowEdges)),
	a: source.draw(int(0, 2 ** 31 - 1)),
	b: source.draw(int(0, 2 ** 31 - 1))
})

const pick = (from: ReadonlyArray<bigint>, i: number) =>
	defined(from[i % from.length], "a stored point")

/** The nonempty half-open window [lo, hi) a sketch plants: its ends are the limits or stored points between them. */
const resolveWindow = (
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
const artifacts = ["optimized", "conservative"] as const

/** A pointIn check reached: its point relation's type, in one artifact. */
type PointFeature = `${WindowType} ${(typeof artifacts)[number]}`

/**
 * The pointIn query of a point type over every stored span, and the pairs it must deliver: each span with each point
 * it contains. A contract point is compared as its base, the cast on the probe, never on the span.
 */
const pointCase = (point: WindowType, installed: InstalledSpans) => {
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

layer(Substrate.layer)("Allen masks and pointIn on stored spans", (it) => {
	const setup = Effect.gen(function* () {
		const s = yield* Substrate
		const installed = yield* installSpans(Universe, { label: "allen", extensions: [] })
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
		const reader = yield* s.session({ ...worldSession(installed.world), label: "reader" })
		return { installed, reader, table }
	})

	it.effect(
		"matches the brute-force classifier for every basic relation, named mask, complement, converse and explored mask",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const { installed, reader } = yield* setup
					const noteMask = (mask: number, c: { readonly note: (f: MaskFeature) => void }) => {
						for (const r of allenRelations) {
							if ((mask & (1 << relationBit(r))) !== 0) {
								c.note(`includes ${r}`)
							}
						}
					}
					const maskFeatures: Situations<MaskFeature> = Arr.map(
						allenRelations,
						(r): MaskFeature => `includes ${r}`
					)
					yield* exhaust(
						{
							box: "both range types, by every mask ALLEN names, its complement and converse, and the full mask",
							oracle: {
								kind: "second-implementation",
								name: "the brute-force Allen classifier over the stored universe's pairs"
							},
							suite: "spans/allen-fixed-masks",
							generator: (source) => ({
								type: source.draw(element(rangeTypes)),
								mask: source.draw(element(fixedMasks))
							}),
							literal: Formatter.format,
							limit: rangeTypes.length * fixedMasks.length,
							coverage: requiredInSpace<MaskFeature>(maskFeatures),
							caseHang
						},
						({ type, mask }, c) =>
							Effect.gen(function* () {
								noteMask(mask, c)
								const maskFaults = yield* checkMask(installed, reader, type, mask)
								assert.deepEqual(maskFaults, [])
							})
					)
					return yield* explore(
						{
							oracle: {
								kind: "second-implementation",
								name: "the brute-force Allen classifier over the stored universe's pairs"
							},
							suite: "spans/allen-masks",
							draw: drawn(int(1, fullAllenMask)),
							literal: Formatter.format,
							coverage: required<MaskFeature>(maskFeatures, { cases: 24, sense: notesOnly }),
							kept: [],
							runs: 24,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							caseHang
						},
						(mask, c) =>
							Effect.gen(function* () {
								noteMask(mask, c)
								for (const type of rangeTypes) {
									const maskFaults = yield* checkMask(installed, reader, type, mask)
									assert.deepEqual(maskFaults, [])
								}
							})
					)
				})
			)
	)

	it.effect(
		"matches pointIn for every stored span and every point around the window and at the limits",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const { installed, reader } = yield* setup
					return yield* exhaust(
						{
							box: "every point relation's type, in both artifacts",
							oracle: {
								kind: "specification",
								name: "pointIn as half-open containment, lo <= p < hi, over every stored span and point"
							},
							suite: "spans/allen-point-in",
							generator: (source) => ({
								point: source.draw(element(windowTypes)),
								artifact: source.draw(element(artifacts))
							}),
							literal: Formatter.format,
							limit: windowTypes.length * artifacts.length,
							coverage: requiredInSpace<PointFeature>(
								Arr.flatMap(windowTypes, (point) =>
									Arr.map(artifacts, (artifact): PointFeature => `${point} ${artifact}`)
								)
							),
							caseHang
						},
						({ point, artifact }, c) =>
							Effect.gen(function* () {
								c.note(`${point} ${artifact}`)
								const { template, columns, expected } = pointCase(point, installed)
								const spec = defined(template[artifact][0], "a statement")
								const [rows] = yield* runArtifact(reader, template, artifact, {})
								assert.deepEqual(rowsAs(spec, rows ?? [], columns).rows, expected)
							})
					)
				})
			)
	)

	it.effect(
		"binds a pointIn window parameter as the point's base range type, for every window the search draws",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const { installed, reader } = yield* setup
					const templates = {
						int4range: compileSpanQuery(windowQuery("int4range"), installed.schema),
						int8range: compileSpanQuery(windowQuery("int8range"), installed.schema),
						contract: compileSpanQuery(contractWindowQuery, installed.schema)
					}
					return yield* explore(
						{
							oracle: {
								kind: "specification",
								name: "the stored points inside the half-open window, lo <= p < hi"
							},
							suite: "spans/allen-window",
							draw: drawn(windowSketchGen),
							literal: Formatter.format,
							coverage: required<WindowFeature>(
								Arr.flatMap(windowTypes, (type) =>
									Arr.map(windowEdges, (edge): WindowFeature => `${type} window ${edge}`)
								),
								{ cases: 48, sense: notesOnly }
							),
							kept: [],
							runs: 48,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							caseHang
						},
						(sketch, c) =>
							Effect.gen(function* () {
								const { type, lo, hi } = resolveWindow(sketch)
								const { min, max } = windowLimits(type)
								if (lo === min) {
									c.note(`${type} window from the lower limit`)
								}
								if (hi === max) {
									c.note(`${type} window to the upper limit`)
								}
								if (hi - lo === 1n) {
									c.note(`${type} window one point`)
								}
								if (lo > min && hi < max) {
									c.note(`${type} window inside`)
								}
								const at = (n: bigint) => (type === "int4range" ? Number(n) : n)
								const expected = Arr.sort(
									Arr.map(
										Arr.filter(windowPoints(type), (p) => lo <= p && p < hi),
										(p) => [String(p)]
									),
									rowOrder
								)
								const template = templates[type]
								for (const artifact of artifacts) {
									const spec = defined(template[artifact][0], `the ${artifact} statement`)
									const [rows] = yield* runArtifact(reader, template, artifact, {
										window: { start: at(lo), end: at(hi) }
									})
									assert.deepEqual(
										rowsAs(spec, rows ?? [], [type === "contract" ? "at" : "p"]).rows,
										expected,
										`${type} [${lo}, ${hi}) (${artifact})`
									)
								}
							})
					)
				})
			)
	)
})
