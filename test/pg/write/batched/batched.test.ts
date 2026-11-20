/**
 * A write's insert of many facts runs in executions of a share of them each, within PostgreSQL's default work_mem
 * (runtime/write/bind.ts batchedExecutions, runtime/write/transport.ts writeBatching), in its one transaction. On
 * PostgreSQL 19 at its default work_mem, over a relation of two keys as wide as edullm's qti.node, whose insert's met
 * window sorts every fact it carries twice and whose CTEs keep them (batched.fixtures.ts): where one execution of every
 * fact wrote 77 MB of temporary files for 20,000 facts, no execution writes a temporary block, and the write inserts
 * what one execution would, or refuses it on the same key's law.
 */
import { property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	type BatchedFeature,
	batchedGen,
	runBatched
} from "#test/pg/write/batched/batched.fixtures.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * An insert of thousands of wide facts writes no temporary block in any of its executions, inserts every fact once,
 * and refuses two facts at one key whichever executions carry them.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const anInsertOfManyFactsRunsInSharesWithinWorkMemSoItsTemporaryFilesAreNoneWhateverItsFacts =
	property.explore(batchedGen, {
		needs: { substrate: Substrate.installing },
		situations: [
			"every fact inserted",
			"a pair across executions refused",
			"after a write of the same transaction"
		] satisfies ReadonlyArray<BatchedFeature>,
		check:
			({ substrate }, c) =>
			(drawn) =>
				Effect.provideServiceEffect(runBatched(drawn, c), Substrate, substrate),
		oracle: {
			kind: "universal",
			name: "bound: several executions, none writing a temporary block; the host's count of facts added and stored once each, a note written before them stored with them; a pair at the second key refused, storing nothing"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/runtime/write/bind.ts",
				original: '\t\tif (batching.kind === "whole" || !insertsOnly(statement.step)) {',
				replacement: "\t\tif (batching.kind === batching.kind || !insertsOnly(statement.step)) {",
				why: "Every fact of the call travels in one execution, whose met window and CTEs hold all of them past work_mem and write temporary files that grow with the facts."
			},
			{
				file: "packages/engine/src/runtime/write/bind.ts",
				original:
					'\t\t\topen[i] = { from: defined(open[i], "a cut\'s range of each member slot").from, to: at + 1 }',
				replacement:
					'\t\t\topen[i] = { from: defined(open[i], "a cut\'s range of each member slot").from, to: at }',
				why: "Each share leaves out its last fact, so the write stores fewer facts than the call states."
			}
		]
	})
