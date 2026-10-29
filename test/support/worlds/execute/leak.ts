import { Option, Predicate, Record as Rec, String as Str } from "effect"
import type { Observation } from "#test/support/worlds/model/types.ts"

/** Where a refusal's text was found: an error field (CONTEXT is `where`), a notice, or a witness value. */
export type LeakField = "message" | "detail" | "hint" | "where" | "notice" | "witness"

export interface Found {
	readonly field: LeakField
	readonly text: string
}

const fieldOfKey = (key: string): Option.Option<LeakField> =>
	key === "message" || key === "detail" || key === "hint" ? Option.some(key) : Option.none()

/**
 * Every message, DETAIL and HINT text an error carries, at any depth: an Error's message (a getter on grizzle's tagged
 * errors) and every string property named message, detail or hint of it, of its cause and of every object it holds.
 * Statement text the executor wrote is never read: it holds what the caller submitted.
 */
export const errorTexts = (error: unknown): ReadonlyArray<Found> => {
	const found: Array<Found> = []
	const seen = new Set<object>()
	const walk = (value: unknown, depth: number): void => {
		if (!Predicate.isObject(value) || seen.has(value) || depth > 12) {
			return
		}
		seen.add(value)
		if (Error.isError(value)) {
			found.push({ field: "message", text: value.message })
		}
		if (Predicate.hasProperty(value, "cause")) {
			walk(value.cause, depth + 1)
		}
		for (const [key, inner] of Rec.toEntries(value)) {
			if (typeof inner === "string") {
				Option.match(fieldOfKey(key), {
					onNone: () => undefined,
					onSome: (field) => {
						found.push({ field, text: inner })
					}
				})
			} else {
				walk(inner, depth + 1)
			}
		}
	}
	walk(error, 0)
	return found
}

/** The keys of an error, and of what it holds, that a report tells: its tag, stage, reason, capability, rule broken and texts. */
const toldKeys: ReadonlySet<string> = new Set([
	"_tag",
	"stage",
	"reason",
	"capability",
	"what",
	"code",
	"message",
	"detail",
	"hint"
])

/**
 * What a report tells of an error, at any depth: an Error's message, and every string property of it and of every object
 * it holds whose key names its tag, stage, reason, capability, SQLSTATE or texts, as `key: value`. It is the reader's,
 * never the leak scan's.
 */
export const errorStory = (error: unknown): ReadonlyArray<string> => {
	const told: Array<string> = []
	const seen = new Set<object>()
	const walk = (value: unknown, depth: number): void => {
		if (!Predicate.isObject(value) || seen.has(value) || depth > 12) {
			return
		}
		seen.add(value)
		if (Error.isError(value) && Str.isNonEmpty(value.message)) {
			told.push(value.message)
		}
		if (Predicate.hasProperty(value, "cause")) {
			walk(value.cause, depth + 1)
		}
		for (const [key, inner] of Rec.toEntries(value)) {
			if (typeof inner === "string") {
				if (toldKeys.has(key) && Str.isNonEmpty(inner)) {
					told.push(`${key}: ${inner}`)
				}
			} else {
				walk(inner, depth + 1)
			}
		}
	}
	walk(error, 0)
	return told
}

/** The leak among `found`: the first text that holds a hidden token. */
export const leakOf = (
	hidden: ReadonlySet<string>,
	found: ReadonlyArray<Found>
): Option.Option<Observation> => {
	for (const f of found) {
		for (const token of hidden) {
			if (token.length > 0 && Str.includes(token)(f.text)) {
				return Option.some({ kind: "leak", field: f.field, token })
			}
		}
	}
	return Option.none()
}
