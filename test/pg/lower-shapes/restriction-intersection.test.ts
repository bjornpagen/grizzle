/**
 * A node a row site's root reads at several restrictions that share a key part is derived once per row there, at that
 * part (lower/shapes/share/keys.ts restrictionWalk, commonRestriction), each read keeping its other
 * columns: slice 3's restriction intersection. Before, a node every read of which under the root did not arrive at one
 * restriction was reached by none: it stayed the statement's CTE, derived for every row of the store and scanned once
 * for each row of the driver (edullm's session control, read three times in controlOf at a session's stage and at the
 * session; metis's review reads its session control and pending external scorings so).
 *
 * On PostgreSQL 19, a ledger in small (restriction-intersection.fixtures.ts): each child's sittings of its stages, its
 * item sessions, and each session's holds and pauses, a union of the two; a few dozen children and then a few hundred,
 * beside children stored first, one past the read's bound; its tables in each pg_class state (test/support/advice.ts
 * PgClassState), the read run under its carried advice once the plan laws hold over it. The read: a sitting's sessions, each with its
 * stage's controls and its own attached, the union read by two rules of the attachment's child, at the session's child
 * and stage and at its child, stage and place.
 *
 * A second read shares no key's prefix: a batch's probes, each with its stage's scores of its x and of its y attached, the
 * scores keyed by x first and by y first, the two reads sharing the stage alone, beside stages scored first, one past
 * the read's bound.
 * The scores are derived once per probe at the stage, so their arms are read at the stage alone, which the index engine
 * serves by an index of the stage (physical/access/extract.ts `chained`, share/keys.ts rowReading `held`): asked at each
 * read's own columns, the x's and the y's, the indexes were ones no plan reads, and the stage's none.
 *
 * Oracle: a bound, the read's work (test/support/judge.ts readWork) is at most four times what the stage's sessions
 * deliver, and the stage's sitting and sessions, however many children stand beside it, in any pg_class state; and at
 * most four times what the probes' stage holds for each probe, and the probes, however many stages are scored beside it.
 *
 * Features: a read beside a few children and beside many; beside few stages and many; each pg_class state.
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
			"its tables never vacuumed",
			"its tables counted empty",
			"its tables analyzed",
			"its tables skewed",
			"its tables large"
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
			name: "bound: the read's scans read at most four times what the stage's sessions deliver, and its sitting and sessions, beside a few dozen children and beside a few hundred, in any pg_class state"
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
 * many stages are scored beside it, in any pg_class state: each probe's union is derived once at the stage both its reads
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
			"its tables never vacuumed",
			"its tables counted empty",
			"its tables analyzed",
			"its tables skewed",
			"its tables large"
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
			name: "bound: the read's scans read at most four times what the probes' stage holds for each probe, and the probes, beside few stages and beside many, in any pg_class state"
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
			}
		]
	})
