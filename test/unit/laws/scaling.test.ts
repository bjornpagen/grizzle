/**
 * No installation, and no snapshot, grows faster than the schema facts it serves: a size relation over AST nodes, the
 * size oracle every outcome oracle lacks. A product of two dimensions, a function whose body is tables × handles, a law
 * compiled once per trigger into every table's text, a role's grants listing every other role, increments by more over
 * each later step of its dimension, at every size, far below any size a clock would notice.
 *
 * Property: for each scalable dimension of a schema and of its worlds, the installation at 2h, 4h and 6h of that
 * dimension alone, h from 2 to 4: the total of its objects' statements, role defaults, revokes and comments, counted as
 * AST nodes (as snapshot.json holds them, a structural property, never printed text), and its snapshot.json and
 * manifest.json read back and counted as JSON nodes, each increments no more from 4h to 6h than from 2h to 4h
 * (test/support/growth.ts incrementsDoNotGrow). Every size is even, so the dimension that pairs its handles up, ⌈n / 2⌉
 * arm relations for n handles, is affine there too. The largest object is no measure of its own: a size above linear
 * in one object makes the total's increments grow.
 *
 * The schema dimensions are drawn as Descriptions, installed with the full role of the oracle login; the worlds
 * dimensions (roles, whole entries per role, world views, context fields) as the worlds suites' install descriptions
 * (worlds model/types.ts InstallSpec), built through the public builders as those suites build them and installed with
 * their logins.
 *
 * Box: every dimension at every h, exhausted. Oracle: universal, the increments of a size that grows no faster than
 * linearly. Assumptions: no dimension's installation changes shape above some size of it (an object that appears only
 * past a threshold would land in one increment alone), and a key of 24 fields, the parent key at its largest, stays
 * within INDEX_MAX_KEYS beside the columns its laws add.
 *
 * Features: each dimension.
 */

import { defined } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { incrementsDoNotGrow } from "#test/support/growth.ts"
import {
	type Dimension,
	dimensions,
	installationOf,
	pointGen,
	scaled,
	sizesOf
} from "#test/unit/laws/scaling.fixtures.ts"

/** Installation size no installation or snapshot grows faster than one dimension of its schema or worlds. */
export const installationSizeNoInstallationOrSnapshotGrowsFasterThanOneDimensionOfItsSchemaOrWorlds =
	property.exhaust(finite(pointGen), {
		needs: {},
		situations: dimensions satisfies ReadonlyArray<Reached<Dimension>>,
		check: (_, c: Case<Dimension>) => (point) =>
			Effect.gen(function* () {
				c.note(point.dimension)
				const measured = new Map<number, ReturnType<typeof sizesOf>>()
				for (const size of [2 * point.half, 4 * point.half, 6 * point.half]) {
					const installation = yield* installationOf(scaled(point.dimension, size))
					measured.set(size, sizesOf(installation))
				}
				const at = (size: number) => defined(measured.get(size), `the sizes at ${size}`)
				incrementsDoNotGrow(
					(size) => at(size).total,
					point.half,
					`${point.dimension}: the installation's AST nodes`
				)
				incrementsDoNotGrow(
					(size) => at(size).snapshot,
					point.half,
					`${point.dimension}: snapshot.json's and manifest.json's JSON nodes`
				)
			}),
		oracle: {
			kind: "universal",
			name: "a size that grows no faster than linearly increments no more over its second equal step than over its first"
		},
		box: "every dimension of a schema and of its worlds, installed at 2h, 4h and 6h for every h from 2 to 4",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/physical/ddl/tables.ts",
				original: "\t\t\t\treasons: lawReasons(o.lawIds),\n",
				replacement:
					'\t\t\t\treasons: lawReasons(b.natives.flatMap((m) => (m.namespace === "column" ? m.object.lawIds : []))),\n',
				why: "Each law column's manifest reasons name every law column's laws (physical/ddl/tables.ts addNatives), not its own: a schema's manifest grows with the square of its selected sides, each arm's law columns among them."
			}
		]
	})
