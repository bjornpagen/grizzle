/** What the properties of search.test.ts read: its schema, programs, populations, references and plan readers. */

import { indices } from "@bjornpagen/grizzle-text/base/array"
import { array, element, type Gen, int, weighted } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Order } from "effect"
import type { ExecutedPlan, ExecutedStatement } from "#adapter/types/db.ts"
import { planNodes } from "#bench/harness/explain.ts"
import { Search } from "#compiler/public/compute.ts"
import { pg, searchDocument } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import type { Installed } from "#test/support/install-migrate.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import type { FactSet } from "#test/support/oracle/install/load.ts"
import { fixtureTemplate } from "#test/support/pg/reads/support.ts"
import { textRows } from "#test/support/pg/vector/ann/support.ts"
import type { RawSession } from "#test/support/substrate/session.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * Full text search on PostgreSQL 19 (ir/search.ts): a catalog of lessons whose title and summary PostgreSQL parses into
 * a search document under the english configuration, the title's positions weighted A and the summary's B, and a
 * note's body under simple, weighted D, each a generated field a GIN index serves the matches of.
 *
 * - Lesson(lesson, subject, grade, title, summary, search): a subject's lessons by grade, `search` the document.
 * - Note(note, body, search): one text under the simple configuration, which stems nothing and drops no stop word.
 * - A population is drawn per case: its lessons' and notes' texts are words of a small dictionary of stems, stop
 *   words, inflections, case, compounds and letters past ASCII, so a query meets documents a stem joins and a stop word
 *   does not, and a rare marker word some few documents hold, which a query of it selects alone.
 */
const Prose = str.regex("^.*$", "su")

/** A query's text: within 4,096 bytes, well inside what a query parses (ir/search.ts textQueryMaxBytes). */
const QueryText = str.bytes(4096, str.regex("^.*$", "su"))

const Lesson = relation.generated(
	"Lesson",
	{ lesson: pg.integer, subject: pg.integer, grade: pg.integer, title: Prose, summary: Prose },
	["lesson"],
	(r) => ({ search: searchDocument("english", ["A", r.title], ["B", r.summary]) })
)

const Note = relation.generated("Note", { note: pg.integer, body: Prose }, ["note"], (r) => ({
	search: searchDocument("simple", ["D", r.body])
}))

export const Catalog = schema("Catalog", [Lesson, Note], [])

/** A subject's lessons up to a grade that match a websearch query, each with both ranks. */
const matching = query(Catalog).rule((r) => {
	const { lesson, subject, grade, search } = v(Lesson, "lesson")
	const q = Search.websearch(r.param("q", QueryText))
	return r
		.match(Lesson, { lesson, subject, grade, search })
		.where(
			r.and([
				Search.matches(search, q),
				r.eq(subject, r.param("subject", Lesson.fields.subject)),
				r.le(grade, r.param("grade", Lesson.fields.grade))
			])
		)
		.find({ lesson, rank: Search.rank(search, q), cover: Search.rankCd(search, q) })
})

/** The `take` best lessons of a subject up to a grade for a websearch query, best first, ties by lesson. */
const ranked = query(Catalog)
	.rule((r) => {
		const { lesson, subject, grade, search } = v(Lesson, "lesson")
		const q = Search.websearch(r.param("q", QueryText))
		return r
			.match(Lesson, { lesson, subject, grade, search })
			.where(
				r.and([
					Search.matches(search, q),
					r.eq(subject, r.param("subject", Lesson.fields.subject)),
					r.le(grade, r.param("grade", Lesson.fields.grade))
				])
			)
			.find({ lesson, rank: Search.rank(search, q) })
	})
	.orderBy(["rank", "desc"])
	.take("take")

/** The notes every word of a plain query matches, with their cover density rank. */
const plainNotes = query(Catalog).rule((r) => {
	const { note, search } = v(Note, "note")
	const q = Search.plain(r.param("q", QueryText))
	return r
		.match(Note, { note, search })
		.where(Search.matches(search, q))
		.find({ note, cover: Search.rankCd(search, q) })
})

/** Every lesson's stored document, as PostgreSQL prints it. */
const documents = query(Catalog).rule((r) => {
	const { lesson, search } = v(Lesson, "lesson")
	return r.match(Lesson, { lesson, search }).find({ lesson, search })
})

/**
 * A subject's lessons up to a grade, the read a catalog serves beside its searches: an equality on the subject and a
 * range of grades, whose B-tree the read earns, so the searches' filters have an index of their own, which a search's
 * fenced match never reads (lower/shapes/search searchFenced), and the declared statistics price the subject as the
 * anchor that index leads with.
 */
const ofSubject = query(Catalog).rule((r) => {
	const { lesson, subject, grade } = v(Lesson, "lesson")
	return r
		.match(Lesson, { lesson, subject, grade })
		.where(
			r.and([
				r.eq(subject, r.param("subject", Lesson.fields.subject)),
				r.le(grade, r.param("grade", Lesson.fields.grade))
			])
		)
		.find({ lesson })
})

const programs = { matching, ranked, plainNotes, documents, ofSubject } as const

export const searchInstall = { label: "search", programs } as const

/** Catalog installed once per member (reads/support.ts fixtureTemplate), which each case's own clone holds. */
export const searchTemplate = fixtureTemplate(import.meta, Catalog, searchInstall)

/**
 * The words a text is drawn of: inflections of a few stems, which english stems to one lexeme and simple keeps apart;
 * stop words, which english drops; letters of either case; hyphenated compounds, which the parser reads whole and in
 * parts; letters past ASCII; numbers.
 */
const vocabulary = [
	"run",
	"running",
	"runs",
	"ran",
	"runner",
	"cat",
	"cats",
	"Cat",
	"graph",
	"graphs",
	"Graphing",
	"GRAPH",
	"fraction",
	"fractions",
	"fractional",
	"add",
	"adding",
	"addition",
	"the",
	"a",
	"and",
	"of",
	"self-test",
	"x-ray",
	"café",
	"naïve",
	"über",
	"3",
	"42"
] as const

/** The marker words, each held by few documents, so a query of one selects few rows of many. */
const markers = ["zymurgy", "quixotic", "fjord"] as const

/** What may stand between two words of a text: a punctuation mark, a line break or a dash beside a space. */
const marks = [", ", ". ", "\n", " - "] as const

/** A separator of two words: a space, three times as often as any other mark. */
const separatorGen: Gen<string> = weighted<string>([
	[3, () => " "],
	[1, element(marks)]
])

/** A text of `min` to `max` dictionary words, each after a separator. */
const textOf =
	(min: number, max: number): Gen<string> =>
	(s) => {
		const words = s.draw(array(element(vocabulary), { min, max }))
		return Arr.join(
			Arr.map(words, (w, i) => (i === 0 ? w : `${s.draw(separatorGen)}${w}`)),
			""
		)
	}

/** A lesson as a case draws it, its key its position. */
export interface DrawnLesson {
	readonly subject: number
	readonly grade: number
	readonly title: string
	readonly summary: string
}

/** A population: its lessons and notes' bodies, and which lessons hold which marker. */
export interface Population {
	readonly lessons: ReadonlyArray<DrawnLesson>
	readonly notes: ReadonlyArray<string>
}

const lessonGen: Gen<DrawnLesson> = (s) => ({
	subject: s.draw(int(0, 2)),
	grade: s.draw(int(0, 12)),
	title: s.draw(textOf(1, 5)),
	summary: s.draw(textOf(0, 10))
})

/** A websearch query's term: a word, a negated word, a quoted phrase of two words, or `or`. */
const websearchTermGen: Gen<string> = (s) =>
	s.draw(
		weighted<string>([
			[6, element(vocabulary)],
			[2, (t) => `-${t.draw(element(vocabulary))}`],
			[2, (t) => `"${t.draw(element(vocabulary))} ${t.draw(element(vocabulary))}"`],
			[1, () => "or"],
			[1, element(markers)]
		])
	)

/** A probe of a population: a websearch query's text, a plain one's, a subject, a grade and a bound. */
export interface Probe {
	readonly websearch: string
	readonly plain: string
	readonly subject: number
	readonly grade: number
	readonly take: number
}

const probeGen: Gen<Probe> = (s) => ({
	websearch: Arr.join(s.draw(array(websearchTermGen, { min: 1, max: 4 })), " "),
	plain: s.draw(textOf(1, 3)),
	subject: s.draw(int(0, 3)),
	grade: s.draw(int(0, 12)),
	take: s.draw(int(1, 8))
})

/** A case: a population of up to forty lessons and twenty notes, and up to six probes of it. */
export interface SearchCase {
	readonly population: Population
	readonly probes: Arr.NonEmptyReadonlyArray<Probe>
}

export const searchCaseGen: Gen<SearchCase> = (s) => ({
	population: {
		lessons: s.draw(array(lessonGen, { min: 0, max: 40 })),
		notes: s.draw(array(textOf(0, 6), { min: 0, max: 20 }))
	},
	probes: [s.draw(probeGen), ...s.draw(array(probeGen, { min: 0, max: 5 }))]
})

/** A population's facts: each lesson and note by its position. */
export const populationFacts = (p: Population): FactSet => ({
	Lesson: Arr.map(p.lessons, (l, lesson) => ({ lesson, ...l })),
	Note: Arr.map(p.notes, (body, note) => ({ note, body }))
})

/**
 * A population at scale: `count` lessons whose texts the dictionary fills, every `rarity`th holding a marker word, so
 * a query of a marker matches a few lessons among many, the case a GIN index serves.
 */
export interface Scaled {
	readonly count: number
	readonly rarity: number
	readonly marker: (typeof markers)[number]
	readonly draw: number
}

/**
 * The most lessons a scaled case holds: enough that a match of a marker word, which few of them hold, reads a small
 * part of the table, and few enough that a case loads in a moment.
 */
const mostLessons = 4000

export const scaledGen: Gen<Scaled> = (s) => ({
	count: s.draw(int(2000, mostLessons)),
	rarity: s.draw(int(200, 800)),
	marker: s.draw(element(markers)),
	draw: s.draw(int(0, 2 ** 31 - 1))
})

/** A scaled population's facts: lesson i's title a word of the dictionary by i, its summary the marker where i is a multiple of the rarity. */
export const scaledFacts = (c: Scaled): FactSet => ({
	Lesson: Arr.map(indices(c.count), (lesson) => ({
		lesson,
		subject: lesson % 3,
		grade: lesson % 13,
		title: `${vocabulary[(lesson + c.draw) % vocabulary.length] ?? "run"} ${vocabulary[(lesson * 7 + c.draw) % vocabulary.length] ?? "cat"}`,
		summary: lesson % c.rarity === 0 ? `${c.marker} of the graph` : "the graph of a fraction"
	})),
	Note: []
})

/**
 * Vacuums and analyzes Lesson once its lessons are loaded, as production's runbook analyzes an installation after its
 * first load: the planner reads its size and its columns' statistics, and its GIN index holds every entry in its tree.
 * grizzle emits no ANALYZE; this fixture models the production it plans for, where a plan read with no statistics would
 * estimate a subject's equality and a grade's range at PostgreSQL's defaults, a third of a half percent of the rows,
 * and read every lesson of the subject through the (subject, grade) index beside the 4 the GIN finds.
 */
export const analyzed = (installed: Installed) =>
	Effect.flatMap(Substrate, (s) =>
		s.admin.query(`VACUUM (ANALYZE) ${namesOf(installed).table(Lesson)}`, [])
	)

/** The reference's text of an english document of a lesson, PostgreSQL's own parse of its stored texts. */
const lessonDocument = (installed: Installed): string => {
	const n = namesOf(installed)
	return `(pg_catalog.setweight(pg_catalog.to_tsvector('pg_catalog.english'::pg_catalog.regconfig, l.${n.column(Lesson, "title")}), 'A') OPERATOR(pg_catalog.||) pg_catalog.setweight(pg_catalog.to_tsvector('pg_catalog.english'::pg_catalog.regconfig, l.${n.column(Lesson, "summary")}), 'B'))`
}

/**
 * The reference of `matching`: PostgreSQL's own match and ranks of each lesson's texts, parsed in the statement from
 * the stored title and summary, never the stored document, under the subject and grade filters, as (lesson, rank,
 * cover) texts in key order, each rank's real widened exactly to a double.
 */
export const referenceMatching = (session: RawSession, installed: Installed, probe: Probe) => {
	const n = namesOf(installed)
	const doc = lessonDocument(installed)
	const q = `pg_catalog.websearch_to_tsquery('pg_catalog.english'::pg_catalog.regconfig, $1::text)`
	return Effect.map(
		session.values(
			`SELECT l.${n.column(Lesson, "lesson")}::text, pg_catalog.ts_rank(${doc}, ${q})::float8::text, pg_catalog.ts_rank_cd(${doc}, ${q})::float8::text
			 FROM ${n.table(Lesson)} AS l
			 WHERE ${doc} @@ ${q} AND l.${n.column(Lesson, "subject")} = $2::int4 AND l.${n.column(Lesson, "grade")} <= $3::int4
			 ORDER BY l.${n.column(Lesson, "lesson")}`,
			[probe.websearch, probe.subject, probe.grade]
		),
		textRows
	)
}

/** The reference of `ranked`: referenceMatching's lessons ordered by rank, best first, ties by lesson, the first `take`. */
export const referenceRanked = (session: RawSession, installed: Installed, probe: Probe) => {
	const n = namesOf(installed)
	const doc = lessonDocument(installed)
	const q = `pg_catalog.websearch_to_tsquery('pg_catalog.english'::pg_catalog.regconfig, $1::text)`
	return Effect.map(
		session.values(
			`SELECT l.${n.column(Lesson, "lesson")}::text, pg_catalog.ts_rank(${doc}, ${q})::float8::text
			 FROM ${n.table(Lesson)} AS l
			 WHERE ${doc} @@ ${q} AND l.${n.column(Lesson, "subject")} = $2::int4 AND l.${n.column(Lesson, "grade")} <= $3::int4
			 ORDER BY pg_catalog.ts_rank(${doc}, ${q}) DESC, l.${n.column(Lesson, "lesson")}
			 LIMIT $4::int8`,
			[probe.websearch, probe.subject, probe.grade, probe.take]
		),
		textRows
	)
}

/** The reference of `plainNotes`: PostgreSQL's own plain match and cover density of each note's body under simple. */
export const referencePlainNotes = (session: RawSession, installed: Installed, probe: Probe) => {
	const n = namesOf(installed)
	const doc = `pg_catalog.setweight(pg_catalog.to_tsvector('pg_catalog.simple'::pg_catalog.regconfig, t.${n.column(Note, "body")}), 'D')`
	const q = `pg_catalog.plainto_tsquery('pg_catalog.simple'::pg_catalog.regconfig, $1::text)`
	return Effect.map(
		session.values(
			`SELECT t.${n.column(Note, "note")}::text, pg_catalog.ts_rank_cd(${doc}, ${q})::float8::text
			 FROM ${n.table(Note)} AS t
			 WHERE ${doc} @@ ${q}
			 ORDER BY t.${n.column(Note, "note")}`,
			[probe.plain]
		),
		textRows
	)
}

/** The reference of `documents`: each lesson's english document as PostgreSQL parses and prints it, in key order. */
export const referenceDocuments = (session: RawSession, installed: Installed) => {
	const n = namesOf(installed)
	return Effect.map(
		session.values(
			`SELECT l.${n.column(Lesson, "lesson")}::text, (${lessonDocument(installed)})::text
			 FROM ${n.table(Lesson)} AS l ORDER BY l.${n.column(Lesson, "lesson")}`,
			[]
		),
		textRows
	)
}

/** A rank as the reference spells it: the real's exact double, as PostgreSQL prints a double. */
export const rankText = (rank: number): string => `${rank}`

/** Rows sorted by their first cell's integer, the key order the references read. */
export const byKey = (
	rows: ReadonlyArray<ReadonlyArray<string>>
): ReadonlyArray<ReadonlyArray<string>> =>
	Arr.sort(
		rows,
		Order.mapInput(Order.Number, (row: ReadonlyArray<string>) => Number(row[0]))
	)

/** What an executed member's plans say of its reads of Lesson: the GIN index's scans, any other read, and the buffers. */
export interface LessonReads {
	readonly statements: number
	readonly gin: ReadonlyArray<ExecutedPlan>
	readonly sequential: ReadonlyArray<ExecutedPlan>
	readonly buffers: number
}

/**
 * The reads of Lesson a member's executed statements make: its scans of the GIN index its matches requested, as the
 * served file names it; its sequential scans of the table; and every buffer its nodes touched, hit or read.
 */
export const lessonReads = (
	installed: Installed,
	statements: ReadonlyArray<ExecutedStatement>
): LessonReads => {
	const gin = namesOf(installed).accessIndex(Lesson, ["search"])
	const nodes = Arr.flatMap(statements, (s) => [...planNodes(s.plan)])
	return {
		statements: statements.length,
		gin: Arr.filter(
			nodes,
			(n) => n.on.kind === "index" && n.on.relation === "Lesson" && n.on.index.name === gin
		),
		sequential: Arr.filter(
			nodes,
			(n) => n.node === "Seq Scan" && n.on.kind === "relation" && n.on.relation === "Lesson"
		),
		buffers: Arr.reduce(
			Arr.map(statements, (s) => s.plan.buffers.sharedHit + s.plan.buffers.sharedRead),
			0,
			(a, b) => a + b
		)
	}
}
