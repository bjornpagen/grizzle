/**
 * A paged member's window, read at the boundary before any SQL (packages/grizzle/src/adapter/page/window.ts windowCall).
 *
 * A window is exactly `{ anchor, size }`, its size a safe integer of at least 1 with no upper bound, its anchor exactly
 * `{ kind: "start" }`, `{ kind: "end" }`, `{ kind: "after", key }` or `{ kind: "before", key }`, whose key is a list of
 * one value per comparator of the page's completed order, each admitted by its comparator's codec. A window of any other
 * own members is refused as CallInputRefused `window`, a size the rule refuses as `size`, and every other anchor as
 * `anchor`, judged in that order; an inherited member is no member, and a symbol key is an own member. An admitted window
 * is the call of its template: start the first, after the after, end the last and before the before template, its size,
 * and an anchored one's boundary, each comparator's canonical text of the key's value at its position. The rule is
 * restated here as the oracle, over comparators drawn from int4, int8, bool, uuid and text and windows drawn over every
 * member's presence, own or inherited, and every size, kind, key length and key value, each comparator's edge values and
 * the other carriers' among them.
 *
 * Features: each admitted kind, each refusal, an inherited member, a key of another length, and each comparator's key
 * value admitted and refused.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { aimed } from "@bjornpagen/testing/gen"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Result } from "effect"
import { CallInputRefused } from "#adapter/errors/failures.ts"
import { windowCall } from "#adapter/page/window.ts"
import { emptyCodebook } from "#compiler/ir/codes.ts"
import { scalarCodec } from "#compiler/plan/runtime.ts"
import { assert } from "#test/support/assert.ts"
import {
	comparatorNames,
	comparatorTypes,
	expectedOf,
	presences,
	windowCaseGen,
	type WindowFeature,
	windowAims,
	windowOf
} from "#test/unit/page/request.fixtures.ts"

/**
 * A window admits exactly an anchor and a size as its template's call, and refuses every other window by its members,
 * its size or its anchor.
 *
 * Budget: its suite's count before the conversion (unit/page/window: 2000 independent cases and 640 steered, Vitest at
 * grizzle 4ca3036a). Its fixed witnesses hold no key longer than its comparators, so that case is kept (its kept
 * token, found by the kill's mutant at the runner's budget and shrunk): at TEST_SEED=1 to 5 every kill is killed.
 */
export const aWindowAdmitsExactlyAnAnchorAndASizeAsItsTemplatesCallAndRefusesEveryOtherWindowByItsMembersItsSizeOrItsAnchor =
	property.explore(aimed(windowCaseGen, windowAims), {
		needs: {},
		situations: [
			"start",
			"after",
			"end",
			"before",
			"window",
			"size",
			"anchor",
			"an inherited member",
			"a key of another length",
			...Arr.flatMap(comparatorNames, (comparator): ReadonlyArray<WindowFeature> => [
				`an admitted ${comparator} value`,
				`a refused ${comparator} value`
			])
		] satisfies ReadonlyArray<Reached<WindowFeature>>,
		check: (_, note: Case<WindowFeature>) => (c) =>
			Effect.sync(() => {
				if (Arr.some(presences(c), (p) => p === "inherited")) {
					note.note("an inherited member")
				}
				const expected = expectedOf(c)
				note.noteAll(expected.reached)
				const codecs = Arr.map(c.comparators, (comparator) =>
					scalarCodec(comparatorTypes[comparator], emptyCodebook)
				)
				assert.deepEqual(
					windowCall(windowOf(c), codecs),
					expected.kind === "admitted"
						? Result.succeed(expected.call)
						: Result.fail(new CallInputRefused({ fault: expected.fault }))
				)
			}),
		oracle: { kind: "specification", name: "the window rule restated (expectedOf)" },
		budget: { runs: 2000, steered: 640 },
		kept: [
			{
				token: ReplayToken(
					"test/unit/page/request.test.ts#aWindowAdmitsExactlyAnAnchorAndASizeAsItsTemplatesCallAndRefusesEveryOtherWindowByItsMembersItsSizeOrItsAnchor:100.8:0.0.0.0.1.0.0.1.0.0.1.0.1.1.0.7.0.0.0.0.0"
				),
				reason:
					"a window whose key holds one value more than its comparators, which must be refused",
				since: "2026-11-16"
			}
		],
		kills: [
			{
				file: "packages/grizzle/src/adapter/page/window.ts",
				original: '\ttypeof value === "number" && Number.isSafeInteger(value) && value >= 1',
				replacement: '\ttypeof value === "number" && Number.isSafeInteger(value) && value >= 0',
				why: "A size of 0 is admitted; the property fails."
			},
			{
				file: "packages/grizzle/src/adapter/page/window.ts",
				original: "\tif (!Arr.isArray(key) || Reflect.ownKeys(key).length !== length + 1) {",
				replacement: "\tif (!Arr.isArray(key) || Reflect.ownKeys(key).length < length + 1) {",
				why: "A key longer than the comparators is admitted; the property fails."
			}
		]
	})
