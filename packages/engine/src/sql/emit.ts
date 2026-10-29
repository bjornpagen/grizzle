import { nominal } from "#compiler/core/brand.ts"
import type { BudgetMeter } from "#compiler/core/budget.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import type { SourceLoc } from "#compiler/core/loc.ts"
import * as Result from "#compiler/core/result.ts"
import type { EmittedSql, EmittedText, SqlStatement } from "#compiler/sql/ast.ts"
import type { NameMap } from "#compiler/sql/naming.ts"
import { printStatement } from "#compiler/sql/print.ts"

const emitted = nominal<string, EmittedText>()

/**
 * How an emitted text is charged: against a compilation's meter, an overrun reported at `loc`, or not at all (see the
 * header).
 */
type EmitCharge =
	| { readonly kind: "metered"; readonly meter: BudgetMeter; readonly loc: SourceLoc }
	| { readonly kind: "unmetered" }

/**
 * Emission: print, and charge.
 *
 * Every statement a lowering produces leaves the compiler through here: the printer renders its AST (print.ts), and a
 * compilation's statement is charged against the policy's sqlBytes budget; DDL, the installer's and migrator's catalog
 * statements and the runtime's rebuild of a template its compilation already charged are not. The emission discipline
 * the AST's constructors keep (no NULL-yielding form, every parameter cast, generated names) is checked by the test
 * kernel's structural audit over every statement the suites emit (test/support/oracle/verify/sql.ts), never here.
 */
export const unmetered: EmitCharge = { kind: "unmetered" }

export const metered = (meter: BudgetMeter, loc: SourceLoc): EmitCharge => ({
	kind: "metered",
	meter,
	loc
})

/** The text of `statement` and its generated-name map, charged to no meter: a statement whose text is charged where it
 * is final, as a write program charges each statement it sends once (write/program/compile.ts). */
export const emitText = (statement: SqlStatement, nameMap: NameMap): EmittedSql => ({
	text: emitted(printStatement(statement)),
	nameMap
})

/** `nameMap` is the statement's generated-name map, from its NameSupply (naming.ts emptyNameMap when it has none). */
export const emit = (
	statement: SqlStatement,
	nameMap: NameMap,
	charge: EmitCharge
): Result.Result<EmittedSql, CompileError> => {
	const sql = emitText(statement, nameMap)
	if (charge.kind === "metered") {
		const charged = charge.meter.chargeSql(sql.text, charge.loc)
		if (!charged.ok) {
			return charged
		}
	}
	return Result.ok(sql)
}
