import { noBareMaterializedViewJoins } from "#lint/rules/no-bare-materialized-view-joins.ts"
import { noDrizzleWriteWithoutWhere } from "#lint/rules/no-drizzle-write-without-where.ts"
import { noImplicitSelectAll } from "#lint/rules/no-implicit-select-all.ts"
import { noModuleState } from "#lint/rules/no-module-state.ts"
import { noSpreadArgument } from "#lint/rules/no-spread-argument.ts"
import { noNullUndefinedUnion } from "#lint/rules/null-undefined-union.ts"
import { sqlAliasedTableReference } from "#lint/rules/sql-aliased-table-reference.ts"
import { sqlArrayParameter } from "#lint/rules/sql-array-parameter.ts"
import { sqlCaseArmCast } from "#lint/rules/sql-case-arm-cast.ts"
import { sqlCastOwner } from "#lint/rules/sql-cast-owner.ts"
import { sqlDistinctWindow } from "#lint/rules/sql-distinct-window.ts"
import { sqlDynamicSchema } from "#lint/rules/sql-dynamic-schema.ts"
import { sqlExecutorContract } from "#lint/rules/sql-executor-contract.ts"
import { sqlJsonOwner } from "#lint/rules/sql-json-owner.ts"
import { sqlLeafOwnersOnly } from "#lint/rules/sql-leaf-owners-only.ts"
import { sqlNumberDecoder } from "#lint/rules/sql-number-decoder.ts"
import { sqlQueryDeadline } from "#lint/rules/sql-query-deadline.ts"
import { sqlRawExecution } from "#lint/rules/sql-raw-execution.ts"
import { sqlRawStatement } from "#lint/rules/sql-raw-statement.ts"
import { uncheckedVocabularyLiteral } from "#lint/rules/unchecked-vocabulary-literal.ts"
import type { Visit } from "#lint/types.ts"

/** The files a rule visits: every owned file, or every owned file but the test files, where the rule guards product
 * code only. */
type Scope = "every file" | "outside tests"

/** The repositories a rule runs in: every one, or those that own an application database (the superlint option
 * appDatabase "owned"); elsewhere an app-database rule never executes. */
type Family = "every repository" | "app database"

/** Every rule superlint runs, by the id it reports under: its name in the output and its fixture directory, with the
 * files it visits and the repositories it runs in. */
export const RULES: ReadonlyArray<
	Readonly<{ id: string; visit: Visit; scope: Scope; family: Family }>
> = [
	{
		id: "no-module-state",
		visit: noModuleState,
		scope: "outside tests",
		family: "every repository"
	},
	{
		id: "no-null-undefined-union",
		visit: noNullUndefinedUnion,
		scope: "every file",
		family: "every repository"
	},
	{
		id: "no-spread-argument",
		visit: noSpreadArgument,
		scope: "every file",
		family: "every repository"
	},
	{
		id: "unchecked-vocabulary-literal",
		visit: uncheckedVocabularyLiteral,
		scope: "every file",
		family: "every repository"
	},
	{
		id: "no-drizzle-write-without-where",
		visit: noDrizzleWriteWithoutWhere,
		scope: "every file",
		family: "app database"
	},
	{
		id: "no-implicit-select-all",
		visit: noImplicitSelectAll,
		scope: "every file",
		family: "app database"
	},
	{
		id: "no-bare-materialized-view-joins",
		visit: noBareMaterializedViewJoins,
		scope: "every file",
		family: "app database"
	},
	{
		id: "sql-aliased-table-reference",
		visit: sqlAliasedTableReference,
		scope: "every file",
		family: "app database"
	},
	{
		id: "sql-array-parameter",
		visit: sqlArrayParameter,
		scope: "every file",
		family: "app database"
	},
	{ id: "sql-case-arm-cast", visit: sqlCaseArmCast, scope: "every file", family: "app database" },
	{ id: "sql-cast-owner", visit: sqlCastOwner, scope: "every file", family: "app database" },
	{
		id: "sql-distinct-window",
		visit: sqlDistinctWindow,
		scope: "every file",
		family: "app database"
	},
	{
		id: "sql-dynamic-schema",
		visit: sqlDynamicSchema,
		scope: "every file",
		family: "app database"
	},
	{
		id: "sql-executor-contract",
		visit: sqlExecutorContract,
		scope: "every file",
		family: "app database"
	},
	{ id: "sql-json-owner", visit: sqlJsonOwner, scope: "every file", family: "app database" },
	{
		id: "sql-leaf-owners-only",
		visit: sqlLeafOwnersOnly,
		scope: "every file",
		family: "app database"
	},
	{
		id: "sql-number-decoder",
		visit: sqlNumberDecoder,
		scope: "every file",
		family: "app database"
	},
	{
		id: "sql-query-deadline",
		visit: sqlQueryDeadline,
		scope: "every file",
		family: "app database"
	},
	{ id: "sql-raw-execution", visit: sqlRawExecution, scope: "every file", family: "app database" },
	{ id: "sql-raw-statement", visit: sqlRawStatement, scope: "every file", family: "app database" }
]
