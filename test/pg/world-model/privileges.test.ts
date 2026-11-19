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
	situations
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
	requiredWhere
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
	kept: []
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
	kept: []
})
