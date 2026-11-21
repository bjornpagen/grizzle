/**
 * A declared rename of a roster moves no code, so it changes no value any column holds and nothing any constant or row
 * function computes: each constant and row function the previous installation holds that the target holds under the
 * roster's new name is the same function, which the draft renames in place, `ALTER FUNCTION … RENAME TO`, keeping its
 * OID, and writes again in place where its text names the roster's renamed domain (deploy/diff/declared.ts
 * pairedConstants), and renames the roster's bits domain with its domain (renamedSnapshot). So a CHECK that calls a row
 * function over the roster's domain stands, neither added again nor validated, and so does every domain's CHECK, and no
 * set column is converted. A rename that also changes what a function computes (a closed relation's
 * rows it reads) changes that function, which takes the route a changed function always takes: the CHECK that calls it
 * is added again over the new function and validated.
 *
 * The oracle is a specification: with Weight's rows as they were, the draft adds, drops and validates no constraint,
 * alters no domain, and runs no step over stored rows; with them changed, it adds the CHECK Heavy again and validates
 * it. The space: the roster kept or renamed, its handles kept or injectively renamed onto themselves and a fresh name,
 * and Weight's weights kept or reversed, over a relation holding a code of the roster, a set of it and a number its
 * CHECK holds to its code's weight.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter } from "effect"
import type { SqlStatement } from "#compiler/sql/ast.ts"
import {
	type RenamingFeature,
	renamedDraft,
	renamingGen,
	renamingNotes
} from "#test/unit/deploy/roster-renames.fixtures.ts"

/** Whether a statement touches a domain or a constraint: a domain created or altered, a table's constraint added,
 * dropped or validated, or a column's type converted. */
const touchesADomainOrAConstraint = (st: SqlStatement): boolean =>
	st.kind === "createDomain" ||
	st.kind === "alterDomain" ||
	(st.kind === "alterTable" &&
		Arr.some(
			st.actions,
			(a) =>
				a.kind === "addConstraint" ||
				a.kind === "dropConstraint" ||
				a.kind === "validateConstraint" ||
				a.kind === "alterColumnType"
		))

/** Whether a statement adds a CHECK to a table again, or validates one. */
const addsOrValidatesACheck = (
	st: SqlStatement,
	action: "addConstraint" | "validateConstraint"
): boolean =>
	st.kind === "alterTable" &&
	Arr.some(st.actions, (a) =>
		action === "addConstraint"
			? a.kind === "addConstraint" && a.constraint.kind === "check"
			: a.kind === "validateConstraint"
	)

/** A declared rename of a roster keeps every function it only renames, so no CHECK over the roster is built again;
 * one whose function computes otherwise is built again and validated. */
export const aDeclaredRosterRenameKeepsEveryFunctionItOnlyRenamesAndRebuildsOnlyWhatComputesOtherwise =
	property.exhaust(finite(renamingGen), {
		needs: {},
		situations: ["roster renamed", "handles renamed", "weights changed"] satisfies ReadonlyArray<
			Reached<RenamingFeature>
		>,
		check: (_, c: Case<RenamingFeature>) => (r) =>
			Effect.sync(() => {
				c.noteAll(renamingNotes(r))
				const drafted = renamedDraft(r)
				if (r.weighed === "by code") {
					assert.deepEqual(
						Arr.filter(drafted.statements, touchesADomainOrAConstraint),
						[],
						`a rename that keeps Weight's rows touches no domain and no constraint: ${Formatter.format(r)}`
					)
					assert.deepEqual(
						drafted.rowSteps,
						[],
						"a rename that keeps Weight's rows reads no stored row"
					)
				} else {
					assert.ok(
						Arr.some(drafted.statements, (st) => addsOrValidatesACheck(st, "addConstraint")) &&
							Arr.some(drafted.statements, (st) => addsOrValidatesACheck(st, "validateConstraint")),
						`a change of Weight's rows adds the CHECK over them again and validates it: ${Formatter.format(r)}`
					)
				}
			}),
		oracle: {
			kind: "specification",
			name: "a roster rename keeps every function it only renames; a changed function's CHECK is built again and validated"
		},
		box: "the roster kept or renamed, its three handles kept or injectively renamed onto themselves and a fresh name, and a closed relation's weights kept or reversed, over a relation holding a code of the roster, a set of it and a number its CHECK holds to its code's weight",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/deploy/diff/declared.ts",
				original: "\t\t\tfound.set(create.name.name, prior)\n",
				replacement: "",
				why: "A row function a roster rename only renames is not found: it is created anew under the target's name, and the CHECK that calls it is added again NOT VALID and validated, a scan of its table."
			},
			{
				file: "packages/engine/src/deploy/diff/declared.ts",
				original: "\t\t\t\tfound.set(target, prior)\n",
				replacement: "",
				why: "A roster constant a roster rename only renames is not found: it is created anew under the target's name, and each domain whose CHECK reads it re-points at it, dropped, added and validated."
			},
			{
				file: "packages/engine/src/deploy/diff/declared.ts",
				original: "\t\tconst prior = heldRows.find((h) => h === restated && !renamedFrom(h))",
				replacement: "\t\tconst prior = heldRows.find((h) => !renamedFrom(h))",
				why: "A row function paired whatever its restated content: one that reads a closed relation's changed rows is taken for the previous one and its body replaced in place, and the CHECK that calls it stands unvalidated over rows its new function may refuse."
			},
			{
				file: "packages/engine/src/deploy/diff/declared.ts",
				original: "\t\t\treturn holder === undefined ||",
				replacement: "\t\t\treturn true ||",
				why: "A renamed roster's bits domain left under its old name: the target's is created anew and every set column converted to it, its CHECK checked over every row."
			}
		]
	})
