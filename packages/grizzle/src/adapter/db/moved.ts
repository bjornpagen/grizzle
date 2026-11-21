import { Array as Arr, Effect, Predicate, Result, Stream } from "effect"
import {
	handlesOf,
	type MemberExplains,
	type MemberHandleParts,
	memberHandleParts,
	type ServedCalls
} from "#adapter/db/handles.ts"
import { callInput } from "#adapter/db/input.ts"
import { openedWith } from "#adapter/db/served.ts"
import { readHost } from "#adapter/engine.ts"
import type { OpenError } from "#adapter/errors/execution.ts"
import type { LoadedMember } from "#adapter/served/load.ts"
import type { DbOf, OpenOptions } from "#adapter/types/db.ts"
import type { DbLayerService, ServedRole } from "#adapter/types/layer.ts"
import type { AnyRole } from "#compiler/plan/common.ts"
import { clockOffsetName } from "#compiler/plan/runtime.ts"

/**
 * A Db over a moved clock (Db.openMoved): a test's Db whose every reading of the database's clock is the instant its
 * call's transaction began moved by the offset the test states, so a time-dependent law (a lease's end, a claim's
 * until, an expiry) is judged at the instant the test chooses, through the statements a served file runs, and no test
 * sleeps. Its login's served file is compiled for a moved clock (adapter/public/compile.ts compileServedMoved): every
 * clocked read and every ChangeSet of it declares the clock's offset (engine check/clock.ts clockOffset) and reads each
 * instant moved by it, its clocked parameters' and its stamps' alike, so a production file, whose programs declare no
 * offset and read the transaction's instant, is never a moved Db's, and a moved file is no production Db's: a call that
 * states no offset is refused as its parameters.
 *
 * Each call of a clocked read or a change member reads `offset` once, before anything else of the call, and states it
 * as the clock's offset among the call's parameters, the one value every statement of the call binds; its once, its
 * answer and its explains alike. A read is clocked exactly when its program declares the offset among its parameters,
 * the one place a served file states its clock: an answered read that binds no parameter to the clock compiles under
 * the transaction's clock and declares none. Every other member (a live or answered read that reads no clock, a key, a
 * page, a refresh) is the served Db's own.
 */

/**
 * A call's parameters with the clock's offset among them, read as a JavaScript caller's are (reader/params.ts
 * readParams, a getter's value its read): parameters that are no record, or whose reading throws, are passed as they
 * stand, for the call to refuse as it refuses them.
 */
const movedParams = (params: unknown, offset: bigint): unknown =>
	Predicate.isObject(params)
		? Result.merge(
				readHost<unknown, unknown>(params, () =>
					Result.succeed({ ...params, [clockOffsetName]: offset })
				)
			)
		: params

/**
 * A call's input with the clock's offset among its parameters (db/input.ts callInput): an input the call's boundary
 * refuses is passed as it stands, for the call to refuse it as it refuses it.
 */
const movedInput = (input: unknown, offset: bigint): unknown =>
	Result.match(callInput(input), {
		onFailure: () => input,
		onSuccess: (read) => ({ params: movedParams(read.params, offset), facts: read.facts })
	})

/** A call `f` of an input, reading `offset` first and stating it among the input's parameters. */
const onceAt =
	<A, E>(offset: Effect.Effect<bigint>, f: (input: unknown) => Effect.Effect<A, E>) =>
	(input: unknown): Effect.Effect<A, E> =>
		Effect.flatMap(offset, (o) => f(movedInput(input, o)))

/** A stream `f` of an input, reading `offset` first and stating it among the input's parameters. */
const streamAt =
	<A>(offset: Effect.Effect<bigint>, f: (input: unknown) => Stream.Stream<A>) =>
	(input: unknown): Stream.Stream<A> =>
		Stream.unwrap(Effect.map(offset, (o) => f(movedInput(input, o))))

/** A member's calls, each stating the offset `offset` reads (onceAt, streamAt). */
const movedCalls = (calls: ServedCalls, offset: Effect.Effect<bigint>): ServedCalls => {
	switch (calls.shape) {
		case "set":
			return {
				shape: "set",
				once: onceAt(offset, calls.once),
				watch: streamAt(offset, calls.watch)
			}
		case "list":
			return {
				shape: "list",
				once: onceAt(offset, calls.once),
				watch: streamAt(offset, calls.watch)
			}
		case "answeredSet":
			return {
				shape: "answeredSet",
				once: onceAt(offset, calls.once),
				answer: streamAt(offset, calls.answer)
			}
		case "answeredList":
			return {
				shape: "answeredList",
				once: onceAt(offset, calls.once),
				answer: streamAt(offset, calls.answer)
			}
		case "write":
			return {
				shape: "write",
				once: onceAt(offset, calls.once),
				watch: streamAt(offset, calls.watch)
			}
	}
}

/** A member's explains, each stating the offset `offset` reads (onceAt). */
const movedExplains = (explains: MemberExplains, offset: Effect.Effect<bigint>): MemberExplains => {
	switch (explains.kind) {
		case "read":
			return {
				kind: "read",
				explain: onceAt(offset, explains.explain),
				explainAnalyze: onceAt(offset, explains.explainAnalyze)
			}
		case "change":
			return { kind: "change", explain: onceAt(offset, explains.explain) }
		case "refresh":
			return explains
	}
}

/**
 * Whether a member's calls read the clock, and so state its offset: a change's, every one of which a moved file
 * declares it for (its stamps), and a read's whose program declares the clock's offset among its parameters (engine
 * check/clock.ts sourcedParams), a clocked read's; a refresh reads none.
 */
const readsClock = (member: LoadedMember): boolean => {
	switch (member.kind) {
		case "change":
			return true
		case "read":
		case "key":
		case "paged":
			return Arr.some(member.read.params, (param) => param.name === clockOffsetName)
		case "refresh":
			return false
	}
}

/**
 * A member's handle parts over a moved clock: one whose calls read the clock (readsClock) states the offset `offset`
 * reads at each call; every other member's are the served Db's own.
 */
const movedParts = (
	parts: MemberHandleParts,
	member: LoadedMember,
	offset: Effect.Effect<bigint>
): MemberHandleParts =>
	readsClock(member)
		? { calls: movedCalls(parts.calls, offset), explains: movedExplains(parts.explains, offset) }
		: parts

/**
 * Db.openMoved(role, options, offset): the Db of `role` opened with `options` as Db.open opens it, over a moved clock
 * (see the header): `offset`, read once at each call of a clocked read or a change, is the count of microseconds the
 * call's readings of the database's clock are moved past the instant its transaction began, PostgreSQL's own
 * resolution (a millisecond is 1000n), negative to move them back; a moved instant timestamptz cannot hold is
 * PostgreSQL's refusal of the call. Its role is a role of a served file compiled for a moved clock
 * (compileServedMoved), served by its login's DbLayer.
 */
export const openMoved = <R extends AnyRole, P>(
	role: ServedRole<R, P>,
	options: OpenOptions<R>,
	offset: Effect.Effect<bigint>
): Effect.Effect<DbOf<R, P>, OpenError, DbLayerService<R>> =>
	Effect.map(
		openedWith<R, P>(role, options, (ctx, held) =>
			handlesOf(held.role.members, (member) =>
				movedParts(memberHandleParts(ctx, held.sessions.login.tables, member), member, offset)
			)
		),
		(opened) => opened.db
	)
