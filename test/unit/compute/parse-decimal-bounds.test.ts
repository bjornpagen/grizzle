/**
 * The bounds Text.parseNumeric's value is typed with (scalar/compute/typing.ts parseNumeric, decimalBounds), over a
 * column of any text bounded by a few bytes, by about numericTextMaxBytes, or by up to two hundred thousand.
 *
 * - The parse is defined only within numericTextMaxBytes (its lexical precondition), so its value has as many integer
 *   digits as the lesser of the operand's bound and numericTextMaxBytes, and one fewer fraction digits: a bound within
 *   numericTextMaxBytes types it as it did, and one past it as numericTextMaxBytes does.
 * - The work: the exact edges a typing materializes, ±10 to its integer digits, have at most numericTextMaxBytes + 1
 *   digits whatever the operand's bound, where the operand's own bound made edges of as many digits as it has bytes
 *   (two of 268,435,455 digits for a regex-matched text, about 40 s each).
 *
 * Features: an operand within the parse's bytes; one past them.
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { type Bounds, digitsOfExact } from "#compiler/scalar/compute/bounds.ts"
import { numericTextMaxBytes } from "#compiler/scalar/lexical.ts"
import { succeeded } from "#test/support/assert.ts"
import { bytesGen, parsedOver } from "#test/unit/compute/parse-decimal-bounds.fixtures.ts"

type Situation = "within the parse's bytes" | "past them"

/** The digits an edge of a typing's bounds is written with: its exact value's, none for an infinity. */
const edgeDigits = (edge: Bounds["low"]): number =>
	edge.kind === "at" ? digitsOfExact(edge.value) : 0

/** Text.parseNumeric's bounds read the parse's bytes, never more than numericTextMaxBytes, and materialize no more. */
export const aParsedDecimalsBoundsReadTheParsesBytesNeverMoreThanDecimalTextMaxBytesAndMaterializeNoMore =
	property.explore(bytesGen, {
		needs: {},
		situations: ["within the parse's bytes", "past them"] satisfies ReadonlyArray<
			Reached<Situation>
		>,
		check: (_, c: Case<Situation>) => (bytes) =>
			Effect.sync(() => {
				const bounds = defined(
					succeeded(parsedOver(bytes)).root.bounds,
					"a parse over a bounded text is bounded"
				)
				const parsed = Math.min(bytes, numericTextMaxBytes)
				assert.equal(bounds.digits, parsed, `the integer digits over ${bytes} bytes`)
				assert.equal(
					bounds.scale,
					Math.max(parsed - 1, 0),
					`the fraction digits over ${bytes} bytes`
				)
				assert.ok(
					edgeDigits(bounds.low) <= numericTextMaxBytes + 1 &&
						edgeDigits(bounds.high) <= numericTextMaxBytes + 1,
					`the edges over ${bytes} bytes have ${edgeDigits(bounds.high)} digits, at most ${numericTextMaxBytes + 1}`
				)
				c.note(bytes <= numericTextMaxBytes ? "within the parse's bytes" : "past them")
			}),
		oracle: {
			kind: "specification",
			name: "the parse's lexical precondition: a decimal text within numericTextMaxBytes, no more than the operand's bytes"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/compute/typing.ts",
				original: "\tconst parsed = Math.min(bytes, numericTextMaxBytes)\n",
				replacement: "\tconst parsed = bytes\n",
				why: "The parse's bounds read the operand's nominal bound, as at 28ffbfcdc: an operand past numericTextMaxBytes makes edges of as many digits as it has bytes, past the bound, and the search fails."
			}
		]
	})
