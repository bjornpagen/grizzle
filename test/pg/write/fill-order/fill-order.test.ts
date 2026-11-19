/**
 * The fill order on the cluster an admitted schema whose generated fields read fields grizzle draws or accumulates stores each as the reference writer, rowEvaluator and insertPreview give it, through every write.
 *
 * Its pre-conversion budget: runs 16, coverage cases 60 (test/pg/write/fill-order/fill-order.test.ts at d8eed1786).
 */
import { type Reached } from "@bjornpagen/testing/features"
import { recorded, steered } from "@bjornpagen/testing/gen"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	aims,
	caseGen,
	checkCase,
	type ClusterSituation,
	generationAims,
	generationCaseGen,
	generationSituations,
	situations,
	steeredBy,
	type ClusterCase,
	recordedFirstInserts
} from "#test/pg/write/fill-order/fill-order.fixtures.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
export const theFillOrderOnTheClusterAnAdmittedSchemaWhoseGeneratedFieldsReadFieldsGrizzleDrawsOrAccumulatesStoresEachAsTheReferenceWriterRowEvaluatorAndInsertPreviewGiveItThroughEveryWrite =
	property.explore(steered(steeredBy(generationAims, generationCaseGen)), {
		needs: { substrate: Substrate.installing },
		situations: generationSituations satisfies ReadonlyArray<Reached<ClusterSituation>>,
		check:
			({ substrate }, c: Case<ClusterSituation>) =>
			(value) =>
				Effect.provideServiceEffect(checkCase(value, c), Substrate, substrate),
		oracle: {
			kind: "second-implementation",
			name: "the reference writer (test/support/families/fill.ts writtenRows), rowEvaluator and insertPreview"
		},
		budget: { runs: 16, steered: 60 },
		kept: [
			{
				token: ReplayToken(
					"test/pg/write/fill-order/fill-order.test.ts#theFillOrderOnTheClusterAnAdmittedSchemaWhoseGeneratedFieldsReadFieldsGrizzleDrawsOrAccumulatesStoresEachAsTheReferenceWriterRowEvaluatorAndInsertPreviewGiveItThroughEveryWrite:10.4:1.0.1.1.0.1.5.1.0.0"
				),
				reason:
					"an owner's put refilling its counted members' fold of their copy of its g, the greater of its v and its ordered family's sum, which the put keeps",
				since: "2026-11-19"
			}
		],
		kills: []
	})

/**
 * The fill order on the cluster an admitted schema installs, and its instance's first insert stores the reference writer's rows.
 *
 * Its pre-conversion budget: runs 16, coverage cases 60 (test/pg/write/fill-order/fill-order.test.ts at d8eed1786).
 */
export const theFillOrderOnTheClusterAnAdmittedSchemaInstallsAndItsInstancesFirstInsertStoresTheReferenceWritersRows =
	property.explore(
		steered<ClusterCase, ClusterSituation>((steering) =>
			recorded(steeredBy(aims, caseGen)(steering), recordedFirstInserts)
		),
		{
			needs: { substrate: Substrate.installing },
			situations: situations satisfies ReadonlyArray<Reached<ClusterSituation>>,
			check:
				({ substrate }, c: Case<ClusterSituation>) =>
				(value) =>
					Effect.provideServiceEffect(checkCase(value, c), Substrate, substrate),
			oracle: {
				kind: "second-implementation",
				name: "the reference writer (test/support/families/fill.ts writtenRows)"
			},
			budget: { runs: 16, steered: 60 },
			kept: [
				{
					token: ReplayToken(
						"test/pg/write/fill-order/fill-order.test.ts#theFillOrderOnTheClusterAnAdmittedSchemaInstallsAndItsInstancesFirstInsertStoresTheReferenceWritersRows:-:1"
					),
					reason:
						"a delete of an ordered family's member re-places the next, which owns a counted member copying its index",
					since: "2026-11-19"
				},
				{
					token: ReplayToken(
						"test/pg/write/fill-order/fill-order.test.ts#theFillOrderOnTheClusterAnAdmittedSchemaInstallsAndItsInstancesFirstInsertStoresTheReferenceWritersRows:-:2"
					),
					reason:
						"a delete of an ordered family's member re-places the next, which owns a counted member copying its index, beside an append under it, which recounts it",
					since: "2026-11-19"
				},
				{
					token: ReplayToken(
						"test/pg/write/fill-order/fill-order.test.ts#theFillOrderOnTheClusterAnAdmittedSchemaInstallsAndItsInstancesFirstInsertStoresTheReferenceWritersRows:-:3"
					),
					reason:
						"a delete of an ordered family's member re-places the next, which owns a counted member and nothing copies",
					since: "2026-11-19"
				},
				{
					token: ReplayToken(
						"test/pg/write/fill-order/fill-order.test.ts#theFillOrderOnTheClusterAnAdmittedSchemaInstallsAndItsInstancesFirstInsertStoresTheReferenceWritersRows:-:4"
					),
					reason:
						"a delete and a move re-placing ordered members that are a counted family's, whose count falls",
					since: "2026-11-19"
				},
				{
					token: ReplayToken(
						"test/pg/write/fill-order/fill-order.test.ts#theFillOrderOnTheClusterAnAdmittedSchemaInstallsAndItsInstancesFirstInsertStoresTheReferenceWritersRows:-:5"
					),
					reason:
						"an owner's put refilling its counted members' fold of its copy, beside an insert of two more under it",
					since: "2026-11-19"
				},
				{
					token: ReplayToken(
						"test/pg/write/fill-order/fill-order.test.ts#theFillOrderOnTheClusterAnAdmittedSchemaInstallsAndItsInstancesFirstInsertStoresTheReferenceWritersRows:-:6"
					),
					reason:
						"a delete of an ordered family's first member redraws the rest, each copying its predecessor's generated field, and its owner the last one's",
					since: "2026-11-19"
				},
				{
					token: ReplayToken(
						"test/pg/write/fill-order/fill-order.test.ts#theFillOrderOnTheClusterAnAdmittedSchemaInstallsAndItsInstancesFirstInsertStoresTheReferenceWritersRows:-:7"
					),
					reason:
						"a delete of an ordered family's member re-places the next, an immutable owner of a counted member",
					since: "2026-11-19"
				},
				{
					token: ReplayToken(
						"test/pg/write/fill-order/fill-order.test.ts#theFillOrderOnTheClusterAnAdmittedSchemaInstallsAndItsInstancesFirstInsertStoresTheReferenceWritersRows:-:8"
					),
					reason:
						"an owner's put beside a delete of its ordered family's first member, which appends nothing",
					since: "2026-11-19"
				},
				{
					token: ReplayToken(
						"test/pg/write/fill-order/fill-order.test.ts#theFillOrderOnTheClusterAnAdmittedSchemaInstallsAndItsInstancesFirstInsertStoresTheReferenceWritersRows:-:9"
					),
					reason:
						"a counted fold stepping its member's copy along an ordered family's owner axis, the member moved to another owner",
					since: "2026-11-19"
				},
				{
					token: ReplayToken(
						"test/pg/write/fill-order/fill-order.test.ts#theFillOrderOnTheClusterAnAdmittedSchemaInstallsAndItsInstancesFirstInsertStoresTheReferenceWritersRows:-:a"
					),
					reason:
						"an owner's put beside a delete of its ordered member, re-placing another, whose copy of the owner's v along a counted family the put leaves stale",
					since: "2026-11-19"
				}
			],
			kills: []
		}
	)
