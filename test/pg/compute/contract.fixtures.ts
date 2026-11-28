/** What the property of contract.test.ts reads: its contract Rate, its literals and its evaluator schema. */
import { array, element, type Gen, int, weighted } from "@bjornpagen/testing/gen"
import { pipe, String as Str } from "effect"
import { computeCore } from "#compiler/scalar/compute/builders.ts"
import { evaluatorTemplate } from "#test/support/pg/compute/support.ts"
import { testContract, testPg } from "#test/support/unit/compute/support.ts"

/**
 * The rounding property's search: the rotating 2 batches of literals and the floor's 1, about the generated sample each
 * contract sent before the search.
 */
export const domainRuns = 2

/**
 * The evaluator's schema (compute/support.ts evaluatorTemplate) each case's transaction creates its contract's domain in
 * and casts its literals over, the domain undone with the transaction.
 */
export const contractEvaluator = evaluatorTemplate(import.meta, "contract evaluator")

/** The contract the rounding property casts into: a rate of numeric(7, 6) within [0, 1]. */
export const Rate = testContract("Rate", testPg.numericOf(7, 6), (x) =>
	computeCore.between(x, 0n, 1n)
)

/** Rate's rounding edges: values a half-unit of its scale either side of its bounds, and a few beyond its typmod. */
const roundingEdges = [
	"0.0000005",
	"0.0000004",
	"-0.0000004",
	"-0.0000005",
	"0.9999994",
	"0.9999995",
	"0.99999949",
	"1.0000004",
	"1.0000005",
	"1.00000049999",
	"0.0625",
	"1.5",
	"9.9999995",
	"10",
	"NaN"
] as const

/** A literal of eight fraction digits about Rate's bounds. */
const roundingLiteral: Gen<string> = (source) =>
	`${source.draw(int(-1, 1))}.${pipe(String(source.draw(int(0, 99999999))), Str.padStart(8, "0"))}`

/** A batch of literals cast into Rate: its edges weighted among the drawn ones. */
export const roundingBatch: Gen<ReadonlyArray<string>> = array(
	weighted<string>([
		[1, element(roundingEdges)],
		[8, roundingLiteral]
	]),
	{ min: 1, max: 300 }
)
