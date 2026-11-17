/**
 * A response body reaches its destination as design 4.6 and 13.1 say: stdout, where a binary body at a terminal is
 * refused before any chunk is read, a reader that went away ends the write as a success and another write failure is
 * OutputError write; `--output -`, stdout without the terminal guard; or a file written through a temp sibling renamed
 * into place, an existing target refused untouched unless `--force`, one made while the body streams refused at the
 * rename unless `--force`, a missing directory OutputError write, and a failing body leaving neither target nor temp.
 */

import { deepStrictEqual } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Scratch } from "@bjornpagen/testing/resources"
import { Effect } from "effect"
import {
	aimedSinkings,
	expectedOf,
	type SinkFeature,
	sinkFeatures,
	sunkIn
} from "#test/runtime/output-sink.fixtures.ts"

/**
 * A body lands where the settings say, or is refused before it is read. It replaces twelve example cases (output.test.ts's
 * stdout sink and --output file cases); its rotating stream is twelve drawn writes, its floor and steered phase reach
 * each situation by an aimed one.
 */
export const bodySunk = property.explore(aimedSinkings, {
	needs: { dir: Scratch.dir },
	situations: [
		"text to a terminal",
		"binary refused at a terminal",
		"--output - with binary at a terminal",
		"a reader gone away",
		"a stdout write failure",
		"a failing body",
		"a fresh file",
		"an existing file refused",
		"an existing file forced",
		"a file made while streaming",
		"a missing directory"
	] satisfies ReadonlyArray<Reached<SinkFeature>>,
	check:
		({ dir }, c: Case<SinkFeature>) =>
		(sinking) =>
			Effect.gen(function* () {
				c.noteAll(sinkFeatures(sinking))
				const scratch = yield* dir
				const sunk = yield* sunkIn(scratch, sinking)
				deepStrictEqual(sunk, expectedOf(sinking))
			}),
	oracle: {
		kind: "specification",
		name: "design 4.6 and 13.1: each destination's bytes, refusals and faults"
	},
	kept: [],
	budget: { runs: 12, steered: 24 },
	kills: [
		{
			file: "packages/generator/src/runtime-src/runtime/output.ts",
			original: "\t\tif (target === undefined && binary) {",
			replacement: "\t\tif (target !== undefined && binary) {",
			why: "The terminal guard reads only a file destination, so a binary body is written to a terminal; the property fails (CATCH's evidence, mutant 3f20097714)."
		},
		{
			file: "packages/generator/src/runtime-src/runtime/output.ts",
			original: 'yield* new OutputError({ path: target, reason: "exists" })',
			replacement: "{}",
			why: "An existing target is no longer refused, so it is overwritten without --force; the property fails (CATCH's evidence, mutant 57395d4eb0)."
		},
		{
			file: "packages/generator/src/runtime-src/runtime/output.ts",
			original:
				"\t\t\t\tEffect.ignore(fs.remove(path.dirname(temp), { force: true, recursive: true }))",
			replacement:
				"\t\t\t\tEffect.ignore(fs.remove(path.dirname(temp), { force: true, recursive: false }))",
			why: "A write's temp directory is kept when the write ends, so the target's directory holds more than the target; the property fails (CATCH's evidence, mutant 62a0af4ac4)."
		},
		{
			file: "packages/generator/src/runtime-src/runtime/output.ts",
			original: 'error.reason._tag === "Unknown" && Schema.is(BrokenPipe)(error.reason.cause)',
			replacement: "true",
			why: "Every stdout failure reads as a reader gone away, so a disk-full write succeeds; the property fails (CATCH's evidence, mutant bb1002520d)."
		},
		{
			file: "packages/generator/src/runtime-src/runtime/output.ts",
			original: '\terror.reason._tag === "Unknown" && Schema.is(BrokenPipe)(error.reason.cause)',
			replacement: '\terror.reason._tag !== "Unknown" && Schema.is(BrokenPipe)(error.reason.cause)',
			why: "A reader gone away reads as another failure, so EPIPE fails the write; the property fails (CATCH's evidence, mutant bfd187111c)."
		},
		{
			file: "packages/generator/src/runtime-src/runtime/output.ts",
			original:
				"isText(mediaType) || (mediaType !== undefined && sequentialCodecOf(mediaType) !== undefined)",
			replacement: "(mediaType !== undefined && sequentialCodecOf(mediaType) !== undefined)",
			why: "A text body that is no sequence reads as binary, so it is refused at a terminal; the property fails (CATCH's evidence, mutant d9708ffc13)."
		}
	]
})
