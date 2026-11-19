/** What the properties of page.test.ts read: its spaces, models and helpers. */

import {
	array,
	boolean,
	constant,
	element,
	type Gen,
	int,
	oneOf,
	weighted
} from "@bjornpagen/testing/gen"
import { Array as Arr, Option, pipe, Record as Rec, String as Str } from "effect"
import type { CallInputFault } from "#adapter/errors/failures.ts"
import type { Anchor, RowKey } from "#compiler/live/index.ts"
import type { Uuid } from "#compiler/public/fields.ts"
import { paged } from "#compiler/public/workload.ts"
import { rowOf } from "#test/pg/page/support.ts"
import { fixtureTemplate } from "#test/pg/reads/support.ts"
import { defined } from "#test/support/assert.ts"
import { pickGen, pickIndex } from "#test/support/pick.ts"
import {
	ascendingTasks,
	descendingTasks,
	flagged,
	flaggedByTitle,
	priorityCounts,
	priorityDescendingTasks,
	tasksWithNotes,
	titles
} from "#test/unit/page/fixtures.ts"
import { Paging } from "#test/unit/page/fixtures.ts"

const id = (n: number): Uuid =>
	`00000000-0000-4000-8000-${pipe(n.toString(16), Str.padStart(12, "0"))}`

export const A = id(0xa)

export const B = id(0xb)

export const t = (n: number) => id(0x1000 + n)

/** The titles a task draws: repeating, a supplementary-plane one among them. */
const titleChoices = ["alpha", "beta", "gamma", "𝔘nicode", "beta"] as const

export const titleOf = (n: number): string => defined(titleChoices[n % titleChoices.length])

/**
 * The input suite's facts: one task of the paged account A, noted (for notes) and flagged High (for flagged and flagged
 * by title), so every paged query's D holds a row whose key an input anchors at. A refusal reads no fact, so no other is
 * stated.
 */
export const inputFacts = Object.freeze({
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

export const pagedQueryNames: Arr.NonEmptyReadonlyArray<PagedQuery> = [
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
export type Handle = "member" | "twin"

/** A paged query's member name, its twin's, or its unpaged member's: its position among the fixture's paged queries. */
export const memberName = (q: PagedQuery, handle: Handle | "unpaged"): string =>
	`${handle}${Arr.findFirstIndex(pagedQueryNames, (n) => n === q).pipe(Option.getOrThrow)}`

/** Every paged query, served under its member's name and its twin's, and unpaged beside them. */
export const pagedMembers: Readonly<Record<string, unknown>> = Rec.fromEntries(
	Arr.flatMap(pagedQueryNames, (q) => [
		...Arr.map(["member", "twin"] as const, (handle): readonly [string, unknown] => [
			memberName(q, handle),
			paged(pagedQueries[q])
		]),
		[memberName(q, "unpaged"), pagedQueries[q]]
	])
)

/** The paged account's parameters, which every window and D's read take. */
export const params = Object.freeze({ account: A })

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

export const walkSketchGen: Gen<WalkSketch> = (source) => ({
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

export type WalkFeature =
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
export interface ModelTask {
	readonly id: string
	readonly account: string
	readonly priority: number
	readonly title: string
	readonly flag: "High" | "Low" | "none"
}

/** A row some window delivered: its key, the row, the member that read it. */
export interface Delivered {
	readonly key: RowKey
	readonly row: unknown
	readonly handle: Handle
}

/**
 * The ids of a model's tasks a row stands for: a keyed row's own task, or every task of the paged account a keyless row
 * collapses (a title's, a priority's count).
 */
export const tasksOf = (
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
export const anchorOf = (
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

/** A key one value shorter or longer than the delivered row's. */
const otherLengthGen: Gen<InputSketch["key"]> = element<InputSketch["key"]>([
	{ kind: "one shorter" },
	{ kind: "one longer" }
])

/** A key with one value no codec admits, at a drawn pick. */
const refusedKeyGen: Gen<InputSketch["key"]> = (inner) => ({
	kind: "a refused value",
	at: inner.draw(pickGen),
	value: inner.draw(element<Refused>(["null", "undefined", "a symbol"]))
})

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

export const inputSketchGen: Gen<InputSketch> = (source) => ({
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
			[2, otherLengthGen],
			[2, refusedKeyGen],
			[1, constant({ kind: "no list" })]
		])
	)
})

/** An input every check admits, its query and size drawn: an after or a before anchored at the delivered row's key. */
const admittedGen: Gen<InputSketch> = (source) => ({
	query: source.draw(element(pagedQueryNames)),
	envelope: "exact",
	facts: "none",
	window: "exact",
	size: source.draw(int(1, 7)),
	anchor: "a record",
	kind: source.draw(element(["after", "before"] as const)),
	keyMember: true,
	extra: false,
	key: { kind: "the row's" }
})

/** An input every check before its key admits (admittedGen), carrying a key `key` draws. */
const admittedWith =
	(key: Gen<InputSketch["key"]>): Gen<InputSketch> =>
	(source) => ({ ...source.draw(admittedGen), key: source.draw(key) })

/**
 * Each refusal of an input's key, with the input a case whose turn aims at it draws (aimed): one every check before
 * its key admits, carrying that refusal's key (see the header). The features noted are still the rule's (expectedOf),
 * so a note never claims what the input does not hold.
 */
export const keyAims: ReadonlyArray<readonly [InputFeature, Gen<InputSketch>]> = [
	["a key of another length", admittedWith(otherLengthGen)],
	["a key value no codec admits", admittedWith(refusedKeyGen)]
]

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
export const inputOf = (c: InputSketch, row: RowKey): unknown => {
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

export type InputFeature =
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
export const expectedOf = (
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

/** What every case installs: Paging, its full world's workload holding no member of its own. */
export const pagingInstall = { label: "real", programs: {} } as const

/** Paging installed once per member (reads/support.ts fixtureTemplate), which each case's seat holds. */
export const pagingTemplate = fixtureTemplate(import.meta, Paging, pagingInstall)
