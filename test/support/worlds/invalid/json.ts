import { Array as Arr, Record } from "effect"
import { jsonText as jsonTextOf } from "#compiler/core/trusted.ts"

/**
 * A JSON text as a tree the token generators edit before it is written: ordered members, so a duplicate key or a
 * `__proto__` member survives into the text, and raw number text, so an integer past the safe integers keeps every digit
 * the text states.
 */
export type Json =
	| { readonly kind: "raw"; readonly text: string }
	| { readonly kind: "string"; readonly value: string }
	| { readonly kind: "number"; readonly value: number }
	| { readonly kind: "boolean"; readonly value: boolean }
	| { readonly kind: "null" }
	| { readonly kind: "array"; readonly items: ReadonlyArray<Json> }
	| { readonly kind: "object"; readonly members: ReadonlyArray<readonly [string, Json]> }

export const jsonString = (value: string): Json => ({ kind: "string", value })
export const jsonObject = (members: ReadonlyArray<readonly [string, Json]>): Json => ({
	kind: "object",
	members
})

/**
 * The text of a tree. A string is written by trusted.ts jsonText, which escapes a lone surrogate and a NUL, so the text
 * stays well-formed JSON whose parse yields the very string.
 */
export const jsonText = (json: Json): string => {
	switch (json.kind) {
		case "raw":
			return json.text
		case "string":
			return jsonTextOf(json.value)
		case "number":
			return String(json.value)
		case "boolean":
			return json.value ? "true" : "false"
		case "null":
			return "null"
		case "array":
			return `[${Arr.join(Arr.map(json.items, jsonText), ",")}]`
		case "object":
			return `{${Arr.join(
				Arr.map(json.members, ([key, value]) => `${jsonTextOf(key)}:${jsonText(value)}`),
				","
			)}}`
	}
}

/** A host value of a payload as a tree: what `Token.payload` holds, read as JSON. */
export const jsonOf = (value: unknown): Json => {
	if (typeof value === "string") {
		return jsonString(value)
	}
	if (typeof value === "number") {
		return { kind: "number", value }
	}
	if (typeof value === "boolean") {
		return { kind: "boolean", value }
	}
	if (Arr.isArray(value)) {
		return { kind: "array", items: Arr.map(value, jsonOf) }
	}
	if (typeof value === "object" && value !== null) {
		return jsonObject(Arr.map(Record.toEntries(value), ([k, v]) => [k, jsonOf(v)]))
	}
	return { kind: "null" }
}
