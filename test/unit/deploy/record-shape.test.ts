/**
 * The shape each file grizzle reads back is stated by (core/format.ts recordShapes) is the shape of the type this
 * grizzle writes it from: a committed snapshot's record (deploy/snapshot/build.ts SealedRecord) and a served file
 * (served/forms.ts ServedFile), each resolved by the TypeScript compiler's checker and minimized
 * (test/support/record-shape.ts recordShapeOf). So a change of what a file holds fails this test until the constant
 * states the new shape in the same change, and every file of the old shape is refused by its format.
 *
 * Oracle: second implementation, the TypeScript checker's resolution of each file's type over the engine's project.
 */
import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { element, finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { type FormattedFile, formattedFiles, recordShapes } from "#compiler/core/format.ts"
import { repoRoot } from "#test/support/files.ts"
import { recordShapeOf } from "#test/support/record-shape.ts"

/** The shape each file's format states is the shape of the type this grizzle writes it from. */
export const theShapeEachFilesFormatStatesIsTheShapeOfTheTypeThisGrizzleWritesItFrom =
	property.exhaust(
		finite((source): FormattedFile => source.draw(element(formattedFiles))),
		{
			needs: {},
			situations: formattedFiles satisfies ReadonlyArray<Reached<FormattedFile>>,
			check: (_, c: Case<FormattedFile>) => (file) =>
				Effect.sync(() => {
					c.note(file)
					assert.equal(
						recordShapeOf(`${repoRoot}packages/engine`, file),
						recordShapes[file],
						`core/format.ts recordShapes.${file} is the digest of the ${file} file's type as this grizzle declares it: a change of what the file holds states its new shape there`
					)
				}),
			oracle: {
				kind: "second-implementation",
				name: "the TypeScript checker's resolution of each file's type over the engine's project (test/support/record-shape.ts)"
			},
			box: "a committed snapshot's record and a served file, over the engine's project as it stands",
			kept: [],
			kills: [
				{
					file: "packages/engine/src/core/format.ts",
					original:
						'\tsnapshot: "46b2458739d2323ae3bba6dd2941595bc932f92323ff3ec5b037202fe4c95619",',
					replacement:
						'\tsnapshot: "46b2458739d2323ae3bba6dd2941595bc932f92323ff3ec5b037202fe4c9561a",',
					why: "A record's shape changed without the constant stating it: the shape the format states is not the one the checker resolves. The kill states another shape, since the mutation runner rewrites a module as it loads and the checker reads the record's types from disk, where a mutated type never reaches it; a declared statistic's dependencies made optional on disk changes the resolved shape (46b24587… to another), which this property then refuses."
				}
			]
		}
	)
