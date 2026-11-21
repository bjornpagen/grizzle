/**
 * Every file a generation writes is a function of its inputs alone, and `generate --check` (generate.ts
 * checkGeneration, write/index.ts checkFiles) passes exactly when the output directory holds that generation.
 *
 * - relocatedAlike: the golden package's spec and author config, laid out under two roots at different absolute
 *   paths, each layout once, generate the same bytes in every file, generation-report.json and the manifest among
 *   them, and no file names either root: a report names each document by its label against the entry
 *   (model/uri.ts documentLabel), as the emitted code already did, where it wrote each document's file URL, so a
 *   generation read differently on every machine (metis deleted both reports for it).
 * - checkVerdicts: a fresh generation checks clean; one with a file edited or missing, the manifest among them, or
 *   with an extra file its manifest lists that the run no longer writes, checks with exactly that file named, in path
 *   order, and nothing is written by the check.
 */
import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Scratch } from "@bjornpagen/testing/resources"
import { Array as Arr, Effect, Path } from "effect"
import { Digest } from "effect/crypto"
import { digestService } from "#test/support/digest.ts"
import {
	type CheckFeature,
	checkedAfter,
	faults,
	generatedUnder,
	layouts,
	namesRoot
} from "#test/write/check.fixtures.ts"

/**
 * Two generations of the same inputs in the same layout under two different roots write the same files with the same
 * bytes, and none of them names a root. One case per layout.
 */
export const relocatedAlike = property.exhaust(layouts, {
	box: "the golden package's spec and author config in three layouts, each generated under two roots",
	needs: { dir: Scratch.dir, digest: digestService },
	situations: ["a layout generated under two roots"],
	check:
		({ dir, digest }, c: Case<"a layout generated under two roots">) =>
		(layout) =>
			Effect.gen(function* () {
				const service = yield* digest
				const path = yield* Path.Path
				const root = yield* dir
				const first = path.join(root, "first")
				const second = path.join(root, "second", "deeper")
				const left = yield* Effect.provideService(
					generatedUnder(first, layout),
					Digest.Digest,
					service
				)
				const right = yield* Effect.provideService(
					generatedUnder(second, layout),
					Digest.Digest,
					service
				)
				c.note("a layout generated under two roots")
				assert.deepEqual(left, right, "the same inputs write the same files with the same bytes")
				assert.deepEqual(
					Arr.filter(left, ([, text]) => namesRoot(text, first)),
					[],
					"no generated file names the directory it was generated under"
				)
			}),
	oracle: {
		kind: "specification",
		name: "a generation is a function of its inputs alone: equal inputs, equal bytes, wherever they sit"
	},
	kept: [],
	kills: [
		{
			file: "packages/cli-generator/src/report/index.ts",
			original: "? documentLabel(entry, member)",
			replacement: "? member",
			why: "The report names each document by its file URL again, so a generation under another directory writes another generation-report.json and manifest; the property fails."
		},
		{
			file: "packages/cli-generator/src/model/uri.ts",
			original: "if (base.origin !== target.origin || base.protocol !== target.protocol) {",
			replacement: "if (true) {",
			why: "Every document is labelled by its origin and full path, a host path for a file, so the report names the directory it ran in; the property fails."
		}
	]
})

/**
 * A check of an output directory finds exactly the faults it carries against a fresh generation: none for a fresh
 * one, the edited or missing file, or the extra file its manifest lists beside the manifest that lists it.
 */
export const checkVerdicts = property.exhaust(faults, {
	box: "no fault, an extra listed file, and an edited or a missing file at each of the first eight files a generation writes",
	needs: { dir: Scratch.dir, digest: digestService },
	situations: [
		"a fresh generation passes",
		"an extra file the manifest lists",
		"a generated file edited",
		"a generated file missing",
		"the manifest edited",
		"the manifest missing"
	] satisfies ReadonlyArray<Reached<CheckFeature>>,
	check:
		({ dir, digest }, c: Case<CheckFeature>) =>
		(fault) =>
			Effect.gen(function* () {
				const root = yield* dir
				const service = yield* digest
				const { expected, feature, found } = yield* Effect.provideService(
					checkedAfter(root, fault),
					Digest.Digest,
					service
				)
				c.note(feature)
				assert.deepEqual(
					found,
					expected,
					"the check names exactly the faulted files, in path order"
				)
			}),
	oracle: {
		kind: "specification",
		name: "--check: every file the run writes holds its bytes, and the output's manifest lists no file the run no longer writes"
	},
	kept: [],
	kills: [
		{
			file: "packages/cli-generator/src/write/index.ts",
			original: 'text === file.content ? [] : [{ kind: "edited", path: file.path }]',
			replacement: "[]",
			why: "A file is taken as the generation's whatever it holds, so an edited file checks clean; the property fails."
		},
		{
			file: "packages/cli-generator/src/write/index.ts",
			original: 'onNone: (): readonly CheckDifference[] => [{ kind: "missing", path: file.path }]',
			replacement: "onNone: (): readonly CheckDifference[] => []",
			why: "A file the run writes may be absent, so a missing file checks clean; the property fails."
		},
		{
			file: "packages/cli-generator/src/write/index.ts",
			original: "Arr.filter(previous.entries, (entry) => !written.has(fold(entry.path)))",
			replacement: "Arr.filter(previous.entries, () => false)",
			why: "A file the output's manifest lists that the run no longer writes goes unnamed, so a stale file checks as part of the generation; the property fails."
		}
	]
})
