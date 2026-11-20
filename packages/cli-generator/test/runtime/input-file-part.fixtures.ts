/**
 * What the property of input-file-part.test.ts reads: file parts as an operator names them (a regular file, stdin,
 * a path that is missing, a directory, an unreadable file, each named after a secret the operator passed by
 * mistake), laid out in a case's own directory, and what reading them must give.
 */

import {
	aimed,
	array,
	constant,
	element,
	type Gen,
	int,
	map,
	weighted
} from "@bjornpagen/testing/gen"
import { regex } from "arkregex"
import { Array as Arr, Effect, FileSystem, Option, Path, String as Str } from "effect"
import type { ErrorFormat } from "#runtime-src/runtime/output.ts"
import { holding } from "#test/runtime/serialize.fixtures.ts"

/** What a part's path names: a regular file, stdin, nothing, a directory, or a file no one may read. */
export type Given = "regular" | "stdin" | "missing" | "directory" | "unreadable"

/** One file part flag as drawn: its flag, what its path names, and the bytes a regular file or stdin holds. */
export type FilePart = Readonly<{ flag: string; given: Given; bytes: Uint8Array }>

/** A run reading file parts in order, as drawn: its parts, its error format, and the secret every path is named after. */
export type FileCase = Readonly<{
	parts: ReadonlyArray<FilePart>
	format: ErrorFormat
	secret: string
}>

/** Bytes a file or stdin holds. */
const bytes: Gen<Uint8Array> = map(array(int(0, 255), { min: 0, max: 6 }), (drawn) =>
	Uint8Array.from(drawn)
)

/** A run as drawn: one or two parts under distinct flags, most often readable, its format, its secret. */
const fileDrawn: Gen<FileCase> = (source) => ({
	parts: Arr.map(
		Arr.dedupe(array(element(["secret", "note", "file"]), { min: 1, max: 2 })(source)),
		(flag) => ({
			flag,
			given: weighted<Given>([
				[2, constant("regular")],
				[2, constant("stdin")],
				[1, constant("missing")],
				[1, constant("directory")],
				[1, constant("unreadable")]
			])(source),
			bytes: bytes(source)
		})
	),
	format: element<ErrorFormat>(["text", "json"])(source),
	secret: element(["hunter2-PWMH", "s3cr3t value"])(source)
})

/** The path a part names inside the case's directory, `-` for stdin, every other after the secret. */
export const pathOf = (path: Path.Path, dir: string, part: FilePart, secret: string): string =>
	part.given === "stdin" ? "-" : path.join(dir, `${secret}-${part.flag}-${part.given}`)

/** Lays out what a part's path names: a regular file holding its bytes, a directory, a file no one may read. */
export const laidOut = (fs: FileSystem.FileSystem, path: string, part: FilePart) => {
	switch (part.given) {
		case "regular":
			return fs.writeFile(path, part.bytes)
		case "directory":
			return fs.makeDirectory(path)
		case "unreadable":
			return Effect.andThen(fs.writeFile(path, part.bytes), fs.chmod(path, 0o000))
		case "stdin":
		case "missing":
			return Effect.void
	}
}

/** What reading a run's parts gives: every part's bytes, or the first refusal's flag. */
export type Reading =
	| Readonly<{ kind: "read"; bytes: ReadonlyArray<string> }>
	| Readonly<{ kind: "refused"; flag: string }>

/**
 * A run's reading (design 4.5, C1, m3-pwmh): parts in order, a regular file its bytes, the first stdin part stdin's
 * bytes and a second one refused naming its own flag; a missing path, a directory and an unreadable file refused
 * naming the part's flag.
 */
export const readingModel = (run: FileCase, stdin: Uint8Array): Reading => {
	const read: Array<string> = []
	let claimed = false
	for (const part of run.parts) {
		switch (part.given) {
			case "regular":
				read.push(Buffer.from(part.bytes).toString("latin1"))
				break
			case "stdin":
				if (claimed) {
					return { kind: "refused", flag: part.flag }
				}
				claimed = true
				read.push(Buffer.from(stdin).toString("latin1"))
				break
			case "missing":
			case "directory":
			case "unreadable":
				return { kind: "refused", flag: part.flag }
		}
	}
	return { kind: "read", bytes: read }
}

const separator = regex("[/\\\\]", "u")

/** The name a file part's Content-Disposition carries (design 6.3): its part's name for stdin, else the path's last segment, the part's name when that is empty. */
export const filenameModel = (path: string, part: string): string =>
	path === "-"
		? part
		: Option.getOrElse(
				Option.filter(Arr.last(Str.split(separator)(path)), Str.isNonEmpty),
				() => part
			)

/** The situations a run reaches. */
export type FileFeature =
	| "regular file read"
	| "stdin read"
	| "second stdin claimant refused"
	| "missing file refused"
	| "directory refused"
	| "unreadable file refused"
	| "refusal in json"

/** What a run reaches. */
export const fileFeatures = (run: FileCase, stdin: Uint8Array): ReadonlyArray<FileFeature> => {
	const reading = readingModel(run, stdin)
	const refusedBy = Option.flatMap(
		reading.kind === "refused" ? Option.some(reading.flag) : Option.none(),
		(flag) => Arr.findFirst(run.parts, (part) => part.flag === flag)
	)
	return holding<FileFeature>([
		[
			"regular file read",
			reading.kind === "read" && Arr.some(run.parts, (part) => part.given === "regular")
		],
		[
			"stdin read",
			reading.kind === "read" && Arr.some(run.parts, (part) => part.given === "stdin")
		],
		["second stdin claimant refused", Option.exists(refusedBy, (part) => part.given === "stdin")],
		["missing file refused", Option.exists(refusedBy, (part) => part.given === "missing")],
		["directory refused", Option.exists(refusedBy, (part) => part.given === "directory")],
		["unreadable file refused", Option.exists(refusedBy, (part) => part.given === "unreadable")],
		["refusal in json", reading.kind === "refused" && run.format === "json"]
	])
}

/** Bytes stdin holds in every run. */
export const STDIN = new TextEncoder().encode("from stdin")

/** A run whose one part's path names `given`, in either format. */
const refusedBy =
	(given: Given): Gen<FileCase> =>
	(source) => ({ ...fileDrawn(source), parts: [{ flag: "secret", given, bytes: bytes(source) }] })

/** A run aimed at each refusal: a missing path, a directory, an unreadable file, and stdin claimed twice. */
export const fileSpace = aimed<FileCase, FileFeature>(fileDrawn, [
	["missing file refused", refusedBy("missing")],
	["directory refused", refusedBy("directory")],
	["unreadable file refused", refusedBy("unreadable")],
	[
		"second stdin claimant refused",
		(source) => ({
			...fileDrawn(source),
			parts: [
				{ flag: "file", given: "stdin", bytes: bytes(source) },
				{ flag: "note", given: "stdin", bytes: bytes(source) }
			]
		})
	]
])
