import type { DocumentUri } from "#model/brands.ts"
import type { DiagnosticScope } from "#model/diagnostic.ts"
import type { Sha256Hex } from "#model/digest.ts"
import type { JsonPointer } from "#model/pointer.ts"

/** An object type with its members spelled out, so an intersection of members is one plain object type. */
type Spelled<T> = { readonly [K in keyof T]: T[K] }

type Entry = Readonly<{ code: string; pointer: JsonPointer; row: string }>

/** A walk element's use site (design 8.3). */
type Site = Readonly<{ document: DocumentUri; pointer: JsonPointer }>

/** A `--describe` claim nothing in the spec stands behind, by the command's path. */
type Claim = Readonly<{ path: ReadonlyArray<string> }>

type OperationKind = Readonly<{ kind: "operation" }>

type ParameterKind = Readonly<{ in: string; kind: "parameter"; name: string }>

type CommandKind = Readonly<{ kind: "command" }>

type RefusedFieldKind = Readonly<{ kind: "refusedField"; mediaType: string; name: string }>

type RequestMediaKind = Readonly<{ kind: "requestMedia"; mediaType: string }>

type ResponseKind = Readonly<{ key: string; kind: "response" }>

type SecurityAlternativeKind = Readonly<{
	kind: "securityAlternative"
	schemes: ReadonlyArray<string>
}>

type ServerKind = Readonly<{ kind: "server"; url: string }>

/**
 * A walk element (design 8.3): its use site, then its kind and the kind's value, or a `field` refusal no command agrees
 * with (rule 6) by its pointer, request media type and property name.
 */
type Element = Spelled<
	Site &
		(
			| OperationKind
			| ParameterKind
			| RefusedFieldKind
			| RequestMediaKind
			| ResponseKind
			| SecurityAlternativeKind
			| ServerKind
		)
>

/** An invented claim: the command's path, then its kind and the kind's value. */
type Invented = Spelled<
	Claim &
		(
			| CommandKind
			| RefusedFieldKind
			| RequestMediaKind
			| ResponseKind
			| SecurityAlternativeKind
			| ServerKind
		)
>

/**
 * The coverage join (design 8.2, revision 19): `missing` lists what nothing accounts for, `byNotice` what only a notice
 * accounts for, and `invented` what nothing in the spec stands behind.
 */
export type VerdictCoverage = Readonly<{
	byNotice: ReadonlyArray<Element>
	checked: boolean
	invented: ReadonlyArray<Invented>
	missing: ReadonlyArray<Element>
}>

/**
 * The corpus verdict file for one pinned specification (design 8.2). Each count is the length of what it counts, so no
 * count is negative or fractional.
 */
export type Verdict = Readonly<{
	/** Commands by the source of their command name; `fold` covers `operationId` and route names. */
	commandSources: Readonly<{ config: number; fern: number; fold: number; forge: number }>
	corpusVersion: number
	counts: Readonly<{
		informational: number
		nonStandard: number
		notices: number
		operations: Readonly<{ generated: number; refused: number; total: number }>
		refusals: Readonly<{ document: number; element: number; field: number; operation: number }>
	}>
	coverage: VerdictCoverage
	generator: Readonly<{ config: string; configSha256: Sha256Hex; version: string }>
	/** The report's non-standard entries; they never change `verdict`. */
	nonStandard: ReadonlyArray<Readonly<{ choice: string; pointer: JsonPointer; row: string }>>
	notices: ReadonlyArray<Entry>
	refusals: ReadonlyArray<Spelled<Entry & Readonly<{ scope: DiagnosticScope }>>>
	spec: Readonly<{ id: string; openapi: string; sha256: Sha256Hex }>
	twinEquality: Readonly<{ checked: boolean; equal: boolean }>
	verdict: "accepted" | "partly-refused" | "refused"
}>
