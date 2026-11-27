/**
 * A chain step that no equality joins to anything the region reads beside it is read whole for each row before it, in
 * every lowering, so it continues a chain read at a key and starts none (lower/optimize/cte-policy Rank `cross`): an
 * attachment whose child reads such a step after its key-bound ones is read per key, each key's rows times the step's,
 * never the child derived for every key. Before, the step stalled the chain, so the attachment was co-grouped and its
 * child derived whole: pantry's listedMedia, every media type tested by its suffix against each media file, under
 * metis's resume's (`sitting`) and review's served and withheld files, derived every package's media.
 *
 * On PostgreSQL 19, a package's documents, the files each names, its media and the media types served
 * (cross-step.fixtures.ts): Listed, each media file with the type whose suffix its path ends with, Served, each named
 * file Listed serves, read by a learner's sessions' `files` attachment at each session's document; a few packages and
 * then a few dozen more, under counted statistics or statistics stating each value its own or every row one value
 * (pg_restore_attribute_stats).
 *
 * Oracle: a bound and store invariance, the read's scans read at most three times the learner's own rows (its
 * sessions, their documents' named files, each file and the media types tested against it), and no more beside a few
 * dozen packages than beside a few, under any statistics.
 *
 * Features: a read beside few packages and beside many; each statistics.
 */
import type { Reached } from "@bjornpagen/testing/features"
import { property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	type CrossFeature,
	crossGen,
	crossTemplate,
	runCross
} from "#test/pg/lower-shapes/cross-step.fixtures.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * A learner's sessions, each with the files its document serves attached, read the learner's own rows alone however many
 * packages stand beside them, under any statistics: the attachment reads per key, the media types whole beside each file.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const aStepNoEqualityJoinsContinuesAChainReadAtAKey = property.explore(crossGen, {
	needs: { stored: Substrate.rolledBack(crossTemplate) },
	situations: [
		"beside few packages",
		"beside many packages",
		"under counted statistics",
		"under statistics stating each value its own",
		"under statistics stating every row one value"
	] satisfies ReadonlyArray<Reached<CrossFeature>>,
	check:
		({ stored }, c) =>
		(drawn) =>
			Effect.gen(function* () {
				const { connection, value } = yield* stored
				yield* runCross(value.installed, connection, drawn, c)
			}),
	oracle: {
		kind: "universal",
		name: "a bound and store invariance: the read's scans read at most three times the learner's own rows, and no more beside a few dozen packages than beside a few, under any statistics"
	},
	kept: [],
	kills: [
		{
			file: "packages/engine/src/lower/optimize/cte-policy/index.ts",
			original:
				'\t\t\t\t(b.bound.length > 0 || (b.bound.rank === "cross" && chain.length > 0)) &&\n',
			replacement: "\t\t\t\tb.bound.length > 0 &&\n",
			why: "A step no equality joins stalls the chain, as before: the files attachment is co-grouped, Served derived for every package's documents, and the read grows with the packages beside the learner's."
		}
	]
})
