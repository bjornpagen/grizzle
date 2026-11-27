/**
 * An attachment over a union of rules is read per parent key, inside each arm (lower/optimize/cte-policy probedByKey,
 * attachmentRead `perKey`). On PostgreSQL 19, over documents of packages as edullm's QTI ledger stores them
 * (attach-union.fixtures.ts): each document's files, the media files it references or names as image candidates,
 * edullm's `files` attachment of its item reads, a union of two rules each joining one relation's range by the
 * document's key to the package's media. Before, no stored relation's range bound a union, so the policy derived it
 * once for the statement as a MATERIALIZED CTE (rule 5b) and joined each document's key to it beside: every item read
 * read every reference and media file stored, about 13 ms of edullm's contentItem's 16 at 206 packages.
 */
import { property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	type AttachUnionFeature,
	attachUnionTemplate,
	corpusGen,
	runAttachUnion
} from "#test/pg/lower-shapes/attach-union.fixtures.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * A package's documents' files read through a union of rules read each arm's rows by the documents' keys alone, however
 * many packages are stored: its rows and its buffers.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 *
 * Its budget, measured (fastcycle's cull):
 *
 * @limitKind measured
 * @owner test/pg/lower-shapes/attach-union.test.ts, this property's search
 * @unit cases of the rotating stream; the floor stream runs a quarter of them, rounded up
 * @scope one search of this property in one run; the steered phase's cases, its cap, run only while a required
 *   situation is pending
 * @evidence `TEST_SEED=2219874524 pnpm exec toolchain-test kills test/pg/lower-shapes/attach-union.test.ts` at its
 *   budget before, the runner's, runs 150 and steered 200, each kill's verdict printed with where its witnesses went
 *   red (judgedLine with the red's headline, a local print), in
 *   ~/.cache/grizzle-release/CULL-COMPUTE/kills-current.log; this budget run by path in run-budgets.log there
 * @observed 2026-11-23, 04:00 to 06:00 UTC
 * @environment cassowary, Ubuntu 26.04 on arm64 in AWS, 64 cores and 247 GiB at load 440 to 530; PostgreSQL 19 in
 *   memory (the family grizzle-m-cull-compute); Node 26.13.1; grizzle at dbcb09929 with lane CULL-COMPUTE's cull,
 *   vendor/toolchain at 2cc4817
 * @workload each declared kill applied alone and judged on the property's witnesses: its kept cases, its floor stream
 *   and its steered phase, which no run seed moves
 * @result its kill went red on the first case of its floor stream
 * @decision 1, the least a generative search draws, whose floor stream holds that one case; no headroom: a kill its
 *   witnesses stop killing fails the kill gate, which measures it again
 * @revalidate a change of its space, situations, kept cases or kills, of its label (the floor stream's seed), or of the
 *   runner's floor rule
 */
export const anAttachmentOverAUnionOfRulesReadsEachArmByItsParentsKeysSoItsWorkIsTheParentsRowsNotTheCorpus =
	property.explore(corpusGen, {
		needs: { ledger: Substrate.fresh(attachUnionTemplate) },
		situations: [
			"a file both rules name",
			"no file both rules name"
		] satisfies ReadonlyArray<AttachUnionFeature>,
		check:
			({ ledger }, c) =>
			(drawn) =>
				Effect.flatMap(ledger, ({ substrate, value }) =>
					runAttachUnion(value.installed, substrate.admin, drawn, c)
				),
		oracle: {
			kind: "universal",
			name: "the host's files of every document of the package read, and bound: the rows each arm's relations' scans read are at most those the documents' keys match at two corpus sizes, and the buffers they touch grow by less than half as much as the corpus does"
		},
		budget: { runs: 1, steered: 200 },
		kept: [],
		kills: []
	})
