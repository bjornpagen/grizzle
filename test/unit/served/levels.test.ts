/**
 * A login over any level of an installation compiles as `grizzle generate` compiles it, under the installation's
 * snapshot: every level is served (README "Levels"), and a login over a level below the top reads that level and those
 * below it alone, though the installation's codes hold every level's rosters.
 *
 * Over installations of three levels (levels.fixtures.ts installationOf): a generated public schema, its law level and a
 * top declaring rosters of its own, a login over each level, one role holding every relation of its levels and writing
 * each it may, compiled under the snapshot of the installation (adapter/served/compile.ts snapshotCompiled, then
 * servedEntryOf): each is served, or refused with a ServedRefusal, never a defect.
 *
 * Oracle: the specification, README "Levels": a login's compile over a level of the installation ends in a served file
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
 * A login over any level of a three-level installation is served or refused, never a defect.
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
				"a login over the installation's top",
				"a login's compile served"
			] satisfies ReadonlyArray<Reached<Feature>>,
			check:
				(_, c: Case<Feature>) =>
				([sketch, level, top]) =>
					Effect.gen(function* () {
						const installation = installationOf(c.draw(resolveCase(sketch)), level, top)
						const compiled = yield* compiledOverEachLevel(installation)
						for (const [i, outcome] of compiled.entries()) {
							c.note(
								i === 0
									? "a login over the installation's first level"
									: i === 1
										? "a login over a level below a level that declares a roster"
										: "a login over the installation's top"
							)
							if (outcome.kind === "died") {
								return assert.fail(`a login over level ${i} died compiling:\n${outcome.cause}`)
							}
							c.note(
								outcome.kind === "served" ? "a login's compile served" : "a login's compile refused"
							)
						}
					}),
			oracle: {
				kind: "specification",
				name: 'README "Levels": a login\'s compile over any level of the installation ends in a served file or a refusal'
			},
			kept: [],
			kills: [
				{
					file: "packages/grizzle/src/adapter/served/refusals.ts",
					original: "\t\t\trosters: new Set(Arr.map(rostersOf(artifacts.owned), (r) => r.closed))",
					replacement: "\t\t\trosters: new Set(artifacts.names.codes.rosters.keys())",
					why: "A login's installation refusals range over every roster of the installation's codes, a level above the login's among them, whose domain the login's level cannot name: the compile dies (\"grizzle: internal error\", alphatest-novus's login over its middle level)."
				}
			]
		}
	)
