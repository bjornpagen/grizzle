/**
 * A case's data step: the one way a case removes or rewrites a closed relation's rows, as a migration's custom data
 * step does, by the runner's own bracket (physical/ddl/immutable.ts dataStepBracket). A closed relation's DELETE,
 * TRUNCATE or UPDATE of a fixed field is refused anywhere else, the owner's included.
 */

import { Array as Arr } from "effect"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import type { LawId } from "#compiler/core/ids.ts"
import { sqlstates } from "#compiler/core/sqlstate.ts"
import { dataStepBracket } from "#compiler/physical/ddl/immutable.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"
import { objectName } from "#compiler/sql/build.ts"
import type { PgErrorFields } from "#test/support/pg.ts"

/**
 * The bracket a migration's runner sends around a custom data step of `installation` (adapter/migrate/apply.ts
 * guardBracket, physical/ddl/immutable.ts dataStepBracket): `before` its statements, every guard of the installation's
 * levels lifted; `after` them, where the installation holds one, its re-check (physical/ddl/recheck.ts), after SET
 * CONSTRAINTS ALL IMMEDIATE, which runs the judge and then makes each stored relation over a closed relation its
 * definition's rows again and checks each rule over one over every row, as the judge, whose premise spares a closed
 * relation's removed rows, reads none of them; then each guard created again. The caller stands up the tables its
 * statements write, and reads, where it reads the state a step leaves, between the two.
 */
export const dataStepOf = (
	installation: Installation
): { readonly before: ReadonlyArray<string>; readonly after: ReadonlyArray<string> } =>
	dataStepBracket(
		Arr.map(installation.names.levels, identifierOf),
		[],
		installation.recheck === undefined
			? []
			: [objectName(installation.names.schema, identifierOf(identity.dataStepRecheck()))]
	)

/**
 * `statements`, one transaction's, as a data step of `installation` (`dataStepOf`): the bracket's `before`, the
 * statements, its `after`, all in the transaction the caller opens and ends, whose judge judges the rest at its COMMIT,
 * as it judges a migration's data step.
 */
export const asDataStep = (
	installation: Installation,
	statements: ReadonlyArray<string>
): ReadonlyArray<string> => {
	const bracket = dataStepOf(installation)
	return [...bracket.before, ...statements, ...bracket.after]
}

/**
 * Whether `fields` are the refusal of a data step that breaks law `law`, a rule over a closed relation, by the
 * re-check its bracket runs (`asDataStep`, physical/ddl/recheck.ts violationCheck): 23000 under the law's own identity,
 * raised inside the bracket, before the transaction's end. The judge, whose premise is that no served write removes a
 * closed relation's rows, captures and reads none of a data step's removals, so the re-check is the one that refuses.
 */
export const refusedByRecheck = (fields: PgErrorFields, law: LawId): boolean =>
	fields.code === sqlstates.integrityConstraintViolation && fields.constraint === law
