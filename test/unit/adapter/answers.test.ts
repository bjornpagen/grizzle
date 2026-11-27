/**
 * The server's answer held to the proofs grizzle's SQL carries: a row PostgreSQL delivers is decoded only where its
 * statement's compiled proof says it can deliver it, never repaired on the host.
 *
 * - An attachment's delivery (core/decoder.ts): an array delivers its children, an Option at most one and the one child
 *   exactly one; a child more than its proof allows, or the child a proof requires missing, is the defect
 *   UnlawfulDelivery, its fields the attachment, the law it breaks and the children the row held, never the first of
 *   several. Oracle: the specification of the deliveries, enumerated in a box of every
 *   delivery, every proof that licenses it and every count of children up to three.
 * - A statement's rows (reader/execution.ts recordRowsOf): every statement grizzle delivers, an attachment's included, is a
 *   set, so its answer holding one row twice, under the column types' equality (1.5 and 1.50 alike), is
 *   UnreadableAnswer at that statement, and an answer that is a set is stitched exactly. Oracle: a model of the delivered
 *   set, the generated rows themselves, which are distinct by construction until the case plants a repeat.
 * - A window's rows (page/execute.ts windowIntake): the rows a window fetches strictly increase under its fetch order;
 *   an equal tuple, a step back, or a row past the statement's LIMIT, the window's size, is UnreadableAnswer at the rows
 *   statement. Oracle: the window's contract, the first min(size, n) of n increasing rows.
 *
 * Features: each delivery, a defect, a proof that does not license the reader; each statement kind with a repeat
 * planted or none; each way a window's rows fail.
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { finite, int, subset } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option, Result } from "effect"
import { windowIntake } from "#adapter/page/execute.ts"
import type { SentRuns } from "#adapter/reader/execution.ts"
import { deliveredRows } from "#adapter/reader/run.ts"
import { licenses, type Row, UnlawfulDelivery } from "#compiler/core/decoder.ts"
import { recordsReader } from "#compiler/runtime/read/record.ts"
import { bindGroups, named, record } from "#compiler/schema/record.ts"
import { succeeded } from "#test/support/assert.ts"
import { codebookFor, firstCodes, schemaInputOf } from "#test/support/compile.ts"
import { lengthHashedKeyings, longFamily } from "#test/support/kernel/long-keys.ts"
import { upTo } from "#test/support/up-to.ts"
import { outputRows } from "#test/support/wire.ts"
import {
	attached,
	cellText,
	childOf,
	context,
	type DeliveryFeature,
	deliveryCases,
	expected,
	fieldOf,
	heading,
	keyCount,
	numerics,
	statementHeadingOf,
	type PageAnswer,
	pageCases,
	type PageFeature,
	parentLayout,
	parentRow,
	program,
	root,
	type StitchFeature,
	stitchCases,
	taggedAttached,
	taggedKeyCount,
	taggedProgram,
	taggedRoot,
	uuids,
	windowProgram
} from "#test/unit/adapter/answers.fixtures.ts"
import { Paging } from "#test/unit/page/fixtures.ts"

/** An attachment's delivery delivers what its proof allows and is a defect naming the attachment past it, never a first of several. */
export const anAttachmentsDeliveryDeliversWhatItsProofAllowsAndIsADefectNamingTheAttachmentPastItNeverAFirstOfSeveral =
	property.exhaust(finite(deliveryCases), {
		needs: {},
		situations: [
			"delivered",
			"a defect",
			"a proof that does not license the reader"
		] satisfies ReadonlyArray<Reached<DeliveryFeature>>,
		check:
			(_, c: Case<DeliveryFeature>) =>
			({ reader, proved, n }) =>
				Effect.sync(() => {
					if (!licenses(proved, reader)) {
						c.note("a proof that does not license the reader")
						return
					}
					const codes = succeeded(codebookFor(schemaInputOf(Paging), firstCodes))
					const parent = succeeded(
						bindGroups(record(named("kids", fieldOf(reader))), (form) =>
							recordsReader(form, [parentLayout(proved)], context(codes))
						)
					)
					const read = (row: Row): unknown => parent(row).kids
					const want = expected(reader, n)
					const row = parentRow(n)
					switch (want.kind) {
						case "defect": {
							c.note("a defect")
							const died = Result.try(() => read(row))
							if (Result.isSuccess(died) || !(died.failure instanceof UnlawfulDelivery)) {
								return assert.fail(`${reader} of ${n} dies an UnlawfulDelivery`)
							}
							const defect = died.failure
							assert.deepEqual(
								{ attachment: defect.attachment, law: defect.law, children: defect.children },
								{ attachment: "kids", law: want.law, children: n },
								`${reader} of ${n}`
							)
							return
						}
						case "children":
							c.note("delivered")
							assert.deepEqual(
								read(row),
								Array.from({ length: want.n }, (_, i) => childOf(`c${i}`))
							)
							return
						case "option":
							c.note("delivered")
							assert.deepEqual(read(row), want.child)
							return
						case "one":
							c.note("delivered")
							assert.deepEqual(read(row), want.child)
							return
					}
				}),
		oracle: {
			kind: "specification",
			name: "the deliveries each proof licenses, enumerated with every count of children"
		},
		box: "every reader under every proof that licenses it, over zero to three children",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/runtime/read/record.ts",
				original:
					'\t\tthrow new UnlawfulDelivery({ attachment: key, law: "atMostOne", children: children.length })',
				replacement: "\t\treturn children.slice(0, 1)",
				why: "A second child under an Option or the one child is taken silently, the first of several kept; the deliveries' property fails."
			},
			{
				file: "packages/engine/src/runtime/read/record.ts",
				original:
					'\t\tthrow new UnlawfulDelivery({ attachment: key, law: "exactlyOne", children: 0 })',
				replacement:
					'\t\tthrow new UnlawfulDelivery({ attachment: key, law: "atMostOne", children: 0 })',
				why: "A missing one child is named under the law of at most one child; the deliveries' property fails."
			}
		]
	})

/**
 * A statement's rows are a set: a row the answer holds twice, in any spelling, is UnreadableAnswer at its statement.
 *
 * Budget: its suite's count before the conversion (unit/adapter/answers-rows: 500 independent cases and 0 steered,
 * Vitest at grizzle 4ca3036a).
 */
export const aStatementsRowsAreASetARowTheAnswerHoldsTwiceInAnySpellingIsUnreadableAnswerAtItsStatement =
	property.explore(stitchCases, {
		needs: {},
		situations: [
			"stitched",
			"a repeat refused",
			"a respelled repeat refused",
			"a post without comments",
			"a post with two comments"
		] satisfies ReadonlyArray<Reached<StitchFeature>>,
		check:
			(_, c: Case<StitchFeature>) =>
			({ posts, comments, numeric, plant }) =>
				Effect.sync(() => {
					const postId = (p: number) => defined(uuids[p], "a post id")
					const commentId = (k: number) => defined(uuids[posts + k], "a comment id")
					const rootRows = upTo(posts, (p) =>
						Arr.map(statementHeadingOf(root), (col) =>
							cellText(col.type, postId(p), defined(numeric[p], "n"), false)
						)
					)
					/** A comment's row: its parent key and its post field the post's id, its own id, and its value. */
					const childRows = Arr.map(comments, (p, k) =>
						Arr.map(statementHeadingOf(attached), (col, at) =>
							cellText(
								col.type,
								at < keyCount || col.name === "post" ? postId(p) : commentId(k),
								defined(numeric[posts + k], "n"),
								false
							)
						)
					)
					const planted = (rows: ReadonlyArray<ReadonlyArray<string>>, record: typeof root) => {
						if (plant.kind === "none") {
							return rows
						}
						const [first] = rows
						if (first === undefined) {
							return rows
						}
						const again = Arr.map(first, (text, i) => {
							const type = defined(statementHeadingOf(record)[i], "a column").type
							const spelled = Option.getOrUndefined(
								Arr.findFirst(numerics, (pair) => pair[0] === text)
							)
							return plant.respelled && type.carrier === "numeric" && spelled !== undefined
								? spelled[1]
								: text
						})
						return [...rows, again]
					}
					const sent: Array<ReadonlyArray<ReadonlyArray<string>>> = []
					sent[root.answer] =
						plant.kind === "repeat" && plant.statement === "root"
							? planted(rootRows, root)
							: rootRows
					sent[attached.answer] =
						plant.kind === "repeat" && plant.statement === "attachment"
							? planted(childRows, attached)
							: childRows
					const answers: SentRuns = Arr.map(sent, outputRows)
					const delivered = deliveredRows(program, answers, {})
					if (plant.kind === "repeat" && (plant.statement === "root" || childRows.length > 0)) {
						c.note(plant.respelled ? "a respelled repeat refused" : "a repeat refused")
						assert.ok(Result.isFailure(delivered), "a repeated row was delivered")
						assert.equal(delivered.failure._tag, "UnreadableAnswer")
						assert.equal(delivered.failure.index, 0, "at the read's one statement")
						return
					}
					c.note("stitched")
					const rows = Result.getOrThrow(delivered)
					assert.equal(rows.length, posts)
					for (const row of rows) {
						const kids = defined(row.children[0], "the comments slot")
						const owner = Arr.findFirst(uuids, (u) => Arr.some(row.cells, (t) => t === u)).pipe(
							Option.getOrUndefined
						)
						const p = uuids.indexOf(defined(owner, "the row's post id"))
						const owned = Arr.filter(comments, (q) => q === p).length
						c.note(owned === 0 ? "a post without comments" : "stitched")
						if (owned >= 2) {
							c.note("a post with two comments")
						}
						assert.equal(kids.length, owned, "each post owns exactly its comments")
					}
				}),
		oracle: {
			kind: "specification",
			name: "the delivered set: the generated rows, distinct until the case plants a repeat"
		},
		budget: { runs: 500, steered: 0 },
		kept: [],
		kills: [
			{
				file: "packages/grizzle/src/adapter/reader/execution.ts",
				original:
					"\tif (repeats(rows, plan.identity)) {\n\t\treturn Result.fail(repeated())\n\t}\n",
				replacement: "",
				why: "A statement's answer holding a row twice is delivered (recordRowsOf checks no repeat); the statements' property fails."
			}
		]
	})

/**
 * A read's rows key no native Map or Set by a text V8 hashes by its length alone: tags each named by one of a family of
 * two to four texts of one length past 16,383 units (kernel/long-keys.ts longFamily), each with up to three notes whose bodies
 * are of the family too, delivered by the read of each tag with its notes' bodies (reader/execution.ts recordRowsOf),
 * are each tag once with exactly its notes, and no native Map or Set was keyed by such a text (kernel/long-keys.ts
 * lengthHashedKeyings): a statement's rows are a set by their identities and an attachment's rows are grouped by their
 * parent key, each a TextsMap (core/text.ts), which hashes them by their digest, where a trie of the row's texts was a
 * native Map per text, one chain of such texts. A parent key is bounded, as every key is, so the texts past the hashed
 * length are the rows' own: a tag's name and a note's body.
 *
 * Budget: 40 independent cases and 0 steered, each a few long texts.
 */
export const aReadsRowsKeyNoNativeMapByATextV8HashesByItsLength = property.explore(
	(s) => {
		const family = longFamily(s.draw(int(2, 4)))
		const every = upTo(family.length, (n) => n)
		const tags = s.draw(subset(every, { min: 1, max: family.length }))
		const notes = Arr.map(tags, () =>
			s.draw(subset(every, { min: 0, max: Math.min(3, family.length) }))
		)
		return { family, tags, notes }
	},
	{
		needs: {},
		situations: [
			"a tag without notes",
			"a tag with two notes",
			"one body under two tags"
		] satisfies ReadonlyArray<
			Reached<"a tag without notes" | "a tag with two notes" | "one body under two tags">
		>,
		check:
			(_, c: Case<"a tag without notes" | "a tag with two notes" | "one body under two tags">) =>
			({ family, tags, notes }) =>
				Effect.gen(function* () {
					const textOf = (at: number): string => defined(family[at], "a text of the family")
					const sent: Array<ReadonlyArray<ReadonlyArray<string>>> = []
					sent[taggedRoot.answer] = Arr.map(tags, (tag) =>
						Arr.map(statementHeadingOf(taggedRoot), (col) =>
							col.name === "name" ? textOf(tag) : String(tag)
						)
					)
					sent[taggedAttached.answer] = Arr.flatMap(tags, (tag, t) =>
						Arr.map(defined(notes[t], "a tag's notes"), (body) =>
							Arr.map(statementHeadingOf(taggedAttached), (col, at) =>
								at < taggedKeyCount
									? String(tag)
									: col.name === "body"
										? textOf(body)
										: String(t * family.length + body)
							)
						)
					)
					const answers: SentRuns = Arr.map(sent, outputRows)
					const [delivered, keyings] = yield* lengthHashedKeyings(
						Effect.sync(() => deliveredRows(taggedProgram, answers, {}))
					)
					assert.equal(keyings, 0, "no native Map or Set keyed by a text past the hashed length")
					const rows = Result.getOrThrow(delivered)
					assert.equal(rows.length, tags.length, "each tag once")
					for (const row of rows) {
						const t = Option.getOrThrow(
							Arr.findFirstIndex(tags, (tag) => Arr.some(row.cells, (cell) => cell === textOf(tag)))
						)
						const kids = defined(row.children[0], "the notes slot")
						const owned = defined(notes[t], "the tag's notes")
						assert.equal(kids.length, owned.length, "each tag holds exactly its notes")
						if (owned.length === 0) {
							c.note("a tag without notes")
						}
						if (owned.length >= 2) {
							c.note("a tag with two notes")
						}
					}
					if (
						Arr.some(
							upTo(family.length, (n) => n),
							(body) => Arr.filter(notes, (owned) => owned.includes(body)).length >= 2
						)
					) {
						c.note("one body under two tags")
					}
				}),
		oracle: {
			kind: "specification",
			name: "each tag once with its notes, no native keying by a text"
		},
		budget: { runs: 40, steered: 0 },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/core/text.ts",
				original: "\treturn mintTextsId({ texts, digest: digest >> 1, belowSurrogates })",
				replacement:
					'\treturn mintTextsId({ texts, digest: texts.join("\\u0000"), belowSurrogates })',
				why: "A TextsMap keys its buckets by an identity's texts joined, a native Map of strings, as the reader's trie of a row's texts did: rows of texts past the hashed length key a native Map by each, one chain."
			}
		]
	}
)

/**
 * A window's rows strictly increase in the fetch order and stop at the LIMIT, so an equal tuple, a step back or a row
 * past the LIMIT is UnreadableAnswer, never a delivered row.
 *
 * Budget: its suite's count before the conversion (unit/adapter/answers-page: 500 independent cases and 0 steered,
 * Vitest at grizzle 4ca3036a).
 */
export const aWindowsRowsStrictlyIncreaseInTheFetchOrderAndStopAtTheLIMITSoAnEqualTupleAStepBackOrARowPastTheLIMITIsUnreadableAnswerNeverADeliveredRow =
	property.explore(pageCases, {
		needs: {},
		situations: [
			"a short window",
			"a full window",
			"an equal tuple refused",
			"a step back refused",
			"a row past its limit refused"
		] satisfies ReadonlyArray<Reached<PageFeature>>,
		check:
			(_, c: Case<PageFeature>) =>
			({ priorities, size, plant }) =>
				Effect.sync(() => {
					/** The tasks in the fetch order, priority then id ascending: distinct, so strictly increasing. */
					const ordered = Arr.sort(
						Arr.map(priorities, (priority, i) => ({
							priority,
							id: defined(uuids[i], "an id")
						})),
						(a: { readonly priority: number; readonly id: string }, b: typeof a) =>
							a.priority !== b.priority ? (a.priority < b.priority ? -1 : 1) : a.id < b.id ? -1 : 1
					)
					const tasks = ordered.slice(0, size)
					const textsOf = (t: { readonly priority: number; readonly id: string }) =>
						Arr.map(heading, (col) =>
							col.name === "priority"
								? `${t.priority}`
								: col.type.carrier === "uuid"
									? t.id
									: "a title"
						)
					const fetched = Arr.map(tasks, textsOf)
					const [first, second] = fetched
					const answer: PageAnswer =
						plant === "an equal tuple" && first !== undefined && fetched.length < size
							? {
									kind: "planted",
									refusal: "an equal tuple refused",
									rows: [first, ...fetched]
								}
							: plant === "a step back" && first !== undefined && second !== undefined
								? {
										kind: "planted",
										refusal: "a step back refused",
										rows: [second, first, ...fetched.slice(2)]
									}
								: plant === "a row past its limit" && ordered.length > size
									? {
											kind: "planted",
											refusal: "a row past its limit refused",
											rows: Arr.map(ordered.slice(0, size + 1), textsOf)
										}
									: { kind: "fetched", rows: fetched }
					const delivered: Array<unknown> = []
					const intake = windowIntake(windowProgram, size, (row) => {
						delivered.push(row)
					})
					for (const row of outputRows(answer.rows)) {
						intake.take(row)
					}
					const ended = intake.end()
					if (answer.kind === "planted") {
						c.note(answer.refusal)
						assert.ok(Result.isFailure(ended), `${answer.refusal}: delivered`)
						assert.equal(ended.failure._tag, "UnreadableAnswer")
						assert.equal(ended.failure.index, 0, "at the window's one statement")
						assert.equal(delivered.length, 0, `${answer.refusal}: a row delivered before it`)
						return
					}
					assert.ok(Result.isSuccess(ended), "an answer of increasing rows refused")
					c.note(fetched.length < size ? "a short window" : "a full window")
					assert.equal(delivered.length, Math.min(size, ordered.length))
				}),
		oracle: {
			kind: "specification",
			name: "a window the first min(size, n) of n increasing rows"
		},
		budget: { runs: 500, steered: 0 },
		kept: [],
		kills: [
			{
				file: "packages/grizzle/src/adapter/page/execute.ts",
				original: "\t\tif (candidates.length > limit) {",
				replacement: "\t\tif (candidates.length > limit + 1) {",
				why: "A rows statement may answer one row past its LIMIT, the window's size; the window's property fails."
			}
		]
	})
