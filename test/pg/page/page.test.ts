/**
 * The page runtime through the readers.
 *
 * The traversal property, that windows walked from the start and from the end at every size 1 through 7 concatenate to
 * the complete sorted distinct result D and that each window's attachments read exactly its rows' children, is
 * test/pg/page/generated.ts's, over generated ordered queries, minus the transaction and the handles. Here the Paging
 * fixture installs under a fresh schema and opens through Db.open and its login's served file as its full world, every
 * ordered query a paged member of its workload, exactly as an application reads windows, and its unpaged member beside
 * it, whose read is D:
 *
 * - every window answers exactly by the D of the moment and its anchor's values, through the query's paged member or
 *   its twin, another member paging the same query, whatever happened to D since the anchor's row was read: over drawn
 *   facts, a drawn query of the fixture and a walk of drawn windows, each anchored at the key of a row some earlier
 *   window delivered, through either member, with drawn changes to D between them (deleting an anchor's task, moving it,
 *   deleting the last window's tasks, inserting, flagging, emptying the account), each written as the facts' whole new
 *   state in one transaction that reads nothing (test/support/substrate/replace.ts), so no reset is an SSI pivot under
 *   load. A start window holds D's first k rows and an end window its last k; an after window the first k rows strictly
 *   after the anchor's values, a before window the last k strictly before them, whether or not a row of the anchor is
 *   still in D; every window in D's order. Each window is one flight carrying its one statement;
 * - a window input that is not exactly its params, no facts and a window of an anchor and a size, its size a safe integer
 *   of at least 1, its anchor of its kind and a key of one admitted value per comparator, is refused before any SQL: the
 *   call's error is the input refusal of its fault, and the Db's sessions send nothing; every other input reads its
 *   window in one flight;
 * - a window size has no upper bound: a walk's windows draw sizes up to the largest safe integer, which the statement
 *   binds as a bigint limit.
 *
 * test/pg/page/values.test.ts covers the boundary values, test/pg/page/plans.test.ts the plans, and
 * test/pg/page/generated.ts the generated ordered queries.
 *
 * Oracle: the specification of a window, D of the moment and the anchor's values, which the drawn facts and the walk's
 * own writes state, D read by the query's unpaged member; and the window rule restated, with no flight counted.
 *
 * Plants: window-after-seek-inclusive (the after template's seek admits the anchor's own row),
 * window-anchor-length-unchecked (a key of another length than the comparators reaches SQL).
 *
 * Features: each query through each member, each anchor kind, the anchors the walk names, and each input refusal.
 */
import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
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
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import {
	Array as Arr,
	Effect,
	Formatter,
	Option,
	pipe,
	Record as Rec,
	Result,
	String as Str
} from "effect"
import { onceCalls } from "#adapter/db/handles.ts"
import { ReadFailure } from "#adapter/errors/execution.ts"
import { CallInputRefused, type CallInputFault } from "#adapter/errors/failures.ts"
import { callErrorOf } from "#adapter/live/call-error.ts"
import { appendAll } from "#compiler/core/array.ts"
import { type Anchor, keyOf, type RowKey } from "#compiler/live/index.ts"
import type { Uuid } from "#compiler/public/fields.ts"
import { paged } from "#compiler/public/workload.ts"
import {
	canon,
	holdsKey,
	pageTemplate,
	rowOf,
	sortedResult,
	strictlyAfter,
	strictlyBefore,
	windowOf
} from "#test/pg/page/support.ts"
import { installed } from "#test/pg/reads/support.ts"
import { assert, defined } from "#test/support/assert.ts"
import { readOnce } from "#test/support/calls.ts"
import { replaceMigrated as replace } from "#test/support/install-migrate.ts"
import { caseHang } from "#test/support/limits.ts"
import { pickGen, pickIndex } from "#test/support/pick.ts"
import { recordingContext } from "#test/support/plans.ts"
import { member, withServedDb } from "#test/support/served-db.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import {
	ascendingTasks,
	descendingTasks,
	flagged,
	flaggedByTitle,
	priorityDescendingTasks,
	Paging,
	priorityCounts,
	tasksWithNotes,
	titles
} from "#test/unit/page/fixtures.ts"

const id = (n: number): Uuid =>
	`00000000-0000-4000-8000-${pipe(n.toString(16), Str.padStart(12, "0"))}`
const A = id(0xa)
const B = id(0xb)
const t = (n: number) => id(0x1000 + n)

/** The titles a task draws: repeating, a supplementary-plane one among them. */
const titleChoices = ["alpha", "beta", "gamma", "𝔘nicode", "beta"] as const
const titleOf = (n: number): string => defined(titleChoices[n % titleChoices.length])

/**
 * The input suite's facts: one task of the paged account A, noted (for notes) and flagged High (for flagged and flagged
 * by title), so every paged query's D holds a row whose key an input anchors at. A refusal reads no fact, so no other is
 * stated.
 */
const inputFacts = Object.freeze({
	Task: [{ id: t(0), account: A, priority: 0, title: titleOf(0) }],
	Note: [{ task: t(0), note: "note" }],
	Flag: [{ task: t(0), level: "High" }]
})

/**
 * The ordered queries of the fixture a walk or an input is drawn over: one native row comparison either way, mixed
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

/**
 * The member that pages a query, or its twin, another member paging the same query: a window is read through either.
 * Beside them, the query served unpaged, whose read is D.
 */
type Handle = "member" | "twin"

/** A paged query's member name, its twin's, or its unpaged member's: its position among the fixture's paged queries. */
const memberName = (q: PagedQuery, handle: Handle | "unpaged"): string =>
	`${handle}${Arr.findFirstIndex(pagedQueryNames, (n) => n === q).pipe(Option.getOrThrow)}`

/** Every paged query, served under its member's name and its twin's, and unpaged beside them. */
const pagedMembers: Readonly<Record<string, unknown>> = Rec.fromEntries(
	Arr.flatMap(pagedQueryNames, (q) => [
		...Arr.map(["member", "twin"] as const, (handle): readonly [string, unknown] => [
			memberName(q, handle),
			paged(pagedQueries[q])
		]),
		[memberName(q, "unpaged"), pagedQueries[q]]
	])
)

/** The paged account's parameters, which every window and D's read take. */
const params = Object.freeze({ account: A })

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
 * A direct write between two windows. A target pick resolves over the tasks of the anchor pool's rows (a delivered
 * row's task: its own, or the tasks a keyless row stands for) or, when the pool is empty, over every task.
 */
type Write =
	| { readonly kind: "delete a row's tasks"; readonly target: number }
	| {
			readonly kind: "move a row's tasks"
			readonly target: number
			readonly priority: number
			readonly title: number
	  }
	| { readonly kind: "delete the last window" }
	| { readonly kind: "insert"; readonly task: TaskSketch }
	| { readonly kind: "flag"; readonly target: number; readonly level: "High" | "Low" | "none" }
	| { readonly kind: "empty the account" }

const writeGen: Gen<Write> = weighted<Write>([
	[3, (source) => ({ kind: "delete a row's tasks", target: source.draw(pickGen) })],
	[
		3,
		(source) => ({
			kind: "move a row's tasks",
			target: source.draw(pickGen),
			priority: source.draw(element([-7, 0, 1, 2, 3, 4, 99])),
			title: source.draw(int(0, titleChoices.length - 1))
		})
	],
	[2, constant({ kind: "delete the last window" })],
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

/** Which row an anchored window takes: the last window's last or first row, or any row delivered so far. */
type AnchorPick =
	| { readonly kind: "end" }
	| { readonly kind: "start" }
	| { readonly kind: "any"; readonly pick: number }

/** An anchor's kind. */
type Kind = Anchor["kind"]

interface WindowSketch {
	readonly kind: Kind
	readonly size: number
	readonly anchor: AnchorPick
	readonly handle: Handle
}

/**
 * A window's size: mostly small, so the windows of the drawn facts cut through them, and now and then any safe integer,
 * a size past every 32-bit integer, or the largest safe integer: a window size has no upper bound, and the statement
 * binds it as a bigint.
 */
const windowSizeGen: Gen<number> = weighted([
	[8, int(1, 7)],
	[1, int(8, Number.MAX_SAFE_INTEGER)],
	[1, element([2 ** 31, Number.MAX_SAFE_INTEGER])]
])

const windowSketchGen: Gen<WindowSketch> = (source) => ({
	kind: source.draw(
		weighted<Kind>([
			[1, constant("start")],
			[1, constant("end")],
			[2, constant("after")],
			[2, constant("before")]
		])
	),
	size: source.draw(windowSizeGen),
	anchor: source.draw(
		oneOf<AnchorPick>([
			constant({ kind: "end" }),
			constant({ kind: "start" }),
			(inner) => ({ kind: "any", pick: inner.draw(pickGen) })
		])
	),
	handle: source.draw(element(["member", "twin"] as const))
})

interface StepSketch {
	readonly writes: ReadonlyArray<Write>
	readonly window: WindowSketch
}

interface WalkSketch {
	readonly query: PagedQuery
	readonly tasks: ReadonlyArray<TaskSketch>
	/** Notes and flags over the tasks, by pick. */
	readonly notes: ReadonlyArray<{ readonly task: number; readonly note: number }>
	readonly flags: ReadonlyArray<{ readonly task: number; readonly high: boolean }>
	readonly steps: ReadonlyArray<StepSketch>
}

const handleGen: Gen<Handle> = element(["member", "twin"] as const)

/**
 * A walk's steps: drawn, or planted a fifth of the time as a window from one end, its rows' tasks deleted, and the
 * window past it, so a window anchored at a row gone from D, with the rows past it still to answer, is reached on every
 * run.
 */
const stepsGen: Gen<ReadonlyArray<StepSketch>> = weighted<ReadonlyArray<StepSketch>>([
	[
		4,
		array(
			(source): StepSketch => ({
				writes: source.draw(
					oneOf<ReadonlyArray<Write>>([constant([]), array(writeGen, { min: 1, max: 3 })])
				),
				window: source.draw(windowSketchGen)
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
					window: {
						kind: forward ? "start" : "end",
						size: first,
						anchor: { kind: "end" },
						handle: handles[0]
					}
				},
				{
					writes: [{ kind: "delete the last window" }],
					window: {
						kind: forward ? "after" : "before",
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
	| `${Kind} through the ${Handle}`
	| "an anchor of the other member's row"
	| "an anchor gone from D"
	| "an anchor still in D"
	| "rows past a gone anchor"
	| "an empty anchored window"
	| "an emptied D"
	| "a write between windows"

/** A task of the walk's model: what the database holds, which writes and row lookups resolve against. */
interface ModelTask {
	readonly id: string
	readonly account: string
	readonly priority: number
	readonly title: string
	readonly flag: "High" | "Low" | "none"
}

/** A row some window delivered: its key, the row, the member that read it. */
interface Delivered {
	readonly key: RowKey
	readonly row: unknown
	readonly handle: Handle
}

/**
 * The ids of a model's tasks a row stands for: a keyed row's own task, or every task of the paged account a keyless row
 * collapses (a title's, a priority's count).
 */
const tasksOf = (
	q: PagedQuery,
	row: unknown,
	tasks: ReadonlyArray<ModelTask>
): ReadonlyArray<string> => {
	const fields = rowOf(row)
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
 * The row an anchored window takes, if it has one: the last window's last or first row, or any row delivered so far;
 * none before any row was delivered.
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

/** How a window input is drawn: a valid one's members, each kept, dropped, doubled or replaced (see expectedOf). */
interface InputSketch {
	readonly query: PagedQuery
	readonly envelope: "exact" | "no window" | "an extra member" | "no record"
	readonly facts: "none" | "a fact"
	readonly window: "exact" | "no size" | "no anchor" | "an extra member" | "no record"
	readonly size: unknown
	readonly anchor: "a record" | "no record"
	readonly kind: unknown
	/** Whether the anchor holds a key member, and a member besides its kind and key. */
	readonly keyMember: boolean
	readonly extra: boolean
	/** The key: the delivered row's, one value shorter or longer, or one value no codec admits at a pick. */
	readonly key:
		| { readonly kind: "the row's" }
		| { readonly kind: "one shorter" }
		| { readonly kind: "one longer" }
		| { readonly kind: "a refused value"; readonly at: number; readonly value: Refused }
		| { readonly kind: "no list" }
}

/** Values no codec admits: no key holds null or undefined, and no carrier's host value is a symbol. */
type Refused = "null" | "undefined" | "a symbol"

const refusedValue = (value: Refused): unknown => {
	switch (value) {
		case "null":
			return null
		case "undefined":
			return undefined
		case "a symbol":
			return Symbol("key")
	}
}

const inputSketchGen: Gen<InputSketch> = (source) => ({
	query: source.draw(element(pagedQueryNames)),
	envelope: source.draw(
		weighted<InputSketch["envelope"]>([
			[8, constant("exact")],
			[1, constant("no window")],
			[1, constant("an extra member")],
			[1, constant("no record")]
		])
	),
	facts: source.draw(
		weighted<InputSketch["facts"]>([
			[8, constant("none")],
			[1, constant("a fact")]
		])
	),
	window: source.draw(
		weighted<InputSketch["window"]>([
			[8, constant("exact")],
			[1, constant("no size")],
			[1, constant("no anchor")],
			[1, constant("an extra member")],
			[1, constant("no record")]
		])
	),
	size: source.draw(
		weighted<unknown>([
			[6, int(1, 7)],
			[1, element([Number.MAX_SAFE_INTEGER])],
			[
				2,
				element<unknown>([
					0,
					-0,
					-1,
					1.5,
					Number.NaN,
					Number.POSITIVE_INFINITY,
					Number.MAX_SAFE_INTEGER + 1,
					2n,
					"2",
					null
				])
			]
		])
	),
	anchor: source.draw(
		weighted<InputSketch["anchor"]>([
			[8, constant("a record")],
			[1, constant("no record")]
		])
	),
	kind: source.draw(
		weighted<unknown>([
			[8, element<unknown>(["start", "after", "end", "before"])],
			[1, element<unknown>(["first", "last", 0, null])]
		])
	),
	keyMember: source.draw(
		weighted<boolean>([
			[1, constant(false)],
			[1, constant(true)]
		])
	),
	extra: source.draw(
		weighted<boolean>([
			[8, constant(false)],
			[1, constant(true)]
		])
	),
	key: source.draw(
		weighted<InputSketch["key"]>([
			[6, constant({ kind: "the row's" })],
			[1, constant({ kind: "one shorter" })],
			[1, constant({ kind: "one longer" })],
			[
				2,
				(inner) => ({
					kind: "a refused value",
					at: inner.draw(pickGen),
					value: inner.draw(element<Refused>(["null", "undefined", "a symbol"]))
				})
			],
			[1, constant({ kind: "no list" })]
		])
	)
})

/** The key an input's anchor carries, from `row`, the delivered row's key. */
const keyInput = (sketch: InputSketch["key"], row: RowKey): unknown => {
	switch (sketch.kind) {
		case "the row's":
			return row
		case "one shorter":
			return row.slice(0, -1)
		case "one longer":
			return [...row, row[0]]
		case "a refused value": {
			const key = [...row]
			key[pickIndex(sketch.at, row.length)] = refusedValue(sketch.value)
			return key
		}
		case "no list":
			return "key"
	}
}

/** The input a sketch builds over `row`, the delivered row's key. */
const inputOf = (c: InputSketch, row: RowKey): unknown => {
	const anchor =
		c.anchor === "no record"
			? c.kind
			: {
					kind: c.kind,
					...(c.keyMember ? { key: keyInput(c.key, row) } : {}),
					...(c.extra ? { size: 1 } : {})
				}
	const members = { anchor, size: c.size }
	const windowed =
		c.window === "no record"
			? [anchor, c.size]
			: c.window === "no size"
				? { anchor }
				: c.window === "no anchor"
					? { size: c.size }
					: c.window === "an extra member"
						? { ...members, after: anchor }
						: members
	const facts = c.facts === "none" ? {} : { Task: [] }
	switch (c.envelope) {
		case "exact":
			return { params, facts, window: windowed }
		case "no window":
			return { params, facts }
		case "an extra member":
			return { params, facts, window: windowed, extra: true }
		case "no record":
			return [params, facts, windowed]
	}
}

type InputFeature =
	| `query ${PagedQuery}`
	| CallInputFault
	| "admitted"
	| "a key of another length"
	| "a key value no codec admits"

/**
 * The rule, restated (live/program.ts WindowInput, adapter/page/window.ts): the input's members exactly params, facts
 * and window, then no facts, then the window's members exactly an anchor and a size, then its size a safe integer of at
 * least 1, then its anchor a record of a kind and, exactly for an after and a before, a key of one value per
 * comparator, each admitted; with what the case reached on the way.
 */
const expectedOf = (
	c: InputSketch
): {
	readonly verdict: CallInputFault | "admitted"
	readonly reached: ReadonlyArray<InputFeature>
} => {
	const refused = (fault: CallInputFault, ...reached: ReadonlyArray<InputFeature>) => ({
		verdict: fault,
		reached: [fault, ...reached]
	})
	if (c.envelope !== "exact") {
		return refused("envelope")
	}
	if (c.facts !== "none") {
		return refused("facts")
	}
	if (c.window !== "exact") {
		return refused("window")
	}
	const size = c.size
	if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 1) {
		return refused("size")
	}
	const kind = c.kind
	if (
		c.anchor === "no record" ||
		c.extra ||
		!(kind === "start" || kind === "end" || kind === "after" || kind === "before")
	) {
		return refused("anchor")
	}
	const keyed = kind === "after" || kind === "before"
	if (c.keyMember !== keyed) {
		return refused("anchor")
	}
	if (!keyed) {
		return { verdict: "admitted", reached: ["admitted"] }
	}
	switch (c.key.kind) {
		case "the row's":
			return { verdict: "admitted", reached: ["admitted"] }
		case "one shorter":
		case "one longer":
			return refused("anchor", "a key of another length")
		case "a refused value":
			return refused("anchor", "a key value no codec admits")
		case "no list":
			return refused("anchor")
	}
}

layer(Substrate.layer)("the page runtime through the readers", (it) => {
	it.effect(
		"answers every window by the D of the moment and its anchor's values, through either member, whatever changed since its anchor's row was read, each window one flight",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const opened = yield* installed(Paging, {}, { label: "real", programs: {} })
					return yield* withServedDb(
						opened.installed,
						opened.server.roles.app,
						{},
						({ ctx: dbCtx, load }) =>
							Effect.gen(function* () {
								const loaded = yield* load(pagedMembers)
								const recording = recordingContext(dbCtx)
								return yield* explore(
									{
										oracle: {
											kind: "specification",
											name: "D of the moment and the anchor's values, as the walk's own writes state them"
										},
										suite: "pg/page/walks",
										draw: drawn(walkSketchGen),
										literal: Formatter.format,
										kept: [],
										runs: 100,
										shrink: completeShrink,
										concurrency: 1,
										steerEvery: 16,
										caseHang,
										coverage: required<WalkFeature>(
											[
												...Arr.map(pagedQueryNames, (q): WalkFeature => `query ${q}`),
												...Arr.flatMap(["start", "end", "after", "before"] as const, (kind) =>
													Arr.map(
														["member", "twin"] as const,
														(handle): WalkFeature => `${kind} through the ${handle}`
													)
												),
												"an anchor of the other member's row",
												"an anchor gone from D",
												"an anchor still in D",
												"rows past a gone anchor",
												"an empty anchored window",
												"an emptied D",
												"a write between windows"
											],
											{ cases: 100, sense: notesOnly }
										)
									},
									(walk, c) =>
										Effect.gen(function* () {
											/** A paged member's calls, their flights counted. */
											const pagedCalls = (handle: Handle) =>
												onceCalls(recording.ctx, member(loaded, memberName(walk.query, handle)))
											const unpaged = onceCalls(
												dbCtx,
												member(loaded, memberName(walk.query, "unpaged"))
											)
											const compiled = pageTemplate(
												member(loaded, memberName(walk.query, "member")),
												opened.installed.names.codes
											)
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
											const notes = new Map<
												string,
												{ readonly task: string; readonly note: string }
											>()
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
														...new Set(Arr.flatMap(pool, (d) => tasksOf(walk.query, d.row, model)))
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
															tasksOf(walk.query, d.row, model).includes(chosen)
														),
														{
															onNone: () => [chosen],
															onSome: (row) => tasksOf(walk.query, row.row, model)
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
														const at = Option.getOrThrow(
															Arr.findFirstIndex(model, (x) => x.id === i)
														)
														model[at] = change(defined(model[at]))
													}
												}
												for (const write of step.writes) {
													switch (write.kind) {
														case "delete a row's tasks":
															remove(targets(write.target))
															break
														case "delete the last window":
															remove([
																...new Set(
																	Arr.flatMap(last, (d) => tasksOf(walk.query, d.row, model))
																)
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
														case "move a row's tasks":
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
													c.note("a write between windows")
												}
												/** The window, anchored at a delivered row's key when it names one and one exists. */
												const w = step.window
												const anchorRow =
													w.kind === "after" || w.kind === "before"
														? anchorOf(w.anchor, last, pool)
														: Option.none<Delivered>()
												const anchor: Anchor = Option.match(anchorRow, {
													onNone: () =>
														w.kind === "start" || w.kind === "after"
															? { kind: "start" }
															: { kind: "end" },
													onSome: (row) =>
														w.kind === "after"
															? { kind: "after", key: row.key }
															: { kind: "before", key: row.key }
												})
												const flights = recording.counts.flights
												const statements = recording.counts.statements
												const answered = yield* windowOf(
													pagedCalls(w.handle),
													params,
													anchor,
													w.size
												)
												assert.deepEqual(
													[
														recording.counts.flights - flights,
														recording.counts.statements - statements
													],
													[1, 1],
													`a ${anchor.kind} window is one flight of one statement`
												)
												/** The oracle: D now, and the anchor's values. */
												const rows = yield* readOnce(unpaged)({ params, facts: {} })
												const full = sortedResult(compiled, rows)
												const k = w.size
												const expected = ((): ReadonlyArray<unknown> => {
													switch (anchor.kind) {
														case "start":
															return full.slice(0, k)
														case "end":
															return full.slice(Math.max(0, full.length - k))
														case "after":
															return strictlyAfter(compiled, rows, anchor.key).slice(0, k)
														case "before": {
															const before = strictlyBefore(compiled, rows, anchor.key)
															return before.slice(Math.max(0, before.length - k))
														}
													}
												})()
												const presented: ReadonlyArray<unknown> = Arr.map(answered, canon)
												assert.deepEqual(
													presented,
													expected,
													`${anchor.kind} ${k} through the ${w.handle}`
												)
												c.note(`query ${walk.query}`)
												c.note(`${anchor.kind} through the ${w.handle}`)
												if (Option.isSome(anchorRow)) {
													const gone = !holdsKey(compiled, rows, anchorRow.value.key)
													c.note(gone ? "an anchor gone from D" : "an anchor still in D")
													if (gone && expected.length > 0) {
														c.note("rows past a gone anchor")
													}
													if (expected.length === 0) {
														c.note("an empty anchored window")
													}
													if (full.length === 0) {
														c.note("an emptied D")
													}
													if (anchorRow.value.handle !== w.handle) {
														c.note("an anchor of the other member's row")
													}
												}
												last = Arr.map(answered, (row) => ({
													key: keyOf(compiled.fields, row),
													row,
													handle: w.handle
												}))
												appendAll(pool, last)
											}
										}).pipe(Effect.scoped)
								)
							})
					)
				}).pipe(Effect.scoped)
			)
	)

	it.effect(
		"refuses every window input but exactly its params, no facts and a window of an anchor and a size before any SQL, and reads every other in one flight",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const opened = yield* installed(Paging, inputFacts, {
						label: "real",
						programs: {}
					})
					return yield* withServedDb(
						opened.installed,
						opened.server.roles.app,
						{},
						({ ctx: dbCtx, load }) =>
							Effect.gen(function* () {
								const loaded = yield* load(pagedMembers)
								const recording = recordingContext(dbCtx)
								return yield* explore(
									{
										oracle: {
											kind: "specification",
											name: "the window rule restated, a refusal sending no flight and every other input one"
										},
										suite: "pg/page/inputs",
										draw: drawn(inputSketchGen),
										literal: Formatter.format,
										kept: [],
										runs: 200,
										shrink: completeShrink,
										concurrency: 1,
										steerEvery: 16,
										caseHang,
										coverage: required<InputFeature>(
											[
												...Arr.map(pagedQueryNames, (q): InputFeature => `query ${q}`),
												"envelope",
												"facts",
												"window",
												"size",
												"anchor",
												"admitted",
												"a key of another length",
												"a key value no codec admits"
											],
											{ cases: 200, sense: notesOnly }
										)
									},
									(c, notes) =>
										Effect.gen(function* () {
											const paging = member(loaded, memberName(c.query, "member"))
											const calls = onceCalls(recording.ctx, paging)
											const compiled = pageTemplate(paging, opened.installed.names.codes)
											const [first] = yield* windowOf(calls, params, { kind: "start" }, 1)
											const row = keyOf(compiled.fields, defined(first, "a row of D"))
											const expected = expectedOf(c)
											const flights = recording.counts.flights
											const statements = recording.counts.statements
											const answer = yield* Effect.result(readOnce(calls)(inputOf(c, row)))
											const sent = [
												recording.counts.flights - flights,
												recording.counts.statements - statements
											]
											if (expected.verdict === "admitted") {
												assert.ok(Result.isSuccess(answer), Formatter.format(answer))
												assert.deepEqual(sent, [1, 1], "one flight of one statement")
											} else {
												assert.deepEqual(
													answer,
													Result.fail(
														callErrorOf(
															new ReadFailure({
																reason: new CallInputRefused({ fault: expected.verdict })
															})
														)
													),
													expected.verdict
												)
												assert.deepEqual(sent, [0, 0], "no SQL")
											}
											notes.noteAll(expected.reached)
											notes.note(`query ${c.query}`)
										})
								)
							})
					)
				}).pipe(Effect.scoped)
			)
	)
})
