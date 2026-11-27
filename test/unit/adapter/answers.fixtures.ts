/** What the properties of answers.test.ts read: its spaces, models and helpers. */

import { defined } from "@bjornpagen/testing/assert"
import { array, element, type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr, Option } from "effect"
import { rowOptions } from "#adapter/engine.ts"
import { readProgram } from "#adapter/reader/run.ts"
import { compiledPageRuntime } from "#adapter/served/forms.ts"
import {
	attachment,
	type BindContext,
	type ChildLaw,
	type Delivery,
	type Layout,
	type RecordField,
	type Row,
	textColumn
} from "#compiler/core/decoder.ts"
import { codeNames } from "#compiler/ir/codes.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import { queryInput } from "#compiler/program/input.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { contained, on, relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { statementOutput } from "#compiler/runtime/lower/tree.ts"
import { record } from "#compiler/schema/record.ts"
import { servedSource } from "#compiler/served/read.ts"
import { servedSpine } from "#compiler/served/spine.ts"
import { succeeded } from "#test/support/assert.ts"
import {
	codebookFor,
	compileTemplate,
	firstCodes,
	schemaInputOf,
	testCompile
} from "#test/support/compile.ts"
import { Id } from "#test/support/ids.ts"
import { upTo } from "#test/support/up-to.ts"
import { outputText } from "#test/support/wire.ts"
import { ascendingTasks, compiledPageResult, Paging } from "#test/unit/page/fixtures.ts"

/** A child record of one column, `c`. */
const child = record({ c: { column: textColumn<string>() } })

/** The child record of `text`, as the child decoder reads it: a frozen null-prototype record. */
export const childOf = (text: string): { readonly c: string } =>
	Object.freeze({ __proto__: null, c: text })

export const context = (codes: Parameters<typeof codeNames>[0]): BindContext => ({
	options: rowOptions,
	names: codeNames(codes)
})

/** A parent layout holding one attachment, `kids`, whose analysis proved `proved`. */
export const parentLayout = (proved: Delivery): Layout => ({
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
export const parentRow = (n: number): Row => ({
	group: 0,
	cells: [],
	children: [
		Array.from({ length: n }, (_, i): Row => ({
			group: 0,
			cells: [outputText(`c${i}`)],
			children: []
		}))
	]
})

/** What the contract makes of `n` children under `reader`: the children, an Option, the one child, or a defect. */
type Expected =
	| { readonly kind: "children"; readonly n: number }
	| { readonly kind: "option"; readonly child: Option.Option<{ readonly c: string }> }
	| { readonly kind: "one"; readonly child: { readonly c: string } }
	| { readonly kind: "defect"; readonly law: ChildLaw }

export const expected = (reader: Delivery, n: number): Expected => {
	switch (reader) {
		case "array":
			return { kind: "children", n }
		case "option":
			return n === 0
				? { kind: "option", child: Option.none() }
				: n === 1
					? { kind: "option", child: Option.some(childOf("c0")) }
					: { kind: "defect", law: "atMostOne" }
		case "one":
			return n === 1
				? { kind: "one", child: childOf("c0") }
				: { kind: "defect", law: n === 0 ? "exactlyOne" : "atMostOne" }
	}
}

export const fieldOf = (reader: Delivery): RecordField<unknown> => attachment(child, reader)

interface DeliveryCase {
	readonly reader: Delivery
	readonly proved: Delivery
	readonly n: number
}

const deliveriesList: Arr.NonEmptyReadonlyArray<Delivery> = ["array", "option", "one"]

/** Every reader under every proof that licenses it, over zero to three children. */
export const deliveryCases: Gen<DeliveryCase> = (source) => ({
	reader: source.draw(element(deliveriesList)),
	proved: source.draw(element(deliveriesList)),
	n: source.draw(int(0, 3))
})

export type DeliveryFeature = "delivered" | "a defect" | "a proof that does not license the reader"

const Post = relation("Post", { id: Id, n: pg.numeric(10, 2) }, ["id"])
const Comment = relation("Comment", { id: Id, post: Id, n: pg.numeric(10, 2) }, ["id"])
const Blog = schema("Blog", [Post, Comment], [contained(on(Comment, "post"), on(Post, "id"))])

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

export const uuids = [
	"a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
	"a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a12",
	"a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a13",
	"a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a14",
	"a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a15",
	"a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a16"
] as const

/** Two spellings of each numeric value, as numeric_out writes it at two display scales. */
export const numerics: ReadonlyArray<readonly [string, string]> = [
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

export const stitchCases: Gen<StitchCase> = (source) => {
	const posts = source.draw(int(1, 3))
	const comments = source.draw(array(int(0, posts - 1), { min: 0, max: 3 }))
	return {
		posts,
		comments,
		numeric: upTo(posts + comments.length, () => source.draw(int(0, numerics.length - 1))),
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
export const cellText = (
	type: ScalarType,
	id: string,
	numeric: number,
	second: boolean
): string => {
	const spelled = defined(numerics[numeric], "a numeric")
	return type.carrier === "numeric" ? (second ? spelled[1] : spelled[0]) : id
}

export type StitchFeature =
	| "stitched"
	| "a repeat refused"
	| "a respelled repeat refused"
	| "a post without comments"
	| "a post with two comments"

const blogTemplate = succeeded(compileTemplate(postsWithComments, Blog, testCompile))

/** The read of each post with its comments, as the reader runs it: its root part and its attachment's. */
export const program = readProgram(
	servedSource(blogTemplate.runs.conservative),
	servedSpine(succeeded(queryInput(postsWithComments)).desc),
	succeeded(codebookFor(schemaInputOf(Blog), firstCodes))
)

/** The read's root part. */
export const root = defined(
	Arr.findFirst(program.records, (r) => r.part.role.kind !== "attachment").pipe(
		Option.getOrUndefined
	),
	"the root part"
)

/** The read's attachment part. */
export const attached = defined(
	Arr.findFirst(program.records, (r) => r.part.role.kind === "attachment").pipe(
		Option.getOrUndefined
	),
	"the attachment part"
)

const role = attached.part.role

/** How many columns an attachment part's rows lead with: its parent key's. */
export const keyCount = role.kind === "attachment" ? role.parentKey.length : 0

/** The columns a part's statement outputs. */
export const statementHeadingOf = (record: typeof root) =>
	statementOutput(record.part.role, record.part.heading, record.part.fused).heading

/** What a case plants among the fetched rows: nothing, a repeat of the first, the first two swapped, or one row more. */
type PagePlant = "none" | "an equal tuple" | "a step back" | "a row past its limit"

interface PageCase {
	readonly priorities: ReadonlyArray<number>
	readonly size: number
	readonly plant: PagePlant
}

/** Up to four tasks of distinct (priority, id), a window's size, and what the case plants among the rows. */
export const pageCases: Gen<PageCase> = (source) => ({
	priorities: source.draw(array(int(0, 2), { min: 0, max: 4 })),
	size: source.draw(int(1, 4)),
	plant: source.draw(
		element<PagePlant>(["none", "an equal tuple", "a step back", "a row past its limit"])
	)
})

/** A planted answer's refusal. */
type PageRefusal = "an equal tuple refused" | "a step back refused" | "a row past its limit refused"

export type PageFeature = "a short window" | "a full window" | PageRefusal

/** The rows a case answers its statement with: the fetched rows as the server sends them, or a plant among them. */
export type PageAnswer =
	| { readonly kind: "fetched"; readonly rows: ReadonlyArray<ReadonlyArray<string>> }
	| {
			readonly kind: "planted"
			readonly refusal: PageRefusal
			readonly rows: ReadonlyArray<ReadonlyArray<string>>
	  }

const compiled = succeeded(compiledPageResult(ascendingTasks, testCompile))

/** The window's read of the ascending tasks, as its runtime runs it. */
export const windowProgram = compiledPageRuntime({
	page: { ...compiled.page, artifact: compiled.baseline },
	params: compiled.query.params,
	spine: servedSpine(succeeded(queryInput(ascendingTasks)).desc),
	codes: succeeded(codebookFor(schemaInputOf(Paging), firstCodes))
}).artifact.requests.first

const rows = defined(windowProgram.records[0], "the rows part")

/** The columns the window's rows statement outputs. */
export const heading = statementOutput(rows.part.role, rows.part.heading, rows.part.fused).heading

/**
 * Tag(id, name) and Note(n, tag, body), each keyed by a number and holding a text of a's and b's of any length, which
 * no key holds, since a key's every column is bounded (schema/representability.ts): a read whose rows' identities hold
 * texts past V8's longest hashed text (kernel/long-keys.ts longestHashedText).
 */
const Tag = relation("Tag", { id: pg.integer, name: str.regex("^[ab]*$") }, ["id"])
const Note = relation("Note", { n: pg.integer, tag: pg.integer, body: str.regex("^[ab]*$") }, ["n"])
const Tagged = schema("Tagged", [Tag, Note], [contained(on(Note, "tag"), on(Tag, "id"))])

/** Each tag with its notes' bodies: a root statement and one attachment statement, its rows led by the tag's id. */
const tagsWithNotes = query(Tagged)
	.rule((r) => {
		const { id, name } = v(Tag, "tag")
		return r.match(Tag, { id, name }).find({ id, name })
	})
	.attach(
		"notes",
		(tag) =>
			query(Tagged).rule((r) => {
				const { n, body } = v(Note, "note")
				return r.match(Note, { n, tag: tag.id, body }).find({ n, body })
			}),
		"array"
	)

/** The read of each tag with its notes, as the reader runs it: its root part and its attachment's. */
export const taggedProgram = readProgram(
	servedSource(succeeded(compileTemplate(tagsWithNotes, Tagged, testCompile)).runs.conservative),
	servedSpine(succeeded(queryInput(tagsWithNotes)).desc),
	succeeded(codebookFor(schemaInputOf(Tagged), firstCodes))
)

/** The tagged read's root part and its attachment's. */
export const taggedRoot = defined(
	Arr.findFirst(taggedProgram.records, (r) => r.part.role.kind !== "attachment").pipe(
		Option.getOrUndefined
	),
	"the tagged read's root part"
)

export const taggedAttached = defined(
	Arr.findFirst(taggedProgram.records, (r) => r.part.role.kind === "attachment").pipe(
		Option.getOrUndefined
	),
	"the tagged read's attachment part"
)

/** How many columns of the tagged attachment's rows lead with its parent's key. */
export const taggedKeyCount =
	taggedAttached.part.role.kind === "attachment" ? taggedAttached.part.role.parentKey.length : 0
