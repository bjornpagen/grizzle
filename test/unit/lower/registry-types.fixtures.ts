/** What the properties of registry-types.test.ts read: its spaces, models and helpers. */

import type { HeadingColumn } from "#compiler/ir/rel.ts"
import { numericTypmodOf, sameScalarType, textOf } from "#compiler/ir/scalar.ts"
import { wildcardText } from "#compiler/scalar/compute/types.ts"
import { plainType } from "#compiler/scalar/native.ts"
import { assert } from "#test/support/assert.ts"
import { isPlainCarrier } from "#test/support/fixtures/ir/scalar.ts"

/** What a case's root reached; a query a lowering refuses has no delivered types to judge, and is noted as such: the
 * lowerings' refusals are their own suites'. */
export type RootFeature =
	| "plain root"
	| "attached root"
	| "heterogeneous union"
	| "a query a lowering refuses"

/** A delivered column of a plain carrier is typed as the registry states the carrier, and wildcard text as the registry's. */
export const registryTyped = (column: HeadingColumn): void => {
	const type = column.type
	if (
		isPlainCarrier(type.carrier) &&
		type.contract === undefined &&
		numericTypmodOf(type) === undefined
	) {
		assert.ok(
			sameScalarType(type, plainType(type.carrier)),
			`${column.name}: the registry's ${type.carrier}`
		)
	}
	if (textOf(type) === "wildcard" && type.contract === undefined) {
		assert.ok(sameScalarType(type, wildcardText), `${column.name}: the registry's wildcard text`)
	}
}
