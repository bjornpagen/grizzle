/**
 * The worked examples, migrated version by version through the real apply runner, on PostgreSQL 19.
 *
 * The fixtures are a dictionary of realistic schemas, each a family of levels: Work and its Reports extension, Payroll
 * and its Reporting, and every other example (Plans, the queue, the ledger, the graph, vector search, spans and
 * calendars) a family of one level. A history is drawn as a walk over one family's levels, two to four versions, each
 * at any level, so it adds an extension's derived relation and its worlds, drops them, and drafts a version again after
 * itself, which changes nothing. Each history is drafted from the empty
 * snapshot on, as `grizzle generate` drafts it, and applied as `grizzle migrate` applies it: the real runner on the
 * migration identity's own connection path (verify-full TLS), every folder up to the step with that step's snapshot.
 * Every fixture is installed under the allocated name, every level of it renamed, so the declared name is the
 * installed one. Properties, for every history:
 *
 * - every apply is admitted by the runner's post-apply drift check and by the installed-catalog checker against the
 *   version's installation (`checkedAdmission`);
 * - a version drafted again after itself changes nothing;
 * - three installations of the last version agree, the ledger aside: the history the runner migrated, the
 *   fresh-install script, and the test installer every other pg suite installs through,
 *   their catalogs, function bodies, trigger events and view queries included; the installer's statement certificate
 *   (runsInstallScript) holds, so its later installations of a process may skip the full comparison;
 * - the ledger records every folder complete with each of its files once, its latest target the last snapshot and no
 *   folder partial, and applying the directory again runs nothing;
 * - Db.open of every role of the last version's logins, over the schema rebuilt under the installed name, admits the
 *   database.
 *
 * A version carries the logins its fixture's worlds declare, so the histories add, drop
 * and keep logins and roles as they move between levels, each login a step drops declared (`--drop @<login>`), and every
 * apply's checker judges the worlds' posture: the
 * grants, the memberships, and each login's defaults, the search policy's among them (Search reads vectors). The
 * fixtures' roles hold their relations whole, so no table has row security; the worlds suite migrates worlds whose
 * written query entries have policies.
 *
 * Oracle: the fresh-install script and the test installer, against the history the runner migrated, each judged by
 * PostgreSQL's catalog; the runner's drift check and the installed-catalog checker; and Db.open.
 *
 * Features: every fixture family, an extension added, an extension dropped, and a version drafted again, each pending
 * one aimed at by drawing from the families that reach it.
 */

import type { Reached } from "@bjornpagen/testing/features"
import { steered } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import {
	families,
	featuresOf,
	type FixtureFeature,
	historySteered,
	migrates
} from "#test/pg/migrate/fixtures.fixtures.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"

/** The worked examples migrate version by version every history: every apply admitted and checked, the history the fresh install and the installer agree, the ledger complete and Db.open admits every role. */
export const workedExamples = property.explore(steered(historySteered), {
	needs: { substrate: Substrate.fresh(baseSubstrate) },
	situations: [
		...Arr.map(families, (f) => f.label),
		"an extension added",
		"an extension dropped",
		"a version drafted again"
	] satisfies ReadonlyArray<Reached<FixtureFeature>>,
	/** Its pre-conversion budget: runs 2, coverage cases 16 (fixtures.test.ts at bf4f43bb). */
	budget: { runs: 2, steered: 16 },
	check:
		({ substrate }, c: Case<FixtureFeature>) =>
		(history) =>
			Effect.provideServiceEffect(
				Effect.suspend(() => {
					c.noteAll(featuresOf(history))
					return migrates(history)
				}),
				Substrate,
				Effect.map(substrate, (taken) => taken.substrate)
			),
	oracle: {
		kind: "second-implementation",
		name: "the fresh-install script and the test installer, against the history the runner migrated"
	},
	kept: [],
	kills: [
		{
			file: "packages/engine/src/deploy/render/generate.ts",
			original:
				'\t\t\tplan.steps.length > 0 || snapshot.fingerprint !== previous.fingerprint ? "schema" : "none"',
			replacement: '\t\t\tplan.steps.length > 0 || snapshot !== previous ? "schema" : "none"',
			why: "A version drafted again after itself reports a schema change: generate compares the finished snapshot with the previous one as objects, never by content."
		},
		{
			file: "packages/engine/src/physical/ddl/context.ts",
			original: "\t\t\tappendAll(pending, node.ddl)\n",
			replacement:
				'\t\t\tif (object.kind === "domain") {\n\t\t\t\tappendAll(pending, node.ddl)\n\t\t\t}\n',
			why: "A role is granted EXECUTE on the constants its statements call and no constant a constant's body calls, so Reporting's clerk, which writes LevyLine, is refused the LevyRate constant its CHECK's row function calls as it runs (42501): the installed-catalog checker, which reads a table's CHECKs through their row functions' bodies, names it missing."
		}
	]
})
