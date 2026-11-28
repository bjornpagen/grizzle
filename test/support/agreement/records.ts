/**
 * The records properties' space (test/types/schema/records.test.ts, test/pg/records/records.test.ts): a query over
 * Shelves (test/support/fixtures/records/shelves.ts) that reads one shelf, at the parameter `shelf`, and attaches its
 * books as an array, each book with a drawn subset of its blurb (an option or an array), its spine (one, an option or
 * an array, with its ink, one, an option or an array, below it), its paper and digital details (each an option) and its
 * chapters (an array, each with at most one remark, an option or an array): every delivery, at depths one to three. A
 * book's head may hold its column `at`, the name an array's place takes first, and a head literal; its order is its
 * key's or its pages', descending. Each attachment's name is drawn from a dictionary of the names the records' naming
 * branches on: one that repeats elsewhere in the tree, `row`, the root's own, and `at`, so an attachment's relation is
 * qualified by its parent's name and a place moves to `at2`. The owner is a run, or a run and a step, keyed by both.
 *
 * Each shape is built twice: as a query value, through the builder's runtime view (shapeQuery), and as the text of a
 * typed program (shapeText), which states the records' types against the runtime records the value makes.
 */
import { boolean, element, type Gen, option } from "@bjornpagen/testing/gen"
import { Array as Arr, Option, Record as Rec } from "effect"
import { int4 } from "#compiler/public/fields.ts"
import type { RecordOwner } from "#compiler/public/schema.ts"
import {
	type OrderedValue,
	type QueryValue,
	queryOver,
	varsOver
} from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import {
	Blurb,
	Book,
	Chapter,
	Digital,
	Paper,
	Ink,
	Remark,
	Shelf,
	Spine
} from "#test/support/fixtures/records/shelves.ts"
import { Id } from "#test/support/ids.ts"

/** An attachment of the shape: its name and the delivery it states. */
interface Named<D extends string> {
	readonly name: string
	readonly delivery: D
}

/**
 * A book's spine: its attachment's name and delivery, and its ink, if attached. The spine heads its book as its
 * parent's variable, which keys its ink, an option or an array: no one child, since the ink is matched on no variable of
 * the spine's own.
 */
interface SpineShape extends Named<"one" | "option" | "array"> {
	readonly ink: Option.Option<Named<"option" | "array">>
}

/** A book's chapters: their attachment's name, and each chapter's remark, if attached. */
interface ChaptersShape {
	readonly name: string
	readonly remark: Option.Option<Named<"option" | "array">>
}

/** The books attached to the shelf: their name, order and head, and each book's attachments. */
interface BooksShape {
	readonly name: string
	readonly descending: boolean
	readonly at: boolean
	readonly literal: boolean
	readonly blurb: Option.Option<Named<"option" | "array">>
	readonly spine: Option.Option<SpineShape>
	readonly paper: Option.Option<Named<"option">>
	readonly digital: Option.Option<Named<"option">>
	readonly chapters: Option.Option<ChaptersShape>
}

/** A records case's shape: its owner and the shelf's books. */
export interface RecordsShape {
	readonly owner: "run" | "runStep"
	readonly books: BooksShape
}

/** The names an attachment is drawn under: each repeats elsewhere, `row` is the root's, `at` an array place's. */
const names = ["notes", "items", "row", "at", "detail", "extra"] as const

/** A name of the dictionary that none of `taken` is. */
const nameApart =
	(taken: ReadonlyArray<string>): Gen<string> =>
	(source) => {
		const [first, ...rest] = Arr.filter(names, (n) => !taken.includes(n))
		return first === undefined ? "apart" : source.draw(element([first, ...rest]))
	}

/** An attachment drawn apart from `taken`, under one of `deliveries`. */
const namedGen =
	<const D extends string>(
		taken: ReadonlyArray<string>,
		deliveries: readonly [D, ...Array<D>]
	): Gen<Named<D>> =>
	(source) => ({ name: source.draw(nameApart(taken)), delivery: source.draw(element(deliveries)) })

/** The taken names of a drawn sibling, if it is attached. */
const takenBy = (sibling: Option.Option<{ readonly name: string }>): ReadonlyArray<string> =>
	Option.match(sibling, { onNone: () => [], onSome: (s) => [s.name] })

/** The books' shape: its head first, so each attachment's name is drawn apart from its columns and its siblings. */
const booksGen: Gen<BooksShape> = (source) => {
	const at = source.draw(boolean)
	const literal = source.draw(boolean)
	const head = ["id", "kind", "pages", ...(at ? ["at"] : []), ...(literal ? ["source"] : [])]
	const blurb = source.draw(option(namedGen(head, ["option", "array"])))
	const spine = source.draw(
		option((s): SpineShape => ({
			...s.draw(namedGen([...head, ...takenBy(blurb)], ["one", "option", "array"])),
			ink: s.draw(option(namedGen(["book", "color"], ["option", "array"])))
		}))
	)
	const paper = source.draw(
		option(namedGen([...head, ...takenBy(blurb), ...takenBy(spine)], ["option"]))
	)
	const digital = source.draw(
		option(namedGen([...head, ...takenBy(blurb), ...takenBy(spine), ...takenBy(paper)], ["option"]))
	)
	const chapters = source.draw(
		option((s): ChaptersShape => ({
			name: s.draw(
				nameApart([
					...head,
					...takenBy(blurb),
					...takenBy(spine),
					...takenBy(paper),
					...takenBy(digital)
				])
			),
			remark: s.draw(option(namedGen(["book", "n", "pages"], ["option", "array"])))
		}))
	)
	return {
		name: source.draw(nameApart(["id", "label"])),
		descending: source.draw(boolean),
		at,
		literal,
		blurb,
		spine,
		paper,
		digital,
		chapters
	}
}

/** A records case's shape. */
export const shapeGen: Gen<RecordsShape> = (source) => ({
	owner: source.draw(element(["run", "runStep"])),
	books: source.draw(booksGen)
})

/**
 * A records case's shape with the name its author states, if any: for the books' path (true), or for the chapters'
 * (false), the books' where the shape attaches no chapters.
 */
export interface StatedShape {
	readonly shape: RecordsShape
	readonly stated: Option.Option<boolean>
}

/** A records case's shape and the name its author states (StatedShape). */
export const statedShapeGen: Gen<StatedShape> = (source) => ({
	shape: source.draw(shapeGen),
	stated: source.draw(option(boolean))
})

/** The name a stated shape's author states for its path. */
const statedName = "Stated"

/** The path a stated shape's name is stated for, if any: the books', or the chapters' below them. */
export const statedPath = (stated: StatedShape): Option.Option<string> =>
	Option.map(stated.stated, (books) =>
		Option.match(books ? Option.none() : stated.shape.books.chapters, {
			onNone: () => stated.shape.books.name,
			onSome: (c) => `${stated.shape.books.name}.${c.name}`
		})
	)

/** The names a stated shape's records state, by path, as records' options take them. */
export const statedNames = (stated: StatedShape): Readonly<Record<string, string>> =>
	Option.match(statedPath(stated), {
		onNone: () => ({}),
		onSome: (path) => ({ [path]: statedName })
	})

/** The text of a stated shape's options: none where no name is stated. */
export const statedText = (stated: StatedShape): string =>
	Option.match(statedPath(stated), {
		onNone: () => "",
		onSome: (path) => `, { names: { "${path}": "${statedName}" } }`
	})

/** An owner of records: its fields, and its key, a nonempty list of their names. */
interface Owner {
	readonly fields: RecordOwner
	readonly key: readonly [string, ...Array<string>]
}

/** The owner's fields of a shape, and its key. */
export const ownerOf = (shape: RecordsShape): Owner =>
	shape.owner === "run"
		? { fields: { run: Id }, key: ["run"] }
		: { fields: { run: Id, step: int4 }, key: ["run", "step"] }

/** A child over `over` of one rule over `relation`, its parent's fields bound at `bound`, its own matched and found. */
const childOf = (
	over: unknown,
	relation: unknown,
	scope: string,
	bound: Readonly<Record<string, unknown>>,
	own: ReadonlyArray<string>
): QueryValue =>
	queryOver(over).rule((r: RuleValue) => {
		const vars = varsOver(relation, scope)
		const found = Rec.fromEntries(Arr.map(own, (f) => [f, vars[f]] as const))
		return r.match(relation, { ...bound, ...found }).find(found)
	})

/** Each optional attachment of a value, in the order the shape states them. */
const attachEach = (
	q: QueryValue,
	attachments: ReadonlyArray<
		Option.Option<readonly [string, (p: Readonly<Record<string, unknown>>) => unknown, unknown]>
	>
): QueryValue =>
	Arr.reduce(Arr.getSomes(attachments), q, (acc, [name, child, delivery]) =>
		acc.attach(name, child, delivery)
	)

/**
 * A book's chapters over `over`, each with its remark: each heads its own book, held to the parent's by an equality, so
 * its remark is keyed by the chapter's own fields.
 */
const chaptersOf = (
	over: unknown,
	shape: ChaptersShape,
	b: Readonly<Record<string, unknown>>
): QueryValue =>
	attachEach(
		queryOver(over).rule((r: RuleValue) => {
			const { book, n, pages } = varsOver(Chapter, "chapter")
			return r
				.match(Chapter, { book, n, pages })
				.where(r.eq(book, b["id"]))
				.find({ book, n, pages })
		}),
		[
			Option.map(shape.remark, (remark) => [
				remark.name,
				(c: Readonly<Record<string, unknown>>) =>
					childOf(over, Remark, "remark", { book: c["book"], n: c["n"] }, ["stars"]),
				remark.delivery
			])
		]
	)

/** The shelf's books over `over`, each with its drawn attachments, in their drawn order. */
const booksOf = (
	over: unknown,
	shape: BooksShape,
	s: Readonly<Record<string, unknown>>
): QueryValue | OrderedValue => {
	const books = queryOver(over).rule((r: RuleValue) => {
		const { id, kind, pages, at } = varsOver(Book, "book")
		return r.match(Book, { id, shelf: s["id"], kind, pages, at }).find({
			id,
			kind,
			pages,
			...(shape.at ? { at } : {}),
			...(shape.literal ? { source: "shelf" } : {})
		})
	})
	const attached = attachEach(books, [
		Option.map(shape.blurb, (blurb) => [
			blurb.name,
			(b: Readonly<Record<string, unknown>>) =>
				childOf(over, Blurb, "blurb", { book: b["id"] }, ["words"]),
			blurb.delivery
		]),
		Option.map(shape.spine, (spine) => [
			spine.name,
			(b: Readonly<Record<string, unknown>>) =>
				attachEach(
					queryOver(over).rule((r: RuleValue) => {
						const { color } = varsOver(Spine, "spine")
						return r.match(Spine, { book: b["id"], color }).find({ book: b["id"], color })
					}),
					[
						Option.map(spine.ink, (ink) => [
							ink.name,
							(p: Readonly<Record<string, unknown>>) =>
								childOf(over, Ink, "ink", { book: p["book"] }, ["hue"]),
							ink.delivery
						])
					]
				),
			spine.delivery
		]),
		Option.map(shape.paper, (paper) => [
			paper.name,
			(b: Readonly<Record<string, unknown>>) =>
				childOf(over, Paper, "paper", { book: b["id"] }, ["grams"]),
			paper.delivery
		]),
		Option.map(shape.digital, (digital) => [
			digital.name,
			(b: Readonly<Record<string, unknown>>) =>
				childOf(over, Digital, "digital", { book: b["id"] }, ["bytes"]),
			digital.delivery
		]),
		Option.map(shape.chapters, (chapters) => [
			chapters.name,
			(b: Readonly<Record<string, unknown>>) => chaptersOf(over, chapters, b),
			"array"
		])
	])
	return shape.descending ? attached.orderBy(["pages", "desc"]) : attached
}

/** The query of a shape over Shelves `over`: the shelf at the parameter `shelf`, its books attached as an array. */
export const shapeQuery = (over: unknown, shape: RecordsShape): QueryValue =>
	queryOver(over)
		.rule((r: RuleValue) => {
			const { id, label } = varsOver(Shelf, "shelf")
			return r
				.match(Shelf, { id, label })
				.where(r.eq(id, r.param("shelf", Id)))
				.find({ id, label })
		})
		.attach(
			shape.books.name,
			(s: Readonly<Record<string, unknown>>) => booksOf(over, shape.books, s),
			"array"
		)

/** A child's text: one rule over `relation`, its parent's fields bound, its own matched and found. */
const childText = (
	relation: string,
	scope: string,
	bound: ReadonlyArray<readonly [string, string]>,
	own: ReadonlyArray<string>
): string => {
	const vars = Arr.join(own, ", ")
	const bindings = Arr.join([...Arr.map(bound, ([f, t]) => `${f}: ${t}`), ...own], ", ")
	return `query(Shelves).rule((r) => { const { ${vars} } = v(${relation}, "${scope}"); return r.match(${relation}, { ${bindings} }).find({ ${vars} }) })`
}

/** An attachment's text, if attached. */
const attachText = (
	attachment: Option.Option<readonly [string, string, string]>
): ReadonlyArray<string> =>
	Option.match(attachment, {
		onNone: () => [],
		onSome: ([name, child, delivery]) => [`.attach("${name}", ${child}, ${delivery})`]
	})

/** The text of a shape's query, an expression of the program's names over Shelves. */
export const shapeText = (shape: RecordsShape): string => {
	const books = shape.books
	const head = Arr.join(
		[
			"id",
			"kind",
			"pages",
			...(books.at ? ["at"] : []),
			...(books.literal ? ['source: "shelf"'] : [])
		],
		", "
	)
	const chapters = Option.map(books.chapters, (c): readonly [string, string, string] => [
		c.name,
		`(b) => ${Arr.join(
			[
				'query(Shelves).rule((r) => { const { book, n, pages } = v(Chapter, "chapter"); return r.match(Chapter, { book, n, pages }).where(r.eq(book, b.id)).find({ book, n, pages }) })',
				...attachText(
					Option.map(c.remark, (remark): readonly [string, string, string] => [
						remark.name,
						`(c) => ${childText(
							"Remark",
							"remark",
							[
								["book", "c.book"],
								["n", "c.n"]
							],
							["stars"]
						)}`,
						`"${remark.delivery}"`
					])
				)
			],
			""
		)}`,
		'"array"'
	])
	const booksText = Arr.join(
		[
			`query(Shelves).rule((r) => { const { id, kind, pages, at } = v(Book, "book"); return r.match(Book, { id, shelf: s.id, kind, pages, at }).find({ ${head} }) })`,
			...attachText(
				Option.map(books.blurb, (b): readonly [string, string, string] => [
					b.name,
					`(b) => ${childText("Blurb", "blurb", [["book", "b.id"]], ["words"])}`,
					`"${b.delivery}"`
				])
			),
			...attachText(
				Option.map(books.spine, (b): readonly [string, string, string] => [
					b.name,
					`(b) => ${Arr.join(
						[
							'query(Shelves).rule((r) => { const { color } = v(Spine, "spine"); return r.match(Spine, { book: b.id, color }).find({ book: b.id, color }) })',
							...attachText(
								Option.map(b.ink, (ink): readonly [string, string, string] => [
									ink.name,
									`(p) => ${childText("Ink", "ink", [["book", "p.book"]], ["hue"])}`,
									`"${ink.delivery}"`
								])
							)
						],
						""
					)}`,
					`"${b.delivery}"`
				])
			),
			...attachText(
				Option.map(books.paper, (b): readonly [string, string, string] => [
					b.name,
					`(b) => ${childText("Paper", "paper", [["book", "b.id"]], ["grams"])}`,
					`"${b.delivery}"`
				])
			),
			...attachText(
				Option.map(books.digital, (b): readonly [string, string, string] => [
					b.name,
					`(b) => ${childText("Digital", "digital", [["book", "b.id"]], ["bytes"])}`,
					`"${b.delivery}"`
				])
			),
			...attachText(chapters),
			...(books.descending ? ['.orderBy(["pages", "desc"])'] : [])
		],
		""
	)
	return Arr.join(
		[
			'query(Shelves).rule((r) => { const { id, label } = v(Shelf, "shelf"); return r.match(Shelf, { id, label }).where(r.eq(id, r.param("shelf", Id))).find({ id, label }) })',
			`.attach("${books.name}", (s) => ${booksText}, "array")`
		],
		""
	)
}

/** The owner's text of a shape: its fields' record and its key's tuple. */
export const ownerText = (shape: RecordsShape): { readonly fields: string; readonly key: string } =>
	shape.owner === "run"
		? { fields: "{ run: Id }", key: '["run"]' }
		: { fields: "{ run: Id, step: int4 }", key: '["run", "step"]' }
