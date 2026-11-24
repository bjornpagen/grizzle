/**
 * A containment whose source joins two unions, one read at the keys the other binds, is judged as its violation query
 * reads it, and the rule's check over every row runs: on PostgreSQL 19, pantry's "E1 derived" shape reduced
 * (placed-keys.fixtures.ts), each spelled attribute under each placement of its document, every placed attribute a
 * placed row. The check reads the placements at the keys the spelled attributes bind, each arm's steps at them inside
 * their fences (lower/shapes/share/keyed.ts pushedInto), and an item's own placements at the keys the templates it
 * locates bind, a key set whose CTE, at the statement's WITH, reads the templates' navigation over the reference
 * relation: a restriction is scoped by the environment it is made in (lower/conservative/context.ts Env), so the key
 * set's CTE, lowered in the statement's scope, reads no key of the placements' row, which its WITH does not see.
 * metis's and edullm's installations of pantry failed to migrate there (42P01, a missing FROM-clause entry), the CTE of
 * the templates' key set reading the placements' key inside the reference relation's step.
 *
 * Each case writes a drawn state of two packages in one transaction rolled back after, then runs the judge (SET
 * CONSTRAINTS ALL IMMEDIATE).
 *
 * Oracle: the containment's violation query lowered by the oracle baseline (deploy/snapshot/violation.ts
 * baselineRuleChecks) over the state: the rule's check over every row finds a row exactly when it does, and the judge
 * refuses exactly then, under an integrity SQLSTATE.
 *
 * Features: refused and accepted.
 */
import type { Reached } from "@bjornpagen/testing/features"
import { property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	type PlacedFeature,
	placedCaseGen,
	placedKeysTemplate,
	runPlaced
} from "#test/pg/laws/placed-keys.fixtures.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * A containment whose source joins a union read at keys and a union of navigated steps is judged exactly as its
 * violation query finds the state, its check over every row reading each key where its row is in scope.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const aContainmentOverAUnionReadAtKeysIsJudgedAsItsViolationQueryFindsTheStateEachKeyReadWhereItsRowIsInScope =
	property.explore(placedCaseGen, {
		needs: { placed: Substrate.rolledBack(placedKeysTemplate) },
		situations: ["refused by the judge", "accepted by the judge"] satisfies ReadonlyArray<
			Reached<PlacedFeature>
		>,
		check:
			({ placed }, c) =>
			(drawn) =>
				Effect.flatMap(placed, ({ connection, value }) => runPlaced(value, connection, drawn, c)),
		oracle: {
			kind: "second-implementation",
			name: "the containment's violation query lowered by the oracle baseline: the check over every row finds a row and the judge refuses exactly when it finds one"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/conservative/context.ts",
				original:
					"\t\t: { columns: env.columns, restricted: new Map([...env.restricted, ...restricted]) }\n",
				replacement:
					"\t\t: (restricted.forEach((value, node) => emptyEnv.restricted.set(node, value)), env)\n",
				why: "A restriction is pushed regardless of scope, into the statement's own: the CTE of the templates' key set, lowered at the statement's WITH, reads the placements' key inside the reference relation's step, which no FROM item there holds, and the installation's migration fails with 42P01."
			}
		]
	})
