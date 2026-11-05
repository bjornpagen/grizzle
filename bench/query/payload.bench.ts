import { Array as Arr, Effect, Option, Record as Rec } from "effect"
import { findNodes, type PlanNode } from "#bench/harness/explain.ts"
import {
	type CaseRecord,
	defineGate,
	equivalence,
	mechanism,
	type VerdictInput
} from "#bench/harness/gate.ts"

import {
	compareVariants,
	measureVariant,
	type VariantMeasure,
	type VariantOptions
} from "#bench/harness/variant.ts"

import {
	agrees,
	autocommit,
	compile,
	conditions,
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
	runtimeSession,
	serializedExplain,
	settle
} from "#bench/query/support/kit.ts"
import { outline, planOf, serializedKb, summaryOf } from "#bench/query/support/plans.ts"
import { maxOf } from "#compiler/core/array.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"

/**
 * R06: late payload retrieval.
 *
 * One relation, Doc(id, rank, title, body), whose body is unbounded text, wide payload by the structural rule (text
 * with no proved byte bound), some of it long enough to be TOASTed. The bounded read is a program outside the workload,
 * so no index supplies its order and the sort reads every document: the case late fetch exists for.
 *
 * - R06 (:90): "measure intermediate width, heap/TOAST access, total serialization bytes, sort/hash memory, and
 *   identical result membership", for the generated take against the handwritten late-fetch form (the narrow key and
 *   order tuple sorted and limited, then the payload fetched by key in the same statement) and the plain form. The
 *   rewrite is required to fire where its proof holds, a take over a key-retaining stage whose order reads no payload,
 *   and to stay off where the key is projected away and equal payloads collapse.
 */
const Doc = relation(
	"Doc",
	{
		id: pg.bigint,
		rank: pg.integer,
		title: str.regex("^.{1,80}$", "su"),
		body: str.regex("^.*$", "su")
	},
	["id"]
)
const Payload = schema("Payload", { Doc }, [])

/** The twenty best-ranked documents with their payload; the order is total at the key. */
const topDocs = query(Payload)
	.rule((r) => {
		const { id, rank, title, body } = v(Doc, "doc")
		return r.match(Doc, { id, rank, title, body }).find({ id, rank, title, body })
	})
	.orderBy(["rank", "desc"], ["id", "asc"])
	.take(20)

/**
 * The counterexample: the key projected away, so equal (rank, body) facts collapse and limiting keys first would
 * underfill the answer.
 */
const topBodies = query(Payload)
	.rule((r) => {
		const { rank, body } = v(Doc, "doc")
		return r.match(Doc, { rank, body }).find({ rank, body })
	})
	.orderBy(["rank", "desc"])
	.take(20)

interface Options extends Readonly<Record<string, unknown>> {
	readonly docs: number
	readonly samples: number
}

/** The widest row a Sort node of the plan carries, and the memory the sorts used. */
const sortFigures = (plan: PlanNode): { readonly width: number; readonly spaceKb: number } => {
	const sorts = findNodes(plan, (n) => n.nodeType === "Sort" || n.nodeType === "Incremental Sort")
	if (sorts.length === 0) {
		throw new GateSetupError({ what: "the plan sorts nothing" })
	}
	return {
		width: maxOf(
			Arr.map(sorts, (n) => n.planWidth),
			Number.NEGATIVE_INFINITY
		),
		spaceKb: Arr.reduce(
			sorts,
			0,
			(s, n) =>
				s +
				Option.match(n.sort, {
					onNone: () => {
						throw new GateSetupError({ what: `a ${n.nodeType} node reports no sort space` })
					},
					onSome: (sort) => sort.spaceUsedKb
				})
		)
	}
}

/** The root-inclusive buffers and the serialized output of a variant's one statement. */
const figures = (m: VariantMeasure): Readonly<Record<string, number>> => {
	const summary = summaryOf(m, 0)
	return {
		sharedHit: summary.sharedHit.p50,
		sharedRead: summary.sharedRead.p50,
		tempWritten: summary.tempWritten.p50,
		serializationKb: serializedKb(m, 0)
	}
}

/** @internal */
export default defineGate({
	name: "query-payload",
	gates: ["R06"],
	title: "Late payload retrieval against the handwritten late-fetch and plain forms",
	scope:
		"A take(20) over documents with unbounded text bodies, some TOASTed, against the handwritten late-fetch and plain " +
		"forms, and the key-dropping take late fetch must not rewrite (R06).",
	phases: queryPhases,
	options: {
		full: { docs: 60000, samples: 15 },
		quick: { docs: 8000, samples: 2 }
	} satisfies { readonly full: Options; readonly quick: Options },
	run: ({ options }) =>
		Effect.gen(function* () {
			const fx = yield* installFixture(Payload, {}, "benchpayload", [])
			yield* fill(fx, "Doc", options.docs, {
				id: "g::int8",
				rank: "((pg_catalog.hashint8(g) & 2147483647) % 1000)::int4",
				title: "'doc ' || g",
				body: "pg_catalog.repeat(pg_catalog.md5((g % 500)::text), CASE WHEN g % 10 = 0 THEN 130 ELSE 6 END)"
			})
			yield* settle(fx)
			const runtime = yield* runtimeSession(fx, fx.world.app)
			const raw = yield* rawSession(fx, fx.world.app, "m15b payload raw")
			const D = fx.table("Doc")
			const c = (f: string) => fx.column("Doc", f)
			const data = `${options.docs} documents, ranks 0-999 hashed, bodies 192 bytes or (every tenth) 4160 bytes of repeated md5 text`
			const reading = { role: fx.world.app, context: "snapshot", warm: 3, read: "rows" } as const
			const handOptions: VariantOptions = {
				samples: options.samples,
				warmup: 0,
				explainSamples: 1,
				explain: serializedExplain,
				serverPlans: []
			}
			const measure: MeasureOptions = {
				samples: options.samples,
				explainSamples: 1,
				serverPlans: [],
				explain: serializedExplain,
				conservativeSamples: options.samples
			}
			const schemaState = "fresh install, primary key only (no workload program); VACUUM (ANALYZE)"
			const cases: Array<CaseRecord<"R06">> = []

			const top = compile(fx, topDocs, reading)
			const topM = yield* measureQuery(runtime, raw, top, {}, measure)
			const lateFetch = yield* measureVariant(
				raw,
				handwritten(
					"handwritten late fetch",
					[
						{
							sql: handwrittenRows(
								headingOf(top),
								`SELECT d.${c("id")} AS id, d.${c("rank")} AS rank, d.${c("title")} AS title, d.${c("body")} AS body FROM ` +
									`(SELECT ${c("id")} AS id, ${c("rank")} AS rank FROM ${D} ORDER BY ${c("rank")} DESC, ${c("id")} LIMIT 20) AS k ` +
									`JOIN ${D} AS d ON d.${c("id")} = k.id`
							),
							params: []
						}
					],
					autocommit
				),
				handOptions
			)
			const plain = yield* measureVariant(
				raw,
				handwritten(
					"handwritten plain",
					[
						{
							sql: handwrittenRows(
								headingOf(top),
								`SELECT ${c("id")} AS id, ${c("rank")} AS rank, ${c("title")} AS title, ${c("body")} AS body FROM ${D} ` +
									`ORDER BY ${c("rank")} DESC, ${c("id")} LIMIT 20`
							),
							params: []
						}
					],
					autocommit
				),
				handOptions
			)
			const bodies = compile(fx, topBodies, reading)
			const bodiesM = yield* measureQuery(
				runtime,
				raw,
				bodies,
				{},
				{
					...measure,
					samples: 1,
					explain: plainExplain,
					conservativeSamples: 1
				}
			)
			const generatedSort = sortFigures(planOf(topM.generated, 0))
			const lateSort = sortFigures(planOf(lateFetch, 0))
			const plainSort = sortFigures(planOf(plain, 0))
			cases.push(
				{
					name: "the twenty best-ranked documents with their bodies",
					gates: ["R06"],
					conditions: conditions({
						workload:
							"take(20) by (rank desc, id) of Doc delivering id, rank, title and body; outside the workload",
						schemaState,
						data,
						parameters: {},
						semantics: "the 20 documents first by rank descending then id, with their payload",
						cache: "warm: each variant runs once before its timed samples"
					}),
					phases: {},
					variants: [topM.generated, topM.conservative, lateFetch, plain],
					comparisons: [
						compareVariants(topM.generated, lateFetch),
						compareVariants(topM.generated, plain)
					],
					transactions: {},
					loads: {},
					measures: {
						sortWidthGenerated: generatedSort.width,
						sortWidthLateFetch: lateSort.width,
						sortWidthPlain: plainSort.width,
						sortKbGenerated: generatedSort.spaceKb,
						sortKbLateFetch: lateSort.spaceKb,
						sortKbPlain: plainSort.spaceKb,
						...Rec.fromEntries(
							Arr.map(Rec.toEntries(figures(topM.generated)), ([k, x]) => [`generated.${k}`, x])
						),
						...Rec.fromEntries(
							Arr.map(Rec.toEntries(figures(lateFetch)), ([k, x]) => [`lateFetch.${k}`, x])
						),
						...Rec.fromEntries(
							Arr.map(Rec.toEntries(figures(plain)), ([k, x]) => [`plain.${k}`, x])
						)
					}
				},
				{
					name: "the twenty best (rank, body) pairs, the key projected away",
					gates: ["R06"],
					conditions: conditions({
						workload: "take(20) by rank desc of Doc's distinct (rank, body) pairs",
						schemaState,
						data,
						parameters: {},
						semantics: "the first 20 distinct (rank, body) pairs, completed by body",
						cache: "timed once, after its first execution"
					}),
					phases: {},
					variants: [bodiesM.generated, bodiesM.conservative],
					comparisons: [],
					transactions: {},
					loads: {},
					measures: {}
				}
			)
			const r06: VerdictInput = {
				checks: [
					mechanism(
						"the generated sort carries the narrow key and order tuple, as the late-fetch form's does",
						generatedSort.width <= lateSort.width,
						`generated ${generatedSort.width} bytes, late fetch ${lateSort.width}, plain ${plainSort.width}\n${outline(planOf(topM.generated, 0), 0)}`
					),
					agrees("generated and conservative deliver the same documents", topM),
					equivalence(
						"generated and handwritten late fetch deliver the same documents",
						compareVariants(topM.generated, lateFetch).sameResult,
						`${topM.generated.result.rows} generated rows, ${lateFetch.result.rows} handwritten`
					),
					equivalence(
						"generated and handwritten plain deliver the same documents",
						compareVariants(topM.generated, plain).sameResult,
						`${topM.generated.result.rows} generated rows, ${plain.result.rows} handwritten`
					),
					agrees("the key-dropping take agrees with the conservative form", bodiesM),
					equivalence(
						"no repeated row",
						topM.generated.result.repeated === 0 && bodiesM.generated.result.repeated === 0,
						`${topM.generated.result.repeated} and ${bodiesM.generated.result.repeated} repeated`
					)
				]
			}
			return { cases, verdicts: { R06: r06 } }
		})
})
