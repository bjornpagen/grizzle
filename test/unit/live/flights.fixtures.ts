/** What the properties of flights.test.ts read: its spaces, models and helpers. */

import { defined } from "@bjornpagen/testing/assert"
import { Array as Arr, Effect, Exit, Stream } from "effect"
import type { ServedDbContext } from "#adapter/db/context.ts"
import { type ServedCalls } from "#adapter/db/handles.ts"
import type { ChangeSource } from "#adapter/live/source.ts"
import { loadServed } from "#adapter/served/load.ts"
import { type CallError, type CallErrorKind } from "#compiler/live/index.ts"
import { workload } from "#compiler/program/workload/value.ts"
import { closedId, int4 } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { closed, login, relation, role, schema, wholeEntriesOf } from "#compiler/public/schema.ts"
import { servedFile } from "#compiler/served/json.ts"
import { succeeded } from "#test/support/assert.ts"
import { compiledServedFile } from "#test/support/compiled-served.ts"
import { fatalStates, fenceRefusal } from "#test/support/flight/model.ts"
import {
	answeringScript,
	immediateDelivery,
	rows,
	scriptedSession,
	sentSql,
	type StatementAnswer
} from "#test/support/flight/scripted.ts"
import { nothingReported, serverError } from "#test/support/server-error.ts"
import { upTo } from "#test/support/up-to.ts"

const Sitting = relation("Sitting", { id: int4, student: int4, week: int4 }, ["id"])

const Kind = closed.ordered("Kind", ["light", "heavy"])

const Weights = closed.relation(
	"Weights",
	{ kind: closedId(Kind), weight: int4 },
	["kind"],
	[
		{ kind: "light", weight: 1 },
		{ kind: "heavy", weight: 2 }
	]
)

const Edu = schema("Edu", [Sitting, Kind, Weights], [])

const app = role(Edu, "app", wholeEntriesOf(Edu))

const sittingsOf = query(Edu).rule((r) => {
	const { id, week } = v(Sitting, "sitting")
	return r.match(Sitting, { id, student: r.param("student", int4), week }).find({ id, week })
})

const server = login(Edu, "server", [app], {
	workload: [
		workload(app, {
			sittings: sittingsOf,
			ordered: sittingsOf.orderBy(["week", "asc"], ["id", "asc"]),
			weight: Weights
		})
	]
})

/** The fixture's login, loaded from its served file as a layer loads it. */
export const loaded = succeeded(
	loadServed(succeeded(servedFile(compiledServedFile(server)), "the served file"), "server")
)

export const loadedApp = defined(loaded.roles[0], "the role app")

export type Member = "sittings" | "ordered" | "weight"

/** A case's one fault (see the header). */
export type Fault =
	| { readonly kind: "none" }
	| { readonly kind: "statement refused"; readonly sqlstate: "40001" | "40P01" | "23505" }
	| { readonly kind: "statement fatal" }
	| { readonly kind: "statement lost" }
	| { readonly kind: "COMMIT refused" }
	| { readonly kind: "COMMIT lost" }
	| { readonly kind: "fence refused by a migration" }
	| { readonly kind: "no session" }

interface Case {
	readonly member: Member
	readonly rows: number
	readonly fault: Fault
}

/**
 * The class a fault's meaning gives a failed read (see the header): a read commits nothing, so its lost connection is
 * transport wherever it came.
 */
export const meaningOf = (fault: Exclude<Fault, { readonly kind: "none" }>): CallErrorKind => {
	switch (fault.kind) {
		case "statement refused":
			return fault.sqlstate === "23505" ? "failed" : "transient"
		case "statement fatal":
			return "transport"
		case "COMMIT refused":
			return "transient"
		case "statement lost":
		case "COMMIT lost":
			return "transport"
		case "fence refused by a migration":
			return "stale"
		case "no session":
			return "unavailable"
	}
}

/** The retry the meaning of a class gives it: safe where nothing committed and the failure was not the call's own. */
export const retryOf = (kind: CallErrorKind): "safe" | "never" => {
	switch (kind) {
		case "transient":
		case "transport":
		case "unavailable":
		case "tokenExpired":
			return "safe"
		case "route":
		case "input":
		case "paramRejected":
		case "tokenRefused":
		case "refused":
		case "outsideWorld":
		case "credentialRefused":
		case "stale":
		case "commitUnknown":
		case "failed":
			return "never"
	}
}

/**
 * A scripted session of a case, one a lease opens: its member's statement answers its rows or its fault; the prologue
 * answers. Each lease opens its own, as a pool's next session is another after a lost one is retired, so once meets the
 * fault its watch met.
 */
export const sessionOf = (c: Case, ctx: Pick<ServedDbContext, "prologue">) => {
	const fault = c.fault
	const prologue = new Set<string>([ctx.prologue.fence.text.sql, ctx.prologue.enter.sql])
	const answer = (sql: string): StatementAnswer => {
		if (prologue.has(sql)) {
			return fault.kind === "fence refused by a migration" && sql === ctx.prologue.fence.text.sql
				? {
						_tag: "refused",
						error: serverError({ ...nothingReported, sqlstate: fenceRefusal("lock", "migrating") })
					}
				: rows([])
		}
		switch (fault.kind) {
			case "statement refused":
				return {
					_tag: "refused",
					error: serverError({ ...nothingReported, sqlstate: fault.sqlstate })
				}
			case "statement fatal":
				return {
					_tag: "fatal",
					error: serverError({ ...nothingReported, sqlstate: fatalStates[0] })
				}
			case "statement lost":
				return { _tag: "lose" }
			case "none":
			case "COMMIT refused":
			case "COMMIT lost":
			case "fence refused by a migration":
			case "no session":
				return c.member === "weight"
					? rows([])
					: rows(upTo(c.rows, (k) => [`${k + 1}`, `${k + 1}`]))
		}
	}
	return scriptedSession(
		{
			...answeringScript,
			statement: (query) => answer(sentSql(query)),
			commit: () =>
				fault.kind === "COMMIT refused"
					? serverError({ ...nothingReported, sqlstate: "40001" })
					: fault.kind === "COMMIT lost"
						? "lose"
						: undefined
		},
		immediateDelivery
	)
}

/** A change source that opens and reports no change, so a registered read is never marked. */
export const silent: ChangeSource = { open: () => Effect.void }

/** One event of an answer as the properties read it: its kind, and an error event's CallError. */
interface Answered {
	readonly _tag: string
	readonly error: CallError | undefined
}

/**
 * A member's watch, run to its first `ready` or its `end`, each event read as Answered, whatever the answer's shape: a
 * write's answer ends at its outcome's `end`, and a read's, live, waits after its `ready` for a change none reports.
 */
export const answerOf = (
	calls: ServedCalls,
	input: unknown
): Effect.Effect<ReadonlyArray<Answered>> => {
	const read = <E extends { readonly _tag: string }>(
		events: Stream.Stream<E>,
		errorOf: (event: E) => CallError | undefined
	) =>
		Effect.map(
			Stream.runCollect(Stream.takeUntil(events, (e) => e._tag === "ready" || e._tag === "end")),
			(all) => Arr.map(all, (e): Answered => ({ _tag: e._tag, error: errorOf(e) }))
		)
	switch (calls.shape) {
		case "list":
			return read(calls.watch(input), (e) => (e._tag === "error" ? e.error : undefined))
		case "answeredList":
			return read(calls.answer(input), (e) => (e._tag === "error" ? e.error : undefined))
		case "write":
			return read(calls.watch(input), (e) => (e._tag === "error" ? e.error : undefined))
	}
}

/** A member's once, its value dropped: how it ended. */
export const onceOf = (
	calls: ServedCalls,
	input: unknown
): Effect.Effect<Exit.Exit<void, CallError>> => {
	switch (calls.shape) {
		case "list":
			return Effect.exit(Effect.asVoid(calls.once(input)))
		case "answeredList":
			return Effect.exit(Effect.asVoid(calls.once(input)))
		case "write":
			return Effect.exit(Effect.asVoid(calls.once(input)))
	}
}

export type Feature =
	| Member
	| Fault["kind"]
	| "a read of rows"
	| "a read of none"
	| "a watch of a closed-only read"
