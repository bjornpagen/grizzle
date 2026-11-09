import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { noCoverage } from "@grizzle/testing/features"
import { element, string } from "@grizzle/testing/gen"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter } from "effect"
import { Sqlstate } from "#compiler/core/sqlstate.ts"
import { assert, nonEmpty } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"

import { regex } from "arkregex"
/**
 * The hand-written scanners that replaced RegExp in the adapter when
 * their packages met the dependency gate (no RegExp construction, .test or .exec under src/). Each is pinned against the
 * regex it replaces over generated texts. Tests may use RegExp; src may not.
 *
 * The rotating stream's cases of every property here.
 */
const numRuns = 20_000

const textOf = (letters: string, maxLength: number) =>
	string(element(nonEmpty(Arr.fromIterable(letters), "an alphabet")), { min: 0, max: maxLength })

describe("scanners that replace a RegExp under src", () => {
	it.effect("Sqlstate.parse reads exactly /^[0-9A-Z]{5}$/, as the text itself", (ctx) =>
		Effect.gen(function* () {
			const reference = regex("^[0-9A-Z]{5}$")
			yield* searched(
				ctx,
				explore(
					{
						oracle: { kind: "unstated" },
						suite: "unit/deps/scanners-2",
						draw: drawn(textOf("09AZaz_ ٠", 7)),
						literal: Formatter.format,
						coverage: noCoverage,
						kept: [],
						runs: numRuns,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(text) =>
						Effect.sync(() => {
							const parsed: string | undefined = Sqlstate.parse(text)
							assert.equal(parsed, reference.test(text) ? text : undefined)
						})
				)
			)
		})
	)
})
