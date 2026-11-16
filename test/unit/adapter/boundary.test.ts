import { type Reached } from "@bjornpagen/testing/features"
import { constant } from "@bjornpagen/testing/gen"
import { drawnFeature, lsw, passed, WILD_KINDS, type WildKind } from "@bjornpagen/testing/lsw"
import { type Case, property } from "@bjornpagen/testing/property"
import { absurd, Array as Arr, Effect, Option } from "effect"
import { parseSchemaInput } from "#compiler/program/schema.ts"
import { assert, failed, succeeded } from "#test/support/assert.ts"
import {
	accessorFaults,
	callOf,
	type DoorFeature,
	keyed,
	Shop,
	textCodec,
	variants,
	wildVerdict,
	windowCaseGen,
	type WindowFeature,
	windowFeatures,
	windowInput,
	withAccessor
} from "#test/unit/adapter/boundary.fixtures.ts"

/** The public boundary answers every paged member's window by the README's contract, and refuses every other value with a typed refusal. */
export const thePublicBoundaryAnswersEveryPagedMembersWindowByTheREADMEsContractAndRefusesEveryOtherValueWithATypedRefusal =
	property.explore(windowCaseGen, {
		needs: {},
		situations: windowFeatures satisfies ReadonlyArray<Reached<WindowFeature>>,
		check: (_, k: Case<WindowFeature>) => (c) =>
			Effect.sync(() => {
				if (c.kind === "accessor") {
					const { input, calls } = withAccessor(c.base, c.field)
					const refusal = failed(callOf(input))
					assert.equal(refusal.fault, accessorFaults[c.field])
					assert.equal(calls(), 0, "the caller's getter never runs")
					k.note(`an accessor at the ${c.field}, refused uncalled`)
					return
				}
				k.note(drawnFeature(c.drawn))
				const result = callOf({ params: {}, facts: {}, window: windowInput(c) })
				const d = c.drawn
				if (d.kind === "live") {
					const admitted = succeeded(result)
					const w = d.value
					k.note(`anchor ${w.kind}`)
					assert.equal(admitted.variant, variants[w.kind])
					assert.equal(admitted.size, w.size)
					assert.deepEqual(
						"boundary" in admitted ? admitted.boundary : [],
						keyed(w.kind) ? [succeeded(textCodec.encode(w.key))] : []
					)
					return
				}
				if (d.kind === "stale") {
					return absurd(d.from)
				}
				k.note(`site ${c.site}`)
				const verdict = wildVerdict(c.site, passed(d))
				if (verdict === "admitted") {
					succeeded(result)
					return
				}
				assert.equal(failed(result).fault, verdict)
				k.note(`refused at ${verdict}`)
			}),
		oracle: {
			kind: "specification",
			name: "README Reading's window: its four anchors, a size of at least 1, a key its comparators' codecs admit"
		},
		kept: [],
		kills: [
			{
				file: "packages/grizzle/src/adapter/page/window.ts",
				original: '\ttypeof value === "number" && Number.isSafeInteger(value) && value >= 1',
				replacement: '\ttypeof value === "number" && Number.isSafeInteger(value) && value >= 0',
				why: "A window of size 0 is admitted."
			}
		]
	})

/** The public boundary admits a built schema at the schema door, and refuses every other value as a MalformedDescription. */
export const thePublicBoundaryAdmitsABuiltSchemaAtTheSchemaDoorAndRefusesEveryOtherValueAsAMalformedDescription =
	property.explore(
		lsw<typeof Shop>({
			live: constant(Shop),
			stale: Option.none(),
			wild: WILD_KINDS
		}),
		{
			needs: {},
			situations: [
				"live",
				...Arr.map(WILD_KINDS, (k: WildKind): DoorFeature => `wild ${k}`)
			] satisfies ReadonlyArray<Reached<DoorFeature>>,
			check: (_, k: Case<DoorFeature>) => (d) =>
				Effect.sync(() => {
					k.note(drawnFeature(d))
					const parsed = parseSchemaInput(passed(d))
					if (d.kind === "live") {
						assert.ok(parsed.ok)
						return
					}
					assert.ok(!parsed.ok)
					assert.equal(parsed.error.reason._tag, "MalformedDescription")
				}),
			oracle: {
				kind: "specification",
				name: "a schema door takes a value schema(...) built and refuses anything else"
			},
			kept: [],
			kills: []
		}
	)
