/**
 * What the property of generator-cli-failure.test.ts reads: every failure the generator prints as one line (design 8.1)
 * with drawn fields, the line the design gives it, the characters a line may not hold raw, and the subject a line's
 * subject field reads back as.
 */

import {
	array,
	characterOf,
	codePoint,
	element,
	map,
	oneOf,
	type Space,
	string,
	unicodeScalar,
	weighted
} from "@bjornpagen/testing/gen"
import { regex } from "arkregex"
import { Array as Arr, Option, PlatformError, Record, String as Str } from "effect"
import { ApiEmitError } from "#emit/api.ts"
import { CliEmitError } from "#emit/cli.ts"
import { DomainEmitError } from "#emit/domain.ts"
import { PackageEmitError } from "#emit/package.ts"
import { PrinterError } from "#emit/printer.ts"
import type { failureLine } from "#main.ts"
import { SchemaImportDefect } from "#normalize/schemas.ts"
import { SchemaManifestError, ValidatorError } from "#validate/index.ts"
import { InvalidInstanceLocation } from "#validate/locations.ts"
import { WriteRefused } from "#write/index.ts"
import { RunLockHeld, RunLockUnavailable } from "#write/lock.ts"

/** A failure the generator prints as one line: every failure of a run but a refusal, which prints its diagnostics. */
export type LineFailure = Parameters<typeof failureLine>[0]

/**
 * The line a failure prints, by the design: the lock's and a refused write's whole line, or a generation failure's
 * head (its tag and its reason, a token printed as it is) and the subject the field after it must read back as.
 */
export type Expected =
	| Readonly<{ kind: "whole"; line: string }>
	| Readonly<{ kind: "generation"; head: string; subject: Option.Option<string> }>

/** One drawn failure, beside the line the design gives it and what the property notes of it. */
export type FailureCase = Readonly<{
	failure: LineFailure
	expected: Expected
	shape: Shape
}>

/** Which of a reason and a subject a failure's line names. */
type Shape =
	| "the lock line"
	| "a refused write"
	| "a reason and a subject"
	| "a reason alone"
	| "neither field"

export type Feature =
	| Shape
	| `the ${LineFailure["_tag"]} line`
	| "a character JSON escapes"
	| "a character only the sanitizer escapes"
	| "a lone surrogate"
	| "a sanitizer escape spelled in the subject"

/**
 * The characters a line may not hold raw (design 8.1, C8): controls, format characters, line and paragraph separators,
 * and lone surrogates, each of which a terminal may act on or a reader may not see.
 */
const unsafe = regex("[\\p{Cc}\\p{Cf}\\p{Zl}\\p{Zp}\\p{Cs}]", "u")

/** The characters JSON's string escapes write as an escape: the C0 controls, the quote and the backslash. */
const jsonEscaped = regex('[\\u0000-\\u001f"\\\\]', "u")

const loneSurrogate = regex("\\p{Cs}", "u")

/** Whether a text holds a character a line may not hold raw. */
export const holdsUnsafe = (text: string): boolean => unsafe.test(text)

/**
 * A subject's characters: any scalar value; the C0 and C1 controls, ASCII and DEL; the General Punctuation block, which
 * holds the zero-width and bidirectional format characters and both separators; and surrogates, alone or paired by
 * their neighbour.
 */
const subjectCharacter: Space<string> = weighted([
	[2, unicodeScalar],
	[3, codePoint(0, 0x9f)],
	[2, codePoint(0x20_00, 0x20_6f)],
	[1, codePoint(0xd8_00, 0xdf_ff)]
])

/** A sanitizer's escape spelled out in a subject's own text, `\u{hex}`, which its field must not read back as a character. */
const spelledEscape: Space<string> = map(
	string(characterOf(["0", "7", "a", "f"]), { min: 1, max: 4 }),
	(hex) => `\\u{${hex}}`
)

/** A subject: its characters, and now and then a spelled sanitizer escape among them. */
const subject: Space<string> = map(
	array(
		weighted([
			[6, subjectCharacter],
			[1, spelledEscape]
		]),
		{ min: 0, max: 10 }
	),
	Arr.join("")
)

const text: Space<string> = string(unicodeScalar, { min: 0, max: 6 })

const whole = (failure: LineFailure, shape: Shape, line: string): FailureCase => ({
	failure,
	expected: { kind: "whole", line },
	shape
})

const generation = (
	failure: LineFailure,
	head: string,
	fields: Readonly<{ shape: Shape; subject: Option.Option<string> }>
): FailureCase => ({
	failure,
	expected: { kind: "generation", head, subject: fields.subject },
	shape: fields.shape
})

/** A failure with a reason and a subject: the reason after its tag, then the subject read back from its field. */
const withSubject = (
	failure: LineFailure & Readonly<{ reason: string; subject: string }>
): FailureCase =>
	generation(failure, `error: generation failed (${failure._tag}) reason ${failure.reason}`, {
		shape: "a reason and a subject",
		subject: Option.some(failure.subject)
	})

/** A failure with a reason and no subject: the reason after its tag, and nothing after it. */
const reasonAlone = (failure: LineFailure & Readonly<{ reason: string }>): FailureCase =>
	generation(failure, `error: generation failed (${failure._tag}) reason ${failure.reason}`, {
		shape: "a reason alone",
		subject: Option.none()
	})

/** A failure with neither field: its tag alone. */
const neither = (failure: LineFailure): FailureCase =>
	generation(failure, `error: generation failed (${failure._tag})`, {
		shape: "neither field",
		subject: Option.none()
	})

const platformFailure = PlatformError.badArgument({ module: "FileSystem", method: "open" })

/** Every failure class a run prints as one line, each with drawn fields. */
export const failureSpace: Space<FailureCase> = oneOf([
	(source) =>
		whole(
			new RunLockHeld({ lockPath: source.draw(text) }),
			"the lock line",
			"error: another run holds the output directory's lock"
		),
	(source) => {
		const reason = source.draw(element(["io", "symlink", "unsafe-path"] as const))
		return whole(
			new WriteRefused({ reason, subject: source.draw(subject) }),
			"a refused write",
			`error: the output was not written (${reason})`
		)
	},
	(source) =>
		withSubject(
			new PrinterError({
				reason: source.draw(element(["duplicate-key", "unbreakable-line"] as const)),
				subject: source.draw(subject)
			})
		),
	(source) =>
		withSubject(
			new ApiEmitError({
				reason: source.draw(element(["unknown-scheme", "unprintable-name"] as const)),
				subject: source.draw(subject)
			})
		),
	(source) =>
		withSubject(
			new CliEmitError({
				reason: source.draw(element(["name-clash", "unsupported-flag"] as const)),
				subject: source.draw(subject)
			})
		),
	(source) =>
		reasonAlone(
			new DomainEmitError({
				reason: source.draw(element(["identifier-mismatch", "unresolved-reference"] as const))
			})
		),
	() => reasonAlone(new PackageEmitError({ reason: "unprintable-package" })),
	(source) =>
		reasonAlone(
			new SchemaManifestError({
				file: source.draw(text),
				reason: source.draw(element(["unreadable", "sha256-mismatch"] as const))
			})
		),
	(source) => neither(new InvalidInstanceLocation({ location: source.draw(text) })),
	(source) =>
		neither(new SchemaImportDefect({ key: source.draw(text), message: source.draw(subject) })),
	(source) => neither(new ValidatorError({ cause: source.draw(subject) })),
	(source) =>
		neither(new RunLockUnavailable({ lockPath: source.draw(text), cause: platformFailure }))
])

/**
 * One token of a subject field between its quotes: a sanitizer's escape `\u{hex}`, JSON's `\uXXXX`, JSON's short
 * escape of one character, or one character as it stands. JSON's escapes never begin `\u{`, so the two cannot be
 * confused.
 */
const token = regex("\\\\u\\{([0-9a-f]+)\\}|\\\\u([0-9a-f]{4})|\\\\([\\s\\S])|([\\s\\S])", "gu")

/** The character each of JSON's short escapes stands for (RFC 8259 section 7). */
const shortEscapes: Readonly<Record<string, string>> = {
	'"': '"',
	"\\": "\\",
	"/": "/",
	b: "\b",
	f: "\f",
	n: "\n",
	r: "\r",
	t: "\t"
}

const fromHex = (hex: string): number => Number.parseInt(hex, 16)

/** What one token stands for, or `None` for a quote standing raw inside the string or an escape JSON has not. */
const readToken = (match: RegExpMatchArray): Option.Option<string> => {
	const [, sanitized, unit, escaped, plain] = match
	if (sanitized !== undefined) {
		return Option.some(String.fromCodePoint(fromHex(sanitized)))
	}
	if (unit !== undefined) {
		return Option.some(String.fromCharCode(fromHex(unit)))
	}
	if (escaped !== undefined) {
		return Record.get(shortEscapes, escaped)
	}
	return Option.filter(Option.fromUndefinedOr(plain), (character) => character !== '"')
}

/**
 * The subject a line's subject field reads back as: a JSON string, its quotes around tokens each read as what it
 * stands for, or `None` when the field is no such string.
 */
export const readSubject = (field: string): Option.Option<string> =>
	field.length >= 2 && Str.startsWith('"')(field) && Str.endsWith('"')(field)
		? Option.map(
				Option.all(
					Arr.map(Arr.fromIterable(Str.matchAll(token)(Str.slice(1, -1)(field))), readToken)
				),
				Arr.join("")
			)
		: Option.none()

/** What a drawn failure reaches: the shape of its line, its class, and the characters of its subject. */
export const featuresOf = (drawn: FailureCase): ReadonlyArray<Feature> => {
	const characters = Option.match(
		drawn.expected.kind === "generation" ? drawn.expected.subject : Option.none(),
		{ onNone: (): ReadonlyArray<string> => [], onSome: (written) => Arr.fromIterable(written) }
	)
	const subjectText = Arr.join(characters, "")
	return [
		drawn.shape,
		`the ${drawn.failure._tag} line`,
		...(Arr.some(
			characters,
			(character) => jsonEscaped.test(character) || loneSurrogate.test(character)
		)
			? ["a character JSON escapes" as const]
			: []),
		...(Arr.some(
			characters,
			(character) =>
				unsafe.test(character) && !jsonEscaped.test(character) && !loneSurrogate.test(character)
		)
			? ["a character only the sanitizer escapes" as const]
			: []),
		...(Arr.some(characters, (character) => loneSurrogate.test(character))
			? ["a lone surrogate" as const]
			: []),
		...(Str.includes("\\u{")(subjectText)
			? ["a sanitizer escape spelled in the subject" as const]
			: [])
	]
}
