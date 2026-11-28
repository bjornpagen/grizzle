/**
 * Every read a login serves is covered by the live source of an installation migrated with that login's workload: only a
 * snapshot of an installation migrated without the login's workload holds an uncovered read (served/forms.ts
 * UncoveredRead), since generate builds the installation's publication from the same workload.
 *
 * Over the worlds suites' installations of the documents bases (drive/suite.ts docsInstalls: the README-shaped ones,
 * and generated ones, half of those named from the kernel dictionary or after PostgreSQL's types), built through the
 * public builders (execute/build.ts buildInstall), each login is given a workload holding, for every relation each of
 * its roles holds, the read the worlds executor serves of it (execute/session.ts readProgramOf) and, where the case
 * draws it, that read with one of its fields fixed to a parameter, so the read routes the relation's table by that
 * field. Each installation is drafted as `grizzle generate` drafts it with those workloads (cli/generate.ts
 * draftSchema, then eachServedFile), and each login's file is compiled again over the snapshot.json the draft writes by
 * the test door the worlds executor compiled its reads by (adapter/public/compile.ts compileServed): generate serves
 * every login, and the door compiles each one's own workloads, refused by no UncoveredRead, into the file generate
 * wrote.
 *
 * The oracle is generate's own served file: compileServed with a login's own workloads is the compile generate commits
 * (its JSDoc), so the door's file is generate's, as JSON.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { docsInstalls } from "#test/support/worlds/drive/suite.ts"
import {
	coveredWhereMigrated,
	type Feature
} from "#test/unit/world-model/live-coverage.fixtures.ts"

/**
 * A login's served reads are covered by the live source of an installation migrated with the login's workload.
 *
 * Budget: its suite's count before the conversion (unit/world-model/live-coverage: 16 independent cases and 0 steered,
 * Vitest at grizzle 4ca3036a). Its four fixed witnesses read through no query entry whose filter reads another
 * relation, so that case is kept (its kept token, found by the kill's mutant at the runner's budget and shrunk): at
 * TEST_SEED=1 to 5 every kill is killed.
 */
export const aLoginsServedReadsAreCoveredByTheLiveSourceOfAnInstallationMigratedWithTheLoginsWorkload =
	property.explore(docsInstalls, {
		needs: {},
		situations: [
			"a footprint table read table-wide",
			"a footprint table routed by a field",
			"a read whose footprint holds two tables",
			"two logins"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check: (_, c: Case<Feature>) => (value) => coveredWhereMigrated(value, c),
		oracle: {
			kind: "second-implementation",
			name: "generate's served file of the login, against the test door's compile of its own workloads"
		},
		budget: { runs: 16, steered: 0 },
		kept: [
			{
				token: ReplayToken(
					"test/unit/world-model/live-coverage.test.ts#aLoginsServedReadsAreCoveredByTheLiveSourceOfAnInstallationMigratedWithTheLoginsWorkload:-:0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0"
				),
				reason:
					"a read through a query entry whose filter reads another relation, so the live plan must hold every footprint table of the read",
				since: "2026-11-16"
			}
		],
		kills: [
			{
				file: "packages/engine/src/program/workload/compile.ts",
				original: "\t\t\tfor (const [relation, routes] of footprint.tables) {",
				replacement: "\t\t\tfor (const [relation, routes] of [...footprint.tables].slice(0, 1)) {",
				why: "The live plan leaves out every footprint table but the first of each read (program/workload/compile.ts livePlanOf), so a read through a query entry whose filter reads another relation is uncovered; the property fails."
			}
		]
	})
