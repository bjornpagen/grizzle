import { Array as Arr, Effect, Record as Rec, Result, Stream } from "effect"
import { collectInputs } from "#adapter/apply/collect.ts"
import type { CompiledChange, WriteEntry } from "#adapter/apply/compile.ts"
import {
	type ArtifactKind,
	type ReadBackRuns,
	readBackFlight,
	readsRow
} from "#adapter/apply/readback.ts"
import { rowOptions } from "#adapter/engine.ts"
import {
	type ApplyError,
	CommitUnknown,
	ExecutionFailure,
	TransientFailure,
	TransportFailure
} from "#adapter/errors/execution.ts"
import { InputTooLarge, type MissingCapability, StaleStatement } from "#adapter/errors/failures.ts"
import {
	type Classified,
	classifyServerError,
	committedOutcome,
	outsideOutcome,
	rejectedOutcome
} from "#adapter/outcomes/index.ts"
import type { ExecutionInputs, HostParams } from "#adapter/reader/execution.ts"
import { readParams, relationStreams } from "#adapter/reader/params.ts"
import { executionInputs } from "#adapter/reader/relations.ts"
import type { ApplyOutcome } from "#adapter/types/db.ts"
import {
	type BatchStatement,
	type FlightFailure,
	type Frame,
	joinFlights,
	runFramed
} from "#adapter/wire/batch.ts"
import { nameStatements } from "#adapter/wire/naming.ts"
import type { Session } from "#adapter/wire/session.ts"
import { encodeFailure, factPlace, slotPlace } from "#compiler/codec/fault.ts"
import { bindGroups, type Row, type RowDecoder } from "#compiler/core/decoder.ts"
import { type CompileError, type EncodingFailure } from "#compiler/core/errors.ts"
import { recordsetMaxRows } from "#compiler/core/policy.ts"
import type { ParamDecl } from "#compiler/ir/products.ts"
import { transportLimits } from "#compiler/lower/shapes/relparam/index.ts"
import type { Law, Witness } from "#compiler/types/changeset/changeset.ts"
import type { ParamMap, ParamValue } from "#compiler/types/core/phantom.ts"
import type { ArtifactStatement, UniqueAbort } from "#compiler/write/program/artifact.ts"
import { type BoundWrite, bindWrite, type Raw } from "#compiler/write/program/bind.ts"
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
 * How readying an application's inputs fails, before any SQL: a codec refused an input, an input is past the size
 * limit, or the WriteProgram refused the binding (its CompileError), which each caller reports in its own channel.
 */
export type InputFailure = EncodingFailure | InputTooLarge | CompileError

/** An input's refusal as an apply's error: a codec's as itself, any other as the ExecutionFailure whose reason it is. */
export const inputApplyError = (failure: InputFailure): EncodingFailure | ExecutionFailure =>
	failure._tag === "EncodingFailure" ? failure : new ExecutionFailure({ reason: failure })

/**
 * Running one application of a WriteProgram.
 *
 * One application is two halves.
 *
 * Before any SQL (`hostInputs`): the ChangeSet value's array and Stream members are collected, a Stream at most
 * recordsetMaxRows facts (apply/collect.ts), and so is a Stream relation parameter; the WriteProgram binds
 * them (write/program/bind.ts): host normalization, which refuses a same-key pair among the enumerated additions as
 * invariant-rejected with the key law without sending any SQL; and the transport size rule, which refuses an input
 * past the size limit with InputTooLarge. A caller that runs the apply again after a
 * TransientFailure replays this half too, so a Stream member must be repeatable.
 *
 * Then the transaction (`runWrite`), one transaction of the Db's role on one session, in one flight
 * (../wire/batch.ts runFramed):
 *
 * 1. Every write, carrier and sequence-advance statement of the artifact, in the order its statements run, each with
 *    the placeholder texts binding gave it, goes in the flight; a statement whose enumerated member holds no fact is
 *    skipped, because it produces no statement. A flight left with no statement still sends its frame, BEGIN, the
 *    prologue's fence and snapshot check, and COMMIT, so an all-empty application meets the check every transaction
 *    of the Db meets. No statement's rows decide whether a later one is sent: whatever
 *    refuses the write raises inside the statement that detects it (write/refusal.ts), and PostgreSQL then aborts the
 *    transaction, so nothing after it, COMMIT included, commits.
 * 2. The read-backs run after every write and before COMMIT, delivered as queries are (readback.ts): every statement
 *    of every read-back rides in the flight behind the writes, an attachment included, since it computes its parent's
 *    rows itself. COMMIT ends the flight, so a write and its read-backs are one round trip.
 * 3. A refused statement is classified (../outcomes): a refusal a write statement raised is invariant-rejected with
 *    its law or a TransientFailure of the concurrent change it met; an abort PostgreSQL raised is a TransientFailure,
 *    an integrity violation of a law invariant-rejected, anything else an operational failure. So is a refusal at
 *    COMMIT (a deferred law, 40001). COMMIT with no answer is CommitUnknown.
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

/**
 * A Stream relation parameter collected on the host: one that fails encodes nothing, and one of more than `maxRows`
 * facts is a relation input past the size limit.
 */
const collectParam = (
	decl: ParamDecl,
	stream: Stream.Stream<unknown, unknown>,
	maxRows: number
): Effect.Effect<ReadonlyArray<unknown>, EncodingFailure | InputTooLarge> =>
	Stream.runCollect(
		Stream.take(
			Stream.mapError(stream, () => encodeFailure("factShape", slotPlace(decl.name))),
			maxRows + 1
		)
	).pipe(
		Effect.filterOrFail(
			(facts) => facts.length <= maxRows,
			() => new InputTooLarge()
		)
	)

/** The values of the declared parameters by name: a ChangeSet.bind value under its private name, else the caller's. */
const declaredParams = (
	declared: ReadonlyArray<ParamDecl>,
	params: ParamMap,
	bindings: ReadonlyMap<string, ParamValue>
): Effect.Effect<HostParams, EncodingFailure | InputTooLarge> =>
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
				Effect.map(
					collectParam(decl, stream, recordsetMaxRows),
					(facts) => [decl.name, facts] as const
				)
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
		const members = yield* collectInputs(program.frontend, compiled.change.inputs, recordsetMaxRows)
		const host = yield* declaredParams(program.params, params, compiled.change.values)
		/**
		 * `host` holds every bound value under its private name with its Stream collected, so the statements bind the
		 * same values the read-backs read; the raw bindings would hand them an uncollected Stream.
		 */
		const bound = bindWrite(program, { members, params: host })
		if (!bound.ok) {
			return yield* Effect.fail(bound.error === "ResourceBound" ? new InputTooLarge() : bound.error)
		}
		if (bound.value.kind === "invariant-rejected") {
			return {
				kind: "rejected",
				law: bound.value.described,
				witness: bound.value.witness
			} as const
		}
		const ready = executionInputs(compiled.codecs, host, transportLimits)
		if (Result.isFailure(ready)) {
			return yield* Effect.fail(ready.failure)
		}
		return { kind: "bound", bound: bound.value, ...ready.success } as const
	})

const outcomeOf = <R>(classified: Classified): Effect.Effect<ApplyOutcome<R>, ApplyError> => {
	switch (classified.kind) {
		case "rejected":
			return Effect.succeed(rejectedOutcome(classified.law, classified.witness))
		case "outside":
			return Effect.succeed(outsideOutcome(classified.relation))
		case "failed":
			return Effect.fail(classified.error)
	}
}

/**
 * The unique aborts of the flight's statement at `index`: a write statement's own, a single statement's parts', and none
 * for another step or for a read-back, whose statements follow the sent ones.
 */
const uniqueAbortsAt = (
	sent: ReadonlyArray<ArtifactStatement>,
	index: number
): ReadonlyArray<UniqueAbort> => {
	const statement = sent[index]
	if (statement === undefined) {
		return []
	}
	const step = statement.step
	return step.kind === "write" || step.kind === "single" ? step.uniqueAborts : []
}

/**
 * What a write's failed flight means: a refused statement is classified with its unique aborts; a refusal at COMMIT
 * with none; the fence's refusal is StaleSnapshot; any other refused prologue, which only a login that lost the role's
 * membership meets, is the server's.
 */
const flightFailure = <R>(
	failure: FlightFailure,
	sent: ReadonlyArray<ArtifactStatement>,
	context: { readonly violation: WriteEntry["violation"] }
): Effect.Effect<ApplyOutcome<R>, ApplyError> => {
	switch (failure._tag) {
		case "BatchRefused":
			return outcomeOf(
				classifyServerError(failure.failure, {
					...context,
					uniqueAborts: uniqueAbortsAt(sent, failure.index)
				})
			)
		case "CommitRefused":
			return outcomeOf(classifyServerError(failure.failure, { ...context, uniqueAborts: [] }))
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
	const read = bindGroups(decoder, [runs.layout], rowOptions)
	return read.ok ? Result.succeed({ runs, read: read.value }) : Result.fail(read.error)
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
		const skip = inputs.bound.skip(artifact)
		/** The write statements, in the order they are sent. */
		const sent: Array<ArtifactStatement> = []
		const statements: Array<BatchStatement> = []
		for (const s of artifact.statements) {
			if (s.step.kind === "readBack" || skip.has(s.index)) {
				continue
			}
			const values = inputs.bound.values(s)
			if (!values.ok) {
				return yield* Effect.fail(values.error)
			}
			sent.push(s)
			statements.push({ sql: inputs.bound.form(s).sql, params: values.value })
		}
		const flights = yield* Effect.mapError(
			Effect.forEach(reads.runs.runs, (run) => readBackFlight(run, inputs)),
			inputApplyError
		)
		const readBacks = joinFlights(flights)
		const ran = yield* Effect.result(
			runFramed(
				session,
				frame,
				nameStatements(entry.naming, [...statements, ...readBacks.statements])
			)
		)
		if (Result.isFailure(ran)) {
			return yield* flightFailure<R>(ran.failure, sent, context)
		}
		const outcomes = ran.success
		/** The rows of each sent statement, by its position in the artifact; a statement not sent answered none. */
		const raws = new Map<number, Raw>(
			Arr.map(Arr.zip(sent, outcomes), ([s, outcome]) => [s.index, outcome.rows] as const)
		)
		const delivered = yield* readBacks.read(outcomes.slice(statements.length))
		const changes = interpretRows(program.outcomeContext, artifact, (i) => raws.get(i) ?? noRows)
		return committedOutcome(changes.outcome, changes.counts, reads.read(readsRow(delivered)))
	})
