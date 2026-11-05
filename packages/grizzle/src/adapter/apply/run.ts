import { Array as Arr, Effect, Record as Rec, Result, Stream } from "effect"
import { collectInputs } from "#adapter/apply/collect.ts"
import type { CompiledChange, WriteEntry } from "#adapter/apply/compile.ts"
import {
	type ArtifactKind,
	type ReadBackRuns,
	readBackFlight,
	readsRow
} from "#adapter/apply/readback.ts"
import {
	type ApplyError,
	CommitUnknown,
	ExecutionFailure,
	TransientFailure,
	TransportFailure
} from "#adapter/errors/execution.ts"
import {
	familyRowBound,
	type InputTooLarge,
	literalBound,
	type MissingCapability,
	StaleStatement,
	UnreadableAnswer
} from "#adapter/errors/failures.ts"
import {
	type Classified,
	classifyServerError,
	committedOutcome,
	type FailureOrigin,
	outsideOutcome,
	rejectedOutcome
} from "#adapter/outcomes/index.ts"
import type { ExecutionInputs, HostParams } from "#adapter/reader/execution.ts"
import { readParams, relationStreams } from "#adapter/reader/params.ts"
import { executionInputs } from "#adapter/reader/relations.ts"
import type { ApplyOutcome } from "#adapter/types/db.ts"
import {
	type BatchOutcome,
	type BatchStatement,
	bindFrame,
	type FlightFailure,
	type FlightStatement,
	type Frame,
	joinFlights,
	runFramed,
	runFramedTwice
} from "#adapter/wire/batch.ts"
import { nameStatements } from "#adapter/wire/naming.ts"
import type { Session } from "#adapter/wire/session.ts"
import { encodeFailure, factPlace, slotPlace } from "#compiler/codec/fault.ts"
import { bindGroups, type Row, type RowDecoder } from "#compiler/core/decoder.ts"
import { type CompileError, type EncodingFailure } from "#compiler/core/errors.ts"
import type { FamilyId } from "#compiler/ir/law.ts"
import type { LiteralBound, ParamDecl } from "#compiler/ir/products.ts"
import type { Law, Witness } from "#compiler/types/changeset/changeset.ts"
import type { ParamMap, ParamValue } from "#compiler/types/core/phantom.ts"
import { inForce } from "#compiler/write/family/order.ts"
import type { ArtifactStatement, WriteArtifact } from "#compiler/write/program/artifact.ts"
import {
	type BoundWrite,
	bindWrite,
	type Chunks,
	type FamilyRowBound,
	type Raw
} from "#compiler/write/program/bind.ts"
import { interpretRows } from "#compiler/write/program/outcome.ts"

/** The rows of a statement the flight did not send. */
const noRows: Raw = []

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
	| { readonly kind: "rejected"; readonly law: Law; readonly witness: Witness }

/**
 * How readying an application's inputs fails, before any SQL: a codec refused an input, an input's texts are past a
 * bound of their transport, or the WriteProgram refused the binding (its CompileError), which each caller reports in
 * its own channel.
 */
export type InputFailure = EncodingFailure | InputTooLarge | CompileError

/**
 * A statement's placeholder texts refused (write/program/bind.ts BoundWrite.chunks): a codec's refusal as itself, a
 * column whose array no string can hold as the InputTooLarge of its bound, a family's row no statement of its plan
 * can carry as the InputTooLarge naming its family and statement (errors/failures.ts familyRowBound), and a change an
 * immutable owner's family refuses, which only the run time could decide, as the same CompileError its static form is.
 */
export const valuesFailure = (
	failure: EncodingFailure | LiteralBound | FamilyRowBound | CompileError
): InputFailure => {
	switch (failure._tag) {
		case "EncodingFailure":
		case "CompileError":
			return failure
		case "LiteralBound":
			return literalBound(failure)
		case "FamilyRowBound":
			return familyRowBound(failure.family, failure.row)
	}
}

/** An input's refusal as an apply's error: a codec's as itself, any other as the ExecutionFailure whose reason it is. */
export const inputApplyError = (failure: InputFailure): EncodingFailure | ExecutionFailure =>
	failure._tag === "EncodingFailure" ? failure : new ExecutionFailure({ reason: failure })

/**
 * Running one application of a WriteProgram.
 *
 * One application is two halves.
 *
 * Before any SQL (`hostInputs`): the ChangeSet value's array and Stream members are collected, a Stream whole
 * (apply/collect.ts), and so is a Stream relation parameter; the WriteProgram binds them (write/program/bind.ts): host
 * normalization, which refuses a same-key pair among the enumerated additions as invariant-rejected with the key law
 * without sending any SQL, and each family's nested write planned under the wire's transport (wire/batch.ts bindFrame,
 * write/family/order.ts inForce), its statements cut to what one Bind message carries. No input is bounded by its
 * number of facts: its arrays are written per statement as the transaction is built, and one whose texts are past a
 * bound of their transport, a family's row no statement carries even alone among them, is InputTooLarge before the
 * flight is sent (wire/batch.ts). A caller that runs the apply again after a TransientFailure replays this half too, so a Stream
 * member must be repeatable.
 *
 * Then the transaction (`runWrite`), one transaction of the Db's role on one session, in one flight
 * (../wire/batch.ts runFramed), or in two when its plan reads before it writes (BoundWrite flights, rows-first.md §2):
 * a family's edit of a group that already exists reads the group's stored suffix and its owner's count and ends, one
 * batched SELECT per family, in a first flight behind BEGIN and the prologue, and the plan fills its write statements
 * from those rows, which the second flight sends with COMMIT (../wire/batch.ts runFramedTwice). Under SERIALIZABLE a
 * concurrent writer of a group the reads read meets 40001 at either flight or at COMMIT, a TransientFailure the caller
 * may run the apply again for; grizzle never retries. Each statement is counted across both flights, so a failure is
 * attributed to its statement, a family step's chunk, or the read of its family:
 *
 * 1. Every write, family, carrier and sequence-advance statement of the artifact, in the order its statements run, each
 *    with the placeholder texts binding gave it, goes in the flight, a family's once per statement its plan cuts, and
 *    none where its nested write writes no row of the statement's kind; a statement whose enumerated member holds no
 *    fact is skipped, because it produces no statement. A flight left with no statement still sends its frame, BEGIN, the
 *    prologue's fence and snapshot check, and COMMIT, so an all-empty application meets the check every transaction
 *    of the Db meets. No statement's rows decide whether a later one is sent: whatever
 *    refuses the write raises inside the statement that detects it (write/refusal.ts), and PostgreSQL then aborts the
 *    transaction, so nothing after it, COMMIT included, commits.
 * 2. The read-backs run after every write and before COMMIT, delivered as queries are (readback.ts): every statement
 *    of every read-back rides in the flight behind the writes, an attachment included, since it computes its parent's
 *    rows itself. COMMIT ends the flight, so a write and its read-backs are one round trip.
 * 3. A refused statement is classified (../outcomes) at its origin, the statement or the COMMIT: a refusal a write
 *    statement raised is invariant-rejected with its law or a TransientFailure of the concurrent change it met; an
 *    abort PostgreSQL raised is a TransientFailure, an integrity violation of a law invariant-rejected, a roster
 *    domain's refusal of a value grizzle wrote grizzle's defect, which the application dies with, anything else an
 *    operational failure. So is a refusal at COMMIT (a deferred law, 40001). COMMIT with no answer is CommitUnknown.
 * 4. The rows are read into the changes by the WriteProgram's own converters (write/program/outcome.ts interpretRows):
 *    each stratum's facts made present and absent, netted across strata into counts and the outcome kind. Rows carry
 *    no refusal. The read-backs' Rows are read by the ChangeSet's reads decoder, bound once to the artifact's reads
 *    layout (readback.ts). Only a committed outcome is ever reported.
 *
 * A compile failure where the error channel has no CompileError: a ChangeSet that does not compile for this Db, or a
 * value built outside the typed API, as the ExecutionFailure whose reason is the refusal, as a direct read refuses with
 * the ReadFailure whose reason it is.
 */
export const compileFailure = (refusal: CompileError): Effect.Effect<never, ExecutionFailure> =>
	Effect.fail(new ExecutionFailure({ reason: refusal }))

/** A capability found absent after admission, on an apply, before any SQL. */
export const capabilityFailure = (
	missing: MissingCapability
): Effect.Effect<never, ExecutionFailure> => Effect.fail(new ExecutionFailure({ reason: missing }))

/** A Stream relation parameter collected on the host, whole: one that fails encodes nothing. */
const collectParam = (
	decl: ParamDecl,
	stream: Stream.Stream<unknown, unknown>
): Effect.Effect<ReadonlyArray<unknown>, EncodingFailure> =>
	Stream.runCollect(Stream.mapError(stream, () => encodeFailure("factShape", slotPlace(decl.name))))

/** The values of the declared parameters by name: a ChangeSet.bind value under its private name, else the caller's. */
const declaredParams = (
	declared: ReadonlyArray<ParamDecl>,
	params: ParamMap,
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
		const out: Record<string, ParamValue> = { ...given.success }
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
 * The first half of an application: everything before any SQL (see the header). A binding the WriteProgram refuses is
 * its CompileError, which each caller reports in its own error channel.
 */
export const hostInputs = (
	compiled: CompiledChange,
	params: ParamMap
): Effect.Effect<HostInputs, InputFailure> =>
	Effect.gen(function* () {
		const program = compiled.program
		const members = yield* collectInputs(program.frontend, compiled.change.inputs)
		const host = yield* declaredParams(program.params, params, compiled.change.values)
		/**
		 * `host` holds every bound value under its private name with its Stream collected, so the statements bind the
		 * same values the read-backs read; the raw bindings would hand them an uncollected Stream.
		 */
		const bound = bindWrite(program, { members, params: host, transport: inForce(bindFrame) })
		if (!bound.ok) {
			return yield* Effect.fail(bound.error)
		}
		if (bound.value.kind === "invariant-rejected") {
			return {
				kind: "rejected",
				law: bound.value.described,
				witness: bound.value.witness
			} as const
		}
		const ready = executionInputs(compiled.codecs, host)
		if (Result.isFailure(ready)) {
			return yield* Effect.fail(ready.failure)
		}
		return { kind: "bound", bound: bound.value, ...ready.success } as const
	})

const outcomeOf = <R>(classified: Classified): Effect.Effect<ApplyOutcome<R>, ApplyError> => {
	switch (classified.kind) {
		case "rejected":
			return Effect.succeed(rejectedOutcome(classified.laws, classified.witness))
		case "outside":
			return Effect.succeed(outsideOutcome(classified.relation))
		case "failed":
			return Effect.fail(classified.error)
		case "defect":
			return Effect.die(classified.defect)
	}
}

/**
 * A statement a write sends, by its index across its flights: a family's stored-suffix read, in the read flight a plan
 * that reads sends first, or the `chunk`th execution of an artifact statement (BoundWrite chunks).
 */
type SentStatement =
	| { readonly kind: "read"; readonly family: FamilyId }
	| { readonly kind: "statement"; readonly statement: ArtifactStatement; readonly chunk: number }

/**
 * The origin of the write's statement at `index`: the read or write statement sent there, or a read-back, whose
 * statements follow every sent one.
 */
const statementOrigin = (sent: ReadonlyArray<SentStatement>, index: number): FailureOrigin => {
	const one = sent[index]
	if (one === undefined) {
		return { kind: "readBack", index }
	}
	return one.kind === "read"
		? { kind: "read", index, family: one.family }
		: { kind: "statement", index, step: one.statement.step, chunk: one.chunk }
}

/**
 * What a write's failed flight means: a refused statement, or a refusal at COMMIT, is classified at its origin; the
 * fence's refusal is StaleSnapshot; any other refused prologue, which only a login that lost the role's
 * membership meets, is the server's.
 */
const flightFailure = <R>(
	failure: FlightFailure,
	sent: ReadonlyArray<SentStatement>,
	context: { readonly violation: WriteEntry["violation"] }
): Effect.Effect<ApplyOutcome<R>, ApplyError> => {
	switch (failure._tag) {
		case "BatchRefused":
			return outcomeOf(
				classifyServerError(failure.failure, {
					...context,
					origin: statementOrigin(sent, failure.index)
				})
			)
		case "CommitRefused":
			return outcomeOf(
				classifyServerError(failure.failure, { ...context, origin: { kind: "commit" } })
			)
		case "StaleName":
			return Effect.fail(
				new TransientFailure({ reason: new StaleStatement(), error: failure.failure })
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
			return Effect.fail(new ExecutionFailure({ reason: failure.failure }))
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
 * The read-backs of artifact `kind` and `decoder` bound to their layout, once per artifact: a layout the decoder
 * cannot bind is the ChangeSet's CompileError.
 */
export const boundReads = <R>(
	entry: WriteEntry,
	kind: ArtifactKind,
	decoder: RowDecoder<R>
): Result.Result<BoundReads<R>, CompileError> => {
	const runs = entry.readBacks[kind]
	const read = bindGroups(decoder, [runs.layout], entry.bind)
	return read.ok ? Result.succeed({ runs, read: read.value }) : Result.fail(read.error)
}

/**
 * An artifact's write statements as `chunks` executes them, in the order they are sent, each by the artifact statement
 * it executes (SentStatement): one execution of most, and one of a family step per statement of its kind its family's
 * plan cuts, each the step's one text over its own rows' arrays; none of a read-back's, which follow every write.
 */
const writeStatements = (
	artifact: WriteArtifact,
	inputs: BoundInputs,
	chunks: Chunks
): Result.Result<
	{
		readonly sent: ReadonlyArray<SentStatement>
		readonly statements: ReadonlyArray<BatchStatement>
	},
	InputFailure
> => {
	const skip = inputs.bound.skip(artifact)
	const sent: Array<SentStatement> = []
	const statements: Array<BatchStatement> = []
	for (const s of artifact.statements) {
		if (s.step.kind === "readBack" || skip.has(s.index)) {
			continue
		}
		const executions = chunks(s)
		if (!executions.ok) {
			return Result.fail(valuesFailure(executions.error))
		}
		const sql = inputs.bound.form(s).sql
		for (const [chunk, params] of executions.value.entries()) {
			sent.push({ kind: "statement", statement: s, chunk })
			statements.push({ sql, params })
		}
	}
	return Result.succeed({ sent, statements })
}

/** The second half of an application: its statements in one transaction of `frame` on `session` (see the header). */
export const runWrite = <R>(
	session: Session,
	frame: Frame,
	entry: WriteEntry,
	kind: ArtifactKind,
	inputs: BoundInputs,
	reads: BoundReads<R>
): Effect.Effect<ApplyOutcome<R>, ApplyError> =>
	Effect.gen(function* () {
		const program = entry.program
		const artifact = program.artifacts[kind]
		const context = { violation: entry.violation }
		const readBackFlights = yield* Effect.mapError(
			Effect.forEach(reads.runs.runs, (run) => readBackFlight(run, inputs)),
			inputApplyError
		)
		const backs = joinFlights(readBackFlights)
		const flights = inputs.bound.flights
		/** Every statement the write sends but the read-backs, by its index across its flights. */
		let sent: ReadonlyArray<SentStatement> = []
		/** How many statements precede the read-backs: the read flight's and the write statements. */
		let written = 0
		/** The write statements and the read-backs behind them, the flight that ends the transaction. */
		const closing = (
			chunks: Chunks,
			before: ReadonlyArray<SentStatement>
		): Result.Result<ReadonlyArray<FlightStatement>, InputFailure> =>
			Result.map(writeStatements(artifact, inputs, chunks), (w) => {
				sent = [...before, ...w.sent]
				written = sent.length
				return nameStatements(entry.naming, [...w.statements, ...backs.statements])
			})
		let ran: Result.Result<
			ReadonlyArray<BatchOutcome>,
			FlightFailure | EncodingFailure | CompileError
		>
		if (flights.kind === "write") {
			const one = closing(flights.chunks, [])
			if (Result.isFailure(one)) {
				return yield* Effect.fail(inputApplyError(one.failure))
			}
			ran = yield* Effect.result(runFramed(session, frame, one.success))
		} else {
			/**
			 * The read flight first, in the same transaction: each family's stored suffixes, whose rows the plan fills
			 * the write statements from (BoundWrite flights).
			 */
			const read: ReadonlyArray<SentStatement> = Arr.map(flights.reads, (r) => ({
				kind: "read",
				family: r.family
			}))
			ran = yield* Effect.result(
				runFramedTwice(
					session,
					frame,
					nameStatements(
						entry.naming,
						Arr.map(flights.reads, (r): BatchStatement => ({ sql: r.sql, params: r.params }))
					),
					(outcomes) => {
						sent = read
						const filled = flights.writes(Arr.map(outcomes, (o) => o.rows))
						return Effect.fromResult(
							filled.ok ? closing(filled.value, read) : Result.fail(valuesFailure(filled.error))
						)
					}
				)
			)
		}
		if (Result.isFailure(ran)) {
			const failure = ran.failure
			return yield* failure._tag === "EncodingFailure"
				? Effect.fail(failure)
				: failure._tag === "CompileError"
					? Effect.fail(inputApplyError(failure))
					: flightFailure<R>(failure, sent, context)
		}
		const outcomes = ran.success
		/**
		 * The rows of each sent write statement, by its position in the artifact, its executions' in the order they
		 * ran; a statement not sent answered none.
		 */
		const raws = new Map<number, Raw>()
		for (const [one, outcome] of Arr.zip(sent, outcomes)) {
			if (one.kind !== "statement") {
				continue
			}
			const s = one.statement
			const before = raws.get(s.index)
			raws.set(s.index, before === undefined ? outcome.rows : [...before, ...outcome.rows])
		}
		/**
		 * The read-backs' Rows, read from the statements after the written ones: a read-back whose answer repeats a row is
		 * UnreadableAnswer at its index in the write's flight, after the transaction committed.
		 */
		const delivered = yield* Effect.mapError(
			backs.read(outcomes.slice(written)),
			(unreadable) =>
				new ExecutionFailure({
					reason: new UnreadableAnswer({ index: written + unreadable.index, fate: unreadable.fate })
				})
		)
		const changes = interpretRows(program.outcomeContext, artifact, (i) => raws.get(i) ?? noRows)
		return committedOutcome(changes.outcome, changes.counts, reads.read(readsRow(delivered)))
	})
