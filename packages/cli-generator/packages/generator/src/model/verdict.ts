import { Schema } from "effect"
import { JsonPointer, Sha256Hex } from "#model/brands.ts"
import { DiagnosticScope } from "#model/diagnostic.ts"
import { Origin } from "#model/entities.ts"

const Count = Schema.Natural

const Entry = Schema.Struct({
	code: Schema.String,
	pointer: JsonPointer,
	row: Schema.String
})

/**
 * Construct a walk element (design 8.3): its use site, then its kind and the kind's value, or a
 * `field` refusal no command agrees with (rule 6) by its pointer, request media type and property
 * name.
 */
const withSite = <const Fields extends Schema.Struct.Fields>(kind: Schema.Struct<Fields>) =>
	Schema.Struct({ ...Origin.fields, ...kind.fields })

/**
 * A `--describe` claim nothing in the spec stands behind, by the command's path and the value.
 */
const Claim = Schema.Struct({ path: Schema.Array(Schema.String) })

/**
 * Construct an invented claim: the command's path, then its kind and the kind's value.
 */
const withClaim = <const Fields extends Schema.Struct.Fields>(kind: Schema.Struct<Fields>) =>
	Schema.Struct({ ...Claim.fields, ...kind.fields })

const OperationKind = Schema.Struct({ kind: Schema.Literal("operation") })

const ParameterKind = Schema.Struct({
	in: Schema.String,
	kind: Schema.Literal("parameter"),
	name: Schema.String
})

const CommandKind = Schema.Struct({ kind: Schema.Literal("command") })

const RefusedFieldKind = Schema.Struct({
	kind: Schema.Literal("refusedField"),
	mediaType: Schema.String,
	name: Schema.String
})

const RequestMediaKind = Schema.Struct({
	kind: Schema.Literal("requestMedia"),
	mediaType: Schema.String
})

const ResponseKind = Schema.Struct({ key: Schema.String, kind: Schema.Literal("response") })

const SecurityAlternativeKind = Schema.Struct({
	kind: Schema.Literal("securityAlternative"),
	schemes: Schema.Array(Schema.String)
})

const ServerKind = Schema.Struct({ kind: Schema.Literal("server"), url: Schema.String })

const Element = Schema.Union([
	withSite(OperationKind),
	withSite(ParameterKind),
	withSite(RefusedFieldKind),
	withSite(RequestMediaKind),
	withSite(ResponseKind),
	withSite(SecurityAlternativeKind),
	withSite(ServerKind)
])

const Invented = Schema.Union([
	withClaim(CommandKind),
	withClaim(RefusedFieldKind),
	withClaim(RequestMediaKind),
	withClaim(ResponseKind),
	withClaim(SecurityAlternativeKind),
	withClaim(ServerKind)
])

/**
 * The coverage join (design 8.2, revision 19): `missing` lists what nothing accounts for,
 * `byNotice` what only a notice accounts for, and `invented` what nothing in the spec stands
 * behind.
 */
export const VerdictCoverage = Schema.Struct({
	byNotice: Schema.Array(Element),
	checked: Schema.Boolean,
	invented: Schema.Array(Invented),
	missing: Schema.Array(Element)
})

/**
 * The corpus verdict file for one pinned specification (design 8.2). Fields are alphabetical.
 */
export const Verdict = Schema.Struct({
	/**
	 * Commands by the source of their command name; `fold` covers `operationId` and route names.
	 */
	commandSources: Schema.Struct({ config: Count, fern: Count, fold: Count, forge: Count }),
	corpusVersion: Count,
	counts: Schema.Struct({
		informational: Count,
		nonStandard: Count,
		notices: Count,
		operations: Schema.Struct({ generated: Count, refused: Count, total: Count }),
		refusals: Schema.Struct({ document: Count, element: Count, field: Count, operation: Count })
	}),
	coverage: VerdictCoverage,
	generator: Schema.Struct({
		config: Schema.String,
		configSha256: Sha256Hex,
		version: Schema.String
	}),
	/**
	 * The report's non-standard entries; they never change `verdict`.
	 */
	nonStandard: Schema.Array(
		Schema.Struct({ choice: Schema.String, pointer: JsonPointer, row: Schema.String })
	),
	notices: Schema.Array(Entry),
	refusals: Schema.Array(Schema.Struct({ ...Entry.fields, scope: DiagnosticScope })),
	spec: Schema.Struct({ id: Schema.String, openapi: Schema.String, sha256: Sha256Hex }),
	twinEquality: Schema.Struct({ checked: Schema.Boolean, equal: Schema.Boolean }),
	verdict: Schema.Literals(["accepted", "partly-refused", "refused"])
})
