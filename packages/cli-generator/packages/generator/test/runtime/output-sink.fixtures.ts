/** What output-sink.test.ts's property reads: drawn bodies, destinations and faults, and where their bytes land. */

import {
	type Aimed,
	aimed,
	constant,
	element,
	type Gen,
	map,
	weighted
} from "@bjornpagen/testing/gen"
import type { ScratchDir } from "@bjornpagen/testing/resources"
import {
	Array as Arr,
	Cause,
	Effect,
	Exit,
	FileSystem,
	Layer,
	Option,
	Order,
	Path,
	PlatformError,
	Sink,
	Stdio,
	Stream
} from "effect"
import { Force, OutputPath, writeBody } from "#runtime-src/runtime/output.ts"

/** Media types a body may carry: text, and binary types a terminal must not receive. */
const MEDIA: Arr.NonEmptyReadonlyArray<readonly [string | undefined, boolean]> = [
	["text/plain; charset=utf-8", true],
	["application/json", true],
	["image/png", false],
	["application/octet-stream", false],
	[undefined, false]
]

/** Where the body goes: stdout, `--output -`, or a file that is fresh, already there, made while the body streams, or in a missing directory. */
export type Destination =
	| Readonly<{ kind: "stdout" }>
	| Readonly<{ kind: "dash" }>
	| Readonly<{
			kind: "file"
			target: "fresh" | "existing" | "made while streaming" | "in a missing directory"
			force: boolean
	  }>

/** A drawn write: the body's media type, the destination, a terminal or not, a stdout fault, and whether the body fails. */
export type Sinking = Readonly<{
	media: readonly [string | undefined, boolean]
	destination: Destination
	terminal: boolean
	fault: "none" | "EPIPE" | "disk full"
	bodyFails: boolean
}>

const destination: Gen<Destination> = weighted<Destination>([
	[2, constant<Destination>({ kind: "stdout" })],
	[1, constant<Destination>({ kind: "dash" })],
	[
		3,
		(s): Destination => ({
			kind: "file",
			target: s.draw(
				element<"fresh" | "existing" | "made while streaming" | "in a missing directory">([
					"fresh",
					"existing",
					"made while streaming",
					"in a missing directory"
				])
			),
			force: s.draw(element([false, true]))
		})
	]
])

const sinkings: Gen<Sinking> = (s) => ({
	media: s.draw(element(MEDIA)),
	destination: s.draw(destination),
	terminal: s.draw(element([false, true])),
	fault: s.draw(
		weighted<Sinking["fault"]>([
			[4, constant("none")],
			[1, constant("EPIPE")],
			[1, constant("disk full")]
		])
	),
	bodyFails: s.draw(
		weighted([
			[5, constant(false)],
			[1, constant(true)]
		])
	)
})

/** The body's three chunks. */
const CHUNKS: ReadonlyArray<string> = ["a-chunk;", "b-chunk;", "c-chunk;"]

const encoder = new TextEncoder()

/** What a write left: how it ended, stdout, whether any chunk was pulled, the target's content and the directory's names. */
export type Sunk = Readonly<{
	ended: string
	stdout: string
	pulled: boolean
	target: Option.Option<string>
	names: ReadonlyArray<string>
}>

const fault = (kind: "EPIPE" | "disk full") =>
	PlatformError.systemError({
		_tag: "Unknown",
		cause: Object.assign(new Error(kind === "EPIPE" ? "write EPIPE" : "write ENOSPC"), {
			code: kind === "EPIPE" ? "EPIPE" : "ENOSPC"
		}),
		method: "stdout",
		module: "Stdio"
	})

/** Writes the drawn body with writeBody under the drawn settings, in the case's own directory. */
export const sunkIn = (dir: ScratchDir, sinking: Sinking) =>
	Effect.scoped(
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const path = yield* Path.Path
			const target = path.join(dir, "out.bin")
			const out: Array<string> = []
			const decoder = new TextDecoder()
			let pulled = 0
			if (sinking.destination.kind === "file" && sinking.destination.target === "existing") {
				yield* fs.writeFileString(target, "keep")
			}
			const racing =
				sinking.destination.kind === "file" && sinking.destination.target === "made while streaming"
			const chunks = Stream.fromIterable(CHUNKS).pipe(
				Stream.mapEffect((chunk) =>
					Effect.gen(function* () {
						pulled += 1
						if (racing && pulled === 2) {
							yield* Effect.orDie(fs.writeFileString(target, "racer"))
						}
						return encoder.encode(chunk)
					})
				)
			)
			const bytes = sinking.bodyFails
				? Stream.concat(Stream.take(chunks, 1), Stream.fail("boom" as const))
				: chunks
			const stdout = () =>
				Sink.forEachArray((written: ReadonlyArray<string | Uint8Array>) =>
					sinking.fault === "none"
						? Effect.sync(() => {
								for (const chunk of written) {
									out.push(typeof chunk === "string" ? chunk : decoder.decode(chunk))
								}
							})
						: Effect.fail(fault(sinking.fault))
				)
			const output = ((): Option.Option<string> => {
				switch (sinking.destination.kind) {
					case "stdout":
						return Option.none()
					case "dash":
						return Option.some("-")
					case "file":
						return Option.some(
							sinking.destination.target === "in a missing directory"
								? path.join(dir, "missing", "out.bin")
								: target
						)
				}
			})()
			const context = yield* Layer.build(
				Layer.mergeAll(
					Stdio.layerTest({ stdout, stdoutIsTerminal: Effect.succeed(sinking.terminal) }),
					Layer.succeed(OutputPath, output),
					Layer.succeed(Force, sinking.destination.kind === "file" && sinking.destination.force)
				)
			)
			const exit = yield* Effect.exit(
				writeBody({ bytes, mediaType: sinking.media[0] }).pipe(Effect.provideContext(context))
			)
			const exists = yield* Effect.orDie(fs.exists(target))
			const content = exists ? yield* Effect.orDie(fs.readFileString(target)) : ""
			const names = yield* Effect.orDie(fs.readDirectory(dir))
			const sunk: Sunk = {
				ended: Exit.match(exit, {
					onSuccess: () => "written",
					onFailure: (cause) =>
						Option.match(Cause.findErrorOption(cause), {
							onNone: () => "a defect",
							onSome: (error) =>
								typeof error === "string"
									? error
									: error._tag === "OutputError"
										? `OutputError ${error.reason}`
										: error._tag
						})
				}),
				stdout: Arr.join(out, ""),
				pulled: pulled > 0,
				target: exists ? Option.some(content) : Option.none(),
				names: Arr.sort(names, Order.String)
			}
			return sunk
		})
	)

const whole = Arr.join(CHUNKS, "")

/**
 * What design 4.6 and 13.1 say a write leaves. To stdout: a binary body at a terminal is refused before any chunk is
 * read; a reader that went away (EPIPE) ends the write as a success; another write failure is OutputError write; a body
 * that fails ends the write with its failure. `--output -` is stdout without the terminal guard. To a file: through a
 * temp sibling renamed into place, so the directory then holds the target alone; an existing target is refused (exists)
 * before any chunk is read and left untouched, unless `--force`, which replaces it; one made while the body streams is
 * refused at the rename and left as it was made, unless `--force`; a missing directory is OutputError write; a failing
 * body leaves neither the target nor a temp file.
 */
export const expectedOf = (sinking: Sinking): Sunk => {
	const nothing: Omit<Sunk, "ended"> = {
		stdout: "",
		pulled: false,
		target: Option.none(),
		names: []
	}
	const dest = sinking.destination
	if (dest.kind === "file") {
		if (dest.target === "in a missing directory") {
			return { ...nothing, ended: "OutputError write" }
		}
		if (dest.target === "existing" && !dest.force) {
			return {
				...nothing,
				ended: "OutputError exists",
				target: Option.some("keep"),
				names: ["out.bin"]
			}
		}
		if (sinking.bodyFails) {
			return {
				...nothing,
				ended: "boom",
				pulled: true,
				target: dest.target === "existing" ? Option.some("keep") : Option.none(),
				names: dest.target === "existing" ? ["out.bin"] : []
			}
		}
		if (dest.target === "made while streaming" && !dest.force) {
			return {
				...nothing,
				ended: "OutputError exists",
				pulled: true,
				target: Option.some("racer"),
				names: ["out.bin"]
			}
		}
		return {
			...nothing,
			ended: "written",
			pulled: true,
			target: Option.some(whole),
			names: ["out.bin"]
		}
	}
	const [, text] = sinking.media
	if (dest.kind === "stdout" && !text && sinking.terminal) {
		return { ...nothing, ended: "UsageError" }
	}
	switch (sinking.fault) {
		case "EPIPE":
			return { ...nothing, ended: "written", pulled: true }
		case "disk full":
			return { ...nothing, ended: "OutputError write", pulled: true }
		case "none":
			return sinking.bodyFails
				? { ...nothing, ended: "boom", pulled: true, stdout: Arr.getUnsafe(CHUNKS, 0) }
				: { ...nothing, ended: "written", pulled: true, stdout: whole }
	}
}

export type SinkFeature =
	| "text to a terminal"
	| "binary refused at a terminal"
	| "--output - with binary at a terminal"
	| "a reader gone away"
	| "a stdout write failure"
	| "a failing body"
	| "a fresh file"
	| "an existing file refused"
	| "an existing file forced"
	| "a file made while streaming"
	| "a missing directory"

export const sinkFeatures = (sinking: Sinking): ReadonlyArray<SinkFeature> => {
	const dest = sinking.destination
	const [, text] = sinking.media
	const when = (holds: boolean, feature: SinkFeature): ReadonlyArray<SinkFeature> =>
		holds ? [feature] : []
	const toStdout = dest.kind !== "file"
	return [
		...when(toStdout && text && sinking.terminal && sinking.fault === "none", "text to a terminal"),
		...when(dest.kind === "stdout" && !text && sinking.terminal, "binary refused at a terminal"),
		...when(
			dest.kind === "dash" && !text && sinking.terminal,
			"--output - with binary at a terminal"
		),
		...when(
			toStdout &&
				sinking.fault === "EPIPE" &&
				!(dest.kind === "stdout" && !text && sinking.terminal),
			"a reader gone away"
		),
		...when(
			toStdout &&
				sinking.fault === "disk full" &&
				!(dest.kind === "stdout" && !text && sinking.terminal),
			"a stdout write failure"
		),
		...when(
			sinking.bodyFails &&
				sinking.fault === "none" &&
				!(dest.kind === "file" && dest.target === "in a missing directory"),
			"a failing body"
		),
		...when(dest.kind === "file" && dest.target === "fresh", "a fresh file"),
		...when(
			dest.kind === "file" && dest.target === "existing" && !dest.force,
			"an existing file refused"
		),
		...when(
			dest.kind === "file" && dest.target === "existing" && dest.force,
			"an existing file forced"
		),
		...when(
			dest.kind === "file" && dest.target === "made while streaming",
			"a file made while streaming"
		),
		...when(dest.kind === "file" && dest.target === "in a missing directory", "a missing directory")
	]
}

const forced = (overrides: Partial<Sinking>): Gen<Sinking> =>
	map(sinkings, (drawn): Sinking => ({ ...drawn, ...overrides }))

const file = (
	target: "fresh" | "existing" | "made while streaming" | "in a missing directory",
	force: boolean
): Destination => ({
	kind: "file",
	target,
	force
})

/** Writes, aimed at each pending situation by one built to reach it. */
export const aimedSinkings: Aimed<Sinking, SinkFeature> = aimed(sinkings, [
	[
		"text to a terminal",
		forced({
			media: ["application/json", true],
			destination: { kind: "stdout" },
			terminal: true,
			fault: "none"
		})
	],
	[
		"binary refused at a terminal",
		forced({ media: ["image/png", false], destination: { kind: "stdout" }, terminal: true })
	],
	[
		"--output - with binary at a terminal",
		forced({ media: ["image/png", false], destination: { kind: "dash" }, terminal: true })
	],
	[
		"a reader gone away",
		forced({ media: ["application/json", true], destination: { kind: "stdout" }, fault: "EPIPE" })
	],
	[
		"a stdout write failure",
		forced({
			media: ["application/json", true],
			destination: { kind: "stdout" },
			fault: "disk full"
		})
	],
	["a failing body", forced({ destination: file("fresh", false), fault: "none", bodyFails: true })],
	["a fresh file", forced({ destination: file("fresh", false), bodyFails: false })],
	["an existing file refused", forced({ destination: file("existing", false) })],
	["an existing file forced", forced({ destination: file("existing", true), bodyFails: false })],
	[
		"a file made while streaming",
		forced({ destination: file("made while streaming", false), bodyFails: false })
	],
	["a missing directory", forced({ destination: file("in a missing directory", false) })]
])
