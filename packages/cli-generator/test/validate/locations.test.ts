/**
 * Grouping a validator run's errors by location (validate/locations.ts, design 3.2): error units at locations drawn over
 * a small pointer tree (one reported twice, the root and other ancestors of several leaves, leaves reported out of
 * order), each spelled as the validator reports it (plain, percent-encoded, after a property name's `#*`, its tokens
 * escaped or not) or with a fault (no `#`, a broken percent escape, a fragment that is no pointer), group as design
 * 3.2's grouping says, or are refused naming the first faulted location.
 */
import { assert } from "@bjornpagen/testing/assert"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	expectedGroupingOf,
	type GroupFeature,
	groupFeaturesOf,
	groupingOf,
	groupSpace
} from "#test/validate/locations.fixtures.ts"

/** A drawn run's errors group as the model says. It replaces locations' three groupErrors examples. */
export const groupedLocations = property.explore(groupSpace, {
	needs: {},
	situations: [
		"a deepest pointer reported twice",
		"a context owned by the first of its leaves",
		"the root as context",
		"leaves out of report order",
		"a leaf with no context",
		"a location percent-encoded",
		"a property name's location",
		"an escaped token",
		"no hash refused",
		"a broken percent escape refused",
		"a fragment that is no pointer refused"
	],
	check: (_, c: Case<GroupFeature>) => (run) =>
		Effect.gen(function* () {
			c.noteAll(groupFeaturesOf(run))
			const grouping = yield* groupingOf(run)
			assert.deepEqual(grouping, expectedGroupingOf(run))
		}),
	oracle: {
		kind: "specification",
		name: "design 3.2's error locations: each deepest location a group in pointer order, every other error context of the first group below it"
	},
	kept: [],
	kills: [
		{
			file: "packages/cli-generator/src/validate/locations.ts",
			original: 'Str.startsWith("#*")(instanceLocation) ? 2 : 1',
			replacement: "1",
			why: "A property name's location keeps its `*`, so it is refused as no pointer; the property fails."
		},
		{
			file: "packages/cli-generator/src/validate/locations.ts",
			original: "try: () => decodeURIComponent(fragmentOf(instanceLocation))",
			replacement: "try: () => fragmentOf(instanceLocation)",
			why: "A location is never percent-decoded, so `a%20b` names another member and a broken escape passes; the property fails."
		},
		{
			file: "packages/cli-generator/src/validate/locations.ts",
			original:
				"(other) => other.pointer !== item.pointer && isPointerWithin(item.pointer, other.pointer)",
			replacement: "(other) => isPointerWithin(item.pointer, other.pointer)",
			why: "Every location lies within itself, so none is deepest and no error is grouped; the property fails."
		},
		{
			file: "packages/cli-generator/src/validate/locations.ts",
			original: "Arr.sort(Arr.dedupeWith(deepestItems, samePointer), byPointer)",
			replacement: "Arr.dedupeWith(deepestItems, samePointer)",
			why: "Leaves come out in report order, not pointer order; the property fails."
		},
		{
			file: "packages/cli-generator/src/validate/locations.ts",
			original: "Arr.findFirst(leaves,",
			replacement: "Arr.findLast(leaves,",
			why: "A context error belongs to the last leaf below it, not the first; the property fails."
		},
		{
			file: "packages/cli-generator/src/validate/locations.ts",
			original: "(item) => !deepestItems.has(item) && Option.exists",
			replacement: "(item) => Option.exists",
			why: "A deepest error is also its own group's context; the property fails."
		},
		{
			file: "packages/cli-generator/src/model/pointer.ts",
			original: "pointer === ancestor ||",
			replacement: "pointer !== ancestor ||",
			why: "isPointerWithin counts every other pointer as within, so the deepest locations and their contexts are wrong; the property fails (CATCH's evidence, mutant c38cb8519b)."
		}
	]
})
