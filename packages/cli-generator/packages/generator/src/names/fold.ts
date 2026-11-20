import { regex } from "arkregex"
import { Array as Arr, Option, Result, Schema, String as Str, pipe } from "effect"
import { reservedIdentifiers, windowsDeviceNames } from "#names/reserved.ts"

type Casing = "kebab" | "camel" | "pascal"

/**
 * A fix the fold applied; every note is reported (design 4.4).
 */
export type FoldNote =
	| { readonly _tag: "DigitPrefix"; readonly prefix: string }
	| { readonly _tag: "ReservedSuffix"; readonly suffix: string }

/** An input with no letter or digit to fold. */
export class EmptyFold extends Schema.TaggedError<EmptyFold, { readonly brand: unique symbol }>()(
	"EmptyFold",
	{ input: Schema.String }
) {}

/** A file segment the fold refuses: off the segment pattern, or a Windows device name. */
class UnsafeFileSegment extends Schema.TaggedError<
	UnsafeFileSegment,
	{ readonly brand: unique symbol }
>()("UnsafeFileSegment", {
	segment: Schema.String,
	reason: Schema.Literals(["pattern", "device"])
}) {}

const digitPrefix = "n"

const reservedSuffix = "_"

const identifierPattern = regex("^[A-Za-z_$][A-Za-z0-9_$]*$", "u")

const segmentPattern = regex("^[a-z0-9][a-z0-9-]{0,63}$", "u")

const leadingDigit = regex("^[0-9]", "u")

const combiningMarks = regex("\\p{M}+", "gu")

const nonAlphanumeric = regex("[^A-Za-z0-9]+", "gu")

const lowerBeforeUpper = regex("(?<lower>[a-z])(?=[A-Z])", "gu")

const deviceStem = (segment: string): string =>
	Str.toUpperCase(Arr.headNonEmpty(Str.split(".")(segment)))

const isDeviceName = (segment: string): boolean => windowsDeviceNames.has(deviceStem(segment))

/**
 * A generated identifier: ASCII, matches `^[A-Za-z_$][A-Za-z0-9_$]*$` and is not reserved.
 */
export const SafeIdentifier = Schema.String.pipe(
	Schema.check(
		Schema.makeFilter(
			(value: string) => identifierPattern.test(value) && !reservedIdentifiers.has(value)
		)
	),
	Schema.brand("SafeIdentifier")
)

export type SafeIdentifierValue = typeof SafeIdentifier.Type

/**
 * A generated file segment: `^[a-z0-9][a-z0-9-]{0,63}$`, not a Windows device name in any case.
 */
export const SafeFileSegment = Schema.String.pipe(
	Schema.check(
		Schema.makeFilter((value: string) => segmentPattern.test(value) && !isDeviceName(value))
	),
	Schema.brand("SafeFileSegment")
)

export type SafeFileSegmentValue = typeof SafeFileSegment.Type

export interface Folded<Name extends string> {
	readonly name: Name
	readonly notes: readonly FoldNote[]
}

const capitalize = (word: string): string =>
	`${Str.toUpperCase(Str.slice(0, 1)(word))}${Str.toLowerCase(Str.slice(1)(word))}`

/**
 * The fold's word split: NFKD, drop combining marks, keep `[A-Za-z0-9]`, break on everything
 * else and between a lowercase and an uppercase letter. Case is kept.
 */
export const words = (input: string): readonly string[] =>
	Arr.filter(
		Str.split(" ")(
			pipe(
				input,
				Str.normalize("NFKD"),
				Str.replaceAll(combiningMarks, ""),
				Str.replaceAll(nonAlphanumeric, " "),
				Str.replaceAll(lowerBeforeUpper, "$<lower> ")
			)
		),
		Str.isNonEmpty
	)

const joinWords = (parts: readonly string[], casing: Casing): string => {
	if (casing === "kebab") {
		return Arr.join(Arr.map(parts, Str.toLowerCase), "-")
	}

	if (casing === "pascal") {
		return Arr.join(Arr.map(parts, capitalize), "")
	}

	return Arr.join(
		Arr.map(parts, (word, index) => (index === 0 ? Str.toLowerCase(word) : capitalize(word))),
		""
	)
}

const withDigitPrefix = (
	parts: readonly string[]
): { readonly parts: readonly string[]; readonly notes: readonly FoldNote[] } =>
	Option.exists(Arr.head(parts), (first) => leadingDigit.test(first))
		? { notes: [{ _tag: "DigitPrefix", prefix: digitPrefix }], parts: [digitPrefix, ...parts] }
		: { notes: [], parts }

/**
 * Fold to a kebab name for commands and flags. A leading digit gets the prefix `n`.
 */
export const foldKebab = (input: string): Result.Result<Folded<string>, EmptyFold> => {
	const parts = words(input)
	if (parts.length === 0) {
		return Result.fail(EmptyFold.make({ input }))
	}

	const prefixed = withDigitPrefix(parts)

	return Result.succeed({ name: joinWords(prefixed.parts, "kebab"), notes: prefixed.notes })
}

/**
 * Fold to a camel or Pascal identifier. A leading digit gets the prefix `n`; a reserved word
 * gets the suffix `_`.
 */
export const foldIdentifier = (
	input: string,
	casing: "camel" | "pascal"
): Result.Result<Folded<SafeIdentifierValue>, EmptyFold> => {
	const parts = words(input)
	if (parts.length === 0) {
		return Result.fail(EmptyFold.make({ input }))
	}

	const prefixed = withDigitPrefix(parts)
	const joined = joinWords(prefixed.parts, casing)
	if (!reservedIdentifiers.has(joined)) {
		return Result.succeed({
			name: SafeIdentifier.make(joined),
			notes: prefixed.notes
		})
	}

	return Result.succeed({
		name: SafeIdentifier.make(`${joined}${reservedSuffix}`),
		notes: [...prefixed.notes, { _tag: "ReservedSuffix", suffix: reservedSuffix }]
	})
}

/**
 * Fold to a file segment. A Windows device name or a name over 64 characters is refused, never
 * renamed.
 */
export const foldFileSegment = (
	input: string
): Result.Result<SafeFileSegmentValue, EmptyFold | UnsafeFileSegment> => {
	const parts = words(input)
	if (parts.length === 0) {
		return Result.fail(EmptyFold.make({ input }))
	}

	const segment = joinWords(parts, "kebab")
	if (isDeviceName(segment)) {
		return Result.fail(UnsafeFileSegment.make({ reason: "device", segment }))
	}

	if (!Schema.is(SafeFileSegment)(segment)) {
		return Result.fail(UnsafeFileSegment.make({ reason: "pattern", segment }))
	}

	return Result.succeed(segment)
}
