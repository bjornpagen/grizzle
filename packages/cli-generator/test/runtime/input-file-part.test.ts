/**
 * A file part's flag reads its file, or stdin once per run, and its Content-Disposition names the file by its path's
 * last segment; a path that is missing, a directory or unreadable, and a second claimant of stdin, are refused through
 * the final catch naming the flag, in text and in `--error-format json`, never echoing the path the operator gave
 * (m3-pwmh: a `format: password` part is a file part, and its path may be the secret itself).
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Scratch } from "@bjornpagen/testing/resources"
import {
	Array as Arr,
	Effect,
	Exit,
	FileSystem,
	Path,
	Ref,
	Sink,
	Stdio,
	Stream,
	String as Str
} from "effect"
import * as Input from "#runtime-src/runtime/input.ts"
import * as Multipart from "#runtime-src/runtime/multipart.ts"
import * as Output from "#runtime-src/runtime/output.ts"
import { RunCredentials, type ScrubEntry } from "#runtime-src/runtime/redact.ts"
import {
	type FileFeature,
	fileFeatures,
	fileSpace,
	filenameModel,
	laidOut,
	pathOf,
	readingModel,
	STDIN
} from "#test/runtime/input-file-part.fixtures.ts"
import { latin1 } from "#test/runtime/serialize.fixtures.ts"

/**
 * A run reads its file parts as its model says, or is refused naming the first refused part's flag and never its path.
 * It replaces seven example cases (the password part's three read failures, each in text and json, and its fields)
 * and serialize's stdin and file part reading; its budget is 32 drawn runs, its floor 8, steered up to 32.
 */
export const filePart = property.explore(fileSpace, {
	needs: { dir: Scratch.dir },
	situations: [
		"regular file read",
		"stdin read",
		"second stdin claimant refused",
		"missing file refused",
		"directory refused",
		"unreadable file refused",
		"refusal in json"
	] satisfies ReadonlyArray<Reached<FileFeature>>,
	check: (resources, c: Case<FileFeature>) => (run) =>
		Effect.gen(function* () {
			c.noteAll(fileFeatures(run, STDIN))
			const dir = yield* resources.dir
			const fs = yield* FileSystem.FileSystem
			const path = yield* Path.Path
			const placed = Arr.map(
				run.parts,
				(part) => [part, pathOf(path, dir, part, run.secret)] as const
			)
			yield* Effect.forEach(placed, ([part, at]) => laidOut(fs, at, part))
			yield* Effect.addFinalizer(() =>
				Effect.forEach(placed, ([, at]) => Effect.ignore(fs.chmod(at, 0o700)), { discard: true })
			)
			for (const [part, at] of placed) {
				assert.equal(Multipart.partFilename(at, part.flag), filenameModel(at, part.flag))
			}
			const stdout: Array<Uint8Array> = []
			const stderr: Array<Uint8Array> = []
			const keep = (into: Array<Uint8Array>) => (chunk: string | Uint8Array) =>
				Effect.sync(() => {
					into.push(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk)
				})
			const capture = (into: Array<Uint8Array>) => () => Sink.forEach(keep(into))
			const read = Effect.forEach(placed, ([part, at]) =>
				Effect.flatMap(Multipart.fileBody(part.flag, at), (stream) =>
					Effect.map(Stream.runCollect(Stream.orDie(stream)), (chunks) =>
						Arr.join(Arr.map(Arr.fromIterable(chunks), latin1), "")
					)
				)
			)
			const exit = yield* Effect.exit(
				Output.finalCatch([])(read).pipe(
					Effect.provideServiceEffect(
						Output.RunRecord,
						Ref.make<Output.RunRecordState>({ format: run.format })
					),
					Effect.provideServiceEffect(RunCredentials, Ref.make<ReadonlyArray<ScrubEntry>>([])),
					Effect.provideService(
						Stdio.Stdio,
						Stdio.make({
							args: Effect.succeed([]),
							stdout: capture(stdout),
							stderr: capture(stderr),
							stdin: Stream.make(STDIN)
						})
					),
					Effect.provide(Input.stdinClaimLayer)
				)
			)
			const printedOut = latin1(Buffer.concat(stdout))
			const printedErr = new TextDecoder().decode(Buffer.concat(stderr))
			const expected = readingModel(run, STDIN)
			switch (expected.kind) {
				case "read":
					assert.deepEqual<ReadonlyArray<string>>(
						Exit.isSuccess(exit) ? exit.value : [],
						expected.bytes
					)
					assert.ok(Exit.isSuccess(exit), "a run of readable parts reads them")
					assert.equal(printedErr, "")
					break
				case "refused": {
					assert.ok(Exit.isFailure(exit), "a refused part fails the run")
					assert.ok(Str.includes(`--${expected.flag}`)(printedErr), "the refusal names the flag")
					if (run.format === "json") {
						assert.deepEqual(
							Arr.filter(Str.split("\n")(Str.trimEnd(printedErr)), Str.isNonEmpty).length,
							1
						)
						assert.ok(
							Str.includes('"kind":"UsageError"')(printedErr),
							"the json refusal is a UsageError"
						)
					}
				}
			}
			assert.equal(printedOut, "")
			assert.equal(
				Str.includes(run.secret)(printedErr),
				false,
				"a refusal echoes the path the operator gave"
			)
		}),
	oracle: {
		kind: "specification",
		name: "design 4.5's file part reading: a regular readable file, stdin once, every other path refused by its flag"
	},
	kept: [],
	budget: { runs: 32, steered: 32 },
	kills: [
		{
			file: "packages/cli-generator/src/runtime-src/runtime/multipart.ts",
			original: 'info.type === "File"',
			replacement: "true",
			why: "A directory passes the regular-file check, so its read fails past the check with the file system's cause; the property fails (CATCH's evidence, mutant d82ede44ae)."
		},
		{
			file: "packages/cli-generator/src/runtime-src/runtime/input.ts",
			original: '\tpath === "-"',
			replacement: '\tpath !== "-"',
			why: "A path reads stdin and - reads a file named -, so every part reads the wrong source; the property fails (CATCH's evidence, mutant fada6f4a7d)."
		},
		{
			file: "packages/cli-generator/src/runtime-src/runtime/input.ts",
			original: "Option.isSome(held) ? [held, held] : [Option.none<string>(), Option.some(flag)]",
			replacement: "[Option.none<string>(), Option.some(flag)]",
			why: "Every claimant of stdin is granted it, so a second part reading - reads an already drained stdin instead of being refused; the property fails."
		}
	]
})
