/**
 * A call's facts past one share are drawn, bound and sent a share at a time (adapter/apply/shares.ts callShares and
 * eachShare), so the host holds one share's bound facts and its statements' parameters, never every fact's: the heap one
 * call holds beyond its facts, collected and read after each share's executions are built, is the same at four and at
 * sixteen shares' worth of facts as at one, where binding every share before sending any held it sixteen times over
 * (edullm's learning-commons split its release across child processes, a whole release in one call past the 4 GiB heap).
 */
import { assert } from "@bjornpagen/testing/assert"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Order } from "effect"
import {
	boundOf,
	type Drawn,
	drawnGen,
	type Feature,
	type Grouped,
	type GroupedFeature,
	groupedGen,
	runGrouped,
	runShares
} from "#test/unit/write/shares.fixtures.ts"

/** Each relation's rows by its name. */
const byRelation = Order.mapInput(
	Order.String,
	([relation]: readonly [string, unknown]) => relation
)

/**
 * A call of many shares' worth of facts holds on the host what a call of one share holds, within a share's slack.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const aCallOfManySharesOfFactsHoldsOnTheHostWhatACallOfOneShareHolds = property.explore(
	drawnGen,
	{
		needs: {},
		situations: ["a narrow body", "a wide body"] satisfies ReadonlyArray<Feature>,
		check: (_, c: Case<Feature>) => (d: Drawn) =>
			Effect.map(runShares(d, c), ({ one, four, sixteen }) => {
				const most = boundOf(one)
				assert.ok(
					sixteen.shares >= 16 && four.shares >= 4,
					`${Formatter.format(d)}: the calls are drawn in ${four.shares} and ${sixteen.shares} shares`
				)
				assert.ok(
					four.peak <= most && sixteen.peak <= most,
					`${Formatter.format(d)}: beyond its facts the call holds ${one.peak} bytes at one share, ${four.peak} at four and ${sixteen.peak} at sixteen, past ${most}`
				)
			}),
		oracle: {
			kind: "universal",
			name: "bound: the heap a call of four and of sixteen shares' facts holds beyond them is within three times one share's, and two shares' bytes"
		},
		kept: [],
		kills: [
			{
				file: "packages/grizzle/src/adapter/apply/shares.ts",
				original: "\t\tfor (const share of shares) {\n\t\t\tconst bound = yield* bind(share)",
				replacement:
					"\t\tconst all = yield* Effect.forEach(Arr.fromIterable(shares), bind)\n\t\tfor (const bound of all) {",
				why: "Every share is bound before any is sent, so the call holds every fact's bound form at once, sixteen shares' worth sixteen times one."
			}
		]
	}
)

/**
 * A call of learning-commons' families drawn in shares of whole groups fills every row as the whole call does: an
 * owner's ordered members, a tree's nodes and an area's counted members each in their owner's share, so every count,
 * end, slot and tree position the host draws is the whole call's.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const aCallOfFamiliesDrawnInSharesOfWholeGroupsFillsEveryRowAsTheWholeCallDoes =
	property.explore(groupedGen, {
		needs: {},
		situations: [
			"a call of several shares",
			"a group past a share"
		] satisfies ReadonlyArray<GroupedFeature>,
		check: (_, c: Case<GroupedFeature>) => (d: Grouped) =>
			Effect.map(runGrouped(d, c), ({ whole, shared }) => {
				assert.deepEqual(
					Arr.sort([...shared], byRelation),
					Arr.sort([...whole], byRelation),
					`${Formatter.format(d)}: the shares' inserted rows are the whole call's`
				)
			}),
		oracle: {
			kind: "universal",
			name: "every relation's rows the shares insert, as the host fills them, are the whole call's"
		},
		kept: [],
		kills: [
			{
				file: "packages/grizzle/src/adapter/apply/shares.ts",
				original: "\tconst families = familySlots(program)",
				replacement: "\tconst families: ReadonlyArray<FamilySlots> = []",
				why: "An area and its counted members are drawn as facts of their own, so a share holds an area with some of its members, and the host counts it at those alone."
			}
		]
	})
