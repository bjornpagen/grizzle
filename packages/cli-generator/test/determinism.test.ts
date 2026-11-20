/**
 * Determinism (invariant I8): a generated package is a function of its document and its author config alone, so one
 * document generated twice, into two fresh output directories at different paths, leaves the same tree of files, byte
 * for byte, its generation report and its manifest among them.
 *
 * Oracle: the document generated a second time, into a directory of its own (metamorphic).
 */
import { assert } from "@bjornpagen/testing/assert"
import { type Case, property } from "@bjornpagen/testing/property"
import { Scratch } from "@bjornpagen/testing/resources"
import { Effect } from "effect"
import {
	type DeterminismFeature,
	determinismFeaturesOf,
	generationSpace,
	treeOf
} from "#test/determinism.fixtures.ts"
import { digestService } from "#test/support/digest.ts"

/**
 * One document generated twice leaves one tree. Its budget replaces the one example case of the suite it converts (the
 * golden fixture generated twice) with two drawn documents, each a whole generation twice, and up to eight steered
 * while no document of several operations has run, as canonical-order's, which generates twice a case too.
 */
export const generatedTwiceAlike = property.explore(generationSpace, {
	needs: { scratch: Scratch.dir, digest: digestService },
	situations: ["a package of several operations"],
	check: (resources, k: Case<DeterminismFeature>) => (c) =>
		Effect.gen(function* () {
			k.noteAll(determinismFeaturesOf(c))
			const scratch = yield* resources.scratch
			const digest = yield* resources.digest
			const first = yield* treeOf(scratch, digest, "first", c)
			const second = yield* treeOf(scratch, digest, "a-second-run", c)
			assert.deepEqual(second, first, "the second generation's tree is the first's, byte for byte")
		}),
	oracle: {
		kind: "universal",
		name: "a document generated twice into fresh directories leaves the same files"
	},
	kept: [],
	budget: { runs: 2, steered: 8 },
	kills: [
		{
			file: "packages/cli-generator/src/write/index.ts",
			original: "Effect.map((sha256) => ({ path: file.path, sha256, size: bytes.length }))",
			replacement:
				'Effect.map((sha256) => ({ path: outputDir + "/" + file.path, sha256, size: bytes.length }))',
			why: "The manifest records each file under the output directory's own path, so a package's bytes depend on where it was generated; the property fails."
		},
		{
			file: "packages/cli-generator/src/write/index.ts",
			original:
				'\t\tyield* lock.registerTemp(temp)\n\t\tyield* fs\n\t\t\t.writeFileString(temp, content, { flag: "wx" })\n\t\t\t.pipe(Effect.mapError(ioFailure(relative)))\n\t\tyield* fs.rename(temp, target).pipe(Effect.mapError(ioFailure(relative)))',
			replacement:
				'\t\tyield* fs\n\t\t\t.writeFileString(temp, content, { flag: "wx" })\n\t\t\t.pipe(Effect.mapError(ioFailure(relative)))\n\t\tyield* fs.copyFile(temp, target).pipe(Effect.mapError(ioFailure(relative)))',
			why: "The writer copies each temp sibling into place and forgets it, so every run leaves its temp files under names of its own random part; the property fails."
		}
	]
})
