/** What the properties of nearest.test.ts read: its schema, programs, populations and helpers. */

import { indices } from "@bjornpagen/grizzle-text/base/array"
import { array, element, type Gen, int, weighted } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect } from "effect"
import type { ExecutedPlan, ExecutedStatement } from "#adapter/types/db.ts"
import { planNodes } from "#bench/harness/explain.ts"
import { Distance } from "#compiler/public/compute.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { Vector } from "#compiler/scalar/values/vector.ts"
import { printObjectName } from "#compiler/sql/print.ts"
import { fixtureTemplate } from "#test/pg/reads/support.ts"
import { dimensions, generator, unitVector, vectorText } from "#test/pg/vector/ann/support.ts"
import type { Installed } from "#test/support/install-migrate.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import type { FactSet } from "#test/support/oracle/install/load.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * Nearest reads on PostgreSQL 19 with pgvector, as an assignment engine makes them: the lessons of a catalog nearest the
 * stored vector of one item, by the item's key, and a step's reads, a search among them, as one record.
 *
 * - Lesson(lesson, catalog, embedding) is the searched relation, its embedding under the HNSW index the workload's
 *   searches request; Item(item, catalog, embedding) the anchors a search takes its query vector from, keyed by item;
 *   Seen(learner, lesson) a plain relation a record reads beside a search.
 * - The population is drawn per case: the counts of lessons, catalogs, items and learners, and every vector from a drawn
 *   number (populationFacts), unit vectors of exact binary32 components, so a stored vector reads back as the very
 *   value written, as the approximate-retrieval fixture draws its own (test/pg/vector/ann/support.ts).
 * - A probe names an item that is stored or one that is not, a catalog, which may hold no lesson, and a learner.
 */
const Embedding = pg.vector(dimensions)

const Lesson = relation(
	"Lesson",
	{ lesson: pg.integer, catalog: pg.integer, embedding: Embedding },
	["lesson"]
)

const Item = relation("Item", { item: pg.integer, catalog: pg.integer, embedding: Embedding }, [
	"item"
])

const Seen = relation("Seen", { learner: pg.integer, lesson: pg.integer }, ["learner", "lesson"])

export const Nearest = schema("Nearest", [Lesson, Item, Seen], [])

/** The bound of every search here. */
export const take = 10

/**
 * The lessons of a catalog nearest the stored vector of one item: the item matched by its key, a parameter, so its
 * vector is the query vector (check/approximate/trace.ts Anchor).
 */
const fromItem = query(Nearest)
	.rule((r) => {
		const { lesson, catalog, embedding } = v(Lesson, "lesson")
		const item = v(Item, "item")
		return r
			.match(Item, { item: r.param("item", Item.fields.item), embedding: item.embedding })
			.match(Lesson, { lesson, catalog, embedding })
			.where(r.eq(catalog, r.param("catalog", Lesson.fields.catalog)))
			.find({ lesson, distance: Distance.cosine(embedding, item.embedding) })
	})
	.approximateNearest({ by: "distance", take })

/**
 * The lessons of the item's own catalog nearest its vector: the item's key fixed by a `where`, a filter above the
 * region rather than a constant of its match, the item's catalog, a field of the anchor beside its vector, joining
 * the candidates, and the query vector standing first in the distance.
 */
const sameCatalog = query(Nearest)
	.rule((r) => {
		const { lesson, catalog, embedding } = v(Lesson, "lesson")
		const item = v(Item, "item")
		return r
			.match(Item, { item: item.item, catalog, embedding: item.embedding })
			.match(Lesson, { lesson, catalog, embedding })
			.where(r.eq(item.item, r.param("item", Item.fields.item)))
			.find({ lesson, distance: Distance.cosine(item.embedding, embedding) })
	})
	.approximateNearest({ by: "distance", take })

/** The reference's first step: the item's catalog and vector, by its key. */
const itemRow = query(Nearest).rule((r) => {
	const { catalog, embedding } = v(Item, "item")
	return r
		.match(Item, { item: r.param("item", Item.fields.item), catalog, embedding })
		.find({ catalog, embedding })
})

/** The reference's second step: the lessons of a catalog nearest a query vector, a parameter. */
const byVector = query(Nearest)
	.rule((r) => {
		const { lesson, catalog, embedding } = v(Lesson, "lesson")
		return r
			.match(Lesson, { lesson, catalog, embedding })
			.where(r.eq(catalog, r.param("catalog", Lesson.fields.catalog)))
			.find({
				lesson,
				distance: Distance.cosine(embedding, r.param("vector", Lesson.fields.embedding))
			})
	})
	.approximateNearest({ by: "distance", take })

/** The lessons a learner has seen, latest first: an ordered read, whose array a record delivers in its order. */
const seen = query(Nearest)
	.rule((r) => {
		const { lesson } = v(Seen, "seen")
		return r
			.match(Seen, { learner: r.param("learner", Seen.fields.learner), lesson })
			.find({ lesson })
	})
	.orderBy(["lesson", "desc"])

/** A step's reads as one record: the search from an item, the learner's seen lessons, and the item itself. */
const reads = query(Nearest).reads({ nearest: fromItem, seen, item: itemRow })

/**
 * The programs the fixture's login serves: each read on its own, and the record, as a step's reads are.
 * Their searches justify the HNSW index on Lesson's embedding.
 */
const programs = {
	fromItem,
	sameCatalog,
	itemRow,
	byVector,
	seen,
	reads
} as const

export const nearestInstall = { label: "nearest", programs } as const

/** Nearest installed once per member (reads/support.ts fixtureTemplate), which each case's own clone holds. */
export const nearestTemplate = fixtureTemplate(import.meta, Nearest, nearestInstall)

/**
 * A case's population: how many lessons, catalogs, items and learners, and the number its vectors and its seen
 * lessons are drawn from.
 */
export interface Population {
	readonly lessons: number
	readonly catalogs: number
	readonly items: number
	readonly learners: number
	readonly draw: number
}

/**
 * A probe: an item by its position among the stored ones, or one past them, which no row holds; a catalog, of the
 * population's or the one past them, which holds no lesson; a learner, of the population's or one past them.
 */
export interface Probe {
	readonly item: number
	readonly catalog: number
	readonly learner: number
}

export interface NearestCase {
	readonly population: Population
	readonly probes: Arr.NonEmptyReadonlyArray<Probe>
}

/**
 * The most lessons a case holds: enough that PostgreSQL's planner prefers the HNSW index for a catalog's nearest ten
 * over a scan and a sort once the table is analyzed, as it does from about 1,500 rows of eight dimensions over three
 * catalogs (measured on PostgreSQL 19 with pgvector 0.8.7), and few enough that a case loads in a moment.
 */
const mostLessons = 2400

const populationGen: Gen<Population> = (source) => ({
	lessons: source.draw(
		weighted<number>([
			[3, int(1600, mostLessons)],
			[1, int(1, 200)]
		])
	),
	catalogs: source.draw(int(1, 3)),
	items: source.draw(int(1, 8)),
	learners: source.draw(int(1, 4)),
	draw: source.draw(int(0, 2 ** 31 - 1))
})

const probeGen =
	(p: Population): Gen<Probe> =>
	(source) => ({
		item: source.draw(
			weighted<number>([
				[3, int(0, p.items - 1)],
				[1, element([p.items])]
			])
		),
		catalog: source.draw(int(0, p.catalogs)),
		learner: source.draw(int(0, p.learners))
	})

/** A population and its probes: one, then up to five more, each read against the one load. */
export const nearestCaseGen: Gen<NearestCase> = (source) => {
	const population = source.draw(populationGen)
	const first = source.draw(probeGen(population))
	const more = source.draw(array(probeGen(population), { min: 0, max: 5 }))
	return { population, probes: [first, ...more] }
}

/** A vector of the fixture's dimensions. */
const vectorOf = (components: ReadonlyArray<number>) =>
	Vector.make(Float32Array.from(components), dimensions)

/**
 * The population's facts: each lesson in a catalog by its position, each item too, each with a unit vector drawn from
 * the population's number, the first item's vector a lesson's own, so a search from it meets a distance of zero, and
 * each learner having seen the lessons the draw picks.
 */
export const populationFacts = (p: Population): FactSet => {
	const next = generator(p.draw)
	const lessons = Arr.map(indices(p.lessons), (i) => ({
		lesson: i,
		catalog: i % p.catalogs,
		embedding: unitVector(next)
	}))
	const [firstLesson] = lessons
	const items = Arr.map(indices(p.items), (j) => ({
		item: j,
		catalog: j % p.catalogs,
		embedding: j === 0 && firstLesson !== undefined ? firstLesson.embedding : unitVector(next)
	}))
	const seenRows = Arr.flatMap(indices(p.learners), (learner) =>
		Arr.flatMap(indices(p.lessons), (lesson) =>
			next() < 8 / Math.max(p.lessons, 8) ? [{ learner, lesson }] : []
		)
	)
	return {
		Lesson: Arr.map(lessons, (l) => ({ ...l, embedding: vectorOf(l.embedding) })),
		Item: Arr.map(items, (i) => ({ ...i, embedding: vectorOf(i.embedding) })),
		Seen: seenRows
	}
}

/** Analyzes the population's tables, so the planner reads their sizes, as a deployment's autovacuum would. */
export const analyzed = (installed: Installed) =>
	Effect.flatMap(Substrate, (s) =>
		Effect.forEach(
			["Lesson", "Item", "Seen"],
			(r) =>
				s.admin.query(`ANALYZE ${printObjectName(installed.installation.names.relation(r))}`, []),
			{ discard: true }
		)
	)

/**
 * The nodes of a member's executed statements that read Lesson through the HNSW index its searches requested, as the
 * served file names it, and whether the member sent one statement.
 */
export const hnswScans = (
	installed: Installed,
	statements: ReadonlyArray<ExecutedStatement>
): { readonly statements: number; readonly scans: ReadonlyArray<ExecutedPlan> } => {
	const hnsw = namesOf(installed).accessIndex(Lesson, ["embedding"])
	return {
		statements: statements.length,
		scans: Arr.filter(
			Arr.flatMap(statements, (s) => [...planNodes(s.plan)]),
			(n) => n.on.kind === "index" && n.on.relation === "Lesson" && n.on.index.name === hnsw
		)
	}
}

/** A search's candidates as a set's members: each lesson with its distance, exact text of the double. */
export const candidateTexts = (
	rows: Iterable<{ readonly lesson: number; readonly distance: number }>
): ReadonlyArray<string> =>
	Arr.sort(
		Arr.map([...rows], (r) => `${r.lesson}|${r.distance}`),
		(a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
	)

/** A vector as its text, for a report. */
export const shownVector = (vector: Float32Array): string => vectorText([...vector])
