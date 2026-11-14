import { Array as Arr } from "effect"
import { accessEntriesFrom, accessModule } from "#test/support/agreement/access.ts"
import { attachEntriesFrom, attachModule } from "#test/support/agreement/attachments.ts"
import { changeSetEntriesFrom, changeSetModules } from "#test/support/agreement/changesets.ts"
import { computeEntriesFrom, computeModules } from "#test/support/agreement/compute.ts"
import { configEntriesFrom, configModule } from "#test/support/agreement/dbconfig.ts"
import { genericEntriesFrom, genericModule } from "#test/support/agreement/generic-sources.ts"
import { agreementEntriesFrom, agreementModules } from "#test/support/agreement/queries.ts"
import { recursionEntriesFrom, recursionModule } from "#test/support/agreement/recursion.ts"
import { schemaEntriesFrom, schemaModules } from "#test/support/agreement/schemas.ts"
import { workloadEntriesFrom, workloadModule } from "#test/support/agreement/workloads.ts"
import { bytesProgram } from "#test/support/text/bytes.ts"
import { decoderEntriesFrom, decoderModule } from "#test/types/api/decoder.ts"
import { handleEntriesFrom, handleSource } from "#test/types/api/handle.ts"
import { surfaceEntriesFrom, surfaceModule } from "#test/types/api/surface.ts"
import { untypedEntriesFrom, untypedSource } from "#test/types/api/untyped.ts"
import type { Group, UnitSpec } from "#test/types/batch/batch.ts"
import { entryOwnerEntriesFrom, entryOwnerSource } from "#test/types/changeset/entry-owner.ts"
import { nestingCases, nestingSource } from "#test/types/changeset/nesting.ts"
import { parameterSource } from "#test/types/evidence/parameter.ts"
import { boundaryEntriesFrom, boundarySource } from "#test/types/executor/boundary.ts"
import { doorEntriesFrom, doorModule } from "#test/types/harness/door.ts"
import { vocabularyModule } from "#test/types/harness/vocabulary.ts"
import {
	entriesFrom,
	generateQuerySource,
	largestQuerySize
} from "#test/types/query/budget/generate.ts"
import { regexEntriesFrom, regexModules } from "#test/types/regex/agreement.ts"
import { familiesTwinSource, largestFamilies } from "#test/types/schema/budget/families.ts"
import {
	generateStatementSource,
	largestStatementSize
} from "#test/types/schema/budget/generate.ts"
import { generateSchemaSource, largestSkeletonSize } from "#test/types/skeleton/budget/generate.ts"
import { containedProgram } from "#test/types/text/contained.ts"

/**
 * Every type check of test/types, by the test file that reads it (test/types/batch/batch.ts). One run of the
 * type-test files checks all of their groups as one tsgo program.
 */

/** A fixture directory's two units: its fixtures in place, and their disarmed copy. */
const fixtureUnits = (name: string): Readonly<Record<string, UnitSpec>> => ({
	[`${name}/fixtures`]: { kind: "fixtures", dir: `test/types/${name}` },
	[`${name}/disarmed`]: { kind: "disarmed", dir: `test/types/${name}` }
})

const typeGroups: ReadonlyArray<Group> = [
	{
		owner: "test/types/api/access.test.ts",
		units: {
			"api/access": {
				kind: "program",
				dir: "test/types/api",
				prefix: ".access-",
				disarm: true,
				heavy: false,
				source: (entry, seed) => [
					{ file: "index.ts", source: accessModule(accessEntriesFrom(entry), seed) }
				]
			}
		}
	},
	{
		owner: "test/types/api/config.test.ts",
		units: {
			"api/config": {
				kind: "program",
				dir: "test/types/api",
				prefix: ".config-",
				disarm: true,
				heavy: false,
				source: (entry) => [{ file: "index.ts", source: configModule(configEntriesFrom(entry)) }]
			}
		}
	},
	{
		owner: "test/types/api/decoder.test.ts",
		units: {
			"api/decoder": {
				kind: "program",
				dir: "test/types/api",
				prefix: ".decoder-",
				disarm: false,
				heavy: false,
				source: (entry) => [{ file: "index.ts", source: decoderModule(decoderEntriesFrom(entry)) }]
			}
		}
	},
	{
		owner: "test/types/api/handle.test.ts",
		units: {
			"api/handle": {
				kind: "program",
				dir: "test/types/api",
				prefix: ".handle-",
				disarm: false,
				heavy: false,
				source: (entry) => [{ file: "index.ts", source: handleSource(handleEntriesFrom(entry)) }]
			}
		}
	},
	{
		owner: "test/types/api/recursion.test.ts",
		units: {
			"api/recursion": {
				kind: "program",
				dir: "test/types/api",
				prefix: ".recursion-",
				disarm: true,
				heavy: false,
				source: (entry, seed) => [
					{ file: "index.ts", source: recursionModule(recursionEntriesFrom(entry), seed) }
				]
			}
		}
	},
	{
		owner: "test/types/api/surface.test.ts",
		units: {
			"api/surface": {
				kind: "program",
				dir: "test/types/api",
				prefix: ".surface-",
				disarm: false,
				heavy: false,
				source: (entry) => [{ file: "index.ts", source: surfaceModule(surfaceEntriesFrom(entry)) }]
			}
		}
	},
	{
		owner: "test/types/api/untyped.test.ts",
		units: {
			"api/untyped": {
				kind: "program",
				dir: "test/types/api",
				prefix: ".untyped-",
				disarm: true,
				heavy: false,
				source: (entry) => [{ file: "index.ts", source: untypedSource(untypedEntriesFrom(entry)) }]
			}
		}
	},
	{
		owner: "test/types/api/workload.test.ts",
		units: {
			"api/workload": {
				kind: "program",
				dir: "test/types/api",
				prefix: ".workload-",
				disarm: true,
				heavy: false,
				source: (entry, seed) => [
					{ file: "index.ts", source: workloadModule(workloadEntriesFrom(entry), seed) }
				]
			}
		}
	},
	{
		owner: "test/types/changeset/changeset.test.ts",
		units: {
			"changeset/agreement": {
				kind: "program",
				dir: "test/types/changeset",
				prefix: ".agreement-",
				disarm: true,
				heavy: true,
				source: (entry, seed) => changeSetModules(changeSetEntriesFrom(entry), seed)
			}
		}
	},
	{
		owner: "test/types/changeset/entry-owner.test.ts",
		units: {
			"changeset/entry-owner": {
				kind: "program",
				dir: "test/types/changeset",
				prefix: ".entry-owner-",
				disarm: true,
				heavy: false,
				source: (entry) => [
					{ file: "index.ts", source: entryOwnerSource(entryOwnerEntriesFrom(entry)) }
				]
			}
		}
	},
	{
		owner: "test/types/changeset/nesting.test.ts",
		units: {
			"changeset/nesting": {
				kind: "program",
				dir: "test/types/changeset",
				prefix: ".nesting-",
				disarm: true,
				heavy: true,
				source: (entry) => [
					{ file: "index.ts", source: nestingSource(entriesFrom(entry), nestingCases) }
				]
			}
		}
	},
	{
		owner: "test/types/compute/compute.test.ts",
		units: {
			"compute/agreement": {
				kind: "program",
				dir: "test/types/compute",
				prefix: ".agreement-",
				disarm: true,
				heavy: false,
				source: (entry, seed) => computeModules(computeEntriesFrom(entry), seed)
			}
		}
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
	{
		owner: "test/types/evidence/attachments.test.ts",
		units: {
			"evidence/attachments": {
				kind: "program",
				dir: "test/types/evidence",
				prefix: ".attachments-",
				disarm: true,
				heavy: false,
				source: (entry, seed) => [
					{ file: "index.ts", source: attachModule(attachEntriesFrom(entry), seed) }
				]
			}
		}
	},
	{
		owner: "test/types/evidence/parameter.test.ts",
		units: {
			"evidence/parameter": {
				kind: "program",
				dir: "test/types/evidence",
				prefix: ".parameter-",
				disarm: true,
				heavy: false,
				source: () => [{ file: "index.ts", source: parameterSource() }]
			}
		}
	},
	{ owner: "test/types/examples/examples.test.ts", units: fixtureUnits("examples") },
	{
		owner: "test/types/executor/boundary.test.ts",
		units: {
			"executor/boundary": {
				kind: "program",
				dir: "test/types/executor",
				prefix: ".boundary-",
				disarm: true,
				heavy: false,
				source: (entry) => [
					{ file: "index.ts", source: boundarySource(boundaryEntriesFrom(entry)) }
				]
			}
		}
	},
	{
		owner: "test/types/harness/harness.test.ts",
		units: {
			"harness/vocabulary": {
				kind: "program",
				dir: "test/types/harness",
				prefix: ".vocabulary-",
				disarm: true,
				heavy: false,
				source: (_entry, seed) => [{ file: "index.ts", source: vocabularyModule(seed) }]
			},
			"harness/door": {
				kind: "program",
				dir: "test/types/harness",
				prefix: ".door-",
				disarm: true,
				heavy: false,
				source: (entry, seed) => [
					{ file: "index.ts", source: doorModule(doorEntriesFrom(entry), seed) }
				]
			}
		}
	},
	{
		owner: "test/types/query/budget/invariance.test.ts",
		units: {
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
		owner: "test/types/regex/agreement.test.ts",
		units: {
			"regex/agreement": {
				kind: "program",
				dir: "test/types/regex",
				prefix: ".agreement-",
				disarm: true,
				heavy: false,
				source: (entry, seed) => regexModules(regexEntriesFrom(entry), seed)
			}
		}
	},
	{
		owner: "test/types/schema/agreement.test.ts",
		units: {
			"schema/agreement": {
				kind: "program",
				dir: "test/types/schema",
				prefix: ".agreement-",
				disarm: true,
				heavy: false,
				source: (entry, seed) => schemaModules(schemaEntriesFrom(entry), seed)
			}
		}
	},
	{
		owner: "test/types/schema/generic.test.ts",
		units: {
			"schema/generic": {
				kind: "program",
				dir: "test/types/schema",
				prefix: ".generic-",
				disarm: true,
				heavy: false,
				source: (entry) => [{ file: "index.ts", source: genericModule(genericEntriesFrom(entry)) }]
			}
		}
	},
	{
		owner: "test/types/schema/budget/invariance.test.ts",
		units: {
			"schema/budget": {
				kind: "program",
				dir: "test/types/schema",
				prefix: ".budget-",
				disarm: true,
				heavy: true,
				source: (entry) => [
					{
						file: "index.ts",
						source: generateStatementSource(largestStatementSize, entriesFrom(entry))
					}
				]
			}
		}
	},
	{
		owner: "test/types/schema/budget/families.test.ts",
		units: {
			"schema/families": {
				kind: "program",
				dir: "test/types/schema",
				prefix: ".families-",
				disarm: true,
				heavy: true,
				source: (entry) => [
					{ file: "index.ts", source: familiesTwinSource(largestFamilies, entriesFrom(entry)) }
				]
			}
		}
	},
	{
		owner: "test/types/skeleton/budget/invariance.test.ts",
		units: {
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
			"text/contained": {
				kind: "program",
				dir: "test/types/text",
				prefix: ".contained-",
				disarm: false,
				heavy: false,
				source: (_entry, seed) => [{ file: "contained.ts", source: containedProgram(seed).source }]
			}
		}
	},
	{
		owner: "test/types/text/bytes.test.ts",
		units: {
			"text/bytes": {
				kind: "program",
				dir: "test/types/text",
				prefix: ".bytes-",
				disarm: false,
				heavy: false,
				source: (_entry, seed) => [{ file: "bytes.ts", source: bytesProgram(seed).source }]
			}
		}
	}
]

/**
 * The groups the batch's builder (build.ts) builds for the type-test files a run runs, by their paths relative to the
 * repository.
 */
export const groupsFor = (files: ReadonlyArray<string>): ReadonlyArray<Group> =>
	Arr.filter(typeGroups, (group) => files.includes(group.owner))
