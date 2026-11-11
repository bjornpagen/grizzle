/**
 * The client plan: every engine name @bjornpagen/grizzle/client loads, each re-exported from the one module that holds
 * it. Every module it re-exports is browser-safe: it loads no Node module, no Effect, no compiler and no runtime of a
 * served layer, only the live event model, the wire codecs and the exact values they decode into. .fallowrc.json's
 * plan-client zone holds the facade to that.
 */
export { defect } from "#compiler/core/invariant.ts"
export { trusted, trustedJson } from "#compiler/core/trusted.ts"
export { encodeInput, slotDecoders, wireText } from "#compiler/live/codec.ts"
export {
	type CallError,
	type CallErrorKind,
	callError,
	type EventDescriptor,
	events,
	type ReadShape,
	type Retry,
	type Shape,
	type WriteEvent
} from "#compiler/live/events.ts"
export {
	fold,
	foldWrite,
	opening,
	type ReadEvent,
	type ReadState,
	type WriteState,
	writeOpening
} from "#compiler/live/fold.ts"
export { RowKey } from "#compiler/live/key.ts"
export { Keyed, type KeyedList, type KeyedSet } from "#compiler/live/keyed.ts"
export type {
	Anchor,
	EventOf,
	InputOf,
	Refreshed,
	RelationCounts,
	ValueOf,
	Window,
	WriteOutcome
} from "#compiler/live/program.ts"
export type { MemberWire, WireOptions } from "#compiler/live/shape.ts"
export { trustedMember, type WireJson } from "#compiler/live/wire.ts"
export { Decimal } from "#compiler/scalar/values/decimal.ts"
export { Money } from "#compiler/scalar/values/money.ts"
export { Vector } from "#compiler/scalar/values/vector.ts"
