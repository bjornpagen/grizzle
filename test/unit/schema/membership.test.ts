/**
 * A membership of one value is the equality with it (schema/own.ts canonicalPredicate): `x IN (v)`, and `x IN (v, v)`,
 * which names one value twice, are `x = v`, so the two spellings are one statement, at a row check's helper, at
 * Compute and in a side's selection, over a closed id read against its roster's handles and over an integer: one
 * fingerprint, one canonical statement, one list of laws, every law under one identity, and one install script, the
 * generated columns of a selected side named alike. A membership of two values stays an IN list, of its own meaning.
 *
 * The oracle is the schema written with the equality, `x = v`, read through the same owning, lawsOf and installation
 * as the IN: a specification, PostgreSQL's `x IN (v)` being `x = v`. The box: 3 surfaces × 2 fields × 3 lists,
 * exhausted (18 cases).
 *
 * Features: a list of one value, of one value twice, and of two values.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { assert } from "#test/support/assert.ts"
import {
	holdsIn,
	type ListForm,
	membershipGen,
	namesOne,
	readingsOf
} from "#test/unit/schema/membership.fixtures.ts"

/** A membership of one value is its equality, at every surface, and one of two values stays a membership. */
export const aMembershipOfOneValueIsItsEqualityOneStatementLawsAndScriptAndOneOfTwoValuesStaysAnInList =
	property.exhaust(finite(membershipGen), {
		box: "every surface (a row check's helper, Compute, a side's selection) by a closed id and an integer field by a list of one value, one value twice and two values",
		needs: {},
		situations: ["one", "one twice", "two"] satisfies ReadonlyArray<Reached<ListForm>>,
		check: (_, c: Case<ListForm>) => (m) =>
			Effect.sync(() => {
				c.note(m.list)
				const written = readingsOf(m, "in")
				const equality = readingsOf(m, "eq")
				const label = `${m.surface} over ${m.field}, a list of ${m.list}`
				if (!namesOne(m)) {
					assert.equal(holdsIn(written.statement), true, `${label}: a list of two values stays IN`)
					assert.notEqual(written.fingerprint, equality.fingerprint, label)
					return
				}
				assert.equal(holdsIn(written.statement), false, `${label}: no IN of one value is left`)
				assert.equal(written.fingerprint, equality.fingerprint, `${label}: one fingerprint`)
				assert.deepEqual(written.statement, equality.statement, `${label}: one canonical statement`)
				assert.deepEqual(written.laws, equality.laws, `${label}: one law under one identity`)
				assert.deepEqual(written.sql, equality.sql, `${label}: one install script`)
			}),
		oracle: {
			kind: "specification",
			name: "the schema written with the equality x = v, PostgreSQL's meaning of x IN (v)"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/schema/own.ts",
				original:
					'\t\t\t\tif (rules.has("inOfOne") && only !== undefined && others.length === 0) {',
				replacement:
					'\t\t\t\tif (rules.has("inOfOne") && only !== undefined && others.length === -1) {',
				why: "An IN list of one value kept as an IN: its canonical text, its laws' identities and the generated columns of a selected side are the IN's, not the equality's."
			}
		]
	})
