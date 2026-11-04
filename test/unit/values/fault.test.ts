import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { element } from "@grizzle/testing/gen"
import { matching } from "@grizzle/testing/pattern"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Duration, Effect, Formatter } from "effect"
import { isCompileError } from "#compiler/core/errors.ts"
import { Decimal } from "#compiler/scalar/values/decimal.ts"
import { assert, lacksText } from "#test/support/assert.ts"

import { regex } from "arkregex"
/** A decimal the admission refuses, out of range or misspelt, whose digits are a secret no refusal may repeat. */
type Refused = "out of range" | "misspelt"

describe("value faults", () => {
	it.effect("never carry the refused value", (ctx) =>
		searched(
			ctx,
			explore(
				{
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
					caseHang: Duration.minutes(2)
				},
				({ secret, refused }, c) =>
					Effect.sync(() => {
						c.note(refused)
						const text = refused === "out of range" ? `${secret}.5e999999999` : `${secret}.5x`
						assert.throws(
							() => Decimal.of(text),
							(error: unknown) => {
								assert.ok(isCompileError(error))
								lacksText(JSON.stringify(error), secret)
								lacksText(String(error), secret)
								return true
							}
						)
					})
			)
		)
	)
})
