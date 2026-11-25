/**
 * A call past one share of facts, through a Db's served change member, is drawn in shares of whole groups and sent as
 * one flight a share of its one transaction (adapter/apply/shares.ts drawShares, adapter/apply/run.ts runWriteShares,
 * adapter/wire/batch.ts runFramedFlights), so the host holds one share's facts at a time (test/unit/write/shares holds
 * the heap to it), and answers what one execution of every fact answers: on PostgreSQL 19, every distinct fact added
 * and stored once, a fact repeated across shares once, every area's counted members counted though its members are
 * facts of their own, and a pair across shares refused with nothing stored, its refusal the call's answer as the
 * shared attempt classifies it, and so a later share the host refuses as it binds it: the shares sent before it are rolled back, never
 * committed (adapter/wire/batch.ts runFramedFlights), and a refused call is its one transaction, its refusal judged on
 * the shared attempt and never sent again (adapter/apply/run.ts runWriteShares), counted by pg_stat_statements' calls
 * of the Db prologue's guard.
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
			"a pair refused across shares",
			"a later share the host refuses",
			"a COMMIT the deferred containment refuses"
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
			name: "accepted with every distinct fact added and stored once and every area's members counted, or a pair across shares, or a share the host refuses, refused storing nothing"
		},
		kept: [],
		kills: [
			{
				file: "packages/grizzle/src/adapter/apply/run.ts",
				original: "\t\t\taddCounts(\n\t\t\t\tcounts,",
				replacement: "\t\t\tcounts.clear()\n\t\t\taddCounts(\n\t\t\t\tcounts,",
				why: "The outcome counts the last share's facts alone, where every share's add to it."
			},
			{
				file: "packages/grizzle/src/adapter/wire/batch.ts",
				original:
					'\t\t\t\t\t\tsendPlan(session, [], principal, [], { ...frame, end: "ROLLBACK" }, "closing")',
				replacement: '\t\t\t\t\t\tsendPlan(session, [], principal, [], frame, "closing")',
				why: "A transaction a failure decided ends with its frame's COMMIT: after a share the host refused, every share sent before it commits."
			},
			{
				file: "packages/grizzle/src/adapter/apply/run.ts",
				original:
					'\t\t\t\tcase "ShareRejected":\n\t\t\t\t\treturn hostRejection<R>(failure.rejected)\n',
				replacement:
					'\t\t\t\tcase "ShareRejected":\n\t\t\t\t\tyield* Effect.ignore(runFramedFlights(session, frame, shareFlights(session, entry, drawn), read, backs.statements))\n\t\t\t\t\treturn hostRejection<R>(failure.rejected)\n',
				why: "A shared refusal is sent again before it answers: a second transaction, which under READ COMMITTED may commit where the first refused, the state having moved between them."
			},
			{
				file: "packages/grizzle/src/adapter/apply/run.ts",
				original: "\t\t\t\t? Effect.succeed(diagnosedWitness(unmatched, answer.closing))\n",
				replacement: "\t\t\t\t? Effect.succeed(unreproduced)\n",
				why: "A shared call's COMMIT refusal is answered with no witness, as though another commit had changed the state, where its shares drawn again leave the node unmatched whose key is the witness."
			}
		]
	}
)
