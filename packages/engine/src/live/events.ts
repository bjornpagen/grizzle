/**
 * The live event model as data: every event of a call's answer and every error that ends one is a descriptor here, its
 * name and the slots its payload holds, from which the TypeScript types below, the SSE frames and the OpenAPI schema
 * all derive, so no shape is spelled twice.
 *
 * A read's answer opens with `reset`, which names the key fields its rows are keyed by; sends an `upsert` per row as it
 * decodes, provisional until `ready`, which follows the read's COMMIT; and then, live, an `upsert` or `remove` per
 * change, each sent after its re-run's COMMIT. A set read's upsert carries its row alone; an ordered read's carries the
 * key of the row it follows too, null for the first. A write's answer is its `outcome`, after its COMMIT. Every failure
 * is one `error`, and an answer ends with `end` after its error or outcome.
 */
import type { TransientTag } from "#compiler/core/errors.ts"
import type { Key, KeyFields } from "#compiler/live/key.ts"
import type { Refused, Witness } from "#compiler/types/changeset/changeset.ts"

/**
 * What one payload member holds, by the slot that types it: a text; reset's key fields; a row; a key; the key an
 * ordered row follows, null for the first; a write's outcome; a CallError; a refusal's laws and witness; and which
 * concurrent refusal a transient error met (core/errors.ts TransientTag).
 */
export interface SlotValues<Row, Outcome> {
	readonly text: string
	readonly fields: KeyFields
	readonly row: Row
	readonly key: Key
	readonly after: Key | null
	readonly outcome: Outcome
	readonly error: CallError
	readonly refused: Refused
	readonly witness: Witness
	readonly transientReason: TransientTag
}

/** The slots a payload member is typed by. */
export type Slot = keyof SlotValues<unknown, unknown>

/** A payload: each member's name, with the slot that types it. */
export type Payload = { readonly [member: string]: Slot }

/**
 * Whether running the same call again is safe: `safe`, nothing committed and the failure is not the call's own, so the
 * same call may succeed; `never`, the same call meets the same answer, or may apply twice.
 */
export type Retry = "safe" | "never"

/**
 * The one classification of every failure a call ends with: each error's retry, and the members its payload holds
 * beside its `message`, the failure's own words (the server's report where the database refused).
 *
 * - `route`: no served program at the path: an unknown login, role or program, or a method other than POST.
 * - `input`: the body, a parameter or a fact does not decode, or a parameter or fact a codec refuses, past its size
 *   bound included.
 * - `tokenRefused`: no token where the role reads a context, a token its verify refuses, or claims that do not
 *   decode through the role's contexts.
 * - `tokenExpired`: the token expired, before the call or while it streamed: the same call with a fresh token.
 * - `refused`: the schema's laws refused the write: which laws and how grizzle decided them, and the witness.
 * - `outsideWorld`: a fact the write adds lies outside the written world relation.
 * - `transient`: SERIALIZABLE refused the attempt (40001, 40P01) or a concurrent writer's change met it, and it
 *   changed nothing (TransientFailure); `reason` names which.
 * - `unavailable`: no session could be opened: the pool or the handle refused one before anything was sent.
 * - `transport`: a connection broke before the terminal event, the client's exchange or the server's session, of a
 *   read, which commits nothing, or of a write before its COMMIT was sent.
 * - `stale`: the database does not hold the snapshot the server was deployed with, so the call ran nothing.
 * - `commitUnknown`: a write's COMMIT was sent and no answer came: it may have committed.
 * - `failed`: the server or the database failed the call otherwise: a statement it refused, a lost connection, an
 *   answer that does not read.
 */
export const callErrors = {
	route: { retry: "never", payload: { message: "text" } },
	input: { retry: "never", payload: { message: "text" } },
	tokenRefused: { retry: "never", payload: { message: "text" } },
	tokenExpired: { retry: "safe", payload: { message: "text" } },
	refused: {
		retry: "never",
		payload: { message: "text", refused: "refused", witness: "witness" }
	},
	outsideWorld: { retry: "never", payload: { message: "text", relation: "text" } },
	transient: { retry: "safe", payload: { message: "text", reason: "transientReason" } },
	unavailable: { retry: "safe", payload: { message: "text" } },
	transport: { retry: "safe", payload: { message: "text" } },
	stale: { retry: "never", payload: { message: "text" } },
	commitUnknown: { retry: "never", payload: { message: "text" } },
	failed: { retry: "never", payload: { message: "text" } }
} as const satisfies {
	readonly [kind: string]: { readonly retry: Retry; readonly payload: Payload }
}

/** The errors' kinds. */
export type CallErrorKind = keyof typeof callErrors

/** The members of a payload, each typed by its slot. */
export type PayloadOf<P extends Payload, Row, Outcome> = {
	readonly [M in keyof P]: SlotValues<Row, Outcome>[P[M]]
}

/** The error of kind K: its kind, the retry the classification gives it, and its payload. */
export type CallErrorOf<K extends CallErrorKind> = {
	readonly kind: K
	readonly retry: (typeof callErrors)[K]["retry"]
} & PayloadOf<(typeof callErrors)[K]["payload"], never, never>

/** Every failure a call ends with (callErrors). */
export type CallError = { readonly [K in CallErrorKind]: CallErrorOf<K> }[CallErrorKind]

/** The error of kind `kind` with its payload, its retry the classification's. */
export const callError = <K extends CallErrorKind>(
	kind: K,
	payload: PayloadOf<(typeof callErrors)[K]["payload"], never, never>
): CallErrorOf<K> => ({ kind, retry: callErrors[kind].retry, ...payload })

/**
 * What an event is to its stream: an `item` of the answer; `ready`, the read's value is whole; `error`, the answer
 * failed; `end`, nothing follows.
 */
export type Role = "item" | "ready" | "error" | "end"

/** An event's descriptor: its role, and the members its payload holds. */
export interface EventDescriptor {
	readonly role: Role
	readonly payload: Payload
}

const reset = { role: "item", payload: { key: "fields" } } as const
const remove = { role: "item", payload: { key: "key" } } as const
const ready = { role: "ready", payload: {} } as const
const error = { role: "error", payload: { error: "error" } } as const
const end = { role: "end", payload: {} } as const

/**
 * The events of each shape of answer, by name: a set read's, an ordered read's, whose upsert carries `after` too, and
 * a write's.
 */
export const events = {
	set: { reset, upsert: { role: "item", payload: { row: "row" } }, remove, ready, error, end },
	list: {
		reset,
		upsert: { role: "item", payload: { row: "row", after: "after" } },
		remove,
		ready,
		error,
		end
	},
	write: { outcome: { role: "item", payload: { outcome: "outcome" } }, error, end }
} as const satisfies {
	readonly [shape: string]: { readonly [name: string]: EventDescriptor }
}

/** The shapes of answer: a set read's, an ordered read's, a write's. */
export type Shape = keyof typeof events

/** The read shapes, whose answers are keyed values. */
export type ReadShape = Exclude<Shape, "write">

/** The event `name` of shape S over Row and Outcome: its name as `kind`, and its payload's members. */
type EventNamed<S extends Shape, Name extends keyof (typeof events)[S], Row, Outcome> = {
	readonly kind: Name
} & PayloadOf<EventPayload<S, Name>, Row, Outcome>

type EventPayload<
	S extends Shape,
	Name extends keyof (typeof events)[S]
> = (typeof events)[S][Name] extends { readonly payload: infer P extends Payload } ? P : never

/** Every event of an answer of shape S, over its rows Row and a write's Outcome. */
export type EventOfShape<S extends Shape, Row, Outcome> = {
	readonly [Name in keyof (typeof events)[S]]: EventNamed<S, Name, Row, Outcome>
}[keyof (typeof events)[S]]

/** A set read's events. */
export type SetEvent<Row> = EventOfShape<"set", Row, never>

/** An ordered read's events. */
export type ListEvent<Row> = EventOfShape<"list", Row, never>

/** A write's events. */
export type WriteEvent<Outcome> = EventOfShape<"write", never, Outcome>

/** A set read's change: an upsert of a row, or the removal of a key. */
export type SetChange<Row> = Extract<SetEvent<Row>, { readonly kind: "upsert" | "remove" }>

/** An ordered read's change: an upsert of a row after a key, a move when its key is present, or a removal. */
export type ListChange<Row> = Extract<ListEvent<Row>, { readonly kind: "upsert" | "remove" }>
