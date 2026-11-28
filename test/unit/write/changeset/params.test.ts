/**
 * One declaration of a relation parameter across a ChangeSet's members (write/frontend/compile.ts merge): two members
 * that read the parameter `rows` read one relation of one heading, so the ChangeSet compiles exactly when they declare
 * it under the same fields of the same types, in any order, and is refused MalformedDescription otherwise, a heading
 * within the other's among them, whichever member comes first.
 *
 * The box: R and S, each (b, c, d) keyed by (b, c), inserted in one stratum from `rows`, each member declaring it under
 * one of four headings: b, c and d; b and c; c, b and d, the first in another order; b, c and d with d a bigint.
 *
 * Oracle: the specification, read off the declarations themselves: each heading's fields with the FieldDesc its
 * builder recorded (schema/protocol.ts describedDesc), in name order, and two declarations one exactly when those are
 * equal, so no hand-written reading of a heading stands between a declaration and its verdict.
 *
 * Features: one heading, a heading within the other, a field of another type.
 */

import { deepEquals } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { changeSetOver as ChangeSet } from "#compiler/write/changeset/value.ts"
import { compileWrite } from "#compiler/write/program/compile.ts"
import { refused, succeeded } from "#test/support/assert.ts"
import { realityWrite, testArtifacts, testCompile } from "#test/support/compile.ts"
import { checking } from "#test/support/policy.ts"
import { descOf } from "#test/support/unit/write/changeset/fixtures.ts"
import {
	caseGen,
	fieldsOf,
	fromRows,
	Pair,
	type ParamFeature,
	R,
	S
} from "#test/unit/write/changeset/params.fixtures.ts"

/** A relation parameter two members read is one declaration: the ChangeSet compiles exactly when both declare its fields and their types alike. */
export const aRelationParameterTwoMembersReadIsOneDeclarationTheChangeSetCompilesExactlyWhenBothDeclareItsFieldsAndTheirTypesAlike =
	property.exhaust(finite(caseGen), {
		needs: {},
		situations: [
			"one heading",
			"a heading within the other",
			"a field of another type"
		] satisfies ReadonlyArray<Reached<ParamFeature>>,
		check:
			(_, c: Case<ParamFeature>) =>
			([first, second]) =>
				Effect.sync(() => {
					const write = ChangeSet.empty(Pair)
						.insert(R, fromRows(first, R))
						.insert(S, fromRows(second, S))
					const compiled = compileWrite(
						checking(Pair),
						descOf(write),
						realityWrite(succeeded(testArtifacts(Pair, testCompile)))
					)
					const [mine, theirs] = [fieldsOf(first), fieldsOf(second)]
					if (deepEquals(mine, theirs)) {
						succeeded(compiled, `${first} beside ${second}`)
						c.note("one heading")
						return
					}
					refused(compiled, "MalformedDescription", `${first} beside ${second}`)
					c.note(
						mine.length === theirs.length ? "a field of another type" : "a heading within the other"
					)
				}),
		oracle: {
			kind: "specification",
			name: "one declaration of a parameter: its fields and their types, apart from their order"
		},
		box: "R and S inserted from `rows`, each member declaring it under b, c and d; b and c; c, b and d; or b, c and d with d a bigint",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/write/frontend/compile.ts",
				original: "\t\treturn d !== undefined && sameScalarType(c.type, d.type)",
				replacement: "\t\treturn d !== undefined",
				why: "Two relation declarations merged by their field names alone (write/frontend/compile.ts sameHeading)."
			}
		]
	})
