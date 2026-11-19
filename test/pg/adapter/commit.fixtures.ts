/** What the properties of commit.test.ts read: its spaces, models and helpers. */

import { element, type Gen } from "@bjornpagen/testing/gen"
import { Option } from "effect"
import type { CallError } from "#compiler/live/index.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { query, v } from "#compiler/public/query.ts"
import { fixtureTemplate } from "#test/pg/reads/support.ts"
import * as W from "#test/support/fixtures/api/work.ts"

/** What the concurrent transaction does with what the apply read and wrote, and how it ends. */
export const concurrentKinds = ["nothing", "writes the read", "reads the written", "both"] as const

type Concurrent = (typeof concurrentKinds)[number]

export const ends = ["commits", "rolls back"] as const

type End = (typeof ends)[number]

/** Every concurrent transaction: what it does, and how it ends. */
export const concurrents: Gen<readonly [Concurrent, End]> = (source) =>
	[source.draw(element(concurrentKinds)), source.draw(element(ends))] as const

export type CommitFeature =
	| `${Concurrent} ${End}`
	| "40001 at COMMIT"
	| "a serializable pair committed"

/** Whether a failure is SERIALIZABLE's refusal: the CallError `transient`, which is safe to retry. */
export const serializationRefused = (failure: Option.Option<CallError>): boolean =>
	Option.exists(failure, (error) => error.kind === "transient")

/** t1's note as workFacts stores it, and the one the concurrent transaction writes. */
export const stored = "check the feed"

export const changed = "changed"

/**
 * What every case installs: the worked example's Work, its full world's workload holding the apply as a change member,
 * a described member over a stored relation: a note at the target task copying the source's note.
 */
export const commitInstall = {
	label: "real",
	programs: {
		copy: ChangeSet.empty(W.Work).insert(
			W.TaskNote,
			query(W.Work).rule((r) => {
				const { note } = v(W.TaskNote, "taskNote")
				return r
					.match(W.TaskNote, {
						task: r.param("source", W.TaskNote.fields.task),
						note
					})
					.find({ task: r.param("target", W.TaskNote.fields.task), note })
			})
		)
	}
} as const

/** Work installed once per member (reads/support.ts fixtureTemplate), which each case's seat holds. */
export const commitTemplate = fixtureTemplate(import.meta, W.Work, commitInstall)
