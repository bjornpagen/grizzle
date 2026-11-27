/**
 * The one hand change to an installation's triggers a test makes: an operator's `ALTER TABLE … DISABLE TRIGGER`, which
 * PostgreSQL lets a table's owner run in production and which grizzle's drift check reports (pg_trigger tgenabled), so
 * a drift test reaches that state as an operator does. The one module whose SQL text names DISABLE TRIGGER: the
 * toolchain's lint (testing/no-trigger-switch) refuses it, and session_replication_role, the same switch, in every
 * other test source, so no fixture lifts a guard or a capture by them, and a state no production path reaches stays
 * unwritable.
 */

import { quoteIdent } from "#compiler/core/text.ts"
import type { ObjectName } from "#compiler/sql/ast.ts"

/** The statement disabling the trigger `trigger` of `table`, as an operator types it, each name quoted. */
export const triggerDisabled = (table: ObjectName, trigger: string): string =>
	`ALTER TABLE ${quoteIdent(table.schema)}.${quoteIdent(table.name)} DISABLE TRIGGER ${quoteIdent(trigger)}`
