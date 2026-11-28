import { ReplayToken } from "@bjornpagen/testing/property"
import { installs, tamperMigratedRequired } from "#test/pg/world-model/privileges.fixtures.ts"
import {
	drawnRealities,
	programProperty,
	tamperThenMigrate
} from "#test/support/worlds/drive/suite.ts"

/**
 * Least privilege: a migrate over a tampered catalog either rewrites what was tampered with, ends refusing the drift it
 * leaves, or, where its folder drops or creates again an object the tamper removed, or drops a role the tamper granted a
 * privilege to, stops at that statement with its file rolled back and a report saying the installation may have
 * drifted, for each perturbation kind of the catalog
 * (docs/operations.md "Migrations": the run ends with the drift check): never an `ok` over a catalog that still departs from the
 * contract, a PUBLIC grant or an extra grant among them.
 */
export const privilegesTamperMigrated = programProperty({
	installs,
	focus: ["tamper", "migrate", "open-db", "drift"],
	steps: 4,
	required: tamperMigratedRequired,
	realities: drawnRealities,
	lead: tamperThenMigrate(tamperMigratedRequired),
	check: () => undefined,
	kept: [
		{
			token: ReplayToken(
				"test/pg/world-model/privileges.test.ts#privilegesTamperMigrated:-:1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.1.0.0.0.0.1.0.1.0.0.1.0.0.0.0.0.0.0.0.2.8.1.2.0.1.0.0.2.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0"
			),
			reason:
				"row security enabled by hand on Doc, which the old installation already narrows, then a migration to one that narrows it no more: the migration's DISABLE ROW LEVEL SECURITY leaves Doc as the new installation states it, so the run ends ok, where the model kept the hand change standing and wanted the drift refused (STAMPRC5's red on d9a51ea25; the model's rowSecurityHealed)",
			since: "2026-11-25"
		},
		{
			token: ReplayToken(
				"test/pg/world-model/privileges.test.ts#privilegesTamperMigrated:3ffffff.9:1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.1.0.0.0.0.0.0.0.8.2.0.0"
			),
			reason:
				"row security enabled by hand on Org, which no role's entry narrows, and a migration that leaves it so: the drift check refuses the run, Org's row security the only fact that departs",
			since: "2026-11-25"
		}
	],
	kills: [
		{
			file: "packages/grizzle/src/adapter/admission/drift.ts",
			original:
				'\t\t\t\t\tC.caseWhen(\n\t\t\t\t\t\t[{ when: c.col("relrowsecurity"), result: C.text("enabled") }],\n\t\t\t\t\t\tC.text("disabled")\n\t\t\t\t\t),\n',
			replacement: '\t\t\t\t\tC.text("disabled"),\n',
			why: "The drift check reads no table's relrowsecurity (adapter/admission/drift.ts), so a table's row security enabled or disabled by hand is no fact that departs, and a migrate over it ends ok; the property fails."
		},
		{
			file: "packages/grizzle/src/adapter/migrate/errors.ts",
			original: "\t\t\tcatalogDeparted.has(this.failure.sqlstate) &&\n",
			replacement: "\t\t\tcatalogDeparted.has(sqlstates.internalError) &&\n",
			why: "A migration statement over an object the catalog lacks is reported as any failed statement, its fix to edit the file, never that the installation may have drifted, so the operator of a migrate whose folder drops a policy dropped by hand (42704) is never pointed at grizzle drift."
		}
	]
})
