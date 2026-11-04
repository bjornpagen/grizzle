import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { noCoverage } from "@grizzle/testing/features"
import { element, int } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Duration, Effect, Formatter } from "effect"
import { valuesMaxRows } from "#compiler/core/policy.ts"
import * as Result from "#compiler/core/result.ts"
import { relationBound, relationTransport } from "#compiler/lower/shapes/relparam/index.ts"
import { assert } from "#test/support/assert.ts"

describe("the R22 size rule", () => {
	it.effect(
		"VALUES from one row up to valuesMaxRows, a recordset otherwise, nothing above recordsetMaxRows",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/lower/relparam/transport",
						literal: Formatter.format,
						generator: (source) => {
							const limits = source.draw(
								element([
									{ valuesMaxRows: 1, recordsetMaxRows: 2 },
									{ valuesMaxRows: 2, recordsetMaxRows: 5 },
									{ valuesMaxRows, recordsetMaxRows: valuesMaxRows + 3 }
								])
							)
							return { limits, n: source.draw(int(0, limits.recordsetMaxRows + 2)) }
						},
						/**
						 * Every row count from none to two past the recordset rule, under each of the three limit pairs: 35
						 * cases under core/policy.ts valuesMaxRows of 16.
						 */
						limit: 64,
						coverage: noCoverage,
						caseHang: Duration.minutes(2)
					},
					({ limits, n }) =>
						Effect.sync(() => {
							const bound = relationBound(n, limits)
							if (n > limits.recordsetMaxRows) {
								assert.deepEqual(bound, Result.err("ResourceBound"))
							} else {
								assert.deepEqual(bound, Result.ok(n))
								assert.equal(
									relationTransport(
										Array.from({ length: n }, (_, i) => i),
										limits
									).kind,
									n > 0 && n <= limits.valuesMaxRows ? "values" : "recordset"
								)
							}
						})
				)
			)
	)
})
