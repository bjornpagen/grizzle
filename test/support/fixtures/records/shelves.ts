/**
 * Shelves, the source of the records properties (test/types/schema/records.test.ts, test/pg/records/records.test.ts):
 * a shelf's books, each one row of Book, an array a query attaches; each book's blurb, of at most one (an option), its
 * spine, of exactly one (one), with its ink, of exactly one too, its paper or digital detail, the arm of its kind (each
 * mirrored with the books of that kind), and its chapters, an array, each with at most one remark. A book holds a
 * column named `at`, the name an array's place takes first, so a books attachment that heads it moves its place to
 * `at2`.
 */
import { closedId, pg } from "#compiler/public/fields.ts"
import {
	closed,
	contained,
	mirrors,
	on,
	relation,
	schema,
	select
} from "#compiler/public/schema.ts"
import { Id } from "#test/support/ids.ts"

export const Kind = closed.ordered("Kind", ["Paper", "Digital"])
export const Shelf = relation("Shelf", { id: Id, label: pg.integer }, ["id"])
export const Book = relation(
	"Book",
	{ id: Id, shelf: Id, kind: closedId(Kind), pages: pg.integer, at: pg.integer },
	["id"]
)
export const Paper = relation("Paper", { book: Id, grams: pg.integer }, ["book"])
export const Digital = relation("Digital", { book: Id, bytes: pg.bigint }, ["book"])
export const Blurb = relation("Blurb", { book: Id, words: pg.integer }, ["book"])
export const Spine = relation("Spine", { book: Id, color: pg.integer }, ["book"])
export const Ink = relation("Ink", { book: Id, hue: pg.integer }, ["book"])
export const Chapter = relation("Chapter", { book: Id, n: pg.integer, pages: pg.integer }, [
	"book",
	"n"
])
export const Remark = relation("Remark", { book: Id, n: pg.integer, stars: pg.integer }, [
	"book",
	"n"
])

/** Shelves under `name`, as an installation under its allocated name rebuilds it. */
export const shelvesNamed = <const N extends string>(name: N) =>
	schema(
		name,
		[Kind, Shelf, Book, Paper, Digital, Blurb, Spine, Ink, Chapter, Remark],
		[
			contained(on(Book, "shelf"), on(Shelf, "id")),
			mirrors(
				on(Paper, "book"),
				on(
					select(Book, (b) => b.eq(b.kind, "Paper")),
					"id"
				)
			),
			mirrors(
				on(Digital, "book"),
				on(
					select(Book, (b) => b.eq(b.kind, "Digital")),
					"id"
				)
			),
			contained(on(Blurb, "book"), on(Book, "id")),
			mirrors(on(Spine, "book"), on(Book, "id")),
			mirrors(on(Ink, "book"), on(Spine, "book")),
			contained(on(Chapter, "book"), on(Book, "id")),
			contained(on(Remark, "book", "n"), on(Chapter, "book", "n"))
		]
	)

export const Shelves = shelvesNamed("Shelves")
