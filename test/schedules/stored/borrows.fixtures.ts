/**
 * What test/schedules/stored/borrows.test.ts reads: its schema, its writers' workload, its cases and the rule each case
 * is held to.
 */

import { element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Result } from "effect"
import type { CallError, WriteOutcome } from "#compiler/live/index.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { derived, login, relation, role, schema, unit } from "#compiler/public/schema.ts"
import { workload } from "#compiler/public/workload.ts"
import type { WriteAnswer } from "#test/support/calls.ts"
import { rigTemplate } from "#test/support/schedules/rig.ts"

/** A document's places, in the unit of the document. */
export const Doc = relation("Doc", { doc: pg.integer, at: pg.integer }, ["doc", "at"])

/**
 * The schema: Doc in the unit Document(doc), and a level above it holding Counted, each document's number of places, a
 * stored derived relation local to the document, its primary key its document; the role `writer`, which inserts Doc
 * and nothing else, its workload `put`, an insertion of Doc's rows the call states, and its two logins.
 */
export const stored = (name: string) => {
	const base = schema(name, [Doc], [unit("Document", { doc: pg.integer })])
	const Counted = derived(
		"Counted",
		query(base).rule((r) => {
			const { doc, at } = v(Doc, "d")
			return r.match(Doc, { doc, at }).find({ doc, places: r.count() })
		})
	)
	const top = schema.extend([base], `${name}_top`, [Counted], [])
	const writer = role(top, "writer", { Doc }, { insert: ["Doc"] })
	const direct = role(top, "direct", { Doc })
	return {
		schema: top,
		Counted,
		writer,
		direct,
		server: login(top, "server", [writer], {
			workload: [workload(writer, { put: ChangeSet.empty(base).insert(Doc, []) })]
		}),
		psql: login(top, "psql", [direct])
	}
}

/** The schedule's installation made once per member (support/schedules/rig.ts rigTemplate), which each case's seat holds. */
export const storedRig = rigTemplate(import.meta, "stored_borrows", stored)

/** A document of the case. */
export type DocOf = 1 | 2

/**
 * A case: the places each document holds before the calls, at 0 on, and the document each writer's call puts one place
 * at, A's at 10 and B's at 11, so the two never meet at a key of Doc.
 */
export interface StoredCase {
	readonly seeded: { readonly 1: 0 | 1 | 2; readonly 2: 0 | 1 | 2 }
	readonly a: DocOf
	readonly b: DocOf
}

export const storedCaseGen: Gen<StoredCase> = (source) => ({
	seeded: {
		1: source.draw(element([0, 1, 2] as const)),
		2: source.draw(element([0, 1, 2] as const))
	},
	a: source.draw(element([1, 2] as const)),
	b: source.draw(element([1, 2] as const))
})

/** The seeded rows as Doc's VALUES tuples, by its columns (doc, at). */
export const seededTuples = (c: StoredCase): ReadonlyArray<string> =>
	Arr.flatMap([1, 2] as const, (doc) =>
		Array.from({ length: c.seeded[doc] }, (_, at) => `(${doc}, ${at})`)
	)

/**
 * Counted as the rule gives it after both calls: each document's places, the seeded ones and one for each call that
 * put a place there, a document holding none absent.
 */
export const countedAfter = (c: StoredCase): Array<string> =>
	Arr.flatMap([1, 2] as const, (doc) => {
		const places = c.seeded[doc] + (c.a === doc ? 1 : 0) + (c.b === doc ? 1 : 0)
		return places === 0 ? [] : [`${doc}:${places}`]
	})

/** A call's answer, with how many times it ran before it ended other than in a TransientFailure. */
interface Answered {
	readonly tries: number
	readonly ran: Result.Result<WriteAnswer<WriteOutcome<unknown>>, CallError>
}

/** `call` run until it ends other than in a TransientFailure, each run counted. */
export const untilAnswered = (call: Effect.Effect<WriteAnswer<WriteOutcome<unknown>>, CallError>) =>
	Effect.gen(function* () {
		for (let tries = 1; ; tries++) {
			const ran = yield* Effect.result(call)
			if (Result.isSuccess(ran) || ran.failure.kind !== "transient") {
				return { tries, ran } satisfies Answered
			}
		}
	})
