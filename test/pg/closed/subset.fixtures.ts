/** What the property of subset.test.ts reads: its roster, its relation of a column per subset, its space and template. */

import type { NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import { type Gen, int, map } from "@bjornpagen/testing/gen"
import { Array as Arr, Record as Rec } from "effect"
import { type ClosedIdField, closedId, int4 } from "#compiler/public/fields.ts"
import { closed, relation, schema } from "#compiler/public/schema.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { fullWorldTemplate } from "#test/support/installed.ts"
import { fullWorld } from "#test/support/worlds.ts"

/** The roster's handles, in its order. */
const handles = ["p", "q", "r", "s"] as const

/** A handle of the roster. */
export type Handle = (typeof handles)[number]

/** The roster every column is a closed id of. */
export const Mark = closed.ordered("Mark", handles)

/**
 * Every subset of Mark's handles a closed id holds short of every handle, in the roster's order: the handles of each
 * mask of the four but none and all of them.
 */
export const subsets: ReadonlyArray<NonEmptyReadonlyArray<Handle>> = Arr.flatMap(
	Array.from({ length: 2 ** handles.length - 2 }, (_, at) => at + 1),
	(mask) => {
		const held = Arr.filter(handles, (_, at) => ((mask >> at) & 1) === 1)
		return Arr.isReadonlyArrayNonEmpty(held) ? [held] : []
	}
)

/** The column of the closed id holding `held`: its handles, in the roster's order. */
export const columnOf = (held: NonEmptyReadonlyArray<Handle>): string => Arr.join(held, "")

const columns: Readonly<Record<string, ClosedIdField<typeof Mark, Handle> | typeof int4>> = {
	id: int4,
	...Rec.fromEntries(Arr.map(subsets, (held) => [columnOf(held), closedId(Mark, { only: held })]))
}

/** A relation keyed by `id` with a column of a closed id of each subset. */
export const Marked = relation("Marked", columns, ["id"])

const Subsets = schema("Subsets", [Mark, Marked], [])

/** Subsets' full world, whose writer each case takes on. */
export const world = fullWorld(Subsets, {}, [])

/** Subsets installed once per member with its full world's login (install-migrate.ts installedTemplate). */
export const subsetsTemplate = fullWorldTemplate({
	declaredIn: import.meta,
	name: "subsets",
	fixture: Subsets,
	programs: {},
	contexts: [],
	label: "subsets",
	ambient: ordinarySession
})

/** What a case writes: a handle of the roster, by its code, into the column of a subset. */
export interface Write {
	readonly held: NonEmptyReadonlyArray<Handle>
	readonly handle: Handle
}

/** The box: every subset's column, every handle of the roster. */
export const writes: Gen<Write> = (s) => ({
	held: s.draw(map(int(0, subsets.length - 1), (at) => Arr.getUnsafe(subsets, at))),
	handle: s.draw(map(int(0, handles.length - 1), (at) => Arr.getUnsafe(handles, at)))
})

export type Feature = "stored" | "refused by the subset CHECK"
