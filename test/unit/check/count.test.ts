/**
 * A count is a natural (scalar/aggregate.ts countOverload): `r.count()` is typed natural wherever it is read, a natural
 * every schema holds (schema/own.ts #collectFields), so it meets a natural field, parameter or literal and no bigint,
 * and a rule's place, the count of the rows before it beside 0 where there are none, is one term of one type.
 *
 * The box, exhausted: a count of Item's rows by their kind, read in a query's head; as a stored derived relation's
 * field; written by an insert into a natural field or a bigint one; in the head of two rules, the count's and
 * one delivering 0n, a natural field or a bigint field, read as the query's head or inserted into a natural field; and read
 * from the derived relation by a filter against a natural parameter, a bigint parameter or the literal 1n; each in a
 * schema that declares a natural field of its own, Tally's, or one that declares none where the reading declares none
 * either. 26 cases.
 *
 * Property, per case, against the model (count.fixtures.ts modelOf), the rule stated again over the case's shape: the
 * count's type where a head or a derived field reads it is natural, a write or a filter compiles where the other side is
 * natural or a literal, and one that meets a bigint is refused, as DescribedHeadingMismatch for a write's member column,
 * MalformedDescription for a union's arms or a comparison.
 *
 * Features: each reading and each side, and a schema declaring no natural field.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect, Formatter } from "effect"
import {
	countGen,
	type CountFeature,
	featuresOf,
	modelOf,
	observedOf
} from "#test/unit/check/count.fixtures.ts"

/** A count is a natural wherever it is read: it meets a natural field, parameter or literal, and no bigint. */
export const aCountIsANaturalWhereverItIsReadMeetingANaturalFieldParameterOrLiteralAndNoBigint =
	property.exhaust(finite(countGen), {
		needs: {},
		situations: [
			"read in a head",
			"read as a derived field",
			"written into a natural",
			"written into a bigint, refused",
			"beside 0 in a union",
			"beside a natural in a union",
			"beside a bigint in a union, refused",
			"a union written into a natural",
			"compared with a natural",
			"compared with a bigint, refused",
			"compared with a literal",
			"a schema declaring no natural field"
		] satisfies ReadonlyArray<Reached<CountFeature>>,
		check: (_, k: Case<CountFeature>) => (c) =>
			Effect.sync(() => {
				k.noteAll(featuresOf(c))
				assert.deepEqual(observedOf(c), modelOf(c), `the count read in ${Formatter.format(c)}`)
			}),
		oracle: {
			kind: "specification",
			name: "a count is a natural, which meets only a natural or a literal (count.fixtures.ts modelOf)"
		},
		box: "a count of Item by kind, read in a head, as a derived field, inserted into a natural or a bigint, beside 0n, a natural or a bigint in two rules read or inserted into a natural, and filtered against a natural parameter, a bigint parameter or 1n; Tally's natural declared or not",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/aggregate.ts",
				original: "\tresult: naturalType,\n",
				replacement: '\tresult: plainType("int8"),\n',
				why: "A count is a bigint, so the two rules of a place, n: r.count() beside n: 0n, are a bigint head, refused where it is inserted into a natural field, and the property fails."
			},
			{
				file: "packages/engine/src/schema/own.ts",
				original:
					"\t\tthis.#contracts.set(naturalOwned.desc.name, { ...naturalOwned, level: 0 })\n",
				replacement: "\t\tvoid naturalOwned\n",
				why: "A schema that declares no natural field holds no natural, so a derived relation's count is refused as a contract the schema does not declare, and the property fails."
			}
		]
	})
