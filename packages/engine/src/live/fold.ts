/**
 * The evaluators of a read's value: fold, the one reading of a read's events into its state, which a client, a test
 * and coalescing share; diff, the least change from one value to another; and coalesce, the net change of pending
 * changes.
 */
import { defect, defined } from "@bjornpagen/grizzle-text/base/invariant"
import type { ListChange, ListEvent, ShapeFailure, WriteEvent } from "#compiler/live/events.ts"
import { type RowKey, sameValue } from "#compiler/live/key.ts"
import { type Entry, KeyedList } from "#compiler/live/keyed.ts"

/**
 * A read's state as its events have built it: `opening`, before its reset; `provisional`, the rows decoded so far,
 * which an error voids; `ready`, its value, whole at `ready` and live after it; `failed`, the error that ended it,
 * with no value, one a read's answer may end with (live/events.ts ShapeFailure).
 */
export type ReadState<Row extends object> =
	| { readonly kind: "opening" }
	| { readonly kind: "provisional"; readonly value: KeyedList<Row> }
	| { readonly kind: "ready"; readonly value: KeyedList<Row> }
	| { readonly kind: "failed"; readonly error: ShapeFailure<"list"> }

/** The state of a read before its first event. */
export const opening = <Row extends object>(): ReadState<Row> => ({ kind: "opening" })

/** The state `state` with `pending` changes applied to its value, where it holds one. */
const settled = <Row extends object>(
	state: ReadState<Row>,
	pending: ReadonlyArray<ListChange<Row>>
): ReadState<Row> => {
	if (pending.length === 0) {
		return state
	}
	switch (state.kind) {
		case "provisional":
		case "ready":
			return { kind: state.kind, value: state.value.applying(pending) }
		case "opening":
		case "failed":
			return state
	}
}

/**
 * `state` after `events`, in order: `reset` opens an empty value keyed by its fields, provisional; an upsert or a
 * remove changes the value (KeyedList applying); `ready` makes the provisional value the read's value; `error` ends the
 * read, voiding any value; `end` changes nothing. A failed read stays failed. A change before any reset is a defect of
 * the stream. Consecutive changes are applied to one new value, so `state` is never changed.
 */
export const fold = <Row extends object>(
	state: ReadState<Row>,
	events: Iterable<ListEvent<Row>>
): ReadState<Row> => {
	let current = state
	let pending: Array<ListChange<Row>> = []
	for (const event of events) {
		switch (event.kind) {
			case "upsert":
			case "remove":
				if (current.kind === "opening") {
					defect("a read's change came before its reset")
				}
				pending.push(event)
				break
			case "reset":
				current =
					current.kind === "failed"
						? current
						: { kind: "provisional", value: KeyedList.empty(event.key) }
				pending = []
				break
			case "ready":
				current = settled(current, pending)
				pending = []
				if (current.kind === "opening") {
					defect("a read's ready came before its reset")
				}
				current = current.kind === "provisional" ? { kind: "ready", value: current.value } : current
				break
			case "error":
				current = current.kind === "failed" ? current : { kind: "failed", error: event.error }
				pending = []
				break
			case "end":
				break
		}
	}
	return settled(current, pending)
}

/**
 * A write's state as its events have built it: `opening`, before its answer; `ready`, its outcome, final; `failed`, the
 * error that ended it.
 */
export type WriteState<Outcome> =
	| { readonly kind: "opening" }
	| { readonly kind: "ready"; readonly value: Outcome }
	| { readonly kind: "failed"; readonly error: ShapeFailure<"write"> }

/** The state of a write before its first event. */
export const writeOpening = <Outcome>(): WriteState<Outcome> => ({ kind: "opening" })

/**
 * `state` after `events`, in order: `outcome` is the write's final value; `error` ends it; `end` changes nothing. A
 * write answers once, so a second answer is a defect of the stream.
 */
export const foldWrite = <Outcome>(
	state: WriteState<Outcome>,
	events: Iterable<WriteEvent<Outcome>>
): WriteState<Outcome> => {
	let current = state
	for (const event of events) {
		switch (event.kind) {
			case "outcome":
				if (current.kind !== "opening") {
					defect("a write answered twice")
				}
				current = { kind: "ready", value: event.outcome }
				break
			case "error":
				if (current.kind === "ready") {
					defect("a write answered twice")
				}
				current = current.kind === "failed" ? current : { kind: "failed", error: event.error }
				break
			case "end":
				break
		}
	}
	return current
}

/**
 * Which of `positions` one longest strictly increasing subsequence holds, by index: patience sorting, each index
 * linked to the index before it in the subsequence it ends.
 */
const longestIncreasing = (positions: ReadonlyArray<number>): ReadonlySet<number> => {
	const ends: Array<number> = []
	const before: Array<number | undefined> = []
	positions.forEach((position, i) => {
		let low = 0
		let high = ends.length
		while (low < high) {
			const middle = (low + high) >>> 1
			if (defined(positions[defined(ends[middle], "an end")], "a position") < position) {
				low = middle + 1
			} else {
				high = middle
			}
		}
		before.push(low === 0 ? undefined : ends[low - 1])
		ends[low] = i
	})
	const held = new Set<number>()
	for (let i = ends.at(-1); i !== undefined; i = before[i]) {
		held.add(i)
	}
	return held
}

/**
 * The least change from value `previous` to value `next`, of one program's key fields: a remove of each key `next` does
 * not hold, in `previous`'s order, then, in `next`'s order, an upsert after the row before it (null first) of each row
 * that is new, changed, or moved. The rows that stay are the most of those unchanged whose order `previous` already
 * holds (a longest increasing subsequence of their places in it): every other row must be sent, and no fewer moves give
 * `next`'s order.
 */
export const diffList = <Row extends object>(
	previous: KeyedList<Row>,
	next: KeyedList<Row>
): ReadonlyArray<ListChange<Row>> => {
	const changes: Array<ListChange<Row>> = []
	for (const entry of previous.entries()) {
		if (next.at(entry.form) === undefined) {
			changes.push({ kind: "remove", key: entry.key })
		}
	}
	const place = new Map<Entry<Row>, number>()
	for (const entry of previous.entries()) {
		place.set(entry, place.size)
	}
	const entries = [...next.entries()]
	const kept: Array<number> = []
	const places: Array<number> = []
	entries.forEach((entry, i) => {
		const was = previous.at(entry.form)
		if (was !== undefined && sameValue(was.row, entry.row)) {
			kept.push(i)
			places.push(defined(place.get(was), "a kept row's place"))
		}
	})
	const stays = new Set<number>()
	for (const k of longestIncreasing(places)) {
		stays.add(defined(kept[k], "a kept row"))
	}
	let after: RowKey | null = null
	entries.forEach((entry, i) => {
		if (!stays.has(i)) {
			changes.push({ kind: "upsert", row: entry.row, after })
		}
		after = entry.key
	})
	return changes
}

/**
 * The net change of `pending`, changes sent after `base`: the least change from `base` to `base` with `pending`
 * applied, so a key's last change stands for all of its own, one that ends where it began is none, and every `after`
 * is a key the value holds when it is applied.
 */
export const coalesceList = <Row extends object>(
	base: KeyedList<Row>,
	pending: Iterable<ListChange<Row>>
): ReadonlyArray<ListChange<Row>> => diffList(base, base.applying(pending))
