/**
 * A value fault never carries the value it refuses (scalar/values/fault.ts): a refusal is one fixed word of the
 * vocabulary, so a diagnostic never holds a parameter's value.
 *
 * - Secrecy: Decimal.of refuses a decimal past numeric's range, or misspelt, with a CompileError whose printed and
 *   formatted text holds none of the refused digits.
 *
 * Oracle: the specification turned into a checker, the refused text's digit run sought in every text the error prints.
 *
 * Features: each way a decimal is refused, past the range and misspelt.
 *
 * Plants: values-fault-echo (the refusal's location names the refused input).
 */
import { drawn, explore } from "@bjornpagen/testing/explore"
import { required } from "@bjornpagen/testing/features"
import { element } from "@bjornpagen/testing/gen"
import { matching } from "@bjornpagen/testing/pattern"
import { notesOnly } from "@bjornpagen/testing/sense"
import { completeShrink } from "@bjornpagen/testing/shrink"
import { searched } from "@bjornpagen/testing/vitest"
import { describe, it } from "@effect/vitest"
import { Effect, Formatter } from "effect"
import { isCompileError } from "#compiler/core/errors.ts"
import { numericMaxIntegerDigits } from "#compiler/ir/carriers.ts"
import { Decimal } from "#compiler/scalar/values/decimal.ts"
import { assert, lacksText } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"

import { regex } from "arkregex"

/** A decimal the admission refuses, out of range or misspelt, whose digits are a secret no refusal may repeat. */
type Refused = "out of range" | "misspelt"

describe("value faults", () => {
	it.effect("never carry the refused value", (ctx) =>
		searched(
			ctx,
			explore(
				{
					oracle: {
						kind: "specification",
						name: "no text the refusal prints holds the refused digits"
					},
					suite: "unit/values/fault-secrets",
					draw: drawn((source) => ({
						secret: source.draw(matching(regex("^[1-9]\\d{5,11}$"))),
						refused: source.draw(element<Refused>(["out of range", "misspelt"]))
					})),
					literal: Formatter.format,
					coverage: required<Refused>(["out of range", "misspelt"], {
						cases: 100,
						sense: notesOnly
					}),
					kept: [],
					runs: 100,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang
				},
				({ secret, refused }, c) =>
					Effect.sync(() => {
						c.note(refused)
						const text =
							refused === "out of range"
								? `${secret}.5e${numericMaxIntegerDigits.value}`
								: `${secret}.5x`
						assert.throws(
							() => Decimal.of(text),
							(error: unknown) => {
								assert.ok(isCompileError(error))
								lacksText(Formatter.format(error, { ignoreToString: true }), secret)
								lacksText(String(error), secret)
								return true
							}
						)
					})
			)
		)
	)
})
