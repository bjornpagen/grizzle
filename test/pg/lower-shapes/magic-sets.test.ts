/**
 * A fold, a union or a join a statement reads at several sites is computed at its sites' keys alone (lower/shapes/share/
 * keys.ts KeyAnalysis, magic sets): a site read once per row of a driver, an attachment's child per parent key, is
 * lowered there at that row's values, each carried into the nodes under it that read them (keys.ts restrictionWalk), a
 * fold's keys below its aggregate; every other site reads one evaluation of it at the DISTINCT union of their keys,
 * LATERAL per key, to which a site read per row adds none. So a read of one child's rows reads that child's rows alone
 * however many children the store holds beside it. Before, a fold read by a head at a sitting's keys and by the head's
 * attachment at each head row was derived whole: the attachment's keys were the head's rows, which read the fold
 * itself, a cycle no order computes first, and the attachment read the whole fold beside each parent key (edullm's
 * latest decision, ~176k buffers a call for any child; reviewOf's LatestAttempt, every attempt's latest derived before
 * the sitting's three were kept). An attachment whose correlation the parameters hold (the constant-column pass reads
 * them in place of the head's columns) has one key, the statement's, and is read per key too (cte-policy
 * keyPrefixBound: a column held at a value that reads no relation is no column to prove).
 *
 * On PostgreSQL 19, a ledger in small (magic-sets.fixtures.ts): each child's sittings of its stages, its item sessions
 * at their stages, their attempts and marks, a few dozen children and then a few hundred; the read of one child's
 * stage's latest attempts, through its sitting or at the parameters, with the marks of the stage's latest attempts
 * attached to each. Each per-key evaluation reads its relations in the order their declared keys prove (cte-policy
 * keyedRegionChain, lower/shapes/region keyedChain): the stage's sessions by (child, stage), then each session's
 * attempts by its key.
 *
 * Oracle: a bound, the read's scans read at most three times the stage's stored rows however many children stand beside
 * it: stored relations' rows and CTE scans' with what their filters removed.
 *
 * Features: a read beside a few children and beside many.
 */
import type { Reached } from "@bjornpagen/testing/features"
import { type Kill, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	runStage,
	type StageFeature,
	type StageRead,
	stageGen,
	stageTemplate
} from "#test/pg/lower-shapes/magic-sets.fixtures.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** The property over one of the reads (StageRead), with its kills. */
const stageProperty = (by: StageRead, kills: ReadonlyArray<Kill>) =>
	property.explore(stageGen, {
		needs: { stored: Substrate.rolledBack(stageTemplate) },
		situations: ["beside a few children", "beside many children"] satisfies ReadonlyArray<
			Reached<StageFeature>
		>,
		check:
			({ stored }, c) =>
			(drawn) =>
				Effect.gen(function* () {
					const { connection, value } = yield* stored
					yield* runStage(value, connection, drawn, c, by)
				}),
		oracle: {
			kind: "universal",
			name: "bound: the read's scans read at most three times the stage's stored rows, stored relations' and CTE scans' with what their filters removed, beside a few dozen children and beside a few hundred"
		},
		kept: [],
		kills
	})

/**
 * A read of one child's stage through its sitting, a fold read by the head at the sitting's child and stage and by its
 * attachment at each head row, reads that stage's rows alone however many children the store holds beside it, each
 * per-key chain led by the stage's sessions.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const aFoldReadByAHeadAndByItsAttachmentIsComputedAtTheHeadsKeysSoAReadOfOneChildReadsItsOwnRows =
	stageProperty("sitting", [
		{
			file: "packages/engine/src/lower/shapes/share/keys.ts",
			original:
				"\t\treturn perRow === undefined ? readers : readers.filter((r) => !perRow.has(r))\n",
			replacement: "\t\treturn readers\n",
			why: "A site read per parent key adds its keys to the fold's: the attachment's keys are the head's rows, which read the fold, a cycle no order computes first, so the fold is derived whole for every child stored."
		},
		{
			file: "packages/engine/src/lower/shapes/region/index.ts",
			original:
				"\t\tconst keyed = chain === undefined ? undefined : keyedChain(cx, node, parts, chain)\n",
			replacement: "\t\tconst keyed = chain === undefined ? undefined : undefined\n",
			why: "A per-key region reads its relations in the order PostgreSQL's estimates choose: the fold's attempts read by the child, every stage's, before its stage's sessions bind each, past three times the stage's rows."
		},
		{
			file: "packages/engine/src/lower/shapes/share/keys.ts",
			original: "\t\t\t\tfor (const [source, columns] of bySource) {\n\t\t\t\t\tenter(\n",
			replacement:
				"\t\t\t\tfor (const [source, columns] of bySource.size < 0 ? bySource : []) {\n\t\t\t\t\tenter(\n",
			why: "The parent key stops at the attachment's region: the fold it reads is read there as the statement's CTE, a site of its key set, whose keys the head's rows of it give, a cycle, so the fold is derived whole for every child stored."
		}
	])

/**
 * A read of one child's stage at the parameters, whose attachment's child holds every column of its correlation at a
 * parameter, reads the child once, at the statement's key, the stage's rows alone however many children the store holds
 * beside it.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const anAttachmentWhoseCorrelationTheParametersHoldIsReadAtTheStatementsOneKey =
	stageProperty("parameters", [
		{
			file: "packages/engine/src/lower/optimize/cte-policy/index.ts",
			original: "\t\t\treturn read.length === 0 || keyPrefixBound(node.input, read)\n",
			replacement:
				"\t\t\treturn read.length === columns.length && keyPrefixBound(node.input, read)\n",
			why: "A column held at a parameter is a column no declared-key prefix binds: the attachment's child is co-grouped, its marks joined to its fold by the child alone, every stage's, past three times the stage's rows."
		}
	])
