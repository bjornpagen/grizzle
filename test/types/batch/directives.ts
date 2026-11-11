import { Array as Arr, String as Str } from "effect"
import { type Refused, refusals } from "#compiler/core/refusals.ts"

import { regex } from "arkregex"
/**
 * The directives of a type test: each `// @ts-expect-error` names the diagnostic its next line raises, which the
 * type-test batch (batch.ts) disarms to check that the line raises exactly it.
 */
export interface Diagnostic {
	readonly file: string
	readonly line: number
	readonly code: string
}

export const diagnosticKey = (d: Diagnostic): string => `${d.file}:${d.line}:${d.code}`

/**
 * What a directive claims of the diagnostic its next line raises. A structural refusal says why in prose; a
 * refusal-backed one names the message grizzle's type prints, `Refusal<"<message>">`, one of the vocabulary (core/refusals.ts).
 */
export type Claim =
	| { readonly kind: "prose"; readonly reason: string }
	| { readonly kind: "refusal"; readonly refusal: Refused }

/** A disarmed directive: the diagnostic the disarmed copy must raise, and what the directive claims of it. */
export interface Directive extends Diagnostic {
	readonly claim: Claim
}

const refusalMessages: ReadonlySet<string> = new Set(refusals)
const isRefused = (text: string): text is Refused => refusalMessages.has(text)

/**
 * A directive line, trimmed, is exactly one of `// @ts-expect-error -- TSnnnn: <why>`, a structural refusal, and
 * `// @ts-expect-error -- TSnnnn refusal: <message>`, a refusal grizzle's type names.
 */
const directiveLine = regex("^// @ts-expect-error -- (TS\\d+)( refusal)?: (.+)$")

/**
 * Disarms every directive, returning the source and the directives: code nnnn on the line after each, with its claim.
 * A directive outside the grammar, or a refusal naming no Refused, refuses the file.
 */
export const disarm = (
	file: string,
	source: string
): { readonly source: string; readonly directives: ReadonlyArray<Directive> } => {
	const directives: Array<Directive> = []
	const out = Arr.map(Str.split(source, "\n"), (line, index) => {
		const trimmed = Str.trim(line)
		if (!Str.startsWith("// @ts-expect-error")(trimmed)) {
			return line
		}
		const n = index + 1
		const parsed = directiveLine.exec(trimmed)
		const code = parsed?.[1]
		const text = parsed?.[3]
		if (code === undefined || text === undefined) {
			throw new Error(
				`${file}:${n}: a directive is "// @ts-expect-error -- TSnnnn: why" or "// @ts-expect-error -- TSnnnn refusal: <message>"`
			)
		}
		const claim = (): Claim => {
			if (parsed?.[2] === undefined) {
				return { kind: "prose", reason: text }
			}
			if (!isRefused(text)) {
				throw new Error(
					`${file}:${n}: "${text}" is no Refused (packages/engine/src/core/refusals.ts)`
				)
			}
			return { kind: "refusal", refusal: text }
		}
		directives.push({ file, line: n + 1, code, claim: claim() })
		return Str.replace("@ts-expect-error", "expected error")(line)
	})
	return { source: Arr.join(out, "\n"), directives }
}
