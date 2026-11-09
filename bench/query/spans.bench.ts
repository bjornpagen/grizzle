import { Array as Arr, Effect, Option, Result } from "effect"
import type { PlanNode } from "#bench/harness/explain.ts"
import {
	type CaseRecord,
	type GateCheck,
	defineGate,
	equivalence,
	mechanism,
	type VerdictInput
} from "#bench/harness/gate.ts"

import {
	measureVariant,
	rowsAgree,
	type TextRow,
	type VariantOptions,
	type VariantStatement
} from "#bench/harness/variant.ts"

import {
	agrees,
	autocommit,
	columnAt,
	compile,
	fill,
	handwritten,
	handwrittenRows,
	headingOf,
	installedIndexes,
	installFixture,
	type MeasureOptions,
	measureQuery,
	optimizedStatement,
	plainExplain,
	queryPhases,
	rawSession,
	textRowsOf,
	runtimeSession,
	settle
} from "#bench/query/support/kit.ts"
import { indexAccessOn, outline, planOf, rowsReadFrom } from "#bench/query/support/plans.ts"
import { pg, span } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { key, on, relation, schema } from "#compiler/public/schema.ts"
import { has, shapeOf } from "#test/support/kernel/shape.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * R38: point-in-partition lookups.
 *
 * R38 states no gate paragraph; its rule is the measurement: "The fixed policy chooses by measurement; until a shipped
 * benchmark selects the B-tree, the policy selects the GiST form". A calendar of day spans keyed by its
 * span, a nonoverlap key whose GiST index the key's constraint builds, and visits carrying an instant:
 *
 * - the generated lookup of one instant's day is `span @> t`, an index condition on that GiST index reading at most
 *   one span;
 * - the B-tree alternative, the latest span starting at or before t then `t < upper(span)`, reads one entry of a
 *   B-tree on lower(span), an index the handwritten baseline creates for this measurement only, after the generated
 *   variants are measured in their own physical design;
 * - the bare range `lower(span) <= t AND t < upper(span)` without the limit reads every earlier entry, the form the
 *   rule exists to avoid;
 * - a lookup per fact of a joined relation, every visit's day, keeps the GiST form, one probe per visit.
 * All forms agree on instants at a span's start, just before its end, and outside every span.
 */
const Day = relation("Day", { day: pg.bigint, span: span(pg.bigint), week: pg.bigint }, ["day"])
const Visit = relation("Visit", { id: pg.bigint, at: pg.bigint }, ["id"])
const Spans = schema("Spans", { Day, Visit }, [key(on(Day, "span"))])

/**
 * The day of each instant a relation parameter names. r.pointIn takes a term as its point, and a scalar parameter is
 * not one in the public types (types/query/rule.ts pointIn), so the instants arrive as an outer relation.
 */
const dayOf = query(Spans).rule((r) => {
	const instants = r.relation("instants", { at: pg.bigint })
	const { at } = v(instants, "instants")
	const { day, span: s, week } = v(Day, "day")
	return r
		.match(instants, { at })
		.match(Day, { day, span: s, week })
		.where(r.pointIn(at, s))
		.find({ at, day, week })
})

/** Every visit's day: a lookup per fact of a joined relation. */
const visitDays = query(Spans).rule((r) => {
	const { id, at } = v(Visit, "visit")
	const { day, span: s } = v(Day, "day")
	return r
		.match(Visit, { id, at })
		.match(Day, { day, span: s })
		.where(r.pointIn(at, s), r.lt(id, r.param("below", pg.bigint)))
		.find({ id, day })
})

const programs = { dayOf, visitDays } as const

interface Options extends Readonly<Record<string, unknown>> {
	readonly days: number
	readonly visits: number
	readonly samples: number
}

const daySeconds = 86400

/** @internal */
export default defineGate({
	name: "query-spans",
	gates: ["R38"],
	title: "Point-in-partition lookups by GiST containment against the B-tree latest-start form",
	scope:
		"The day of an instant against a calendar keyed by its span: the generated GiST containment, the handwritten " +
		"B-tree latest-start form over an expression index created for the measurement, and the bare range without a " +
		"limit; every visit's day as the joined case.",
	phases: queryPhases,
	options: {
		full: { days: 36500, visits: 100000, samples: 20 },
		quick: { days: 3650, visits: 10000, samples: 3 }
	} satisfies { readonly full: Options; readonly quick: Options },
	run: ({ options }) =>
		Effect.gen(function* () {
			const s = yield* Substrate
			const fx = yield* installFixture(Spans, programs, "benchspans", [])
			yield* fill(fx, "Day", options.days, {
				day: "g::int8",
				/** g is int4 and a century of days in seconds is not: the bounds are computed in int8. */
				span: `pg_catalog.int8range(g::int8 * ${daySeconds}, (g::int8 + 1) * ${daySeconds})`,
				week: "(g / 7)::int8"
			})
			yield* fill(fx, "Visit", options.visits, {
				id: "g::int8",
				at: `(${daySeconds} + (pg_catalog.hashint8(g) & 2147483647) % ${options.days * daySeconds})::int8`
			})
			yield* settle(fx)
			const runtime = yield* runtimeSession(fx, fx.world.app)
			const raw = yield* rawSession(fx, fx.world.app, "m15b spans raw")
			/** The installed indexes, read before the handwritten B-tree design adds its own. */
			const indexes = yield* installedIndexes(fx)
			const day = fx.relationName("Day")
			const D = fx.table("Day")
			const c = (f: string) => fx.column("Day", f)
			const data = `${options.days} consecutive day spans of ${daySeconds} s from day 1, ${options.visits} visits at hashed instants`
			const reading = { role: fx.world.app, context: "snapshot", warm: 3, read: "rows" } as const
			const installed =
				"fresh install of Spans with its workload's access paths; facts loaded, then VACUUM (ANALYZE) of every table; " +
				"the handwritten B-tree on lower(span) created after the generated variants are measured"
			const warm = "warm: each variant runs once before its timed samples"
			const measure: MeasureOptions = {
				samples: options.samples,
				explainSamples: 1,
				serverPlans: [],
				explain: plainExplain,
				conservativeSamples: options.samples
			}
			const middle = Math.floor(options.days / 2)
			/** Instants at a span's start, just before its end, before the first span and after the last. */
			const instants = [
				middle * daySeconds,
				(middle + 1) * daySeconds - 1,
				7 * daySeconds + 12345,
				daySeconds - 1,
				(options.days + 1) * daySeconds
			] as const
			const [firstInstant] = instants
			const cases: Array<CaseRecord<"R38">> = []

			const lookup = compile(fx, dayOf, reading)
			const t = BigInt(firstInstant)
			const lookupM = yield* measureQuery(runtime, raw, lookup, { instants: [{ at: t }] }, measure)
			const joined = compile(fx, visitDays, reading)
			const joinedM = yield* measureQuery(runtime, raw, joined, { below: 200n }, measure)
			const generatedRows: Array<{
				readonly instant: number
				readonly rows: ReadonlyArray<TextRow>
			}> = []
			const atIndex = columnAt(lookup, "at")
			for (const instant of instants) {
				const m = yield* measureQuery(
					runtime,
					raw,
					lookup,
					{ instants: [{ at: BigInt(instant) }] },
					{ ...measure, samples: 1, conservativeSamples: 1 }
				)
				const generatedTexts = yield* textRowsOf(raw, m.delivered.generated.statements)
				generatedRows.push({
					instant,
					rows: Arr.map(generatedTexts, (row) =>
						Arr.filterMap(row, (cell, i) =>
							i === atIndex ? Result.failVoid : Result.succeed(cell)
						)
					)
				})
			}
			const dayHeading = Arr.filter(headingOf(lookup), (h) => h !== "at")
			yield* s.admin.query(
				`CREATE INDEX m15b_day_lower ON ${D} (pg_catalog.lower(${c("span")}))`,
				[]
			)
			yield* s.admin.query(`ANALYZE ${D}`, [])
			const latestStart = (instant: string): VariantStatement => ({
				sql: handwrittenRows(
					dayHeading,
					`SELECT x.day, x.week FROM (SELECT ${c("day")} AS day, ${c("week")} AS week, ${c("span")} AS span FROM ${D} ` +
						`WHERE pg_catalog.lower(${c("span")}) <= $1::int8 ORDER BY pg_catalog.lower(${c("span")}) DESC LIMIT 1) AS x ` +
						"WHERE $1::int8 < pg_catalog.upper(x.span)"
				),
				params: [instant]
			})
			const bareRange = (instant: string): VariantStatement => ({
				sql: handwrittenRows(
					dayHeading,
					`SELECT ${c("day")} AS day, ${c("week")} AS week FROM ${D} WHERE pg_catalog.lower(${c("span")}) <= $1::int8 ` +
						`AND $1::int8 < pg_catalog.upper(${c("span")})`
				),
				params: [instant]
			})
			const handOptions: VariantOptions = {
				samples: options.samples,
				warmup: 0,
				explainSamples: 1,
				explain: plainExplain,
				serverPlans: []
			}
			const btree = yield* measureVariant(
				raw,
				handwritten("handwritten B-tree latest start", [latestStart(String(t))], autocommit),
				handOptions
			)
			const bare = yield* measureVariant(
				raw,
				handwritten("bare range, the rejected form", [bareRange(String(t))], autocommit),
				handOptions
			)
			const agreements: Array<GateCheck> = []
			for (const { instant, rows: viaGist } of generatedRows) {
				const viaBtree = yield* textRowsOf(raw, [latestStart(String(instant))])
				const viaBare = yield* textRowsOf(raw, [bareRange(String(instant))])
				const versusBtree = rowsAgree(viaGist, viaBtree)
				const versusBare = rowsAgree(viaGist, viaBare)
				agreements.push(
					equivalence(
						`instant ${instant}: GiST containment, B-tree latest start and the bare range agree`,
						Option.isNone(versusBtree) && Option.isNone(versusBare) && viaGist.length <= 1,
						`${viaGist.length} rows; B-tree: ${Option.getOrElse(versusBtree, () => "agree")}; bare: ${Option.getOrElse(versusBare, () => "agree")}`
					)
				)
			}
			const lookupPlan = planOf(lookupM.generated, 0)
			const joinedPlan = planOf(joinedM.generated, 0)
			const spanKey = fx.columnName("Day", "span")
			/** The containment in the index condition of the span key's GiST index: the index whose key is the span. */
			const gistProbe = (plan: PlanNode): boolean =>
				Arr.some(
					indexAccessOn(plan, day, indexes),
					(a) => a.condition === "index cond" && a.columns.length === 1 && a.columns[0] === spanKey
				)
			cases.push(
				{
					name: "the day of one instant",
					gates: ["R38"],
					conditions: {
						workload:
							"a one-fact relation parameter of instants matched to Day by r.pointIn(at, span), span a nonoverlap key",
						schemaState: installed,
						dataDistribution: data,
						parameters: { t: String(t), instants },
						resultSemantics: "the (day, week) whose span contains the instant, at most one",
						cacheState: warm
					},
					phases: {},
					variants: [lookupM.generated, lookupM.conservative, btree, bare],
					comparisons: [],
					transactions: {},
					loads: {},
					measures: {
						gistRowsRead: rowsReadFrom(lookupPlan, day),
						btreeRowsRead: rowsReadFrom(planOf(btree, 0), day),
						bareRowsRead: rowsReadFrom(planOf(bare, 0), day)
					}
				},
				{
					name: "every visit's day, a lookup per fact of a joined relation",
					gates: ["R38"],
					conditions: {
						workload: "Visit joined to Day by r.pointIn(at, span), visits below an id",
						schemaState: installed,
						dataDistribution: data,
						parameters: { below: "200" },
						resultSemantics: "each visit below the id with its day",
						cacheState: warm
					},
					phases: {},
					variants: [joinedM.generated, joinedM.conservative],
					comparisons: [],
					transactions: {},
					loads: {},
					measures: { joinedDayRowsRead: rowsReadFrom(joinedPlan, day) }
				}
			)
			const r38: VerdictInput = {
				checks: [
					mechanism(
						"the generated lookup is span @> t in the GiST index condition",
						gistProbe(lookupPlan) &&
							has(shapeOf(optimizedStatement(lookup, 0).ast), "predicate @> column column"),
						outline(lookupPlan, 0)
					),
					mechanism(
						"the nonoverlap key admits at most one span: one row read",
						rowsReadFrom(lookupPlan, day) <= 1,
						`${rowsReadFrom(lookupPlan, day)} rows`
					),
					mechanism(
						"a lookup per joined fact keeps the GiST form",
						gistProbe(joinedPlan) &&
							has(shapeOf(optimizedStatement(joined, 0).ast), "predicate @> column column"),
						outline(joinedPlan, 0)
					),
					agrees("the lookup agrees with the conservative lowering", lookupM),
					agrees("the joined lookup agrees with the conservative lowering", joinedM),
					...agreements
				]
			}
			return { cases, verdicts: { R38: r38 } }
		})
})
