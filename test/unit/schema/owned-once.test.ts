/**
 * A built schema is owned once, where its Owned is first read, and every reader of its Owned reads that one by reference
 * (schema/levels.ts BuiltSchemaContent, schema/world.ts BuiltRoleLevel): exhausted over programs of metis's import's
 * shape (owned-once.fixtures.ts), a schema, a schema.extend over it or none, a role over the top level or none, and 1, 3
 * or 12 records(...) over each level, each of which owned its level again (metis's import: 136 owns of 5 descriptions,
 * 72.6 s CPU). The budget is counted, not timed: the Owned objects the readers give, each level's read twice, its
 * compile's law model and the role's base, are one per schema value, the compile's the level's own and the role's base
 * the top level's, since an owning makes a new Owned. The records over each level are built first, so a program of many
 * records owns no more than one of few.
 *
 * Oracle: the specification, BuiltSchemaContent's JSDoc: one Owned per built schema, read by every reader.
 */
import { assert } from "@bjornpagen/testing/assert"
import { property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { ownsOf, readsOf, shapes } from "#test/unit/schema/owned-once.fixtures.ts"

/** Every reader of a built schema's Owned reads the one its build made: one Owned per schema value, however many read. */
export const aBuiltSchemaIsOwnedOnce = property.exhaust(shapes, {
	box: "a schema alone or extended, with a role over its top level or none, and 1, 3 or 12 records over each level",
	needs: {},
	situations: [],
	check: () => (shape) =>
		Effect.sync(() => {
			const reads = readsOf(shape)
			assert.deepEqual(
				{
					distinct: reads.distinct,
					compiledAsBuilt: reads.compiledAsBuilt,
					roleOverTop: reads.roleOverTop
				},
				{ distinct: reads.schemas, compiledAsBuilt: true, roleOverTop: true }
			)
		}),
	oracle: {
		kind: "specification",
		name: "one Owned per built schema, read by every reader (BuiltSchemaContent)"
	},
	kept: [],
	kills: [
		{
			file: "packages/engine/src/program/schema.ts",
			original: "Result.flatMap(schema.content.owned(), plannedModel)",
			replacement: "Result.flatMap(own(schema.desc), plannedModel)",
			why: "A built schema's compile owns it again from its description, as records(...) did once a records: the compile's Owned is a second one."
		},
		{
			file: "packages/engine/src/schema/world.ts",
			original: "Result.flatMap(baseEntry.content.owned(), (owned) => ownBuiltRole(desc, owned))",
			replacement:
				"Result.flatMap(baseEntry.content.owned(), (owned) => ownBuiltRole(desc, { ...owned }))",
			why: "A role is owned over a base Owned other than its base's own: its base is a second Owned, as ownRole's own(desc.base) made one."
		}
	]
})

/**
 * Building a program owns no level, however many records it builds over each: a records value types its contract
 * columns by its level's contracts, a fact of the level's content (schema/levels.ts SchemaContent contracts), not by an
 * owning of the level (metis's den worker: 136 owns of 5 descriptions by records alone, 48.9 s of its 68.4 s import).
 * Each schema's compile then owns it once: as many ownings as schemas. Counted, not timed (ownWith's calls).
 */
export const aProgramsRecordsOwnNoLevelAndEachSchemasCompileOwnsItOnce = property.exhaust(shapes, {
	box: "a schema alone or extended, with a role over its top level or none, and 1, 3 or 12 records over each level",
	needs: {},
	situations: [],
	check: () => (shape) =>
		Effect.map(ownsOf(shape), (owns) =>
			assert.deepEqual(
				{ building: owns.building, compiling: owns.compiling },
				{ building: 0, compiling: owns.schemas }
			)
		),
	oracle: {
		kind: "specification",
		name: "no owning at build; one per schema at its compile (SchemaContent contracts, BuiltSchemaContent)"
	},
	kept: [],
	kills: [
		{
			file: "packages/engine/src/program/records.ts",
			original: "\t\t\treturn Result.ok(contentDeclarations(level.content))",
			replacement:
				"\t\t\treturn Result.map(level.content.owned(), () => contentDeclarations(level.content))",
			why: "Records own their level again to type its contract and variant columns, as they did: building the program owns each level its records read."
		}
	]
})
