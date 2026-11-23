/** What the property of hybrid.test.ts reads: its schema, its hybrid query and the record over it, populations and references. */

import { array, element, type Gen, int, weighted } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect } from "effect"
import type { ExecutedStatement } from "#adapter/types/db.ts"
import { planNodes } from "#bench/harness/explain.ts"
import { Distance, Num, Search, Type } from "#compiler/public/compute.ts"
import { closedId, pg, searchDocument } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { closed, relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { Vector } from "#compiler/scalar/values/vector.ts"
import { fixtureTemplate } from "#test/pg/reads/support.ts"
import {
	dimensions,
	generator,
	textRows,
	unitVector,
	vectorText
} from "#test/pg/vector/ann/support.ts"
import type { Installed } from "#test/support/install-migrate.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import type { FactSet } from "#test/support/oracle/install/load.ts"
import type { RawSession } from "#test/support/substrate/session.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * A hybrid search on PostgreSQL 19 with pgvector, as an assignment engine's catalog search makes it: a lesson's nearest
 * candidates by the cosine distance of its embedding to a query vector, and its full text candidates by ts_rank of its
 * search document against a web search's text, each under one route's filters (a subject, a grade up to the student's,
 * an app, and an intervention or one for both), fused by reciprocal rank, Σ 1 / (k + rank), in one query of grizzle's
 * language, one statement.
 *
 * - Lesson(lesson, subject, grade, app, intervention, title, summary, embedding, search): the catalog.
 * - Each arm is a bound of `armTake` candidates: the nearest by distance, a set of candidates with their distances, and
 *   the full text by rank, best first; a candidate's place in its arm is 1 and the count of the arm's candidates before
 *   it, nearest or best first, ties broken by lesson; the fusion sums each lesson's reciprocal places over the arms that
 *   hold it.
 */
const Prose = str.regex("^.*$", "su")
const QueryText = str.bytes(4096, str.regex("^.*$", "su"))
const Embedding = pg.vector(dimensions)

/** Who a lesson intervenes for: a gap's remediation, an extension past it, or both. */
const Intervention = closed.unordered("Intervention", ["remediate", "extend", "both"])

const Lesson = relation.generated(
	"Lesson",
	{
		lesson: pg.integer,
		subject: pg.integer,
		grade: pg.integer,
		app: pg.integer,
		intervention: closedId(Intervention),
		title: Prose,
		summary: Prose,
		embedding: Embedding
	},
	["lesson"],
	(r) => ({ search: searchDocument("english", ["A", r.title], ["B", r.summary]) })
)

export const Catalog = schema("HybridCatalog", [Intervention, Lesson], [])

/** How many candidates each arm takes. */
export const armTake = 12

/** The reciprocal rank fusion's constant, the caller's: its authors' 60. */
const fusionK = 60n

/** The route's nearest lessons to a query vector, the closest first. */
const nearestArm = query(Catalog)
	.rule((r) => {
		const { lesson, subject, grade, app, intervention, embedding } = v(Lesson, "lesson")
		return r
			.match(Lesson, { lesson, subject, grade, app, intervention, embedding })
			.where(
				r.and(
					r.eq(subject, r.param("subject", Lesson.fields.subject)),
					r.le(grade, r.param("grade", Lesson.fields.grade)),
					r.eq(app, r.param("app", Lesson.fields.app)),
					r.or(
						r.eq(intervention, r.param("intervention", Lesson.fields.intervention)),
						r.eq(intervention, "both")
					)
				)
			)
			.find({
				lesson,
				distance: Distance.cosine(embedding, r.param("vector", Lesson.fields.embedding))
			})
	})
	.approximateNearest({ by: "distance", take: armTake })

/** The route's lessons a web search's text matches, the best ranked first. */
const textArm = query(Catalog)
	.rule((r) => {
		const { lesson, subject, grade, app, intervention, search } = v(Lesson, "lesson")
		const q = Search.websearch(r.param("q", QueryText))
		return r
			.match(Lesson, { lesson, subject, grade, app, intervention, search })
			.where(
				r.and(
					Search.matches(search, q),
					r.eq(subject, r.param("subject", Lesson.fields.subject)),
					r.le(grade, r.param("grade", Lesson.fields.grade)),
					r.eq(app, r.param("app", Lesson.fields.app)),
					r.or(
						r.eq(intervention, r.param("intervention", Lesson.fields.intervention)),
						r.eq(intervention, "both")
					)
				)
			)
			.find({ lesson, rank: Search.rank(search, q) })
	})
	.orderBy(["rank", "desc"])
	.take(armTake)

/**
 * Each candidate of each arm with its place: the count of the arm's candidates at or before it, nearest or best first,
 * ties by lesson, 1 for the first, an arm told apart by its name.
 */
const places = query(Catalog)
	.rule((r) => {
		const route = {
			subject: r.param("subject", Lesson.fields.subject),
			grade: r.param("grade", Lesson.fields.grade),
			app: r.param("app", Lesson.fields.app),
			intervention: r.param("intervention", Lesson.fields.intervention)
		}
		const near = nearestArm.bind({ ...route, vector: r.param("vector", Lesson.fields.embedding) })
		const x = v(near, "x")
		const y = v(near, "y")
		return r
			.match(near, { lesson: x.lesson, distance: x.distance })
			.match(near, { lesson: y.lesson, distance: y.distance })
			.where(
				r.or(
					r.lt(y.distance, x.distance),
					r.and(r.eq(y.distance, x.distance), r.le(y.lesson, x.lesson))
				)
			)
			.find({ arm: "nearest", lesson: x.lesson, place: r.count() })
	})
	.rule((r) => {
		const route = {
			subject: r.param("subject", Lesson.fields.subject),
			grade: r.param("grade", Lesson.fields.grade),
			app: r.param("app", Lesson.fields.app),
			intervention: r.param("intervention", Lesson.fields.intervention)
		}
		const text = textArm.bind({ ...route, q: r.param("q", QueryText) })
		const x = v(text, "x")
		const y = v(text, "y")
		return r
			.match(text, { lesson: x.lesson, rank: x.rank })
			.match(text, { lesson: y.lesson, rank: y.rank })
			.where(r.or(r.gt(y.rank, x.rank), r.and(r.eq(y.rank, x.rank), r.le(y.lesson, x.lesson))))
			.find({ arm: "text", lesson: x.lesson, place: r.count() })
	})

/**
 * The hybrid: each lesson of either arm and its reciprocal rank fusion score, Σ 1 / (k + place) over the arms that hold
 * it, a double, the best first, ties by lesson, the first `take`.
 */
const hybrid = query(Catalog)
	.rule((r) => {
		const p = places.bind({
			subject: r.param("subject", Lesson.fields.subject),
			grade: r.param("grade", Lesson.fields.grade),
			app: r.param("app", Lesson.fields.app),
			intervention: r.param("intervention", Lesson.fields.intervention),
			vector: r.param("vector", Lesson.fields.embedding),
			q: r.param("q", QueryText)
		})
		const { arm, lesson, place } = v(p, "place")
		return r.match(p, { arm, lesson, place }).find({
			lesson,
			score: r.sum(
				Num.div(
					Type.literal(pg["double precision"], 1),
					Type.cast(Num.add(place, fusionK), pg["double precision"])
				)
			)
		})
	})
	.orderBy(["score", "desc"])
	.take("take")

/**
 * A step's reads as one record (query(S).reads), one statement: each arm and the hybrid over them, so the hybrid's
 * places are its arms' answers in the very statement, snapshot and plan mode, where two statements of one session may be
 * planned apart, one generic once the session has run it often.
 */
const step = query(Catalog).reads({ nearest: nearestArm, text: textArm, hybrid })

/** The programs the fixture's login serves: the record, and the hybrid alone. */
const programs = { step, hybrid } as const

export const hybridInstall = { label: "hybrid", programs } as const

/** Catalog installed once per member (reads/support.ts fixtureTemplate), which each case's own clone holds. */
export const hybridTemplate = fixtureTemplate(import.meta, Catalog, hybridInstall)

/** The words a text is drawn of: inflections english stems together, stop words, and a few other words. */
const vocabulary = [
	"fraction",
	"fractions",
	"fractional",
	"add",
	"adding",
	"addition",
	"graph",
	"graphs",
	"Graphing",
	"the",
	"of",
	"and",
	"self-test",
	"café",
	"42"
] as const

/** A text of `min` to `max` dictionary words, a space apart. */
const textOf =
	(min: number, max: number): Gen<string> =>
	(s) =>
		Arr.join(s.draw(array(element(vocabulary), { min, max })), " ")

/** A word of the dictionary by a number in [0, 1). */
const wordAt = (x: number): string => vocabulary[Math.floor(x * vocabulary.length)] ?? "graph"

/** A probe: the query vector's number, a web search's text, a route and a bound. */
export interface Probe {
	readonly vector: number
	readonly q: string
	readonly subject: number
	readonly grade: number
	readonly app: number
	readonly intervention: (typeof Intervention.handles)[number]
	readonly take: number
}

/** One of `count` values a catalog spans, three times in four, or the one past them, which no lesson holds. */
const spannedGen = (count: number): Gen<number> =>
	weighted<number>([
		[3, int(0, count - 1)],
		[1, element([count])]
	])

/** A probe of a catalog spanning `subjects` subjects and `apps` apps. */
const probeGen =
	(subjects: number, apps: number): Gen<Probe> =>
	(s) => ({
		vector: s.draw(int(0, 2 ** 31 - 1)),
		q: s.draw(textOf(1, 3)),
		subject: s.draw(spannedGen(subjects)),
		grade: s.draw(int(0, 12)),
		app: s.draw(spannedGen(apps)),
		intervention: s.draw(element(Intervention.handles)),
		take: s.draw(int(1, 2 * armTake))
	})

/**
 * A case: how many lessons, how many subjects and apps they span, the number their fields and embeddings are drawn
 * from, and up to eight probes.
 */
export interface HybridCase {
	readonly lessons: number
	readonly subjects: number
	readonly apps: number
	readonly draw: number
	readonly probes: Arr.NonEmptyReadonlyArray<Probe>
}

/**
 * The most lessons a case holds, and how many subjects and apps they span: enough that PostgreSQL's planner serves some
 * routes' nearest from the HNSW index, so the route's filters meet the index's iterative scan, and few enough that a
 * case loads in a moment. The planner serves a route from the HNSW index only where the btree the arms earn on (app,
 * subject, grade) would read a large part of the catalog, and from that btree, exactly, otherwise: measured on
 * PostgreSQL 19 with pgvector 0.8.7 over this population analyzed (lane FTSG2, 2026-11-21). On this fixture's own
 * installation, 2,400 lessons of one subject and one app had every route of grade 4 or more served by the HNSW index,
 * of one subject and two apps every route of grade 10 or more and some of 7 or more, of two subjects and two apps none.
 * Over a table of the route's columns and the embedding alone, routes drawn uniformly, catalogs of one or two subjects
 * and one or two apps had 173 of 4,000 routes served by the HNSW index, each admitting 184 lessons or more, one of
 * them of two subjects and two apps, where catalogs of two subjects and two apps had 17 of 6,400. Of those 173,
 * hnsw.iterative_scan = off underfilled 66, the route's filters cutting hnsw.ef_search's 40 candidates below the bound,
 * and strict_order none; with the HNSW index forced, strict_order filled min(12, the lessons the route admits) in all
 * of 40,000 routes, off in 113.
 */
const mostLessons = 2400

export const hybridCaseGen: Gen<HybridCase> = (s) => {
	const lessons = s.draw(
		weighted<number>([
			[3, int(1600, mostLessons)],
			[1, int(0, 80)]
		])
	)
	const subjects = s.draw(int(1, 2))
	const apps = s.draw(int(1, 2))
	return {
		lessons,
		subjects,
		apps,
		draw: s.draw(int(0, 2 ** 31 - 1)),
		probes: [
			s.draw(probeGen(subjects, apps)),
			...s.draw(array(probeGen(subjects, apps), { min: 0, max: 7 }))
		]
	}
}

/** A vector of the fixture's dimensions from a number. */
export const vectorOf = (n: number) =>
	Vector.make(Float32Array.from(unitVector(generator(n))), dimensions)

/** A case's facts: each lesson by its position, its route, texts and embedding drawn from the case's number. */
export const hybridFacts = (c: HybridCase): FactSet => {
	const next = generator(c.draw)
	const pick = (count: number): number => Math.floor(next() * count)
	const words = (least: number, most: number): string =>
		Arr.join(
			Array.from({ length: least + pick(most - least + 1) }, () => wordAt(next())),
			" "
		)
	return {
		Lesson: Array.from({ length: c.lessons }, (_, lesson) => ({
			lesson,
			subject: pick(c.subjects),
			grade: pick(13),
			app: pick(c.apps),
			intervention: Intervention.handles[pick(Intervention.handles.length)] ?? "both",
			title: words(1, 4),
			summary: words(0, 8),
			embedding: Vector.make(Float32Array.from(unitVector(next)), dimensions)
		}))
	}
}

/** Analyzes Lesson, so the planner reads its size, as a deployment's autovacuum would. */
export const analyzed = (installed: Installed) =>
	Effect.flatMap(Substrate, (s) => s.admin.query(`ANALYZE ${namesOf(installed).table(Lesson)}`, []))

/** Whether a member's executed statements read Lesson through the HNSW index its nearest arm requested. */
export const servedByHnsw = (
	installed: Installed,
	statements: ReadonlyArray<ExecutedStatement>
): boolean => {
	const hnsw = namesOf(installed).accessIndex(Lesson, ["embedding"])
	return Arr.some(
		Arr.flatMap(statements, (s) => [...planNodes(s.plan)]),
		(n) => n.on.kind === "index" && n.on.relation === "Lesson" && n.on.index.name === hnsw
	)
}

/**
 * The lessons a probe's route admits, PostgreSQL's reading of the stored rows under the route's filters, each with its
 * cosine distance to the probe's vector by pgvector's own function, in no index's order, as (lesson, distance) texts in
 * key order: the eligible universe of the nearest arm.
 */
export const eligible = (session: RawSession, installed: Installed, probe: Probe) => {
	const n = namesOf(installed)
	const column = (f: Parameters<typeof n.column<typeof Lesson>>[1]) => `l.${n.column(Lesson, f)}`
	return Effect.map(
		session.values(
			`SELECT ${column("lesson")}::text, vector_ext.cosine_distance(${column("embedding")}, $1::text::vector_ext.vector)::text
			 FROM ${n.table(Lesson)} AS l
			 WHERE ${column("subject")} = $2::int4 AND ${column("grade")} <= $3::int4 AND ${column("app")} = $4::int4
			   AND (${column("intervention")} = $5::int2 OR ${column("intervention")} = $6::int2)
			 ORDER BY ${column("lesson")}`,
			[
				vectorText([...vectorOf(probe.vector)]),
				probe.subject,
				probe.grade,
				probe.app,
				n.code(Intervention, probe.intervention),
				n.code(Intervention, "both")
			]
		),
		textRows
	)
}

/**
 * The reference fusion of two arms' answers, each in its order, best first: each lesson either holds, its score the
 * sum of 1 / (k + place) over the arms that hold it, each reciprocal and the sum IEEE doubles, which two terms round
 * once; the best `take` by score, ties by lesson.
 */
export const referenceFusion = (
	arms: ReadonlyArray<ReadonlyArray<{ readonly lesson: number }>>,
	take: number
): ReadonlyArray<{ readonly lesson: number; readonly score: number }> => {
	const scores = new Map<number, number>()
	for (const rows of arms) {
		for (const [at, row] of rows.entries()) {
			scores.set(row.lesson, (scores.get(row.lesson) ?? 0) + 1 / (Number(fusionK) + at + 1))
		}
	}
	return Arr.take(
		Arr.sort(
			Arr.map([...scores], ([lesson, score]) => ({ lesson, score })),
			(
				a: { readonly lesson: number; readonly score: number },
				b: { readonly lesson: number; readonly score: number }
			) =>
				a.score !== b.score
					? a.score > b.score
						? -1
						: 1
					: a.lesson < b.lesson
						? -1
						: a.lesson > b.lesson
							? 1
							: 0
		),
		take
	)
}
