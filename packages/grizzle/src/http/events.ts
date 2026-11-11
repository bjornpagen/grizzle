import type {
	CallError,
	events,
	ListEvent,
	SetEvent,
	Slot,
	SlotValues,
	WriteEvent
} from "#compiler/live/index.ts"
import type { WireJson } from "#compiler/plan/runtime.ts"

/**
 * A call's events as their SSE lines carry them (sse.ts SseEvent): each event's kind names it, and its data holds each
 * member of its payload (live/events.ts events) as JSON, encoded by the slot that types it (live/wire.ts
 * slotEncoders): a row, a key, an outcome and an error by the member's wire, the rest as their slots spell them. Every
 * frame's data is typed by its event's payload, so a frame that leaves out a member, or holds one the payload does not,
 * is no frame of it; an event with no payload carries `{}`.
 */

/** Each slot's JSON encoder, as a member's wire builds them (live/wire.ts slotEncoders). */
export type SlotEncoders = {
	readonly [S in Slot]: (value: SlotValues<unknown, unknown>[S]) => WireJson
}

/** The descriptors of each shape's events. */
type Events = typeof events

/** A payload's JSON: one value per member. */
type PayloadJson<P> = { readonly [M in keyof P]: WireJson }

/** The frame of each event of shape S: its kind as the event's name, and its payload's JSON as its data. */
type FrameOf<S extends keyof Events> = {
	readonly [N in keyof Events[S]]: {
		readonly event: N
		readonly data: PayloadJson<Events[S][N] extends { readonly payload: infer P } ? P : never>
	}
}[keyof Events[S]]

/** The events every read shares, set or ordered: their payloads are one descriptor's. */
type ReadCommon = Exclude<SetEvent<unknown> | ListEvent<unknown>, { readonly kind: "upsert" }>

/** The frame of an event every read shares, set or ordered. */
const readCommonFrame = (
	slots: SlotEncoders,
	event: ReadCommon
): Exclude<FrameOf<"set">, { readonly event: "upsert" }> => {
	switch (event.kind) {
		case "reset":
			return { event: event.kind, data: { key: slots.fields(event.key) } }
		case "remove":
			return { event: event.kind, data: { key: slots.key(event.key) } }
		case "ready":
			return { event: event.kind, data: {} }
		case "error":
			return { event: event.kind, data: { error: slots.error(event.error) } }
		case "end":
			return { event: event.kind, data: {} }
	}
}

/** The frame of a set read's event: an upsert holds its row. */
export const setFrame = (slots: SlotEncoders, event: SetEvent<unknown>): FrameOf<"set"> =>
	event.kind === "upsert"
		? { event: event.kind, data: { row: slots.row(event.row) } }
		: readCommonFrame(slots, event)

/** The frame of an ordered read's event: an upsert holds its row and the key of the row it follows. */
export const listFrame = (slots: SlotEncoders, event: ListEvent<unknown>): FrameOf<"list"> =>
	event.kind === "upsert"
		? { event: event.kind, data: { row: slots.row(event.row), after: slots.after(event.after) } }
		: readCommonFrame(slots, event)

/** The frame of a write's event: its outcome, its error, or its end. */
export const writeFrame = (slots: SlotEncoders, event: WriteEvent<unknown>): FrameOf<"write"> => {
	switch (event.kind) {
		case "outcome":
			return { event: event.kind, data: { outcome: slots.outcome(event.outcome) } }
		case "error":
			return { event: event.kind, data: { error: slots.error(event.error) } }
		case "end":
			return { event: event.kind, data: {} }
	}
}

/**
 * The frames of a call refused before any member ran (a request line no route serves, a token, a body): its error,
 * encoded by `error`, then its end, as every failed call ends.
 */
export const refusedFrames = <E extends CallError>(
	error: (value: E) => WireJson,
	refused: E
): readonly [FrameOf<"write">, FrameOf<"write">] => [
	{ event: "error", data: { error: error(refused) } },
	{ event: "end", data: {} }
]
