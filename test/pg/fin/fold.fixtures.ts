/** What the property of fold.test.ts reads: its space, models and seat. */

import { defined, nonEmpty } from "@bjornpagen/testing/assert"
import { element, type Gen } from "@bjornpagen/testing/gen"
import { type Oracle } from "@bjornpagen/testing/property"
import { Array as Arr, Option } from "effect"
import {
	type FoldFamily,
	type FoldStored,
	foldStoredFrom,
	foldStoredOf,
	foldedFrom,
	identityOf,
	type Planes
} from "#test/support/families/fold.ts"
import { FOLD_SPECS, type FoldSpec, type FoldVerdict } from "#test/support/pg/fin/folds.ts"
import { type EndFeature, seatTemplate } from "#test/support/pg/fin/installed.ts"
import { upTo } from "#test/support/up-to.ts"

/** A single junk accumulator of a family (the header's kinds), at a slot and a plane where it names one. */
type Junk =
	| { readonly kind: "none" }
	| { readonly kind: "a junk seed" }
	| {
			readonly kind: "a junk before" | "a junk after"
			readonly slot: number
			readonly plane: number
	  }
	| { readonly kind: "a junk end"; readonly plane: number }
	| { readonly kind: "a junk step"; readonly slot: number }

/** A junk kind as a feature, the first slot and the empty family told apart: the axis it is on. */
type JunkAxis =
	| "lawful"
	| "a junk seed"
	| "a junk before at the first slot"
	| "a junk before past the first slot"
	| "a junk after"
	| "a junk end"
	| "a junk end of an empty family"
	| "a junk step at the first slot"
	| "a junk step past the first slot"

export const axisOf = (junk: Junk, n: number): JunkAxis => {
	switch (junk.kind) {
		case "none":
			return "lawful"
		case "a junk seed":
			return "a junk seed"
		case "a junk before":
			return junk.slot === 0
				? "a junk before at the first slot"
				: "a junk before past the first slot"
		case "a junk after":
			return "a junk after"
		case "a junk end":
			return n === 0 ? "a junk end of an empty family" : "a junk end"
		case "a junk step":
			return junk.slot === 0 ? "a junk step at the first slot" : "a junk step past the first slot"
	}
}

/** A case: a family of owner 0, its members' value indices into the domain, and one junk or none. */
interface Sketch {
	readonly values: ReadonlyArray<number>
	readonly junk: Junk
}

/** Families of up to four members are written lawful; families of up to three also with every single junk. */
const box = { lawful: 4, junked: 3 } as const

const junksOf = (n: number, planes: number): ReadonlyArray<Junk> => [
	{ kind: "a junk seed" },
	...Arr.flatMap(
		upTo(n, (i) => i),
		(slot) =>
			Arr.flatMap(
				upTo(planes, (i) => i),
				(plane): ReadonlyArray<Junk> => [
					{ kind: "a junk before", slot, plane },
					{ kind: "a junk after", slot, plane }
				]
			)
	),
	...upTo(planes, (plane): Junk => ({ kind: "a junk end", plane })),
	...upTo(n, (slot): Junk => ({ kind: "a junk step", slot }))
]

export const sketchGen =
	(planes: number): Gen<Sketch> =>
	(source) => {
		const n = source.draw(element(nonEmpty(upTo(box.lawful + 1, (i) => i))))
		const values = Arr.map(
			upTo(n, (i) => i),
			() => source.draw(element([0, 1, 2, 3, 4] as const))
		)
		const junks: Arr.NonEmptyReadonlyArray<Junk> =
			n <= box.junked ? [{ kind: "none" }, ...junksOf(n, planes)] : [{ kind: "none" }]
		return { values, junk: source.draw(element(junks)) }
	}

/** A plane list with one plane replaced. */
const replacedPlane = (planes: Planes, plane: number, value: bigint): Planes =>
	nonEmpty(Arr.map(planes, (v, i) => (i === plane ? value : v)))

/** A sketch's family as its caller writes it: owner 0's members, each its value and whether its row is selected. */
export const familyOf = (spec: FoldSpec, sketch: Sketch): FoldFamily => ({
	owner: 0,
	members: Arr.map(sketch.values, (i, member) => ({
		member,
		x: Arr.getUnsafe(spec.domain, i),
		selected: Option.match(spec.selected, { onNone: () => true, onSome: (s) => s(i) })
	}))
})

export const storedOf = (spec: FoldSpec, sketch: Sketch): FoldStored => {
	const { members } = familyOf(spec, sketch)
	const lawful = foldStoredOf(spec.monoid, [{ owner: 0, members }])
	const junk = spec.carrier.junk
	const j = sketch.junk
	switch (j.kind) {
		case "none":
			return lawful
		case "a junk seed":
			return foldStoredFrom(
				spec.monoid,
				[{ owner: 0, members }],
				nonEmpty(Arr.map(identityOf(spec.monoid), junk))
			)
		case "a junk before":
		case "a junk after":
			return {
				owners: lawful.owners,
				rows: Arr.map(lawful.rows, (r) =>
					r.at !== j.slot
						? r
						: j.kind === "a junk before"
							? {
									...r,
									before: replacedPlane(r.before, j.plane, junk(Arr.getUnsafe(r.before, j.plane)))
								}
							: {
									...r,
									after: replacedPlane(r.after, j.plane, junk(Arr.getUnsafe(r.after, j.plane)))
								}
				)
			}
		case "a junk step":
			return {
				owners: lawful.owners,
				rows: Arr.map(lawful.rows, (r) => {
					if (r.at !== j.slot) {
						return r
					}
					const before = nonEmpty(Arr.map(r.before, junk))
					return {
						...r,
						before,
						after: Arr.getUnsafe(foldedFrom(spec.monoid, before, [r]).slots, 0).after
					}
				})
			}
		case "a junk end":
			return {
				owners: Arr.map(lawful.owners, (o) => ({
					...o,
					end: replacedPlane(o.end, j.plane, junk(Arr.getUnsafe(o.end, j.plane)))
				})),
				rows: lawful.rows
			}
	}
}

export type FoldFeature = `${string} ${JunkAxis} ${FoldVerdict}` | EndFeature

export const ORACLE: Oracle = {
	kind: "second-implementation",
	name: "the reference fold (test/support/families/fold.ts folded), exact, beside the fold's model of each installed native's moment (fold.ts foldPredicted)"
}

/** The fold the property searches: sum of int4 over an ordered family with named accumulators (folds.ts FOLD_SPECS). */
export const SPEC: FoldSpec = defined(
	Arr.findFirst(FOLD_SPECS, (s) => s.label === "sum of int4").pipe(Option.getOrUndefined),
	"the sum of int4 fold spec"
)

/** Its schema installed once per member (installed.ts seatTemplate), which its cases' seats clone. */
export const foldSeat = seatTemplate(import.meta, SPEC.schema, SPEC.label)
