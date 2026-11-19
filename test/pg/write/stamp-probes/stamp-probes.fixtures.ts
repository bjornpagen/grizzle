/** What the property of stamp-probes.test.ts reads: its schema, its box and the write of a case. */

import { indices } from "@bjornpagen/grizzle-text/base/array"

import { element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { instant, pg } from "#compiler/public/fields.ts"
import { relation, schema } from "#compiler/public/schema.ts"

export const Log = relation("Log", { child: pg.integer, at: instant, note: pg.integer }, [
	"child",
	"at",
	"note"
])

export const build = (name: string) => schema(name, [Log], [])

export type Schema = ReturnType<typeof build>

/** A case: how many children the call stamps, how many rows each, and whether each child holds a head before it. */
interface Stamping {
	readonly children: 1 | 3 | 10
	readonly rows: 1 | 4
	readonly head: boolean
}

export const stampingGen: Gen<Stamping> = (source) => ({
	children: source.draw(element([1, 3, 10] as const)),
	rows: source.draw(element([1, 4] as const)),
	head: source.draw(element([false, true] as const))
})

export const situations = [
	"one child",
	"several children",
	"one row a child",
	"several rows a child",
	"a stored head",
	"no head"
] as const

export type Situation = (typeof situations)[number]

/** The call's rows: `rows` notes at each of `children` children, every instant left out. */
export const writeOf = (s: Schema, c: Stamping) =>
	ChangeSet.empty(s).insert(
		Log,
		Arr.flatMap(indices(c.children), (child) =>
			Arr.map(indices(c.rows), (note) => ({ child, note }))
		)
	)
