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
 * of the Db prologue's guard. A share's statement PostgreSQL refuses by a CHECK it checks itself is judged on the host
 * over that share's own rows, so its witness is the row that breaks the law: qti-pie's import of the drill's choice
 * package, refused by AL3 at its Node statement, answered `unreported`, the host having judged every share's refusal
 * over the rows of the call's empty bind (QP-PUBFACTS); here a document's tree node whose marks fall short of its need
 * is refused by Enough, its witness that node's key.
 */
import { property, ReplayToken } from "@bjornpagen/testing/property"
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
			"a COMMIT the deferred containment refuses",
			"a node its marks fall short of"
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
			name: "accepted with every distinct fact added and stored once and every area's members counted, or a pair across shares, a share the host refuses or a node its marks fall short of, refused storing nothing, the last witnessed by the node's key"
		},
		kept: [
			{
				token: ReplayToken(
					"test/pg/write/streamed/streamed.test.ts#aCallDrawnInSharesAnswersWhatOneExecutionOfEveryFactAnswers:40.6:0.0.0.0.0.6"
				),
				reason:
					"QP-PUBFACTS' AL3 refusal cut down: 6,000 wide facts, so the call is drawn in shares, and seven documents' one-node trees, the last's node one mark short of its need. Enough refused the share's Node statement, and the host judged it over the call's empty bind, so the refusal named no row, `first` and `unreported`, as AL3's of pantry's drill package did (lvc-pin3-draft at grizzle 8aea9fea)",
				since: "2026-11-26"
			}
		],
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
				original: "\t\t\t\t? Effect.succeed(unmatchedKeyOf(unmatched, answer.closing))\n",
				replacement: "\t\t\t\t? Effect.succeed(unreproduced)\n",
				why: "A shared call's COMMIT refusal is answered with no witness, as though another commit had changed the state, where its shares drawn again leave the node unmatched whose key is the witness."
			},
			{
				file: "packages/grizzle/src/adapter/apply/run.ts",
				original: "\t\t\t\t\t: flightFailure<R>(failure, share.sent, contextOf(share.stated))",
				replacement: "\t\t\t\t\t: flightFailure<R>(failure, share.sent, unshared)",
				why: "A share's refused statement is judged over the rows of the call's empty bind, as before QP-PUBFACTS' report: the host finds no row it states, and Enough's refusal of the short node is answered `unreported`, as AL3's of qti-pie's import was."
			}
		]
	}
)
