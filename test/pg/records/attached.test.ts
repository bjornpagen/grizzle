/**
 * A query's records on PostgreSQL 19: over drawn queries of Shelves (test/support/agreement/records.ts), each reading
 * one shelf and its books as an array, each book with a drawn subset of its blurb, spine, paper, digital and chapters,
 * each chapter with its remark, at depths one to three and every delivery (an array, an option, one, an arm), and over
 * drawn facts of Shelves, the records of the query (records(...)) installed beside Shelves as a level over it, the rows
 * the query delivers inserted into them by their insert (recordsFacts) and read back by their read (recordsQuery) are
 * exactly the rows the query delivered: each attachment's records, at every depth, stored in its relation under its
 * law and delivered as the query states it, an array in its order.
 *
 * Oracle: the query itself, served on the same installation over the same facts, its rows the records' read must equal
 * (test/support/equivalence.ts exactValue).
 */
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option } from "effect"
import {
	type AttachedCase,
	attachedCase,
	attachedCaseGen
} from "#test/pg/records/attached.fixtures.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"

/** What a case stores: each delivery below the books with a child, a third level's, an order of several. */
type RecordsFeature =
	| "an option stored"
	| "one child stored"
	| "an arm stored"
	| "a nested array stored"
	| "a third level stored"
	| "books in their pages' order"
	| "no book"

/** The features a case reaches: what its shape attaches over the facts it stores. */
const reached = (c: AttachedCase): ReadonlyArray<RecordsFeature> => {
	const b = c.shape.books
	const books = c.facts.books
	const some = Arr.isReadonlyArrayNonEmpty(books)
	const delivered = (a: Option.Option<{ readonly delivery: string }>, delivery: string): boolean =>
		Option.exists(a, (x) => x.delivery === delivery)
	const ofKind = (kind: "Paper" | "Digital") => Arr.some(books, (book) => book.kind === kind)
	const blurbs = Arr.some(books, (book) => Option.isSome(book.blurb))
	const chapters = Arr.some(books, (book) => Arr.isReadonlyArrayNonEmpty(book.chapters))
	const remarks = Arr.some(books, (book) =>
		Arr.some(book.chapters, (chapter) => Option.isSome(chapter.remark))
	)
	const ink = Option.flatMap(b.spine, (spine) => spine.ink)
	const remark = Option.flatMap(b.chapters, (ch) => ch.remark)
	const feature = (holds: boolean, f: RecordsFeature): ReadonlyArray<RecordsFeature> =>
		holds ? [f] : []
	return [
		...feature(
			(delivered(b.blurb, "option") && blurbs) ||
				(delivered(b.spine, "option") && some) ||
				(delivered(b.paper, "option") && ofKind("Paper")) ||
				(delivered(b.digital, "option") && ofKind("Digital")) ||
				(delivered(ink, "option") && some) ||
				(delivered(remark, "option") && remarks),
			"an option stored"
		),
		...feature(delivered(b.spine, "one") && some, "one child stored"),
		...feature(
			(delivered(b.paper, "arm") && ofKind("Paper")) ||
				(delivered(b.digital, "arm") && ofKind("Digital")),
			"an arm stored"
		),
		...feature(Option.isSome(b.chapters) && chapters, "a nested array stored"),
		...feature(
			(Option.isSome(remark) && remarks) || (Option.isSome(ink) && some),
			"a third level stored"
		),
		...feature(
			b.descending && new Set(Arr.map(books, (book) => book.pages)).size > 1,
			"books in their pages' order"
		),
		...feature(!some, "no book")
	]
}

/** The records of a query read back exactly the rows the query delivered. */
export const aQuerysRecordsReadBackExactlyTheRowsTheQueryDelivered = property.explore(
	attachedCaseGen,
	{
		needs: { substrate: Substrate.fresh(baseSubstrate) },
		situations: [
			"an option stored",
			"one child stored",
			"an arm stored",
			"a nested array stored",
			"a third level stored",
			"books in their pages' order",
			"no book"
		] satisfies ReadonlyArray<Reached<RecordsFeature>>,
		check:
			({ substrate }, notes: Case<RecordsFeature>) =>
			(c) =>
				Effect.provideServiceEffect(
					Effect.scoped(
						Effect.map(attachedCase(c), () => {
							for (const feature of reached(c)) {
								notes.note(feature)
							}
						})
					),
					Substrate,
					Effect.map(substrate, (taken) => taken.substrate)
				),
		oracle: {
			kind: "second-implementation",
			name: "the query itself, served over the same facts, its rows the records' read must equal"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/runtime/records.ts",
				original: "\t\t\t\t\ta.name,\n\t\t\t\t\tvalue.map((member, i): RecordsFact => {",
				replacement:
					"\t\t\t\t\ta.name,\n\t\t\t\t\tvalue.slice(0, 0).map((member, i): RecordsFact => {",
				why: "An array's members are never inserted (runtime/records.ts attachmentFacts), so a book's chapters, and the shelf's books, read back empty."
			},
			{
				file: "packages/engine/src/runtime/records.ts",
				original: '\t\t\tcase "option":\n\t\t\tcase "arm": {',
				replacement: '\t\t\tcase "option":\n\t\t\t\tbreak\n\t\t\tcase "arm": {',
				why: "An option's child is never inserted (runtime/records.ts attachmentFacts), so a blurb reads back None where the query delivered Some."
			},
			{
				file: "packages/engine/src/runtime/records.ts",
				original: '\t\t\tcase "option":\n\t\t\tcase "arm": {',
				replacement: '\t\t\tcase "arm":\n\t\t\t\tbreak\n\t\t\tcase "option": {',
				why: "An arm's child is never inserted (runtime/records.ts attachmentFacts), so the alternatives law refuses the insert of a book of the arm's kind."
			},
			{
				file: "packages/engine/src/runtime/records.ts",
				original: '\t\t\tcase "one":\n\t\t\t\tstateApart(a, value)\n\t\t\t\tbreak',
				replacement: '\t\t\tcase "one":\n\t\t\t\tbreak',
				why: "The one child is never inserted (runtime/records.ts attachmentFacts), so its mirror refuses the insert of every book."
			},
			{
				file: "packages/engine/src/program/records.ts",
				original: 'attached.orderBy([a.holding.place, "asc"])',
				replacement: 'attached.orderBy([a.holding.place, "desc"])',
				why: "An array is read back against its place's order (program/records.ts childRead), so books of several pages read back reversed."
			}
		]
	}
)
