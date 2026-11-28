import { assert, defined } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option, Result } from "effect"
import { checkQuery } from "#compiler/check/index.ts"
import { queryInput } from "#compiler/program/input.ts"
import { refused, succeeded, throwsRefused } from "#test/support/assert.ts"
import { checkOptions } from "#test/support/policy.ts"
import {
	type Arm,
	armsSpace,
	checked,
	expectedOf,
	type Feature,
	featuresOf,
	plainDefaults,
	tokenOf,
	unionOf
} from "#test/unit/check/head-literals.fixtures.ts"

/** Head literal typing types a head literal by the field it writes, its union's term-typed arms or its value, and a handle by its roster. Its budget is its suite's before it was a property (test/unit/check/head-literals.test.ts at 4ca3036a): 400 runs and 400 steered cases. */
export const headLiteralTypingTypesAHeadLiteralByTheFieldItWritesItsUnionsTermTypedArmsOrItsValueAndAHandleByItsRoster =
	property.explore(armsSpace, {
		needs: {},
		budget: { runs: 400, steered: 400 },
		situations: [
			"a plain text its rule fixes Kind to",
			"a plain text its rule fixes Kind to by a handle",
			"a Numeric or a Money",
			"a plain literal beside a term-typed arm",
			"a plain literal the term-typed arms' type refuses",
			"a handle",
			"a typed literal",
			"plain literals only",
			...Arr.map(plainDefaults, (type) => `plain literals only, typed ${type}` as const),
			"a number that is no safe integer",
			"text of two refinements",
			"refused",
			"typed"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check: (_, c: Case<Feature>) => (drawnArms) =>
			Effect.sync(() => {
				const [first, ...rest] = drawnArms
				const arms: Arr.NonEmptyReadonlyArray<Arm> = [defined(first, "a drawn arm"), ...rest]
				const expected = expectedOf(arms)
				c.noteAll(featuresOf(arms, expected))
				if (Result.isFailure(Result.try(() => unionOf(arms)))) {
					assert.equal(
						expected.kind,
						"refused",
						"the builder refuses only a union the rule refuses: one whose arms deliver c at carriers no rule combines, refused as its rules are added (schema/record.ts carrierUnion); the checker refuses any other"
					)
					throwsRefused(() => unionOf(arms), "MalformedDescription", "the union's arms' carriers")
					return
				}
				const input = succeeded(
					queryInput(unionOf(arms)),
					"the builder admits every union whose arms' carriers it combines"
				)
				const result = checkQuery(checked, input.desc, checkOptions("head literals"))
				if (expected.kind === "refused") {
					refused(result, "MalformedDescription", "the union the rule refuses is refused")
					return
				}
				const dag = succeeded(result, "the union the rule types is checked").dag
				const root = dag.roots[0]
				Option.match(
					Arr.findFirst(root.heading, (col) => col.name === "c"),
					{
						onNone: () => assert.fail("the checked root delivers the head field c"),
						onSome: (column) => {
							assert.equal(
								tokenOf(column.type),
								expected.type,
								"c takes the type the rule gives it"
							)
						}
					}
				)
			}),
		oracle: {
			kind: "specification",
			name: "the head literal rule over a universe of types this file states"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/check/checker.ts",
				original: '\t\t\tinteger: "int4",',
				replacement: '\t\t\tinteger: "int8",',
				why: "A plain safe integer defaults to bigint (check/checker.ts bareLiteralType); the property fails."
			}
		]
	})
