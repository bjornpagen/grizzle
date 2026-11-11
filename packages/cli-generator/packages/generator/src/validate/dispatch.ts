import { jsonTextOf } from "@superstarter/json"
import { regex } from "arkregex"
import { Effect, Option, Schema } from "effect"
import type { DocumentUri } from "#model/brands.ts"
import { diagnosticOf } from "#model/diagnostic.ts"
import type { Diagnostic } from "#model/diagnostic.ts"
import type { Json } from "#model/pointer.ts"
import { declaredOpenapi, patchVersion, SpecLine, specSectionUrl } from "#model/spec-section.ts"

export { declaredOpenapi } from "#model/spec-section.ts"

/**
 * The document has no `openapi` string, or names a line other than 3.0, 3.1 or 3.2. A run reports
 * it as the `DOC-02` refusal `versionRefusal` builds.
 */
export class UnsupportedOpenApiVersion extends Schema.TaggedError<
	UnsupportedOpenApiVersion,
	{ readonly brand: unique symbol }
>()("UnsupportedOpenApiVersion", { openapi: Schema.UndefinedOr(Schema.String) }) {}

/**
 * The dated official schema each line validates against (design 3.2): `schema-base` for 3.1 and
 * 3.2, because the plain schema validates no Schema Object.
 */
export const schemaUri: Readonly<Record<SpecLine, string>> = {
	"3.0": "https://spec.openapis.org/oas/3.0/schema/2024-10-18",
	"3.1": "https://spec.openapis.org/oas/3.1/schema-base/2026-08-03",
	"3.2": "https://spec.openapis.org/oas/3.2/schema-base/2026-08-30"
}

const linePattern = regex("^(?<line>3\\.[012])\\.[0-9]+$", "u")

const isSpecLine = Schema.is(SpecLine)

const lineOfVersion = (openapi: string): Option.Option<SpecLine> =>
	Option.filter(Option.fromUndefinedOr(linePattern.exec(openapi)?.groups.line), isSpecLine)

/**
 * Selects the line from the document's `openapi` major.minor.
 */
export const lineOf = (document: Json): Effect.Effect<SpecLine, UnsupportedOpenApiVersion> => {
	const openapi = declaredOpenapi(document)

	return Effect.fromOption(Option.flatMap(openapi, lineOfVersion)).pipe(
		Effect.mapError(() =>
			UnsupportedOpenApiVersion.make({ openapi: Option.getOrUndefined(openapi) })
		)
	)
}

const knownLine = regex("^(?<line>3\\.[012])(?![0-9])", "u")

const declare = "Declare a 3.0.x, 3.1.x or 3.2.x version."

/**
 * `DOC-02` (design 8.1): the document-scope refusal at `/openapi` for an `openapi` value that names
 * no supported line. The section is the value's own line when its major.minor is one (`3.1`), and
 * the 3.2.1 text otherwise.
 */
export const versionRefusal = (
	error: UnsupportedOpenApiVersion,
	document: typeof DocumentUri.Type
): Effect.Effect<Diagnostic, Schema.SchemaError> => {
	const declared = Option.fromUndefinedOr(error.openapi)
	const line = Option.getOrElse(
		Option.filter(
			Option.flatMap(declared, (openapi) =>
				Option.fromUndefinedOr(knownLine.exec(openapi)?.groups.line)
			),
			isSpecLine
		),
		(): SpecLine => "3.2"
	)

	return diagnosticOf({
		code: Option.isNone(declared) ? "DOC-02/missing-version" : "DOC-02/unsupported-version",
		document,
		element: "openapi",
		message: Option.match(declared, {
			onNone: () => `The document declares no openapi version. ${declare}`,
			onSome: (openapi) => `The openapi version ${jsonTextOf(openapi)} is not supported. ${declare}`
		}),
		openapi: Option.getOrElse(declared, () => patchVersion[line]),
		pointer: "/openapi",
		scope: "document",
		severity: "refusal",
		specSection: specSectionUrl(line, "oas-version")
	})
}
