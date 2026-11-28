/** What the property of zero-merge.test.ts reads: its fixture, its box and its model. */

import { type Gen, element } from "@bjornpagen/testing/gen"
import { Array as Arr, Order, Record as Rec } from "effect"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { fixtureTemplate } from "#test/support/pg/reads/support.ts"
import { type PlanShape, planShapeNames } from "#test/support/plan-shapes.ts"

/**
 * A float's two zeros under every operation that takes one value for several equal ones (check/merge.ts,
 * scalar/aggregate.ts), over two relations of a double precision field, F keyed by k in one group g, and G keyed by k:
 *
 * - a keyed read of F, which delivers each fact's own zero;
 * - a projection of F's x, a group of F keyed by x, a union of F's and G's keyed rows, a join of F and G on x, a
 *   recursion whose state holds F's rows and G's at F's keys, each a merge, which delivers +0 for either zero;
 * - F's min, max, sum and mean of x, IEEE 754-2019's: -0 below +0, a sum of zeros -0 exactly when each is.
 */
const F = relation("F", { k: pg.bigint, g: pg.bigint, x: pg["double precision"] }, ["k"])

const G = relation("G", { k: pg.bigint, x: pg["double precision"] }, ["k"])

export const Merges = schema("Merges", [F, G], [])

/** F's rows and G's at F's keys, the recursion's state, which its recursive UNION merges across its iterations. */
const reach = query(Merges).recursive("Reach", {
	row: { k: pg.bigint, x: pg["double precision"] },
	base: [
		(r) => {
			const { k, g, x } = v(F, "f")
			return r.match(F, { k, g, x }).find({ k, x })
		}
	],
	rec: [
		(r, self) => {
			const { k } = v(self, "self")
			const { x } = v(G, "g")
			return r.match(self, { k }).match(G, { k, x }).find({ k, x })
		}
	]
})

/** The reads a case holds to the model, each under its name in the workload, beside the load of its facts. */
const programs = Object.freeze({
	load: ChangeSet.empty(Merges).insert(F, []).insert(G, []),
	keyed: query(Merges).rule((r) => {
		const { k, g, x } = v(F, "f")
		return r.match(F, { k, g, x }).find({ k, x })
	}),
	projected: query(Merges).rule((r) => {
		const { k, g, x } = v(F, "f")
		return r.match(F, { k, g, x }).find({ x })
	}),
	grouped: query(Merges).rule((r) => {
		const { k, g, x } = v(F, "f")
		return r.match(F, { k, g, x }).find({ x, n: r.count() })
	}),
	extremes: query(Merges).rule((r) => {
		const { k, g, x } = v(F, "f")
		return r.match(F, { k, g, x }).find({ g, lo: r.min(x), hi: r.max(x) })
	}),
	totals: query(Merges).rule((r) => {
		const { k, g, x } = v(F, "f")
		return r.match(F, { k, g, x }).find({ g, sum: r.sum(x), mean: r.mean(x) })
	}),
	united: query(Merges)
		.rule((r) => {
			const { k, g, x } = v(F, "f")
			return r.match(F, { k, g, x }).find({ k, x })
		})
		.rule((r) => {
			const { k, x } = v(G, "g")
			return r.match(G, { k, x }).find({ k, x })
		}),
	joined: query(Merges).rule((r) => {
		const { k: a, g, x } = v(F, "f")
		const { k: b } = v(G, "g")
		return r.match(F, { k: a, g, x }).match(G, { k: b, x }).find({ a, b, x })
	}),
	reached: query(Merges).rule((r) => {
		const { k, x } = v(reach, "reach")
		return r.match(reach, { k, x }).find({ k, x })
	})
})

/** The reads a case holds to the model. */
export const reads = [
	"keyed",
	"projected",
	"grouped",
	"extremes",
	"totals",
	"united",
	"joined",
	"reached"
] as const satisfies ReadonlyArray<keyof typeof programs>
export type Read = (typeof reads)[number]

/** The zeros a float holds. */
const zeros: Arr.NonEmptyReadonlyArray<number> = [-0, 0]

/** The group every fact of F is in. */
const group = 7n

/**
 * A case: F's zeros in the order they are stored, k from 1, one or two, so a native min or max, which keeps the last of
 * two equal zeros a scan meets, meets them in each order; G's zero at k 1, or none; and the plan shape the reads run
 * under.
 */
export interface Sketch {
	readonly f: Arr.NonEmptyReadonlyArray<number>
	readonly g: ReadonlyArray<number>
	readonly shape: PlanShape
}

export const sketchGen: Gen<Sketch> = (source) => {
	const first = source.draw(element(zeros))
	const f: Arr.NonEmptyReadonlyArray<number> = source.draw(element([false, true]))
		? [first, source.draw(element(zeros))]
		: [first]
	const g: ReadonlyArray<number> = source.draw(element([false, true]))
		? [source.draw(element(zeros))]
		: []
	return { f, g, shape: source.draw(element(planShapeNames)) }
}

/** F's facts and G's of a case. */
export const factsOf = (s: Sketch) => ({
	F: Arr.map(s.f, (x, i) => ({ k: BigInt(i + 1), g: group, x })),
	G: Arr.map(s.g, (x, i) => ({ k: BigInt(i + 1), x }))
})

/** A merged float: +0 for either zero, IEEE 754's x + 0. */
const merged = (x: number): number => x + 0

/** IEEE 754's sum of the values, in their order: -0 exactly when each is -0. */
const ieeeSum = (xs: Arr.NonEmptyReadonlyArray<number>): number =>
	Arr.reduce(Arr.tailNonEmpty(xs), Arr.headNonEmpty(xs), (a, b) => a + b)

/** A delivered value written as its identity: a float's -0 apart from 0, a bigint by its digits. */
const textOf = (value: unknown): string =>
	typeof value === "number"
		? Object.is(value, -0)
			? "-0"
			: `${value}`
		: typeof value === "bigint"
			? `${value}n`
			: String(value)

/** A row as its identity: each field by its name and its value's identity. */
const rowText = (row: Readonly<Record<string, unknown>>): string =>
	Arr.join(
		Arr.map(Arr.sort(Rec.keys(row), Order.String), (name) => `${name}=${textOf(row[name])}`),
		" "
	)

/** A set of rows as the sorted identities of its distinct rows. */
export const setText = (rows: Iterable<Readonly<Record<string, unknown>>>): ReadonlyArray<string> =>
	Arr.sort(Arr.dedupe(Arr.map(Arr.fromIterable(rows), rowText)), Order.String)

/** The model's answer to each read, by the merged zero and IEEE 754-2019's aggregates. */
export const expected = (s: Sketch, read: Read): ReadonlyArray<string> => {
	const { F: f, G: g } = factsOf(s)
	switch (read) {
		case "keyed":
			return setText(Arr.map(f, ({ k, x }) => ({ k, x })))
		case "projected":
			return setText(Arr.map(f, ({ x }) => ({ x: merged(x) })))
		case "grouped":
			return setText([{ x: 0, n: BigInt(f.length) }])
		case "extremes":
			return setText([
				{
					g: group,
					lo: Arr.reduce(s.f, Number.POSITIVE_INFINITY, (a, x) => Math.min(a, x)),
					hi: Arr.reduce(s.f, Number.NEGATIVE_INFINITY, (a, x) => Math.max(a, x))
				}
			])
		case "totals": {
			const sum = ieeeSum(s.f)
			return setText([{ g: group, sum, mean: sum / s.f.length }])
		}
		case "united":
			return setText(Arr.map([...f, ...g], ({ k, x }) => ({ k, x: merged(x) })))
		case "joined":
			return setText(Arr.flatMap(f, (a) => Arr.map(g, (b) => ({ a: a.k, b: b.k, x: merged(a.x) }))))
		case "reached":
			return setText(Arr.map(f, ({ k, x }) => ({ k, x: merged(x) })))
	}
}

export type Feature = `${Read} under the ${PlanShape} plan`

export const features: Arr.NonEmptyReadonlyArray<Feature> = Arr.flatMap(
	planShapeNames,
	(shape): Arr.NonEmptyReadonlyArray<Feature> =>
		Arr.map(reads, (read): Feature => `${read} under the ${shape} plan`)
)

/** How the module's fixture is installed: its label and the programs its login's workload holds. */
export const mergesInstall = Object.freeze({ label: "zero_merge", programs })

/** Merges installed as `grizzle generate` drafts it, once per member: the template every case clones. */
export const mergesTemplate = fixtureTemplate(import.meta, Merges, mergesInstall)
