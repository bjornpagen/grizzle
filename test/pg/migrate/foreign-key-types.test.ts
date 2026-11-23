/**
 * The migration model's foreign key rule (test/support/migrate/interpret.ts `comparable`) against PostgreSQL.
 *
 * PostgreSQL implements a foreign key by an equality of the operator family of the referenced key's index, and refuses
 * a key whose columns have none (42804, "cannot be implemented"): when the key is added, and when a column on either
 * side changes type, after which it adds the key again at the end of the statement. The model refuses at the same
 * statements, so a drafted migration that converts a column under a foreign key whose sides then do not compare fails
 * in the unit box as it does on PostgreSQL.
 *
 * - **Property:** for every case drawn, the model and PostgreSQL, run over the same statements after the same
 *   setup, reach one verdict: both implement the key, or both refuse it with 42804 at the same statement. The model's
 *   verdict is its typed refusal (InterpretFailure `refusal`), never its words.
 * - **Oracle:** PostgreSQL itself, each case, its setup included, in one owner transaction on the worker's own clone,
 *   rolled back after it (Substrate.rolledBack).
 * - **Space, sampled:** an ordered pair of column types drawn from the types a column can have (each builtin with an
 *   index, two rosters' domains over smallint, as two rosters' closed ids are, and a domain over bigint), and a key from
 *   a column of the first to a key of the second made one of three ways: with the two tables; over the second type with
 *   the referencing column then converted to the first; over the first type with the referenced column then converted
 *   to the second.
 * - **Features:** each way's two verdicts, implemented and refused.
 *
 * A case's tables, columns, constraints and types live in a schema of its own inside its transaction, under names no
 * installation has.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { quoteIdent } from "#compiler/core/text.ts"
import { printStatement } from "#compiler/sql/print.ts"
import {
	keyCaseGen,
	type KeyFeature,
	modelVerdict,
	pgVerdict,
	setup,
	statementsOf,
	ways
} from "#test/pg/migrate/foreign-key-types.fixtures.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"

/** The migration model's foreign key types a key between two column types, created or converted on either side, is refused by PostgreSQL exactly when by the model. */
export const foreignKeyTypes = property.explore(keyCaseGen, {
	needs: { transaction: Substrate.rolledBack(baseSubstrate) },
	situations: Arr.flatMap(ways, (way) => [
		`${way}: implemented` as const,
		`${way}: refused` as const
	]) satisfies ReadonlyArray<Reached<KeyFeature>>,
	check:
		({ transaction }, c: Case<KeyFeature>) =>
		([way, from, to]) =>
			Effect.gen(function* () {
				const { connection, schema: allocate } = yield* transaction
				const schema = yield* allocate("fk_types")
				yield* connection.query(`CREATE SCHEMA ${quoteIdent(schema)}`, [])
				for (const statement of setup(schema)) {
					yield* connection.query(printStatement(statement), [])
				}
				const statements = statementsOf(schema, way, from, to)
				const pg = yield* pgVerdict(connection, statements)
				c.note(`${way}: ${pg.kind}`)
				assert.deepEqual(
					modelVerdict(schema, statements),
					pg,
					`a ${from.name} column referencing a ${to.name} key, ${way}`
				)
			}),
	oracle: {
		kind: "postgresql",
		name: "PostgreSQL implements the key or refuses it with 42804 at the statement the model refuses"
	},
	kept: [],
	kills: [
		{
			file: "packages/engine/src/sql/print.ts",
			original:
				"\t\t\tlisted(out.nested(), [\n\t\t\t\t...statement.columns.map(printColumnDef),\n\t\t\t\t...tableConstraints(statement).map(printConstraint)\n\t\t\t])",
			replacement: "\t\t\t{}",
			why: "Operator mutant (statement) at packages/engine/src/sql/print.ts:1808 in writeCommand: `listed(out.nested(), [\n\t\t\t\t...statement.columns.map(printColumnDef),\n\t\t\t\t...tabl` becomes `{}`; the property fails (lane CATCH, grizzle 0baff5d6)."
		}
	]
})
