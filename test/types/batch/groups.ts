import { Array as Arr, Record as Rec } from "effect"
import { agreementEntriesFrom, agreementModules } from "#test/support/agreement/queries.ts"
import { checkUnit, type Group, type UnitSpec } from "#test/types/batch/batch.ts"
import {
	entriesFrom,
	generateQuerySource,
	largestQuerySize
} from "#test/types/query/budget/generate.ts"
import { programSource } from "#test/types/regex/program.ts"
import { regexSchemaPatterns, regexSchemaSource } from "#test/types/regex/schema.ts"
import { generateSchemaSource, largestSkeletonSize } from "#test/types/skeleton/budget/generate.ts"
import { containedProgram } from "#test/types/text/contained.ts"

/**
 * Every type check of test/types, by the test file that reads it (test/types/batch/batch.ts). One run of the
 * type-test files checks all of their groups as one tsgo program.
 *
 * A path from a generated program's directory into the repository.
 */

/**
 * A fixture directory's two units: its fixtures in place, with the files its project includes, and their disarmed copy.
 */
const fixtureUnits = (
	name: string,
	extra: ReadonlyArray<string>
): Readonly<Record<string, UnitSpec>> => ({
	[`${name}/fixtures`]: { kind: "fixtures", dir: `test/types/${name}`, extra },
	[`${name}/disarmed`]: { kind: "disarmed", dir: `test/types/${name}` }
})

export const typeGroups: ReadonlyArray<Group> = [
	{ owner: "test/types/api/api.test.ts", units: fixtureUnits("api", ["support.ts"]) },
	{
		owner: "test/types/changeset/changeset.test.ts",
		units: fixtureUnits("changeset", ["support.ts"])
	},
	{ owner: "test/types/compute/compute.test.ts", units: fixtureUnits("compute", ["support.ts"]) },
	{ owner: "test/types/derived/derived.test.ts", units: fixtureUnits("derived", ["support.ts"]) },
	{
		owner: "test/types/evidence/evidence.test.ts",
		units: fixtureUnits("evidence", ["support.ts"])
	},
	{
		owner: "test/types/evidence/agreement.test.ts",
		units: {
			"evidence/agreement": {
				kind: "program",
				dir: "test/types/evidence",
				prefix: ".agreement-",
				disarm: true,
				heavy: false,
				source: (entry, seed) => agreementModules(agreementEntriesFrom(entry), seed)
			}
		}
	},
	{ owner: "test/types/examples/examples.test.ts", units: fixtureUnits("examples", ["work.ts"]) },
	{ owner: "test/types/fields/fields.test.ts", units: fixtureUnits("fields", ["support.ts"]) },
	{ owner: "test/types/harness/harness.test.ts", units: fixtureUnits("harness", []) },
	{ owner: "test/types/page/page.test.ts", units: fixtureUnits("page", ["support.ts"]) },
	{
		owner: "test/types/query/query.test.ts",
		units: {
			...fixtureUnits("query", ["support.ts"]),
			"query/budget": {
				kind: "program",
				dir: "test/types/query",
				prefix: ".budget-",
				disarm: true,
				heavy: true,
				source: (entry) => [
					{ file: "index.ts", source: generateQuerySource(largestQuerySize, entriesFrom(entry)) }
				]
			}
		}
	},
	{
		owner: "test/types/regex/schema.test.ts",
		units: {
			"regex/schema": {
				kind: "program",
				dir: "test/types/regex",
				prefix: ".schema-",
				disarm: true,
				heavy: false,
				source: (entry) => [
					{ file: "index.ts", source: regexSchemaSource(regexSchemaPatterns, entriesFrom(entry)) }
				]
			}
		}
	},
	{
		owner: "test/types/regex/matrix.test.ts",
		units: Rec.fromEntries(
			Arr.map([false, true], (disarm): readonly [string, UnitSpec] => [
				disarm ? "regex/matrix-disarmed" : "regex/matrix",
				{
					kind: "program",
					dir: "test/types/regex",
					prefix: ".matrix-",
					disarm,
					heavy: false,
					source: (entry) => [{ file: "index.ts", source: programSource(entriesFrom(entry)) }]
				}
			])
		)
	},
	{ owner: "test/types/schema/schema.test.ts", units: fixtureUnits("schema", ["support.ts"]) },
	{
		owner: "test/types/skeleton/skeleton.test.ts",
		units: {
			...fixtureUnits("skeleton", ["support.ts"]),
			"skeleton/budget": {
				kind: "program",
				dir: "test/types/skeleton",
				prefix: ".budget-",
				disarm: true,
				heavy: true,
				source: (entry) => [
					{
						file: "index.ts",
						source: generateSchemaSource(largestSkeletonSize, entriesFrom(entry))
					}
				]
			}
		}
	},
	{
		owner: "test/types/text/regex.test.ts",
		units: {
			...fixtureUnits("text", ["support.ts"]),
			"text/contained": {
				kind: "program",
				dir: "test/types/text",
				prefix: ".contained-",
				disarm: false,
				heavy: false,
				source: (_entry, seed) => [{ file: "contained.ts", source: containedProgram(seed).source }]
			}
		}
	}
]

/**
 * The groups the type tier's global setup builds for the type-test files a run runs, by their paths relative to the
 * repository (global-setup.ts).
 */
export const groupsFor = (files: ReadonlyArray<string>): ReadonlyArray<Group> =>
	Arr.filter(typeGroups, (group) => files.includes(group.owner))

/** The diagnostics of one unit of the batch, an Effect a type test runs. */
export const checked = (unit: string) => checkUnit(typeGroups, unit)
