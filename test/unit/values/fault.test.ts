/**
 * A value fault never carries the value it refuses (scalar/values/fault.ts): a refusal is one fixed word of the
 * vocabulary, so a diagnostic never holds a parameter's value.
 *
 * - Secrecy: Numeric.of refuses a decimal past numeric's range, or misspelt, with a CompileError whose printed and
 *   formatted text holds none of the refused digits.
 *
 * Oracle: the specification turned into a checker, the refused text's digit run sought in every text the error prints.
 *
 * Features: each way a decimal is refused, past the range and misspelt.
 */

import { assert, lacksText } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { element } from "@bjornpagen/testing/gen"
import { matching } from "@bjornpagen/testing/pattern"
import { type Case, property } from "@bjornpagen/testing/property"
import { regex } from "arkregex"
import { Effect, Formatter } from "effect"
import { isCompileError } from "#compiler/core/errors.ts"
import { Numeric } from "#compiler/scalar/values/decimal.ts"
import { numericMaxIntegerDigits } from "#compiler/scalar/values/fault.ts"
import type { Refused } from "#test/unit/values/fault.fixtures.ts"

/** Value faults never carry the refused value. Its budget is its suite's before it was a property (test/unit/values/fault.test.ts at 4ca3036a): 100 runs and 100 steered cases. */
export const valueFaultsNeverCarryTheRefusedValue = property.explore(
	(source) => ({
		secret: source.draw(matching(regex("^[1-9]\\d{5,11}$"))),
		refused: source.draw(element<Refused>(["out of range", "misspelt"]))
	}),
	{
		needs: {},
		budget: { runs: 100, steered: 100 },
		situations: ["out of range", "misspelt"] satisfies ReadonlyArray<Reached<Refused>>,
		check:
			(_, c: Case<Refused>) =>
			({ secret, refused }) =>
				Effect.sync(() => {
					c.note(refused)
					const text =
						refused === "out of range" ? `${secret}.5e${numericMaxIntegerDigits}` : `${secret}.5x`
					assert.throws(
						() => Numeric.of(text),
						(error: unknown) => {
							assert.ok(isCompileError(error))
							lacksText(Formatter.format(error, { ignoreToString: true }), secret)
							lacksText(String(error), secret)
							return true
						}
					)
				}),
		oracle: {
			kind: "specification",
			name: "no text the refusal prints holds the refused digits"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/values/decimal.ts",
				original: '\t\t\tthrow faultError(parsed.error, SourceLoc("Numeric literal", []))',
				replacement: `\t\t\tthrow faultError(parsed.error, SourceLoc(\`Numeric literal \${String(input)}\`, []))`,
				why: "Numeric.admit's refusal names the refused input in its location; the secrecy property fails."
			}
		]
	}
)
