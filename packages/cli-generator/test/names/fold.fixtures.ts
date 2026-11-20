/**
 * What the properties of fold.test.ts read: names drawn from pieces of every class the fold decides on, and a model of
 * design 4.4's folds written as a walk over code points, apart from the module's own patterns.
 */

import { aimed, type Aimed, array, constant, element, type Gen, map } from "@bjornpagen/testing/gen"
import { regex } from "arkregex"
import { Array as Arr, Option, Order, Result, String as Str } from "effect"
import {
	domainIdentifiers,
	domainNamespace,
	fixedNamespaces,
	rootModuleNames
} from "#names/domain.ts"
import {
	foldFileSegment,
	foldIdentifier,
	foldKebab,
	isSafeFileSegment,
	isSafeIdentifier
} from "#names/fold.ts"
import { reservedIdentifiers } from "#names/reserved.ts"

/** Which fold a case runs. */
export type Fold = "kebab" | "camel" | "pascal" | "segment"

/** One case: the pieces of a name, and the fold it runs. */
export type FoldCase = Readonly<{ pieces: ReadonlyArray<string>; fold: Fold }>

/**
 * Pieces of names: words of each case, digits, separators, marks that NFKD splits off, compatibility characters it
 * decomposes (ligatures, fullwidth and circled forms), letters it keeps that are no ASCII letter, controls, bidi
 * overrides, emoji, reserved words and Windows device names.
 */
const PIECES: Arr.NonEmptyReadonlyArray<string> = [
	"list",
	"Users",
	"API",
	"x",
	"aB",
	"2",
	"fa",
	"_",
	"-",
	".",
	" ",
	"/",
	"é",
	"Crème",
	"ﬁ",
	"ｆｕｌｌ",
	"①",
	"ß",
	"日本",
	"😀",
	"\u0000",
	"\u202E",
	"class",
	"delete",
	"error",
	"keyof",
	"con",
	"COM1",
	"lpt9",
	"Nul",
	"aux.txt",
	"prn",
	"abcdefghijklmnopqrstuvwxyzabcdefghijkl"
]

export type Feature =
	| `a ${Fold} fold`
	| `an empty ${Fold} fold refused`
	| "a leading digit prefixed"
	| "a reserved word suffixed"
	| "a named device refused"
	| "a COM port refused"
	| "an LPT port refused"
	| "a segment over 64 characters refused"
	| "a mark dropped"
	| "a compatibility character decomposed"
	| "a lower-to-upper boundary split"
	| "a reserved word as a raw identifier"
	| "a device name as a raw segment"

/** The Windows device names (Microsoft's naming rules): CON, PRN, AUX, NUL, COM0 to COM9 and LPT0 to LPT9. */
const DEVICES: ReadonlySet<string> = new Set([
	"CON",
	"PRN",
	"AUX",
	"NUL",
	...Arr.map(Arr.range(0, 9), (digit) => `COM${digit}`),
	...Arr.map(Arr.range(0, 9), (digit) => `LPT${digit}`)
])

const mark = regex("^\\p{M}$", "u")

const asciiLower = regex("^[a-z]$", "u")

const asciiUpper = regex("^[A-Z]$", "u")

const asciiDigit = regex("^[0-9]$", "u")

/**
 * Design 4.4's word split, as a walk: NFKD, then each code point a mark (dropped), an ASCII letter or digit (kept in its
 * word, a new word starting at a capital after a small letter), or anything else (ending the word).
 */
const wordsOf = (input: string): ReadonlyArray<string> => {
	const words: Array<string> = []
	let current = ""
	let previous = ""
	for (const char of Str.normalize("NFKD")(input)) {
		if (mark.test(char)) {
			continue
		}
		const alnum = asciiLower.test(char) || asciiUpper.test(char) || asciiDigit.test(char)
		if (!alnum || (asciiUpper.test(char) && asciiLower.test(previous))) {
			if (current !== "") {
				words.push(current)
			}
			current = alnum ? char : ""
		} else {
			current = Str.concat(current, char)
		}
		previous = alnum ? char : ""
	}
	if (current !== "") {
		words.push(current)
	}
	return words
}

const capitalized = (word: string): string =>
	`${Str.toUpperCase(Str.slice(0, 1)(word))}${Str.toLowerCase(Str.slice(1)(word))}`

/** A fold's answer: a name and its notes, or a refusal and why. */
export type Answer =
	| Readonly<{ kind: "named"; name: string; notes: ReadonlyArray<string> }>
	| Readonly<{ kind: "refused"; why: string }>

const inputOf = (c: FoldCase): string => Arr.join(c.pieces, "")

/** Design 4.4's folds, from the word split: kebab and identifier casing, the `n` prefix, the `_` suffix, file segments. */
const modelOf = (c: FoldCase): Answer => {
	const words = wordsOf(inputOf(c))
	if (!Arr.isReadonlyArrayNonEmpty(words)) {
		return { kind: "refused", why: "EmptyFold" }
	}
	const digitLed = asciiDigit.test(Str.slice(0, 1)(Arr.headNonEmpty(words)))
	const prefixed = digitLed && c.fold !== "segment" ? ["n", ...words] : words
	const notes = digitLed && c.fold !== "segment" ? ["DigitPrefix n"] : []
	switch (c.fold) {
		case "kebab":
			return { kind: "named", name: Arr.join(Arr.map(prefixed, Str.toLowerCase), "-"), notes }
		case "segment": {
			const segment = Arr.join(Arr.map(words, Str.toLowerCase), "-")
			return DEVICES.has(Str.toUpperCase(segment))
				? { kind: "refused", why: "UnsafeFileSegment device" }
				: segment.length > 64
					? { kind: "refused", why: "UnsafeFileSegment pattern" }
					: { kind: "named", name: segment, notes: [] }
		}
		case "camel":
		case "pascal": {
			const joined = Arr.join(
				Arr.map(prefixed, (word, index) =>
					c.fold === "camel" && index === 0 ? Str.toLowerCase(word) : capitalized(word)
				),
				""
			)
			return reservedIdentifiers.has(joined)
				? { kind: "named", name: `${joined}_`, notes: [...notes, "ReservedSuffix _"] }
				: { kind: "named", name: joined, notes }
		}
	}
}

/** What the module's folds answer for a case. */
const foldedOf = (c: FoldCase): Answer => {
	const input = inputOf(c)
	if (c.fold === "segment") {
		return Result.match(foldFileSegment(input), {
			onSuccess: (name): Answer => ({ kind: "named", name, notes: [] }),
			onFailure: (failure): Answer => ({
				kind: "refused",
				why: failure._tag === "EmptyFold" ? "EmptyFold" : `UnsafeFileSegment ${failure.reason}`
			})
		})
	}
	const folded = c.fold === "kebab" ? foldKebab(input) : foldIdentifier(input, c.fold)
	return Result.match(folded, {
		onSuccess: (success): Answer => ({
			kind: "named",
			name: success.name,
			notes: Arr.map(success.notes, (note) =>
				note._tag === "DigitPrefix" ? `DigitPrefix ${note.prefix}` : `ReservedSuffix ${note.suffix}`
			)
		}),
		onFailure: (failure): Answer => ({ kind: "refused", why: failure._tag })
	})
}

/** The laws a name a fold gives keeps: a kebab name folds to itself; an identifier and a segment are their brands'. */
const lawsOf = (c: FoldCase, answer: Answer): ReadonlyArray<string> => {
	if (answer.kind === "refused") {
		return []
	}
	switch (c.fold) {
		case "kebab":
			return Result.match(foldKebab(answer.name), {
				onSuccess: (again) => (again.name === answer.name ? [] : ["a kebab name folds to another"]),
				onFailure: () => ["a kebab name folds to nothing"]
			})
		case "camel":
		case "pascal":
			return isSafeIdentifier(answer.name) ? [] : ["an identifier that is no SafeIdentifier"]
		case "segment":
			return isSafeFileSegment(answer.name) ? [] : ["a segment that is no SafeFileSegment"]
	}
}

/** The brands' answers for the raw input itself: SafeIdentifier and SafeFileSegment membership. */
const brandsOf = (c: FoldCase): readonly [identifier: boolean, segment: boolean] => [
	isSafeIdentifier(inputOf(c)),
	isSafeFileSegment(inputOf(c))
]

const identifierPattern = regex("^[A-Za-z_$][A-Za-z0-9_$]*$", "u")

const segmentPattern = regex("^[a-z0-9][a-z0-9-]{0,63}$", "u")

/** Design 4.4's brands: an ASCII identifier no reserved word; a lowercase segment of at most 64 no device name. */
const expectedBrandsOf = (c: FoldCase): readonly [identifier: boolean, segment: boolean] => {
	const input = inputOf(c)
	const stem = Str.toUpperCase(Option.getOrElse(Arr.head(Str.split(".")(input)), () => ""))
	return [
		identifierPattern.test(input) && !reservedIdentifiers.has(input),
		segmentPattern.test(input) && !DEVICES.has(stem)
	]
}

/** The family a refused device name belongs to. */
const deviceFeature = (segment: string): Feature =>
	Str.startsWith("COM")(segment)
		? "a COM port refused"
		: Str.startsWith("LPT")(segment)
			? "an LPT port refused"
			: "a named device refused"

export const featuresOf = (c: FoldCase): ReadonlyArray<Feature> => {
	const answer = modelOf(c)
	const input = inputOf(c)
	const when = (holds: boolean, feature: Feature): ReadonlyArray<Feature> =>
		holds ? [feature] : []
	const words = wordsOf(input)
	return [
		...(answer.kind === "named"
			? [`a ${c.fold} fold` as const]
			: answer.why === "EmptyFold"
				? [`an empty ${c.fold} fold refused` as const]
				: []),
		...when(
			answer.kind === "named" && Arr.some(answer.notes, Str.startsWith("DigitPrefix")),
			"a leading digit prefixed"
		),
		...when(
			answer.kind === "named" && Arr.some(answer.notes, Str.startsWith("ReservedSuffix")),
			"a reserved word suffixed"
		),
		...(answer.kind === "refused" && answer.why === "UnsafeFileSegment device"
			? [deviceFeature(Str.toUpperCase(Arr.join(Arr.map(words, Str.toLowerCase), "-")))]
			: []),
		...when(
			answer.kind === "refused" && answer.why === "UnsafeFileSegment pattern",
			"a segment over 64 characters refused"
		),
		...when(
			Arr.some(Arr.fromIterable(Str.normalize("NFKD")(input)), (char) => mark.test(char)),
			"a mark dropped"
		),
		...when(
			Str.normalize("NFKD")(input) !== Str.normalize("NFD")(input),
			"a compatibility character decomposed"
		),
		...when(reservedIdentifiers.has(input), "a reserved word as a raw identifier"),
		...when(
			DEVICES.has(Str.toUpperCase(input)) && segmentPattern.test(input),
			"a device name as a raw segment"
		),
		...when(
			words.length >
				Arr.filter(
					Str.split(regex("[^A-Za-z0-9]+", "u"))(Str.normalize("NFKD")(input)),
					Str.isNonEmpty
				).length,
			"a lower-to-upper boundary split"
		)
	]
}

const pieceGen = element(PIECES)

const caseGen =
	(fold: Gen<Fold>, pieces: Gen<ReadonlyArray<string>>): Gen<FoldCase> =>
	(s) => ({ pieces: s.draw(pieces), fold: s.draw(fold) })

const anyFold = element<Fold>(["kebab", "camel", "pascal", "segment"])

const anyPieces = array(pieceGen, { min: 0, max: 4 })

const of = (fold: Fold, pieces: Gen<ReadonlyArray<string>>): Gen<FoldCase> =>
	caseGen(constant(fold), pieces)

const separators = array(element(["", "-", "日本", "😀", "\u202E", " "]), { min: 0, max: 2 })

/** Names under each fold, aimed at every fold's success and refusal and at each rule the fold applies. */
export const foldSpace: Aimed<FoldCase, Feature> = aimed(caseGen(anyFold, anyPieces), [
	...Arr.map(
		["kebab", "camel", "pascal", "segment"] as const,
		(fold) =>
			[
				`a ${fold} fold`,
				of(
					fold,
					map(pieceGen, (piece) => ["list", "-", "Users", piece])
				)
			] as const
	),
	...Arr.map(
		["kebab", "camel", "pascal", "segment"] as const,
		(fold) => [`an empty ${fold} fold refused`, of(fold, separators)] as const
	),
	[
		"a leading digit prefixed",
		caseGen(
			element<Fold>(["kebab", "camel", "pascal"]),
			map(anyPieces, (pieces) => ["2", "fa", ...pieces])
		)
	],
	[
		"a reserved word suffixed",
		caseGen(
			element<Fold>(["camel", "pascal"]),
			map(element(["class", "delete", "error", "keyof"]), (word) => [word])
		)
	],
	[
		"a named device refused",
		of(
			"segment",
			map(element(["con", "Nul", "prn", "aux.txt"]), (word) => [word])
		)
	],
	[
		"a COM port refused",
		of(
			"segment",
			map(element(["COM1", "com0", "Com9"]), (word) => [word])
		)
	],
	[
		"an LPT port refused",
		of(
			"segment",
			map(element(["lpt9", "LPT0", "lpt5"]), (word) => [word])
		)
	],
	[
		"a segment over 64 characters refused",
		of(
			"segment",
			constant(["abcdefghijklmnopqrstuvwxyzabcdefghijkl", "abcdefghijklmnopqrstuvwxyzabcdefghijkl"])
		)
	],
	["a mark dropped", caseGen(anyFold, constant(["Crème", "é"]))],
	[
		"a compatibility character decomposed",
		caseGen(
			anyFold,
			map(element(["ﬁ", "ｆｕｌｌ", "①"]), (piece) => ["list", "-", "Users", piece])
		)
	],
	["a lower-to-upper boundary split", caseGen(anyFold, constant(["list", "Users"]))],
	[
		"a reserved word as a raw identifier",
		caseGen(
			anyFold,
			map(element(["class", "delete", "keyof"]), (word) => [word])
		)
	],
	[
		"a device name as a raw segment",
		caseGen(
			anyFold,
			map(element(["con", "prn", "lpt9"]), (word) => [word])
		)
	]
])

/** A case's whole answer: its fold, the laws the fold's name breaks, and the brands' membership of the raw input. */
export type Outcome = Readonly<{
	folded: Answer
	broken: ReadonlyArray<string>
	brands: readonly [identifier: boolean, segment: boolean]
}>

export const actualOf = (c: FoldCase): Outcome => {
	const folded = foldedOf(c)
	return { folded, broken: lawsOf(c, folded), brands: brandsOf(c) }
}

export const expectedOf = (c: FoldCase): Outcome => ({
	folded: modelOf(c),
	broken: [],
	brands: expectedBrandsOf(c)
})

/** The Pascal fold the model gives a key, or none when it folds to nothing. */
const pascalOf = (key: string): Option.Option<string> => {
	const answer = modelOf({ pieces: [key], fold: "pascal" })
	return answer.kind === "named" ? Option.some(answer.name) : Option.none()
}

/**
 * Every name the domain module, a cli module or `cli/root.ts` holds besides domain names: the emitter's own lists, read
 * as rosters.
 */
const HELD: ReadonlySet<string> = new Set([
	domainNamespace[0],
	...fixedNamespaces,
	...rootModuleNames
])

/** Schema keys: plain and kebab names, keys folding alike, held names, reserved words, unfoldable keys, an inline pointer. */
const KEY_WORDS: Arr.NonEmptyReadonlyArray<string> = [
	"user",
	"User",
	"USER",
	"User2",
	"user_update",
	"my-schema",
	"Avatar",
	"Schema",
	"read",
	"Command",
	"Option",
	"Multipart",
	"Groups",
	"args",
	"services",
	"Error",
	"Error_",
	"string",
	"record",
	"Date",
	"_",
	"$",
	"Definition",
	"a-b",
	"a_b",
	"AB",
	"a b",
	"/paths/~1users/post/requestBody/content/application~1json/schema"
]

export type DomainFeature =
	| "keys folding alike"
	| "a held name"
	| "a reserved word"
	| "a key with nothing to fold"
	| "an inline pointer key"
	| "a suffixed name already taken"

/** Schema keys in the order a document lists them. */
export type DomainCase = ReadonlyArray<string>

/** A key's Pascal fold, Definition when it folds to nothing. */
const domainFoldOf = (key: string): string => Option.getOrElse(pascalOf(key), () => "Definition")

/**
 * Design 4.4's domain names: the keys once each in code-point order, each its Pascal fold (Definition when it folds to
 * nothing), a fold held or taken getting the first free numeric suffix from 2.
 */
export const expectedDomainOf = (keys: DomainCase): ReadonlyArray<readonly [string, string]> => {
	const assigned = new Set<string>()
	const taken = (name: string): boolean => HELD.has(name) || assigned.has(name)
	return Arr.map(Arr.sort(Arr.dedupe(keys), Order.String), (key) => {
		const base = domainFoldOf(key)
		const free = Option.getOrElse(
			Arr.findFirst(
				Array.from({ length: keys.length + HELD.size + 1 }, (_, index) => index + 2),
				(n) => !taken(`${base}${n}`)
			),
			() => 0
		)
		const name = taken(base) ? `${base}${free}` : base
		assigned.add(name)
		return [key, name] as const
	})
}

/** The module's names, read in its own order of keys and again from the keys reversed. */
export const actualDomainOf = (
	keys: DomainCase
): readonly [
	ReadonlyArray<readonly [string, string]>,
	ReadonlyArray<readonly [string, string]>
] => {
	const entriesOf = (names: ReadonlyMap<string, string>) =>
		Arr.sort(
			Arr.fromIterable(names.entries()),
			Order.mapInput(Order.String, ([key]: readonly [string, string]) => key)
		)
	return [entriesOf(domainIdentifiers(keys)), entriesOf(domainIdentifiers(Arr.reverse(keys)))]
}

export const domainFeaturesOf = (keys: DomainCase): ReadonlyArray<DomainFeature> => {
	const unique = Arr.dedupe(keys)
	const folds = Arr.map(unique, domainFoldOf)
	const when = (holds: boolean, feature: DomainFeature): ReadonlyArray<DomainFeature> =>
		holds ? [feature] : []
	const assigned = expectedDomainOf(keys)
	return [
		...when(Arr.dedupe(folds).length < folds.length, "keys folding alike"),
		...when(
			Arr.some(folds, (name) => HELD.has(name)),
			"a held name"
		),
		...when(
			Arr.some(unique, (key) => Option.exists(pascalOf(key), Str.endsWith("_"))),
			"a reserved word"
		),
		...when(
			Arr.some(unique, (key) => Option.isNone(pascalOf(key))),
			"a key with nothing to fold"
		),
		...when(Arr.some(unique, Str.startsWith("/")), "an inline pointer key"),
		...when(
			Arr.some(
				assigned,
				([key, name]) =>
					name !== domainFoldOf(key) &&
					Arr.some(
						assigned,
						([other, otherName]) =>
							otherName === domainFoldOf(key) && domainFoldOf(other) !== domainFoldOf(key)
					)
			),
			"a suffixed name already taken"
		)
	]
}

const keysGen = (words: Gen<string>): Gen<DomainCase> => array(words, { min: 1, max: 6 })

const keyWord = element(KEY_WORDS)

/** Key lists, aimed at alike folds, held names, reserved words, unfoldable keys, inline pointers and taken suffixes. */
export const domainSpace: Aimed<DomainCase, DomainFeature> = aimed(keysGen(keyWord), [
	["keys folding alike", map(keysGen(keyWord), (keys) => ["user", "User", ...keys])],
	["a held name", map(keysGen(keyWord), (keys) => [...keys, "Schema", "args"])],
	["a reserved word", map(keysGen(keyWord), (keys) => ["Error", "string", ...keys])],
	["a key with nothing to fold", map(keysGen(keyWord), (keys) => ["_", "$", ...keys])],
	[
		"an inline pointer key",
		map(keysGen(keyWord), (keys) => [
			"/paths/~1users/post/requestBody/content/application~1json/schema",
			...keys
		])
	],
	["a suffixed name already taken", constant(["user", "User", "User2", "USER"])]
])
