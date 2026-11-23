/** What the property of series.test.ts reads: its space, its fixture and the brute force it judges by. */

import { type Gen, int } from "@bjornpagen/testing/gen"
import { Logic, Num, Type } from "#compiler/public/compute.ts"
import { contract, pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { fixtureTemplate } from "#test/pg/reads/support.ts"

/** The contract a series' element is cast into: within [-20, 20]. */
const Small = contract("Small", pg.bigint, (x) => Num.within(x, -20n, 20n))

/** A relation holding a Small, so the installation installs its domain, which the element's cast is into. */
const Held = relation("Held", { id: pg.integer, small: Small }, ["id"])

export const Series = schema("Series", [Held], [])

/**
 * Each integer from the bigint parameter `lo` to the bigint parameter `hi`, each held within [-20, 20] by LEAST and
 * GREATEST with constants: the element, an exact integer, and the element cast into Small, which stands on the element's
 * interval, its ends' [-20, 20], with no guard.
 */
const elements = query(Series).rule((r) => {
	const top = Type.literal(pg.bigint, 20n)
	const bottom = Type.literal(pg.bigint, -20n)
	const low = Logic.greatest(Logic.least(r.param("lo", pg.bigint), top), bottom)
	const high = Logic.greatest(Logic.least(r.param("hi", pg.bigint), top), bottom)
	const s = r.series(low, high)
	const { at } = v(s, "element")
	return r.match(s, { at }).find({ at, small: Type.cast(at, Small) })
})

/** How the module's fixture is installed: its label and the programs its login's workload holds. */
export const seriesInstall = Object.freeze({ label: "series", programs: { elements } })

/** Series installed as `grizzle generate` drafts it, once per member: the template every case clones. */
export const seriesTemplate = fixtureTemplate(import.meta, Series, seriesInstall)

/** A series' parameters: each anywhere within [-25, 25], so past the clamp at either end and as often above the other. */
export const endsGen: Gen<readonly [number, number]> = (source) =>
	[source.draw(int(-25, 25)), source.draw(int(-25, 25))] as const

/** A parameter held within [-20, 20]. */
const clamp = (x: number): number => Math.min(Math.max(x, -20), 20)

/**
 * Each integer from lo to hi, each held within [-20, 20], both included, none where lo lies above hi: generate_series's
 * rows, by brute force.
 */
export const elementsOf = (lo: number, hi: number): Array<bigint> =>
	Array.from({ length: Math.max(clamp(hi) - clamp(lo) + 1, 0) }, (_, i) => BigInt(clamp(lo) + i))

export type Feature = "no element: low above high" | "one element" | "several elements"
