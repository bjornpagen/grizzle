import * as Arr from "effect/Array"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Rec from "effect/Record"
import * as Result from "effect/Result"
import * as Stream from "effect/Stream"
import type { WriteEntry } from "#adapter/apply/compile.ts"
import {
	type ReadBackRun,
	type ReadBackRuns,
	readBackFlight,
	readsRow,
	riddenRows
} from "#adapter/apply/readback.ts"
import {
	type ApplyError,
	CommitUnknown,
	ExecutionFailure,
	serializationRefusal,
	TransportFailure
} from "#adapter/errors/execution.ts"
import {
	familyRowBound,
	type InputTooLarge,
	literalBound,
	messageBound,
	temporaryRefusal,
	UnreadableAnswer
} from "#adapter/errors/failures.ts"
import {
	applyOutcome,
	type Classified,
	classifyServerError,
	type FailureOrigin
} from "#adapter/outcomes/index.ts"
import type { ExecutionInputs, HostParams } from "#adapter/reader/execution.ts"
import { readParams, relationStreams } from "#adapter/reader/params.ts"
import { executionInputs } from "#adapter/reader/relations.ts"
import type { ApplyOutcome } from "#adapter/types/db.ts"
import {
	type BatchStatement,
	bindFrame,
	type FlightFailure,
	type Frame,
	joinFlights,
	preparedStatement,
	runFramed
} from "#adapter/wire/batch.ts"
import type { Session } from "#adapter/wire/session.ts"
import type { WrittenAt } from "#adapter/witness/classify.ts"
import type {
	BoundWrite,
	Chunks,
	ExecutionPart,
	FamilyRowBound,
	FlightStatement,
	FlightWrite,
	MemberFacts,
	RefusedLaw,
	StatementAt,
	Transport,
	Witness
} from "#compiler/plan/change.ts"
import type {
	EncodingFailure,
	LiteralBound,
	MessageBound,
	OutputRows,
	CallerParamDecl,
	ParamValue,
	Row
} from "#compiler/plan/common.ts"
import {
	aboveJudgement,
	bindWrite,
	defect,
	defined,
	encodeFailure,
	factPlace,
	hostJudgement,
	inForce,
	interpretRows,
	slotPlace,
	statementRelations,
	writeBatching
} from "#compiler/plan/runtime.ts"

/** The rows of a statement the flight did not send. */
const noRows: OutputRows = []

/**
 * What a write's failure is classified with: the installation's violation classifier, the layer's, and what a refused
 * statement wrote: its relations and the host's judgement of a native refusal over the facts this application states
 * (runtime/write/witness.ts statementRelations, hostJudgement), or of its own CHECKs where a level above's refused it
 * (aboveJudgement).
 */
interface WitnessContext {
	readonly violation: WriteEntry["witness"]["classify"]
	readonly statement: (at: StatementAt) => WrittenAt
}

/**
 * One application's inputs, ready for its transaction: its bound write, and its read-backs' execution inputs, whose
 * params are the declared parameters by name, ChangeSet.bind values under their private names, Streams collected.
 */
interface BoundInputs extends ExecutionInputs {
	readonly kind: "bound"
	readonly bound: BoundWrite
}

type HostInputs =
	| BoundInputs
	| { readonly kind: "rejected"; readonly refused: RefusedLaw; readonly witness: Witness }

/**
 * How readying an application's inputs fails, before any SQL: a codec refused an input, or an input's texts are past a
 * bound of their transport, which each caller reports in its own channel.
 */
export type InputFailure = EncodingFailure | InputTooLarge

/**
 * A statement's placeholder texts refused (runtime/write/bind.ts BoundWrite chunks): a codec's refusal as itself, a
 * column whose array no string can hold as the InputTooLarge of its bound, and a nested row no insert of its relation
 * can carry as the InputTooLarge naming its family (errors/failures.ts familyRowBound).
 */
export const valuesFailure = (
	failure: EncodingFailure | LiteralBound | MessageBound | FamilyRowBound
): InputFailure => {
	switch (failure._tag) {
		case "EncodingFailure":
			return failure
		case "LiteralBound":
			return literalBound(failure)
		case "MessageBound":
			return messageBound(failure)
		case "FamilyRowBound":
			return familyRowBound(failure)
	}
}

/** An input's refusal as an apply's error: a codec's as itself, any other as the ExecutionFailure whose reason it is. */
export const inputApplyError = (failure: InputFailure): EncodingFailure | ExecutionFailure =>
	failure._tag === "EncodingFailure" ? failure : new ExecutionFailure({ reason: failure })

/** A Stream relation parameter collected on the host, whole: one that fails encodes nothing. */
const collectParam = (
	decl: CallerParamDecl,
	stream: Stream.Stream<unknown, unknown>
): Effect.Effect<ReadonlyArray<unknown>, EncodingFailure> =>
	Stream.runCollect(Stream.mapError(stream, () => encodeFailure("factShape", slotPlace(decl.name))))

/** The values of the declared parameters by name: a ChangeSet.bind value under its private name, else the caller's. */
const declaredParams = (
	declared: ReadonlyArray<CallerParamDecl>,
	params: unknown,
	bindings: ReadonlyMap<string, ParamValue>
): Effect.Effect<HostParams, EncodingFailure> =>
	Effect.suspend(() => {
		/**
		 * The caller's map, read once at the boundary (../reader/params.ts readParams); a map or a value whose reading
		 * throws encodes nothing.
		 */
		const unreadable = encodeFailure("factShape", factPlace)
		const given = readParams(
			Arr.map(declared, (decl) => decl.name),
			params,
			unreadable
		)
		if (Result.isFailure(given)) {
			return Effect.fail(given.failure)
		}
		const out: Record<string, unknown> = { ...given.success }
		for (const [name, value] of bindings) {
			out[name] = value
		}
		/**
		 * A ChangeSet's parameters reach here from the typed Db boundary as a read's do, and its bound values from its
		 * typed bind (../reader/params.ts): each is a ParamValue.
		 */
		const found = relationStreams(declared, out, unreadable)
		if (Result.isFailure(found)) {
			return Effect.fail(found.failure)
		}
		const streams = found.success
		if (streams.length === 0) {
			return Effect.succeed(out)
		}
		return Effect.map(
			Effect.forEach(streams, ({ decl, stream }) =>
				Effect.map(collectParam(decl, stream), (facts) => [decl.name, facts] as const)
			),
			(collected) => ({ ...out, ...Rec.fromEntries(collected) })
		)
	})

/**
 * What one call of a write gives: the caller's parameters, the values ChangeSet.bind closed, under their private names,
 * and the facts of each member slot (write/normalize/normalize.ts MemberFacts).
 */
export interface HostCall {
	readonly params: unknown
	readonly bound: ReadonlyMap<string, ParamValue>
	readonly members: MemberFacts
}

/**
 * What one statement carries on `session`: the longest message its server reads, around the wire's frame (wire/batch.ts
 * bindFrame). An application's writes are cut under it, and so are explain's (served/explain.ts), on the session each
 * leases.
 */
export const sessionTransport = (session: Pick<Session, "messageMaxBytes">): Transport => ({
	...inForce(bindFrame),
	messageBytes: session.messageMaxBytes
})

/** The first half of an application: everything before any SQL (see the header). */
export const hostInputs = (
	entry: WriteEntry,
	call: HostCall
): Effect.Effect<HostInputs, InputFailure> =>
	Effect.gen(function* () {
		const host = yield* declaredParams(entry.program.params, call.params, call.bound)
		/**
		 * `host` holds every bound value under its private name with its Stream collected, so the statements bind the
		 * same values the read-backs read; the raw bindings would hand them an uncollected Stream.
		 */
		const bound = bindWrite(entry.program, {
			members: call.members,
			params: host,
			transport: inForce(bindFrame)
		})
		if (!bound.ok) {
			return yield* Effect.fail(valuesFailure(bound.error))
		}
		if (bound.value.kind === "invariant-rejected") {
			return {
				kind: "rejected",
				refused: entry.witness.laws.hostRefused({
					kind: "key",
					relation: bound.value.relation,
					law: bound.value.law,
					described: bound.value.described
				}),
				witness: bound.value.witness
			} as const
		}
		if (bound.value.kind === "generated-rejected") {
			const { law, witness } = bound.value.rejection
			return {
				kind: "rejected",
				refused: entry.witness.laws.hostRefused({
					kind: "generated",
					relation: law.relation,
					field: law.field
				}),
				witness
			} as const
		}
		const ready = executionInputs(entry.codecs, host)
		if (Result.isFailure(ready)) {
			return yield* Effect.fail(ready.failure)
		}
		return { kind: "bound", bound: bound.value, ...ready.success } as const
	})

const outcomeOf = <R>(classified: Classified): Effect.Effect<ApplyOutcome<R>, ApplyError> => {
	switch (classified.kind) {
		case "rejected":
			return Effect.succeed(applyOutcome.invariantRejected(classified.refused, classified.witness))
		case "outside":
			return Effect.succeed(applyOutcome.outsideWorld(classified.relation))
		case "failed":
			return Effect.fail(classified.error)
		case "defect":
			return Effect.die(classified.defect)
	}
}

/**
 * A statement a write sends, by its index in its flight: the `chunk`th execution of an artifact statement (BoundWrite
 * chunks), its `part` what the execution is: the statement itself, or one of its staged carriers' creation or fills.
 */
interface SentStatement {
	readonly statement: FlightStatement
	readonly chunk: number
	readonly part: ExecutionPart
}

/**
 * The origin of the write's statement at `index`: the statement sent there, or a read-back, whose statements follow
 * every sent one.
 */
const statementOrigin = (sent: ReadonlyArray<SentStatement>, index: number): FailureOrigin => {
	const one = sent[index]
	return one === undefined
		? { kind: "readBack", index }
		: { kind: "statement", index, step: one.statement.step, chunk: one.chunk }
}

/**
 * What a write's failed flight means: a refused statement, or a refusal at COMMIT, is classified at its origin; the
 * fence's refusal is StaleSnapshot; a refused prologue's deadlock or serialization failure, which a fenced write's lock
 * meets where a READ COMMITTED check holds one of its tables and waits for another it locked first, is the
 * TransientFailure a statement's is (errors/execution.ts serializationRefusal); any other refused prologue, which only
 * a login that lost the role's membership or the grant of a fenced table meets, is the server's.
 */
const flightFailure = <R>(
	failure: FlightFailure,
	sent: ReadonlyArray<SentStatement>,
	context: WitnessContext
): Effect.Effect<ApplyOutcome<R>, ApplyError> => {
	switch (failure._tag) {
		case "BatchRefused": {
			const at = sent[failure.index]
			const temporary = at === undefined ? undefined : temporaryRefusal(at.part, failure.failure)
			return temporary === undefined
				? outcomeOf(
						classifyServerError(failure.failure, {
							...context,
							origin: statementOrigin(sent, failure.index)
						})
					)
				: Effect.fail(new ExecutionFailure({ reason: temporary }))
		}
		case "CommitRefused":
			return outcomeOf(
				classifyServerError(failure.failure, { ...context, origin: { kind: "commit" } })
			)
		case "CommitLost":
			return Effect.fail(new CommitUnknown())
		case "ConnectionLost":
		case "DriverFailure":
			return Effect.fail(new TransportFailure({ reason: failure }))
		case "UnreadableAnswer":
		case "InputTooLarge":
			return Effect.fail(new ExecutionFailure({ reason: failure }))
		case "PrologueRefused":
			return Effect.fail(
				serializationRefusal(failure.failure) ?? new ExecutionFailure({ reason: failure.failure })
			)
		case "StaleSnapshot":
			return Effect.fail(failure)
	}
}

/** An artifact's read-backs, and the ChangeSet's reads decoder bound to their Row's layout. */
export interface BoundReads<R> {
	readonly runs: ReadBackRuns
	readonly read: (row: Row) => R
}

/**
 * A write's statements as `chunks` executes them under `transport`, in the order they are sent, each by the statement
 * it executes (SentStatement): one execution of most, a staged statement's carriers' creations and fills before it, and
 * one of a family step per statement of its kind its family's plan cuts, each the step's one text over
 * its own rows' arrays. The read-backs' follow every write.
 */
const writeStatements = (
	flight: FlightWrite,
	inputs: BoundInputs,
	chunks: Chunks,
	transportOf: (statement: FlightStatement) => Transport
): Result.Result<
	{
		readonly sent: ReadonlyArray<SentStatement>
		readonly statements: ReadonlyArray<BatchStatement>
		/** Whether some statement's facts were cut into batched executions (bind.ts batchedExecutions). */
		readonly cut: boolean
	},
	InputFailure
> => {
	const skip = inputs.bound.skip
	const sent: Array<SentStatement> = []
	const statements: Array<BatchStatement> = []
	let cut = false
	for (const s of flight.statements) {
		if (skip.has(s.index)) {
			continue
		}
		const transport = transportOf(s)
		const executions = chunks(s, transport)
		if (!executions.ok) {
			return Result.fail(valuesFailure(executions.error))
		}
		cut ||=
			transport.batching.kind === "bounded" &&
			Arr.filter(executions.value, (execution) => execution.part === "statement").length > 1
		for (const [chunk, execution] of executions.value.entries()) {
			sent.push({ statement: s, chunk, part: execution.part })
			statements.push(preparedStatement(execution.text, execution.params))
		}
	}
	return Result.succeed({ sent, statements, cut })
}

/** The second half of an application: its statements in one transaction of `frame` on `session` (see the header). */
export const runWrite = <R>(
	session: Session,
	frame: Frame,
	entry: WriteEntry,
	inputs: BoundInputs,
	reads: BoundReads<R>
): Effect.Effect<ApplyOutcome<R>, ApplyError> =>
	Effect.gen(function* () {
		const flight = entry.program
		/** The rows the ChangeSet states as the write statements fill them, which a refusal of one of them judges. */
		const stated = inputs.bound.stated
		const context: WitnessContext = {
			violation: entry.witness.classify,
			statement: (at) => ({
				relations: statementRelations(flight.prepared.witness, at),
				judge: (refuser) => hostJudgement(flight.prepared.witness, stated, at, refuser),
				above: (owner) => aboveJudgement(flight.prepared.witness, stated, at, owner)
			})
		}
		/** The read-backs sent behind the writes; a riding one's statements are parts of the write statement it rides. */
		const sentBacks = Arr.flatMap(reads.runs.runs, (run) => (run.kind === "sent" ? [run] : []))
		const readBackFlights = yield* Effect.mapError(
			Effect.forEach(sentBacks, (run) => readBackFlight(run, inputs)),
			inputApplyError
		)
		const backs = joinFlights(readBackFlights)
		const transport = sessionTransport(session)
		const batched: Transport = { ...transport, batching: writeBatching }
		/** The statements a read-back rides, whose rows it reads in the one execution that makes them. */
		const ridingOn = new Set(
			Arr.flatMap(reads.runs.runs, (run) => (run.kind === "riding" ? [run.riding.statement] : []))
		)
		/**
		 * The write's flight, its statements of member inserts cut into executions within PostgreSQL's default work_mem where
		 * `cutting` (bind.ts batchedExecutions), every other statement and every ridden one whole.
		 */
		const attempt = (cutting: boolean) =>
			Effect.gen(function* () {
				const writes = writeStatements(flight, inputs, inputs.bound.chunks, (s) =>
					cutting && !ridingOn.has(s.index) ? batched : transport
				)
				if (Result.isFailure(writes)) {
					return yield* Effect.fail(inputApplyError(writes.failure))
				}
				const ran = yield* Effect.result(
					runFramed(session, frame, [...writes.success.statements, ...backs.statements])
				)
				return { writes: writes.success, ran }
			})
		/**
		 * A batched flight a statement refused is sent again whole, in a transaction of its own, the first having changed
		 * nothing: a refusal judges the call's facts all at once, its witness the least of every fact's (protocol.ts),
		 * which the executions cut alone would choose among their own facts. A refusal at COMMIT reads the same deltas
		 * either way, and stands.
		 */
		const first = yield* attempt(true)
		const { writes, ran } =
			first.writes.cut && Result.isFailure(first.ran) && first.ran.failure._tag === "BatchRefused"
				? yield* attempt(false)
				: first
		/** Every statement the write sends but the read-backs, by its index in its flight. */
		const sent = writes.sent
		/** How many statements precede the read-backs. */
		const written = sent.length
		if (Result.isFailure(ran)) {
			return yield* flightFailure<R>(ran.failure, sent, context)
		}
		const outcomes = ran.success
		/**
		 * The rows of each sent write statement, by its position in the artifact, its executions' in the order they
		 * ran; a statement not sent answered none.
		 */
		const raws = new Map<number, OutputRows>()
		for (const [one, outcome] of Arr.zip(sent, outcomes)) {
			const s = one.statement
			const before = raws.get(s.index)
			raws.set(s.index, before === undefined ? outcome.rows : [...before, ...outcome.rows])
		}
		/**
		 * The read-backs' Rows: a sent one's read from the statements after the written ones, a riding one's from the rows
		 * of the write statement it rides. A read-back whose answer repeats a row is UnreadableAnswer at its index in the
		 * write's flight, after the transaction committed.
		 */
		const sentRows = yield* Effect.mapError(
			backs.read(outcomes.slice(written)),
			(unreadable) =>
				new ExecutionFailure({
					reason: new UnreadableAnswer({ index: written + unreadable.index, fate: unreadable.fate })
				})
		)
		const bySent = new Map(Arr.zip(sentBacks, sentRows))
		const deliveredOf = (run: ReadBackRun): Result.Result<ReadonlyArray<Row>, UnreadableAnswer> => {
			if (run.kind === "sent") {
				return Result.succeed(defined(bySent.get(run), `the sent read-back ${run.name}'s Rows`))
			}
			const ridden = run.riding.statement
			const at = Option.getOrThrowWith(
				Arr.findLastIndex(sent, (one) => one.statement.index === ridden),
				() => defect(`the write statement ${ridden} the read-back ${run.name} rides`)
			)
			return riddenRows(
				run,
				defined(raws.get(ridden), `the rows of the statement ${run.name} rides`),
				inputs.params,
				at
			)
		}
		const delivered = yield* Effect.mapError(
			Effect.fromResult(Result.all(Arr.map(reads.runs.runs, deliveredOf))),
			(reason) => new ExecutionFailure({ reason })
		)
		const changes = interpretRows(flight.outcome, flight.statements, (i) => raws.get(i) ?? noRows)
		return applyOutcome.committed(changes.counts, reads.read(readsRow(delivered)))
	})
