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
 */
export const anAttachmentOverAUnionOfRulesReadsEachArmByItsParentsKeysSoItsWorkIsTheParentsRowsNotTheCorpus =
	property.explore(corpusGen, {
		needs: { ledger: Substrate.freshOf(attachUnionTemplate) },
		situations: [
			"a file both rules name",
			"no file both rules name"
		] satisfies ReadonlyArray<AttachUnionFeature>,
		check:
			({ ledger }, c) =>
			(drawn) =>
				Effect.flatMap(ledger, ({ substrate, value }) =>
					runAttachUnion(value, substrate.admin, drawn, c)
				),
		oracle: {
			kind: "universal",
			name: "the host's files of every document of the package read, and bound: the rows each arm's relations' scans read are at most those the documents' keys match at two corpus sizes, and the buffers they touch grow by less than half as much as the corpus does"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/optimize/cte-policy/index.ts",
				original: "\t\treturn unionArms(node.groups).every((arm) => probedByKey(arm, columns))",
				replacement: "\t\treturn false",
				why: "No stored relation's range binds a union, so the policy derives the files of every document once as a MATERIALIZED CTE and joins each document's key to it beside, reading every reference, candidate and media file stored."
			}
		]
	})
