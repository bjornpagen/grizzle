/**
 * A call past one share of facts, through a Db's served change member, is drawn in shares of whole groups and sent as
 * one flight a share of its one transaction (adapter/apply/shares.ts drawShares, adapter/apply/run.ts runWriteShares,
 * adapter/wire/batch.ts runFramedFlights), so the host holds one share's facts at a time (test/unit/write/shares holds
 * the heap to it), and answers what one execution of every fact answers: on PostgreSQL 19, every distinct fact added
 * and stored once, a fact repeated across shares once, every area's counted members counted though its members are
 * facts of their own, and a pair across shares refused with nothing stored, its refusal the whole call's (the call sent
 * again whole).
 */
import { property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	runStreamed,
	type StreamedFeature,
	streamedGen
} from "#test/pg/write/streamed/streamed.fixtures.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"

/**
 * A call drawn in shares answers what one execution of every fact answers.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const aCallDrawnInSharesAnswersWhatOneExecutionOfEveryFactAnswers = property.explore(
	streamedGen,
	{
		needs: { substrate: Substrate.fresh(baseSubstrate) },
		situations: [
			"every fact once",
			"a fact repeated across shares",
			"a stored fact repeated across shares",
			"a pair refused across shares"
		] satisfies ReadonlyArray<StreamedFeature>,
		check:
			({ substrate }, c) =>
			(drawn) =>
				Effect.provideServiceEffect(
					runStreamed(drawn, c),
					Substrate,
					Effect.map(substrate, (taken) => taken.substrate)
				),
		oracle: {
			kind: "universal",
			name: "accepted with every distinct fact added and stored once and every area's members counted, or a pair across shares refused storing nothing"
		},
		kept: [],
		kills: [
			{
				file: "packages/grizzle/src/adapter/apply/run.ts",
				original: "\t\t\taddCounts(\n\t\t\t\tcounts,",
				replacement: "\t\t\tcounts.clear()\n\t\t\taddCounts(\n\t\t\t\tcounts,",
				why: "The outcome counts the last share's facts alone, where every share's add to it."
			}
		]
	}
)
