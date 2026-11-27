/**
 * A whole rule's per-unit step reads every relation its import inlines at the unit (analysis/theory/navigate.ts
 * equatedWith, fixedTerms): an import a rule binds at a variable its conditions equate with another, which the unit's
 * channel fixes, is restricted inside to the unit, where navigation took only the direct equalities and read the import
 * apart from the unit, every package's rows. pantry's catalog statements (scope_duration_read_check_e_1_derived) read
 * every stored test's placed references in each publish so (PUBLISH2): readRows inlines testReadingRows over
 * placedReferences, bound at the placed reference's package, equal to the unit's only through the inlined head.
 *
 * Property: over UnitBound (rule-unit-bound.fixtures.ts), the smallest such shape, a check over Typed judged whole, on
 * PostgreSQL 19: every statement the judge runs of the check, explained with ANALYZE as PL/pgSQL plans it, touches at
 * most its plan's nodes times the rows the transaction wrote, beside forty stored units as large as the written one.
 * The oracle is the bound, rows counted over every loop, never a clock.
 *
 * The box, exhausted: a written document of 64, 128 and 256 nodes, planned with no statistics and analyzed.
 */
import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	runUnit,
	type UnitFeature,
	unitBoundTemplates,
	unitGen
} from "#test/pg/laws/rule-unit-bound.fixtures.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** A whole rule's statement reads its inlined import's every relation at the unit written, with statistics or none. */
export const aWholeRulesStatementReadsAnImportItInlinesAtTheUnitWrittenAlone = property.exhaust(
	finite(unitGen),
	{
		needs: Substrate.oneOf(unitBoundTemplates, Substrate.rolledBack),
		situations: ["planned with no statistics", "planned analyzed"] satisfies ReadonlyArray<
			Reached<UnitFeature>
		>,
		check: (units, c) => (drawn) =>
			Effect.gen(function* () {
				const { connection, value } = yield* units[`${drawn.nodes}`]
				yield* runUnit(value, connection, drawn, c)
			}),
		oracle: {
			kind: "universal",
			name: "bound: every statement the judge runs of the check touches at most its plan's nodes times the rows the transaction wrote, counted over all loops"
		},
		box: "a written document of 64, 128 and 256 nodes beside forty stored, with no statistics and analyzed",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/theory/navigate.ts",
				original: "\tconst fixed = equatedWith(rule.where, isFixed)\n",
				replacement:
					'\tconst fixed = equatedWith(\n\t\trule.where.filter((w) => w.kind !== "compare" || w.left.kind !== "var" || w.right.kind !== "var"),\n\t\tisFixed\n\t)\n',
				why: "fixedTerms takes the direct equalities alone, no chain between variables: Placed, bound at Read's package, equal to the unit's only through Read's head, is read apart from the unit, every stored package's nodes of kinds 1 and 2, and the statement touches past its bound."
			}
		]
	}
)
