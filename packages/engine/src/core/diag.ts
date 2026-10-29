import type { SourceLoc } from "#compiler/core/loc.ts"

type Severity = "info" | "warning" | "error"

type SafeValue = string | number | boolean | bigint

type DiagField = { readonly kind: "safe"; readonly value: SafeValue }

export const safe = (value: SafeValue): DiagField => ({ kind: "safe", value })

/**
 * Diagnostic records: what a compilation notes about its choices beside its result. A diagnostic's message is a
 * constant template whose "{name}" placeholders name its typed fields.
 */
export interface Diagnostic {
	/** A stable machine code, for example a CompileError reason's tag. */
	readonly code: string
	readonly severity: Severity
	/** A constant template; "{name}" is replaced by the rendered field `name`, "{{" and "}}" by literal braces. */
	readonly message: string
	/** Undefined for a diagnostic about no one declaration. */
	readonly loc: SourceLoc | undefined
	readonly fields: Readonly<Record<string, DiagField>>
}

export const diagnostic = (input: Diagnostic): Diagnostic => ({
	code: input.code,
	severity: input.severity,
	message: input.message,
	loc: input.loc,
	fields: { ...input.fields }
})
