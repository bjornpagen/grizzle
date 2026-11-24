/** What the properties of composition.test.ts read: their levels, the parts a case composes, and what a composition built. */

import { defined } from "@bjornpagen/testing/assert"
import { Array as Arr } from "effect"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import {
	changeSetOver as ChangeSet,
	changeSetState,
	type ChangeSetValue
} from "#compiler/write/changeset/value.ts"
import { containersOf, freshContainers } from "#test/support/containers.ts"
import { descOf } from "#test/unit/write/changeset/fixtures.ts"

/** The lower level's visits and what its members write of them; the app's stages, a level above. */
const Visit = relation("Visit", { child: pg.integer, stage: pg.integer }, ["child", "stage"])
const Out = relation("Out", { child: pg.integer, stage: pg.integer, n: pg.integer }, [
	"child",
	"stage",
	"n"
])
const Stage = relation("Stage", { child: pg.integer, key: pg.integer }, ["child", "key"])
const Lower = schema("CompositionLower", [Visit, Out], [])
const Upper = schema.extend([Lower], "CompositionUpper", [Stage], [])

const sittingHeading = { child: Visit.fields.child, stage: Visit.fields.stage } as const

/** The child's own stages, the guard every part binds its sittings to. */
const guard = query(Upper).rule((r) => {
	const { child, key: stage } = v(Stage, "own")
	return r
		.match(Stage, { child, key: stage })
		.where(r.eq(child, r.param("child", pg.integer)))
		.find({ child, stage })
})

/**
 * The open visits of the sittings, through a chain of `depth` imports, each level the one below's visits at least at
 * its level's stage: what a part's member imports, its size the chain's.
 */
const chainOf = (depth: number) =>
	Arr.reduce(
		Array.from({ length: depth - 1 }, (_, k) => k + 1),
		query(Lower).rule((r) => {
			const sittings = r.relation("sittings", sittingHeading)
			const { child, stage } = v(sittings, "sitting")
			return r
				.match(sittings, { child, stage })
				.match(Visit, { child, stage })
				.find({ child, stage })
		}),
		(below, level) =>
			query(Lower).rule((r) => {
				const held = below.bind({ sittings: r.relation("sittings", sittingHeading) })
				const { child, stage } = v(held, "sitting")
				return r.match(held, { child, stage }).where(r.ge(stage, level)).find({ child, stage })
			})
	)

/**
 * The `i`-th part: one insert into Out of the visits of its sittings through a chain `depth` deep, each at its own
 * parameter `n<i>` and held by `conditions` conditions that read no sittings, the sittings bound to the guard.
 */
export const partOf = (i: number, depth: number, conditions: number): ChangeSetValue => {
	const chain = chainOf(depth)
	return ChangeSet.empty(Lower)
		.insert(
			Out,
			query(Lower).rule((r) => {
				const held = chain.bind({ sittings: r.relation("sittings", sittingHeading) })
				const { child, stage } = v(held, "visit")
				const n = r.param(`n${i}`, pg.integer)
				return Arr.reduce(
					Array.from({ length: conditions }, (_, c) => c),
					r.match(held, { child, stage }),
					(rule, c) => rule.where(r.ge(n, -1 - c))
				).find({ child, stage, n })
			})
		)
		.bind({ sittings: guard })
}

/** The member states of a ChangeSet, every stratum's. */
export const membersOf = (value: ChangeSetValue): ReadonlyArray<object> =>
	defined(changeSetState(value), "a ChangeSet's state").strata.flat()

/** The names a ChangeSet binds privately. */
export const boundNames = (value: ChangeSetValue): ReadonlyArray<string> => [
	...defined(changeSetState(value), "a ChangeSet's state").bound.keys()
]

/** The member states of `combined` that are none of `parts`' own: the ones its composition rebuilt. */
export const rebuiltMembers = (
	combined: ChangeSetValue,
	parts: ReadonlyArray<ChangeSetValue>
): number => {
	const carried = new Set(Arr.flatMap(parts, membersOf))
	return Arr.filter(membersOf(combined), (m) => !carried.has(m)).length
}

/** The containers of `combined`'s Description that are none of `parts`' Descriptions': the ones its composition built. */
export const builtContainers = (
	combined: ChangeSetValue,
	parts: ReadonlyArray<ChangeSetValue>
): number =>
	freshContainers(
		descOf(combined),
		Arr.reduce(parts, new Set<object>(), (known, part) => containersOf(descOf(part), known))
	)

/** How a case composes its parts with unions: each into the union of the ones before, or pairwise, halving each round. */
export type Tower = "left-deep" | "balanced"

/** The unions of a tower of `parts`, each with the two it unites, in the order the tower makes them. */
export const unionsOf = (
	tower: Tower,
	parts: ReadonlyArray<ChangeSetValue>
): ReadonlyArray<{
	readonly union: ChangeSetValue
	readonly of: readonly [ChangeSetValue, ChangeSetValue]
}> => {
	const made: Array<{
		readonly union: ChangeSetValue
		readonly of: readonly [ChangeSetValue, ChangeSetValue]
	}> = []
	const unite = (a: ChangeSetValue, b: ChangeSetValue): ChangeSetValue => {
		const union = ChangeSet.union(a, b)
		made.push({ union, of: [a, b] })
		return union
	}
	const round = (level: ReadonlyArray<ChangeSetValue>): ChangeSetValue =>
		level.length === 1
			? defined(level[0], "the tower's top")
			: round(
					Arr.map(Arr.chunksOf(level, 2), ([first, second]) =>
						second === undefined ? first : unite(first, second)
					)
				)
	if (tower === "left-deep") {
		Arr.reduce(Arr.drop(parts, 1), defined(parts[0], "a first part"), unite)
	} else {
		round(parts)
	}
	return made
}
