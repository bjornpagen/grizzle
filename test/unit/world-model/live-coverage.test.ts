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
 * draftSchema, then servedFiles), and each login's file is compiled again over the snapshot.json the draft writes by
 * the test door the worlds executor compiled its reads by (adapter/public/compile.ts compileServed): generate serves
 * every login, and the door compiles each one's own workloads, refused by no UncoveredRead, into the file generate
 * wrote.
 *
 * The oracle is generate's own served file: compileServed with a login's own workloads is the compile generate commits
 * (its JSDoc), so the door's file is generate's, as JSON.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { docsInstalls } from "#test/support/worlds/drive/suite.ts"
import {
	coveredWhereMigrated,
	type Feature
} from "#test/unit/world-model/live-coverage.fixtures.ts"

/** A login's served reads are covered by the live source of an installation migrated with the login's workload. */
export const aLoginsServedReadsAreCoveredByTheLiveSourceOfAnInstallationMigratedWithTheLoginsWorkload =
	property.explore(docsInstalls, {
		needs: {},
		situations: [
			"a footprint table read table-wide",
			"a footprint table routed by a field",
			"a read whose footprint holds two tables",
			"a materialized view a read reads",
			"two logins"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check: (_, c: Case<Feature>) => (value) => coveredWhereMigrated(value, c),
		oracle: {
			kind: "second-implementation",
			name: "generate's served file of the login, against the test door's compile of its own workloads"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/program/workload/compile.ts",
				original: "\t\t\tfor (const [relation, routes] of footprint.tables) {",
				replacement: "\t\t\tfor (const [relation, routes] of [...footprint.tables].slice(0, 1)) {",
				why: "The live plan leaves out every footprint table but the first of each read (program/workload/compile.ts livePlanOf), so a read through a query entry whose filter reads another relation is uncovered; the property fails."
			}
		]
	})
