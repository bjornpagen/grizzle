/**
 * A schema's law violation queries are held by none of their readers past the read (laws/model/violations.ts
 * theoryViolations): its artifacts, its checked schema and its theory alive, the queries a read wrote are collected
 * once the read drops them, where a memo keyed by the checked schema and the theory held every schema's for as long as
 * the schema lived, a level's below the configured schema's among them, which a generate reads once and keeps through
 * its change compile and its served files (metis's full installation: eleven schemas' violation queries, 380 MB of its
 * heap as its change compile ran).
 *
 * The box, exhausted: Work (a roster, a closed id and keys), Plans (a roster and a closed relation over it) and Shared
 * (bound imports over one relation), each compiled to its artifacts as a test compiles them.
 *
 * Property, per case: the violation queries of the artifacts' checked schema and theory, written and dropped, held only
 * through a weak reference, are collected by a full collection (node:v8 queryObjects, which collects first) while the
 * artifacts, their law model, checked schema and theory are held. Oracle: specification, a read's queries are its own.
 * Kill: each schema's violation queries kept by the schema, as the memo kept them.
 *
 * Features: a schema with a closed relation, a schema without one.
 */

import { queryObjects } from "node:v8"
import { assert } from "@bjornpagen/testing/assert"
import { element, finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { CheckedSchema } from "#compiler/analysis/schema.ts"
import type { Theory } from "#compiler/analysis/theory/theory.ts"
import { type TheoryViolations, theoryViolations } from "#compiler/laws/model/violations.ts"
import { succeeded } from "#test/support/assert.ts"
import { type FixtureSchema, testArtifacts, testCompile } from "#test/support/compile.ts"
import { Plans, Work } from "#test/support/fixtures/api/work.ts"
import { Shared } from "#test/support/unit/write/shared-imports.fixtures.ts"

type Feature = "a schema with a closed relation" | "a schema without one"

type Shape = "Work" | "Plans" | "Shared"

const schemaOf = (shape: Shape): FixtureSchema => {
	switch (shape) {
		case "Work":
			return Work
		case "Plans":
			return Plans
		case "Shared":
			return Shared
	}
}

/**
 * The job that made a weak reference ended: V8 keeps a WeakRef's target alive to the end of the job that made it
 * (ECMA-262 AddToKeptObjects), so a collection inside that job never collects it.
 */
const jobEnded = Effect.callback<void>((resume) => {
	setImmediate(() => resume(Effect.void))
})

/** A full collection: V8 collects before it counts (node:v8 queryObjects). */
const collect = (): number => queryObjects(CheckedSchema, { format: "count" })

/** A weak reference to the violation queries one read writes, the read and its result dropped. */
const writtenAndDropped = (checked: CheckedSchema, theory: Theory): WeakRef<TheoryViolations> =>
	new WeakRef(succeeded(theoryViolations(checked, theory)))

/** A schema's violation queries are held by no reader past its read: dropped, they are collected while the schema lives. */
export const aSchemasViolationQueriesAreHeldByNoReaderPastItsReadDroppedTheyAreCollectedWhileTheSchemaLives =
	property.exhaust(
		finite((source) => source.draw(element<Shape>(["Work", "Plans", "Shared"]))),
		{
			needs: {},
			situations: ["a schema with a closed relation", "a schema without one"],
			check: (_, k: Case<Feature>) => (shape) =>
				Effect.gen(function* () {
					const artifacts = succeeded(testArtifacts(schemaOf(shape), testCompile))
					k.note(
						artifacts.laws.checked.closed.size > 0
							? "a schema with a closed relation"
							: "a schema without one"
					)
					const held = writtenAndDropped(artifacts.laws.checked, artifacts.laws.theory)
					yield* jobEnded
					collect()
					assert.equal(
						held.deref(),
						undefined,
						`${shape}: no reader holds the violation queries it dropped`
					)
					assert.ok(
						artifacts.laws.theory.laws.length > 0,
						`${shape}: the schema and its theory are held`
					)
				}),
			oracle: { kind: "specification", name: "a read's violation queries are its own" },
			box: "Work, Plans and Shared, each compiled to its artifacts",
			kept: [],
			kills: [
				{
					file: "packages/engine/src/laws/model/violations.ts",
					original: "\t\treturn { dag: supply.dag([...forbids.values()]), forbids }\n\t})\n",
					replacement:
						"\t\tconst held = { dag: supply.dag([...forbids.values()]), forbids }\n\t\tkeptBySchema.set(checked, held)\n\t\treturn held\n\t})\nconst keptBySchema = new WeakMap<CheckedSchema, TheoryViolations>()\n",
					why: "Each schema's violation queries are kept by the schema, as the memo kept them, so a level's live as long as its artifacts and the dropped ones are never collected."
				}
			]
		}
	)
