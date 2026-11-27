import * as Arr from "effect/Array"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Order from "effect/Order"
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
import { drawShares, sendsAlone } from "#adapter/apply/shares.ts"
import { standUp } from "#adapter/apply/stand-up.ts"
import {
	type ApplyError,
	CommitUnknown,
	ExecutionFailure,
	serializationRefusal,
	TransportFailure
} from "#adapter/errors/execution.ts"
import {
	type CommitRefused,
	ConnectionLost,
	type InputTooLarge,
	type ServerError,
	literalBound,
	messageBound,
	UnreadableAnswer
} from "#adapter/errors/failures.ts"
import {
	applyOutcome,
	type Classified,
	classifyServerError,
	type FailureOrigin
} from "#adapter/outcomes/index.ts"
import type { ExecutionInputs, HostParams } from "#adapter/reader/execution.ts"
import { type ParamValues, relationStreams } from "#adapter/reader/params.ts"
import { executionInputs } from "#adapter/reader/relations.ts"
import type { ApplyOutcome } from "#adapter/types/db.ts"
import {
	type BatchStatement,
	bindFrame,
	type FlightFailure,
	type Frame,
	type BatchOutcome,
	type FlightBatch,
	joinFlights,
	oneShotStatement,
	preparedStatement,
	runFramed,
	runFramedFlights
} from "#adapter/wire/batch.ts"
import type { Session } from "#adapter/wire/session.ts"
import type { WrittenAt } from "#adapter/witness/classify.ts"
import type { Unmatched } from "#adapter/witness/index.ts"
import type {
	BoundWrite,
	Chunks,
	ExecutionPart,
	FlightStatement,
	FlightWrite,
	MemberFacts,
	RefusedLaw,
	RelationCounts,
	StatedRows,
	StatementAt,
	Transport,
	Witness
} from "#compiler/plan/change.ts"
import type {
	EncodingFailure,
	LiteralBound,
	MessageBound,
	OutputRows,
	OutputText,
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
 * A statement's placeholder texts refused (runtime/write/bind.ts BoundWrite chunks): a codec's refusal as itself, and a
 * column whose array no string can hold as the InputTooLarge of its bound.
 */
export const valuesFailure = (
	failure: EncodingFailure | LiteralBound | MessageBound
): InputFailure => {
	switch (failure._tag) {
		case "EncodingFailure":
			return failure
		case "LiteralBound":
			return literalBound(failure)
		case "MessageBound":
			return messageBound(failure)
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

/**
 * The values of the declared parameters by name: a ChangeSet.bind value under its private name, else the caller's,
 * which the call's boundary read (HostCall `params`).
 */
const declaredParams = (
	declared: ReadonlyArray<CallerParamDecl>,
	params: ParamValues,
	bindings: ReadonlyMap<string, ParamValue>
): Effect.Effect<HostParams, EncodingFailure> =>
	Effect.suspend(() => {
		const out: Record<string, unknown> = { ...params }
		for (const [name, value] of bindings) {
			out[name] = value
		}
		/**
		 * A ChangeSet's parameters reach here from the typed Db boundary as a read's do, and its bound values from its
		 * typed bind (../reader/params.ts): each is a ParamValue.
		 */
		const found = relationStreams(declared, out)
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
 * What one call of a write gives: the caller's parameters, read at the call's boundary by its program's declared names
 * (../reader/params.ts readParams), the values ChangeSet.bind closed, under their private names, and the facts of each
 * member slot (write/normalize/normalize.ts MemberFacts).
 */
export interface HostCall {
	readonly params: ParamValues
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

/** The outcome a classified failure means. */
const outcomeOf = <R>(classified: Classified): Effect.Effect<ApplyOutcome<R>, ApplyError> => {
	switch (classified.kind) {
		case "rejected":
			return Effect.succeed(applyOutcome.invariantRejected(classified.refused, classified.witness))
		case "outside":
			return Effect.succeed(applyOutcome.outsideWorld(classified.relation))
		case "failed":
			return Effect.fail(classified.error)
		case "defect":
			return Effect.sync(() => defect(classified.what))
	}
}

/**
 * A statement a write sends, by its index in its flight: the `chunk`th execution of an artifact statement (BoundWrite
 * chunks), its `part` what the execution is: the statement itself, or one of its staged carriers' emptying or fills.
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
 * What a write's failed stand-up means (stand-up.ts): the fence's refusal as StaleSnapshot; SERIALIZABLE's refusal as the
 * TransientFailure a statement's is; a lost connection, at COMMIT too, as a TransportFailure, since the write's own
 * statements were never sent; any other refusal as the server's.
 */
const standUpFailure = (failure: FlightFailure): ApplyError => {
	switch (failure._tag) {
		case "BatchRefused":
		case "CommitRefused":
			return (
				serializationRefusal(failure.failure) ?? new ExecutionFailure({ reason: failure.failure })
			)
		case "PrologueRefused":
			return (
				serializationRefusal(failure.failure) ?? new ExecutionFailure({ reason: failure.failure })
			)
		case "CommitLost":
			return new TransportFailure({
				reason: new ConnectionLost({ operation: "commit", ended: { by: "transport" } })
			})
		case "ConnectionLost":
		case "DriverFailure":
			return new TransportFailure({ reason: failure })
		case "UnreadableAnswer":
		case "InputTooLarge":
			return new ExecutionFailure({ reason: failure })
		case "StaleSnapshot":
			return failure
	}
}

/**
 * What a write's failed flight means, but a refusal at COMMIT (`commitRefusal`): a refused statement is classified at
 * its origin; the fence's refusal is StaleSnapshot; a refused prologue's deadlock or serialization failure, which a fenced write's lock
 * meets where a READ COMMITTED check holds one of its tables and waits for another it locked first, is the
 * TransientFailure a statement's is (errors/execution.ts serializationRefusal); any other refused prologue, which only
 * a login that lost the role's membership or the grant of a fenced table meets, is the server's.
 */
const flightFailure = <R>(
	failure: Exclude<FlightFailure, CommitRefused>,
	sent: ReadonlyArray<SentStatement>,
	context: WitnessContext
): Effect.Effect<ApplyOutcome<R>, ApplyError> => {
	switch (failure._tag) {
		case "BatchRefused":
			return outcomeOf(
				classifyServerError(failure.failure, {
					...context,
					origin: statementOrigin(sent, failure.index)
				})
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

/**
 * What a refusal at COMMIT means: classified at COMMIT, a law refused there whose deferred foreign key leaves a row
 * unmatched has the witness its `diagnosis` reads (`unmatchedWitness`), where the server reports none.
 */
const commitRefusal = <R>(
	failure: ServerError,
	context: WitnessContext,
	diagnosis: Effect.Effect<Witness, ApplyError> | undefined
): Effect.Effect<ApplyOutcome<R>, ApplyError> => {
	const classified = classifyServerError(failure, { ...context, origin: { kind: "commit" } })
	return classified.kind === "rejected" && diagnosis !== undefined
		? Effect.flatMap(diagnosis, (witness) => outcomeOf<R>({ ...classified, witness }))
		: outcomeOf<R>(classified)
}

/**
 * The witness of a COMMIT a deferred foreign key refused, read by the diagnosis flight: the write's statements sent
 * again, then the key's witness query (write/unmatched.ts), in a transaction of `frame` that ends ROLLBACK, so the
 * query reads the state the write leaves and nothing of it lasts. It is a write flight like the call's: the same
 * prologue, its admission and its fence, and the same statements, which take the same borrows in the same order, so
 * at READ COMMITTED it reads the state those borrows guarantee and waits on no writer in a cycle; its rollback undoes
 * every row it wrote, every stamp it drew among them, and publishes nothing, since a transaction that rolls back reaches
 * no live source. The one row the query answers is the key the refusal met. Where it answers none, or a statement or
 * the fence refuses the flight, the state it met is not the first flight's: another transaction's commit changed it in
 * between, and the witness is `unreproduced`, never a key guessed. A flight that loses its connection or answers what
 * grizzle cannot read fails the call as the write's own flight would (`flightFailure`), the refusal unreported to no
 * one. The success path sends none of it: a write that commits pays nothing for its witness, and the foreign key stays
 * its law's one check. Only a COMMIT is diagnosed: a statement judges its own refusals, a member joining a stored
 * closed owner's group among them (write/family/additions.ts metRefusal).
 */
const unmatchedWitness = (
	session: Session,
	frame: Frame,
	statements: ReadonlyArray<BatchStatement>,
	unmatched: Unmatched
): Effect.Effect<Witness, ApplyError> =>
	Effect.flatMap(
		Effect.result(
			runFramed(session, { ...frame, end: "ROLLBACK" }, [
				...statements,
				oneShotStatement(unmatched.sql, [])
			])
		),
		(ran): Effect.Effect<Witness, ApplyError> =>
			Result.isSuccess(ran)
				? Effect.succeed(unmatchedKeyOf(unmatched, ran.success))
				: diagnosisFailure(ran.failure)
	)

/** The witness a diagnosis's outcomes name: its last statement's, the witness query's, one row, or none. */
const unmatchedKeyOf = (unmatched: Unmatched, outcomes: ReadonlyArray<BatchOutcome>): Witness => {
	const detail = outcomes.at(-1)?.rows[0]?.[0]
	return detail === undefined ? unreproduced : unmatchedKey(unmatched, detail)
}

/**
 * What a diagnosis's failure makes of its witness (unmatchedWitness): a refusal of its flight, its fence's or a
 * statement's, met a state another commit changed, `unreproduced`; a lost connection or an answer grizzle cannot read
 * fails the call as the write's own flight would.
 */
const diagnosisFailure = (failure: FlightFailure): Effect.Effect<Witness, ApplyError> => {
	switch (failure._tag) {
		case "BatchRefused":
		case "PrologueRefused":
		case "StaleSnapshot":
			return Effect.succeed(unreproduced)
		case "ConnectionLost":
		case "DriverFailure":
			return Effect.fail(new TransportFailure({ reason: failure }))
		case "UnreadableAnswer":
		case "InputTooLarge":
			return Effect.fail(new ExecutionFailure({ reason: failure }))
		case "CommitRefused":
		case "CommitLost":
			return Effect.sync(() => defect(`a COMMIT in the diagnosis flight, which ends ROLLBACK`))
	}
}

/** The key a witness query's one row names (write/unmatched.ts), its DETAIL as the installation's encoding reads it. */
const unmatchedKey = (unmatched: Unmatched, detail: OutputText): Witness => {
	const key = unmatched.key(detail)
	if (key === undefined) {
		defect(`a witness query's DETAIL the installation's encoding reads: ${detail}`)
	}
	return key
}

/** The witness of a refusal at COMMIT its diagnosis met no longer (`unmatchedWitness`). */
const unreproduced: Witness = Object.freeze({ kind: "unreproduced" })

/** An artifact's read-backs, and the ChangeSet's reads decoder bound to their Row's layout. */
export interface BoundReads<R> {
	readonly runs: ReadBackRuns
	readonly read: (row: Row) => R
}

/**
 * A write's statements as `chunks` executes them under `transport`, in the order they are sent, each by the statement
 * it executes (SentStatement): one execution of most, a staged statement's carriers' emptyings and fills before it, and
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

/**
 * The second half of an application: its statements in one transaction of `frame` on `session` (see the header), once
 * they are bound, behind the session's stand-up of the write, which a session that ran it sends nothing for
 * (stand-up.ts), so a call whose values no transport carries is refused before any SQL.
 */
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
				yield* Effect.mapError(standUp(session, frame, flight.standUps), standUpFailure)
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
			const failure = ran.failure
			if (failure._tag !== "CommitRefused") {
				return yield* flightFailure<R>(failure, sent, context)
			}
			const unmatched = entry.witness.unmatched(failure.failure)
			return yield* commitRefusal<R>(
				failure.failure,
				context,
				unmatched === undefined
					? undefined
					: unmatchedWitness(session, frame, writes.statements, unmatched)
			)
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

/**
 * A call's rejection by the laws its host judges as it binds it (hostInputs `rejected`): the law and the witness, the
 * call's answer as it stands.
 */
export const hostRejection = <R>(
	rejected: Extract<HostInputs, { readonly kind: "rejected" }>
): ApplyOutcome<R> =>
	applyOutcome.invariantRejected({ kind: "every", laws: [rejected.refused] }, rejected.witness)

/** A share of a streamed write whose bind the laws its host judges refused, with that rejection (runWriteShares). */
class ShareRejected extends Data.TaggedError("ShareRejected")<{
	readonly rejected: Extract<HostInputs, { readonly kind: "rejected" }>
}> {}

/** A call drawn in shares (shares.ts drawShares), and the inputs of its call of no facts, which its read-backs read. */
export interface SharedCall {
	readonly shares: Iterable<HostCall>
	readonly empty: BoundInputs
}

/**
 * A call as its application binds it: `whole`, the call its whole bind binds, its facts as the call's one read took
 * them where its write's facts are drawn in shares (shares.ts drawShares), else the caller's; and `shared`, its shares,
 * none where it is bound whole.
 */
export interface DrawnCall {
	readonly whole: HostCall
	readonly shared: SharedCall | undefined
}

/**
 * A call's facts drawn in shares of whole groups, where its write's every statement is fed by its facts and no
 * read-back rides one of them (shares.ts drawShares): none where they fit one share, or the write is no such write,
 * which the call binds whole; or the first refusal of the call's one read of its facts, as its bind would meet it.
 */
export const drawnCall = <R>(
	entry: WriteEntry,
	call: HostCall,
	reads: BoundReads<R>
): Effect.Effect<DrawnCall, InputFailure> =>
	Effect.gen(function* () {
		const unshared: DrawnCall = { whole: call, shared: undefined }
		if (Arr.some(reads.runs.runs, (run) => run.kind === "riding")) {
			return unshared
		}
		const none = new Map(Arr.map(entry.program.binding.members, (m) => [m.slot, []] as const))
		const empty = yield* hostInputs(entry, { ...call, members: none })
		if (empty.kind !== "bound") {
			return unshared
		}
		const drawn = drawShares(
			entry.program,
			call,
			writeBatching.bytes,
			sendsAlone(entry.program, empty.bound.skip)
		)
		if (Result.isFailure(drawn)) {
			return yield* Effect.fail(valuesFailure(drawn.failure))
		}
		const { whole, shares } = drawn.success
		return { whole, shared: shares === undefined ? undefined : { shares, empty } }
	})

/** Each relation's counts of `counts` added to those `into` holds, by relation. */
const addCounts = (
	into: Map<string, RelationCounts>,
	counts: ReadonlyArray<RelationCounts>
): void => {
	for (const c of counts) {
		const held = into.get(c.relation)
		into.set(
			c.relation,
			held === undefined
				? c
				: {
						relation: c.relation,
						added: held.added + c.added,
						deleted: held.deleted + c.deleted,
						put: held.put + c.put
					}
		)
	}
}

/**
 * A call drawn in shares applied in its one transaction of `frame` on `session` (wire/batch.ts runFramedFlights): each
 * share bound on the host (hostInputs) only once the flight of the share before it has drained, its statements sent
 * as one flight, cut into executions within PostgreSQL's default work_mem (bind.ts batchedExecutions), and its rows read
 * at once into the outcome's counts, which every share's add to, so the host holds one share's facts, parameters and
 * rows at a time; then the read-backs and COMMIT. The session's stand-up of the write runs first, as for a whole call
 * (runWrite).
 *
 * A refusal is the call's answer, judged where it is met, and every share sent before it is rolled back
 * (runFramedFlights): the call is never sent again, so no second attempt can commit what the first refused, the state
 * having moved between them.
 *
 * - A share the laws its host judges refuse as it binds it: that rejection (hostRejection). drawShares draws whole
 *   groups, so every count, end and fresh group the host judges reads one share's facts as it reads the call's
 *   (shares.ts); a key's duplicate across two shares, which no share's bind meets, the key's UNIQUE constraint refuses
 *   at the later share, the same law.
 * - A statement a share's flight refused: classified as a whole call's is (flightFailure), by the server's error, the
 *   statement's place in its share, and the host's judgement over that share's stated rows, the facts its statements
 *   write, so its witness names the share's row that breaks the law, as a whole call's names its own.
 * - COMMIT refused: classified at COMMIT (commitRefusal), the witness of a deferred foreign key's unmatched row read by
 *   one more draw of the shares in a transaction of `frame` that ends ROLLBACK, the key's witness query its closing
 *   flight (unmatchedShares): the row is one the state every share leaves holds, which exists only once the last share
 *   ran, and the refusal is known only at COMMIT, which rolled that state back. The draw is the refusal's alone, and
 *   commits nothing.
 */
export const runWriteShares = <R>(
	session: Session,
	frame: Frame,
	entry: WriteEntry,
	drawn: SharedCall,
	reads: BoundReads<R>
): Effect.Effect<ApplyOutcome<R>, ApplyError> =>
	Effect.gen(function* () {
		const flight = entry.program
		yield* Effect.mapError(standUp(session, frame, flight.standUps), standUpFailure)
		const empty = drawn.empty
		/**
		 * How a refusal of a statement is judged on the host, over `stated`: a share's statement over that share's own
		 * stated rows, the facts its statements write (shares.ts), so its witness is the share's row that breaks the law;
		 * the opening's prologue and the closing flight's statements and COMMIT, which no share states, over the call's
		 * empty facts.
		 */
		const contextOf = (stated: StatedRows): WitnessContext => ({
			violation: entry.witness.classify,
			statement: (at) => ({
				relations: statementRelations(flight.prepared.witness, at),
				judge: (refuser) => hostJudgement(flight.prepared.witness, stated, at, refuser),
				above: (owner) => aboveJudgement(flight.prepared.witness, stated, at, owner)
			})
		})
		const unshared = contextOf(empty.bound.stated)
		const sentBacks = Arr.flatMap(reads.runs.runs, (run) => (run.kind === "sent" ? [run] : []))
		const readBackFlights = yield* Effect.mapError(
			Effect.forEach(sentBacks, (run) => readBackFlight(run, empty)),
			inputApplyError
		)
		const backs = joinFlights(readBackFlights)
		const counts = new Map<string, RelationCounts>()
		const read = (share: SentShare, outcomes: ReadonlyArray<BatchOutcome>): void => {
			const raws = new Map<number, OutputRows>()
			for (const [one, outcome] of Arr.zip(share.sent, outcomes)) {
				const before = raws.get(one.statement.index)
				raws.set(
					one.statement.index,
					before === undefined ? outcome.rows : [...before, ...outcome.rows]
				)
			}
			addCounts(
				counts,
				interpretRows(flight.outcome, flight.statements, (i) => raws.get(i) ?? noRows).counts
			)
		}
		const ran = yield* Effect.result(
			runFramedFlights(session, frame, shareFlights(session, entry, drawn), read, backs.statements)
		)
		if (Result.isFailure(ran)) {
			const failure = ran.failure
			switch (failure._tag) {
				case "ShareRejected":
					return hostRejection<R>(failure.rejected)
				case "ConnectionLost":
					return yield* new TransportFailure({ reason: failure })
				case "EncodingFailure":
				case "InputTooLarge":
					return yield* Effect.fail(inputApplyError(failure))
			}
		}
		const answer = ran.success
		if (answer.kind === "failed") {
			const failure = answer.failure
			if (failure._tag !== "CommitRefused") {
				const share = answer.at
				return yield* share === undefined
					? flightFailure<R>(failure, [], unshared)
					: flightFailure<R>(failure, share.sent, contextOf(share.stated))
			}
			const unmatched = entry.witness.unmatched(failure.failure)
			return yield* commitRefusal<R>(
				failure.failure,
				unshared,
				unmatched === undefined
					? undefined
					: unmatchedShares(session, frame, entry, drawn, unmatched)
			)
		}
		const sentRows = yield* Effect.mapError(
			backs.read(answer.closing),
			(unreadable) =>
				new ExecutionFailure({
					reason: new UnreadableAnswer({ index: unreadable.index, fate: unreadable.fate })
				})
		)
		const total = Arr.sort(
			[...counts.values()],
			Order.mapInput(Order.String, (c: RelationCounts) => c.relation)
		)
		return applyOutcome.committed(total, reads.read(readsRow(sentRows)))
	})

/**
 * A share's batch as its flight sends it: its statements' executions, in order, and the rows its facts state as those
 * statements fill them (bind.ts BoundWrite `stated`), which a refusal of one of them is judged over (runWriteShares).
 */
interface SentShare {
	readonly sent: ReadonlyArray<SentStatement>
	readonly stated: StatedRows
}

/**
 * The batches of a call's shares as runFramedFlights draws them (`next`), one per share, from the first share each time
 * it is made: each share bound on the host (hostInputs) only as its batch is drawn, its statements cut into executions
 * within PostgreSQL's default work_mem (bind.ts batchedExecutions), and a share the host's laws refuse ShareRejected.
 */
const shareFlights = (session: Session, entry: WriteEntry, drawn: SharedCall) => {
	const batched: Transport = { ...sessionTransport(session), batching: writeBatching }
	const shares = drawn.shares[Symbol.iterator]()
	return (): Effect.Effect<FlightBatch<SentShare> | undefined, InputFailure | ShareRejected> =>
		Effect.gen(function* () {
			const step = shares.next()
			if (step.done === true) {
				return undefined
			}
			const inputs = yield* hostInputs(entry, step.value)
			if (inputs.kind !== "bound") {
				return yield* new ShareRejected({ rejected: inputs })
			}
			const writes = writeStatements(entry.program, inputs, inputs.bound.chunks, () => batched)
			if (Result.isFailure(writes)) {
				return yield* Effect.fail(writes.failure)
			}
			return {
				statements: writes.success.statements,
				batch: { sent: writes.success.sent, stated: inputs.bound.stated }
			}
		})
}

/**
 * The witness of a COMMIT a deferred foreign key refused, for a call drawn in shares (runWriteShares): every share drawn
 * again and sent as the call's were, in a transaction of `frame` that ends ROLLBACK, the key's witness query its closing
 * flight, so the query reads the state the write leaves, one share's facts held at a time, and nothing of it lasts, as
 * unmatchedWitness reads a whole call's. A share its host refuses now, or a statement's refusal, met a state another
 * commit changed: `unreproduced`.
 */
const unmatchedShares = (
	session: Session,
	frame: Frame,
	entry: WriteEntry,
	drawn: SharedCall,
	unmatched: Unmatched
): Effect.Effect<Witness, ApplyError> =>
	Effect.flatMap(
		Effect.result(
			runFramedFlights(
				session,
				{ ...frame, end: "ROLLBACK" },
				shareFlights(session, entry, drawn),
				() => undefined,
				[oneShotStatement(unmatched.sql, [])]
			)
		),
		(ran): Effect.Effect<Witness, ApplyError> => {
			if (Result.isFailure(ran)) {
				const failure = ran.failure
				switch (failure._tag) {
					case "ShareRejected":
						return Effect.succeed(unreproduced)
					case "ConnectionLost":
						return Effect.fail(new TransportFailure({ reason: failure }))
					case "EncodingFailure":
					case "InputTooLarge":
						return Effect.fail(inputApplyError(failure))
				}
			}
			const answer = ran.success
			return answer.kind === "committed"
				? Effect.succeed(unmatchedKeyOf(unmatched, answer.closing))
				: diagnosisFailure(answer.failure)
		}
	)
