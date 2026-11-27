/**
 * A node a row site's root reads at several restrictions that share a key part is derived once per row there, at that
 * part (lower/shapes/share/keys.ts restrictionWalk, commonRestriction), each read keeping its other
 * columns: slice 3's restriction intersection. Before, a node every read of which under the root did not arrive at one
 * restriction was reached by none: it stayed the statement's CTE, derived for every row of the store and scanned once
 * for each row of the driver (edullm's session control, read three times in controlOf at a session's stage and at the
 * session; metis's review reads its session control and pending external scorings so).
 *
 * On PostgreSQL 19, under no planner setting, a ledger in small (restriction-intersection.fixtures.ts): each child's
 * sittings of its stages, its item sessions, and each session's holds and pauses, a union of the two; a few dozen
 * children and then a few hundred, beside children stored first, as many as make a scan of each relation cost
 * PostgreSQL more than the read's index probes (fill.ts rowsBeside); under counted statistics or statistics stating each
 * value its own or every row one value (pg_restore_attribute_stats). The read: a sitting's sessions, each with its
 * stage's controls and its own attached, the union read by two rules of the attachment's child, at the session's child
 * and stage and at its child, stage and place.
 *
 * A second read shares no key's prefix: a batch's probes, each with its stage's scores of its x and of its y attached, the
 * scores keyed by x first and by y first, the two reads sharing the stage alone, beside stages scored first, as many as
 * make a scan of each kind of score cost more than the probes.
 * The scores are derived once per probe at the stage, so their arms are read at the stage alone, which the index engine
 * serves by an index of the stage (physical/access/extract.ts `chained`, share/keys.ts rowReading `held`): asked at each
 * read's own columns, the x's and the y's, the indexes were ones no plan reads, and the stage's none.
 *
 * Oracle: a bound, the read reads no table larger than a probe whole, and its keyed work (test/support/judge.ts
 * keyedReadWork) is at most four times what the stage's sessions deliver, and the stage's sitting and sessions, however
 * many children stand beside it, under any statistics; and at most four times what the probes' stage holds for each
 * probe, and the probes, however many stages are scored beside it. And every equality path the
 * workload's access asks of the read is a binding its statement prints (test/support/read-indexes.ts unprintedPaths).
 *
 * Features: a read beside a few children and beside many; beside few stages and many; each statistics.
 */
import type { Reached } from "@bjornpagen/testing/features"
import { property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	type IntersectionFeature,
	intersectionGen,
	intersectionTemplate,
	type ProbeFeature,
	probeGen,
	runControls,
	runProbes
} from "#test/pg/lower-shapes/restriction-intersection.fixtures.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * A sitting's sessions, each with its stage's controls and its own attached, read through the sitting, read that stage's
 * controls alone however many children the store holds beside it: each session's union is derived once at the child and
 * stage both its reads hold.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const aNodeReadAtRestrictionsSharingAKeyPartIsDerivedOncePerRowAtThatPart = property.explore(
	intersectionGen,
	{
		needs: { stored: Substrate.rolledBack(intersectionTemplate) },
		situations: [
			"beside a few children",
			"beside many children",
			"under counted statistics",
			"under statistics stating each value its own",
			"under statistics stating every row one value"
		] satisfies ReadonlyArray<Reached<IntersectionFeature>>,
		check:
			({ stored }, c) =>
			(drawn) =>
				Effect.gen(function* () {
					const { connection, value } = yield* stored
					yield* runControls(value.installed, connection, drawn, c)
				}),
		oracle: {
			kind: "universal",
			name: "bound: the read's scans read at most four times what the stage's sessions deliver, and its sitting and sessions, beside a few dozen children and beside a few hundred, under any statistics"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/shapes/share/keys.ts",
				original:
					"\t\trest.every((r) => r.some((x) => x.column === e.column && x.value === e.value))\n",
				replacement:
					"\t\trest.every((r) => r.length === first.length && r.every((x) => first.some((y) => y.column === x.column && y.value === x.value)))\n",
				why: "A node read at restrictions that differ is reached at none, as before: the union stays the statement's CTE, derived for every child stored and scanned twice for each session."
			}
		]
	}
)

/**
 * A batch's probes, each with its stage's scores of its x and of its y attached, read that stage's scores alone however
 * many stages are scored beside it, under any statistics: each probe's union is derived once at the stage both its reads
 * hold, though no key of the scores leads with it.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const aNodeReadAtRestrictionsSharingAPartNoKeyLeadsWithIsDerivedOncePerRowAtThatPart =
	property.explore(probeGen, {
		needs: { stored: Substrate.rolledBack(intersectionTemplate) },
		situations: [
			"beside few stages",
			"beside many stages",
			"under counted statistics",
			"under statistics stating each value its own",
			"under statistics stating every row one value"
		] satisfies ReadonlyArray<Reached<ProbeFeature>>,
		check:
			({ stored }, c) =>
			(drawn) =>
				Effect.gen(function* () {
					const { connection, value } = yield* stored
					yield* runProbes(value.installed, connection, drawn, c)
				}),
		oracle: {
			kind: "universal",
			name: "bound: the read's scans read at most four times what the probes' stage holds for each probe, and the probes, beside few stages and beside many, under any statistics"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/shapes/share/keys.ts",
				original:
					"\t\trest.every((r) => r.some((x) => x.column === e.column && x.value === e.value))\n",
				replacement:
					"\t\trest.every((r) => r.length === first.length && r.every((x) => first.some((y) => y.column === x.column && y.value === x.value)))\n",
				why: "A node read at restrictions that differ is reached at none, as before: the scores stay the statement's CTE, derived for every stage scored and scanned twice for each probe."
			},
			{
				file: "packages/engine/src/physical/access/extract.ts",
				original: "\t\t\tfor (const restriction of this.#reading.held.get(source) ?? [at]) {\n",
				replacement: "\t\t\tfor (const restriction of [at]) {\n",
				why: "A chain step over a node a row site's root holds once visits it at the step's own columns, as before: the scores' arms are asked at (stage, x) and at (stage, y), which no statement prints, each an index no plan reads, and the stage the union is derived at, which every plan reads, asks none."
			}
		]
	})
