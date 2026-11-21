/** What the properties of apply.test.ts read: its spaces, models and helpers. */

import { element, type Gen } from "@bjornpagen/testing/gen"
import type { Need } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Record as Rec } from "effect"
import type { ServedDbContext } from "#adapter/db/context.ts"
import { memberCalls, variantOf } from "#adapter/db/handles.ts"
import type { ChangeCall, LoadedMember } from "#adapter/served/load.ts"
import type { ParamMap } from "#compiler/plan/common.ts"

import { assert, assertVariant } from "@bjornpagen/testing/assert"
import { login, relation, role, schema, wholeEntriesOf } from "#compiler/public/schema.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { answered, writeOnce } from "#test/support/calls.ts"
import * as W from "#test/support/fixtures/api/work.ts"
import { t3, t4, tMissing } from "#test/support/fixtures/golden/work.ts"
import { Id, type IdValue } from "#test/support/ids.ts"
import { installedTemplate } from "#test/support/install-migrate.ts"
import type { StateRow } from "#test/support/substrate/state.ts"
import { stringsOver } from "#test/unit/text/generators.ts"

export const counts = (relation: string, added: bigint, deleted: bigint, put: bigint) => ({
	relation,
	added,
	deleted,
	put
})

/**
 * The worked example's Work under `name`, and an extension of it by a relation of its own: a Db opened on the extension
 * has Work as its base level.
 */
export const levels = (name: string) => {
	const Base = schema(name, Rec.values(W.Work.relations), W.Work.statements)
	const Label = relation("Label", { task: Id }, ["task"])
	const Extended = schema.extend([Base], `${name}_1`, [Label], [])
	/**
	 * The app: a full role over Extended writing Work's stored relations but Account, so a write of Account is outside
	 * its write list, in its login.
	 */
	const app = role(Extended, "app", wholeEntriesOf(Extended), {
		write: ["Task", "AutomaticTask", "ManualTask", "TaskNote"]
	})
	return { Base, Extended, app, server: login(Extended, "server", [app]) }
}

/** The ChangeSet a value applies. */
type Change =
	| "empty"
	| "a Stream parameter, twice"
	| "a base level"
	| "outside the write list"
	| "a sibling"
	| "an extension"
	| "acquisition fails"

export const changes: Arr.NonEmptyReadonlyArray<Change> = [
	"empty",
	"a Stream parameter, twice",
	"a base level",
	"outside the write list",
	"a sibling",
	"an extension",
	"acquisition fails"
]

/** A note of a task: TaskNote's fact, keyed by its task. */
export interface Note {
	readonly task: IdValue
	readonly note: string
}

/** A note as TaskNote's stored state reads it. */
export const stored = (n: Note): StateRow => ({ task: n.task, note: n.note })

/**
 * A value of the space: its ChangeSet, and what its call states, each drawn: the base level's notes, of t3, t4 or
 * both, the Stream's wanted tasks, t3, t4 or both and maybe tMissing, which no Task holds, and the note the Stream's
 * member writes for each wanted task that exists.
 */
interface ApplyCase {
	readonly change: Change
	readonly notes: Arr.NonEmptyReadonlyArray<Note>
	readonly wanted: Arr.NonEmptyReadonlyArray<IdValue>
	readonly note: string
}

export type ApplyFeature =
	| Change
	| "both tasks noted"
	| "a wanted task no Task holds"
	| "an empty note"

/** A note's text: letters, a space, a line feed, a Latin-1 and a supplementary code point, the empty text among them. */
const noteText: Gen<string> = stringsOver(element([0x61, 0x7a, 0x20, 0x0a, 0xe9, 0x1f600]), 6)

export const applyCase: Gen<ApplyCase> = (source) => {
	const tasks = source.draw(element<Arr.NonEmptyReadonlyArray<IdValue>>([[t3], [t4], [t3, t4]]))
	const found = source.draw(element<Arr.NonEmptyReadonlyArray<IdValue>>([[t3], [t4], [t3, t4]]))
	return {
		change: source.draw(element(changes)),
		notes: Arr.map(tasks, (task): Note => ({ task, note: source.draw(noteText) })),
		wanted: source.draw(element([found, Arr.append(found, tMissing)])),
		note: source.draw(noteText)
	}
}

/**
 * How a change member's calls on `ctx` read their host inputs: its call's facts where it holds array members, else its
 * parameters alone.
 */
const callKindOf = (ctx: ServedDbContext, change: LoadedMember): ChangeCall["kind"] => {
	assertVariant(change, "kind", "change", "a ChangeSet loads as a change member")
	return variantOf(ctx, change.variants).call.kind
}

/** A change member of array members, applied on `ctx` with the call's facts. */
export const applied = (ctx: ServedDbContext, change: LoadedMember, facts: unknown) => {
	assert.equal(
		callKindOf(ctx, change),
		"facts",
		"a change member of array members takes its call's facts"
	)
	return answered(writeOnce(memberCalls(ctx, change))({ params: {}, facts }))
}

/** A change member of no array member, applied on `ctx` with `params`. */
export const appliedWith = (ctx: ServedDbContext, change: LoadedMember, params: ParamMap) => {
	assert.equal(
		callKindOf(ctx, change),
		"params",
		"a change member of no array member takes its parameters alone"
	)
	return answered(writeOnce(memberCalls(ctx, change))({ params, facts: {} }))
}

const declared = levels("Levels")

/** Extended installed once per member with its server login (install-migrate.ts installedTemplate). */
export const levelsTemplate = installedTemplate({
	declaredIn: import.meta,
	name: "apply levels",
	schema: declared.Extended,
	options: {
		ambient: ordinarySession,
		extensions: [],
		label: "apply_levels",
		logins: [declared.server]
	}
})

/** What the search built once before its cases (credential), now once per worker: every case on it reads it. */
export const credentialNeed = {
	key: "test/pg/transactions/apply.fixtures.ts credentialNeed",
	open: Effect.sync(() => {
		/** The login's credential, which a value turns off to fail an acquisition. */
		const credential = { ok: true }
		return Effect.succeed(credential)
	})
} as const satisfies Need<unknown>
