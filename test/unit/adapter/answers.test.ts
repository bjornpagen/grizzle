/**
 * The server's answer held to the proofs grizzle's SQL carries: a row PostgreSQL delivers is decoded only where its
 * statement's compiled proof says it can deliver it, never repaired on the host.
 *
 * - An attachment's delivery (core/decoder.ts): an array delivers its children, an Option at most one and the one child
 *   exactly one; a child more than its proof allows, or the child a proof requires missing, is a defect naming the
 *   attachment, never the first of several. Oracle: the specification of the deliveries, enumerated in a box of every
 *   delivery, every proof that licenses it and every count of children up to three.
 * - A statement's rows (reader/execution.ts rowsOf): every statement grizzle delivers, an attachment's included, is a
 *   set, so its answer holding one row twice, under the column types' equality (1.5 and 1.50 alike), is
 *   UnreadableAnswer at that statement, and an answer that is a set is stitched exactly. Oracle: a model of the delivered
 *   set, the generated rows themselves, which are distinct by construction until the case plants a repeat.
 * - A page's candidates (page/execute.ts pageEdges): the rows a request fetches strictly increase under its fetch order,
 *   so the lookahead counts distinct rows; an equal tuple or a step back is UnreadableAnswer at the rows statement.
 *   Oracle: the request's contract, edges the first min(size, n) of n increasing rows and the lookahead n > size.
 */
import { describe, it } from "@effect/vitest"
import { drawn, exhaust, explore } from "@grizzle/testing/explore"
import { required, requiredInSpace } from "@grizzle/testing/features"
import { array, element, type Gen, int } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Result, String as Str } from "effect"
import { rowOptions } from "#adapter/engine.ts"
import { pageEdges } from "#adapter/page/execute.ts"
import { pageRuntimeOf } from "#adapter/page/template.ts"
import { attachmentHeads } from "#adapter/reader/analysis.ts"
import { answerOf, type SentRuns } from "#adapter/reader/execution.ts"
import { deliveredRows, templateProgram } from "#adapter/reader/run.ts"
import {
	attachment,
	type BindContext,
	binding,
	cellAt,
	columnAt,
	type Delivery,
	type Layout,
	licenses,
	noChild,
	type RecordField,
	type Row,
	type RowDecoder,
	someChild
} from "#compiler/core/decoder.ts"
import { codeNames } from "#compiler/ir/codes.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import { statementOutput } from "#compiler/lower/conservative/types.ts"
import { queryInput } from "#compiler/program/compile.ts"
import { pg, uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { contained, on, relation, schema } from "#compiler/public/schema.ts"
import { assert, defined, succeeded, throwsDefect } from "#test/support/assert.ts"
import {
	codebookFor,
	compileTemplate,
	firstCodes,
	schemaInputOf,
	testCompile
} from "#test/support/compile.ts"
import { caseHang } from "#test/support/limits.ts"
import { outputRows, outputText } from "#test/support/wire.ts"
import { ascendingTasks, compiledPageResult, Paging } from "#test/unit/page/fixtures.ts"

/** A child record of one column, `c`. */
const child: RowDecoder<string> = {
	headings: [["c"]],
	bind: (layout) =>
		binding(() => {
			const at = columnAt(layout, "c")
			return (row) => cellAt(row, at)
		})
}

const context = (codes: Parameters<typeof codeNames>[0]): BindContext => ({
	options: rowOptions,
	names: codeNames(codes)
})

/** A parent layout holding one attachment, `kids`, whose analysis proved `proved`. */
const parentLayout = (proved: Delivery): Layout => ({
	columns: new Map(),
	attachments: new Map([
		[
			"kids",
			{
				slot: 0,
				layouts: [{ columns: new Map([["c", 0]]), attachments: new Map() }],
				proved
			}
		]
	])
})

/** A parent row whose one attachment slot holds `n` children, c0 to c(n-1). */
const parentRow = (n: number): Row => ({
	group: 0,
	texts: [],
	children: [
		Array.from({ length: n }, (_, i): Row => ({
			group: 0,
			texts: [outputText(`c${i}`)],
			children: []
		}))
	]
})

/** How a field reads the children: an attachment delivering one of the three ways, or an alternatives arm's. */
type Reader = Delivery | "a selected arm" | "an unselected arm"

/** What the contract makes of `n` children under `reader`: the children, an Option, the one child, or a defect. */
type Expected =
	| { readonly kind: "children"; readonly n: number }
	| { readonly kind: "option"; readonly child: Option.Option<string> }
	| { readonly kind: "one"; readonly child: string }
	| { readonly kind: "defect" }

const expected = (reader: Reader, n: number): Expected => {
	switch (reader) {
		case "array":
			return { kind: "children", n }
		case "option":
			return n === 0
				? { kind: "option", child: Option.none() }
				: n === 1
					? { kind: "option", child: Option.some("c0") }
					: { kind: "defect" }
		case "one":
		case "a selected arm":
			return n === 1 ? { kind: "one", child: "c0" } : { kind: "defect" }
		case "an unselected arm":
			return n === 0 ? { kind: "option", child: Option.none() } : { kind: "defect" }
	}
}

const fieldOf = (reader: Reader): RecordField<unknown> => {
	switch (reader) {
		case "array":
		case "option":
		case "one":
			return attachment(child, reader)
		case "a selected arm":
			return someChild(child)
		case "an unselected arm":
			return noChild(child)
	}
}

interface DeliveryCase {
	readonly reader: Reader
	readonly proved: Delivery
	readonly n: number
}

const readers: Arr.NonEmptyReadonlyArray<Reader> = [
	"array",
	"option",
	"one",
	"a selected arm",
	"an unselected arm"
]
const deliveriesList: Arr.NonEmptyReadonlyArray<Delivery> = ["array", "option", "one"]

/** Every reader under every proof that licenses it, over zero to three children. */
const deliveryCases: Gen<DeliveryCase> = (source) => ({
	reader: source.draw(element(readers)),
	proved: source.draw(element(deliveriesList)),
	n: source.draw(int(0, 3))
})

type DeliveryFeature = "delivered" | "a defect" | "a proof that does not license the reader"

describe("an attachment's delivery", () => {
	it.effect(
		"delivers what its proof allows and is a defect naming the attachment past it, never a first of several",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						box: { kind: "unstated" },
						oracle: { kind: "unstated" },
						suite: "unit/adapter/answers-deliveries",
						generator: deliveryCases,
						literal: Formatter.format,
						limit: 60,
						coverage: requiredInSpace<DeliveryFeature>([
							"delivered",
							"a defect",
							"a proof that does not license the reader"
						]),
						caseHang
					},
					({ reader, proved, n }, c) =>
						Effect.sync(() => {
							const stated: Delivery =
								reader === "a selected arm" || reader === "an unselected arm" ? "option" : reader
							if (!licenses(proved, stated)) {
								c.note("a proof that does not license the reader")
								return
							}
							const codes = succeeded(codebookFor(schemaInputOf(Paging), firstCodes))
							const read = fieldOf(reader).bind(parentLayout(proved), "kids", context(codes)).read
							const want = expected(reader, n)
							const row = parentRow(n)
							switch (want.kind) {
								case "defect": {
									c.note("a defect")
									const named = throwsDefect(() => read(row), `${reader} of ${n}`)
									assert.ok(
										Str.includes("kids")(named),
										`the defect names the attachment: ${named}`
									)
									return
								}
								case "children":
									c.note("delivered")
									assert.deepEqual(
										read(row),
										Array.from({ length: want.n }, (_, i) => `c${i}`)
									)
									return
								case "option":
									c.note("delivered")
									assert.deepEqual(read(row), want.child)
									return
								case "one":
									c.note("delivered")
									assert.deepEqual(
										read(row),
										reader === "a selected arm" ? Option.some(want.child) : want.child
									)
									return
							}
						})
				)
			)
	)
})

const Post = relation("Post", { id: uuid, n: pg.numeric(10, 2) }, ["id"])
const Comment = relation("Comment", { id: uuid, post: uuid, n: pg.numeric(10, 2) }, ["id"])
const Blog = schema("Blog", { Post, Comment }, [contained(on(Comment, "post"), on(Post, "id"))])

/** Each post with its comments: a root statement and one attachment statement, its rows led by the parent key. */
const postsWithComments = query(Blog)
	.rule((r) => {
		const { id, n } = v(Post, "post")
		return r.match(Post, { id, n }).find({ id, n })
	})
	.attach(
		"comments",
		(post) =>
			query(Blog).rule((r) => {
				const { id, n } = v(Comment, "comment")
				return r.match(Comment, { id, post: post.id, n }).find({ id, n })
			}),
		"array"
	)

const uuids = [
	"a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
	"a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a12",
	"a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a13",
	"a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a14",
	"a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a15",
	"a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a16"
] as const

/** Two spellings of each numeric value, as numeric_out writes it at two display scales. */
const numerics: ReadonlyArray<readonly [string, string]> = [
	["1.5", "1.50"],
	["2", "2.0"],
	["-0.25", "-0.250"]
]

/** A planted repeat: none, a row of the root statement or of the attachment's, as written or with a numeric respelled. */
type Plant =
	| { readonly kind: "none" }
	| {
			readonly kind: "repeat"
			readonly statement: "root" | "attachment"
			readonly respelled: boolean
	  }

interface StitchCase {
	readonly posts: number
	/** Each comment's post, by index among the posts. */
	readonly comments: ReadonlyArray<number>
	readonly numeric: ReadonlyArray<number>
	readonly plant: Plant
}

const stitchCases: Gen<StitchCase> = (source) => {
	const posts = source.draw(int(1, 3))
	const comments = source.draw(array(int(0, posts - 1), { min: 0, max: 3 }))
	return {
		posts,
		comments,
		numeric: Arr.makeBy(posts + comments.length, () => source.draw(int(0, numerics.length - 1))),
		plant: source.draw(
			element<Plant>([
				{ kind: "none" },
				{ kind: "repeat", statement: "root", respelled: false },
				{ kind: "repeat", statement: "root", respelled: true },
				{ kind: "repeat", statement: "attachment", respelled: false },
				{ kind: "repeat", statement: "attachment", respelled: true }
			])
		)
	}
}

/** The text of a cell of `type` for a fact's uuid `id` and its numeric value `numeric`, in its first or second spelling. */
const cellText = (type: ScalarType, id: string, numeric: number, second: boolean): string => {
	const spelled = defined(numerics[numeric], "a numeric")
	return type.carrier === "numeric" ? (second ? spelled[1] : spelled[0]) : id
}

type StitchFeature =
	| "stitched"
	| "a repeat refused"
	| "a respelled repeat refused"
	| "a post without comments"
	| "a post with two comments"

describe("a statement's rows", () => {
	it.effect(
		"are a set: a row the answer holds twice, in any spelling, is UnreadableAnswer at its statement",
		(ctx) =>
			Effect.gen(function* () {
				const template = succeeded(compileTemplate(postsWithComments, Blog, testCompile))
				const desc = succeeded(queryInput(postsWithComments)).desc
				const codes = succeeded(codebookFor(schemaInputOf(Blog), firstCodes))
				const program = templateProgram(template, "conservative", attachmentHeads(desc), codes)
				const root = defined(
					Arr.findFirst(program.records, (r) => r.run.statement.role.kind !== "attachment").pipe(
						Option.getOrUndefined
					),
					"the root statement"
				)
				const attached = defined(
					Arr.findFirst(program.records, (r) => r.run.statement.role.kind === "attachment").pipe(
						Option.getOrUndefined
					),
					"the attachment statement"
				)
				const role = attached.run.statement.role
				/** How many columns an attachment statement's rows lead with: its parent key's. */
				const keyCount = role.kind === "attachment" ? role.parentKey.length : 0
				const outputOf = (record: typeof root) =>
					statementOutput(
						record.run.statement.role,
						record.run.statement.heading,
						record.run.statement.fused
					).heading
				yield* searched(
					ctx,
					explore(
						{
							oracle: { kind: "unstated" },
							suite: "unit/adapter/answers-rows",
							draw: drawn(stitchCases),
							literal: Formatter.format,
							coverage: required<StitchFeature>(
								[
									"stitched",
									"a repeat refused",
									"a respelled repeat refused",
									"a post without comments",
									"a post with two comments"
								],
								{ cases: 1000, sense: notesOnly }
							),
							kept: [],
							runs: 500,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							caseHang
						},
						({ posts, comments, numeric, plant }, c) =>
							Effect.sync(() => {
								const postId = (p: number) => defined(uuids[p], "a post id")
								const commentId = (k: number) => defined(uuids[posts + k], "a comment id")
								const rootRows = Arr.makeBy(posts, (p) =>
									Arr.map(outputOf(root), (col) =>
										cellText(col.type, postId(p), defined(numeric[p], "n"), false)
									)
								)
								/** A comment's row: its parent key and its post field the post's id, its own id, and its value. */
								const childRows = Arr.map(comments, (p, k) =>
									Arr.map(outputOf(attached), (col, at) =>
										cellText(
											col.type,
											at < keyCount || col.name === "post" ? postId(p) : commentId(k),
											defined(numeric[posts + k], "n"),
											false
										)
									)
								)
								const planted = (
									rows: ReadonlyArray<ReadonlyArray<string>>,
									record: typeof root
								) => {
									if (plant.kind === "none") {
										return rows
									}
									const [first] = rows
									if (first === undefined) {
										return rows
									}
									const again = Arr.map(first, (text, i) => {
										const type = defined(outputOf(record)[i], "a column").type
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
								sent[answerOf(root.arrival)] =
									plant.kind === "repeat" && plant.statement === "root"
										? planted(rootRows, root)
										: rootRows
								sent[answerOf(attached.arrival)] =
									plant.kind === "repeat" && plant.statement === "attachment"
										? planted(childRows, attached)
										: childRows
								const answers: SentRuns = Arr.map(sent, outputRows)
								const delivered = deliveredRows(program, answers, {})
								const repeatedAt =
									plant.kind === "repeat" && (plant.statement === "root" || childRows.length > 0)
										? answerOf((plant.statement === "root" ? root : attached).arrival)
										: undefined
								if (repeatedAt !== undefined && plant.kind === "repeat") {
									c.note(plant.respelled ? "a respelled repeat refused" : "a repeat refused")
									assert.ok(Result.isFailure(delivered), "a repeated row was delivered")
									assert.equal(delivered.failure._tag, "UnreadableAnswer")
									assert.equal(delivered.failure.index, repeatedAt)
									return
								}
								c.note("stitched")
								const rows = Result.getOrThrow(delivered)
								assert.equal(rows.length, posts)
								for (const row of rows) {
									const kids = defined(row.children[0], "the comments slot")
									const owner = Arr.findFirst(uuids, (u) =>
										Arr.some(row.texts, (t) => t === u)
									).pipe(Option.getOrUndefined)
									const p = uuids.indexOf(defined(owner, "the row's post id"))
									const owned = Arr.filter(comments, (q) => q === p).length
									c.note(owned === 0 ? "a post without comments" : "stitched")
									if (owned >= 2) {
										c.note("a post with two comments")
									}
									assert.equal(kids.length, owned, "each post owns exactly its comments")
								}
							})
					)
				)
			})
	)
})

type PagePlant = "none" | "an equal tuple" | "a step back"

interface PageCase {
	readonly priorities: ReadonlyArray<number>
	readonly size: number
	readonly plant: PagePlant
}

/** Up to four tasks of distinct (priority, id), a page size, and a planted equal tuple or step back among the rows. */
const pageCases: Gen<PageCase> = (source) => ({
	priorities: source.draw(array(int(0, 2), { min: 0, max: 4 })),
	size: source.draw(int(1, 4)),
	plant: source.draw(element<PagePlant>(["none", "an equal tuple", "a step back"]))
})

type PageFeature =
	| "an edge per row"
	| "a lookahead"
	| "an equal tuple refused"
	| "a step back refused"

describe("a page's candidates", () => {
	it.effect(
		"strictly increase in the fetch order, so an equal tuple or a step back is UnreadableAnswer, never a counted row",
		(ctx) =>
			Effect.gen(function* () {
				const compiled = succeeded(compiledPageResult(ascendingTasks, testCompile))
				const desc = succeeded(queryInput(ascendingTasks)).desc
				const codes = succeeded(codebookFor(schemaInputOf(Paging), firstCodes))
				const runtime = succeeded(
					pageRuntimeOf({
						page: compiled.page,
						params: compiled.query.params,
						query: "unit/adapter/answers-page",
						generation: { schema: "answers", extensions: {} },
						spine: attachmentHeads(desc),
						codes
					})
				)
				const program = runtime.artifacts.conservative.requests.first
				const rows = defined(program.records[0], "the rows statement")
				const heading = statementOutput(
					rows.run.statement.role,
					rows.run.statement.heading,
					rows.run.statement.fused
				).heading
				yield* searched(
					ctx,
					explore(
						{
							oracle: { kind: "unstated" },
							suite: "unit/adapter/answers-page",
							draw: drawn(pageCases),
							literal: Formatter.format,
							coverage: required<PageFeature>(
								["an edge per row", "a lookahead", "an equal tuple refused", "a step back refused"],
								{ cases: 1000, sense: notesOnly }
							),
							kept: [],
							runs: 500,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							caseHang
						},
						({ priorities, size, plant }, c) =>
							Effect.sync(() => {
								/** The tasks in the fetch order, priority then id ascending: distinct, so strictly increasing. */
								const tasks = Arr.sort(
									Arr.map(priorities, (priority, i) => ({
										priority,
										id: defined(uuids[i], "an id")
									})),
									(a: { readonly priority: number; readonly id: string }, b: typeof a) =>
										a.priority !== b.priority
											? a.priority < b.priority
												? -1
												: 1
											: a.id < b.id
												? -1
												: 1
								).slice(0, size + 1)
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
								const answer =
									plant === "an equal tuple" && first !== undefined && fetched.length <= size
										? { planted: true, rows: [first, ...fetched] }
										: plant === "a step back" && first !== undefined && second !== undefined
											? { planted: true, rows: [second, first, ...fetched.slice(2)] }
											: { planted: false, rows: fetched }
								const edges = pageEdges(program, [outputRows(answer.rows)], size)
								if (answer.planted) {
									c.note(
										plant === "an equal tuple" ? "an equal tuple refused" : "a step back refused"
									)
									assert.ok(Result.isFailure(edges), `${plant} was delivered`)
									assert.equal(edges.failure._tag, "UnreadableAnswer")
									assert.equal(edges.failure.index, answerOf(rows.arrival))
									return
								}
								const page = Result.getOrThrow(edges)
								c.note(page.lookahead ? "a lookahead" : "an edge per row")
								assert.equal(page.edges.length, Math.min(size, fetched.length))
								assert.equal(page.lookahead, fetched.length > size)
							})
					)
				)
			})
	)
})
