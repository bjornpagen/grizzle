/**
 * A rewrite keeps the restriction reaching every occurrence's read (lower/optimize/demand/restriction.ts): R02
 * (lower/optimize/existence) makes no existence test of an occurrence that is the only one relating some column of
 * another occurrence to the rest of its region, so a derivation a region reads is read at the key that occurrence
 * carries to it, never over every value of the column with the test applied after. Before, qti-pie's ItemSessionControl
 * joined a learner's item session, its sitting, the test's member that refers to the session's item, and the member's
 * controls in force, a union of the stated attempts and a default list of every unstated member; every occurrence but
 * the session and the attempts became an existence test, the attempts were read at the session's package alone, and each
 * item session's control derived its test's whole default list, 68 members, then probed five tests for each (metis's
 * sitting, 9,825 buffers of 31,173 for 34 items, and twice more under it). And the attempts in force, read at the
 * member's place, read its nearest stated scope first, a fold at the member's every grouping column, one group
 * (cte-policy keyedRegionChain, a source whose seek holds one of its keys ranked `key`), then the attempts stated at
 * that scope by their key, where the stated attempts of every scope of the test, read at the test's package and path,
 * led it and the fold was derived again for each. And the session's member, read at (package, path, document), is read
 * through its own index whatever the statistics state: the fold's members' index at (package, path, start) leads with
 * start, a column of its own (physical/indexes/engine.ts ownLead), where led alike with package and path it priced as
 * the member's own under statistics stating each value its own, and every member of the test was read for each session.
 *
 * On PostgreSQL 19, under no planner setting, a test of a few members and then of a hundred more, in sections, its part,
 * its sections and some of its members stating attempts, and a learner's sessions of its first members, each with its
 * control attached at the session's key, beside dozens of other packages' tests and learners, so every relation is
 * dozens of pages and a scan of one costs PostgreSQL more than the learner's index probes.
 *
 * Oracle: a bound, the read's scans read at most four times the learner's own rows (each session, its sitting, its
 * member, the member's scopes and their stated attempts), however many members the test holds beside them, under any
 * statistics; and every equality path the workload's access asks is a binding the read's statement prints
 * (test/support/read-indexes.ts unprintedPaths), none a walk's restriction of a region under a row site holds it at
 * where the lowering reads it at the site's alone (share/keys.ts rowReading).
 *
 * Features: a test of few members and of many; a stated part, stated sections, no scope stated; each statistics.
 */
import type { Reached } from "@bjornpagen/testing/features"
import { property, ReplayToken } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	type MemberFeature,
	memberControlTemplate,
	memberGen,
	runMemberControl
} from "#test/pg/lower-shapes/member-control.fixtures.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * A learner's sessions, each with its control attached, read the learner's own rows alone however many members the test
 * holds beside them: the member that refers to each session's item carries its place to the attempts in force.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const aRewriteKeepsTheRestrictionReachingEveryOccurrencesReadSoADerivationIsReadAtTheKeyItsRegionCarries =
	property.explore(memberGen, {
		needs: { stored: Substrate.rolledBack(memberControlTemplate) },
		situations: [
			"beside few members",
			"beside many members",
			"under a stated part",
			"under a stated section",
			"with no scope stated",
			"under counted statistics",
			"under statistics stating each value its own",
			"under statistics stating every row one value"
		] satisfies ReadonlyArray<Reached<MemberFeature>>,
		check:
			({ stored }, c) =>
			(drawn) =>
				Effect.gen(function* () {
					const { connection, value } = yield* stored
					yield* runMemberControl(value.installed, connection, drawn, c)
				}),
		oracle: {
			kind: "universal",
			name: "bound: the read's scans read at most four times the learner's own rows, beside a test of a few members and of a hundred more, under any statistics"
		},
		kept: [
			{
				token: ReplayToken(
					"test/pg/lower-shapes/member-control.test.ts#aRewriteKeepsTheRestrictionReachingEveryOccurrencesReadSoADerivationIsReadAtTheKeyItsRegionCarries:-:0.0.0.0.0.0.0.0.0.0"
				),
				reason:
					"qti-pie's member controls (ledger/src/member-controls.ts): a member's attempts in force read every stated scope of its test at the test's package and path before the member's nearest stated scope, a fold at the member's place, and derived the fold again for each, 350 rows for one session beside a test of 42 members against a bound of 36",
				since: "2026-11-26"
			},
			{
				token: ReplayToken(
					"test/pg/lower-shapes/member-control.test.ts#aRewriteKeepsTheRestrictionReachingEveryOccurrencesReadSoADerivationIsReadAtTheKeyItsRegionCarries:-:0.0.0.0.0.0.0.0.0.1"
				),
				reason:
					"qti-pie's member controls under statistics stating each value its own: the session's member read at (package, path, document) through the fold's index (package, path, start), led alike, the document filtered after, every member of the test, 61.98 rows beside a test of 42 members against a bound of 36",
				since: "2026-11-26"
			}
		],
		kills: [
			{
				file: "packages/engine/src/lower/optimize/existence/index.ts",
				original: "\t\tconst keeping = connected.filter((o) => keepsRestriction(node, o))\n",
				replacement: "\t\tconst keeping = connected\n",
				why: "R02 makes an existence test of the member that refers to the session's item, as before: the attempts in force are read at the session's package alone, every member's derived for each session and the member's test applied to each."
			},
			{
				file: "packages/engine/src/lower/optimize/cte-policy/index.ts",
				original:
					"\t\tif (source.meta.logicalKeys.some((k) => k.key.every((c) => seek.includes(c)))) {\n",
				replacement: "\t\tif (false) {\n",
				why: "A fold read at its every grouping column ranks by the prefix of its input: the stated attempts of every scope of the test, read at its package and path, lead the member's nearest stated scope, which is derived again for each of them."
			},
			{
				file: "packages/engine/src/physical/indexes/engine.ts",
				original:
					'\tconst [lead] = sortNonEmpty(\n\t\tfirst,\n\t\tcombineAll([\n\t\t\tmapInput(compareBooleans, (k: IndexKey) => columns.holds(k.column) !== "many"),\n\t\t\tmapInput(compareBooleans, (k: IndexKey) => leads.has(text(k))),\n\t\t\tmapInput(compareBooleans, (k: IndexKey) => keyed.has(text(k))),\n\t\t\tmapInput(\n\t\t\t\tcompareNumbers,\n\t\t\t\t(k: IndexKey) => others.filter((o) => o.columns.has(text(k))).length\n\t\t\t),\n\t\t\torder\n\t\t])\n\t)\n',
				replacement: "\tconst [lead] = sortNonEmpty(first, order)\n",
				why: "A created index of a relation in no unit leads in the heading's order, as before: the session's member index and the fold's lead alike with package and path, and under statistics stating each value its own PostgreSQL reads the member at (package, path, document) through the fold's index, every member of the test for each."
			},
			{
				file: "packages/engine/src/lower/shapes/share/keys.ts",
				original:
					"\t\t\t\tfor (const under of postorder([site.occurrence.source], inputsOf)) {\n\t\t\t\t\tbeneath.add(under)\n\t\t\t\t}\n",
				replacement: "",
				why: "A walk holds a region under a row site at its own restriction, as before, beside the site's: the members of the test are asked at its package and path, a chain no statement prints, which the members' attempts in force read at the member's place alone."
			}
		]
	})
