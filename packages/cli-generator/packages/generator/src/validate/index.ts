import { validate as validate04 } from "@hyperjump/json-schema/draft-04"
import { registerSchema, setShouldValidateFormat } from "@hyperjump/json-schema/draft-2020-12"
import type { SchemaObject } from "@hyperjump/json-schema/draft-2020-12"
import { validate as validate31 } from "@hyperjump/json-schema/openapi-3-1"
import { validate as validate32 } from "@hyperjump/json-schema/openapi-3-2"
import {
	Array as Arr,
	Effect,
	FileSystem,
	Option,
	Path,
	Record,
	Schema,
	String as Str
} from "effect"
import type { PlatformError } from "effect"
import type { Digest } from "effect/crypto"
import type { DocumentUri } from "#model/brands.ts"
import type { Diagnostic } from "#model/diagnostic.ts"
import { sha256Hex } from "#model/digest.ts"
import type { Json } from "#model/pointer.ts"
import { declaredOpenapi } from "#model/spec-section.ts"
import type { SpecLine } from "#model/spec-section.ts"
import { rewriteDialect, validatorCopy } from "#validate/dialect.ts"
import type { ValidatorInput } from "#validate/dialect.ts"
import {
	matchDisagreement,
	noticeFor,
	refusalFor,
	knownDisagreements
} from "#validate/disagreements.ts"
import type { Disagreement, Refusal } from "#validate/disagreements.ts"
import { lineOf, schemaUri } from "#validate/dispatch.ts"
import type { UnsupportedOpenApiVersion } from "#validate/dispatch.ts"
import { groupErrors } from "#validate/locations.ts"
import type { ErrorGroup, InvalidInstanceLocation } from "#validate/locations.ts"
import { manifest } from "#validate/schemas/manifest.ts"
import { surrogateRefusal, surrogateSites } from "#validate/surrogates.ts"

/**
 * A vendored schema file cannot be read or differs from the manifest.
 */
export class SchemaManifestError extends Schema.TaggedError<
	SchemaManifestError,
	{ readonly brand: unique symbol }
>()("SchemaManifestError", {
	cause: Schema.optionalKey(Schema.Defect()),
	file: Schema.String,
	reason: Schema.Literals(["unreadable", "sha256-mismatch"])
}) {}

/**
 * The validator library failed to register, compile or run a schema.
 */
export class ValidatorError extends Schema.TaggedError<
	ValidatorError,
	{ readonly brand: unique symbol }
>()("ValidatorError", {
	cause: Schema.Defect()
}) {}

/**
 * One BASIC output error unit. `instanceLocation` is a URI fragment, not yet decoded (m1-va2).
 */
export interface ValidationUnit {
	readonly absoluteKeywordLocation: string
	readonly instanceLocation: string
	readonly keyword: string
}

/**
 * The verdict of the official schema for the line the document declares.
 */
export interface ValidationResult {
	readonly errors: readonly ValidationUnit[]
	readonly line: SpecLine
	readonly schema: string
	readonly valid: boolean
}

/**
 * Reads the bytes of one vendored file.
 */
export type ReadSchema = (
	file: string
) => Effect.Effect<
	Uint8Array,
	PlatformError.PlatformError | PlatformError.BadArgument,
	FileSystem.FileSystem | Path.Path
>

const readVendored: ReadSchema = Effect.fnUntraced(function* readVendored(file: string) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const target = yield* path.fromFileUrl(new URL(`schemas/${file}`, import.meta.url))

	return yield* fs.readFile(target)
})

/**
 * Reads every vendored file and checks its sha256 against the manifest, in registration order.
 * Returns the verified bytes in manifest order.
 */
export const checkManifest = (
	read: ReadSchema
): Effect.Effect<
	readonly Uint8Array[],
	SchemaManifestError,
	FileSystem.FileSystem | Path.Path | Digest.Digest
> =>
	Effect.forEach(manifest, (entry) =>
		read(entry.file).pipe(
			Effect.mapError((cause) =>
				SchemaManifestError.make({ cause, file: entry.file, reason: "unreadable" })
			),
			Effect.flatMap((bytes) =>
				sha256Hex(bytes).pipe(
					Effect.flatMap((hex) =>
						hex === entry.sha256
							? Effect.succeed(bytes)
							: Effect.fail(
									SchemaManifestError.make({ file: entry.file, reason: "sha256-mismatch" })
								)
					)
				)
			)
		)
	)

/**
 * Decodes the text of a vendored schema: every one is a JSON object.
 */
const decodeSchemaText = Schema.decodeUnknownEffect(
	Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json))
)

const textDecoder = new TextDecoder()

/**
 * A decoded schema object as the validator library's own mutable schema type.
 */
const schemaObjectOf = (members: Readonly<Record<string, Json>>): SchemaObject =>
	Record.map(members, validatorCopy)

/**
 * Registers every vendored schema with the validator library, format assertion off. Registration
 * is the library's global state, so `registered` runs it once per process.
 */
const register = checkManifest(readVendored).pipe(
	Effect.flatMap((files) =>
		Effect.forEach(files, (bytes) =>
			decodeSchemaText(textDecoder.decode(bytes)).pipe(
				Effect.mapBoth({
					onFailure: (cause) => ValidatorError.make({ cause }),
					onSuccess: schemaObjectOf
				})
			)
		)
	),
	Effect.flatMap((schemas) =>
		Effect.try({
			catch: (cause) => ValidatorError.make({ cause }),
			try: () => {
				setShouldValidateFormat(false)
				Arr.forEach(schemas, (schema) => registerSchema(schema))
			}
		})
	)
)

const registered = Effect.runSync(Effect.cached(register))

/**
 * Each line compiles through the module that registers its dialect: draft-04 for the 3.0 schema,
 * and the OAS base vocabularies the vendored 3.1 and 3.2 meta-schemas require (design 3.2).
 */
const compilerOf: Readonly<Record<SpecLine, typeof validate32>> = {
	"3.0": validate04,
	"3.1": validate31,
	"3.2": validate32
}

/**
 * Validates the validator's own copy of a document against the official schema of its `openapi`
 * line: BASIC output, format assertion off, no result cache. The only Promise boundary is the
 * compile (R7).
 */
const validateCopy = Effect.fn("validate.validateCopy")(function* validateCopy(
	copy: ValidatorInput
): Effect.fn.Return<
	ValidationResult,
	SchemaManifestError | UnsupportedOpenApiVersion | ValidatorError,
	FileSystem.FileSystem | Path.Path | Digest.Digest
> {
	const line = yield* lineOf(copy)

	yield* registered

	const schema = schemaUri[line]
	const validator = yield* Effect.tryPromise({
		catch: (cause) => ValidatorError.make({ cause }),
		try: () => compilerOf[line](schema)
	})
	const output = validator(copy, "BASIC")

	return {
		errors: output.valid
			? []
			: Arr.map(
					output.errors ?? [],
					({ absoluteKeywordLocation, instanceLocation, keyword }): ValidationUnit => ({
						absoluteKeywordLocation,
						instanceLocation,
						keyword
					})
				),
		line,
		schema,
		valid: output.valid
	}
})

/**
 * Validates a document against the official schema of its `openapi` line (design 3.2), through a
 * copy, so the document is never handed to the library.
 */
export const validateDocument = (
	document: Json
): Effect.Effect<
	ValidationResult,
	SchemaManifestError | UnsupportedOpenApiVersion | ValidatorError,
	FileSystem.FileSystem | Path.Path | Digest.Digest
> => validateCopy(validatorCopy(document))

/**
 * The diagnostics of one document: schema disagreements the text overrules as notices, every other
 * schema error as a document refusal.
 */
export interface Diagnosis {
	readonly notices: readonly Diagnostic[]
	readonly refusals: readonly Refusal[]
}

/**
 * The keyword with which the 3.2 schema bars the uppercase fixed method names as
 * `additionalOperations` keys. The text bars them in any capitalization (PTH-24), so the structure
 * check refuses every spelling alike.
 */
const fixedMethodKeyKeyword = "#/$defs/path-item/properties/additionalOperations/propertyNames/not"

const isFixedMethodKey = (group: ErrorGroup): boolean =>
	Arr.every(group.deepest, (unit) =>
		Str.endsWith(fixedMethodKeyKeyword)(unit.absoluteKeywordLocation)
	)

/**
 * The known disagreement the dialect id rewrite stands for.
 */
const sch01 = Arr.findFirst(knownDisagreements, (entry) => entry.row === "SCH-01")

/**
 * An error group with the known disagreement that explains it, if any.
 */
interface Matched {
	readonly entry: Option.Option<Disagreement>
	readonly group: ErrorGroup
}

/**
 * Validates a document (design 3.2) and sorts the verdict into notices and refusals. The 3.1 line
 * is validated as a deep copy with the text's dialect id rewritten; the input is never changed.
 * SCH-01 is looked up only when the rewrite found a dialect id, so a missing entry dies only then.
 */
export const diagnoseDocument = Effect.fn("validate.diagnoseDocument")(function* diagnoseDocument(
	document: Json,
	uri: typeof DocumentUri.Type
): Effect.fn.Return<
	Diagnosis,
	| InvalidInstanceLocation
	| Schema.SchemaError
	| SchemaManifestError
	| UnsupportedOpenApiVersion
	| ValidatorError,
	FileSystem.FileSystem | Path.Path | Digest.Digest
> {
	const line = yield* lineOf(document)
	const openapi = Option.getOrElse(declaredOpenapi(document), () => line)
	const where = { document: uri, line, openapi }
	const lone = surrogateSites(document)

	if (Arr.isReadonlyArrayNonEmpty(lone)) {
		const refusals = yield* Effect.forEach(lone, (pointer) => surrogateRefusal(where, pointer))

		return { notices: [], refusals }
	}

	const rewritten = yield* rewriteDialect(document)
	const result = yield* validateCopy(rewritten.copy)
	const errorGroups = yield* groupErrors(result.errors)
	const groups = Arr.filter(errorGroups, (group) => !isFixedMethodKey(group))
	const rewriteNotices = Arr.isReadonlyArrayNonEmpty(rewritten.occurrences)
		? yield* Option.match(sch01, {
				onNone: () => Effect.die("SCH-01 is missing from the known-disagreement table"),
				onSome: (entry) =>
					Effect.forEach(rewritten.occurrences, (pointer) =>
						noticeFor(entry, where, pointer, "the schema pins the dated dialect id instead")
					)
			})
		: []
	const matched = Arr.map(groups, (group): Matched => ({
		entry: matchDisagreement(line, group),
		group
	}))
	const tableNotices = yield* Effect.forEach(
		Arr.getSomes(
			Arr.map(matched, ({ entry, group }) =>
				Option.map(entry, (found) => ({ entry: found, group }))
			)
		),
		({ entry, group }) =>
			noticeFor(
				entry,
				where,
				group.pointer,
				`the schema rejects it at ${Option.getOrElse(
					Option.map(Arr.head(group.deepest), (unit) => unit.absoluteKeywordLocation),
					() => ""
				)}`
			)
	)
	const refusals = yield* Effect.forEach(
		Arr.filter(matched, ({ entry }) => Option.isNone(entry)),
		({ group }) => refusalFor(where, group)
	)

	return { notices: [...rewriteNotices, ...tableNotices], refusals }
})
