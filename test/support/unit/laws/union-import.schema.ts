/**
 * The box union-import's properties share (test/unit/laws/union-import.test.ts, test/pg/laws/union-import.test.ts): its
 * stored relations, SnapStage contained in a union of rules that each read SnapStage's query as an import, at its own
 * level or from a level above, and the states drawn over it.
 */

import { type Gen, int, subset } from "@bjornpagen/testing/gen"
import { Array as Arr, String as Str } from "effect"
import { int4 } from "#compiler/public/fields.ts"
import { query, type Rule, v } from "#compiler/public/query.ts"
import { contained, derived, on, relation, schema } from "#compiler/public/schema.ts"

const Snap = relation("Snap", { child: int4, n: int4, at: int4 }, ["child", "n", "at"])

const Item = relation("Item", { child: int4, n: int4, stage: int4 }, ["child", "n"])

const Sess = relation("Sess", { child: int4, stage: int4 }, ["child", "stage"])

const Visit = relation("Visit", { child: int4, stage: int4, k: int4, at: int4 }, [
	"child",
	"stage",
	"k"
])

const Susp = relation("Susp", { child: int4, stage: int4, k: int4, at: int4 }, [
	"child",
	"stage",
	"k"
])

/** Every relation immutable and keyed by its child first, so the containment is unit-local, judged whole by child. */
const Base = schema("union_import", [Snap, Item, Sess, Visit, Susp], [])

/** The stored relations, by name: what a state writes. */
export const stored = { Snap, Item, Sess, Visit, Susp } as const

/** A state: each stored relation's rows, each a value per field. */
export type Facts = {
	readonly [R in keyof typeof stored]: ReadonlyArray<Readonly<Record<string, number>>>
}

/** A snapshot at its item's stage, where the child has a session of that stage: a join of three relations. */
const snaps = query(Base).rule((r) => {
	const { child, n, at } = v(Snap, "snap")
	const { stage } = v(Item, "item")
	return r
		.match(Snap, { child, n, at })
		.match(Item, { child, n, stage })
		.match(Sess, { child, stage })
		.find({ child, n, at, stage })
})

const SnapStage = derived("SnapStage", snaps)

/**
 * A rule of the union a snapshot is contained in, each reading `snaps` once, which navigation inlines into it: a visit
 * of the stage begun by the snapshot (`open`); a visit begun by it and suspended after it (`suspended`), a join of
 * one more relation; a visit begun after it (`late`).
 */
const visited = (r: Rule<typeof Base>) => {
	const { child, n, at, stage } = v(snaps, "snap")
	const { k, at: began } = v(Visit, "visit")
	return {
		matched: r.match(snaps, { child, n, at, stage }).match(Visit, { child, stage, k, at: began }),
		head: { child, n, at, stage, k, began },
		at,
		began,
		key: { child, stage, k }
	}
}

const open = (r: Rule<typeof Base>) => {
	const { matched, head, at, began } = visited(r)
	return matched.where(r.le(began, at)).find(head)
}

const suspended = (r: Rule<typeof Base>) => {
	const { matched, head, at, began, key } = visited(r)
	const { at: until } = v(Susp, "susp")
	return matched
		.match(Susp, { ...key, at: until })
		.where(r.le(began, at), r.le(at, until))
		.find(head)
}

const late = (r: Rule<typeof Base>) => {
	const { matched, head, at, began } = visited(r)
	return matched.where(r.lt(at, began)).find(head)
}

/** Every nonempty union of the three rules, in their order. */
export const unions = [
	"open",
	"suspended",
	"late",
	"open, suspended",
	"open, late",
	"suspended, late",
	"open, suspended, late"
] as const

export type Union = (typeof unions)[number]

/** The rules of a union, each its own read of `snaps`. */
const rulesOf = (union: Union) => {
	const q = query(Base)
	switch (union) {
		case "open":
			return q.rule(open)
		case "suspended":
			return q.rule(suspended)
		case "late":
			return q.rule(late)
		case "open, suspended":
			return q.rule(open).rule(suspended)
		case "open, late":
			return q.rule(open).rule(late)
		case "suspended, late":
			return q.rule(suspended).rule(late)
		case "open, suspended, late":
			return q.rule(open).rule(suspended).rule(late)
	}
}

/** How many rules a union holds. */
export const widthOf = (union: Union): number => Str.split(", ")(union).length

/** Where the containment is compiled: its own level, or a level that extends it. */
export const levels = ["own", "above"] as const

export interface Shape {
	readonly union: Union
	readonly level: (typeof levels)[number]
}

/** The schema of a shape: SnapStage contained in the union of its rules, at its own level or read from one above. */
export const unionSchemaOf = (shape: Shape) => {
	const InSession = derived("InSession", rulesOf(shape.union))
	const own = schema.extend(
		[Base],
		"union_import_1",
		[SnapStage, InSession],
		[
			contained(
				on(SnapStage, "child", "n", "at", "stage"),
				on(InSession, "child", "n", "at", "stage")
			)
		]
	)
	return shape.level === "own"
		? own
		: schema.extend([own], "union_import_2", [relation("Above", { id: int4 }, ["id"])], [])
}

const children = [1, 2] as const

const pairs = Arr.flatMap(children, (child) => Arr.map([1, 2], (n) => ({ child, n })))

const stagesOf = Arr.flatMap(children, (child) => Arr.map([1, 2], (stage) => ({ child, stage })))

const visitKeys = Arr.flatMap(stagesOf, (s) => Arr.map([1, 2], (k) => ({ ...s, k })))

/**
 * A drawn state of two children: snapshots of up to two of their four (child, n) pairs at one or two instants of 0 to 3,
 * each snapshotted pair's item at stage 1 or 2, one to four sessions, and up to five visits, each suspended or not, at
 * instants of 0 to 3.
 */
export const factsGen: Gen<Facts> = (s) => {
	const snapped = s.draw(subset(pairs, { min: 0, max: 2 }))
	const visits = Arr.map(s.draw(subset(visitKeys, { min: 0, max: 5 })), (key) => ({
		...key,
		at: s.draw(int(0, 3))
	}))
	return {
		Snap: Arr.flatMap(snapped, (p) =>
			Arr.map(s.draw(subset([0, 1, 2, 3], { min: 1, max: 2 })), (at) => ({ ...p, at }))
		),
		Item: Arr.map(snapped, (p) => ({ ...p, stage: s.draw(int(1, 2)) })),
		Sess: s.draw(subset(stagesOf, { min: 1, max: 4 })),
		Visit: visits,
		Susp: Arr.flatMap(visits, (visit) =>
			s.draw(int(0, 1)) === 1 ? [{ ...visit, at: s.draw(int(0, 3)) }] : []
		)
	}
}
