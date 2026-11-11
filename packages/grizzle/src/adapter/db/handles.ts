import * as Effect from "effect/Effect"
import type * as Option from "effect/Option"
import * as Result from "effect/Result"
import {
	compileFailure,
	type HostCall,
	hostInputs,
	inputApplyError,
	runWrite
} from "#adapter/apply/run.ts"
import { dbChangeFrame, type ServedDbContext } from "#adapter/db/context.ts"
import {
	type CompiledOps,
	factsCompiled,
	refreshHandle,
	type ServedOps,
	typedCompiled
} from "#adapter/db/ops.ts"
import { fromEngine } from "#adapter/engine.ts"
import {
	type ApplyError,
	type ReadError,
	ReadFailure,
	TransportFailure
} from "#adapter/errors/execution.ts"
import type { InputTooLarge, UnreadableAnswer } from "#adapter/errors/failures.ts"
import { applyOutcome } from "#adapter/outcomes/index.ts"
import { pageOf } from "#adapter/page/edges.ts"
import { type PageCall, pageFlight } from "#adapter/page/execute.ts"
import { pageRequest } from "#adapter/page/request.ts"
import type { ExecutionInputs } from "#adapter/reader/execution.ts"
import { poolExecutor, type ReadExecutor } from "#adapter/reader/executor.ts"
import { hostParams, readKeyValues, unreadableArguments } from "#adapter/reader/params.ts"
import { executionInputs } from "#adapter/reader/relations.ts"
import { programFlight, programGetFlight, type ReadProgram } from "#adapter/reader/run.ts"
import { runRefresh } from "#adapter/refresh/run.ts"
import {
	type LoadedChange,
	type LoadedMember,
	type LoadedPage,
	type LoadedRead,
	type LoadedVariants
} from "#adapter/served/load.ts"
import type { ApplyOutcome, QueryResult } from "#adapter/types/db.ts"
import type { Flight } from "#adapter/wire/batch.ts"
import type {
	CompileError,
	CursorError,
	EncodingFailure,
	ParamMap,
	Row
} from "#compiler/plan/common.ts"
import type { Page } from "#compiler/plan/read.ts"
import { getRefusal, malformedDescription, SourceLoc } from "#compiler/plan/runtime.ts"

/**
 * A served Db's workload handles: each program its layer loaded for the Db's role (served/load.ts LoadedMember), run on
 * the Db's pool, under its name. A handle lives as long as the layer that loaded its program.
 *
 * The refusal of an operation a member's program does not allow, which its typed handle never offers: a JavaScript
 * caller meets it before any SQL.
 */
const notItsOperation = (): CompileError =>
	malformedDescription(
		SourceLoc("db.workload", []),
		"an operation of the program: execute and get read a query, page pages a paged member, apply applies a ChangeSet, a key gets its row, refresh refreshes a refresh member's materialized derived relations"
	)

/** How a read delivers its program's rows: every one, or the one row of a query proved at most one (run.ts). */
type Delivery<X> = (
	program: ReadProgram,
	inputs: ExecutionInputs,
	read: (row: Row) => unknown
) => Effect.Effect<Flight<X, UnreadableAnswer>, InputTooLarge>

/**
 * One run of a loaded read with the caller's parameters, through `executor`: the parameters read once and every Stream
 * collected (reader/params.ts hostParams), the inputs encoded by the read's codecs, then its one flight, its rows read
 * by its bound decoder and delivered by `delivery`.
 */
const runRead = <X>(
	executor: ReadExecutor,
	read: LoadedRead,
	params: ParamMap,
	delivery: Delivery<X>
): Effect.Effect<X, ReadError> =>
	Effect.gen(function* () {
		const values = yield* hostParams(read.params, params)
		const flight = yield* Effect.mapError(
			Effect.flatMap(Effect.fromResult(executionInputs(read.codecs, values)), (ready) =>
				delivery(read.program, ready, read.read)
			),
			(reason) => new ReadFailure({ reason })
		)
		return yield* executor.run(flight)
	})

/** A read's complete result over its rows. */
const collected = (rows: ReadonlyArray<unknown>): QueryResult<unknown> => ({
	collect: Effect.succeed(rows)
})

const refusedRead = (): Effect.Effect<never, ReadFailure> =>
	Effect.fail(new ReadFailure({ reason: notItsOperation() }))

/** An operation its program does not allow, refused when it runs: its refusal is built where it is raised. */
const refusedOperation: Effect.Effect<never, ApplyError> = Effect.suspend(() =>
	compileFailure(notItsOperation())
)

const refusedApply = (): Effect.Effect<never, ApplyError> => refusedOperation

/** Where get refuses a read of a query not proved at most one row per parameter binding. */
const getLoc = SourceLoc("reader.get", [])

/** A loaded read's execute and get: get only of a query proved at most one row per parameter binding. */
const readOps = (executor: ReadExecutor, read: LoadedRead): CompiledOps<unknown> => ({
	execute: (params) => Effect.map(runRead(executor, read, params, programFlight), collected),
	get: (params) =>
		read.getEligible
			? runRead(executor, read, params, programGetFlight)
			: Effect.fail(new ReadFailure({ reason: getRefusal(getLoc) })),
	page: refusedRead,
	apply: refusedApply,
	refresh: refusedOperation
})

/**
 * One page of a paged member (page/page.ts): the request read first, then the parameters as a read's, an anchored
 * request's cursor decoded by the page's codec, the request variant's one flight, and each delivered edge's node read
 * by the decoder the layer bound to that variant's layouts, its cursor made by the codec.
 */
const runPage = <Q>(
	executor: ReadExecutor,
	read: LoadedRead,
	page: LoadedPage,
	params: ParamMap,
	request: unknown
): Effect.Effect<Page<unknown, Q>, ReadError | CursorError> =>
	Effect.gen(function* () {
		const asked = yield* Effect.fromResult(pageRequest(request))
		const values = yield* hostParams(read.params, params)
		const inputs = yield* Effect.fromResult(
			Result.mapError(executionInputs(read.codecs, values), (reason) => new ReadFailure({ reason }))
		)
		const call: PageCall =
			asked.variant === "first" || asked.variant === "last"
				? asked
				: {
						variant: asked.variant,
						size: asked.size,
						boundary: (yield* fromEngine(page.runtime.codec.decode(asked.cursor))).texts
					}
		const flight = yield* Effect.mapError(
			pageFlight(page.runtime, inputs, call),
			(reason) => new ReadFailure({ reason })
		)
		const rows = yield* executor.run(flight)
		return yield* Effect.fromResult(
			pageOf<unknown, Q>(page.runtime, rows, page.reads[asked.variant])
		)
	})

/**
 * One application of a loaded ChangeSet (apply/run.ts) for the call `call` reads (load.ts ChangeCall): its inputs
 * readied on the host, a same-key pair the host already refuses answered as invariant-rejected before any SQL, else its
 * one transaction on a session of the Db's pool, whose acquisition's refusal is a TransportFailure at stage acquire.
 */
const applyChange = (
	ctx: ServedDbContext,
	change: LoadedChange,
	call: Result.Result<HostCall, EncodingFailure>
): Effect.Effect<ApplyOutcome<unknown>, ApplyError> =>
	Effect.gen(function* () {
		const inputs = yield* Effect.mapError(
			Effect.flatMap(Effect.fromResult(call), (read) => hostInputs(change.entry, read)),
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
				(session) => runWrite(session, dbChangeFrame(ctx), change.entry, inputs, change.reads)
			)
		)
	})

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
 * A loaded member's operations over a Db's context (db/ops.ts ServedOps), those its program does not allow refused
 * before any SQL: a read executes and gets; a key gets by its values, read once at the boundary (reader/params.ts
 * readKeyValues); a paged member also pages; a ChangeSet applies its variant for the Db's claims, with each call's
 * facts where it holds array members (load.ts ChangeCall); a refresh refreshes its targets, already in refresh order,
 * in one transaction of the Db's role (refresh/run.ts runRefresh). Its reads run through `executor`, which sends each
 * flight.
 */
export const memberOpsOn = (
	executor: ReadExecutor,
	ctx: ServedDbContext,
	member: LoadedMember
): ServedOps<unknown> => {
	switch (member.kind) {
		case "read":
			return { kind: "program", ops: readOps(executor, member.read) }
		case "key": {
			const read = readOps(executor, member.read)
			return {
				kind: "program",
				ops: {
					...read,
					get: (values: ParamMap): Effect.Effect<Option.Option<unknown>, ReadError> => {
						const bound = readKeyValues(member.fields, values, unreadableArguments())
						return Result.isFailure(bound) ? Effect.fail(bound.failure) : read.get(bound.success)
					}
				}
			}
		}
		case "paged":
			return {
				kind: "program",
				ops: {
					...readOps(executor, member.read),
					page: <Q>(params: ParamMap, request: unknown) =>
						runPage<Q>(executor, member.read, member.page, params, request)
				}
			}
		case "change": {
			const change = variantOf(ctx, member.variants)
			const call = change.call
			switch (call.kind) {
				case "params":
					return {
						kind: "program",
						ops: {
							execute: refusedRead,
							get: refusedRead,
							page: refusedRead,
							apply: (params) => applyChange(ctx, change, Result.succeed(call.call(params))),
							refresh: refusedOperation
						}
					}
				case "facts":
					return {
						kind: "facts",
						ops: {
							execute: refusedRead,
							get: refusedRead,
							page: refusedRead,
							apply: (facts, params) => applyChange(ctx, change, call.call(facts, params)),
							refresh: refusedOperation
						}
					}
			}
		}
		case "refresh": {
			const refresh = member.refresh
			return {
				kind: "program",
				ops: {
					execute: refusedRead,
					get: refusedRead,
					page: refusedRead,
					apply: refusedApply,
					refresh: Effect.asVoid(runRefresh(ctx, refresh))
				}
			}
		}
	}
}

/** A loaded member's operations over a Db's context (memberOpsOn), its reads run on the context's pool. */
export const memberOps = (ctx: ServedDbContext, member: LoadedMember): ServedOps<unknown> =>
	memberOpsOn(poolExecutor(ctx), ctx, member)

/**
 * The record of a Db's workload handles: each member's operations (memberOps), typed, under its name: a refresh's its one
 * operation (refreshHandle), a change's that takes each call's facts its facts handle (factsCompiled), every other
 * member's its program's (typedCompiled).
 */
export const servedHandles = (
	ctx: ServedDbContext,
	members: ReadonlyArray<LoadedMember>
): object => {
	const handles: Record<string, object> = {}
	for (const member of members) {
		const served = memberOps(ctx, member)
		handles[member.name] =
			served.kind === "facts"
				? factsCompiled(served.ops)
				: member.kind === "refresh"
					? refreshHandle(served.ops)
					: typedCompiled(served.ops)
	}
	return Object.freeze(handles)
}
