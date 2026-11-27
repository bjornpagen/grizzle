/**
 * A containment whose source joins two unions, one read at the keys the other binds, is judged as its violation query
 * reads it, and the rule's check over every row runs: on PostgreSQL 19, pantry's "E1 derived" shape reduced
 * (placed-keys.fixtures.ts), each spelled attribute under each placement of its document, and each located template
 * under its locator, every placed attribute a placed row. Where every import is computed, the check reads the
 * placements at the keys the spelled attributes bind, each arm's steps at them inside their fences
 * (lower/shapes/share/keyed.ts pushedInto), and an item's own placements at the keys the templates it locates bind, a
 * key set whose CTE, at the statement's WITH, reads the templates' navigation over the reference relation; and the
 * located templates whole, beside. A restriction is scoped by the environment it is made in
 * (lower/conservative/context.ts Env), so neither the key set's CTE nor the whole read of the located templates, each
 * lowered in the statement's scope, reads a key of the placements' row, which their scope does not see. metis's and
 * edullm's installations of pantry failed to migrate there (42P01, a missing FROM-clause entry), the CTE of the
 * templates' key set reading the placements' key inside the reference relation's step; a restriction read past its
 * scope is now the printer's refusal (sql/scope.ts), which the whole read meets wherever the key set's CTE does not.
 *
 * The content sits in its unit, Package, or in none. In its unit, every closed import of Typed's definition whose
 * upkeep a write bounds is a stored canonical relation, its table read in its place (the spelled attributes, the
 * standalone documents, an item's own placements), which the judge's upkeep makes current; in none, every import is
 * computed where it is read, the shape pantry's installations failed on.
 *
 * Each case writes a drawn state of two packages, over the drawn schema, in one transaction rolled back after, then
 * runs the judge (SET CONSTRAINTS ALL IMMEDIATE).
 *
 * Oracle: the containment's violation query lowered by the oracle baseline over the state, every derived relation it
 * reads read through its definition (deploy/snapshot/violation.ts definedRuleChecks): the judge refuses exactly when it
 * finds a row, under an integrity SQLSTATE; and the rule's check over every row finds a row exactly when the violation
 * query as installed (baselineRuleChecks) does, each reading a stored relation's table, the canonical relation of a
 * closed import of Typed's definition among them, as the last COMMIT left it.
 *
 * Features: refused and accepted; the content in its unit and in none.
 */
import type { Reached } from "@bjornpagen/testing/features"
import { property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	type PlacedFeature,
	placedCaseGen,
	placedKeysTemplates,
	runPlaced
} from "#test/pg/laws/placed-keys.fixtures.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * A containment whose source joins a union read at keys and a union of navigated steps, and reads those steps whole
 * beside, is judged exactly as its violation query finds the state, its check over every row reading each key where
 * its row is in scope.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const aContainmentOverAUnionReadAtKeysIsJudgedAsItsViolationQueryFindsTheStateEachKeyReadWhereItsRowIsInScope =
	property.explore(placedCaseGen, {
		needs: {
			unit: Substrate.rolledBack(placedKeysTemplates["in its unit"]),
			loose: Substrate.rolledBack(placedKeysTemplates["in no unit"])
		},
		situations: [
			"refused by the judge",
			"accepted by the judge",
			"in its unit",
			"in no unit"
		] satisfies ReadonlyArray<Reached<PlacedFeature>>,
		check:
			({ unit, loose }, c) =>
			(drawn) =>
				Effect.flatMap(drawn.content === "in its unit" ? unit : loose, ({ connection, value }) =>
					runPlaced(value, connection, drawn, c)
				),
		oracle: {
			kind: "second-implementation",
			name: "the containment's violation query lowered by the oracle baseline: the judge refuses exactly when it finds a row reading every derived relation through its definition, and the check over every row finds one exactly when it does reading the tables as installed"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/schema.ts",
				original: "\t\t\t\tdefinitions.set(subject.name, definition)\n",
				replacement: "",
				why: "An anonymous canonical relation keeps no definition by its name: the spelled attributes' union, stored, stands in the rule's violation query as its table, and the verdict through every definition finds none for it, an internal compiler error."
			}
		]
	})
