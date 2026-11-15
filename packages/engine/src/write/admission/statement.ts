import { isNonEmpty } from "#compiler/core/nonempty.ts"
import type { CallerParamDecl } from "#compiler/ir/products.ts"
import { admittedTargets, checkedParams } from "#compiler/lower/conservative/admission.ts"
import { provedSelect } from "#compiler/sql/build.ts"
import {
	type AdmissionResult,
	buildStatement,
	ownBuild,
	type WriteContext,
	type WriteStatement
} from "#compiler/write/insert/statement.ts"

/**
 * The admission of a write's caller parameters `params` (lower/conservative/admission.ts), the first statement of its
 * flight, its one row every checked parameter read as its statements read it, so PostgreSQL refuses a value outside
 * its type as it binds this statement, before the statement or any after it runs: ParamRejected at the parameter. A
 * statement after it that fails, one the runtime skips (skipWhenEmpty) and a take bound cast to its base then never
 * meet an unchecked parameter. None where no caller parameter has a check. Its one row carries nothing to decode.
 */
export const buildAdmission = (
	w: WriteContext,
	params: ReadonlyArray<CallerParamDecl>
): WriteStatement<AdmissionResult> | undefined => {
	const checked = checkedParams(w.cx, params)
	if (!isNonEmpty(checked)) {
		return undefined
	}
	return buildStatement(w, ownBuild, (supply) => ({
		ast: provedSelect(
			"oneRow",
			admittedTargets(w.cx, supply, checked, "admission of the write's parameters"),
			[],
			undefined
		),
		role: "main",
		result: { kind: "admission" },
		skipWhenEmpty: undefined
	}))
}
