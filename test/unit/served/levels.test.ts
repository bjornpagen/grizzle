/**
 * A login over any level of an installation compiles as `grizzle generate` compiles it, under the installation's
 * snapshot: every level is served (docs/schema.md "Levels"), and a login over a level below the top reads that level and those
 * below it alone, though the installation's codes hold every level's rosters, whatever the levels between install.
 *
 * Over installations of four levels (levels.fixtures.ts installationOf): a generated public schema, its law level, a
 * level of derived relations alone that installs no table, and a top declaring rosters of its own, a login over each
 * level, one role holding every relation of its levels and writing each it may, compiled under the snapshot of the
 * installation (adapter/served/compile.ts snapshotCompiled, then servedEntryOf): each is served, or refused with a
 * ServedRefusal, never a defect.
 *
 * Oracle: the specification, docs/schema.md "Levels": a login's compile over a level of the installation ends in a served file
 * or a refusal.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { caseSketchGen, resolveCase } from "#test/support/oracle/public/generate.ts"
import { lawLevelGen } from "#test/support/oracle/public/laws.ts"
import {
	compiledOverEachLevel,
	type Feature,
	installationOf,
	topGen
} from "#test/unit/served/levels.fixtures.ts"

/**
 * A login over any level of a four-level installation is served or refused, never a defect.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const aLoginOverAnyLevelOfAnInstallationCompilesUnderItsSnapshotServedOrRefusedNeverADefect =
	property.explore(
		(source) =>
			[source.draw(caseSketchGen), source.draw(lawLevelGen), source.draw(topGen)] as const,
		{
			needs: {},
			situations: [
				"a login over the installation's first level",
				"a login over a level below a level that declares a roster",
				"a login over a level of derived relations alone, below a level that declares a roster",
				"a login over the installation's top",
				"a login's compile served"
			] satisfies ReadonlyArray<Reached<Feature>>,
			check:
				(_, c: Case<Feature>) =>
				([sketch, level, top]) =>
					Effect.gen(function* () {
						const installation = installationOf(c.draw(resolveCase(sketch)), level, top)
						for (const { at, compiled } of yield* compiledOverEachLevel(installation)) {
							c.note(at)
							if (compiled.kind === "died") {
								return assert.fail(`${at} died compiling:\n${compiled.cause}`)
							}
							c.note(
								compiled.kind === "served"
									? "a login's compile served"
									: "a login's compile refused"
							)
						}
					}),
			oracle: {
				kind: "specification",
				name: 'docs/schema.md "Levels": a login\'s compile over any level of the installation ends in a served file or a refusal'
			},
			kept: [],
			kills: [
				{
					file: "packages/engine/src/physical/ddl/names.ts",
					original: "\tconst codes = levelCodes(input.codes, owned)",
					replacement: "\tconst codes = input.codes",
					why: "A level's names hold the installation's codes whole, a level above the login's rosters among them, whose domains the login's level cannot name, and its installation refusals range over them: the compile dies (\"grizzle: internal error\", metis's login over OnerosterSync, below Auth's rosters and its reconciliation's level of derived relations)."
				}
			]
		}
	)
