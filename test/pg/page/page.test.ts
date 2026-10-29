import { layer } from "@effect/vitest"
import { drawn, exhaust, explore } from "@grizzle/testing/explore"
import { features, noFeatures } from "@grizzle/testing/features"
import {
	array,
	boolean,
	constant,
	element,
	type Gen,
	int,
	oneOf,
	weighted
} from "@grizzle/testing/gen"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import {
	Array as Arr,
	Duration,
	Effect,
	Formatter,
	Layer,
	Option,
	pipe,
	String as Str
} from "effect"
import { dbContext } from "#adapter/db/context.ts"
import { ReadFailure } from "#adapter/errors/execution.ts"
import { PageRequestRefused, type RequestFault } from "#adapter/errors/failures.ts"
import { Db } from "#adapter/public/db.ts"
import { makeReader, poolExecutor } from "#adapter/reader/reader.ts"
import { cursorCodec } from "#compiler/codec/cursor/codec.ts"
import { CursorError, type CursorFault } from "#compiler/core/errors.ts"
import { cursorMaxBytes, pageMaxSize } from "#compiler/core/policy.ts"
import { uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import {
	assertEdges,
	canon,
	checkTraversals,
	countingExecutor,
	type PageValue,
	pageOrder,
	pageTemplate,
	compiledPage,
	rowOf,
	sortedResult,
	strictlyAfter,
	strictlyBefore,
	traverse,
	untyped
} from "#test/pg/page/support.ts"
import { installed } from "#test/pg/reads/support.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import { replaceMigrated as replace } from "#test/support/install-migrate.ts"
import { indices } from "#test/support/oracle/pick.ts"
import { pickFrom, pickGen, pickIndex } from "#test/support/pick.ts"
import { dbReader } from "#test/support/runtime-db.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import {
	ascendingTasks,
	descendingTasks,
	flagged,
	flaggedByTitle,
	priorityDescendingTasks,
	Paging,
	priorityCounts,
	Task,
	tasksWithNotes,
	titles
} from "#test/unit/page/fixtures.ts"

/**
 * The page runtime through the readers.
 *
 * The traversal property, that forward and backward pages at every size 1 through 7 concatenate to the complete sorted
 * distinct result D with exact flags and that each page's attachments read exactly its delivered parents' children, is
 * test/pg/page/generated.ts's, over generated ordered queries, minus the transaction and the handles. Here the Paging
 * fixture installs under a fresh schema and opens through Db.open and a DbLayer as its full world, exactly as an
 * application pages:
 *
 * - Db pages are stateless: each opens and commits its own read-only transaction, and their cursors continue across
 *   requests;
 * - every request answers exactly by the D of the moment and its anchor's encoded values, through db.page or a
 *   compiled handle, whatever happened to D since the anchor's cursor was made: over drawn facts, a drawn query of
 *   the fixture and a walk of drawn requests, each anchored on an edge some earlier page delivered, through either
 *   handle, with drawn changes to D between them (deleting an anchor's task, moving it, deleting the last page,
 *   inserting, flagging, emptying the account), each written as the facts' whole new state in one transaction that
 *   reads nothing (test/support/substrate/replace.ts), so no reset is an SSI pivot under load. A first page holds D's
 *   first k tuples and a last page its last k; an after page the first k tuples strictly after the anchor, a before
 *   page the last k strictly before it. The flag of the fetching direction is whether more remain on that side; the
 *   opposite flag of an anchored page is whether D holds a tuple at or before the anchor (after) or at or after it
 *   (before), whether or not the anchor is still in D; a first page has no previous page and a last page no next;
 * - a token that is not one this query issued for this generation, and a request of another shape or size, is refused
 *   before any SQL: CursorError for the token, PageRequestRefused with its fault for the request, the counting
 *   executor seeing no transaction and no statement;
 * - a delivered comparison tuple too long for a cursor fails the page.
 *
 * test/pg/page/values.test.ts covers the boundary values, test/pg/page/plans.test.ts the plans, and
 * test/pg/page/generated.ts the generated ordered queries.
 */

const id = (n: number): string =>
	`00000000-0000-4000-8000-${pipe(n.toString(16), Str.padStart(12, "0"))}`
const A = id(0xa)
const B = id(0xb)
const D = id(0xd)
const t = (n: number) => id(0x1000 + n)

/**
 * Account A: 23 tasks over five priorities, titles repeating, a supplementary-plane title among them; B: three; D:
 * one. Notes and flags on some of A's tasks.
 */
const titleChoices = ["alpha", "beta", "gamma", "𝔘nicode", "beta"] as const
const titleOf = (n: number): string => defined(titleChoices[n % titleChoices.length])
const facts = {
	Task: [
		...Arr.map(indices(23), (n) => ({
			id: t(n),
			account: A,
			priority: (n * 7) % 5,
			title: titleOf(n)
		})),
		...Arr.map(indices(3), (n) => ({
			id: t(100 + n),
			account: B,
			priority: n,
			title: titleOf(n + 1)
		})),
		{ id: t(200), account: D, priority: 4, title: "solo" }
	],
	Note: Arr.map([0, 1, 1, 3, 5, 5, 5, 8, 13, 21], (n, k) => ({ task: t(n), note: `note ${k}` })),
	Flag: Arr.map([0, 2, 3, 6, 7, 9, 11, 14, 17, 20, 22], (n) => ({
		task: t(n),
		level: n % 3 === 0 ? "High" : "Low"
	}))
}

/**
 * The same heading, parameters and order as orderedTasks, so the same TypeScript shape, with a different filter: a
 * token of one is not a token of the other.
 */
const nonNegativeTasks = query(Paging)
	.rule((r) => {
		const { id: tid, account, priority, title } = v(Task)
		return r
			.match(Task, { id: tid, account, priority, title })
			.where(r.eq(account, r.param("account", uuid)))
			.where(r.ge(priority, 0))
			.find({ id: tid, priority, title })
	})
	.orderBy(["priority", "desc"])

const cursorFailure = (fault: CursorFault) => CursorError.make({ _tag: fault })

/**
 * The ordered queries of the fixture a walk or a token is drawn over: one native row comparison either way, mixed
 * directions, a keyless projection, a grouped result, an attachment, and two heterogeneous unions.
 */
const pagedQueries = {
	ordered: priorityDescendingTasks,
	ascending: ascendingTasks,
	descending: descendingTasks,
	titles,
	counts: priorityCounts,
	notes: tasksWithNotes,
	flagged,
	"flagged by title": flaggedByTitle
} as const
type PagedQuery = keyof typeof pagedQueries
const pagedQueryNames: Arr.NonEmptyReadonlyArray<PagedQuery> = [
	"ordered",
	"ascending",
	"descending",
	"titles",
	"counts",
	"notes",
	"flagged",
	"flagged by title"
]

/** A task the facts or a write draw: its account (0 is the one paged, 1 another), priority and title. */
interface TaskSketch {
	readonly other: boolean
	readonly priority: number
	readonly title: number
}

const taskSketchGen: Gen<TaskSketch> = (source) => ({
	other: source.draw(boolean),
	priority: source.draw(int(0, 4)),
	title: source.draw(int(0, titleChoices.length - 1))
})

/**
 * A direct write between two requests. A target pick resolves over the tasks of the anchor pool's nodes (an edge's
 * task: its own, or the tasks a keyless node stands for) or, when the pool is empty, over every task.
 */
type Write =
	| { readonly kind: "delete an edge's tasks"; readonly target: number }
	| {
			readonly kind: "move an edge's tasks"
			readonly target: number
			readonly priority: number
			readonly title: number
	  }
	| { readonly kind: "delete the last page" }
	| { readonly kind: "insert"; readonly task: TaskSketch }
	| { readonly kind: "flag"; readonly target: number; readonly level: "High" | "Low" | "none" }
	| { readonly kind: "empty the account" }

const writeGen: Gen<Write> = weighted<Write>([
	[3, (source) => ({ kind: "delete an edge's tasks", target: source.draw(pickGen) })],
	[
		3,
		(source) => ({
			kind: "move an edge's tasks",
			target: source.draw(pickGen),
			priority: source.draw(element([-7, 0, 1, 2, 3, 4, 99])),
			title: source.draw(int(0, titleChoices.length - 1))
		})
	],
	[2, constant({ kind: "delete the last page" })],
	[2, (source) => ({ kind: "insert", task: source.draw(taskSketchGen) })],
	[
		2,
		(source) => ({
			kind: "flag",
			target: source.draw(pickGen),
			level: source.draw(element(["High", "Low", "none"] as const))
		})
	],
	[1, constant({ kind: "empty the account" })]
])

/** Which edge an anchored request takes: the last page's end or start, or any edge delivered so far. */
type AnchorPick =
	| { readonly kind: "end" }
	| { readonly kind: "start" }
	| { readonly kind: "any"; readonly pick: number }

interface RequestSketch {
	readonly variant: "first" | "last" | "after" | "before"
	readonly size: number
	readonly anchor: AnchorPick
	readonly handle: "db" | "compiled"
}

const requestSketchGen: Gen<RequestSketch> = (source) => ({
	variant: source.draw(element(["first", "last", "after", "before", "after", "before"] as const)),
	size: source.draw(int(1, 7)),
	anchor: source.draw(
		oneOf<AnchorPick>([
			constant({ kind: "end" }),
			constant({ kind: "start" }),
			(inner) => ({ kind: "any", pick: inner.draw(pickGen) })
		])
	),
	handle: source.draw(element(["db", "compiled"] as const))
})

interface StepSketch {
	readonly writes: ReadonlyArray<Write>
	readonly request: RequestSketch
}

interface WalkSketch {
	readonly query: PagedQuery
	readonly tasks: ReadonlyArray<TaskSketch>
	/** Notes and flags over the tasks, by pick. */
	readonly notes: ReadonlyArray<{ readonly task: number; readonly note: number }>
	readonly flags: ReadonlyArray<{ readonly task: number; readonly high: boolean }>
	readonly steps: ReadonlyArray<StepSketch>
}

/**
 * A walk's steps: drawn, or planted a fifth of the time as a page from one end, its edges deleted, and the page past
 * it, so an anchored page whose anchor and every tuple on one side of it left D, whose opposite flag the probe alone
 * can clear, is reached on every run.
 */
const handleGen: Gen<RequestSketch["handle"]> = element(["db", "compiled"] as const)

const stepsGen: Gen<ReadonlyArray<StepSketch>> = weighted<ReadonlyArray<StepSketch>>([
	[
		4,
		array(
			(source): StepSketch => ({
				writes: source.draw(
					oneOf<ReadonlyArray<Write>>([constant([]), array(writeGen, { min: 1, max: 3 })])
				),
				request: source.draw(requestSketchGen)
			}),
			{ min: 1, max: 6 }
		)
	],
	[
		1,
		(source): ReadonlyArray<StepSketch> => {
			const forward = source.draw(boolean)
			const first = source.draw(int(1, 7))
			const next = source.draw(int(1, 7))
			const handles = [source.draw(handleGen), source.draw(handleGen)] as const
			return [
				{
					writes: [],
					request: {
						variant: forward ? "first" : "last",
						size: first,
						anchor: { kind: "end" },
						handle: handles[0]
					}
				},
				{
					writes: [{ kind: "delete the last page" }],
					request: {
						variant: forward ? "after" : "before",
						size: next,
						anchor: forward ? { kind: "end" } : { kind: "start" },
						handle: handles[1]
					}
				}
			]
		}
	]
])

const walkSketchGen: Gen<WalkSketch> = (source) => ({
	query: source.draw(element(pagedQueryNames)),
	tasks: source.draw(array(taskSketchGen, { min: 0, max: 16 })),
	notes: source.draw(
		array((inner) => ({ task: inner.draw(pickGen), note: inner.draw(int(0, 2)) }), {
			min: 0,
			max: 10
		})
	),
	flags: source.draw(
		array((inner) => ({ task: inner.draw(pickGen), high: inner.draw(boolean) }), {
			min: 0,
			max: 10
		})
	),
	steps: source.draw(stepsGen)
})

type WalkFeature =
	| `query ${PagedQuery}`
	| `${RequestSketch["variant"]} through ${RequestSketch["handle"]}`
	| "a cursor of the other handle"
	| "an anchor gone from D"
	| "an anchor still in D"
	| "an opposite flag cleared past a gone anchor"
	| "an empty anchored page"
	| "an emptied D"
	| "a write between requests"

/** A task of the walk's model: what the database holds, which writes and node lookups resolve against. */
interface ModelTask {
	readonly id: string
	readonly account: string
	readonly priority: number
	readonly title: string
	readonly flag: "High" | "Low" | "none"
}

/** An edge some page delivered: its cursor, its node, the handle that made it. */
interface Delivered {
	readonly cursor: string
	readonly node: unknown
	readonly handle: RequestSketch["handle"]
}

/**
 * The ids of a model's tasks a node stands for: a keyed node's own task, or every task of the paged account a keyless
 * node collapses (a title's, a priority's count).
 */
const tasksOf = (
	q: PagedQuery,
	node: unknown,
	tasks: ReadonlyArray<ModelTask>
): ReadonlyArray<string> => {
	const fields = rowOf(node)
	switch (q) {
		case "titles":
			return Arr.map(
				Arr.filter(tasks, (x) => x.account === A && x.title === fields["title"]),
				(x) => x.id
			)
		case "counts":
			return Arr.map(
				Arr.filter(tasks, (x) => x.account === A && x.priority === fields["priority"]),
				(x) => x.id
			)
		case "ascending":
		case "descending":
		case "flagged":
		case "flagged by title":
		case "notes":
		case "ordered":
			return Arr.map(
				Arr.filter(tasks, (x) => x.id === fields["id"]),
				(x) => x.id
			)
	}
}

/**
 * The anchor a request takes, if it has one: the last page's end or start, or any edge delivered so far; none before
 * any edge was delivered.
 */
const anchorOf = (
	pick: AnchorPick,
	last: ReadonlyArray<Delivered>,
	pool: ReadonlyArray<Delivered>
): Option.Option<Delivered> => {
	const end = last.at(-1)
	const start = last.at(0)
	if (pick.kind === "end" && end !== undefined) {
		return Option.some(end)
	}
	if (pick.kind === "start" && start !== undefined) {
		return Option.some(start)
	}
	if (pool.length === 0) {
		return Option.none()
	}
	return Option.some(defined(pool[pickIndex(pick.kind === "any" ? pick.pick : 0, pool.length)]))
}

/** A page as the oracle states it: its canonical nodes and its flags. */
interface Expected {
	readonly nodes: ReadonlyArray<unknown>
	readonly hasPreviousPage: boolean
	readonly hasNextPage: boolean
}

const answered = (page: PageValue): Expected => ({
	nodes: Arr.map(page.edges, (e) => canon(e.node)),
	hasPreviousPage: page.pageInfo.hasPreviousPage,
	hasNextPage: page.pageInfo.hasNextPage
})

/** The base64url alphabet a token is written in, and characters outside it. */
const base64url = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
const foreign = ["!", "+", "/", " ", "=", "é", "\u{1F600}"] as const
/** The characters of a token's three digests: 51 bytes, every one of its first 68 characters within them. */
const digestCharacters = 68

/** What is done to a valid token or its request, and what the refusal is. */
type Tamper =
	| { readonly kind: "a character of a digest changed"; readonly at: number; readonly to: number }
	| { readonly kind: "truncated"; readonly keep: number }
	| { readonly kind: "padded" }
	| {
			readonly kind: "a foreign character"
			readonly at: number
			readonly char: (typeof foreign)[number]
	  }
	| { readonly kind: "oversized"; readonly extra: number }
	| { readonly kind: "another query"; readonly query: number }
	| { readonly kind: "another generation" }
	| {
			readonly kind: "not a string"
			readonly value: "null" | "undefined" | "number" | "object" | "boolean"
	  }
	| {
			readonly kind: "another request shape"
			readonly shape:
				| "both sizes"
				| "the other anchor"
				| "both anchors"
				| "no size"
				| "an extra property"
				| "no object"
	  }
	| {
			readonly kind: "a size out of range"
			readonly size:
				| "zero"
				| "negative"
				| "fraction"
				| "NaN"
				| "infinite"
				| "above pageMaxSize"
				| "text"
				| "bigint"
	  }

const tamperGen: Gen<Tamper> = oneOf<Tamper>([
	(source) => ({
		kind: "a character of a digest changed",
		at: source.draw(pickGen),
		to: source.draw(pickGen)
	}),
	(source) => ({ kind: "truncated", keep: source.draw(pickGen) }),
	constant({ kind: "padded" }),
	(source) => ({
		kind: "a foreign character",
		at: source.draw(pickGen),
		char: source.draw(element(foreign))
	}),
	(source) => ({ kind: "oversized", extra: source.draw(int(1, 64)) }),
	(source) => ({ kind: "another query", query: source.draw(pickGen) }),
	constant({ kind: "another generation" }),
	(source) => ({
		kind: "not a string",
		value: source.draw(element(["null", "undefined", "number", "object", "boolean"] as const))
	}),
	(source) => ({
		kind: "another request shape",
		shape: source.draw(
			element([
				"both sizes",
				"the other anchor",
				"both anchors",
				"no size",
				"an extra property",
				"no object"
			] as const)
		)
	}),
	(source) => ({
		kind: "a size out of range",
		size: source.draw(
			element([
				"zero",
				"negative",
				"fraction",
				"NaN",
				"infinite",
				"above pageMaxSize",
				"text",
				"bigint"
			] as const)
		)
	})
])

interface TokenCase {
	/** The query whose page issued the token, the page and the edge whose cursor it is. */
	readonly query: PagedQuery
	readonly from: "first" | "last"
	readonly size: number
	readonly edge: number
	/** Which way the tampered request continues. */
	readonly direction: "after" | "before"
	readonly tamper: Tamper
}

const tokenCaseGen: Gen<TokenCase> = (source) => ({
	query: source.draw(element(pagedQueryNames)),
	from: source.draw(element(["first", "last"] as const)),
	size: source.draw(int(1, 7)),
	edge: source.draw(pickGen),
	direction: source.draw(element(["after", "before"] as const)),
	tamper: source.draw(tamperGen)
})

/**
 * What the contract says a tampered request meets: a cursor refusal of one stated reason, a cursor refusal of any reason
 * the token's bytes lead to, or the request refusal of its shape or its size.
 */
type Verdict =
	| { readonly kind: "cursor"; readonly reason: CursorFault }
	| { readonly kind: "some cursor refusal" }
	| { readonly kind: "request"; readonly fault: RequestFault }

const sizeOf = (size: Extract<Tamper, { kind: "a size out of range" }>["size"]): unknown => {
	switch (size) {
		case "zero":
			return 0
		case "negative":
			return -1
		case "fraction":
			return 1.5
		case "NaN":
			return Number.NaN
		case "infinite":
			return Number.POSITIVE_INFINITY
		case "above pageMaxSize":
			return pageMaxSize + 1
		case "text":
			return "2"
		case "bigint":
			return 2n
	}
}

const nonString = (value: Extract<Tamper, { kind: "not a string" }>["value"]): unknown => {
	switch (value) {
		case "null":
			return null
		case "undefined":
			return undefined
		case "number":
			return 7
		case "object":
			return {}
		case "boolean":
			return true
	}
}

layer(Substrate.layer)("the page runtime through the readers", (it) => {
	it.effect(
		"Db pages are stateless: each request commits its own transaction, and its cursors continue",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const opened = yield* installed(Paging, facts, { label: "real", extensions: [] })
					return yield* Effect.gen(function* () {
						const db = yield* Db.open(opened.server.roles.app, {})
						const context = dbContext(db)
						if (context === undefined) {
							return yield* Effect.die(new Error("no context"))
						}
						const { executor, counts } = countingExecutor(poolExecutor(context))
						const counted = untyped(makeReader(context, executor))
						const params = { account: A }
						const compiled = pageTemplate(db, priorityDescendingTasks)
						const full = sortedResult(
							compiled,
							yield* (yield* db.execute(priorityDescendingTasks, params)).collect
						)
						/**
						 * Every page size from one to past the account's 23 tasks: each traversal's pages are as many
						 * transactions, and both directions deliver D.
						 */
						const sizes = yield* exhaust(
							{
								suite: "pg/page/stateless",
								generator: int(1, 25),
								literal: String,
								limit: 25,
								features: noFeatures,
								caseHang: Duration.minutes(2)
							},
							(size) =>
								Effect.gen(function* () {
									const before = counts.within
									const forward = yield* traverse(
										counted,
										priorityDescendingTasks,
										params,
										"forward",
										size,
										{
											kind: "end"
										}
									)
									assert.deepEqual(forward.nodes, full, `forward ${size}`)
									assert.equal(counts.within - before, forward.pages.length)
									const backward = yield* traverse(
										counted,
										priorityDescendingTasks,
										params,
										"backward",
										size,
										{
											kind: "end"
										}
									)
									assert.deepEqual(backward.nodes, full, `backward ${size}`)
								})
						)
						/**
						 * The page's own transaction is over once it returned: its cursors are stateless, accepted by any later
						 * page of the query.
						 */
						const page = yield* counted.page(priorityDescendingTasks, params, { first: 3 })
						const end = Option.getOrThrow(page.pageInfo.endCursor)
						const next = yield* untyped(dbReader(db)).page(priorityDescendingTasks, params, {
							first: 3,
							after: end
						})
						assert.deepEqual(
							Arr.map(next.edges, (e) => canon(e.node)),
							full.slice(3, 6)
						)
						/**
						 * A first page takes no probe beyond the lookahead: one statement, in one flight. An after page sends its
						 * rows statement and the probe its anchor binds, which reads no other statement's rows, in one flight
						 * (adapter/page/execute.ts).
						 */
						const sent = counts.statements
						const flown = counts.flights
						yield* counted.page(priorityDescendingTasks, params, { first: 3 })
						assert.equal(counts.statements - sent, 1)
						assert.equal(counts.flights - flown, 1)
						yield* counted.page(priorityDescendingTasks, params, { first: 3, after: end })
						assert.equal(counts.statements - sent, 3)
						assert.equal(counts.flights - flown, 2)
						return sizes
					}).pipe(
						Effect.scoped,
						(body) =>
							Effect.flatMap(Layer.build(opened.layer), (context) =>
								Effect.provideContext(body, context)
							),
						Effect.scoped
					)
				}).pipe(Effect.scoped)
			)
	)

	it.effect(
		"answers every request by the D of the moment and its anchor's encoded values, through either handle, whatever changed since its cursor was made",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const opened = yield* installed(Paging, {}, { label: "real", extensions: [] })
					return yield* Effect.gen(function* () {
						const db = yield* Db.open(opened.server.roles.app, {})
						const pages = untyped(dbReader(db))
						return yield* explore(
							{
								suite: "pg/page/walks",
								draw: drawn(walkSketchGen),
								literal: Formatter.format,
								kept: [],
								runs: 100,
								shrink: completeShrink,
								concurrency: 1,
								steerEvery: 16,
								steering: { kind: "none" },
								caseHang: Duration.minutes(2),
								features: features<WalkFeature>([
									...Arr.map(pagedQueryNames, (q): WalkFeature => `query ${q}`),
									...Arr.flatMap(["first", "last", "after", "before"] as const, (variant) =>
										Arr.map(
											["db", "compiled"] as const,
											(handle): WalkFeature => `${variant} through ${handle}`
										)
									),
									"a cursor of the other handle",
									"an anchor gone from D",
									"an anchor still in D",
									"an opposite flag cleared past a gone anchor",
									"an empty anchored page",
									"an emptied D",
									"a write between requests"
								])
							},
							(walk, c) =>
								Effect.gen(function* () {
									const q = pagedQueries[walk.query]
									const params = { account: A }
									const compiled = pageTemplate(db, q)
									const order = pageOrder(compiled)
									const handle = yield* dbReader(db).compile(q)
									/** The facts: the drawn tasks, a note pair once, a flag per task. */
									const model: Array<ModelTask> = Arr.map(walk.tasks, (x, n) => ({
										id: t(n),
										account: x.other ? B : A,
										priority: x.priority,
										title: titleOf(x.title),
										flag: "none"
									}))
									for (const f of walk.flags) {
										if (model.length > 0) {
											const at = pickIndex(f.task, model.length)
											model[at] = { ...defined(model[at]), flag: f.high ? "High" : "Low" }
										}
									}
									const notes = new Map<string, { readonly task: string; readonly note: string }>()
									for (const n of walk.notes) {
										if (model.length > 0) {
											const owner = defined(model[pickIndex(n.task, model.length)]).id
											notes.set(`${owner} ${n.note}`, { task: owner, note: `note ${n.note}` })
										}
									}
									/**
									 * D's facts as the model holds them when it runs: its tasks, the notes of the tasks it
									 * still holds, its flags.
									 */
									const writeModel = Effect.suspend(() =>
										replace(opened.installed, {
											Task: Arr.map(model, (x) => ({
												id: x.id,
												account: x.account,
												priority: x.priority,
												title: x.title
											})),
											Note: Arr.filter([...notes.values()], (n) =>
												Arr.some(model, (x) => x.id === n.task)
											),
											Flag: Arr.flatMap(model, (x) =>
												x.flag === "none" ? [] : [{ task: x.id, level: x.flag }]
											)
										})
									)
									yield* writeModel
									let fresh = walk.tasks.length
									const pool: Array<Delivered> = []
									let last: ReadonlyArray<Delivered> = []
									for (const step of walk.steps) {
										/** The writes, each resolved against the model. */
										const targets = (pick: number): ReadonlyArray<string> => {
											const marked = [
												...new Set(Arr.flatMap(pool, (d) => tasksOf(walk.query, d.node, model)))
											]
											const candidates =
												marked.length > 0
													? marked
													: Arr.map(
															Arr.filter(model, (x) => x.account === A),
															(x) => x.id
														)
											if (candidates.length === 0) {
												return []
											}
											const chosen = defined(candidates[pickIndex(pick, candidates.length)])
											return Option.match(
												Arr.findFirst(pool, (d) =>
													tasksOf(walk.query, d.node, model).includes(chosen)
												),
												{
													onNone: () => [chosen],
													onSome: (node) => tasksOf(walk.query, node.node, model)
												}
											)
										}
										/** A removed task takes its notes and its flag with it. */
										const remove = (ids: ReadonlyArray<string>) => {
											for (const i of ids) {
												const at = Arr.findFirstIndex(model, (x) => x.id === i)
												if (Option.isSome(at)) {
													model.splice(at.value, 1)
												}
											}
										}
										/** Each target task, changed in place in the model. */
										const update = (
											ids: ReadonlyArray<string>,
											change: (task: ModelTask) => ModelTask
										) => {
											for (const i of ids) {
												const at = Option.getOrThrow(Arr.findFirstIndex(model, (x) => x.id === i))
												model[at] = change(defined(model[at]))
											}
										}
										for (const write of step.writes) {
											switch (write.kind) {
												case "delete an edge's tasks":
													remove(targets(write.target))
													break
												case "delete the last page":
													remove([
														...new Set(Arr.flatMap(last, (d) => tasksOf(walk.query, d.node, model)))
													])
													break
												case "empty the account":
													remove(
														Arr.map(
															Arr.filter(model, (x) => x.account === A),
															(x) => x.id
														)
													)
													break
												case "move an edge's tasks":
													update(targets(write.target), (task) => ({
														...task,
														priority: write.priority,
														title: titleOf(write.title)
													}))
													break
												case "insert":
													model.push({
														id: t(fresh++),
														account: write.task.other ? B : A,
														priority: write.task.priority,
														title: titleOf(write.task.title),
														flag: "none"
													})
													break
												case "flag":
													update(targets(write.target), (task) => ({
														...task,
														flag: write.level
													}))
													break
											}
										}
										if (step.writes.length > 0) {
											yield* writeModel
										}
										if (step.writes.length > 0 && pool.length > 0) {
											c.note("a write between requests")
										}
										/** The request, anchored on a delivered edge when it names one and one exists. */
										const r = step.request
										const anchor =
											r.variant === "after" || r.variant === "before"
												? anchorOf(r.anchor, last, pool)
												: Option.none<Delivered>()
										const variant = Option.isSome(anchor)
											? r.variant
											: r.variant === "first" || r.variant === "after"
												? "first"
												: "last"
										const request = Option.isSome(anchor)
											? variant === "after"
												? { first: r.size, after: anchor.value.cursor }
												: { last: r.size, before: anchor.value.cursor }
											: variant === "first"
												? { first: r.size }
												: { last: r.size }
										const page =
											r.handle === "db"
												? yield* pages.page(q, params, request)
												: yield* compiledPage(handle, params, request)
										assertEdges(page, `${variant} ${r.size}`)
										/** The oracle: D now, and the anchor's values as its cursor encoded them. */
										const rows = yield* Effect.flatMap(
											pages.execute(q, params),
											(result) => result.collect
										)
										const full = sortedResult(compiled, rows)
										const k = r.size
										const expected: Expected = Option.match(anchor, {
											onNone: () =>
												variant === "first"
													? {
															nodes: full.slice(0, k),
															hasPreviousPage: false,
															hasNextPage: full.length > k
														}
													: {
															nodes: full.slice(Math.max(0, full.length - k)),
															hasPreviousPage: full.length > k,
															hasNextPage: false
														},
											onSome: ({ node }) => {
												if (variant === "after") {
													const past = strictlyAfter(compiled, rows, node)
													return {
														nodes: past.slice(0, k),
														hasPreviousPage: Arr.some(rows, (row) => order(row, node) <= 0),
														hasNextPage: past.length > k
													}
												}
												const before = strictlyBefore(compiled, rows, node)
												return {
													nodes: before.slice(Math.max(0, before.length - k)),
													hasPreviousPage: before.length > k,
													hasNextPage: Arr.some(rows, (row) => order(row, node) >= 0)
												}
											}
										})
										assert.deepEqual(
											answered(page),
											expected,
											`${variant} ${k} through ${r.handle}`
										)
										c.note(`query ${walk.query}`)
										c.note(`${variant} through ${r.handle}`)
										if (Option.isSome(anchor)) {
											const gone = !Arr.some(rows, (row) => order(row, anchor.value.node) === 0)
											c.note(gone ? "an anchor gone from D" : "an anchor still in D")
											const opposite =
												variant === "after" ? expected.hasPreviousPage : expected.hasNextPage
											if (gone && !opposite) {
												c.note("an opposite flag cleared past a gone anchor")
											}
											if (expected.nodes.length === 0) {
												c.note("an empty anchored page")
											}
											if (full.length === 0) {
												c.note("an emptied D")
											}
											if (anchor.value.handle !== r.handle) {
												c.note("a cursor of the other handle")
											}
										}
										last = Arr.map(page.edges, (e) => ({
											cursor: e.cursor,
											node: e.node,
											handle: r.handle
										}))
										pool.push(...last)
									}
								}).pipe(Effect.scoped)
						)
					}).pipe(
						Effect.scoped,
						(body) =>
							Effect.flatMap(Layer.build(opened.layer), (context) =>
								Effect.provideContext(body, context)
							),
						Effect.scoped
					)
				}).pipe(Effect.scoped)
			),
		300_000
	)

	it.effect(
		"refuses every token this query did not issue for this generation, and every other request shape or size, before any SQL",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const opened = yield* installed(Paging, facts, { label: "real", extensions: [] })
					return yield* Effect.gen(function* () {
						const db = yield* Db.open(opened.server.roles.app, {})
						const context = dbContext(db)
						if (context === undefined) {
							return yield* Effect.die(new Error("no context"))
						}
						const { executor, counts } = countingExecutor(poolExecutor(context))
						const counted = untyped(makeReader(context, executor))
						return yield* explore(
							{
								/**
								 * Refused before any SQL: no transaction opened, no statement sent.
								 *
								 * The token itself still continues.
								 */
								suite: "pg/page/tokens",
								draw: drawn(tokenCaseGen),
								literal: Formatter.format,
								kept: [],
								runs: 200,
								shrink: completeShrink,
								concurrency: 1,
								steerEvery: 16,
								steering: { kind: "none" },
								caseHang: Duration.minutes(2),
								features: features<Tamper["kind"] | `issued by ${PagedQuery}`>([
									"a character of a digest changed",
									"truncated",
									"padded",
									"a foreign character",
									"oversized",
									"another query",
									"another generation",
									"not a string",
									"another request shape",
									"a size out of range",
									...Arr.map(pagedQueryNames, (q) => `issued by ${q}` as const)
								])
							},
							(c, notes) =>
								Effect.gen(function* () {
									const q = pagedQueries[c.query]
									const params = { account: A }
									const issued = yield* counted.page(
										q,
										params,
										c.from === "first" ? { first: c.size } : { last: c.size }
									)
									const edge = defined(
										issued.edges[pickIndex(c.edge, issued.edges.length)],
										"an edge"
									)
									const token = edge.cursor
									const plain = (cursor: unknown): Record<string, unknown> =>
										c.direction === "after"
											? { first: 2, after: cursor }
											: { last: 2, before: cursor }
									const tamper = c.tamper
									/** The request sent, the query and parameters it is sent with, and the verdict the contract gives. */
									const tampered = ((): {
										readonly query: unknown
										readonly params: object
										readonly request: unknown
										readonly verdict: Verdict
									} => {
										const same = { query: q, params }
										switch (tamper.kind) {
											case "a character of a digest changed": {
												const at = pickIndex(
													tamper.at,
													Math.min(digestCharacters, token.length - 1)
												)
												const was = Option.getOrThrowWith(
													pipe(base64url, Str.indexOf(defined(token[at]))),
													() => new Error("a base64url digit")
												)
												const to =
													(was + 1 + pickIndex(tamper.to, base64url.length - 1)) % base64url.length
												return {
													...same,
													request: plain(
														`${Str.slice(0, at)(token)}${base64url[to]}${Str.slice(at + 1)(token)}`
													),
													verdict: { kind: "some cursor refusal" }
												}
											}
											case "truncated":
												return {
													...same,
													request: plain(
														pipe(token, Str.slice(0, pickIndex(tamper.keep, token.length)))
													),
													verdict: { kind: "some cursor refusal" }
												}
											case "padded":
												return {
													...same,
													request: plain(`${token}=`),
													verdict: { kind: "cursor", reason: "cursorEncoding" }
												}
											case "a foreign character": {
												const at = pickIndex(tamper.at, token.length + 1)
												return {
													...same,
													request: plain(
														`${Str.slice(0, at)(token)}${tamper.char}${Str.slice(at)(token)}`
													),
													verdict: { kind: "cursor", reason: "cursorEncoding" }
												}
											}
											case "oversized":
												return {
													...same,
													request: plain(Str.repeat(cursorMaxBytes + tamper.extra)("A")),
													verdict: { kind: "cursor", reason: "cursorOversized" }
												}
											case "another query": {
												/** The same TypeScript shape with another filter, or any other query of the fixture. */
												const others: Arr.NonEmptyReadonlyArray<unknown> = [
													nonNegativeTasks,
													...Arr.map(
														Arr.filter(pagedQueryNames, (n) => n !== c.query),
														(n) => pagedQueries[n]
													)
												]
												return {
													query: pickFrom(others, tamper.query),
													params,
													request: plain(token),
													verdict: { kind: "cursor", reason: "cursorQuery" }
												}
											}
											case "another generation": {
												const runtime = pageTemplate(db, q).runtime
												const old = cursorCodec(
													{
														query: runtime.identity.query,
														comparators: runtime.page.comparators,
														generation: {
															schema: `${runtime.identity.generation.schema}-previous`,
															extensions: {}
														}
													},
													cursorMaxBytes
												)
												const decoded = succeeded(runtime.codec.decode(token))
												const reissued = succeeded(succeeded(old).encode(decoded.values))
												return {
													...same,
													request: plain(reissued),
													verdict: { kind: "cursor", reason: "cursorGeneration" }
												}
											}
											case "not a string":
												return {
													...same,
													request: plain(nonString(tamper.value)),
													verdict: { kind: "cursor", reason: "cursorType" }
												}
											case "another request shape": {
												const request = ((): unknown => {
													switch (tamper.shape) {
														case "both sizes":
															return { first: 2, last: 2 }
														case "the other anchor":
															return c.direction === "after"
																? { first: 2, before: token }
																: { last: 2, after: token }
														case "both anchors":
															return {
																...plain(token),
																[c.direction === "after" ? "before" : "after"]: token
															}
														case "no size":
															return c.direction === "after" ? { after: token } : { before: token }
														case "an extra property":
															return { ...plain(token), size: 2 }
														case "no object":
															return token
													}
												})()
												return {
													...same,
													request,
													verdict: { kind: "request", fault: "requestShape" }
												}
											}
											case "a size out of range":
												return {
													...same,
													request:
														c.direction === "after"
															? { first: sizeOf(tamper.size), after: token }
															: { last: sizeOf(tamper.size), before: token },
													verdict: { kind: "request", fault: "requestSize" }
												}
										}
									})()
									const within = counts.within
									const statements = counts.statements
									const failure = yield* Effect.flip(
										counted.page(tampered.query, tampered.params, tampered.request)
									)
									switch (tampered.verdict.kind) {
										case "cursor":
											assert.deepEqual(failure, cursorFailure(tampered.verdict.reason), tamper.kind)
											break
										case "some cursor refusal":
											assert.ok(
												failure instanceof CursorError,
												`${tamper.kind}: ${String(failure)}`
											)
											break
										case "request":
											assert.deepEqual(
												failure,
												ReadFailure.make({
													reason: PageRequestRefused.make({ fault: tampered.verdict.fault })
												}),
												tamper.kind
											)
											break
									}
									assert.deepEqual(
										[counts.within, counts.statements],
										[within, statements],
										"no SQL"
									)
									yield* counted.page(q, params, plain(token))
									notes.note(tamper.kind)
									notes.note(`issued by ${c.query}`)
								})
						)
					}).pipe(
						Effect.scoped,
						(body) =>
							Effect.flatMap(Layer.build(opened.layer), (context) =>
								Effect.provideContext(body, context)
							),
						Effect.scoped
					)
				}).pipe(Effect.scoped)
			)
	)

	it.effect(
		"a delivered comparison tuple too long for a cursor fails the page with cursorTupleOversized",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const long = Str.repeat(cursorMaxBytes + 76)("x")
					const opened = yield* installed(
						Paging,
						{
							...facts,
							Task: [...facts.Task, { id: t(300), account: B, priority: 9, title: long }]
						},
						{ label: "real", extensions: [] }
					)
					return yield* Effect.gen(function* () {
						const db = yield* Db.open(opened.server.roles.app, {})
						const params = { account: B }
						const oversized = cursorFailure("cursorTupleOversized")
						/** Every page whose edges include the long title fails. */
						const failing = yield* exhaust(
							{
								suite: "pg/page/oversized tuple",
								generator: element<{ readonly first: number } | { readonly last: number }>([
									{ first: 5 },
									{ last: 5 },
									{ first: 2 },
									{ last: 3 }
								]),
								literal: Formatter.format,
								limit: 4,
								features: noFeatures,
								caseHang: Duration.minutes(2)
							},
							(request) =>
								Effect.gen(function* () {
									assert.deepEqual(
										yield* Effect.flip(db.page(titles, params, request)),
										oversized,
										Formatter.format(request)
									)
								})
						)
						/** A page whose edges exclude the long title pages normally, and the page after it fails. */
						const head = yield* db.page(titles, params, { first: 1 })
						const headTitles = Arr.map(head.edges, (e) => e.node.title)
						assert.deepEqual([headTitles, head.pageInfo.hasNextPage], [["𝔘nicode"], true])
						assert.deepEqual(
							yield* Effect.flip(
								db.page(titles, params, {
									first: 1,
									after: Option.getOrThrow(head.pageInfo.endCursor)
								})
							),
							oversized
						)
						const tail = yield* db.page(titles, params, { last: 2 })
						const tailTitles = Arr.map(tail.edges, (e) => e.node.title)
						assert.deepEqual([tailTitles, tail.pageInfo.hasPreviousPage], [["gamma", "beta"], true])
						/** Only the comparison tuple is encoded: ordered by (priority, id), the long title is delivered whole. */
						const ordered = yield* db.page(priorityDescendingTasks, params, { first: 5 })
						assert.equal(ordered.edges.length, 4)
						const top = defined(ordered.edges[0], "the first edge").node
						assert.equal(top.id, t(300))
						assert.equal(top.title, long)
						/** The same query over an account without the long title pages normally. */
						const compiled = pageTemplate(db, titles)
						const full = sortedResult(
							compiled,
							yield* (yield* db.execute(titles, { account: A })).collect
						)
						yield* checkTraversals(
							"titles of A",
							untyped(dbReader(db)),
							titles,
							{ account: A },
							full,
							3
						)
						return failing
					}).pipe(
						Effect.scoped,
						(body) =>
							Effect.flatMap(Layer.build(opened.layer), (context) =>
								Effect.provideContext(body, context)
							),
						Effect.scoped
					)
				}).pipe(Effect.scoped)
			)
	)
})
