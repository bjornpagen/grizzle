/** What the properties of acquire.test.ts read: its spaces, models and helpers. */

import { element, type Gen } from "@bjornpagen/testing/gen"
import { Effect, Exit, Option } from "effect"
import type { CallError } from "#compiler/live/index.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { query, v } from "#compiler/public/query.ts"
import { paged } from "#compiler/public/workload.ts"
import * as W from "#test/support/fixtures/api/work.ts"

type Call = "read" | "key" | "page" | "write"

type Unhad = "the password fails" | "the layer released"

export const point: Gen<readonly [Call, Unhad]> = (source) =>
	[
		source.draw(element<Call>(["read", "key", "page", "write"])),
		source.draw(element<Unhad>(["the password fails", "the layer released"]))
	] as const

export type AcquireFeature = `${Call}: ${Unhad}`

/** What the README says each way a connection can't be had fails a call with: its kind, its reason and its retry. */
export const unhadError: { readonly [U in Unhad]: readonly [string, string, string] } = {
	"the password fails": ["credentialRefused", "passwordFailed", "never"],
	"the layer released": ["unavailable", "layerReleased", "safe"]
}

/** A call's failure as the README states it: its kind, its reason where its kind holds one, and its retry. */
export const statedOf = (failure: CallError): ReadonlyArray<string> =>
	failure.kind === "credentialRefused"
		? [failure.kind, failure.reason, failure.retry]
		: failure.kind === "unavailable"
			? [failure.kind, failure.reason.kind, failure.retry]
			: [failure.kind, failure.retry]

/**
 * The full world's workload, one member per call that needs a session: a read of an account's automatic tasks, the
 * Task key's read, a page of every task by id, and a note written with the facts each call gives.
 */
export const programs = Object.freeze({
	automaticTasksFor: W.workReads(W.Work).automaticTasksFor,
	task: W.Task,
	tasks: paged(
		query(W.Work)
			.rule((r) => {
				const { id } = v(W.Task, "task")
				return r.match(W.Task, { id }).find({ id })
			})
			.orderBy(["id", "asc"])
	),
	note: ChangeSet.empty(W.Work).insert(W.TaskNote, [])
})

/** What a call failed with: its error, or the call's success, which no case here expects. */
export const failureOf = <A, E>(
	call: Effect.Effect<A, E>
): Effect.Effect<E | "the call succeeded" | undefined> =>
	Effect.map(Effect.exit(call), (exit) =>
		Exit.isSuccess(exit) ? "the call succeeded" : Option.getOrUndefined(Exit.findErrorOption(exit))
	)
