/**
 * The installation's compile does per-relation work linear in the schema: over the compile benchmark's generated
 * schema (bench/compile/schema.ts), shaped as a downstream grammar is, at half, one and twice a scale, every count of
 * which doubles from each to the next, the compile (the checked schema, the theory and the law model lawsOf reads, and
 * the installation with its declared statistics) makes no more than 2.1 times the calls at twice the schema in each
 * module whose work for a relation once scanned the whole schema: analysis/schema.ts, whose writings of a relation read
 * every statement for the families that cascade into it (CheckedSchema #inPlace), and physical/statistics/statistics.ts,
 * whose shape of a relation read every native, key, index and containment of the installation (Grouped); and the
 * schema's builders make no more than 2.1 times the calls in public/fields.ts, whose closed id over a roster copied the
 * roster's handles it holds for each field, though it restricted none (closedId). A scan of the schema for each relation
 * grows with the square of the schema, four times the calls at twice it. And the families that
 * cascade into a relation are read once a checked schema (analysis/schema.ts cascadedMembers), as many times at every
 * scale.
 *
 * The count is work, never time: V8's precise coverage counts every function's calls in each module (kernel/calls.ts
 * everyCallCount). The box is exhausted: the scale at its base and at twice the base.
 *
 * Features: the base scale, twice the base.
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { finite, int } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, String as Str } from "effect"
import { generatedSchema, type Scale } from "#bench/compile/schema.ts"
import { firstCodebook } from "#compiler/ir/codes.ts"
import { completeInstallOptions } from "#compiler/physical/complete.ts"
import { compileInstallation } from "#compiler/physical/install/compile.ts"
import { installationsOf, rostersOf } from "#compiler/schema/own.ts"
import { succeeded } from "#test/support/assert.ts"
import { everyCallCount } from "#test/support/kernel/calls.ts"
import { ownedInput } from "#test/support/policy.ts"

type ScaleFeature = "the base scale" | "twice the base"

/** The modules whose per-relation work the property counts, each by its path in the repository. */
const counted = {
	fields: "packages/engine/src/public/fields.ts",
	schema: "packages/engine/src/analysis/schema.ts",
	statistics: "packages/engine/src/physical/statistics/statistics.ts"
} as const

/**
 * The scale at `base` times the least: closed relations of at most as many rows as their two rosters' handles pair at
 * half the scale, so every row is a pair of handles.
 */
const scaleAt = (base: number, factor: number): Scale => ({
	handles: 40 * base * factor,
	relations: 12 * base * factor,
	rows: 800 * base * factor,
	patterns: 12 * base * factor
})

/** The calls the installation's compile of the generated schema at `scale` makes in each counted module. */
const callsAt = (scale: Scale) =>
	Effect.gen(function* () {
		const [built, fields] = yield* everyCallCount(
			Effect.sync(() => generatedSchema(scale)),
			(file) => file === counted.fields
		)
		const owned = succeeded(ownedInput(built), "the generated schema owns")
		const [, counts] = yield* everyCallCount(
			Effect.sync(() =>
				succeeded(
					compileInstallation(
						owned,
						completeInstallOptions(
							owned,
							installationsOf(owned),
							[],
							[],
							firstCodebook(rostersOf(owned))
						)
					),
					"the generated schema compiles"
				)
			),
			(file) => file === counted.schema || file === counted.statistics
		)
		const callsIn = (file: string): number =>
			Arr.reduce(
				Arr.filter([...counts], ([key]) => Str.startsWith(`${file}:`)(key)),
				0,
				(n, [, k]) => n + k
			)
		return {
			fields: Arr.reduce([...fields.values()], 0, (n, k) => n + k),
			schema: callsIn(counted.schema),
			statistics: callsIn(counted.statistics),
			cascaded: Arr.reduce(
				Arr.filter([...counts], ([key]) => Str.endsWith(" cascadedMembers")(key)),
				0,
				(n, [, k]) => n + k
			)
		}
	})

/** The installation's compile makes no more than 2.1 times the calls in each counted module at twice the schema. */
export const theInstallationsCompileDoesPerRelationWorkLinearInTheSchema = property.exhaust(
	finite(int(1, 2)),
	{
		needs: {},
		box: "the generated schema's scale at its base and at twice it, each at half, one and twice the scale",
		situations: ["the base scale", "twice the base"] satisfies ReadonlyArray<Reached<ScaleFeature>>,
		check: (_, c: Case<ScaleFeature>) => (base) =>
			Effect.gen(function* () {
				c.note(base === 1 ? "the base scale" : "twice the base")
				const [half, once, twice] = yield* Effect.forEach([0.5, 1, 2], (factor) =>
					callsAt(scaleAt(base, factor))
				)
				const cascaded = (calls: typeof once) => defined(calls, "a scale's calls").cascaded
				assert.ok(
					cascaded(half) === cascaded(once) && cascaded(once) === cascaded(twice),
					`the families that cascade into a relation, read once a checked schema at every scale: ${cascaded(half)}, ${cascaded(once)}, ${cascaded(twice)}`
				)
				for (const module of ["fields", "schema", "statistics"] as const) {
					const at = (calls: typeof once) => defined(calls, "a scale's calls")[module]
					assert.ok(
						at(once) <= 2.1 * at(half) && at(twice) <= 2.1 * at(once),
						`${counted[module]}'s calls at half, one and twice the scale: ${at(half)}, ${at(once)}, ${at(twice)}`
					)
				}
			}),
		oracle: {
			kind: "specification",
			name: "each counted module's calls (kernel/calls.ts everyCallCount) at most 2.1 times as many at twice the schema, and the cascading families read once a checked schema"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/public/fields.ts",
				original:
					"\t\t\t\tholdsEvery(roster.handles) ? roster.handles : roster.handles.filter(holds)\n",
				replacement: "\t\t\t\troster.handles.filter(holds)\n",
				why: "Each closed id over a roster copies the roster's handles it holds, though it restricts none: the builders' calls in public/fields.ts grow with the fields times the handles, the square of the schema, and the property fails."
			},
			{
				file: "packages/engine/src/analysis/schema.ts",
				original: "\t\tconst cascaded = this.#cascaded.has(r.name)\n",
				replacement: "\t\tconst cascaded = cascadedMembers(this.owned).has(r.name)\n",
				why: "Each relation's writings read every statement of the schema again for the families that cascade into it: the checked schema's calls grow with the square of the schema, and the property fails."
			},
			{
				file: "packages/engine/src/physical/statistics/statistics.ts",
				original: "\tconst planned = groups.indexes.get(relation) ?? []\n",
				replacement:
					"\tconst planned = [...groups.indexes.values()].flat().filter((i) => i.relation === relation)\n",
				why: "Each relation's shape reads every planned index of the installation for its own: the statistics' calls grow with the square of the schema, and the property fails."
			}
		]
	}
)
