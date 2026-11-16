import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { messageOf } from "#test/support/message.ts"
import { printCase } from "#test/support/oracle/public/print.ts"
import {
	breaksOf,
	caseOf,
	caseSpace,
	type Feature,
	rewrites,
	roundTrips,
	rulesRequired
} from "#test/unit/check/roundtrip.fixtures.ts"

/** Generated queries round-trip through their descriptions a live description reads back as the same Description and IR, and a broken one is refused with its rule's reason. Its budget is its suite's before it was a property (test/unit/check/roundtrip.test.ts at 4ca3036a): 800 runs and 800 steered cases. */
export const generatedQueriesRoundTripThroughTheirDescriptionsALiveDescriptionReadsBackAsTheSameDescriptionAndIRAndABrokenOneIsRefusedWithItsRulesReason =
	property.explore(caseSpace, {
		needs: {},
		budget: { runs: 800, steered: 800 },
		situations: [
			"live",
			...Arr.map(rewrites, (r) => r.feature),
			...rulesRequired
		] satisfies ReadonlyArray<Reached<Feature>>,
		check: (_, k: Case<Feature>) => (source) =>
			Effect.sync(() => {
				const c = caseOf(source, k.draw)
				try {
					roundTrips(c, breaksOf(source), k.draw, k.note)
				} catch (e) {
					throw new Error(`${messageOf(e)}\n${printCase(c)}`, { cause: e })
				}
			}),
		oracle: {
			kind: "universal",
			name: "decode ∘ encode = id over a description, and each corruption's own reason"
		},
		kept: [
			{
				token: ReplayToken(
					"test/unit/check/roundtrip.test.ts#generatedQueriesRoundTripThroughTheirDescriptionsALiveDescriptionReadsBackAsTheSameDescriptionAndIRAndABrokenOneIsRefusedWithItsRulesReason:400000000.22:0"
				),
				reason: "the span case live",
				since: "2026-10-29"
			},
			{
				token: ReplayToken(
					"test/unit/check/roundtrip.test.ts#generatedQueriesRoundTripThroughTheirDescriptionsALiveDescriptionReadsBackAsTheSameDescriptionAndIRAndABrokenOneIsRefusedWithItsRulesReason:400000000.22:1"
				),
				reason: "the span case broken at twoSpanProducers",
				since: "2026-10-29"
			},
			{
				token: ReplayToken(
					"test/unit/check/roundtrip.test.ts#generatedQueriesRoundTripThroughTheirDescriptionsALiveDescriptionReadsBackAsTheSameDescriptionAndIRAndABrokenOneIsRefusedWithItsRulesReason:100000000.20:1"
				),
				reason: "the span case broken at allenLiteralSpan",
				since: "2026-10-29"
			},
			{
				token: ReplayToken(
					"test/unit/check/roundtrip.test.ts#generatedQueriesRoundTripThroughTheirDescriptionsALiveDescriptionReadsBackAsTheSameDescriptionAndIRAndABrokenOneIsRefusedWithItsRulesReason:200000000.21:1"
				),
				reason: "the span case broken at allenParamSpan",
				since: "2026-10-29"
			},
			{
				token: ReplayToken(
					"test/unit/check/roundtrip.test.ts#generatedQueriesRoundTripThroughTheirDescriptionsALiveDescriptionReadsBackAsTheSameDescriptionAndIRAndABrokenOneIsRefusedWithItsRulesReason:80000000.1f:1"
				),
				reason: "the span case broken at allenEmptyMask",
				since: "2026-10-29"
			},
			{
				token: ReplayToken(
					"test/unit/check/roundtrip.test.ts#generatedQueriesRoundTripThroughTheirDescriptionsALiveDescriptionReadsBackAsTheSameDescriptionAndIRAndABrokenOneIsRefusedWithItsRulesReason:200.9:1"
				),
				reason: "the span case broken at compareOp",
				since: "2026-10-29"
			},
			{
				token: ReplayToken(
					"test/unit/check/roundtrip.test.ts#generatedQueriesRoundTripThroughTheirDescriptionsALiveDescriptionReadsBackAsTheSameDescriptionAndIRAndABrokenOneIsRefusedWithItsRulesReason:40000.12:1"
				),
				reason: "the span case broken at pageParentVar",
				since: "2026-10-29"
			}
		],
		kills: [
			{
				file: "packages/engine/src/ir/desc.ts",
				original: "\ttransportJson(desc, everyProperty)",
				replacement: '\ttransportJson(desc, { omit: (key) => key === "dir" })',
				why: "A description's JSON drops every order's direction (ir/desc.ts descToJson); the round trip property fails."
			}
		]
	})
