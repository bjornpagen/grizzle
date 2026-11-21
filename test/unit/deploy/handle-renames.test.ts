/**
 * A declared rename of a roster's handles moves no code, so it changes no value any column holds and no domain: the
 * roster's domain and its sets' domain each ask only whether a code is live, of the roster's live-codes constant, named
 * by its live codes (physical/ddl/constants.ts rosterConstants), so the rename replaces the names constant alone,
 * which only a view's decoded closed id reads, and re-points, re-adds and validates no domain's CHECK.
 *
 * The oracle is a specification: the draft touches no domain, adds, drops and validates no constraint, and runs no step
 * over stored rows. The space: every injective rename of the three handles onto themselves and a fresh name, over a
 * relation holding a code of the roster and a set of it.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import type { SqlStatement } from "#compiler/sql/ast.ts"
import {
	type RenamingFeature,
	renamedDraft,
	renamingGen,
	renamingNotes
} from "#test/unit/deploy/handle-renames.fixtures.ts"

/** Whether a statement touches a domain or a constraint: a domain created or altered, or a table's constraint added,
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

/** A declared rename of a roster's handles re-points, re-adds and validates no domain's CHECK and reads no stored row. */
export const aDeclaredHandleRenameTouchesNoDomainAndValidatesNothing = property.exhaust(
	finite(renamingGen),
	{
		needs: {},
		situations: ["renamed", "swapped", "renamed to a fresh name"] satisfies ReadonlyArray<
			Reached<RenamingFeature>
		>,
		check: (_, c: Case<RenamingFeature>) => (r) =>
			Effect.sync(() => {
				c.noteAll(renamingNotes(r))
				const drafted = renamedDraft(r)
				assert.deepEqual(
					Arr.filter(drafted.statements, touchesADomainOrAConstraint),
					[],
					`a rename of the handles to ${Arr.join(r.to, ", ")} touches no domain and no constraint`
				)
				assert.deepEqual(drafted.rowSteps, [], "a rename of the handles reads no stored row")
			}),
		oracle: {
			kind: "specification",
			name: "a handle rename touches no domain and no constraint and reads no stored row"
		},
		box: "every injective rename of a roster's three handles onto themselves and a fresh name, over a relation holding a code of it and a set of it",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/physical/ddl/constants.ts",
				original: '\t\tconstantDigest("roster-live", liveHex(codec), everyProperty)',
				replacement: '\t\tconstantDigest("roster-names", codec.names, everyProperty)',
				why: "The live-codes constant named by the roster's names: a handle's rename names it anew, and both domains' CHECKs re-point at it, dropped, added and validated, a scan of every column they type."
			}
		]
	}
)
