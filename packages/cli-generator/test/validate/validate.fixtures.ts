/**
 * What the properties of validate.test.ts read: documents built per line with planted faults and the verdict the
 * line's official schema gives them, documents built around a drawn `openapi` member and the line or the DOC-02
 * refusal it gets, the vendored schemas read intact, altered or unreadable, and the generator's own command line run
 * where it can reach no network.
 */

import { jsonText } from "@bjornpagen/grizzle-text/utf8"
import type { CheckoutDir } from "@bjornpagen/testing/checkout"
import { word } from "@bjornpagen/testing/dictionary"
import {
	characterOf,
	constant,
	element,
	type FiniteSpace,
	finite,
	int,
	map,
	oneOf,
	option,
	type Space,
	string,
	unicodeScalar,
	weighted
} from "@bjornpagen/testing/gen"
import {
	Array as Arr,
	Effect,
	FileSystem,
	Option,
	Path,
	PlatformError,
	Record,
	Stream,
	String as Str
} from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { fixedDocumentUri } from "#model/brands.ts"
import { foldJson } from "#model/json-tree.ts"
import type { Json } from "#model/pointer.ts"
import { patchVersion, type SpecLine } from "#model/spec-section.ts"
import { specLines } from "#test/model/spec-section.dictionary.ts"
import {
	type Location,
	locations,
	type SchemaType,
	schemaTypes,
	UNLISTED_LOCATIONS,
	UNLISTED_TYPES
} from "#test/validate/validate.dictionary.ts"
import type { ReadSchema } from "#validate/index.ts"
import { manifest } from "#validate/schemas/manifest.ts"

/**
 * The dated official schema each line validates against (design 3.2): `schema-base` for 3.1 and 3.2, whose plain
 * schema validates no Schema Object.
 */
const DATED_SCHEMA: Readonly<Record<SpecLine, string>> = {
	"3.0": "https://spec.openapis.org/oas/3.0/schema/2024-10-18",
	"3.1": "https://spec.openapis.org/oas/3.1/schema-base/2026-08-03",
	"3.2": "https://spec.openapis.org/oas/3.2/schema-base/2026-08-30"
}

const isUnlistedLocation = (location: Location): boolean =>
	Arr.some(UNLISTED_LOCATIONS, (unlisted) => unlisted === location)

const isUnlistedType = (type: SchemaType): boolean =>
	Arr.some(UNLISTED_TYPES, (unlisted) => unlisted === type)

/** One document of a line: its operation's parameter location and its component schema's type. */
export type LineCase = Readonly<{ line: SpecLine; location: Location; type: SchemaType }>

/** Every line, with every listed and unlisted parameter location and schema type. */
export const lineSpace: FiniteSpace<LineCase> = finite((source) => ({
	line: source.draw(word(specLines)),
	location: source.draw(word(locations)),
	type: source.draw(word(schemaTypes))
}))

/** Every line's valid document: its parameter in the query, its schema an object. */
export const offlineSpace: FiniteSpace<LineCase> = finite((source) => ({
	line: source.draw(word(specLines)),
	location: "query",
	type: "object"
}))

export type LineFeature =
	| `line ${SpecLine}`
	| "a valid document"
	| "a parameter location no line lists"
	| "a schema type no dialect lists"
	| "both faults planted"

const locationPointer = "/paths/~1things/get/parameters/0/in"

const typePointer = "/components/schemas/Thing/type"

/** The pointers of the faults a case plants: its location where no line lists it, its type where no dialect does. */
export const plantedPointers = (drawn: LineCase): ReadonlyArray<string> => [
	...(isUnlistedLocation(drawn.location) ? [locationPointer] : []),
	...(isUnlistedType(drawn.type) ? [typePointer] : [])
]

export const lineFeaturesOf = (drawn: LineCase): ReadonlyArray<LineFeature> => [
	`line ${drawn.line}`,
	...(isUnlistedLocation(drawn.location) ? ["a parameter location no line lists" as const] : []),
	...(isUnlistedType(drawn.type) ? ["a schema type no dialect lists" as const] : []),
	...(Arr.isReadonlyArrayEmpty(plantedPointers(drawn)) ? ["a valid document" as const] : []),
	...(plantedPointers(drawn).length === 2 ? ["both faults planted" as const] : [])
]

/** A copy of a JSON value with every array and object in it frozen, so a write anywhere into it throws. */
const frozenCopy = (value: Json): Json =>
	foldJson<Json>(
		value,
		{
			array: (items) => Object.freeze(items),
			leaf: (leaf) => leaf,
			object: (members) =>
				Object.freeze(
					Record.fromEntries(Arr.map(members, (member) => [member.key, member.folded] as const))
				)
		},
		[]
	)

/**
 * A case's document, deep-frozen: one operation with one parameter at the drawn location, answering a component schema
 * of the drawn type.
 */
export const lineDocument = (drawn: LineCase): Json =>
	frozenCopy({
		openapi: `${drawn.line}.0`,
		info: { title: "Fixture", version: "1" },
		paths: {
			"/things": {
				get: {
					parameters: [{ name: "limit", in: drawn.location, schema: { type: "integer" } }],
					responses: {
						"200": {
							description: "ok",
							content: {
								"application/json": { schema: { $ref: "#/components/schemas/Thing" } }
							}
						}
					}
				}
			}
		},
		components: {
			schemas: { Thing: { type: drawn.type, properties: { id: { type: "string" } } } }
		}
	})

export const datedSchemaOf = (line: SpecLine): string => DATED_SCHEMA[line]

/** An instance location of the validator's output: the fragment of a JSON Pointer into the document. */
export const instanceLocationOf = (pointer: string): string => `#${pointer}`

/** Whether `ancestor` is `pointer` or a node above it. */
export const isAtOrAbove = (ancestor: string, pointer: string): boolean =>
	ancestor === pointer || Str.startsWith(`${ancestor}/`)(pointer)

/**
 * A version string, as its parts write it: a prefix, a major, a minor, a patch after a dot or none, and a suffix. Each
 * part is drawn from the values that sit on an edge of the version grammar.
 */
export type VersionParts = Readonly<{
	prefix: "" | "v" | " "
	major: "3" | "2" | "4" | "03"
	minor: "0" | "1" | "2" | "3" | "10" | "01"
	patch: Option.Option<"0" | "1" | "12" | "" | "x">
	suffix: "" | "-rc1" | " " | "\n" | "x"
}>

/** The `openapi` member a document declares: none, a value that is no string, or a version string. */
export type Declared =
	| Readonly<{ kind: "absent"; other: Readonly<Record<string, Json>> }>
	| Readonly<{ kind: "not a string"; value: Json }>
	| Readonly<{ kind: "version"; parts: VersionParts }>
	| Readonly<{ kind: "text"; text: string }>

const versionParts: Space<VersionParts> = (source) => ({
	prefix: source.draw(element(["", "v", " "] as const)),
	major: source.draw(element(["3", "2", "4", "03"] as const)),
	minor: source.draw(element(["0", "1", "2", "3", "10", "01"] as const)),
	patch: source.draw(option(element(["0", "1", "12", "", "x"] as const))),
	suffix: source.draw(element(["", "-rc1", " ", "\n", "x"] as const))
})

/**
 * A declaration: mostly a version string by its parts, now and then none, a value that is no string, or a text that
 * begins with no version at all.
 */
export const declaredSpace: Space<Declared> = weighted([
	[
		1,
		map(element([{}, { swagger: "2.0" }] as const), (other): Declared => ({
			kind: "absent",
			other
		}))
	],
	[
		1,
		map(
			element([3.1, null, true, ["3.1.0"], { version: "3.1.0" }] as const),
			(value): Declared => ({ kind: "not a string", value })
		)
	],
	[6, map(versionParts, (parts): Declared => ({ kind: "version", parts }))],
	[
		1,
		map(
			string(oneOf([unicodeScalar, characterOf(["3", ".", "0", "1", "2"])]), { min: 0, max: 8 }),
			(text): Declared => ({ kind: "text", text: `x${text}` })
		)
	]
])

const textOf = (parts: VersionParts): string =>
	`${parts.prefix}${parts.major}.${parts.minor}${Option.match(parts.patch, {
		onNone: () => "",
		onSome: (patch) => `.${patch}`
	})}${parts.suffix}`

/** The document a declaration makes: the declared member, or the other members of a document that declares none. */
export const declaredDocument = (declared: Declared): Json => {
	switch (declared.kind) {
		case "absent":
			return declared.other
		case "not a string":
			return { openapi: declared.value }
		case "version":
			return { openapi: textOf(declared.parts) }
		case "text":
			return { openapi: declared.text }
	}
}

/** The line each minor names after a major 3: one digit, 0, 1 or 2, and no other. */
const lineOfMinor: Readonly<Record<VersionParts["minor"], Option.Option<SpecLine>>> = {
	"0": Option.some("3.0"),
	"1": Option.some("3.1"),
	"2": Option.some("3.2"),
	"3": Option.none(),
	"10": Option.none(),
	"01": Option.none()
}

/**
 * The line a version's text begins with, by its parts (design 3.2): no prefix, major 3, and a minor of one digit, 0, 1
 * or 2, which nothing but a dot, the suffix or the end follows. A suffix never begins with a digit.
 */
const knownLineOf = (parts: VersionParts): Option.Option<SpecLine> =>
	parts.prefix === "" && parts.major === "3" ? lineOfMinor[parts.minor] : Option.none()

/** Whether a version's patch is the digits the grammar asks for, with nothing after them. */
const hasPatchDigits = (parts: VersionParts): boolean =>
	Option.exists(parts.patch, (patch) => patch === "0" || patch === "1" || patch === "12") &&
	parts.suffix === ""

/**
 * What a declaration gets (design 3.2, 8.1 DOC-02): the line it selects, or the refusal it is, its `openapi` the
 * value it declared, or the latest release's for a document that declares none, citing the release of the line its
 * text begins with, or the latest release where it begins with none.
 */
export type Verdict =
	| Readonly<{ kind: "selected"; line: SpecLine }>
	| Readonly<{
			kind: "refused"
			declared: Option.Option<string>
			code: "DOC-02/missing-version" | "DOC-02/unsupported-version"
			message: string
			openapi: string
			specSection: string
	  }>

const declare = "Declare a 3.0.x, 3.1.x or 3.2.x version."

const versionSection = (line: SpecLine): string =>
	`https://spec.openapis.org/oas/v${patchVersion[line]}.html#oas-version`

const missing: Verdict = {
	kind: "refused",
	declared: Option.none(),
	code: "DOC-02/missing-version",
	message: `The document declares no openapi version. ${declare}`,
	openapi: patchVersion["3.2"],
	specSection: versionSection("3.2")
}

const unsupported = (text: string, line: Option.Option<SpecLine>): Verdict => ({
	kind: "refused",
	declared: Option.some(text),
	code: "DOC-02/unsupported-version",
	message: `The openapi version ${jsonText(text)} is not supported. ${declare}`,
	openapi: text,
	specSection: versionSection(Option.getOrElse(line, (): SpecLine => "3.2"))
})

export const verdictOf = (declared: Declared): Verdict => {
	switch (declared.kind) {
		case "absent":
		case "not a string":
			return missing
		case "text":
			return unsupported(declared.text, Option.none())
		case "version": {
			const line = knownLineOf(declared.parts)
			return Option.isSome(line) && hasPatchDigits(declared.parts)
				? { kind: "selected", line: line.value }
				: unsupported(textOf(declared.parts), line)
		}
	}
}

export type VersionFeature =
	| "absent"
	| "not a string"
	| "a supported version"
	| "a known line refused"
	| "an unknown line"

export const versionFeaturesOf = (declared: Declared): ReadonlyArray<VersionFeature> => {
	switch (declared.kind) {
		case "absent":
		case "not a string":
			return [declared.kind]
		case "text":
			return ["an unknown line"]
		case "version": {
			const verdict = verdictOf(declared)
			if (verdict.kind === "selected") {
				return ["a supported version"]
			}
			return Option.isSome(knownLineOf(declared.parts))
				? ["a known line refused"]
				: ["an unknown line"]
		}
	}
}

/** One read of the vendored schemas: every file intact, or one of them altered by a byte or unreadable. */
export type ManifestCase =
	| Readonly<{ kind: "intact" }>
	| Readonly<{ kind: "altered" | "unreadable"; file: string }>

const manifestFile = map(
	int(0, manifest.length - 1),
	(index) => Arr.getUnsafe(manifest, index).file
)

/** The intact read, and each file altered and unreadable. */
export const manifestSpace: FiniteSpace<ManifestCase> = finite(
	oneOf([
		constant<ManifestCase>({ kind: "intact" }),
		map(manifestFile, (file): ManifestCase => ({ kind: "altered", file })),
		map(manifestFile, (file): ManifestCase => ({ kind: "unreadable", file }))
	])
)

export type ManifestFeature = "intact" | "altered" | "unreadable"

/** The failure an unreadable file's read fails with, which the manifest's refusal must keep as its cause. */
export const unreadableFailure = new PlatformError.BadArgument({
	module: "FileSystem",
	method: "readFile"
})

/** The bytes of a vendored schema, from the validator's own schemas directory. */
const vendoredBytes: ReadSchema = Effect.fnUntraced(function* vendoredBytes(file: string) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const target = yield* path.fromFileUrl(
		new URL(`../../src/validate/schemas/${file}`, import.meta.url)
	)

	return yield* fs.readFile(target)
})

const space = 0x20

/** The reader a case hands the manifest check: the vendored bytes, but its one file altered by a byte or unreadable. */
export const readerOf =
	(drawn: ManifestCase): ReadSchema =>
	(file) => {
		if (drawn.kind === "intact" || file !== drawn.file) {
			return vendoredBytes(file)
		}
		return drawn.kind === "altered"
			? Effect.map(vendoredBytes(file), (bytes) =>
					Uint8Array.from(Arr.append(Arr.fromIterable(bytes), space))
				)
			: Effect.fail(unreadableFailure)
	}

/** Every vendored schema's bytes, in the manifest's order. */
export const allVendoredBytes = Effect.forEach(manifest, (entry) => vendoredBytes(entry.file))

/** What a run of the generator's command line did: its exit code, and its stdout and stderr text. */
export type CommandRun = Readonly<{ exitCode: number; stdout: string; stderr: string }>

/**
 * Runs the generator's own `validate` command, from the checkout a mutant reaches on disk, on a document written to
 * `dir`, under Node's permission model with file
 * reads alone allowed: the process can open no socket, so a validation that reached for the network fails.
 */
export const validateOffline = (
	checkout: CheckoutDir,
	dir: string,
	document: Json
): Effect.Effect<
	CommandRun,
	PlatformError.PlatformError | PlatformError.BadArgument,
	FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> =>
	Effect.scoped(
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const path = yield* Path.Path
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
			const bin = path.join(checkout, "src", "bin.ts")
			const spec = path.join(dir, "openapi.json")
			yield* fs.writeFileString(spec, jsonText(document))
			const handle = yield* spawner.spawn(
				ChildProcess.make(
					process.execPath,
					["--permission", "--allow-fs-read=*", bin, "validate", spec],
					{ stdin: "ignore" }
				)
			)
			const [stdout, stderr, exitCode] = yield* Effect.all(
				[
					Stream.mkString(Stream.decodeText(handle.stdout)),
					Stream.mkString(Stream.decodeText(handle.stderr)),
					handle.exitCode
				],
				{ concurrency: "unbounded" }
			)
			const run: CommandRun = { exitCode, stderr, stdout }
			return run
		})
	)

/** The document a refusal names. */
export const specUri = fixedDocumentUri("file:///spec/openapi.json")
