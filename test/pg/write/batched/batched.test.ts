/**
 * A write's insert of many facts runs in executions of a share of them each, within PostgreSQL's default work_mem
 * (runtime/write/bind.ts batchedExecutions, runtime/write/transport.ts writeBatching), in its one transaction. On
 * PostgreSQL 19 at its default work_mem, over a relation of two keys as wide as edullm's qti.node, whose insert's met
 * window sorts every fact it carries twice and whose CTEs keep them (batched.fixtures.ts): where one execution of every
 * fact wrote 77 MB of temporary files for 20,000 facts, no execution writes a temporary block, and the write inserts
 * what one execution would, or refuses it on the same key's law. An insert that carries a write's admission of a
 * relation parameter (write/program/admission.ts) is cut as one that carries none, its admission's placeholders bound
 * whole in every execution (runtime/write/flight.ts sharedWhole), so each execution's Bind admits the parameter again.
 */
import type { Reached } from "@bjornpagen/testing/features"
import { property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	type AdmittedFeature,
	admittedGen,
	admittedTemplate,
	type BatchedFeature,
	batchedGen,
	runAdmitted,
	runBatched
} from "#test/pg/write/batched/batched.fixtures.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"

/**
 * An insert of thousands of wide facts writes no temporary block in any of its executions, inserts every fact once,
 * and refuses two facts at one key whichever executions carry them.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const anInsertOfManyFactsRunsInSharesWithinWorkMemSoItsTemporaryFilesAreNoneWhateverItsFacts =
	property.explore(batchedGen, {
		needs: { substrate: Substrate.fresh(baseSubstrate) },
		situations: [
			"every fact inserted",
			"a pair across executions refused",
			"after a write of the same transaction"
		] satisfies ReadonlyArray<BatchedFeature>,
		check:
			({ substrate }, c) =>
			(drawn) =>
				Effect.provideServiceEffect(
					runBatched(drawn, c),
					Substrate,
					Effect.map(substrate, (taken) => taken.substrate)
				),
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

/**
 * An insert of thousands of wide facts that carries the admission of a relation parameter still runs in several
 * executions, each binding the whole parameter at its admission's placeholders, so every execution's Bind refuses a
 * value outside the parameter's type as ParamRejected, and inside it the write inserts every fact.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const anInsertCarryingARelationParametersAdmissionStillRunsInSharesEachExecutionsBindAdmittingTheWholeParameter =
	property.explore(admittedGen, {
		needs: { fixture: Substrate.fresh(admittedTemplate) },
		situations: [
			"every fact inserted, every execution binding the whole parameter",
			"an outside code refused at every execution's Bind"
		] satisfies ReadonlyArray<Reached<AdmittedFeature>>,
		check:
			({ fixture }, k) =>
			(drawn) =>
				Effect.flatMap(fixture, (taken) =>
					Effect.provideService(runAdmitted(drawn, k, taken), Substrate, taken.substrate)
				),
		oracle: {
			kind: "specification",
			name: "Code restated over the call's codes: inside it, several executions binding one value at each admission placeholder and every fact and code stored once; outside it, ParamRejected at named's field, nothing stored, and each execution of the batched flight, sent alone, refused as the parameter's"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/runtime/write/flight.ts",
				original: '\t\tcase "admission":\n\t\t\treturn true\n\t\tcase "relation":',
				replacement: '\t\t\treturn true\n\t\tcase "admission":\n\t\tcase "relation":',
				why: "An admission's placeholder is no placeholder every execution sends whole, so a member insert carrying a relation parameter's admission is sent as one execution of every fact, past one execution's share, as before admission placeholders were marked."
			}
		]
	})
