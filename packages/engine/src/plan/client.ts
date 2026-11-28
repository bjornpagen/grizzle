/**
 * The client plan: every engine name @bjornpagen/grizzle/client loads, each re-exported from the one module that holds
 * it, and those of the reader of a login's OpenAPI document it loads (@bjornpagen/grizzle-openapi/document). Every
 * module it re-exports is browser-safe: it loads no Node module, no Effect, no compiler and no runtime of a served
 * layer, only the live event model, the wire codecs and the exact values they decode into. .fallowrc.json's
 * plan-client zone holds the facade to that.
 */
export { defect } from "@bjornpagen/grizzle-text/base/invariant"
export { isList, isPlainRecord } from "#compiler/core/record.ts"
export { trusted, trustedJson } from "#compiler/core/trusted.ts"
export { encodeInput, slotDecoders } from "#compiler/live/codec.ts"
export {
	type CallError,
	type CallErrorKind,
	type CredentialReason,
	callError,
	type EventDescriptor,
	events,
	type ListEvent,
	type Retry,
	type Shape,
	type UnavailableCause,
	type UnavailableReason,
	type WriteEvent,
	wireHeader
} from "#compiler/live/events.ts"
export {
	fold,
	foldWrite,
	opening,
	type ReadState,
	type WriteState,
	writeOpening
} from "#compiler/live/fold.ts"
export { RowKey } from "#compiler/live/key.ts"
export { KeyedList } from "#compiler/live/keyed.ts"
export type {
	Anchor,
	EventOf,
	InputCheck,
	InputOf,
	RelationCounts,
	ShapeOf,
	ValueOf,
	Window,
	WriteOutcome
} from "#compiler/live/program.ts"
export type { MemberWire, RoleWitness, WireOptions } from "#compiler/live/shape.ts"
export { trustedMember, type WireJson, type WireScalar } from "#compiler/live/wire.ts"
export { Numeric } from "#compiler/scalar/values/decimal.ts"
export { Money } from "#compiler/scalar/values/money.ts"
export { Vector } from "#compiler/scalar/values/vector.ts"
