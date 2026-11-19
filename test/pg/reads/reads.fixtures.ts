/** What the properties of reads.test.ts read: its spaces, models and helpers. */

import type { Steered } from "@bjornpagen/testing/explore"
import type { Pending } from "@bjornpagen/testing/features"
import {
	array,
	boolean,
	constant,
	element,
	type Gen,
	int,
	map,
	oneOf,
	weighted
} from "@bjornpagen/testing/gen"
import { Array as Arr, Option, Order, pipe, Record as Rec, String as Str } from "effect"
import { indices } from "#compiler/core/array.ts"
import { isRecord } from "#compiler/core/record.ts"
import type { Uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { assert, defined } from "#test/support/assert.ts"
import * as W from "#test/support/fixtures/api/work.ts"
import { workFacts } from "#test/support/fixtures/golden/work.ts"
import { isList } from "#test/support/list.ts"
import { pickGen, pickIndex } from "#test/support/pick.ts"

/** A delivered value with its carriers kept and Options spelled out, comparable by deepStrictEqual. */
export const plain = (value: unknown): unknown => {
	if (Option.isOption(value)) {
		return Option.isSome(value) ? { some: plain(value.value) } : "none"
	}
	if (isList(value)) {
		return Arr.map(value, plain)
	}
	if (typeof value === "object" && value !== null && !(Symbol.iterator in value)) {
		const out: Record<string, unknown> = {}
		for (const [k, v2] of Rec.toEntries(value)) {
			out[k] = plain(v2)
		}
		return out
	}
	return value
}

export const uuidAt = (group: number, n: number): Uuid =>
	`00000000-0000-4000-${(0x9000 + group).toString(16)}-${pipe(n.toString(16), Str.padStart(12, "0"))}`

/** The id of a delivered row, every row here being a record with one. */
const idOf = (row: unknown): string => {
	if (!isRecord(row) || typeof row["id"] !== "string") {
		return assert.fail("a row with an id")
	}
	return row["id"]
}

/** The Work tables in delete order: what hangs on a task first, accounts last. */
export const workTables = [W.TaskNote, W.AutomaticTask, W.ManualTask, W.Task, W.Account] as const

/**
 * Facts of Work a case draws: up to four accounts, tasks over them, each automatic with a budget or manual with an
 * operator, some with a note.
 */
interface TaskSketch {
	readonly account: number
	readonly automatic: boolean
	readonly budget: number
	readonly operator: number
	readonly note: boolean
}

const taskSketchGen: Gen<TaskSketch> = (source) => ({
	account: source.draw(pickGen),
	automatic: source.draw(boolean),
	budget: source.draw(int(0, 3)),
	operator: source.draw(int(0, 2)),
	note: source.draw(boolean)
})

const operators = ["Ruth", "Sam", "Uma"] as const

type WorkFacts = {
	readonly Account: ReadonlyArray<{ readonly id: string; readonly name: string }>
	readonly Task: ReadonlyArray<{
		readonly id: string
		readonly account: string
		readonly kind: "Automatic" | "Manual"
	}>
	readonly AutomaticTask: ReadonlyArray<{ readonly task: string; readonly budget: bigint }>
	readonly ManualTask: ReadonlyArray<{ readonly task: string; readonly operator: string }>
	readonly TaskNote: ReadonlyArray<{ readonly task: string; readonly note: string }>
}

/** The facts of `accounts` accounts and the sketched tasks, their ids under `group` so two cases never share one. */
export const workFactsOf = (
	group: number,
	accounts: number,
	tasks: ReadonlyArray<TaskSketch>
): WorkFacts => {
	const accountIds = Arr.map(indices(accounts), (n) => uuidAt(group, n))
	const placed = Arr.map(tasks, (x, n) => ({
		...x,
		id: uuidAt(group, 0x100 + n),
		account: defined(accountIds[pickIndex(x.account, accountIds.length)])
	}))
	return {
		Account: Arr.map(accountIds, (id, n) => ({ id, name: `account ${n}` })),
		Task: Arr.map(placed, (x) => ({
			id: x.id,
			account: x.account,
			kind: x.automatic ? "Automatic" : "Manual"
		})),
		AutomaticTask: Arr.flatMap(placed, (x) =>
			x.automatic ? [{ task: x.id, budget: BigInt(500 * x.budget) }] : []
		),
		ManualTask: Arr.flatMap(placed, (x) =>
			x.automatic ? [] : [{ task: x.id, operator: defined(operators[x.operator]) }]
		),
		TaskNote: Arr.flatMap(placed, (x) =>
			x.note ? [{ task: x.id, note: `note of ${Str.slice(-4)(x.id)}` }] : []
		)
	}
}

/** The union's rows over facts, as the host reads its definition: each task with its account, kind and payload. */
export const payloadRows = (f: WorkFacts): ReadonlyArray<Readonly<Record<string, unknown>>> =>
	Arr.flatMap(f.Task, (x): ReadonlyArray<Readonly<Record<string, unknown>>> => {
		if (x.kind === "Automatic") {
			return Option.toArray(
				Option.map(
					Arr.findFirst(f.AutomaticTask, (p) => p.task === x.id),
					(a) => ({
						id: x.id,
						account: x.account,
						kind: x.kind,
						budget: a.budget
					})
				)
			)
		}
		return Option.toArray(
			Option.map(
				Arr.findFirst(f.ManualTask, (p) => p.task === x.id),
				(m) => ({
					id: x.id,
					account: x.account,
					kind: x.kind,
					operator: m.operator
				})
			)
		)
	})

/**
 * Each account with its tasks attached in id order, and each task with its note attached: an attachment with an
 * attachment of its own stays pipelined, so the tasks statement reads the delivered account keys and the notes are
 * stitched onto the tasks.
 */
export const accountTaskNotes = query(W.Work)
	.rule((r) => {
		const { id, name } = v(W.Account, "account")
		return r.match(W.Account, { id, name }).find({ id, name })
	})
	.attach(
		"tasks",
		(a) =>
			query(W.Work)
				.rule((r) => {
					const { id, kind } = v(W.Task, "task")
					return r.match(W.Task, { id, account: a.id, kind }).find({ id, kind })
				})
				.attach(
					"note",
					(t) =>
						query(W.Work).rule((r) => {
							const { note } = v(W.TaskNote, "taskNote")
							return r.match(W.TaskNote, { task: t.id, note }).find({ note })
						}),
					"option"
				)
				.orderBy(["id", "asc"]),
		"array"
	)

export type RelationFeature =
	| "an array"
	| "a Stream"
	| "a repeated fact"
	| "an absent key"
	| "no fact"
	| "a large input"

/** A large input's distinct facts: past the 100,000 rows a relation input once was bounded by. */
export const largeInput = 250_000

interface RelationCase {
	/** The distinct facts: a large input's, or a small number. */
	readonly size: { readonly kind: "large" } | { readonly kind: "small"; readonly n: number }
	/** How many of the distinct facts are stored tasks' keys, by pick, and the repeats added. */
	readonly present: number
	readonly repeats: number
	readonly stream: boolean
}

/** A large input is a read of largeInput facts, so it is drawn one case in six. */
export const relationCaseGen: Gen<RelationCase> = (source) => ({
	size: source.draw(
		weighted<RelationCase["size"]>([
			[1, constant({ kind: "large" })],
			[5, map(int(0, 6), (n) => ({ kind: "small", n }))]
		])
	),
	present: source.draw(pickGen),
	repeats: source.draw(int(0, 3)),
	stream: source.draw(boolean)
})

export type UnionFeature =
	| "ascending"
	| "descending"
	| "a take"
	| "no take"
	| "an empty group"
	| "a take past the union"

type SnapshotRead = "union" | "attachment"

export type SnapshotFeature =
	| `${SnapshotRead} waiting on ${string}`
	| "read the state before the commit"
	| "read the state after the commit"

/** The tables a read's statements read, each of which a holder may lock. */
const lockable = {
	union: [W.Task, W.AutomaticTask, W.ManualTask],
	attachment: [W.Account, W.Task, W.TaskNote]
} as const

/** A read waiting on a holder's lock of one of the tables its statements read. */
interface Wait {
	readonly read: SnapshotRead
	readonly table: (typeof lockable)[SnapshotRead][number]
}

/** Every read waiting on every table it reads. */
export const waits: Arr.NonEmptyReadonlyArray<Wait> = Arr.flatMap(
	["union", "attachment"] as const,
	(read) => Arr.map(lockable[read], (table): Wait => ({ read, table }))
)

/** What a wait reaches. */
export const waitingOn = (wait: Wait): SnapshotFeature =>
	`${wait.read} waiting on ${wait.table.name}`

/** Every wait's place in `waits`. */
const waitPlaces: Arr.NonEmptyReadonlyArray<number> = Arr.map(waits, (_, at) => at)

/**
 * The waits a case draws from, as their places in `waits`: where the case steers, those whose feature the run had not
 * reached when the case's window began, so the floor stream draws each wait while it is pending rather than leaving it
 * to its share of chance; every wait once none is pending, and where the case may not steer, so the rotating stream's
 * waits are plain draws.
 */
const waitsFor = (
	steering: Option.Option<Pending<SnapshotFeature>>
): Arr.NonEmptyReadonlyArray<number> =>
	Option.match(steering, {
		onNone: () => waitPlaces,
		onSome: (pending) =>
			Arr.match(
				Arr.filter(waitPlaces, (at) => pending.has(waitingOn(Arr.getUnsafe(waits, at)))),
				{ onEmpty: () => waitPlaces, onNonEmpty: (open) => open }
			)
	})

/** A snapshot case as drawn: its wait's place in `waits`, and whether the commit deletes. */
interface SnapshotSketch {
	readonly wait: number
	readonly deletes: boolean
}

/** A snapshot case: the wait its read makes, and whether the commit deletes. */
interface SnapshotCase {
	readonly wait: Wait
	readonly deletes: boolean
}

/**
 * The commit: a new account with an automatic and a manual task, one noted, and a stored task of each kind deleted,
 * so each statement's answer changes; and the wait, drawn among those the case's steering leaves (waitsFor).
 */
export const snapshotSketches: Steered<SnapshotSketch, SnapshotFeature> =
	(steering) => (source) => ({
		deletes: source.draw(boolean),
		wait: steering.pipe(waitsFor, element, source.draw)
	})

/** The snapshot case a sketch states: the wait at its place in `waits`. */
export const snapshotCaseOf = (sketch: SnapshotSketch): SnapshotCase => ({
	wait: Arr.getUnsafe(waits, sketch.wait),
	deletes: sketch.deletes
})

/** A union's case: its facts, its order and its take. */
interface UnionCase {
	readonly accounts: number
	readonly tasks: ReadonlyArray<TaskSketch>
	readonly descending: boolean
	readonly take: { readonly kind: "none" } | { readonly kind: "take"; readonly k: number }
}

/** The largest take a union case draws. */
const takeMax = 14

/** The member a union case reads: the union ordered by id in its direction, with its take or none. */
export const unionMember = (c: Pick<UnionCase, "descending" | "take">): string =>
	`${c.descending ? "desc" : "asc"}${c.take.kind === "none" ? "" : String(c.take.k)}`

/**
 * Every member a union case reads, served at once: the union ordered by id ascending and descending, each with no take
 * and with every take a case draws.
 */
export const unionMembers: Readonly<Record<string, unknown>> = Rec.fromEntries(
	Arr.flatMap([false, true], (descending) => {
		const ordered = W.taskPayloads.orderBy(["id", descending ? "desc" : "asc"])
		return [
			[unionMember({ descending, take: { kind: "none" } }), ordered] as const,
			...Arr.map(
				indices(takeMax),
				(n) =>
					[
						unionMember({ descending, take: { kind: "take", k: n + 1 } }),
						ordered.take(n + 1)
					] as const
			)
		]
	})
)

export const unionCaseGen: Gen<UnionCase> = (source) => ({
	accounts: source.draw(int(1, 4)),
	tasks: source.draw(array(taskSketchGen, { min: 0, max: 12 })),
	descending: source.draw(boolean),
	take: source.draw(
		oneOf<UnionCase["take"]>([
			constant({ kind: "none" }),
			map(int(1, takeMax), (k) => ({ kind: "take", k }))
		])
	)
})

/** Payload rows by their id's text. */
export const byIdText: Order.Order<Readonly<Record<string, unknown>>> = Order.mapInput(
	Order.String,
	(r: Readonly<Record<string, unknown>>) => String(r["id"])
)

/** Rows by their id. */
const byId: Order.Order<unknown> = Order.mapInput(Order.String, idOf)

export const stored = workFacts.Task

/** A read's answer, its rows in id order where the query leaves the order open. */
export const answer = (rows: ReadonlyArray<unknown>): ReadonlyArray<unknown> =>
	Arr.map(Arr.sort(rows, byId), plain)
