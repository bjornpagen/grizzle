import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import type * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import {
	drawnCall,
	type HostCall,
	hostInputs,
	inputApplyError,
	runWrite,
	runWriteShares
} from "#adapter/apply/run.ts"
import { dbChangeFrame, type ServedDbContext } from "#adapter/db/context.ts"
import { type CallInput, callInput, noFacts, windowedInput } from "#adapter/db/input.ts"
import {
	type ApplyError,
	type ReadError,
	ReadFailure,
	TransportFailure
} from "#adapter/errors/execution.ts"
import type { CallInputRefused } from "#adapter/errors/failures.ts"
import { applyCallError, outcomeReading, readCallError } from "#adapter/live/call-error.ts"
import { routeKeys } from "#adapter/live/router.ts"
import type { Live, LiveAnswer } from "#adapter/live/subscriptions.ts"
import { applyOutcome } from "#adapter/outcomes/index.ts"
import { windowIntake, windowStatement } from "#adapter/page/execute.ts"
import { windowCall } from "#adapter/page/window.ts"
import type { ExecutionInputs } from "#adapter/reader/execution.ts"
import { hostParams, readKeyValues } from "#adapter/reader/params.ts"
import { executionInputs } from "#adapter/reader/relations.ts"
import { programStatement, readIntake } from "#adapter/reader/run.ts"
import {
	type DecodedRow,
	listEvents,
	type ReadCall,
	readStream,
	type ShapeEvents
} from "#adapter/reader/stream.ts"
import { explainChange, explainRead, explainReadAnalyzed } from "#adapter/served/explain.ts"
import type {
	ChangeCall,
	LoadedChange,
	LoadedMember,
	LoadedPage,
	LoadedRead,
	LoadedVariants
} from "#adapter/served/load.ts"
import type { ApplyOutcome, ExecutedStatement, StatementPlan } from "#adapter/types/db.ts"
import { takenRows } from "#adapter/wire/batch.ts"
import type { Session } from "#adapter/wire/session.ts"
import {
	type AnswerFailure,
	callError,
	diffList,
	type FailureOf,
	fold,
	type AnsweredListEvent,
	type KeyedList,
	type ListEvent,
	opening,
	type ReadState,
	type ShapeFailure,
	type WriteEvent,
	type WriteOutcome
} from "#compiler/live/index.ts"
import type { EncodingFailure } from "#compiler/plan/common.ts"
import { defect, type RouteKey } from "#compiler/plan/runtime.ts"
import type { ServedReadLive, ServedTables } from "#compiler/plan/serve.ts"

/**
 * A served Db's workload handles: each member its layer loaded for the Db's role (served/load.ts LoadedMember), run on
 * the Db's pool, under its name. Every member offers `once(input)` and, but an answered read, `watch(input)`
 * (ServedCalls), its input read once at this boundary (db/input.ts), and a read or change member its explains, which
 * plan exactly the statements its once sends. A handle lives as long as the layer that loaded its program.
 *
 * - A read, a key and a paged member read: `watch` is the read's events (reader/stream.ts readStream), reset, an
 *   upsert per row as it decodes, provisional, then ready after its COMMIT; `once` is those events folded to ready
 *   (live/fold.ts), the read's value, or the error that ended them. A key member's parameters are its key's values,
 *   read off its input's params by the key's fields; a paged member's window selects its template and its anchor. An
 *   answered read (served/forms.ts ServedReadLive `answered`), a clocked one among them, has no watch: its answer is one
 *   call's events then `end`, which no change follows, and it registers no subscription.
 * - A change member writes: `once` is its outcome after its COMMIT, accepted with its counts and read-backs or
 *   unchanged, and every refusal is its CallError, the laws' rejection and a fact outside the world included; `watch`
 *   is that outcome, or that error, then end. Its facts are its array members' where its ChangeSet holds some, else `{}`.
 *
 * Every failure is classified once (live/call-error.ts readCallError, applyCallError), so an answer's error event and
 * once's error are one CallError, of the kinds its answer ends with (live/events.ts ShapeFailure).
 *
 * A member's calls over JavaScript values, by the shape of its answer, so a call's events and its value are typed by
 * its shape: what a typed handle views (types/db MemberHandle) and what the HTTP handler calls by name. Its `once` half
 * is OnceCalls.
 */
export type ServedCalls =
	| (Extract<OnceCalls, { readonly shape: "list" }> & {
			readonly watch: (input: unknown) => Stream.Stream<ListEvent<DecodedRow>>
	  })
	| (Extract<OnceCalls, { readonly shape: "answeredList" }> & {
			readonly answer: (input: unknown) => Stream.Stream<AnsweredListEvent<DecodedRow>>
	  })
	| (Extract<OnceCalls, { readonly shape: "write" }> & {
			readonly watch: (input: unknown) => Stream.Stream<WriteEvent<WrittenOutcome>>
	  })

/** A member's `once` alone, by the shape of its answer: the once half of every member's calls (ServedCalls). */
export type OnceCalls =
	| {
			readonly shape: "list"
			readonly once: (input: unknown) => Effect.Effect<KeyedList<DecodedRow>, ShapeFailure<"list">>
	  }
	| {
			readonly shape: "answeredList"
			readonly once: (input: unknown) => Effect.Effect<KeyedList<DecodedRow>, ShapeFailure<"list">>
	  }
	| {
			readonly shape: "write"
			readonly once: (input: unknown) => Effect.Effect<WrittenOutcome, ShapeFailure<"write">>
	  }

/** What a write member's once answers: a ChangeSet's outcome over its read-backs. */
export type WrittenOutcome = WriteOutcome<unknown>

/**
 * A read member's call parsed from its input: its read call, and the execution inputs its statement binds, which its
 * subscription routes by.
 */
export interface ParsedRead {
	readonly call: ReadCall
	readonly inputs: ExecutionInputs
}

/**
 * A read's execution inputs from the caller's parameters, read as the program `name` its workload serves it under
 * (reader/params.ts hostParams, reader/relations.ts).
 */
const readInputs = (
	name: string,
	read: LoadedRead,
	params: unknown
): Effect.Effect<ExecutionInputs, ReadError> =>
	Effect.flatMap(hostParams(name, read.params, params), (values) =>
		Effect.mapError(
			Effect.fromResult(executionInputs(read.codecs, values)),
			(reason) => new ReadFailure({ reason })
		)
	)

/**
 * The call of the read member `name` over `params`, each call's rows read by its program's intake (reader/run.ts
 * readIntake).
 */
const programCall = (
	name: string,
	read: LoadedRead,
	params: unknown
): Effect.Effect<ParsedRead, ReadError> =>
	Effect.map(readInputs(name, read, params), (inputs) => ({
		inputs,
		call: {
			fields: read.key.fields,
			decode: read.read,
			open: (emit) => {
				const intake = readIntake(read.program, inputs.params, emit)
				return Effect.map(
					programStatement(read.program, inputs, takenRows(intake.take)),
					(statement) => ({ statement, end: intake.end })
				)
			}
		}
	}))

/** The refusal of an input at the boundary, as a read's. */
const refusedRead = (reason: CallInputRefused): ReadFailure => new ReadFailure({ reason })

/** A read or key member's input: its parameters, and no facts. */
const readInput = (input: unknown): Effect.Effect<CallInput, ReadError> =>
	Effect.mapError(
		Effect.fromResult(
			Result.flatMap(callInput(input), (read) => Result.map(noFacts(read.facts), () => read))
		),
		refusedRead
	)

/** The read member `name`'s call (programCall) from its input. */
const parseRead =
	(name: string, read: LoadedRead) =>
	(input: unknown): Effect.Effect<ParsedRead, ReadError> =>
		Effect.flatMap(readInput(input), (given) => programCall(name, read, given.params))

/**
 * The key member `name`'s call from its input: its parameters are its key's values, read off its params by the key's
 * fields.
 */
const parseKey =
	(name: string, read: LoadedRead, fields: ReadonlyArray<string>) =>
	(input: unknown): Effect.Effect<ParsedRead, ReadError> =>
		Effect.flatMap(readInput(input), (given) =>
			Effect.flatMap(
				Effect.mapError(Effect.fromResult(readKeyValues(fields, given.params)), refusedRead),
				(values) => programCall(name, read, values)
			)
		)

/**
 * The paged member `name`'s call from its input: its window read against the page's comparators (page/window.ts), its template
 * the window's anchor selects, its rows read once its statement has answered (page/execute.ts windowIntake) and decoded
 * by the decoder bound to that template.
 */
const parseWindow =
	(name: string, read: LoadedRead, page: LoadedPage) =>
	(input: unknown): Effect.Effect<ParsedRead, ReadError> =>
		Effect.gen(function* () {
			const given = yield* Effect.mapError(
				Effect.fromResult(
					Result.flatMap(windowedInput(input), (windowed) =>
						Result.flatMap(noFacts(windowed.facts), () =>
							Result.map(windowCall(windowed.window, page.runtime.anchors), (call) => ({
								params: windowed.params,
								call
							}))
						)
					)
				),
				refusedRead
			)
			const inputs = yield* readInputs(name, read, given.params)
			const window = given.call
			return {
				inputs,
				call: {
					fields: read.key.fields,
					decode: page.reads[window.variant],
					open: (emit) => {
						const intake = windowIntake(
							page.runtime.artifact.requests[window.variant],
							window.size,
							emit
						)
						return Effect.map(
							windowStatement(page.runtime, inputs, window, takenRows(intake.take)),
							(statement) => ({ statement, end: intake.end })
						)
					}
				}
			}
		})

/**
 * How a live read answers, beside how its events are made (reader/stream.ts ShapeEvents): its `end`, its events folded
 * from before its reset (live/fold.ts), which once settles, and the least change between two of its values, which it
 * sends after each re-run (live/subscriptions.ts LiveAnswer).
 */
interface ShapeAnswer<E> extends ShapeEvents<E>, LiveAnswer<DecodedRow, E> {
	readonly error: (error: AnswerFailure<"live">) => E
}

/** A live read's answer: its error event of any of the failures a live read's answer ends with. */
const liveAnswer: ShapeAnswer<ListEvent<DecodedRow>> = {
	...listEvents,
	error: (error) => ({ kind: "error", error }),
	end: { kind: "end" },
	settle: (events) => fold(opening<DecodedRow>(), events),
	diff: diffList
}

/**
 * How an answered read answers, at its call's instant alone (an answered(...) or a clocked member's), beside how its
 * events are made: its `end`, which follows its ready, and its events folded from before its reset into its value.
 */
interface AnsweredAnswer<E> extends ShapeEvents<E> {
	readonly end: E
	readonly settle: (events: ReadonlyArray<E>) => ReadState<DecodedRow>
}

/** An answered read's answer. */
const answeredAnswer: AnsweredAnswer<AnsweredListEvent<DecodedRow>> = {
	...listEvents,
	end: { kind: "end" },
	settle: (events) => fold(opening<DecodedRow>(), events)
}

/** What wakes a live read's watch (served/forms.ts ServedReadLive): every arm but an answered read's, which has none. */
type Routing = Exclude<ServedReadLive, { readonly kind: "answered" }>

/**
 * The routing keys a live read's call is registered under, by what wakes it (`routing`): a routed read's, its served
 * footprint's bound with the call's inputs (live/router.ts routeKeys); a constant read's none, since no change of a row
 * changes it.
 */
const keysOf = (
	routing: Routing,
	read: LoadedRead,
	parsed: ParsedRead
): ReadonlyArray<RouteKey> => {
	switch (routing.kind) {
		case "constant":
			return []
		case "routed":
			return routeKeys(routing.footprint, read.codecs, parsed.inputs)
	}
}

/**
 * A read's call registered live on its Db's layer's registry (live/subscriptions.ts), what its watch runs: its run is
 * the call's own statement through the Db's read frame (reader/stream.ts readStream), its routing keys its read's
 * (keysOf), and its expiry its Db's. A constant read is registered under no key, so no change of a row reaches it, and
 * only its source's loss ends it, a migration's `stale` among them.
 */
const registered = <E>(
	ctx: ServedDbContext,
	routing: Routing,
	read: LoadedRead,
	answer: ShapeAnswer<E>,
	parsed: ParsedRead
): Effect.Effect<Live<E>, never, Scope.Scope> =>
	ctx.subscriptions.register({
		read: readStream(ctx, parsed.call, answer).events,
		answer,
		keys: keysOf(routing, read, parsed),
		expiry: ctx.expiry
	})

/**
 * A live read member's registration for one input, exactly what its watch registers (readCalls), for as long as the
 * scope it is made in: a suite keeps its `state` while it pulls its `initial` and `changes` itself. An input that does
 * not parse is the call's error; an answered read, which registers nothing, and a write member are none.
 */
export const liveRead = (
	ctx: ServedDbContext,
	member: LoadedMember,
	input: unknown
): Option.Option<Effect.Effect<Live<ListEvent<DecodedRow>>, FailureOf<"read">, Scope.Scope>> => {
	const live = (
		read: LoadedRead,
		parse: (input: unknown) => Effect.Effect<ParsedRead, ReadError>
	): Option.Option<Effect.Effect<Live<ListEvent<DecodedRow>>, FailureOf<"read">, Scope.Scope>> => {
		const routing = read.live
		switch (routing.kind) {
			case "answered":
				return Option.none()
			case "constant":
			case "routed":
				return Option.some(
					Effect.flatMap(Effect.mapError(parse(input), readCallError), (parsed) =>
						registered(ctx, routing, read, liveAnswer, parsed)
					)
				)
		}
	}
	switch (member.kind) {
		case "read":
			return live(member.read, parseRead(member.name, member.read))
		case "key":
			return live(member.read, parseKey(member.name, member.read, member.fields))
		case "paged":
			return live(member.read, parseWindow(member.name, member.read, member.page))
		case "change":
			return Option.none()
	}
}

/**
 * A live read's calls (see the header): its input parsed by `parse`, a refusal of which is its one error event
 * then `end`; once its events settled to ready, the read's value, or the error that ended them. Its watch is live
 * (live/subscriptions.ts): registered on the layer's registry under its routing keys (keysOf), a constant read's none,
 * before its first run, then that run's events, then each change of its value after its ready, until the Db's token
 * expires, its source is lost, a migration of the installation among the losses, a run fails, or its consumer stops.
 */
const readCalls = <E>(
	ctx: ServedDbContext,
	routing: Routing,
	read: LoadedRead,
	answer: ShapeAnswer<E>,
	parse: (input: unknown) => Effect.Effect<ParsedRead, ReadError>
): {
	readonly once: (input: unknown) => Effect.Effect<KeyedList<DecodedRow>, ShapeFailure<"list">>
	readonly watch: (input: unknown) => Stream.Stream<E>
} => {
	const refused = (failure: ReadError): Stream.Stream<E> =>
		Stream.make(answer.error(readCallError(failure)))
	const live = (parsed: ParsedRead): Stream.Stream<E> =>
		Stream.unwrap(
			Effect.map(registered(ctx, routing, read, answer, parsed), (registration) =>
				Stream.concat(registration.initial, registration.changes)
			)
		)
	return {
		watch: (input) =>
			Stream.unwrap(
				Effect.match(parse(input), {
					onFailure: (failure) => Stream.concat(refused(failure), Stream.make(answer.end)),
					onSuccess: live
				})
			),
		once: readOnce(callEvents(ctx, answer, parse), answer.settle)
	}
}

/**
 * One call's events of a read, its input parsed by `parse`: a refusal of the input its one error event; else its run
 * (reader/stream.ts readStream), from its reset to its ready or its error.
 */
const callEvents =
	<E>(
		ctx: ServedDbContext,
		events: ShapeEvents<E>,
		parse: (input: unknown) => Effect.Effect<ParsedRead, ReadError>
	) =>
	(input: unknown): Stream.Stream<E> =>
		Stream.unwrap(
			Effect.match(parse(input), {
				onFailure: (failure) => Stream.make(events.error(readCallError(failure))),
				onSuccess: (parsed) => readStream(ctx, parsed.call, events).events
			})
		)

/** A read's once: one call's events (`events`) settled to ready by `settle`, the read's value, or the error that ended them. */
const readOnce =
	<E>(
		events: (input: unknown) => Stream.Stream<E>,
		settle: (events: ReadonlyArray<E>) => ReadState<DecodedRow>
	) =>
	(input: unknown): Effect.Effect<KeyedList<DecodedRow>, ShapeFailure<"list">> =>
		Effect.flatMap(Stream.runCollect(events(input)), (collected) => {
			const state = settle(collected)
			switch (state.kind) {
				case "ready":
					return Effect.succeed(state.value)
				case "failed":
					return Effect.fail(state.error)
				case "opening":
				case "provisional":
					return Effect.die(defect("a read's events end at its ready or its error"))
			}
		})

/**
 * An answered read's calls, at its call's instant alone (an answered(...) or a clocked member's): its answer, one
 * call's events then `end`, which no change follows, since no change wakes it and time passing is no change; and its
 * once, those events settled to ready. It registers no subscription.
 */
const answeredCalls = <E>(
	ctx: ServedDbContext,
	answer: AnsweredAnswer<E>,
	parse: (input: unknown) => Effect.Effect<ParsedRead, ReadError>
): {
	readonly once: (input: unknown) => Effect.Effect<KeyedList<DecodedRow>, ShapeFailure<"list">>
	readonly answer: (input: unknown) => Stream.Stream<E>
} => {
	const events = callEvents(ctx, answer, parse)
	return {
		answer: (input) => Stream.concat(events(input), Stream.make(answer.end)),
		once: readOnce(events, answer.settle)
	}
}

/**
 * A read's calls by how it is called (served/forms.ts ServedReadLive), its input parsed by `parse`: an answered read's
 * once and answer, and no watch (answeredCalls); a live one's once and watch, woken as its routing says (readCalls).
 */
const readMemberCalls = (
	ctx: ServedDbContext,
	read: LoadedRead,
	parse: (input: unknown) => Effect.Effect<ParsedRead, ReadError>
): ServedCalls => {
	const routing = read.live
	switch (routing.kind) {
		case "answered":
			return { shape: "answeredList", ...answeredCalls(ctx, answeredAnswer, parse) }
		case "constant":
		case "routed":
			return { shape: "list", ...readCalls(ctx, routing, read, liveAnswer, parse) }
	}
}

/**
 * A write's once and watch from its one Effect: watch is its outcome, or its error, then end, each sent once the
 * Effect settled.
 */
const writeCalls = (
	write: (input: unknown) => Effect.Effect<WrittenOutcome, ShapeFailure<"write">>
): ServedCalls => ({
	shape: "write",
	once: write,
	watch: (input) =>
		Stream.unwrap(
			Effect.match(write(input), {
				onFailure: (error): Stream.Stream<WriteEvent<WrittenOutcome>> =>
					Stream.make({ kind: "error", error }, { kind: "end" }),
				onSuccess: (outcome): Stream.Stream<WriteEvent<WrittenOutcome>> =>
					Stream.make({ kind: "outcome", outcome }, { kind: "end" })
			})
		)
})

/** The host call of a change's input: its parameters, with its facts where its ChangeSet holds array members, else `{}`. */
const hostCallOf = (
	call: ChangeCall,
	input: CallInput
): Result.Result<HostCall, CallInputRefused | EncodingFailure> => {
	switch (call.kind) {
		case "params":
			return Result.flatMap(noFacts(input.facts), () => call.call(input.params))
		case "facts":
			return call.call(input.facts, input.params)
	}
}

/** A change's host call from a caller's input (hostCallOf). */
const changeInput = (
	change: LoadedChange,
	input: unknown
): Result.Result<HostCall, CallInputRefused | EncodingFailure> =>
	Result.flatMap(callInput(input), (given) => hostCallOf(change.call, given))

/**
 * One application of a loaded ChangeSet for `host`: its inputs readied on the host, a same-key pair the host already
 * refuses answered as invariant-rejected before any SQL, else its one transaction on a session of the Db's pool, whose
 * acquisition's refusal is a TransportFailure at stage acquire.
 */
const applyChange = (
	ctx: ServedDbContext,
	change: LoadedChange,
	host: HostCall
): Effect.Effect<ApplyOutcome<unknown>, ApplyError> =>
	Effect.gen(function* () {
		const frame = dbChangeFrame(ctx, change.entry.program.exclusion)
		const lease = Effect.mapError(ctx.pool.lease, (reason) => new TransportFailure({ reason }))
		const drawn = yield* Effect.mapError(
			drawnCall(change.entry, host, change.reads),
			inputApplyError
		)
		/** The call bound whole, every fact at once, and run in its one transaction on `session`. */
		const whole = (session: Session) =>
			Effect.gen(function* () {
				const inputs = yield* Effect.mapError(
					hostInputs(change.entry, drawn.whole),
					inputApplyError
				)
				if (inputs.kind === "rejected") {
					return applyOutcome.invariantRejected(
						{ kind: "every", laws: [inputs.refused] },
						inputs.witness
					)
				}
				return yield* runWrite(session, frame, change.entry, inputs, change.reads)
			})
		const shared = drawn.shared
		if (shared !== undefined) {
			return yield* Effect.scoped(
				Effect.flatMap(lease, (session) =>
					runWriteShares(session, frame, change.entry, shared, change.reads, whole)
				)
			)
		}
		const inputs = yield* Effect.mapError(hostInputs(change.entry, drawn.whole), inputApplyError)
		if (inputs.kind === "rejected") {
			return applyOutcome.invariantRejected(
				{ kind: "every", laws: [inputs.refused] },
				inputs.witness
			)
		}
		return yield* Effect.scoped(
			Effect.flatMap(lease, (session) =>
				runWrite(session, frame, change.entry, inputs, change.reads)
			)
		)
	})

/**
 * A committed application's outcome, or the refusal it is: accepted, with its counts and read-backs; unchanged, with
 * its read-backs; the laws' rejection, with which laws refused it and the witness; a fact outside the world relation.
 */
const writtenOf = (
	outcome: ApplyOutcome<unknown>
): Result.Result<WrittenOutcome, FailureOf<"outcome">> => {
	switch (outcome.kind) {
		case "accepted":
			return Result.succeed({ kind: "accepted", counts: outcome.counts, reads: outcome.reads })
		case "no-change":
			return Result.succeed({ kind: "unchanged", reads: outcome.reads })
		case "invariant-rejected":
			return Result.fail(
				callError(outcomeReading[outcome.kind], {
					message: "the schema's laws refused the write",
					refused: outcome.refused,
					witness: outcome.witness
				})
			)
		case "outside-world":
			return Result.fail(
				callError(outcomeReading[outcome.kind], {
					message: `a fact the write adds lies outside the world relation ${outcome.relation}`,
					relation: outcome.relation
				})
			)
	}
}

/**
 * A change's one application for a caller's input (changeInput, applyChange), its outcome and its failure as the
 * runtime meets them, before a change member's once reads them as the call's (changeWrite): what a suite of the write
 * runtime itself judges, a TransientFailure's reason and a refused stratum's CompileError among them.
 */
export const changeApplication =
	(ctx: ServedDbContext, change: LoadedChange) =>
	(input: unknown): Effect.Effect<ApplyOutcome<unknown>, ApplyError> =>
		Effect.flatMap(Effect.fromResult(changeInput(change, input)), (host) =>
			applyChange(ctx, change, host)
		)

/** A change member's write: its one application (changeApplication), its outcome or its error. */
const changeWrite =
	(ctx: ServedDbContext, change: LoadedChange) =>
	(input: unknown): Effect.Effect<WrittenOutcome, AnswerFailure<"change">> =>
		Effect.flatMap(
			Effect.mapError(changeApplication(ctx, change)(input), applyCallError),
			(outcome) => Effect.fromResult(writtenOf(outcome))
		)

/** The change a Db runs: the one compiled for the fill contexts its claims hold a fact of. */
export const variantOf = (ctx: ServedDbContext, variants: LoadedVariants): LoadedChange => {
	switch (variants.kind) {
		case "change":
			return variants.change
		case "split":
			return variantOf(ctx, ctx.claims.has(variants.context) ? variants.holding : variants.lacking)
	}
}

/**
 * The parse of a read member's input into its call (ParsedRead), by the member's kind: a read's, a key's and a paged
 * member's; a write member has none. What a suite reads a member's statement and rows through when it runs flights of
 * its own beside the read's (two artifacts in one snapshot, a flight's statements counted).
 */
export const readCallOf = (
	member: LoadedMember
): Option.Option<(input: unknown) => Effect.Effect<ParsedRead, ReadError>> => {
	switch (member.kind) {
		case "read":
			return Option.some(parseRead(member.name, member.read))
		case "key":
			return Option.some(parseKey(member.name, member.read, member.fields))
		case "paged":
			return Option.some(parseWindow(member.name, member.read, member.page))
		case "change":
			return Option.none()
	}
}

/** A loaded member's calls over a Db's context (see the header). */
export const memberCalls = (ctx: ServedDbContext, member: LoadedMember): ServedCalls => {
	switch (member.kind) {
		case "read":
			return readMemberCalls(ctx, member.read, parseRead(member.name, member.read))
		case "key":
			return readMemberCalls(ctx, member.read, parseKey(member.name, member.read, member.fields))
		case "paged":
			return readMemberCalls(ctx, member.read, parseWindow(member.name, member.read, member.page))
		case "change":
			return writeCalls(changeWrite(ctx, variantOf(ctx, member.variants)))
	}
}

/**
 * A served member's explains, by what it is: a read's, a key's and a paged member's estimate and analyze the statement
 * its once sends, of the call its input parses to; a change's estimates every statement its once sends. Each is named by the login's served tables (served/explain.ts).
 */
export type MemberExplains =
	| {
			readonly kind: "read"
			readonly explain: (input: unknown) => Effect.Effect<ReadonlyArray<StatementPlan>, ReadError>
			readonly explainAnalyze: (
				input: unknown
			) => Effect.Effect<ReadonlyArray<ExecutedStatement>, ReadError>
	  }
	| {
			readonly kind: "change"
			readonly explain: (input: unknown) => Effect.Effect<ReadonlyArray<StatementPlan>, ReadError>
	  }

/** A read member's explains, of the call its input parses to by `parse`. */
const readExplains = (
	ctx: ServedDbContext,
	installed: ServedTables,
	parse: (input: unknown) => Effect.Effect<ParsedRead, ReadError>
): MemberExplains => ({
	kind: "read",
	explain: (input) =>
		Effect.flatMap(parse(input), (parsed) => explainRead(ctx, installed, parsed.call)),
	explainAnalyze: (input) =>
		Effect.flatMap(parse(input), (parsed) => explainReadAnalyzed(ctx, installed, parsed.call))
})

/** A loaded member's explains over a Db's context, named by the login's served tables `installed` (MemberExplains). */
export const memberExplains = (
	ctx: ServedDbContext,
	installed: ServedTables,
	member: LoadedMember
): MemberExplains => {
	switch (member.kind) {
		case "read":
			return readExplains(ctx, installed, parseRead(member.name, member.read))
		case "key":
			return readExplains(ctx, installed, parseKey(member.name, member.read, member.fields))
		case "paged":
			return readExplains(ctx, installed, parseWindow(member.name, member.read, member.page))
		case "change": {
			const change = variantOf(ctx, member.variants)
			return {
				kind: "change",
				explain: (input) =>
					Effect.flatMap(
						Effect.mapError(
							Effect.fromResult(changeInput(change, input)),
							(reason) => new ReadFailure({ reason })
						),
						(host) => explainChange(ctx, installed, change, host)
					)
			}
		}
	}
}

/**
 * The members a handle holds of its member's explains, each its own call, failing as the member's once fails: a read's
 * failure read as its CallError (live/call-error.ts readCallError).
 */
const explainsOf = (explains: MemberExplains): object => {
	switch (explains.kind) {
		case "read":
			return {
				explain: (input: unknown) => Effect.mapError(explains.explain(input), readCallError),
				explainAnalyze: (input: unknown) =>
					Effect.mapError(explains.explainAnalyze(input), readCallError)
			}
		case "change":
			return {
				explain: (input: unknown) => Effect.mapError(explains.explain(input), readCallError)
			}
	}
}

/**
 * The calls a handle holds of its member's (memberCalls): its once and watch, an answered read's once alone, whose
 * answer only the HTTP handler sends (types/db MemberCalls).
 */
const handleCalls = (calls: ServedCalls): object => {
	switch (calls.shape) {
		case "list":
		case "write":
			return { once: calls.once, watch: calls.watch }
		case "answeredList":
			return { once: calls.once }
	}
}

/** What a handle holds of one member: its calls (ServedCalls) and its explains (MemberExplains). */
export interface MemberHandleParts {
	readonly calls: ServedCalls
	readonly explains: MemberExplains
}

/**
 * The record of a Db's workload handles over `members`, each member's calls and explains as `partsOf` gives them
 * (handleCalls, explainsOf), under its name: a served Db's (servedHandles), and a Db's over a moved clock, whose clocked
 * reads and changes state the clock's instant at each call (db/moved.ts).
 */
export const handlesOf = (
	members: ReadonlyArray<LoadedMember>,
	partsOf: (member: LoadedMember) => MemberHandleParts
): object => {
	const handles: Record<string, object> = {}
	for (const member of members) {
		const parts = partsOf(member)
		handles[member.name] = Object.freeze({
			...handleCalls(parts.calls),
			...explainsOf(parts.explains)
		})
	}
	return Object.freeze(handles)
}

/** A member's handle parts over a Db's context: its calls (memberCalls) and its explains (memberExplains), named by the
 * login's served tables `installed`. */
export const memberHandleParts = (
	ctx: ServedDbContext,
	installed: ServedTables,
	member: LoadedMember
): MemberHandleParts => ({
	calls: memberCalls(ctx, member),
	explains: memberExplains(ctx, installed, member)
})

/**
 * The record of a Db's workload handles: each member's calls (handleCalls) beside its explains (memberExplains), named
 * by the login's served tables `installed`, under its name.
 */
export const servedHandles = (
	ctx: ServedDbContext,
	members: ReadonlyArray<LoadedMember>,
	installed: ServedTables
): object => handlesOf(members, (member) => memberHandleParts(ctx, installed, member))
