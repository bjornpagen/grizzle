/** What the properties of fold.test.ts read: its spaces, models and helpers. */

import { type Oracle } from "@bjornpagen/testing/explore"
import { element, type Gen } from "@bjornpagen/testing/gen"
import { type Kill } from "@bjornpagen/testing/property"
import { Array as Arr, Option, Record as Rec } from "effect"
import { accumulated, drawn, natural, pg } from "#compiler/public/fields.ts"
import { fin, fold, Monoid, on, relation, schema, tree } from "#compiler/public/schema.ts"
import { FOLD_SPECS, type FoldSpec, type FoldVerdict } from "#test/pg/fin/folds.ts"
import { type EndFeature, seatTemplate } from "#test/pg/fin/installed.ts"
import { forestsOf, type TreeRow } from "#test/pg/substrate/tree.ts"
import { nonEmpty } from "#test/support/assert.ts"
import {
	type FoldFamily,
	type FoldStored,
	foldStoredFrom,
	foldStoredOf,
	foldedFrom,
	identityOf,
	type Planes
} from "#test/support/families/fold.ts"
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

/**
 * The features a seat must reach: lawful commits, each junk refused by the native that owns its axis, and each end of a
 * case, each meeting a refusal at the commit (installed.ts End).
 */
export const requiredOf = (spec: FoldSpec): ReadonlyArray<FoldFeature> => {
	const l = spec.label
	return [
		"a case ended by COMMIT",
		"a case ended by SET CONSTRAINTS and ROLLBACK",
		"a case refused at a real COMMIT",
		"a case refused at its checked commit",
		`${l} lawful committed`,
		`${l} a junk seed refused first slot`,
		`${l} a junk end of an empty family refused empty family`,
		`${l} a junk after refused combine`,
		`${l} a junk before past the first slot refused combine`,
		`${l} a junk end refused last axis`,
		`${l} a junk step at the first slot refused first slot`,
		`${l} a junk step past the first slot refused predecessor axis`
	]
}

/** The tree folded by count over each node's children: its accumulators named, its root outside the family. */
const FoldedNode = relation(
	"Node",
	{
		doc: pg.integer,
		parent: drawn(natural),
		at: drawn(natural),
		children: drawn(natural),
		start: drawn(natural),
		end: drawn(natural),
		before: accumulated(natural, 0n),
		after: accumulated(natural, 0n),
		total: accumulated(natural, 0n)
	},
	["doc", "start"]
)

const FoldedTree = (() => {
	const t = tree(on(FoldedNode, "parent", "at"), fin(FoldedNode, "children"), { root: ["doc"] })
	return schema(
		"fin_fold_tree",
		[FoldedNode],
		[
			t,
			fold(
				t,
				Monoid.count,
				on(FoldedNode, "doc", "parent", "before", "after"),
				on(FoldedNode, "doc", "start", "total")
			)
		]
	)
})()

/** A folded tree row: the tree's row and its count fold's before, after and total. */
export interface FoldedRow extends TreeRow {
	readonly before: number
	readonly after: number
	readonly total: number
}

export const TREE_COLUMNS = [
	"doc",
	"parent",
	"at",
	"children",
	"start",
	"end",
	"‹n›",
	"before",
	"after",
	"total"
] as const

/** Each fold spec's schema installed once per member (installed.ts seatTemplate), which its cases' seats clone. */
export const foldSeats = Rec.fromEntries(
	Arr.map(
		FOLD_SPECS,
		(spec) => [spec.label, seatTemplate(import.meta, spec.schema, spec.label)] as const
	)
)

/**
 * The bugs a fold spec's search must catch: sum of int4's, the first slot's pin and the empty family's pin left
 * uninstalled (plan.ts #pin), where its Vitest search planted each by dropping the installed constraint from a seat of
 * its own; every other spec's none.
 */
export const killsOf = (spec: FoldSpec): ReadonlyArray<Kill> =>
	spec.label === "sum of int4"
		? [
				{
					file: "packages/engine/src/laws/model/plan.ts",
					original: '\t\tif (start === undefined || axis === "owner") {',
					replacement:
						'\t\tif (start === undefined || axis === "owner" || axis === "predecessor") {',
					why: "The first slot's pin left out: a junk seed of a family's first member commits."
				},
				{
					file: "packages/engine/src/laws/model/plan.ts",
					original: '\t\tif (start === undefined || axis === "owner") {',
					replacement: '\t\tif (start === undefined || axis === "owner" || axis === "last") {',
					why: "The empty family's pin left out: a junk end of an empty family commits."
				}
			]
		: []

/** Every tree and forest of two trees of at most four rows. */
const forests = nonEmpty(forestsOf(4), "a forest")

/** A forest of the box, drawn. */
export const forestGen: Gen<ReadonlyArray<TreeRow>> = element(forests)

export type RootFeature = "a root's one state committed" | "a root's other states refused"

/** The folded tree's schema installed once per member (installed.ts seatTemplate), which its cases' seats clone. */
export const foldTree = seatTemplate(import.meta, FoldedTree, "fold tree")
