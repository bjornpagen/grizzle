import { Option, Schema } from "effect"
import type { Json } from "#model/pointer.ts"

/**
 * An OpenAPI line: the major.minor of a supported specification release. Defined once here so
 * every stage can cite the specification without importing validate.
 */
export const SpecLine = Schema.Literals(["3.0", "3.1", "3.2"])

export type SpecLine = typeof SpecLine.Type

/**
 * The published patch release of each OpenAPI line: the version diagnostics cite when a document's
 * own `openapi` value is not usable.
 */
export const patchVersion = {
	"3.0": "3.0.4",
	"3.1": "3.1.2",
	"3.2": "3.2.1"
} as const satisfies Record<SpecLine, string>

/**
 * The specification section a diagnostic cites: the anchor on the line's published patch release.
 */
export const specSectionUrl = (line: SpecLine, anchor: string): string =>
	`https://spec.openapis.org/oas/v${patchVersion[line]}.html#${anchor}`

const decodeDeclared = Schema.decodeUnknownOption(Schema.Struct({ openapi: Schema.String }))

/**
 * The `openapi` string a document declares, or `None` when the document has no `openapi` member or
 * its value is not a string. Each caller chooses its own fallback.
 */
export const declaredOpenapi = (document: Json): Option.Option<string> =>
	decodeDeclared(document).pipe(Option.map((found) => found.openapi))
