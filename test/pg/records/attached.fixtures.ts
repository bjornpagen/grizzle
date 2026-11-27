/** What the attachments records property of attached.test.ts reads: its space of shapes and facts, and its case. */

import { array, boolean, element, type Gen, int, option } from "@bjornpagen/testing/gen"
import { Array as Arr, Data, Effect, Formatter, Option, Record as Rec } from "effect"
import { records, recordsFacts, recordsQuery, schema } from "#compiler/public/schema.ts"
import { changeSetOver } from "#compiler/write/changeset/value.ts"
import {
	ownerOf,
	type RecordsShape,
	shapeGen,
	shapeQuery
} from "#test/support/agreement/records.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { readOnce, writeOnce } from "#test/support/calls.ts"
import { levelNameAt } from "#test/support/compile.ts"
import { exactValue } from "#test/support/equivalence.ts"
import { shelvesNamed } from "#test/support/fixtures/records/shelves.ts"
import { type IdValue, toId } from "#test/support/ids.ts"
import { installFullWorld } from "#test/support/installed.ts"
import { member, openServedDb } from "#test/support/served-db.ts"
import { fullWorld } from "#test/support/worlds.ts"

/** One chapter: its pages, and its remark's stars, if it has one. */
interface ChapterFacts {
	readonly pages: number
	readonly remark: Option.Option<number>
}

/**
 * One book: its kind and its columns, its blurb's words if it has one, its spine's color and its ink's hue, and its
 * chapters.
 */
interface BookFacts {
	readonly kind: "Paper" | "Digital"
	readonly pages: number
	readonly at: number
	readonly detail: number
	readonly blurb: Option.Option<number>
	readonly color: number
	readonly hue: number
	readonly chapters: ReadonlyArray<ChapterFacts>
}

/** The facts of a case: the read shelf's books, and whether another shelf holds a book of its own. */
interface ShelvesFacts {
	readonly books: ReadonlyArray<BookFacts>
	readonly other: boolean
}

const small = int(0, 3)

const chapterGen: Gen<ChapterFacts> = (source) => ({
	pages: source.draw(small),
	remark: source.draw(option(small))
})

const bookGen: Gen<BookFacts> = (source) => ({
	kind: source.draw(element(["Paper", "Digital"])),
	pages: source.draw(small),
	at: source.draw(small),
	detail: source.draw(small),
	blurb: source.draw(option(small)),
	color: source.draw(small),
	hue: source.draw(small),
	chapters: source.draw(array(chapterGen, { min: 0, max: 2 }))
})

const factsGen: Gen<ShelvesFacts> = (source) => ({
	books: source.draw(array(bookGen, { min: 0, max: 3 })),
	other: source.draw(boolean)
})

/** A case: the query's shape and the facts it reads. */
export interface AttachedCase {
	readonly shape: RecordsShape
	readonly facts: ShelvesFacts
}

export const attachedCaseGen: Gen<AttachedCase> = (source) => ({
	shape: source.draw(shapeGen),
	facts: source.draw(factsGen)
})

const shelfId = toId("00000000-0000-4000-8000-000000000001")
const otherShelf = toId("00000000-0000-4000-8000-000000000002")
const runId = toId("00000000-0000-4000-8000-0000000000aa")

const bookId = (shelf: number, i: number): IdValue =>
	toId(`00000000-0000-4000-9000-0000000000${shelf}${i}`)

/** Every fact of a case, under each relation's name, as an insert of Shelves takes them. */
const shelvesFacts = (facts: ShelvesFacts): Readonly<Record<string, ReadonlyArray<unknown>>> => {
	const books = [
		...Arr.map(facts.books, (b, i) => ({ id: bookId(1, i), shelf: shelfId, book: b })),
		...(facts.other
			? [
					{
						id: bookId(2, 0),
						shelf: otherShelf,
						book: {
							kind: "Paper",
							pages: 1,
							at: 1,
							detail: 1,
							blurb: Option.some(1),
							color: 1,
							hue: 1,
							chapters: [{ pages: 1, remark: Option.some(1) }]
						} satisfies BookFacts
					}
				]
			: [])
	]
	return {
		Shelf: [{ id: shelfId, label: 1 }, ...(facts.other ? [{ id: otherShelf, label: 2 }] : [])],
		Book: Arr.map(books, ({ id, shelf, book }) => ({
			id,
			shelf,
			kind: book.kind,
			pages: book.pages,
			at: book.at
		})),
		Paper: Arr.flatMap(books, ({ id, book }) =>
			book.kind === "Paper" ? [{ book: id, grams: book.detail }] : []
		),
		Digital: Arr.flatMap(books, ({ id, book }) =>
			book.kind === "Digital" ? [{ book: id, bytes: BigInt(book.detail) }] : []
		),
		Blurb: Arr.flatMap(books, ({ id, book }) =>
			Option.match(book.blurb, { onNone: () => [], onSome: (words) => [{ book: id, words }] })
		),
		Spine: Arr.map(books, ({ id, book }) => ({ book: id, color: book.color })),
		Ink: Arr.map(books, ({ id, book }) => ({ book: id, hue: book.hue })),
		Chapter: Arr.flatMap(books, ({ id, book }) =>
			Arr.map(book.chapters, (c, n) => ({ book: id, n, pages: c.pages }))
		),
		Remark: Arr.flatMap(books, ({ id, book }) =>
			Arr.flatMap(book.chapters, (c, n) =>
				Option.match(c.remark, { onNone: () => [], onSome: (stars) => [{ book: id, n, stars }] })
			)
		)
	}
}

/** The relations of Shelves an insert writes, in its order. */
const shelvesRelations = [
	"Shelf",
	"Book",
	"Paper",
	"Digital",
	"Blurb",
	"Spine",
	"Ink",
	"Chapter",
	"Remark"
] as const

/** A shape's query, its records and the level over Shelves that lists them, all under the installation's `name`. */
const builtAt = (shape: RecordsShape, name: string) => {
	const base = shelvesNamed(name)
	const query = shapeQuery(base, shape)
	const owner = ownerOf(shape)
	const kept = records("Kept", query, owner.fields, owner.key)
	const level = schema.extend([base], levelNameAt(name, 1), [...kept.relations], [...kept.rules])
	return { base, query, kept, level }
}

/** The owner's values of a shape: the run, and its step where the owner has one. */
const ownerValues = (shape: RecordsShape): Readonly<Record<string, unknown>> =>
	shape.owner === "run" ? { run: runId } : { run: runId, step: 1 }

/** The read back of a case's records differs from the rows its query delivered. */
class AttachedDisagreed extends Data.TaggedError("AttachedDisagreed")<{
	readonly message: string
}> {}

/**
 * A case (see attached.test.ts): Shelves and the case's records installed as one installation, the facts inserted, the
 * query read, its rows inserted into the records by their insert and read back by their read, which must be the rows
 * the query delivered, exactly.
 */
export const attachedCase = (c: AttachedCase) =>
	Effect.gen(function* () {
		const declared = builtAt(c.shape, "Shelves")
		const installed = yield* installFullWorld(
			declared.level,
			{},
			{ ambient: ordinarySession, label: "records" }
		)
		const at = builtAt(c.shape, installed.declared)
		/** The relations an insert states apart, as the runtime records hold them: a query built at run time types none. */
		const apart: ReadonlyArray<{ readonly name: string }> = at.kept.apart
		const keptNames = [at.kept.row.name, ...Arr.map(apart, (r) => r.name)]
		const db = yield* openServedDb(installed, fullWorld(at.level, {}).server.roles.app, {})
		const served = yield* db.serve({
			source: changeSetOver
				.empty(at.base)
				.insertAll(Rec.fromEntries(Arr.map(shelvesRelations, (n) => [n, []] as const))),
			found: at.query,
			keep: changeSetOver
				.empty(at.level)
				.insertAll(Rec.fromEntries(Arr.map(keptNames, (n) => [n, []] as const))),
			back: recordsQuery(at.level, at.kept)
		})
		yield* writeOnce(member(served, "source"))({
			params: {},
			facts: { insert: shelvesFacts(c.facts) }
		})
		const found = yield* readOnce(member(served, "found"))({
			params: { shelf: shelfId },
			facts: {}
		})
		const owner = ownerValues(c.shape)
		yield* writeOnce(member(served, "keep"))({
			params: {},
			facts: {
				insert: recordsFacts(at.level, at.kept)(Arr.map(found, (row) => [owner, row] as const))
			}
		})
		const back = yield* readOnce(member(served, "back"))({ params: owner, facts: {} })
		const difference = exactValue(back, found)
		if (Option.isSome(difference)) {
			return yield* new AttachedDisagreed({
				message: `the records read back ${Formatter.format(back)} where the query delivered ${Formatter.format(found)}: ${difference.value}`
			})
		}
		return found
	})
