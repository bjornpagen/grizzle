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
import {
	type Installed,
	loadMigrated,
	seededGeneratedTemplate
} from "#test/support/install-migrate.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import type { FactSet } from "#test/support/oracle/install/load.ts"
import { fixtureSpec, fixtureTemplate } from "#test/support/pg/reads/support.ts"
import {
	dimensions,
	generator,
	textRows,
	unitVector,
	vectorText
} from "#test/support/pg/vector/ann/support.ts"
import type { RawSession } from "#test/support/substrate/session.ts"

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
				r.and([
					r.eq(subject, r.param("subject", Lesson.fields.subject)),
					r.le(grade, r.param("grade", Lesson.fields.grade)),
					r.eq(app, r.param("app", Lesson.fields.app)),
					r.or([
						r.eq(intervention, r.param("intervention", Lesson.fields.intervention)),
						r.eq(intervention, "both")
					])
				])
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
				r.and([
					Search.matches(search, q),
					r.eq(subject, r.param("subject", Lesson.fields.subject)),
					r.le(grade, r.param("grade", Lesson.fields.grade)),
					r.eq(app, r.param("app", Lesson.fields.app)),
					r.or([
						r.eq(intervention, r.param("intervention", Lesson.fields.intervention)),
						r.eq(intervention, "both")
					])
				])
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
				r.or([
					r.lt(y.distance, x.distance),
					r.and([r.eq(y.distance, x.distance), r.le(y.lesson, x.lesson)])
				])
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
			.where(r.or([r.gt(y.rank, x.rank), r.and([r.eq(y.rank, x.rank), r.le(y.lesson, x.lesson)])]))
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

/**
 * A route's lessons by their keys, the read a catalog serves beside its searches: an equality on the route's app and
 * subject, whose B-tree the read earns, so the route's filters have an index of their own, which the arms' fenced
 * streams never read (lower/shapes/vector fenceOf, lower/shapes/search searchFenced), and the declared statistics price
 * the app and the subject as the anchors that index leads with.
 */
const route = query(Catalog).rule((r) => {
	const { lesson, subject, app } = v(Lesson, "lesson")
	return r
		.match(Lesson, { lesson, subject, app })
		.where(
			r.and([
				r.eq(app, r.param("app", Lesson.fields.app)),
				r.eq(subject, r.param("subject", Lesson.fields.subject))
			])
		)
		.find({ lesson })
})

/** The programs the fixture's login serves: the record, the hybrid alone, and a route's lessons. */
const programs = { step, hybrid, route } as const

export const hybridInstall = { label: "hybrid", programs } as const

/** Catalog installed once per member (reads/support.ts fixtureTemplate), which each case's own clone holds. */
export const hybridTemplate = fixtureTemplate(import.meta, Catalog, hybridInstall)

/** The seeded catalog's installation: the same programs, under a label of its own. */
export const seededInstall = { label: "hybrid-seeded", programs } as const

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

/** A catalog: how many lessons, how many subjects and apps they span, and the number their fields and embeddings are drawn from. */
export interface CatalogSpec {
	readonly lessons: number
	readonly subjects: number
	readonly apps: number
	readonly draw: number
}

/**
 * Where a case's catalog stands: drawn by the case, which loads it into its own clone of hybridTemplate; or the seeded
 * catalog (`seededCatalog`), which hybridSeededTemplate's build loads once per member, each case's clone holding it.
 */
export type Population =
	| { readonly kind: "drawn"; readonly catalog: CatalogSpec }
	| { readonly kind: "seeded" }

/** A case: its catalog's population, and up to eight probes of it. */
export interface HybridCase {
	readonly population: Population
	readonly probes: Arr.NonEmptyReadonlyArray<Probe>
}

/**
 * The most lessons a small case holds, and how many subjects and apps they span: few enough that a case loads in a
 * moment. A small case's nearest arm reads its relation whole and sorted, exactly, its route's filters above the ordered
 * stream (lower/shapes/vector fenceOf); a large case's, the seeded catalog's 2^16 lessons (`seededCatalog`), reads the
 * stream from the HNSW index, so the route's filters meet the index's iterative scan: PostgreSQL drives the stream from the
 * index once the relation holds more rows than the index scan costs over a sorted read of all, on PostgreSQL 19 with
 * pgvector 0.8.7 over eight dimensions a sorted read up to 40,000 rows and the index from 50,000
 * (~/.cache/grizzle/DECLSTATS-work/fence/run5.log, 2026-11-23). Measured before the stream was fenced, over 40,000 routes
 * with the HNSW index forced, strict_order filled min(12, the lessons the route admits) in all, hnsw.iterative_scan =
 * off underfilled 113, the route's filters cutting hnsw.ef_search's 40 candidates below the bound (lane FTSG2,
 * 2026-11-21).
 */
const mostLessons = 2400

/**
 * The large catalog, 2^16 lessons over two subjects and two apps, past the 50,000 rows from which PostgreSQL drives the
 * nearest arm's stream from the HNSW index (`mostLessons`), seeded once per member (hybridSeededTemplate), where each
 * large case loaded a catalog of its own: an insert into Lesson walks its HNSW graph, pgvector's ef_construction
 * candidates and their 2m neighbours, 1,760 buffer hits and 0.77 ms of its backend's CPU a row on PostgreSQL 19 with
 * pgvector 0.8.7 (an INSERT of 1,000 lessons, EXPLAIN ANALYZE: 767 ms), so a case of 69,261 lessons spent 53 s of
 * backend CPU loading them and 7 s of its own, past the runner's 60 s case deadline, which counts the backends a case's
 * sockets hold since 875c04cf22 (lane TOOLBUMP), before its first probe (lane REDB, 2026-11-27).
 */
export const seededCatalog: CatalogSpec = { lessons: 2 ** 16, subjects: 2, apps: 2, draw: 1 }

/** A case's catalog, its own or the seeded one. */
export const catalogOf = (population: Population): CatalogSpec =>
	population.kind === "drawn" ? population.catalog : seededCatalog

/** A catalog drawn by a case of `lessons` lessons over one or two subjects and apps. */
const drawnGen =
	(lessons: Gen<number>): Gen<Population> =>
	(s) => ({
		kind: "drawn",
		catalog: {
			lessons: s.draw(lessons),
			subjects: s.draw(int(1, 2)),
			apps: s.draw(int(1, 2)),
			draw: s.draw(int(0, 2 ** 31 - 1))
		}
	})

export const hybridCaseGen: Gen<HybridCase> = (s) => {
	const population = s.draw(
		weighted<Population>([
			[3, drawnGen(int(1600, mostLessons))],
			[1, drawnGen(int(0, 80))],
			[1, () => ({ kind: "seeded" })]
		])
	)
	const { subjects, apps } = catalogOf(population)
	return {
		population,
		probes: [
			s.draw(probeGen(subjects, apps)),
			...s.draw(array(probeGen(subjects, apps), { min: 0, max: 7 }))
		]
	}
}

/** A vector of the fixture's dimensions from a number. */
export const vectorOf = (n: number) =>
	Vector.make(Float32Array.from(unitVector(generator(n))), dimensions)

/** A catalog's facts: each lesson by its position, its route, texts and embedding drawn from the catalog's number. */
export const catalogFacts = (c: CatalogSpec): FactSet => {
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

/**
 * The facts a case loads into its own clone: its drawn catalog's, or none over the seeded catalog, which its clone
 * holds.
 */
export const hybridFacts = (c: HybridCase): FactSet =>
	c.population.kind === "drawn" ? catalogFacts(c.population.catalog) : {}

/**
 * The CPU the seeded catalog's template's open may spend: its build, the install and the seeded catalog's 2^16 lessons
 * loaded, their backend's HNSW walk the most of it, or its first clone.
 *
 * @limitKind measured
 * @owner test/pg/search/hybrid.fixtures.ts hybridSeededTemplate
 * @unit milliseconds of CPU as the runner's meter reads it: the worker's, its descendants' and its backends'
 * @scope each open of hybridSeededTemplate on one worker
 * @evidence `toolchain-test run test/pg/search/hybrid.test.ts` with an uncommitted print at the end of the template's
 *   install (install-migrate.ts generatedTemplateOf): the worker's CPU from the install's start and the CPU of the
 *   template database's backends then alive, the load's among them (lane REDB's hyb3.log, build.txt)
 * @observed 2026-11-27 13:20Z to 13:25Z
 * @environment cassowary, Ubuntu 26.04 (Linux 7.0.0) on an AWS Graviton3 (arm64) instance with 64 logical CPUs and
 *   247 GiB, Node 26.13.1, PostgreSQL 19.0 with pgvector 0.8.7; grizzle b0737bd3f9 with this change, toolchain
 *   54e53afbe; load 345 to 420
 * @workload the property's one readying, its two templates built: hybridTemplate and this one
 * @result this template's install and seed: 3.3 s of the worker's CPU and 71.8 s of the load's backend, 92.6 s of wall
 *   time; hybridTemplate's whole install 2.5 s of the worker's and 4.0 s of wall time, the drafting every worker
 *   computes beside it a few seconds more
 * @decision 160 s: twice the open the print read, 75.1 s, and the drafting beside it, rounded up. An open past it has
 *   regressed
 * @revalidate a larger seeded catalog, another HNSW index setting or pgvector version, another machine, a PostgreSQL or
 *   Node upgrade, a change of the runner's meter, the template reported unopened over its budget
 */
const seededBudget = 160_000

/**
 * The seeded catalog installed and loaded once per member (install-migrate.ts seededGeneratedTemplate), which each
 * large case's own clone holds.
 */
export const hybridSeededTemplate = seededGeneratedTemplate(
	fixtureSpec(import.meta, Catalog, seededInstall),
	(installed) => loadMigrated(installed, catalogFacts(seededCatalog)),
	seededBudget
)

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
