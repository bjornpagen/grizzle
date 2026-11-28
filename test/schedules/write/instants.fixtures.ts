/** What the properties of instants.test.ts read: its spaces, models and helpers. */

import { deepEquals } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { constant, element, type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Formatter, Option, Order, Result } from "effect"
import type { CallError, WriteOutcome } from "#compiler/live/index.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { instant, int4 } from "#compiler/public/fields.ts"
import { login, relation, role, schema } from "#compiler/public/schema.ts"
import { workload } from "#compiler/public/workload.ts"
import type { WriteAnswer } from "#test/support/calls.ts"
import { rigTemplate } from "#test/support/schedules/rig.ts"

export const Log = relation("Log", { child: int4, at: instant, note: int4 }, [
	"child",
	"at",
	"note"
])

/** The relation a held call inserts last, which the owner's SHARE lock holds it at. */
export const Gate = relation("Gate", { n: int4 }, ["n"])

/** The schema, the role `writer`, which inserts Log and Gate and nothing else, and its two logins. */
export const clocks = (name: string) => {
	const base = schema(name, [Log, Gate], [])
	const writer = role(base, "writer", { Log, Gate }, { insert: ["Log", "Gate"] })
	const direct = role(base, "direct", { Log, Gate })
	return {
		schema: base,
		writer,
		direct,
		server: login(base, "server", [writer], {
			workload: [
				workload(writer, {
					stamp: ChangeSet.empty(base).insert(Log, []),
					held: ChangeSet.sequence(
						ChangeSet.empty(base).insert(Log, []),
						ChangeSet.empty(base).insert(Gate, [])
					)
				})
			]
		}),
		psql: login(base, "psql", [direct])
	}
}

/** A microsecond in 2100, above every reading of the clock a run takes: a stored head a stepped-back clock is below. */
const future = 4_102_444_800_000_000n

/** The head a child holds before the calls: none, one at instant 1, or one at `future`, each of note 9. */
type Head = "none" | "past" | "future"

export const headAt = (head: Exclude<Head, "none">): bigint => (head === "past" ? 1n : future)

/** One row a call states: its child and its note, its instant left out to be stamped. */
export interface Row {
	readonly child: 1 | 2
	readonly note: 0 | 1
}

type Mode = "concurrent" | "sequential"

interface Stamping {
	readonly mode: Mode
	readonly heads: { readonly 1: Head; readonly 2: Head }
	readonly a: ReadonlyArray<Row>
	readonly b: ReadonlyArray<Row>
}

export type StampFeature =
	| "a child over no head"
	| "a child over a past head"
	| "a child over a future head: the clock stepped back"
	| "a child both calls stamp, concurrently"
	| "a child both calls stamp, in turn"
	| "B waited for A at a child"
	| "two rows of one child in one call"
	| "two children in one call"

const sameRow = (x: Row, y: Row): boolean => x.child === y.child && x.note === y.note

/** One to three distinct rows. */
const rowsGen: Gen<ReadonlyArray<Row>> = (source) => {
	const count = source.draw(int(1, 3))
	const rows: Array<Row> = []
	for (let i = 0; i < count; i++) {
		const row: Row = {
			child: source.draw(element([1, 2] as const)),
			note: source.draw(element([0, 1] as const))
		}
		if (!Arr.some(rows, (r) => sameRow(r, row))) {
			rows.push(row)
		}
	}
	return rows
}

export const stampingGen: Gen<Stamping> = (source) => ({
	mode: source.draw(element(["concurrent", "sequential"] as const)),
	heads: {
		1: source.draw(element(["none", "past", "future"] as const)),
		2: source.draw(element(["none", "past", "future"] as const))
	},
	a: source.draw(rowsGen),
	b: source.draw(rowsGen)
})

/**
 * A case constructed to reach the situation a draw rarely meets: B waiting for A at a child, both stamping child 1
 * concurrently, over a head the clock is below.
 */
export const aims: ReadonlyArray<readonly [Reached<StampFeature>, Gen<Stamping>]> = [
	[
		"B waited for A at a child",
		constant<Stamping>({
			mode: "concurrent",
			heads: { 1: "future", 2: "none" },
			a: [{ child: 1, note: 0 }],
			b: [{ child: 1, note: 1 }]
		})
	]
]

export const childrenOf = (rows: ReadonlyArray<Row>): ReadonlyArray<1 | 2> =>
	Arr.dedupe(Arr.map(rows, (r) => r.child))

/** Whether B shares a child with A, so waits for it at the child's head in `concurrent`. */
export const shares = (c: Stamping): boolean =>
	Arr.some(c.a, (r) => Arr.some(c.b, (s) => r.child === s.child))

/** A stored row, read back: its child, its instant and its note. */
export interface Stored {
	readonly child: number
	readonly at: bigint
	readonly note: number
}

export const byStored: Order.Order<Stored> = Order.combine(
	Order.mapInput(Order.Number, (s: Stored) => s.child),
	Order.combine(
		Order.mapInput(Order.BigInt, (s: Stored) => s.at),
		Order.mapInput(Order.Number, (s: Stored) => s.note)
	)
)

/** A call's answer once it is no TransientFailure, and how many times it ran. */
export interface Answered {
	readonly tries: number
	readonly ran: Result.Result<WriteAnswer<WriteOutcome<unknown>>, CallError>
}

/** `call` run until it ends other than in a TransientFailure, each run counted. */
export const untilAnswered = (call: Effect.Effect<WriteAnswer<WriteOutcome<unknown>>, CallError>) =>
	Effect.gen(function* () {
		for (let tries = 1; ; tries++) {
			const ran = yield* Effect.result(call)
			if (Result.isSuccess(ran) || ran.failure.kind !== "transient") {
				return { tries, ran } satisfies Answered
			}
		}
	})

export const addedTo = (outcome: WriteAnswer<WriteOutcome<unknown>>): bigint =>
	outcome.kind === "accepted"
		? Option.getOrElse(
				Option.map(
					Arr.findFirst(outcome.counts, (c) => c.relation === "Log"),
					(c) => c.added
				),
				() => 0n
			)
		: 0n

/**
 * Where the rows the calls added at `child` depart from the rule (see the header), why; none where they keep it.
 * `added` are the child's rows the calls added, `order` the calls in commit order with their rows, `before` the
 * clock's reading before the calls began.
 */
export const departureAt = (
	child: 1 | 2,
	head: Head,
	added: ReadonlyArray<Stored>,
	order: ReadonlyArray<readonly [string, ReadonlyArray<Row>]>,
	before: bigint
): string | undefined => {
	const stamping = Arr.filter(order, ([, rows]) => Arr.some(rows, (r) => r.child === child))
	const instants = Arr.dedupe(Arr.map(added, (s) => s.at))
	if (instants.length !== stamping.length) {
		return `child ${child} holds one instant per call that stamps it, ${stamping.length}: ${Formatter.format(added)}`
	}
	for (const [k, [name, rows]] of stamping.entries()) {
		const at = instants[k]
		if (at === undefined) {
			return `child ${child} holds an instant for ${name}`
		}
		const notes = Arr.map(
			Arr.filter(added, (s) => s.at === at),
			(s) => s.note
		)
		const stated = Arr.sort(
			Arr.map(
				Arr.filter(rows, (r) => r.child === child),
				(r) => r.note
			),
			Order.Number
		)
		if (!deepEquals(notes, stated)) {
			return `${name}, the ${k + 1}th call to commit at child ${child}, holds its rows there, notes ${Formatter.format(stated)}, at its instant ${at}, its every row at it: ${Formatter.format(added)}`
		}
		const expected =
			head === "future"
				? future + BigInt(k + 1)
				: k === 0
					? undefined
					: (instants[k - 1] ?? 0n) + 1n
		if (expected !== undefined && head === "future" && at !== expected) {
			return `${name} stamps F + ${k + 1} at child ${child}, over a head the clock is below: ${at}`
		}
		if (k === 0 && head !== "future" && at < before) {
			return `${name} stamps child ${child} at least at the clock's reading before the calls, ${before}: ${at}`
		}
		if (head === "past" && at <= 1n) {
			return `${name} stamps child ${child} above its head, 1: ${at}`
		}
	}
	return undefined
}

export const callRows = (rows: ReadonlyArray<Row>) => Arr.map(rows, (r) => ({ ...r }))

/** The schedule's installation made once per member (support/schedules/rig.ts rigTemplate), which each case's seat holds. */
export const clocksRig = rigTemplate(import.meta, "instants clocks", clocks)
