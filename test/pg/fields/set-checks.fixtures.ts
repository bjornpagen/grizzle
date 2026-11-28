/** What the property of set-checks.test.ts reads: the SetChecks fixture, its template, its checks restated, its sets. */
import { finite, subset } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { Bit, bit, int4 } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { check, closed, relation, schema } from "#compiler/public/schema.ts"
import { fixtureTemplate } from "#test/support/pg/reads/support.ts"

const handles = ["a", "b", "c"] as const
type Handle = (typeof handles)[number]
export const Flag = closed.ordered("Flag", handles)
const R = relation("R", { id: int4, flags: bit(Flag) }, ["id"])

/** The set value Apart holds R's flags apart from, the one Within holds them within, and Split's other side. */
const apartFrom: ReadonlyArray<Handle> = ["a"]
const withinOf: ReadonlyArray<Handle> = ["a", "b"]
const otherSide: ReadonlyArray<Handle> = ["b", "c"]
const apart = check("Apart", R, (r) => r.eq(Bit.disjoint(r.flags, Bit.of(Flag, apartFrom)), true))
const within = check("Within", R, (r) => r.eq(Bit.subset(r.flags, Bit.of(Flag, withinOf)), true))
const split = check("Split", R, (r) =>
	r.or([
		r.eq(Bit.subset(r.flags, Bit.of(Flag, withinOf)), true),
		r.eq(Bit.subset(r.flags, Bit.of(Flag, otherSide)), true)
	])
)
export const Sets = schema("SetChecks", [Flag, R], [apart, within, split])

/**
 * The full world's workload: a row of R written with the flags each call gives, and R's rows read back, whether the
 * flags miss b and their union with {c}, each against a set value.
 */
const programs = Object.freeze({
	write: ChangeSet.empty(Sets).insert(R, []),
	readBack: query(Sets).rule((r) => {
		const { id, flags } = v(R, "r")
		return r.match(R, { id, flags }).find({
			id,
			apart: Bit.disjoint(flags, Bit.of(Flag, ["b"])),
			joined: Bit.union(flags, Bit.of(Flag, ["c"]))
		})
	})
})

/** Every set over Flag's handles, as a finite space: each subset once, in the handles' order. */
export const allSets = finite(subset(handles, { min: 0, max: handles.length }))

/**
 * R's checks restated over plain Sets, the oracle: each check's statement beside whether a row's flags hold it, and the
 * situation of a row that breaks it alone.
 */
export const restated = [
	{
		statement: apart,
		holds: (flags: ReadonlySet<Handle>) => Arr.every(apartFrom, (h) => !flags.has(h)),
		alone: "refused by Apart"
	},
	{
		statement: within,
		holds: (flags: ReadonlySet<Handle>) =>
			Arr.every(Arr.fromIterable(flags), (h) => withinOf.includes(h)),
		alone: "refused by Within"
	},
	{
		statement: split,
		holds: (flags: ReadonlySet<Handle>) =>
			Arr.every(Arr.fromIterable(flags), (h) => withinOf.includes(h)) ||
			Arr.every(Arr.fromIterable(flags), (h) => otherSide.includes(h)),
		alone: "refused by Split"
	}
] as const

type Restated = (typeof restated)[number]

export type Situation = "accepted" | Restated["alone"] | "refused by several checks"

/** The situation of a row breaking `broken`, R's checks its flags break. */
export const situationOf = (broken: ReadonlyArray<Restated>): Situation => {
	const [only, ...others] = broken
	if (only === undefined) {
		return "accepted"
	}
	return Arr.isReadonlyArrayEmpty(others) ? only.alone : "refused by several checks"
}

/** How the module's fixture is installed: its label and the programs its login's workload holds. */
export const setsInstall = Object.freeze({ label: "setchecks", programs })

/** Sets installed as `grizzle generate` drafts it, once per member: the template every case clones. */
export const setsTemplate = fixtureTemplate(import.meta, Sets, setsInstall)
