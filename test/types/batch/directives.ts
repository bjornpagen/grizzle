import { regex } from "arkregex"
import { Array as Arr, String as Str } from "effect"
import { type Refused, refusals } from "#compiler/core/refusals.ts"

/** A line of a checked file: its file name and its 1-based line. */
export interface Place {
	readonly file: string
	readonly line: number
}

/** An error diagnostic tsgo reported: where, and its code. */
export interface Diagnostic extends Place {
	readonly code: string
}

export const placeKey = (p: Place): string => `${p.file}:${p.line}`

/**
 * What a directive claims of the line under it, which the type-test batch (batch.ts) disarms to check that the line
 * raises exactly that, and nothing stronger than the contract the directive states:
 * - `code`, `// @ts-expect-error -- TSnnnn: <why>`: the line raises exactly code nnnn and prints no refusal;
 * - `refusal`, `// @ts-expect-error -- TSnnnn refusal: <message>`: the line raises code nnnn and prints the refusal
 *   grizzle's type names, `Refusal<"<message>">`, one of the vocabulary (core/refusals.ts);
 * - `refused`, `// @ts-expect-error -- refused: <why>`: the line does not compile, whatever diagnostic the checker
 *   raises there, and prints no refusal;
 * - `twin`, `// @ts-expect-error -- twin <label>: <why>`: the line does not compile, and every line of its label in the
 *   unit raises the same diagnostics, each code with the refusal it prints: one probe written at two places, so the
 *   verdict of one is the other's oracle.
 */
export type Claim =
	| { readonly kind: "code"; readonly code: string; readonly reason: string }
	| { readonly kind: "refusal"; readonly code: string; readonly refusal: Refused }
	| { readonly kind: "refused"; readonly reason: string }
	| { readonly kind: "twin"; readonly label: string; readonly reason: string }

/** A disarmed directive: the line whose diagnostics it states, and what it claims of them. */
export interface Directive extends Place {
	readonly claim: Claim
}

const refusalMessages: ReadonlySet<string> = new Set(refusals)
const isRefused = (text: string): text is Refused => refusalMessages.has(text)

/**
 * A directive line, trimmed: `// @ts-expect-error -- ` then a code, a code and ` refusal`, `refused`, or `twin` and a
 * label, then `: ` and its text.
 */
const directiveLine = regex(
	"^// @ts-expect-error -- (?:(TS\\d+)( refusal)?|refused|twin ([a-z][a-z0-9-]*)): (.+)$"
)

/**
 * Disarms every directive, returning the source and the directives: each one's claim of the line after it. A directive
 * outside the grammar, or a refusal naming no Refused, refuses the file.
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
		const text = parsed?.[4]
		if (parsed === null || text === undefined) {
			throw new Error(
				`${file}:${n}: a directive is "// @ts-expect-error -- TSnnnn: why", "// @ts-expect-error -- TSnnnn refusal: <message>", "// @ts-expect-error -- refused: why" or "// @ts-expect-error -- twin <label>: why"`
			)
		}
		const claim = (): Claim => {
			const [, code, refusal, label] = parsed
			if (label !== undefined) {
				return { kind: "twin", label, reason: text }
			}
			if (code === undefined) {
				return { kind: "refused", reason: text }
			}
			if (refusal === undefined) {
				return { kind: "code", code, reason: text }
			}
			if (!isRefused(text)) {
				throw new Error(
					`${file}:${n}: "${text}" is no Refused (packages/engine/src/core/refusals.ts)`
				)
			}
			return { kind: "refusal", code, refusal: text }
		}
		directives.push({ file, line: n + 1, claim: claim() })
		return Str.replace("@ts-expect-error", "expected error")(line)
	})
	return { source: Arr.join(out, "\n"), directives }
}
