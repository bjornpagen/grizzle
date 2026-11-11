import { regex } from "arkregex"
import { Array as Arr, String as Str } from "effect"
import { type Refused, refusals } from "#compiler/core/refusals.ts"

/** A line of a checked file: its file name and its 1-based line. */
export interface FileLine {
	readonly file: string
	readonly line: number
}

/** An error diagnostic tsgo reported: where, and its code. */
export interface Diagnostic extends FileLine {
	readonly code: string
}

export const lineKey = (p: FileLine): string => `${p.file}:${p.line}`

/**
 * What a directive claims of the line under it, which the type-test batch (batch.ts) disarms to check that the line
 * raises exactly that, and nothing stronger than the contract the directive states:
 * - `code`, `// @ts-expect-error -- TSnnnn: <why>`: the line raises exactly code nnnn and prints no refusal, where the
 *   code is itself the contract, as TS2590 is of TypeScript's union limit;
 * - `refusal`, `// @ts-expect-error -- refusal: <message>`: the line does not compile, and a diagnostic of it prints the
 *   refusal grizzle's type names, `Refusal<"<message>">`, one of the vocabulary (core/refusals.ts), whatever its code;
 * - `refused`, `// @ts-expect-error -- refused: <why>`: the line does not compile, whatever diagnostic the checker
 *   raises there, and prints no refusal;
 * - `twin`, `// @ts-expect-error -- twin <label>: <why>`: the line does not compile, and every line of its label in the
 *   unit raises the same diagnostics, each code with the refusal it prints: one probe written at two places, so the
 *   verdict of one is the other's oracle.
 */
export type Claim =
	| { readonly kind: "code"; readonly code: string; readonly reason: string }
	| { readonly kind: "refusal"; readonly refusal: Refused }
	| { readonly kind: "refused"; readonly reason: string }
	| { readonly kind: "twin"; readonly label: string; readonly reason: string }

/** A disarmed directive: the line whose diagnostics it states, and what it claims of them. */
export interface Directive extends FileLine {
	readonly claim: Claim
}

const refusalMessages: ReadonlySet<string> = new Set(refusals)
const isRefused = (text: string): text is Refused => refusalMessages.has(text)

/** A directive line, trimmed: `// @ts-expect-error -- `, its head, `: ` and its text. */
const directiveLine = regex("^// @ts-expect-error -- ([^:]+): (.+)$")

/** A code's head: TS and its digits. */
const codeHead = regex("^TS\\d+$")

/** A twin's head: `twin ` and its label. */
const twinHead = regex("^twin ([a-z][a-z0-9-]*)$")

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
		if (parsed === null) {
			throw new Error(
				`${file}:${n}: a directive is "// @ts-expect-error -- TSnnnn: why", "// @ts-expect-error -- refusal: <message>", "// @ts-expect-error -- refused: why" or "// @ts-expect-error -- twin <label>: why"`
			)
		}
		const [, head, text] = parsed
		const claim = (): Claim => {
			const twin = twinHead.exec(head)
			if (twin !== null) {
				return { kind: "twin", label: twin[1], reason: text }
			}
			if (codeHead.test(head)) {
				return { kind: "code", code: head, reason: text }
			}
			if (head === "refused") {
				return { kind: "refused", reason: text }
			}
			if (head !== "refusal") {
				throw new Error(`${file}:${n}: "${head}" is no code, refused, refusal or twin`)
			}
			if (!isRefused(text)) {
				throw new Error(
					`${file}:${n}: "${text}" is no Refused (packages/engine/src/core/refusals.ts)`
				)
			}
			return { kind: "refusal", refusal: text }
		}
		directives.push({ file, line: n + 1, claim: claim() })
		return Str.replace("@ts-expect-error", "expected error")(line)
	})
	return { source: Arr.join(out, "\n"), directives }
}
