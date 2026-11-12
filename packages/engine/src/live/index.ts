/**
 * The live event model, runtime-free and browser-safe: what a served program's call takes and answers, its events and
 * errors as data, its keys, its values and the evaluators of them, which the server, the client and the tests share.
 */
export {
	type CallError,
	type CallErrorKind,
	type CallErrorOf,
	callError,
	callErrors,
	type EventDescriptor,
	type EventOfShape,
	events,
	type InstantListEvent,
	type InstantSetEvent,
	type InstantShape,
	type ListChange,
	type ListEvent,
	type Payload,
	type PayloadOf,
	type ReadShape,
	type Retry,
	type Role,
	type SetChange,
	type SetEvent,
	type Shape,
	type Slot,
	type SlotValues,
	type WriteEvent
} from "#compiler/live/events.ts"
export {
	coalesceList,
	coalesceSet,
	diffList,
	diffSet,
	fold,
	foldWrite,
	opening,
	type ReadEvent,
	type ReadState,
	type WriteState,
	writeOpening
} from "#compiler/live/fold.ts"
export { type Form, formOf, type KeyFields, keyOf, RowKey, sameValue } from "#compiler/live/key.ts"
export { type Entry, Keyed, type KeyedList, type KeyedSet } from "#compiler/live/keyed.ts"
export type {
	Anchor,
	Empty,
	EventOf,
	Input,
	InputOf,
	OutcomeOf,
	Refreshed,
	RelationCounts,
	RowOf,
	ShapeOf,
	StateOf,
	ValueOf,
	Window,
	WindowInput,
	WriteOutcome
} from "#compiler/live/program.ts"
