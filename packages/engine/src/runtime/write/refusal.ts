/**
 * Reading what a write statement's own refusal raised: the DETAIL of a law's refusal, under SQLSTATE 23000, and of a
 * concurrent change it met, under 40Z01, each behind its tag (write/refusal.ts refusalGuard raises them).
 */
import { nominal } from "#compiler/core/brand.ts"
import type { TransientReason } from "#compiler/core/errors.ts"
import { JsonStrings } from "#compiler/core/json-strings.ts"
import type { OutputText } from "#compiler/core/wire.ts"

/** The TransientFailure reasons a write statement detects itself. */
export type ConcurrentChange = Extract<
	TransientReason,
	{ readonly _tag: "PutTargetConflict" | "SpanKeyChange" }
>

const concurrentChanges = ["PutTargetConflict", "SpanKeyChange"] as const

export type ConcurrentChangeTag = (typeof concurrentChanges)[number]

/** The DETAIL tag of a law's refusal by its key. */
export const keyTag = "k"

/** The DETAIL tag of a concurrent change's refusal. */
export const changeTag = "a"

/** What a DETAIL raised under SQLSTATE 23000 says, read by its tag: a write statement's refusal of a law; or, under no
 * tag of grizzle's, a DETAIL no write statement raised, a foreign trigger's or a defect's, which its reader reports as
 * a statement it cannot classify, with its text. Every other law of grizzle's is a native, named by its constraint. */
export type LawDetail =
	| {
			readonly kind: "law"
			readonly relation: string
			readonly key: ReadonlyArray<{ readonly field: string; readonly text: OutputText }>
	  }
	| { readonly kind: "foreign"; readonly detail: string }

/** What a DETAIL raised under SQLSTATE 40Z01 says: the concurrent change a write statement met. */
export interface ChangeDetail {
	readonly reason: ConcurrentChangeTag
	readonly relation: string
}

/** The strings of a law refusal's DETAIL JSON text, `["<relation>",["<field>",...],["<text>",...]]` after the tag, as
 * PostgreSQL's escape_json wrote them: the relation, then the two arrays'.
 * The structure is the encoding's own, so the reader only walks it. */
const detailStrings = (
	text: string
): {
	readonly relation: string
	readonly fields: ReadonlyArray<string>
	readonly texts: ReadonlyArray<string>
} => {
	const reader = new JsonStrings(text)
	const relation = reader.string()
	const fields = reader.strings()
	const texts = reader.strings()
	return { relation, fields, texts }
}

/**
 * A key field's text in a law refusal's DETAIL: the field's own output text, which the law's SQL casts to text and
 * escape_json writes unchanged, minted here, where the DETAIL is read.
 */
const keyText = nominal<string, OutputText>()

/** The refusal a 23000 DETAIL text says, converted without a check (write/refusal.ts refusalGuard): a write statement's refusal of a
 * law under its tag; any other text a DETAIL grizzle did not raise. */
export const readLawDetail = (text: string): LawDetail => {
	if (!text.startsWith(`${keyTag}[`)) {
		return { kind: "foreign", detail: text }
	}
	const { relation, fields, texts } = detailStrings(text)
	return {
		kind: "law",
		relation,
		key: fields.flatMap((field, i) => {
			const fieldText = texts[i]
			return fieldText === undefined ? [] : [{ field, text: keyText(fieldText) }]
		})
	}
}

/** The concurrent change a 40Z01 DETAIL text says (write/refusal.ts refusalGuard), or undefined when the text names no reason a
 * write statement raises: the server's answer, which the caller reports as it does any statement it cannot classify. */
export const readChangeDetail = (text: string): ChangeDetail | undefined => {
	const reader = new JsonStrings(text)
	const read = reader.string()
	const reason = concurrentChanges.find((c) => c === read)
	return reason === undefined ? undefined : { reason, relation: reader.string() }
}
