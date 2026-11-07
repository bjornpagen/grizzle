/** Raw text capture: the host side of format('%L'). */
import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { noCoverage } from "@grizzle/testing/features"
import { string, unicodeScalar } from "@grizzle/testing/gen"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Effect, Formatter, pipe, String as Str } from "effect"
import { assert } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { unquoteLiteral } from "#test/support/oracle/install/capture.ts"

/**
 * What PostgreSQL's quote_literal writes for a non-NULL text (src/backend/utils/adt/quote.c): quotes and backslashes
 * doubled, and an E prefix when the text has a backslash.
 */
const quoteLiteral = (text: string): string => {
	const body = pipe(Str.replaceAll("'", "''")(text), Str.replaceAll("\\", "\\\\"))
	return Str.includes("\\")(text) ? `E'${body}'` : `'${body}'`
}

describe("unquoteLiteral", () => {
	it.effect("inverts quote_literal for every string", (ctx) =>
		searched(
			ctx,
			explore(
				{
					oracle: { kind: "unstated" },
					suite: "unit/oracle-install/capture-1",
					/** Any Unicode scalar value, never a lone surrogate. */
					draw: drawn(string(unicodeScalar, { min: 0, max: 10 })),
					literal: Formatter.format,
					coverage: noCoverage,
					kept: [],
					runs: 2000,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang
				},
				(text) =>
					Effect.sync(() => {
						assert.equal(unquoteLiteral(quoteLiteral(text)), text)
					})
			)
		)
	)
})
