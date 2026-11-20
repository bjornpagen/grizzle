/** What the properties of removal-plans.test.ts read: its spaces, models and helpers. */

import { element, type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr, Data } from "effect"
import type { Plan } from "#adapter/types/db.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { accumulated, drawn, natural, pg } from "#compiler/public/fields.ts"
import {
	contained,
	counted,
	fin,
	fold,
	Monoid,
	mutable,
	on,
	ordered,
	relation,
	schema
} from "#compiler/public/schema.ts"
import { judgedFixtureTemplate } from "#test/pg/reads/support.ts"

const Owner = relation(
	"Owner",
	{
		id: pg.integer,
		v: pg.integer,
		n: drawn(natural),
		n2: drawn(natural),
		e: accumulated(pg.integer, 0)
	},
	["id"]
)

const Other = relation(
	"Other",
	{ id: pg.integer, w: pg.integer, n: drawn(natural), e: accumulated(pg.integer, 0) },
	["id"]
)

const Member = relation(
	"Member",
	{
		member: pg.integer,
		g: pg.integer,
		h: pg.integer,
		x: pg.integer,
		c: accumulated(pg.integer, 0),
		d: accumulated(pg.integer, 0)
	},
	["member"]
)

const Second = relation("Second", { member: pg.integer, g: pg.integer }, ["member"])

const Order = relation("Order", { id: pg.integer, n: drawn(natural) }, ["id"])

const Line = relation("Line", { line: pg.integer, order: pg.integer, at: drawn(natural) }, ["line"])

const byOwner = counted(on(Member, "g"), fin(Owner, "n"))

const byOther = counted(on(Member, "h"), fin(Other, "n"))

const seconds = counted(on(Second, "g"), fin(Owner, "n2"))

const lines = ordered(on(Line, "order", "at"), fin(Order, "n"))

/**
 * Two owners of Member's two counted families, each column a member copies along its family's owner axis stepped by
 * the family's sum, so a put of either owner that changes it refills its members; a second counted family of Owner's;
 * and an ordered family. Every relation mutable, so a put updates in place and a delete re-places a sequence.
 */
export const Removals = schema(
	"removal_plans",
	[Owner, Other, Member, Second, Order, Line],
	[
		byOwner,
		byOther,
		seconds,
		lines,
		contained(on(Member, "g", "c"), on(Owner, "id", "v")),
		contained(on(Member, "h", "d"), on(Other, "id", "w")),
		fold(byOwner, Monoid.sum, on(Member, "g", "c"), on(Owner, "id", "e")),
		fold(byOther, Monoid.sum, on(Member, "h", "d"), on(Other, "id", "e")),
		mutable(Owner),
		mutable(Other),
		mutable(Member),
		mutable(Second),
		mutable(Order),
		mutable(Line)
	]
)

export const RELATIONS: Arr.NonEmptyReadonlyArray<string> = [
	"Owner",
	"Other",
	"Member",
	"Second",
	"Order",
	"Line"
]

const programs = Object.freeze({
	loadOwners: ChangeSet.empty(Removals).insert(Owner, []).insert(Other, []).insert(Order, []),
	loadMembers: ChangeSet.empty(Removals).insert(Member, []).insert(Second, []),
	removeAndMove: ChangeSet.empty(Removals).delete(Member, []).put(Member, []),
	twoWays: ChangeSet.empty(Removals).put(Owner, []).put(Other, []),
	editAndRefill: ChangeSet.empty(Removals).put(Owner, []).delete(Member, []),
	deleteLine: ChangeSet.empty(Removals).delete(Line, []),
	twoFamilies: ChangeSet.empty(Removals).delete(Member, []).delete(Second, [])
})

type Shape = "removed" | "two ways" | "edited and refilled" | "re-placed" | "recounted"

export const SHAPES: Arr.NonEmptyReadonlyArray<Shape> = [
	"removed",
	"two ways",
	"edited and refilled",
	"re-placed",
	"recounted"
]

/**
 * A case: a shape, the instance it writes over, of `owners` owners of each kind holding `members` members of each
 * family, and the owner `at` its rows are drawn at, the next owner after it the one a move or a second way names.
 */
export interface Sketch {
	readonly shape: Shape
	readonly owners: number
	readonly members: number
	readonly at: number
}

export const sketchGen: Gen<Sketch> = (source) => {
	const owners = source.draw(int(2, 4))
	return {
		shape: source.draw(element(SHAPES)),
		owners,
		members: source.draw(int(2, 3)),
		at: source.draw(int(0, owners - 1))
	}
}

export type Feature = `${Shape} read by index`

export const readByIndex = (shape: Shape): Feature => `${shape} read by index`

/** The relations a family statement reads stored rows of, by their declared names. */
const FAMILY_TABLES: ReadonlySet<string> = new Set(RELATIONS)

/** Every family table a node of `plan` reads by a sequential scan. */
export const seqScans = (plan: Plan): ReadonlyArray<string> => [
	...(plan.node === "Seq Scan" && plan.on.kind === "relation" && FAMILY_TABLES.has(plan.on.relation)
		? [plan.on.relation]
		: []),
	...Arr.flatMap(plan.children, seqScans)
]

/** Member `i` of owner `owner` in the instance of `s`, as stored: its key, its two groups and its x. */
export const memberOf = (s: Sketch, owner: number, i: number) => ({
	member: owner * s.members + i,
	g: owner,
	h: s.owners - 1 - owner,
	x: i
})

export class Disagreed extends Data.TaggedError("Disagreed")<{ readonly message: string }> {}

/** How the module's fixture is installed: its label and the programs its login's workload holds. */
export const removalsInstall = Object.freeze({ label: "removal_plans", programs })

/**
 * Removals installed as `grizzle generate` drafts it, once per member, its login planning under the judged settings over
 * relations never analyzed (reads/support.ts judgedFixtureTemplate): the template every case clones.
 */
export const removalsTemplate = judgedFixtureTemplate(import.meta, Removals, removalsInstall)
