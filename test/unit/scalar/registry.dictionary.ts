import { nonEmpty } from "@bjornpagen/testing/assert"
import { dictionary } from "@bjornpagen/testing/dictionary"
import { Array as Arr, Record as Rec } from "effect"
import { carriers, type ScalarType } from "#compiler/ir/scalar.ts"
import { isPlainCarrier, plainType, wildcardText } from "#test/support/fixtures/ir/scalar.ts"
import { codecTypes } from "#test/support/unit/codec/support.ts"
import { scalarTypes as irFixtureTypes } from "#test/support/unit/ir/fixture.ts"
import {
	E as conservativeEndpoints,
	T as conservativeTypes
} from "#test/support/unit/lower/conservative/fixtures.ts"

/**
 * The ScalarTypes the test fixture modules export (the IR fixture's, the conservative lowering's and the codec's), every
 * plain type and the canonical wildcard text, each beside where it comes from. What the fixtures export is the domain,
 * never cases a person chose for this suite.
 */
export const fixtureTypes = dictionary(
	nonEmpty<readonly [string, ScalarType]>(
		[
			...Arr.map(
				Rec.toEntries(irFixtureTypes),
				([name, t]) => [`ir/fixture.ts T.${name}`, t] as const
			),
			...Arr.map(
				Rec.toEntries(conservativeEndpoints),
				([name, t]) => [`lower/conservative/fixtures.ts E.${name}`, t] as const
			),
			...Arr.map(
				Rec.toEntries(conservativeTypes),
				([name, t]) => [`lower/conservative/fixtures.ts T.${name}`, t] as const
			),
			...Arr.map(
				Rec.toEntries(codecTypes),
				([name, t]) => [`codec/support.ts types.${name}`, t] as const
			),
			...Arr.map(
				Arr.filter(carriers, isPlainCarrier),
				(c) => [`plainType(${c})`, plainType(c)] as const
			),
			...Rec.toEntries({ wildcardText })
		],
		"the fixture types"
	)
)
