import { Array as Arr, Effect, Option, Record as Rec } from "effect"
import { summarize } from "#bench/cold/stats.ts"
import { explain, findNodes, type PlanNode } from "#bench/harness/explain.ts"
import {
	type CaseRecord,
	type GateCheck,
	defineGate,
	equivalence,
	mechanism,
	type VerdictInput
} from "#bench/harness/gate.ts"

import {
	compareVariants,
	measureVariant,
	rowsAgree,
	type VariantStatement
} from "#bench/harness/variant.ts"

import {
	agrees,
	autocommit,
	type Compiled,
	certifiedRules,
	compile,
	deliver,
	fill,
	GateSetupError,
	handwritten,
	handwrittenRows,
	headingOf,
	installFixture,
	type MeasureOptions,
	measureQuery,
	plainExplain,
	queryPhases,
	rawSession,
	textRowsOf,
	runtimeSession,
	settle
} from "#bench/query/support/kit.ts"
import { outline, planOf, scansOf, summaryOf } from "#bench/query/support/plans.ts"
import { indices, maxOf } from "#compiler/core/array.ts"
import { flight } from "#compiler/lower/conservative/types.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { featureCount, has, shapeOf } from "#test/support/kernel/shape.ts"
import type { RawSession } from "#test/support/substrate/session.ts"

import { regex } from "arkregex"
/**
 * R14: keep planning growth bounded.
 *
 * R14 states no gate paragraph, so its gate is the performance contract's measurement, of what R14 names: "Measure
 * PostgreSQL Planning Time, relation count after rewrites, emitted SQL bytes, and first/warm backend behavior". Paths
 * of 2, 4, 8 and 12 edges through a graph (a join chain, past join_collapse_limit at 12 and at geqo_threshold), and
 * unions of 2, 4 and 8 arms, each compiled by grizzle and delivered; for each size the record holds the emitted bytes,
 * the relations the plan scans, the planning time and the first execution on a fresh backend against warm ones. The
 * mechanism checks are structural: fusion adds no scan beyond the matched relations, the emitted text grows linearly
 * with the query, the compiler neither raises the planner's limits nor invents an optimizer fence (OFFSET 0, a
 * MATERIALIZED single-use stage), and past the collapse limits no two inputs are joined without a condition. Each size
 * is also measured against the handwritten baseline: a path as an explicit JOIN chain from the start node under SELECT
 * DISTINCT, whose JOIN order PostgreSQL keeps past join_collapse_limit, and a union of one heading as one scan with the
 * arms' weights as an IN list. The 12-edge path and its handwritten chain are explained and run to completion once
 * each.
 */
const Edge = relation("Edge", { src: pg.bigint, dst: pg.bigint, w: pg.integer }, ["src", "dst"])
const Plan = schema("Plan", { Edge }, [])

const path2 = query(Plan).rule((r) => {
	const [a, b] = [v(Edge, "first"), v(Edge, "second")]
	return r
		.match(Edge, { src: r.param("start", Edge.fields.src), dst: a.dst })
		.match(Edge, { src: a.dst, dst: b.dst })
		.find({ end: b.dst })
})

const path4 = query(Plan).rule((r) => {
	const [a, b, c, d] = [v(Edge, "first"), v(Edge, "second"), v(Edge, "third"), v(Edge, "fourth")]
	return r
		.match(Edge, { src: r.param("start", Edge.fields.src), dst: a.dst })
		.match(Edge, { src: a.dst, dst: b.dst })
		.match(Edge, { src: b.dst, dst: c.dst })
		.match(Edge, { src: c.dst, dst: d.dst })
		.find({ end: d.dst })
})

const path8 = query(Plan).rule((r) => {
	const [a, b, c, d, e, f, g, h] = [
		v(Edge, "first"),
		v(Edge, "second"),
		v(Edge, "third"),
		v(Edge, "fourth"),
		v(Edge, "fifth"),
		v(Edge, "sixth"),
		v(Edge, "seventh"),
		v(Edge, "eighth")
	]
	return r
		.match(Edge, { src: r.param("start", Edge.fields.src), dst: a.dst })
		.match(Edge, { src: a.dst, dst: b.dst })
		.match(Edge, { src: b.dst, dst: c.dst })
		.match(Edge, { src: c.dst, dst: d.dst })
		.match(Edge, { src: d.dst, dst: e.dst })
		.match(Edge, { src: e.dst, dst: f.dst })
		.match(Edge, { src: f.dst, dst: g.dst })
		.match(Edge, { src: g.dst, dst: h.dst })
		.find({ end: h.dst })
})

const path12 = query(Plan).rule((r) => {
	const [a, b, c, d, e, f, g, h, i, j, k, l] = [
		v(Edge, "first"),
		v(Edge, "second"),
		v(Edge, "third"),
		v(Edge, "fourth"),
		v(Edge, "fifth"),
		v(Edge, "sixth"),
		v(Edge, "seventh"),
		v(Edge, "eighth"),
		v(Edge, "ninth"),
		v(Edge, "tenth"),
		v(Edge, "eleventh"),
		v(Edge, "twelfth")
	]
	return r
		.match(Edge, { src: r.param("start", Edge.fields.src), dst: a.dst })
		.match(Edge, { src: a.dst, dst: b.dst })
		.match(Edge, { src: b.dst, dst: c.dst })
		.match(Edge, { src: c.dst, dst: d.dst })
		.match(Edge, { src: d.dst, dst: e.dst })
		.match(Edge, { src: e.dst, dst: f.dst })
		.match(Edge, { src: f.dst, dst: g.dst })
		.match(Edge, { src: g.dst, dst: h.dst })
		.match(Edge, { src: h.dst, dst: i.dst })
		.match(Edge, { src: i.dst, dst: j.dst })
		.match(Edge, { src: j.dst, dst: k.dst })
		.match(Edge, { src: k.dst, dst: l.dst })
		.find({ end: l.dst })
})

/** Unions of arms of one heading, each a filtered scan. */
const union2 = query(Plan)
	.rule((r) => {
		const { src, dst, w } = v(Edge, "edge")
		return r
			.match(Edge, { src, dst, w })
			.where(r.eq(w, 0), r.lt(src, r.param("below", pg.bigint)))
			.find({ src, dst })
	})
	.rule((r) => {
		const { src, dst, w } = v(Edge, "edge")
		return r
			.match(Edge, { src, dst, w })
			.where(r.eq(w, 1), r.lt(src, r.param("below", pg.bigint)))
			.find({ src, dst })
	})

const union4 = union2
	.rule((r) => {
		const { src, dst, w } = v(Edge, "edge")
		return r
			.match(Edge, { src, dst, w })
			.where(r.eq(w, 2), r.lt(src, r.param("below", pg.bigint)))
			.find({ src, dst })
	})
	.rule((r) => {
		const { src, dst, w } = v(Edge, "edge")
		return r
			.match(Edge, { src, dst, w })
			.where(r.eq(w, 3), r.lt(src, r.param("below", pg.bigint)))
			.find({ src, dst })
	})

const union8 = union4
	.rule((r) => {
		const { src, dst, w } = v(Edge, "edge")
		return r
			.match(Edge, { src, dst, w })
			.where(r.eq(w, 4), r.lt(src, r.param("below", pg.bigint)))
			.find({ src, dst })
	})
	.rule((r) => {
		const { src, dst, w } = v(Edge, "edge")
		return r
			.match(Edge, { src, dst, w })
			.where(r.eq(w, 5), r.lt(src, r.param("below", pg.bigint)))
			.find({ src, dst })
	})
	.rule((r) => {
		const { src, dst, w } = v(Edge, "edge")
		return r
			.match(Edge, { src, dst, w })
			.where(r.eq(w, 6), r.lt(src, r.param("below", pg.bigint)))
			.find({ src, dst })
	})
	.rule((r) => {
		const { src, dst, w } = v(Edge, "edge")
		return r
			.match(Edge, { src, dst, w })
			.where(r.eq(w, 7), r.lt(src, r.param("below", pg.bigint)))
			.find({ src, dst })
	})

const programs = { path2, path4, path8, path12, union2, union4, union8 } as const

interface Options extends Readonly<Record<string, unknown>> {
	readonly nodes: number
	readonly samples: number
}

/**
 * Whether a condition's text names a column of `alias`, as EXPLAIN prints a qualified reference: alias.column, the
 * alias quoted where it needs quoting. This reads EXPLAIN's condition text, the one place a plan states which relation
 * a condition reads; the emitted SQL is never matched.
 */
const namesAlias = (text: string, alias: string): boolean =>
	regex.as(`(^|[^\\w"])"?${RegExp.escape(alias)}"?\\.`).test(text)

/**
 * The nested loops of a plan that join their two inputs without a condition: no Join Filter, and no index condition,
 * filter or recheck condition of the inner side names a relation of the outer side, so nothing of the outer row reaches
 * the inner one. A condition on a constant or a parameter alone connects nothing. A hash or merge join always has its
 * condition.
 */
const unconditionedLoops = (plan: PlanNode): number =>
	Arr.filter(findNodes(plan, "Nested Loop"), (loop) => {
		const [outer, inner] = loop.children
		if (outer === undefined || inner === undefined) {
			throw new GateSetupError({ what: "a nested loop with one input" })
		}
		if (loop.joinFilter.kind === "filter") {
			return false
		}
		const aliases = Arr.flatMap(
			findNodes(outer, () => true),
			(n) => Option.toArray(n.alias)
		)
		const innerConditions = Arr.flatMap(
			findNodes(inner, () => true),
			(n) => [
				...Option.toArray(n.indexCond),
				...Option.toArray(n.filter),
				...Option.toArray(n.recheckCond)
			]
		)
		return !Arr.some(innerConditions, (c) => Arr.some(aliases, (a) => namesAlias(c, a)))
	}).length

/** One statement explained with ANALYZE on the raw session, then run once more for its rows, each to completion. */
const planAndRun = Effect.fn("planAndRun")(function* (
	raw: RawSession,
	statement: VariantStatement
) {
	const explained = yield* explain(raw, statement.sql, statement.params, plainExplain)
	const rows = yield* textRowsOf(raw, [statement])
	return { explained, rows }
})

/** Whether a compiled read raises no planner fence: no OFFSET 0 and no MATERIALIZED stage in any statement. */
const unfenced = (compiled: Compiled): boolean =>
	Arr.every(flight(compiled.compiled.template.programs.optimized.roots), (statement) => {
		const shape = shapeOf(statement.ast)
		return featureCount(shape, "offset literal") === 0 && !has(shape, "cte materialized")
	})

/** @internal */
export default defineGate({
	name: "query-planning",
	gates: ["R14"],
	title: "Planning growth over join chains and unions",
	scope:
		"Paths of 2 to 12 edges and unions of 2 to 8 arms: emitted bytes, relations scanned, planning time, and first " +
		"against warm executions, with the structural checks that fusion adds no scan and no fence.",
	phases: queryPhases,
	options: {
		full: { nodes: 20000, samples: 15 },
		quick: { nodes: 4000, samples: 2 }
	} satisfies { readonly full: Options; readonly quick: Options },
	run: ({ options }) =>
		Effect.gen(function* () {
			const fx = yield* installFixture(Plan, programs, "benchplanning", [])
			yield* fill(fx, "Edge", options.nodes * 2, {
				src: "(1 + (g - 1) / 2)::int8",
				dst: `(1 + (2 * ((g - 1) / 2) + g % 2) % ${options.nodes})::int8`,
				w: "(g % 8)::int4"
			})
			yield* settle(fx)
			const raw = yield* rawSession(fx, fx.world.app, "m15b planning raw")
			const runtime = yield* runtimeSession(fx, fx.world.app)
			const edge = fx.relationName("Edge")
			const E = fx.table("Edge")
			const src = fx.column("Edge", "src")
			const dst = fx.column("Edge", "dst")
			const w = fx.column("Edge", "w")
			const reading = { role: fx.world.app, context: "snapshot", warm: 3, read: "rows" } as const
			const installed =
				"fresh install of Plan with its workload's access paths; facts loaded, then VACUUM (ANALYZE) of every table"
			const data = `${options.nodes} nodes with two out-edges each`
			/** The handwritten baselines: an explicit JOIN chain from the start node, and one scan over the arms' weights. */
			const handPathSql = (size: number): string =>
				`SELECT DISTINCT e${size}.${dst} AS "end" FROM ${E} AS e1 ${Arr.join(
					Arr.map(
						indices(size - 1),
						(i) => `JOIN ${E} AS e${i + 2} ON e${i + 2}.${src} = e${i + 1}.${dst}`
					),
					" "
				)} WHERE e1.${src} = $1::bigint`
			const handUnionSql = (size: number): string =>
				`SELECT ${src} AS src, ${dst} AS dst FROM ${E} ` +
				`WHERE ${w} IN (${Arr.join(
					Arr.map(indices(size), (i) => String(i)),
					", "
				)}) AND ${src} < $1::bigint`
			const start = 7n
			const below = BigInt(Math.floor(options.nodes / 4))
			const cases: Array<CaseRecord<"R14">> = []
			const checks: Array<GateCheck> = []
			const agreements: Array<GateCheck> = []
			const sized = [
				["path", 2, path2],
				["path", 4, path4],
				["path", 8, path8],
				["union", 2, union2],
				["union", 4, union4],
				["union", 8, union8]
			] as const
			const bytesPerUnit: { readonly [K in (typeof sized)[number][0]]: Array<number> } = {
				path: [],
				union: []
			}
			for (const [kind, size, q] of sized) {
				const compiled = compile(fx, q, reading)
				const values = kind === "path" ? { start } : { below }
				const measure: MeasureOptions = {
					samples: options.samples,
					explainSamples: Math.max(1, options.samples),
					serverPlans: [],
					explain: plainExplain,
					conservativeSamples: 1
				}
				const m = yield* measureQuery(runtime, raw, compiled, values, measure)
				const hand = yield* measureVariant(
					raw,
					handwritten(
						kind === "path"
							? `handwritten JOIN chain of ${size}`
							: `handwritten IN list of ${size}`,
						[
							{
								sql: handwrittenRows(
									headingOf(compiled),
									kind === "path" ? handPathSql(size) : handUnionSql(size)
								),
								params: [String(kind === "path" ? start : below)]
							}
						],
						autocommit
					),
					{
						samples: options.samples,
						warmup: 1,
						explainSamples: Math.max(1, options.samples),
						explain: plainExplain,
						serverPlans: []
					}
				)
				const versusHand = compareVariants(m.generated, hand)
				/** The first execution of the template's statement on a backend that has run nothing, then warm ones. */
				const fresh = yield* runtimeSession(fx, fx.world.app)
				const first = yield* deliver(fresh, compiled, "optimized", values)
				const warm: Array<number> = []
				for (let i = 0; i < Math.max(2, options.samples); i++) {
					warm.push((yield* deliver(fresh, compiled, "optimized", values)).ms)
				}
				const sql = Arr.join(m.generated.statements, "\n")
				const plan = planOf(m.generated, 0)
				const scans = scansOf(plan, edge).length
				const label = `${kind}${size}`
				const settings = summaryOf(m.generated, 0).settings
				bytesPerUnit[kind].push(Buffer.byteLength(sql) / size)
				checks.push(
					mechanism(
						`${label}: the plan scans each matched relation once, no more`,
						scans === size,
						`${scans} scans of ${size} matches`
					),
					mechanism(
						`${label}: no planner limit raised and no optimizer fence emitted`,
						unfenced(compiled) &&
							Arr.every(Rec.keys(settings), (k) => !regex("collapse_limit|geqo").test(k)),
						`rules ${Arr.join(certifiedRules(compiled), ", ")}; settings ${Arr.join(Rec.keys(settings), ", ")}`
					)
				)
				agreements.push(
					agrees(`${label}: generated agrees with the conservative lowering`, m),
					equivalence(
						`${label}: generated agrees with the handwritten SQL`,
						versusHand.sameResult,
						`${m.generated.result.rows} generated rows, ${hand.result.rows} handwritten`
					)
				)
				cases.push({
					name: `${kind === "path" ? "a path" : "a union"} of ${size} ${kind === "path" ? "edges" : "arms"}`,
					gates: ["R14"],
					conditions: {
						workload:
							kind === "path"
								? `a join chain of ${size} Edge matches from a start node`
								: `a union of ${size} filtered arms`,
						schemaState: installed,
						dataDistribution: data,
						parameters: { size },
						resultSemantics:
							kind === "path"
								? "the end nodes of every path of the length"
								: "the edges of the arms' weights",
						cacheState: "warm variants; firstMs is the first execution on a fresh backend"
					},
					phases: {},
					variants: [m.generated, m.conservative, hand],
					comparisons: [versusHand],
					transactions: {},
					loads: {},
					measures: {
						[`${label}.sqlBytes`]: Buffer.byteLength(sql),
						[`${label}.scans`]: scans,
						[`${label}.planningP50Ms`]: summaryOf(m.generated, 0).planningMs.p50,
						[`${label}.firstMs`]: first.ms,
						[`${label}.warmP50Ms`]: summarize(warm).p50,
						[`${label}.handwrittenPlanningP50Ms`]: summaryOf(hand, 0).planningMs.p50,
						[`${label}.handwrittenSqlBytes`]: Buffer.byteLength(Arr.join(hand.statements, "\n"))
					}
				})
			}
			/**
			 * A path of twelve edges, past join_collapse_limit and at geqo_threshold: delivered once by the runtime, then its
			 * statement and the handwritten chain each explained with ANALYZE and run, to completion.
			 */
			const long = compile(fx, path12, reading)
			const longDelivered = yield* deliver(runtime, long, "optimized", { start })
			const [longStatement] = longDelivered.statements
			if (longDelivered.statements.length !== 1) {
				throw new GateSetupError({
					what: `the 12-edge path sent ${longDelivered.statements.length} statements, not one`
				})
			}
			const longRun = yield* planAndRun(raw, longStatement)
			const longHand = yield* planAndRun(raw, {
				sql: handwrittenRows(headingOf(long), handPathSql(12)),
				params: [String(start)]
			})
			const longAgreement = rowsAgree(longRun.rows, longHand.rows)
			const longLoops = unconditionedLoops(longRun.explained.plan)
			const handLoops = unconditionedLoops(longHand.explained.plan)
			if (handLoops !== 0) {
				throw new GateSetupError({
					what: `the loop check finds ${handLoops} unconditioned loops in the handwritten JOIN chain\n${outline(longHand.explained.plan, 0)}`
				})
			}
			cases.push({
				name: "a path of 12 edges, explained and run once",
				gates: ["R14"],
				conditions: {
					workload:
						"a join chain of 12 Edge matches from a start node, past join_collapse_limit, and the handwritten JOIN chain",
					schemaState: installed,
					dataDistribution: data,
					parameters: { size: 12 },
					resultSemantics: "the end nodes of every path of 12 edges",
					cacheState: "one EXPLAIN ANALYZE and one execution after the runtime's delivery"
				},
				phases: {},
				variants: [],
				comparisons: [],
				transactions: {},
				loads: {},
				measures: {
					"path12.sqlBytes": Buffer.byteLength(longStatement.sql),
					"path12.planningMs": longRun.explained.planningMs,
					"path12.executionMs": longRun.explained.executionMs,
					"path12.unconditionedLoops": longLoops,
					"path12.plan": outline(longRun.explained.plan, 0),
					"path12.handwritten.planningMs": longHand.explained.planningMs,
					"path12.handwritten.executionMs": longHand.explained.executionMs,
					"path12.handwritten.unconditionedLoops": handLoops,
					"path12.handwritten.plan": outline(longHand.explained.plan, 0)
				}
			})
			const linear = (xs: ReadonlyArray<number>) =>
				xs.length > 1 &&
				maxOf(xs, Number.NEGATIVE_INFINITY) <=
					2 * Arr.reduce(xs, Number.POSITIVE_INFINITY, (least, x) => Math.min(least, x))
			const r14: VerdictInput = {
				checks: [
					mechanism(
						"emitted bytes grow linearly with the query: per matched relation and per arm within a factor of two",
						linear(bytesPerUnit.path) && linear(bytesPerUnit.union),
						`path ${Arr.join(Arr.map(bytesPerUnit.path, String), ", ")}; union ${Arr.join(Arr.map(bytesPerUnit.union, String), ", ")}`
					),
					mechanism(
						"the 12-edge plan joins no two inputs without a condition",
						longLoops === 0,
						`${longLoops} nested loops with no condition naming their outer side\n${outline(longRun.explained.plan, 0)}`
					),
					...checks,
					equivalence(
						"path12: generated agrees with the handwritten JOIN chain",
						Option.isNone(longAgreement),
						Option.getOrElse(longAgreement, () => `${longRun.rows.length} rows`)
					),
					...agreements
				]
			}
			return { cases, verdicts: { R14: r14 } }
		})
})
