import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import * as Stream from "effect/Stream"
import { type HostCall, hostInputs, inputApplyError, runWrite } from "#adapter/apply/run.ts"
import { dbChangeFrame, type ServedDbContext } from "#adapter/db/context.ts"
import { type CallInput, callInput, noFacts, windowedInput } from "#adapter/db/input.ts"
import {
	type ApplyError,
	type ReadError,
	ReadFailure,
	TransportFailure
} from "#adapter/errors/execution.ts"
import type { CallInputRefused } from "#adapter/errors/failures.ts"
import { callErrorOf } from "#adapter/live/call-error.ts"
import { routeKeys } from "#adapter/live/router.ts"
import type { LiveAnswer } from "#adapter/live/subscriptions.ts"
import { applyOutcome } from "#adapter/outcomes/index.ts"
import { windowIntake, windowStatement } from "#adapter/page/execute.ts"
import { windowCall } from "#adapter/page/window.ts"
import type { ExecutionInputs } from "#adapter/reader/execution.ts"
import {
	hostParams,
	readKeyValues,
	readParams,
	unreadableArguments
} from "#adapter/reader/params.ts"
import { executionInputs } from "#adapter/reader/relations.ts"
import { programStatement, readIntake } from "#adapter/reader/run.ts"
import {
	type DecodedRow,
	listEvents,
	type ReadCall,
	readStream,
	type ShapeEvents,
	setEvents
} from "#adapter/reader/stream.ts"
import { runRefresh } from "#adapter/refresh/run.ts"
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
import {
	type CallError,
	callError,
	diffList,
	diffSet,
	fold,
	type Keyed,
	type KeyedList,
	type KeyedSet,
	type ListEvent,
	opening,
	type ReadShape,
	type Refreshed,
	type SetEvent,
	type WriteEvent,
	type WriteOutcome
} from "#compiler/live/index.ts"
import type { EncodingFailure } from "#compiler/plan/common.ts"
import { defect, encodeFailure, factPlace } from "#compiler/plan/runtime.ts"
import type { ServedTables } from "#compiler/plan/serve.ts"

/**
 * A served Db's workload handles: each member its layer loaded for the Db's role (served/load.ts LoadedMember), run on
 * the Db's pool, under its name. Every member offers exactly `once(input)` and `watch(input)` (ServedCalls), its input
 * read once at this boundary (db/input.ts), and a read or change member its explains, which plan exactly the
 * statements its once sends. A handle lives as long as the layer that loaded its program.
 *
 * - A read, a key and a paged member read: `watch` is the read's events (reader/stream.ts readStream), reset, an
 *   upsert per row as it decodes, provisional, then ready after its COMMIT; `once` is those events folded to ready
 *   (live/fold.ts), the read's value, or the error that ended them. A key member's parameters are its key's values,
 *   read off its input's params by the key's fields; a paged member's window selects its template and its anchor.
 * - A change member writes: `once` is its outcome after its COMMIT, accepted with its counts and read-backs or
 *   unchanged, and every refusal is its CallError, the laws' rejection and a fact outside the world included; `watch`
 *   is that outcome, or that error, then end. Its facts are its array members' where its ChangeSet holds some, else `{}`.
 * - A refresh member writes too: its outcome is `refreshed`, after its one transaction's COMMIT (refresh/run.ts).
 *
 * Every failure is classified once (live/call-error.ts callErrorOf), so an answer's error event and once's error are
 * one CallError.
 *
 * A member's calls over JavaScript values, by the shape of its answer, so a call's events and its value are typed by
 * its shape: what a typed handle views (types/db MemberHandle) and what the HTTP handler calls by name.
 */
export type ServedCalls =
	| {
			readonly shape: "set"
			readonly once: (input: unknown) => Effect.Effect<KeyedSet<DecodedRow>, CallError>
			readonly watch: (input: unknown) => Stream.Stream<SetEvent<DecodedRow>>
	  }
	| {
			readonly shape: "list"
			readonly once: (input: unknown) => Effect.Effect<KeyedList<DecodedRow>, CallError>
			readonly watch: (input: unknown) => Stream.Stream<ListEvent<DecodedRow>>
	  }
	| {
			readonly shape: "write"
			readonly once: (input: unknown) => Effect.Effect<WrittenOutcome, CallError>
			readonly watch: (input: unknown) => Stream.Stream<WriteEvent<WrittenOutcome>>
	  }

/** What a write member's once answers: a ChangeSet's outcome over its read-backs, or a refresh's. */
export type WrittenOutcome = WriteOutcome<unknown> | Refreshed

/**
 * A read member's call parsed from its input: its read call, and the execution inputs its statement binds, which its
 * subscription routes by.
 */
export interface ParsedRead {
	readonly call: ReadCall
	readonly inputs: ExecutionInputs
}

/** A read's execution inputs from the caller's parameters (reader/params.ts hostParams, reader/relations.ts). */
const readInputs = (read: LoadedRead, params: unknown): Effect.Effect<ExecutionInputs, ReadError> =>
	Effect.flatMap(hostParams(read.params, params), (values) =>
		Effect.mapError(
			Effect.fromResult(executionInputs(read.codecs, values)),
			(reason) => new ReadFailure({ reason })
		)
	)

/** A read member's call over `params`, each call's rows read by its program's intake (reader/run.ts readIntake). */
const programCall = (read: LoadedRead, params: unknown): Effect.Effect<ParsedRead, ReadError> =>
	Effect.map(readInputs(read, params), (inputs) => ({
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

/** A read member's call (programCall) from its input. */
const parseRead =
	(read: LoadedRead) =>
	(input: unknown): Effect.Effect<ParsedRead, ReadError> =>
		Effect.flatMap(readInput(input), (given) => programCall(read, given.params))

/** A key member's call from its input: its parameters are its key's values, read off its params by the key's fields. */
const parseKey =
	(read: LoadedRead, fields: ReadonlyArray<string>) =>
	(input: unknown): Effect.Effect<ParsedRead, ReadError> =>
		Effect.flatMap(readInput(input), (given) =>
			Effect.flatMap(
				Effect.fromResult(readKeyValues(fields, given.params, unreadableArguments())),
				(values) => programCall(read, values)
			)
		)

/**
 * A paged member's call from its input: its window read against the page's comparators (page/window.ts), its template
 * the window's anchor selects, its rows read once its statement has answered (page/execute.ts windowIntake) and decoded
 * by the decoder bound to that template.
 */
const parseWindow =
	(read: LoadedRead, page: LoadedPage) =>
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
			const inputs = yield* readInputs(read, given.params)
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
 * How a read of shape S answers, beside how its events are made (reader/stream.ts ShapeEvents): its `end`, its events
 * folded from before its reset (live/fold.ts), which once settles, and the least change between two of its values, which
 * a live read sends after each re-run (live/subscriptions.ts LiveAnswer).
 */
interface ShapeAnswer<S extends ReadShape, E>
	extends ShapeEvents<E>, LiveAnswer<S, DecodedRow, E> {}

/** A set read's answer. */
const setAnswer: ShapeAnswer<"set", SetEvent<DecodedRow>> = {
	...setEvents,
	end: { kind: "end" },
	settle: (events) => fold(opening<"set", DecodedRow>("set"), events),
	diff: diffSet
}

/** An ordered read's answer. */
const listAnswer: ShapeAnswer<"list", ListEvent<DecodedRow>> = {
	...listEvents,
	end: { kind: "end" },
	settle: (events) => fold(opening<"list", DecodedRow>("list"), events),
	diff: diffList
}

/**
 * A read's calls of shape S (see the header): its input parsed by `parse`, a refusal of which is its one error event
 * then `end`; once its events settled to ready, the read's value, or the error that ended them. Its watch is live
 * (live/subscriptions.ts): registered on the layer's registry under the routing keys its served footprint binds with
 * the call's inputs (live/router.ts routeKeys), before its first run, then that run's events, then each change of its
 * value after its ready, until the Db's token expires, its source is lost, a run fails, or its consumer stops.
 */
const readCalls = <S extends ReadShape, E>(
	ctx: ServedDbContext,
	read: LoadedRead,
	answer: ShapeAnswer<S, E>,
	parse: (input: unknown) => Effect.Effect<ParsedRead, ReadError>
): {
	readonly once: (input: unknown) => Effect.Effect<Keyed<S, DecodedRow>, CallError>
	readonly watch: (input: unknown) => Stream.Stream<E>
} => {
	const refused = (failure: ReadError): Stream.Stream<E> =>
		Stream.make(answer.error(callErrorOf(failure)))
	const events = (input: unknown): Stream.Stream<E> =>
		Stream.unwrap(
			Effect.match(parse(input), {
				onFailure: refused,
				onSuccess: (parsed) => readStream(ctx, parsed.call, answer)
			})
		)
	const live = (parsed: ParsedRead): Stream.Stream<E> =>
		Stream.unwrap(
			Effect.map(
				ctx.subscriptions.register({
					read: readStream(ctx, parsed.call, answer),
					answer,
					keys: routeKeys(read.footprint, read.codecs, parsed.inputs),
					expiry: ctx.expiry
				}),
				(registered) => Stream.concat(registered.initial, registered.changes)
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
		once: (input) =>
			Effect.flatMap(Stream.runCollect(events(input)), (collected) => {
				const state = answer.settle(collected)
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
	}
}

/** A read's calls by the shape of its key (served/forms.ts ServedKey), its input parsed by `parse`. */
const readMemberCalls = (
	ctx: ServedDbContext,
	read: LoadedRead,
	parse: (input: unknown) => Effect.Effect<ParsedRead, ReadError>
): ServedCalls => {
	switch (read.key.kind) {
		case "set":
			return { shape: "set", ...readCalls(ctx, read, setAnswer, parse) }
		case "list":
			return { shape: "list", ...readCalls(ctx, read, listAnswer, parse) }
	}
}

/**
 * A write's once and watch from its one Effect: watch is its outcome, or its error, then end, each sent once the
 * Effect settled.
 */
const writeCalls = (
	write: (input: unknown) => Effect.Effect<WrittenOutcome, CallError>
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
			return Result.map(noFacts(input.facts), () => call.call(input.params))
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
		const inputs = yield* Effect.mapError(hostInputs(change.entry, host), inputApplyError)
		if (inputs.kind === "rejected") {
			return applyOutcome.invariantRejected(
				{ kind: "every", laws: [inputs.refused] },
				inputs.witness
			)
		}
		return yield* Effect.scoped(
			Effect.flatMap(
				Effect.mapError(ctx.pool.lease, (reason) => new TransportFailure({ reason })),
				(session) => runWrite(session, dbChangeFrame(ctx), change.entry, inputs, change.reads)
			)
		)
	})

/**
 * A committed application's outcome, or the refusal it is: accepted, with its counts and read-backs; unchanged, with
 * its read-backs; the laws' rejection, with which laws refused it and the witness; a fact outside the world relation.
 */
const writtenOf = (outcome: ApplyOutcome<unknown>): Result.Result<WrittenOutcome, CallError> => {
	switch (outcome.kind) {
		case "accepted":
			return Result.succeed({ kind: "accepted", counts: outcome.counts, reads: outcome.reads })
		case "no-change":
			return Result.succeed({ kind: "unchanged", reads: outcome.reads })
		case "invariant-rejected":
			return Result.fail(
				callError("refused", {
					message: "the schema's laws refused the write",
					refused: outcome.refused,
					witness: outcome.witness
				})
			)
		case "outside-world":
			return Result.fail(
				callError("outsideWorld", {
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
	(input: unknown): Effect.Effect<WrittenOutcome, CallError> =>
		Effect.flatMap(Effect.mapError(changeApplication(ctx, change)(input), callErrorOf), (outcome) =>
			Effect.fromResult(writtenOf(outcome))
		)

const refreshed: Refreshed = { kind: "refreshed" }

/** A refresh member's input: no parameters and no facts. */
const refreshInput = (input: unknown): Result.Result<void, CallInputRefused | EncodingFailure> =>
	Result.flatMap(callInput(input), (given) =>
		Result.flatMap(readParams([], given.params, encodeFailure("factShape", factPlace)), () =>
			noFacts(given.facts)
		)
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
			return Option.some(parseRead(member.read))
		case "key":
			return Option.some(parseKey(member.read, member.fields))
		case "paged":
			return Option.some(parseWindow(member.read, member.page))
		case "change":
		case "refresh":
			return Option.none()
	}
}

/** A loaded member's calls over a Db's context (see the header). */
export const memberCalls = (ctx: ServedDbContext, member: LoadedMember): ServedCalls => {
	switch (member.kind) {
		case "read":
			return readMemberCalls(ctx, member.read, parseRead(member.read))
		case "key":
			return readMemberCalls(ctx, member.read, parseKey(member.read, member.fields))
		case "paged":
			return readMemberCalls(ctx, member.read, parseWindow(member.read, member.page))
		case "change":
			return writeCalls(changeWrite(ctx, variantOf(ctx, member.variants)))
		case "refresh": {
			const refresh = member.refresh
			return writeCalls((input) =>
				Effect.mapError(
					Effect.as(
						Effect.flatMap(Effect.fromResult(refreshInput(input)), () => runRefresh(ctx, refresh)),
						refreshed
					),
					callErrorOf
				)
			)
		}
	}
}

/**
 * A served member's explains, by what it is: a read's, a key's and a paged member's estimate and analyze the statement
 * its once sends, of the call its input parses to; a change's estimates every statement its once sends; a refresh,
 * whose REFRESH has no plan, has none. Each is named by the login's served tables (served/explain.ts).
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
	| { readonly kind: "refresh" }

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
			return readExplains(ctx, installed, parseRead(member.read))
		case "key":
			return readExplains(ctx, installed, parseKey(member.read, member.fields))
		case "paged":
			return readExplains(ctx, installed, parseWindow(member.read, member.page))
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
						(host) => explainChange(ctx, installed, member.name, change, host)
					)
			}
		}
		case "refresh":
			return { kind: "refresh" }
	}
}

/** The members a handle holds of its member's explains, each its own call. */
const explainsOf = (explains: MemberExplains): object => {
	switch (explains.kind) {
		case "read":
			return { explain: explains.explain, explainAnalyze: explains.explainAnalyze }
		case "change":
			return { explain: explains.explain }
		case "refresh":
			return {}
	}
}

/**
 * The record of a Db's workload handles: each member's once and watch (memberCalls) beside its explains
 * (memberExplains), named by the login's served tables `installed`, under its name.
 */
export const servedHandles = (
	ctx: ServedDbContext,
	members: ReadonlyArray<LoadedMember>,
	installed: ServedTables
): object => {
	const handles: Record<string, object> = {}
	for (const member of members) {
		const calls = memberCalls(ctx, member)
		handles[member.name] = Object.freeze({
			once: calls.once,
			watch: calls.watch,
			...explainsOf(memberExplains(ctx, installed, member))
		})
	}
	return Object.freeze(handles)
}
