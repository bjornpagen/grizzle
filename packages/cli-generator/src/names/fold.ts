import { regex } from "arkregex"
import { Array as Arr, Brand, Data, Option, Result, String as Str, pipe } from "effect"
import { reservedIdentifiers, reservedWords, windowsDeviceNames } from "#names/reserved.ts"

type Casing = "kebab" | "camel" | "pascal"

/**
 * A fix the fold applied; every note is reported (design 4.4).
 */
export type FoldNote =
	| { readonly _tag: "DigitPrefix"; readonly prefix: string }
	| { readonly _tag: "ReservedSuffix"; readonly suffix: string }

/** An input with no letter or digit to fold. */
export class EmptyFold extends Data.TaggedError("EmptyFold")<{ readonly input: string }> {}

/** A file segment the fold refuses: off the segment pattern, or a Windows device name. */
class UnsafeFileSegment extends Data.TaggedError("UnsafeFileSegment")<{
	readonly segment: string
	readonly reason: "pattern" | "device"
}> {}

const digitPrefix = "n"

const reservedSuffix = "_"

/**
 * An identifier's shape in ASCII: what a binding (Identifier), a member after `.` and an object key that needs no
 * quoting are spelled in.
 */
export const identifierPattern = regex("^[A-Za-z_$][A-Za-z0-9_$]*$", "u")

const segmentPattern = regex("^[a-z0-9][a-z0-9-]{0,63}$", "u")

const leadingDigit = regex("^[0-9]", "u")

const combiningMarks = regex("\\p{M}+", "gu")

const nonAlphanumeric = regex("[^A-Za-z0-9]+", "gu")

const lowerBeforeUpper = regex("(?<lower>[a-z])(?=[A-Z])", "gu")

const deviceStem = (segment: string): string =>
	Str.toUpperCase(Arr.headNonEmpty(Str.split(".")(segment)))

const isDeviceName = (segment: string): boolean => windowsDeviceNames.has(deviceStem(segment))

/**
 * A binding name: identifier-shaped ASCII and not a reserved word (reservedWords). Minted only here: by `isIdentifier`,
 * which a name the emitter composes is read through, and unchecked by `fixedIdentifier` and the printer's `path`, whose
 * text is a literal of the emitter's own source. A generated name is a SafeIdentifier, one already.
 */
export type Identifier = string & Brand.Brand<"Identifier">

/** Whether a text is a binding name (`Identifier`): identifier-shaped ASCII and not a reserved word. */
export const isIdentifier = (value: string): value is Identifier =>
	identifierPattern.test(value) && !reservedWords.has(value)

/**
 * A binding name the emitter writes as a literal of its own source (`flags`, `Serialize`). Unchecked: the literal is
 * the proof, the repository's own text and never a document's or a plan's.
 */
export const fixedIdentifier: (text: string) => Identifier = Brand.nominal<Identifier>()

/**
 * A generated identifier: a binding name (Identifier) that is none of the further words a generated name avoids
 * (reservedIdentifiers, design 4.4), so every SafeIdentifier is an Identifier the printer takes as it is. Minted only
 * here: by `isSafeIdentifier`, which every name the fold or the plan composes is read through, and unchecked by
 * `fixedSafeIdentifier`, whose text is a literal of the generator's own source.
 */
export type SafeIdentifier = Identifier & Brand.Brand<"SafeIdentifier">

/** Whether a name is a SafeIdentifier: a binding name and none of the words a generated name avoids. */
export const isSafeIdentifier = (value: string): value is SafeIdentifier =>
	isIdentifier(value) && !reservedIdentifiers.has(value)

/**
 * A SafeIdentifier the generator writes as a literal of its own source (`Definition`). Unchecked: the literal is the
 * proof, the repository's own text and never a document's or a plan's.
 */
export const fixedSafeIdentifier: (text: string) => SafeIdentifier = Brand.nominal<SafeIdentifier>()

/**
 * A generated file segment: `^[a-z0-9][a-z0-9-]{0,63}$`, not a Windows device name in any case. Minted only here, by
 * `isSafeFileSegment`.
 */
export type SafeFileSegment = string & Brand.Brand<"SafeFileSegment">

/** Whether a name is a SafeFileSegment: segment-shaped and no Windows device name. */
export const isSafeFileSegment = (value: string): value is SafeFileSegment =>
	segmentPattern.test(value) && !isDeviceName(value)

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
		return Result.fail(new EmptyFold({ input }))
	}

	const prefixed = withDigitPrefix(parts)

	return Result.succeed({ name: joinWords(prefixed.parts, "kebab"), notes: prefixed.notes })
}

/**
 * A joined fold as a SafeIdentifier: a name that is none takes the suffix `_`, and is read again. A fold is
 * identifier-shaped, its words ASCII letters and digits with a leading digit prefixed, so it is none only as a reserved
 * word, and no reserved word ends in `_`: one suffix makes it one.
 */
const safeIdentifier = (name: string, notes: readonly FoldNote[]): Folded<SafeIdentifier> =>
	isSafeIdentifier(name)
		? { name, notes }
		: safeIdentifier(`${name}${reservedSuffix}`, [
				...notes,
				{ _tag: "ReservedSuffix", suffix: reservedSuffix }
			])

/**
 * Fold to a camel or Pascal identifier. A leading digit gets the prefix `n`; a reserved word
 * gets the suffix `_`.
 */
export const foldIdentifier = (
	input: string,
	casing: "camel" | "pascal"
): Result.Result<Folded<SafeIdentifier>, EmptyFold> => {
	const parts = words(input)
	if (parts.length === 0) {
		return Result.fail(new EmptyFold({ input }))
	}

	const prefixed = withDigitPrefix(parts)

	return Result.succeed(safeIdentifier(joinWords(prefixed.parts, casing), prefixed.notes))
}

/**
 * Fold to a file segment. A Windows device name or a name over 64 characters is refused, never
 * renamed.
 */
export const foldFileSegment = (
	input: string
): Result.Result<SafeFileSegment, EmptyFold | UnsafeFileSegment> => {
	const parts = words(input)
	if (parts.length === 0) {
		return Result.fail(new EmptyFold({ input }))
	}

	const segment = joinWords(parts, "kebab")
	if (isDeviceName(segment)) {
		return Result.fail(new UnsafeFileSegment({ reason: "device", segment }))
	}

	if (!isSafeFileSegment(segment)) {
		return Result.fail(new UnsafeFileSegment({ reason: "pattern", segment }))
	}

	return Result.succeed(segment)
}
