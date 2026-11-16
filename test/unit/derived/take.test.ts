/**
 * A definition is a relation: a derived relation's or a role's query entry's that ends in `.orderBy(...).take(k)`
 * installs its take's ORDER BY and LIMIT and no order beside them, since a view's rows are a set to everything that
 * reads it, though a query that ends in the same take delivers its rows in the take's order.
 *
 * Property: over a drawn base relation R (one to three fields of integer, bigint and uuid, its primary key a drawn
 * prefix of them) and two drawn definitions over it, a derived relation's and a role's query entry's, each one rule,
 * a union of two or a count grouped by its head, ordered by drawn head columns and taking a drawn k: no SELECT of
 * any installed materialized view or role view orders rows it does not limit, and the derived relation's
 * materialized view and some role view each hold a limited SELECT, the take.
 *
 * Oracle: the specification that a view's rows are a set, read off the installed statements' typed SQL (an ORDER BY
 * with no LIMIT is a delivered order), never their text.
 *
 * Features: each owner (a derived relation, a world entry) taking from each form (one rule, a union, a count), a
 * take of one row, of two rows or more, and a descending key.
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

/** A definition that ends in a take installs its take's order and no order beside it. */
export const aDefinitionThatEndsInATakeInstallsItsTakesOrderAndNoOrderBesideIt = property.explore(
	sketchGen,
	{
		needs: {},
		situations: situations satisfies ReadonlyArray<Reached<TakeFeature>>,
		check: (_, k: Case<TakeFeature>) => (s) =>
			Effect.sync(() => {
				k.noteAll([
					...featuresOf("a derived relation", s.derived),
					...featuresOf("a world entry", s.world)
				])
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
