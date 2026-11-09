import { Effect, Result, type Scope } from "effect"
import { changeCall } from "#adapter/apply/collect.ts"
import type { CompiledChange } from "#adapter/apply/compile.ts"
import {
	type BoundReads,
	compileFailure,
	inputApplyError,
	hostInputs,
	runWrite
} from "#adapter/apply/run.ts"
import { type DbContext, dbWriteFrame } from "#adapter/db/context.ts"
import {
	type ApplyError,
	type ExecutionFailure,
	TransportFailure
} from "#adapter/errors/execution.ts"
import { HandleReleased } from "#adapter/errors/failures.ts"
import { applyOutcome } from "#adapter/outcomes/index.ts"
import { whileLive } from "#adapter/reader/reader.ts"
import {
	boundReads,
	compileChangeForm,
	type CompiledEntry,
	compiledWrite
} from "#adapter/served/forms.ts"
import type { ApplyOutcome } from "#adapter/types/db.ts"
import type { CompileError, ParamMap, RowDecoder } from "#compiler/plan/common.ts"

export type { CompiledChange } from "#adapter/apply/compile.ts"
/**
 * db.apply and db.compile(changes): a ChangeSet applied in one transaction. Commit is typed work.
 *
 * One transaction of the Db's role on one session, its statements, its read-backs and COMMIT in one flight (run.ts
 * runWrite). Each application:
 *
 * 1. compiles the ChangeSet for this Db (compile.ts): a CompileError, which an apply's error channel cannot carry, is
 *    the ExecutionFailure whose reason it is, before any SQL. A statement naming an extension's type the database or
 *    the role cannot use is refused by PostgreSQL, the ExecutionFailure whose reason is its ServerError;
 * 2. makes one attempt: it readies its inputs on the host (run.ts hostInputs: Stream members collected,
 *    normalization), and, unless the host already refused a same-key pair, runs the
 *    transaction (run.ts runWrite), whose outcome is `accepted` or `no-change` with its counts and reads once COMMIT
 *    committed; `invariant-rejected` for a law a statement or COMMIT refused; a TransientFailure for a concurrent
 *    transaction's work met at a statement or raised by COMMIT (40001, 40P01, a put-target concurrent commit, a
 *    generated serial's 23505, ...), which the caller may retry; and CommitUnknown for a COMMIT with no answer.
 *
 * grizzle never retries: every call is one attempt, and a caller that wants another runs the call again.
 *
 * An acquisition that fails is an operational failure of the apply: the TransportFailure whose reason is the
 * acquisition's refusal (a CredentialError among them), at stage acquire, as a direct read reports it. A ChangeSet
 * with no statement to send, the empty ChangeSet or one whose every member holds no fact, still runs its transaction:
 * its frame alone meets the fence and the snapshot check, so a stale Db fails with StaleSnapshot, and it is `no-change`
 * only once COMMIT committed.
 *
 * db.compile(changes) compiles once and binds the ChangeSet's reads decoder, failing with
 * the CompileError itself; its handle's apply(params) runs step 2 with each call's parameters and the ChangeSet value's
 * own members.
 *
 * The outcome's reads are the ChangeSet's own reads decoder's record (write/changeset/value.ts), bound once to the
 * layout of the read-backs' Row (readback.ts); a binding it refuses fails the apply as a ChangeSet that does not
 * compile.
 */
export { compileFailure, hostInputs, valuesFailure } from "#adapter/apply/run.ts"

/**
 * A compiled ChangeSet handle, which the public Compiled<S, X, Reads> wraps (types/db): its apply takes the parameters
 * as a JavaScript caller's values are and delivers the outcome, whose reads are R, the records of the ChangeSet's reads
 * decoder. A ChangeSet compiled once: each apply runs its compiled program with that call's parameters, which reach it
 * from the typed Db boundary as a ParamMap (types/core ParamArg).
 */
export interface CompiledChangeValue<R> {
	readonly schema: unknown
	apply(params: ParamMap): Effect.Effect<ApplyOutcome<R>, ApplyError>
}

/**
 * One application of a compiled ChangeSet value whose reads decoder is bound (steps 2 and 3 of the header), running its
 * program's artifact.
 *
 * Every application the host does not refuse runs its transaction, one of no statement included (an empty ChangeSet,
 * or one whose every member holds no fact): its frame alone still meets the fence and the snapshot check (run.ts
 * runWrite), so a Db the database no longer holds the snapshot of fails with StaleSnapshot, and `no-change` is released
 * only once COMMIT committed.
 */
const applyBound = <R>(
	ctx: DbContext,
	entry: CompiledChange,
	params: ParamMap,
	reads: BoundReads<R>
): Effect.Effect<ApplyOutcome<R>, ApplyError> =>
	Effect.gen(function* () {
		const inputs = yield* Effect.mapError(
			Effect.flatMap(changeCall(entry, params), (call) => hostInputs(entry, call)),
			inputApplyError
		)
		if (inputs.kind === "rejected") {
			return applyOutcome.invariantRejected(
				{ kind: "every", laws: [inputs.refused] },
				inputs.witness
			)
		}
		return yield* Effect.scoped(
			Effect.flatMap(
				Effect.mapError(ctx.pool.lease, (reason) => new TransportFailure({ reason })),
				(session) => runWrite(session, dbWriteFrame(ctx), entry, inputs, reads)
			)
		)
	})

/**
 * One application of a compiled ChangeSet value (steps 2 and 3 of the header), its read-backs decoded by `decoder`,
 * running its program's artifact: the optimized one a compilation builds, or the conservative realization the write
 * oracle builds in its place.
 */
export const runApplication = <R>(
	ctx: DbContext,
	entry: CompiledChange,
	params: ParamMap,
	decoder: RowDecoder<R>
): Effect.Effect<ApplyOutcome<R>, ApplyError> =>
	Effect.suspend(() => {
		const reads = boundReads(entry, decoder)
		return Result.isFailure(reads)
			? compileFailure(reads.failure)
			: applyBound(ctx, entry, params, reads.success)
	})

/** The compiled program of a ChangeSet for an apply, or the apply's failure before any SQL. */
const applicable = (
	ctx: DbContext,
	changes: unknown
): Effect.Effect<CompiledChange, ExecutionFailure> =>
	Effect.suspend(() => {
		const compiled = compiledWrite(ctx, changes, ctx.claims)
		return Result.isFailure(compiled)
			? compileFailure(compiled.failure)
			: Effect.succeed(compiled.success)
	})

/**
 * `changes` is a ChangeSet value over a level of the Db's role within the role's write list, and `decoder` its reads
 * decoder; the success value is its ApplyOutcome.
 */
export const apply = <R>(
	ctx: DbContext,
	changes: unknown,
	decoder: RowDecoder<R>,
	params: ParamMap
): Effect.Effect<ApplyOutcome<R>, ApplyError> =>
	Effect.flatMap(applicable(ctx, changes), (entry) => runApplication(ctx, entry, params, decoder))

/**
 * A ChangeSet compiled once for a role and the contexts `claims` holds a fact of, ahead of the applies that run it: its
 * program and its read-backs' decoder bound. db.compile compiles one for its Db's claims, and the layer one for each
 * set of a workload ChangeSet's fill contexts.
 */
export interface ChangeForm<R> {
	readonly entry: CompiledChange
	readonly bound: BoundReads<R>
	/** The ChangeSet's reads decoder, which its served form carries as data. */
	readonly decoder: RowDecoder<R>
}

/** An apply of a handle whose Scope ended. */
const applyReleased = (): TransportFailure => new TransportFailure({ reason: new HandleReleased() })

/**
 * The handle of a change form on a Db: each apply runs the form's program with that call's parameters while `live`
 * holds; an apply after it ends changed nothing: TransportFailure, HandleReleased.
 */
export const changeHandle = <R>(
	ctx: DbContext,
	form: ChangeForm<R>,
	live: () => boolean
): CompiledChangeValue<R> =>
	Object.freeze({
		schema: ctx.schema.value,
		apply: (params: ParamMap) =>
			whileLive(live, applyReleased, () => applyBound(ctx, form.entry, params, form.bound))
	})

/**
 * db.compile of a ChangeSet: its change form for the Db's claims; when the Scope ends its compiled form drops and an
 * apply is refused.
 */
export const compileChange = <R>(
	ctx: DbContext,
	changes: unknown,
	decoder: RowDecoder<R>
): Effect.Effect<CompiledChangeValue<R>, CompileError, Scope.Scope> =>
	Effect.gen(function* () {
		const form = yield* Effect.suspend(() =>
			Effect.fromResult(compileChangeForm(ctx, changes, decoder, ctx.claims))
		)
		const state = { live: true }
		yield* Effect.addFinalizer(() =>
			Effect.sync(() => {
				state.live = false
			})
		)
		return changeHandle(ctx, form, () => state.live)
	})

/** The program a compiled ChangeSet handle runs, for inspection; CompileError when the value is no ChangeSet. */
export const writeProgramOf = (
	ctx: DbContext,
	changes: unknown
): Result.Result<CompiledEntry, CompileError> => compiledWrite(ctx, changes, ctx.claims)
