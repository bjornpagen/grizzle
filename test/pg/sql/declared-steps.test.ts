/**
 * A table's declared statistics restored as PL/pgSQL steps (sql/print.ts declaredStatisticsSteps) over a session's
 * temporary table on PostgreSQL 19, its schema named by an expression read where the steps run: over drawn declarations
 * of one to three columns, each relative or absolute, 2^0 to 2^6, a SECURITY DEFINER function of the session's
 * temporary schema makes the table and runs the steps, its schema the session's temporary one's name
 * (pg_my_temp_schema()); then pg_stats holds exactly each column's declared number of distinct values.
 *
 * Oracle: PostgreSQL, pg_stats against the declaration.
 */

import type { Reached } from "@bjornpagen/testing/features"
import { property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	type DeclaredStepsFeature,
	declarationsGen,
	runDeclared
} from "#test/pg/sql/declared-steps.fixtures.ts"
import { baseSubstrate, ownerSession, Substrate } from "#test/support/substrate/substrate.ts"

/** A declaration's steps restore every declared number over a session's temporary table, its schema read where they run. */
export const aDeclarationsStepsRestoreEveryDeclaredNumberOverASessionsTemporaryTable =
	property.explore(declarationsGen, {
		needs: { substrate: Substrate.fresh(baseSubstrate) },
		situations: [
			"a relative number restored",
			"an absolute number restored"
		] satisfies ReadonlyArray<Reached<DeclaredStepsFeature>>,
		check:
			({ substrate }, c) =>
			(declarations) =>
				Effect.provideServiceEffect(
					Effect.scoped(
						Effect.gen(function* () {
							const s = yield* Substrate
							const session = yield* s.session({ ...ownerSession(), label: "declared steps" })
							yield* runDeclared(session, declarations, c.note)
						})
					),
					Substrate,
					Effect.map(substrate, (taken) => taken.substrate)
				),
		oracle: {
			kind: "postgresql",
			name: "pg_stats of the session's temporary table against the declaration"
		},
		budget: { runs: 8, steered: 8 },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/sql/print.ts",
				original:
					'\t\t\t\t\t\tqualifiedCall("pg_catalog", "pg_restore_attribute_stats", [\n\t\t\t\t\t\t\ttext("schemaname"),\n\t\t\t\t\t\t\tschema,',
				replacement:
					'\t\t\t\t\t\tqualifiedCall("pg_catalog", "pg_restore_attribute_stats", [\n\t\t\t\t\t\t\ttext("schemaname"),\n\t\t\t\t\t\t\ttext("public"),',
				why: "The restore names the table's schema by a literal of its own, never the expression the caller gives: over a session's temporary table it restores another schema's table, or none, and the steps raise."
			}
		]
	})
