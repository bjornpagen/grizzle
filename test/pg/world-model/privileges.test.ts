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
 * (README "Migrations": the run ends with the drift check): never an `ok` over a catalog that still departs from the
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
