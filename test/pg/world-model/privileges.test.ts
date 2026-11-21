import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	catalogFeature,
	directFeature,
	directInstalls,
	type Feature,
	installs,
	privilegeCase,
	readmeSqlstate,
	situations,
	tamperMigratedRequired
} from "#test/pg/world-model/privileges.fixtures.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import {
	breakingAtCommit,
	directTransaction,
	docsTenantRealities,
	drawnRealities,
	leadsOf,
	noLead,
	programProperty,
	requiredWhere,
	tamperThenMigrate
} from "#test/support/worlds/drive/suite.ts"

/**
 * Least privilege, the worlds' privileges from above: every role's installed privileges are exactly the expected
 * privileges. Each case realizes its installation in a database of its own (Substrate.fresh), as the Vitest file ran in
 * a database of its own.
 *
 * Its pre-conversion budget: runs 8, coverage cases 8 (test/pg/world-model/privileges.test.ts at c568eb123).
 */
export const everyRolesInstalledPrivilegesAreExactlyTheExpectedPrivileges = property.explore(
	installs,
	{
		needs: { own: Substrate.fresh },
		situations,
		check:
			({ own }, c: Case<Feature>) =>
			(install) =>
				Effect.provideServiceEffect(privilegeCase(install, c), Substrate, own),
		oracle: {
			kind: "specification",
			name: 'README "Security model" derived from the InstallSpec (worlds/privileges.ts expectedPrivileges) against PostgreSQL\'s own judgment of every privilege, and 42501 for an operation one it lacks governs'
		},
		budget: { runs: 8, steered: 8 },
		kept: [],
		kills: []
	}
)

/** Least privilege: the drift check reports every catalog fault it names and passes the rest, and every Db opens. */
export const privilegesCatalogCheck = programProperty({
	installs,
	focus: ["tamper", "open-db", "drift"],
	steps: 10,
	cases: 100,
	required: requiredWhere(catalogFeature),
	realities: drawnRealities,
	lead: noLead,
	check: () => undefined,
	kept: [],
	kills: []
})

/**
 * Least privilege: a migrate over a tampered catalog either rewrites what was tampered with, ends refusing the drift it
 * leaves, or, where its folder drops or creates again an object the tamper removed, or drops a role the tamper granted a
 * privilege to, stops at that statement with its file rolled back and a report saying the installation may have
 * drifted, for each perturbation kind of the catalog
 * (README "Migrations": the run ends with the drift check): never an `ok` over a catalog that still departs from the
 * contract, a PUBLIC grant or an extra grant among them.
 */
export const privilegesTamperMigrated = programProperty({
	installs,
	focus: ["tamper", "migrate", "open-db", "drift"],
	steps: 4,
	cases: 64,
	required: tamperMigratedRequired,
	realities: drawnRealities,
	lead: tamperThenMigrate(tamperMigratedRequired),
	check: () => undefined,
	kept: [],
	kills: [
		{
			file: "packages/grizzle/src/adapter/migrate/errors.ts",
			original:
				'\t\treturn this.failure._tag === "ServerError" && catalogDeparted.has(this.failure.sqlstate)\n',
			replacement:
				'\t\treturn this.failure._tag === "ServerError" && catalogDeparted.has(sqlstates.internalError)\n',
			why: "A migration statement over an object the catalog lacks is reported as any failed statement, its fix to edit the file, never that the installation may have drifted, so the operator of a migrate whose folder drops a policy dropped by hand (42704) is never pointed at grizzle drift."
		}
	]
})

/** Least privilege: a direct writer meets the world and the laws as the README's SQLSTATEs. */
export const privilegesDirect = programProperty({
	installs: directInstalls,
	focus: ["direct-begin", "direct", "direct-end"],
	steps: 12,
	cases: 32,
	required: requiredWhere(directFeature),
	realities: docsTenantRealities,
	lead: leadsOf(
		directTransaction(requiredWhere(directFeature)),
		breakingAtCommit(requiredWhere(directFeature))
	),
	check: readmeSqlstate,
	kept: [],
	kills: []
})
