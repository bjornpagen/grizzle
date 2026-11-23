/**
 * A definition is a relation: a role's query entry's that ends in `.orderBy(...).take(k)` installs its take's ORDER BY
 * and LIMIT and no order beside them, since a view's rows are a set to everything that reads it, though a query that
 * ends in the same take delivers its rows in the take's order. A stored derived relation ends in no take (its
 * definition is unit-local, which a take is not), and a live one installs nothing.
 *
 * Property: over a drawn base relation R (one to three fields of integer, bigint and uuid, its primary key a drawn
 * prefix of them) and a drawn definition over it, a role's query entry's, one rule, a union of two or a count grouped
 * by its head, ordered by drawn head columns and taking a drawn k: no SELECT of any installed role view orders rows it
 * does not limit, and some role view holds a limited SELECT, the take.
 *
 * Oracle: the specification that a view's rows are a set, read off the installed statements' typed SQL (an ORDER BY
 * with no LIMIT is a delivered order), never their text.
 *
 * Features: a world entry taking from each form (one rule, a union, a count), a take of one row, of two rows or more,
 * and a descending key.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	featuresOf,
	installsNoOrder,
	situations,
	sketchGen,
	type TakeFeature
} from "#test/unit/derived/take.fixtures.ts"

/**
 * A definition that ends in a take installs its take's order and no order beside it.
 *
 * Budget: 120 runs and 200 steered cases, what its suite stated before it became a property
 * (test/unit/derived/take.test.ts:228 at 8cad5bce, its runs and its coverage's cases).
 */
export const aDefinitionThatEndsInATakeInstallsItsTakesOrderAndNoOrderBesideIt = property.explore(
	sketchGen,
	{
		needs: {},
		budget: { runs: 120, steered: 200 },
		situations: situations satisfies ReadonlyArray<Reached<TakeFeature>>,
		check: (_, k: Case<TakeFeature>) => (s) =>
			Effect.sync(() => {
				k.noteAll(featuresOf(s.world))
				installsNoOrder(s)
			}),
		oracle: {
			kind: "specification",
			name: "a view's rows are a set: no installed SELECT orders rows it does not limit"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/check/checker.ts",
				original:
					'\t\t\treturn order.kind === "none" ? undefined : order.stated\n\t\tcase "membership":\n\t\tcase "member":\n\t\tcase "definition":\n\t\t\treturn undefined',
				replacement:
					'\t\tcase "definition":\n\t\t\treturn order.kind === "none" ? undefined : order.stated\n\t\tcase "membership":\n\t\tcase "member":\n\t\t\treturn undefined\n',
				why: "check/checker.ts rootOrder delivers a definition's rows in its take's order, as a root a caller reads."
			}
		]
	}
)
