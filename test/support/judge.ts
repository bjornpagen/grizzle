/** The rule judge's PL/pgSQL, as an installation creates it (physical/ddl/rules.ts addRules). */

import { Array as Arr, String as Str } from "effect"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"
import type { PlStatement } from "#compiler/sql/ast.ts"

/**
 * The bodies of the judge and of each of its parts, each a function of its own: the judge runs a part where the session
 * holds one of its deltas, and every statement that tests a rule stands in a part. A part is named by its identity's
 * stem, the judge's own followed by its first delta's relation (core/identity.ts ruleJudgePart).
 */
export const judgeBodiesOf = (installation: Installation): ReadonlyArray<PlStatement> => {
	const judge = identifierOf(identity.ruleJudge())
	return Arr.flatMap(installation.statements, (s) =>
		s.kind === "createFunction" &&
		s.language === "plpgsql" &&
		(s.name.name === judge || Str.startsWith(`${judge}_`)(s.name.name))
			? s.body.body
			: []
	)
}
