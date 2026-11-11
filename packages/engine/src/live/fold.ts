/**
 * The evaluators of a read's value: fold, the one reading of a read's events into its state, which a client, a test
 * and coalescing share; diff, the least change from one value to another; and coalesce, the net change of pending
 * changes.
 */
import { defect, defined } from "#compiler/core/invariant.ts"
import type {
	CallError,
	ListChange,
	ListEvent,
	ReadShape,
	SetChange,
	SetEvent
} from "#compiler/live/events.ts"
import { type Key, sameValue } from "#compiler/live/key.ts"
import { type Entry, Keyed, type KeyedList, type KeyedSet } from "#compiler/live/keyed.ts"

/** A read's events of shape S. */
export type ReadEvent<S extends ReadShape, Row> = {
	readonly set: SetEvent<Row>
	readonly list: ListEvent<Row>
}[S]

/**
 * A read's state as its events have built it: `opening`, before its reset; `provisional`, the rows decoded so far,
 * which an error voids; `ready`, its value, whole at `ready` and live after it; `failed`, the error that ended it,
 * with no value.
 */
export type ReadState<S extends ReadShape, Row extends object> =
	| { readonly kind: "opening"; readonly shape: S }
	| { readonly kind: "provisional"; readonly value: Keyed<S, Row> }
	| { readonly kind: "ready"; readonly value: Keyed<S, Row> }
	| { readonly kind: "failed"; readonly error: CallError }

/** The state of a read of shape `shape` before its first event. */
export const opening = <S extends ReadShape, Row extends object>(shape: S): ReadState<S, Row> => ({
	kind: "opening",
	shape
})

/** The state `state` with `pending` changes applied to its value, where it holds one. */
const settled = <S extends ReadShape, Row extends object>(
	state: ReadState<S, Row>,
	pending: ReadonlyArray<SetChange<Row> | ListChange<Row>>
): ReadState<S, Row> => {
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

/** The shape of a state's value. */
const shapeOf = <S extends ReadShape, Row extends object>(
	state: Exclude<ReadState<S, Row>, { readonly kind: "failed" }>
): S => (state.kind === "opening" ? state.shape : state.value.shape)

/**
 * `state` after `events`, in order: `reset` opens an empty value keyed by its fields, provisional; an upsert or a
 * remove changes the value (Keyed applying); `ready` makes the provisional value the read's value; `error` ends the
 * read, voiding any value; `end` changes nothing. A failed read stays failed. A change before any reset is a defect of
 * the stream. Consecutive changes are applied to one new value, so `state` is never changed.
 */
export const fold = <S extends ReadShape, Row extends object>(
	state: ReadState<S, Row>,
	events: Iterable<ReadEvent<S, Row>>
): ReadState<S, Row> => {
	let current = state
	let pending: Array<SetChange<Row> | ListChange<Row>> = []
	for (const event of events) {
		const read: SetEvent<Row> | ListEvent<Row> = event
		switch (read.kind) {
			case "upsert":
			case "remove":
				if (current.kind === "opening") {
					throw defect("a read's change came before its reset")
				}
				pending.push(read)
				break
			case "reset":
				current =
					current.kind === "failed"
						? current
						: { kind: "provisional", value: Keyed.empty(shapeOf(current), read.key) }
				pending = []
				break
			case "ready":
				current = settled(current, pending)
				pending = []
				if (current.kind === "opening") {
					throw defect("a read's ready came before its reset")
				}
				current = current.kind === "provisional" ? { kind: "ready", value: current.value } : current
				break
			case "error":
				current = current.kind === "failed" ? current : { kind: "failed", error: read.error }
				pending = []
				break
			case "end":
				break
		}
	}
	return settled(current, pending)
}

/** The removes of every key `previous` holds and `next` does not, in `previous`'s order. */
const removals = <S extends ReadShape, Row extends object>(
	previous: Keyed<S, Row>,
	next: Keyed<S, Row>
): Array<{ readonly kind: "remove"; readonly key: Key }> => {
	const changes: Array<{ readonly kind: "remove"; readonly key: Key }> = []
	for (const entry of previous.entries()) {
		if (next.at(entry.form) === undefined) {
			changes.push({ kind: "remove", key: entry.key })
		}
	}
	return changes
}

/** Whether `entry` stands in `previous` as it is: its key held, with the same row. */
const unchanged = <S extends ReadShape, Row extends object>(
	previous: Keyed<S, Row>,
	entry: Entry<Row>
): boolean => {
	const was = previous.at(entry.form)
	return was !== undefined && sameValue(was.row, entry.row)
}

/**
 * The least change from set `previous` to set `next`, of one program's key fields: a remove of each key `next` does
 * not hold, then an upsert of each row of `next` whose key `previous` does not hold or holds with another row.
 */
export const diffSet = <Row extends object>(
	previous: KeyedSet<Row>,
	next: KeyedSet<Row>
): ReadonlyArray<SetChange<Row>> => {
	const changes: Array<SetChange<Row>> = removals(previous, next)
	for (const entry of next.entries()) {
		if (!unchanged(previous, entry)) {
			changes.push({ kind: "upsert", row: entry.row })
		}
	}
	return changes
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
 * The least change from list `previous` to list `next`, of one program's key fields: a remove of each key `next` does
 * not hold, then, in `next`'s order, an upsert after the row before it (null first) of each row that is new, changed,
 * or moved. The rows that stay are the most of those unchanged whose order `previous` already holds (a longest
 * increasing subsequence of their places in it): every other row must be sent, and no fewer moves give `next`'s order.
 */
export const diffList = <Row extends object>(
	previous: KeyedList<Row>,
	next: KeyedList<Row>
): ReadonlyArray<ListChange<Row>> => {
	const changes: Array<ListChange<Row>> = removals(previous, next)
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
	let after: Key | null = null
	entries.forEach((entry, i) => {
		if (!stays.has(i)) {
			changes.push({ kind: "upsert", row: entry.row, after })
		}
		after = entry.key
	})
	return changes
}

/**
 * The net change of `pending`, changes of a set sent after `base`: the least change from `base` to `base` with
 * `pending` applied, so a key's last change stands for all of its own, and one that ends where it began is none.
 */
export const coalesceSet = <Row extends object>(
	base: KeyedSet<Row>,
	pending: Iterable<SetChange<Row>>
): ReadonlyArray<SetChange<Row>> => diffSet(base, base.applying(pending))

/**
 * The net change of `pending`, changes of a list sent after `base`: the least change from `base` to `base` with
 * `pending` applied, every `after` a key the list holds when it is applied.
 */
export const coalesceList = <Row extends object>(
	base: KeyedList<Row>,
	pending: Iterable<ListChange<Row>>
): ReadonlyArray<ListChange<Row>> => diffList(base, base.applying(pending))
