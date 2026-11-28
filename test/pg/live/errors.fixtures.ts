/** What the properties of errors.test.ts read: its spaces, models and helpers. */

import { assert, defined } from "@bjornpagen/testing/assert"
import { boolean, element, type Gen, int, weighted } from "@bjornpagen/testing/gen"
import { Array as Arr, Data, Effect, Option, Stream } from "effect"
import { memberCalls } from "#adapter/db/handles.ts"
import { openServed } from "#adapter/db/served.ts"
import type { ServedLogin } from "#adapter/types/layer.ts"
import type { CallError, CallErrorKind } from "#compiler/live/index.ts"
import { workload } from "#compiler/program/workload/value.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { int4 } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import {
	type AnyLogin,
	context,
	login,
	mutable,
	relation,
	role,
	schema,
	unit,
	wholeEntriesOf
} from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { errorOf } from "#test/support/live/calls.ts"
import type { RawEvent } from "#test/support/live/system.ts"

/** A call's body with no parameter and no fact, as a request writes it. */
export const emptyBody = `{"params":{},"facts":{}}`

/** What a call ended as: its error's class, or a success. */
export const outcomeKind = <A>(
	call: Effect.Effect<A, CallError>
): Effect.Effect<CallErrorKind | "succeeded"> =>
	Effect.match(call, {
		onFailure: (error): CallErrorKind | "succeeded" => error._tag,
		onSuccess: (): CallErrorKind | "succeeded" => "succeeded"
	})

export class Misclassified extends Data.TaggedError("Misclassified")<{ readonly report: string }> {}

/** The pattern `tagged`'s parameter is of. */
const Tag = str.regex("^[a-z]{1,8}$", "u")

/** Texts outside Tag's pattern: empty, past its length, of another letter case, script or character. */
const untagged = ["", "abcdefghi", "Abc", "a-b", "é", "a b"] as const

/** The notebook under `name`: its schema, its writer's login and the direct writer's. */
export const notebook = (name: string) => {
	const Session = context("Session", { sub: int4 })
	const Note = relation("Note", { id: int4, author: int4, body: int4 }, ["id"])
	const base = schema(name, [Note], [mutable(Note), unit("Noted", { id: int4 })])
	const mine = query(base).rule((r) => {
		const { id, author, body } = v(Note, "note")
		return r
			.match(Note, { id, author, body })
			.match(Session, { sub: author })
			.find({ id, author, body })
	})
	const writer = role(base, "writer", { MyNote: mine }, { write: ["MyNote"], contexts: [Session] })
	const { MyNote } = writer.relations
	const notes = query(writer).rule((r) => {
		const { id, author, body } = v(MyNote, "mine")
		return r.match(MyNote, { id, author, body }).find({ id, author, body })
	})
	const tagged = query(writer).rule((r) => {
		const { id, author, body } = v(MyNote, "mine")
		return r.match(MyNote, { id, author, body }).find({ id, tag: r.param("tag", Tag) })
	})
	const direct = role(base, "direct", wholeEntriesOf(base), { write: ["Note"] })
	return {
		schema: base,
		writer,
		direct,
		app: login(base, "app", [writer], {
			workload: [
				workload(writer, {
					notes,
					tagged,
					add: ChangeSet.empty(writer).insert(MyNote, []),
					edit: ChangeSet.empty(writer).put(MyNote, [])
				})
			]
		}),
		psql: login(base, "notes_psql", [direct])
	}
}

/** A failing call's class, as the case provokes it (see the header). */
type Fault =
	| "a path no program serves"
	| "a method other than POST"
	| "a body that is no JSON"
	| "a fact of another type"
	| "a parameter outside its pattern"
	| "a header that is no bearer token"
	| "no token"
	| "claims that do not decode"
	| "a stored note's id"
	| "a note of another author"
	| "an edit of a held note"

/**
 * The faults only an HTTP request carries: its path, method, body and header are the request's own, and a Db of a role
 * that reads a context opens with a token by its type.
 */
const httpOnly: ReadonlySet<Fault> = new Set<Fault>([
	"a path no program serves",
	"a method other than POST",
	"a body that is no JSON",
	"a header that is no bearer token",
	"no token"
])

/** The class each fault's meaning gives it (see the header). */
export const classOf = (fault: Fault): CallErrorKind => {
	switch (fault) {
		case "a path no program serves":
		case "a method other than POST":
			return "route"
		case "a body that is no JSON":
		case "a fact of another type":
			return "input"
		case "a parameter outside its pattern":
			return "paramRejected"
		case "a header that is no bearer token":
		case "no token":
		case "claims that do not decode":
			return "tokenRefused"
		case "a stored note's id":
			return "refused"
		case "a note of another author":
			return "outsideWorld"
		case "an edit of a held note":
			return "transient"
	}
}

interface Provoked {
	readonly fault: Fault
	readonly overHttp: boolean
	readonly sub: number
	readonly id: number
	readonly body: number
	readonly tag: (typeof untagged)[number]
}

const faultGen: Gen<Fault> = weighted<Fault>([
	[1, () => "a path no program serves"],
	[1, () => "a method other than POST"],
	[1, () => "a body that is no JSON"],
	[1, () => "a fact of another type"],
	[2, () => "a parameter outside its pattern"],
	[1, () => "a header that is no bearer token"],
	[1, () => "no token"],
	[1, () => "claims that do not decode"],
	[2, () => "a stored note's id"],
	[2, () => "a note of another author"],
	[2, () => "an edit of a held note"]
])

export const provokedGen: Gen<Provoked> = (source) => {
	const fault = source.draw(faultGen)
	return {
		fault,
		overHttp: httpOnly.has(fault) || source.draw(boolean),
		sub: source.draw(int(1, 3)),
		id: source.draw(int(1, 4)),
		body: source.draw(int(0, 9)),
		tag: source.draw(element(untagged))
	}
}

export type Feature =
	| CallErrorKind
	| "over HTTP"
	| "in process"
	| "a watch refused by its parameter's pattern"

/**
 * A watch of the read member `name` of the writer in process, its Db opened with `token` as a request handler opens one
 * (adapter/db/handles.ts memberCalls): the events it answers up to its first `ready` or `error`.
 */
export const watched = (file: ServedLogin<AnyLogin>, token: string, name: string, input: unknown) =>
	Effect.gen(function* () {
		const opened = yield* Effect.orDie(
			openServed(defined(file.roles["writer"], "the served role writer"), { token })
		)
		const member = defined(
			Option.getOrUndefined(Arr.findFirst(opened.role.members, (m) => m.name === name)),
			`the served member ${name}`
		)
		const calls = memberCalls(opened.ctx, member)
		if (calls.shape !== "list") {
			return yield* Effect.die(new Error(`the served member ${name} is no live read`))
		}
		return yield* Stream.runCollect(
			Stream.takeUntil(
				calls.watch(input),
				(event) => event._tag === "ready" || event._tag === "error"
			)
		)
	})

/** The error a call's raw answer ends with, its events being exactly that error and its end. */
export const rawError = (events: ReadonlyArray<RawEvent>) => {
	assert.deepEqual(
		Arr.map(events, (e) => e.type),
		["error", "end"],
		"a failing call's answer is its one error event and its end"
	)
	return errorOf(defined(events[0], "the error event"))
}
