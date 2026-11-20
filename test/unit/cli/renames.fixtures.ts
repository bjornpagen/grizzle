/** What the properties of renames.test.ts read: its spaces, models and helpers. */

import { deepEquals, defined, nonEmpty } from "@bjornpagen/testing/assert"
import {
	aimed,
	array,
	characterOf,
	constant,
	element,
	type Gen,
	int,
	map,
	oneOf,
	string,
	uniqueArray,
	weighted
} from "@bjornpagen/testing/gen"
import { passed } from "@bjornpagen/testing/lsw"
import { Array as Arr, Option, Result, String as Str } from "effect"
import type { DeclarationRefused } from "#cli/renames.ts"
import type { Named } from "#compiler/core/errors.ts"
import {
	conversionOf,
	declaredAlike,
	type DeclaredName,
	parseDeclaredName
} from "#compiler/core/identity.ts"
import type { Rename } from "#compiler/deploy/diff/plan.ts"
import { handleMaxBytes } from "#compiler/schema/own.ts"
import { succeeded } from "#test/support/assert.ts"
import {
	admittedNames,
	aliasGroups,
	dictionaryNameGen,
	refusedNames
} from "#test/support/kernel/dict.ts"
import { upTo } from "#test/support/up-to.ts"

/** A name the checker reads, through the naming door. */
export const parsedName = (name: string): DeclaredName => succeeded(parseDeclaredName(name))

/** A text the library's wild values make, passed as a boundary is handed it. */
const wildText = (value: unknown): string => {
	if (typeof value !== "string") {
		throw new Error("a lone surrogate's and a NUL's wild value is a string")
	}
	return value
}
const loneSurrogate = wildText(
	passed({ kind: "wild", wild: { kind: "lone-surrogate", before: "a", unit: 0xd8_00, after: "" } })
)
const nul = wildText(
	passed({ kind: "wild", wild: { kind: "nul-character", before: "a", after: "b" } })
)

/** The dictionary's alias groups: admitted names that convert to one identifier. */
const groups = nonEmpty(aliasGroups, "an alias group")

/** The dictionary's refused names. */
const refused = nonEmpty(refusedNames, "a refused name")

/** A declared name of the dictionary: an admitted name by its feature, or a name of an alias group. */
const declaredGen: Gen<string> = weighted([
	[3, map(dictionaryNameGen, (n) => n.declared)],
	[1, (source) => source.draw(element(source.draw(element(groups))))]
])

/** A conversion of a declared name, drawn as declaredGen draws its name. */
const conversionGen: Gen<string> = map(declaredGen, conversionOf)

/** A declared name of the dictionary whose conversion is `conversion`, each such name equally often. */
const declaredOf = (conversion: string): Gen<string> =>
	element(
		nonEmpty(
			Arr.filter(
				Arr.map(admittedNames, (n) => n.declared),
				(declared) => conversionOf(declared) === conversion
			),
			"a declared name of the conversion"
		)
	)

/** A name token: a declared name, a name the naming door refuses, or the empty text. */
const nameGen: Gen<string> = weighted([
	[6, declaredGen],
	[2, map(element(refused), (n) => n.declared)],
	[1, constant("")]
])

/** One or two letters: a short handle every side may hold. */
const lettersGen: Gen<string> = string(characterOf(["a", "b"]), { min: 1, max: 2 })

/**
 * A handle's characters: letters, the signs a side is read by, characters of two, three and four UTF-8 bytes, a NUL and
 * a lone surrogate.
 */
const handleCharacters = [
	"a",
	"b",
	"K",
	"=",
	"#",
	"@",
	".",
	"-",
	"é",
	"€",
	"😀",
	nul,
	loneSurrogate
] as const

/** A handle straddling the bytes a name holds: one character repeated to within three bytes of the bound either way. */
const longHandleGen: Gen<string> = (source) => {
	const character = source.draw(element(["h", "é", "€", "😀"] as const))
	const width = new TextEncoder().encode(character).length
	const count = source.draw(
		int(Math.floor((handleMaxBytes - 3) / width), Math.ceil((handleMaxBytes + 3) / width))
	)
	return Str.repeat(count)(character)
}

/** A handle's text: short, long, or holding a side of its own after an `=`. */
const handleGen: Gen<string> = weighted([
	[4, string(characterOf(handleCharacters), { min: 0, max: 4 })],
	[1, longHandleGen],
	[1, (source) => `${source.draw(lettersGen)}=${source.draw(nameGen)}#${source.draw(lettersGen)}`]
])

/** A side of each form, its tokens drawn by `name` and `handle`. */
const formsOf = (
	name: Gen<string>,
	handle: Gen<string>
): Arr.NonEmptyReadonlyArray<Gen<string>> => [
	name,
	(source) => `${source.draw(name)}.${source.draw(name)}`,
	(source) => `${source.draw(name)}#${source.draw(handle)}`,
	(source) => `@${source.draw(name)}`
]

/** The forms of a side over every token. */
const forms = formsOf(nameGen, handleGen)

/** A side of any form. */
export const sideGen: Gen<string> = oneOf(forms)

/**
 * A rename's two sides: two of any form, two of one form, a side and itself, two of one form named from one alias
 * group, or a handle side holding a side after an `=` beside another handle side, which splits two ways where both
 * are handles.
 */
const renameGen: Gen<readonly [string, string]> = weighted<readonly [string, string]>([
	[3, (source) => [source.draw(sideGen), source.draw(sideGen)]],
	[
		3,
		(source) => {
			const form = source.draw(element(forms))
			return [source.draw(form), source.draw(form)]
		}
	],
	[
		1,
		(source) => {
			const side = source.draw(sideGen)
			return [side, side]
		}
	],
	[
		1,
		(source) => {
			const form = source.draw(element(formsOf(element(source.draw(element(groups))), lettersGen)))
			return [source.draw(form), source.draw(form)]
		}
	],
	[
		1,
		(source) => [
			`${source.draw(declaredGen)}#${source.draw(lettersGen)}=${source.draw(declaredGen)}#${source.draw(lettersGen)}`,
			`${source.draw(declaredGen)}#${source.draw(lettersGen)}`
		]
	]
])

/**
 * A handle rename whose two sides are one name spelled apart: one handle of one roster, the roster spelled by two names
 * of one alias group.
 */
const alikeHandleGen: Gen<readonly [string, string]> = (source) => {
	const group = source.draw(element(groups))
	const from = source.draw(element(group))
	const to = source.draw(
		element(
			nonEmpty(
				Arr.filter(group, (name) => name !== from),
				"another spelling alike"
			)
		)
	)
	const handle = source.draw(lettersGen)
	return [`${from}#${handle}`, `${to}#${handle}`]
}

/** The renames a case reads: a drawn one, or, while it is pending, a handle rename whose sides are one name spelled apart. */
export const renameSpace = aimed(renameGen, [["an alike handle rename refused", alikeHandleGen]])

/** D9's NAME: a declared name. */
const isName = (text: string): boolean => parseDeclaredName(text).ok

/** D9's HANDLE: what a PostgreSQL name holds, 63 bytes of UTF-8 at most. */
const isHandle = (text: string): boolean =>
	!Str.isEmpty(text) &&
	!Str.includes("\u0000")(text) &&
	text.isWellFormed() &&
	new TextEncoder().encode(text).length <= handleMaxBytes

/** The text before the first `sign` of `text` and the text after it, or none where it holds none. */
const around = (text: string, sign: string): readonly [string, string] | undefined => {
	const units = Str.split(text, "")
	const at = units.indexOf(sign)
	return at < 0
		? undefined
		: [Arr.join(Arr.take(units, at), ""), Arr.join(Arr.drop(units, at + 1), "")]
}

/** A side's text read as D9 reads it, or none: a `#` makes a handle, a leading `@` a login, a `.` a field. */
export const sideOf = (text: string): Named | undefined => {
	const handle = around(text, "#")
	if (handle !== undefined) {
		const [roster, h] = handle
		return isName(roster) && isHandle(h)
			? { kind: "handle", roster: parsedName(roster), handle: h }
			: undefined
	}
	const login = around(text, "@")
	if (login !== undefined) {
		const [before, name] = login
		return Str.isEmpty(before) && isName(name)
			? { kind: "login", login: parsedName(name) }
			: undefined
	}
	const field = around(text, ".")
	if (field !== undefined) {
		const [relation, f] = field
		return isName(relation) && isName(f)
			? { kind: "field", relation: parsedName(relation), field: parsedName(f) }
			: undefined
	}
	return isName(text) ? { kind: "relation", relation: parsedName(text) } : undefined
}

/** Whether two sides are one name: of one kind, their declared names alike, a handle's text exactly. */
export const sameSide = (a: Named, b: Named): boolean => {
	switch (a.kind) {
		case "relation":
			return b.kind === "relation" && declaredAlike(a.relation, b.relation)
		case "field":
			return (
				b.kind === "field" &&
				declaredAlike(a.relation, b.relation) &&
				declaredAlike(a.field, b.field)
			)
		case "handle":
			return b.kind === "handle" && declaredAlike(a.roster, b.roster) && a.handle === b.handle
		case "login":
			return b.kind === "login" && declaredAlike(a.login, b.login)
	}
}

/** Every reading of a rename's text: each `=` it splits at into two sides of one kind. */
export const readingsOf = (text: string): ReadonlyArray<Rename> => {
	const units = Str.split(text, "")
	const readings: Array<Rename> = []
	for (const [at, unit] of units.entries()) {
		if (unit !== "=") {
			continue
		}
		const from = sideOf(Arr.join(Arr.take(units, at), ""))
		const to = sideOf(Arr.join(Arr.drop(units, at + 1), ""))
		if (from !== undefined && to !== undefined && from.kind === to.kind) {
			readings.push({ from, to })
		}
	}
	return readings
}

/** What D9 makes of a rename's text: its one reading of two sides that are not one name, or a refusal. */
export const renameRuling = (text: string): Rename | undefined => {
	const [only, ...more] = readingsOf(text)
	return only === undefined || more.length > 0 || sameSide(only.from, only.to) ? undefined : only
}

/** Whether two of `sides` are one name by `same`. */
const repeatsBy = (sides: ReadonlyArray<Named>, same: (a: Named, b: Named) => boolean): boolean =>
	Arr.some(sides, (a, at) => Arr.some(Arr.drop(sides, at + 1), (b) => same(a, b)))

/** Whether two of `sides` are one name. */
const repeats = (sides: ReadonlyArray<Named>): boolean => repeatsBy(sides, sameSide)

export type Spelled =
	| "a parsed rename"
	| "a parsed login rename"
	| "a parsed handle rename"
	| "a refused rename"
	| "an ambiguous rename"
	| "an unchanged rename"
	| "an alike rename refused"
	| "an alike handle rename refused"

export type Dropped =
	| "a parsed drop"
	| "a parsed login drop"
	| "a parsed handle drop"
	| "a refused drop"

export type Listed = "parsed" | "twice" | "merged" | "refused" | "an alike repeat"

/** The verdict a refusal or a parse is, as the features count it. */
export const verdictOf = (result: Result.Result<unknown, DeclarationRefused>): string =>
	Result.isSuccess(result) ? "parsed" : result.failure.fault.kind

/** A command line's renames and drops, as `--rename` and `--drop` values. */
interface Listing {
	readonly renames: ReadonlyArray<string>
	readonly drops: ReadonlyArray<string>
}

/** A spelling of `name` as alike as its alias group allows: another of its group, or itself. */
const alikeOf =
	(name: string): Gen<string> =>
	(source) =>
		Option.match(
			Arr.findFirst(groups, (group) => Arr.contains(group, name)),
			{ onNone: () => name, onSome: (group) => source.draw(element(group)) }
		)

/** A side's spelling from its name and its second part: a relation, a field, a handle or a login. */
type PoolForm = (name: string, second: string) => string

/** The forms a pool's sides take, the second part a field's name or a handle's text. */
const poolForms: Arr.NonEmptyReadonlyArray<PoolForm> = [
	(name) => name,
	(name, second) => `${name}.${second}`,
	(name, second) => `${name}#${second}`,
	(name) => `@${name}`
]

/** A pooled side: its declared name and its second part, a field's name or a handle's text. */
interface Pooled {
	readonly name: string
	readonly second: string
}

/** Three sides of one form, their names declared names of three conversions, so no two are one name. */
interface Pool {
	readonly form: PoolForm
	readonly sides: Arr.NonEmptyReadonlyArray<Pooled>
}

/** A pool of three sides of one form, each second part one or two letters. */
const poolGen: Gen<Pool> = (source) => {
	const form = source.draw(element(poolForms))
	const sides = nonEmpty(
		Arr.map(source.draw(uniqueArray(conversionGen, declaredOf, { min: 3, max: 3 })), (name) => ({
			name,
			second: source.draw(lettersGen)
		})),
		"the pool"
	)
	return { form, sides }
}

/** The pooled side at `at`, its name as pooled or respelled alike where its alias group allows. */
const spelledIn =
	(pool: Pool, at: number): Gen<string> =>
	(source) => {
		const side = defined(pool.sides[at], "a pooled side")
		const name = source.draw(
			weighted<string>([
				[3, constant(side.name)],
				[1, alikeOf(side.name)]
			])
		)
		return pool.form(name, side.second)
	}

/** A place in the pool. */
const placeGen = (pool: Pool): Gen<number> => int(0, pool.sides.length - 1)

/** Another place in the pool than `from`: `from` moved on by one or two around the pool. */
const otherThan =
	(pool: Pool, from: number): Gen<number> =>
	(source) =>
		(from + source.draw(int(1, pool.sides.length - 1))) % pool.sides.length

/** A rename from the pooled side at `from` to the one at `to`. */
const renameIn =
	(pool: Pool, from: number, to: number): Gen<string> =>
	(source) =>
		`${source.draw(spelledIn(pool, from))}=${source.draw(spelledIn(pool, to))}`

/**
 * A command line over a pool of three sides of one form: up to three renames, each from one side to another or from a
 * side to itself, and up to two drops, each naming a side as pooled or respelled alike where its alias group allows.
 */
const listingGen: Gen<Listing> = (source) => {
	const pool = source.draw(poolGen)
	const renamed: Gen<string> = weighted<string>([
		[
			4,
			(inner) => {
				const from = inner.draw(placeGen(pool))
				return inner.draw(renameIn(pool, from, inner.draw(otherThan(pool, from))))
			}
		],
		[
			1,
			(inner) => {
				const at = inner.draw(placeGen(pool))
				return inner.draw(renameIn(pool, at, at))
			}
		]
	])
	return {
		renames: source.draw(array(renamed, { min: 0, max: 3 })),
		drops: source.draw(
			array((inner) => inner.draw(spelledIn(pool, inner.draw(placeGen(pool)))), { min: 0, max: 2 })
		)
	}
}

/** A command line every declaration of which parses, each name once: one rename from a side to another. */
const parsedGen: Gen<Listing> = (source) => {
	const pool = source.draw(poolGen)
	const from = source.draw(placeGen(pool))
	return {
		renames: [source.draw(renameIn(pool, from, source.draw(otherThan(pool, from))))],
		drops: []
	}
}

/** A command line renaming a side to itself, which no declaration reading takes. */
const refusedGen: Gen<Listing> = (source) => {
	const pool = source.draw(poolGen)
	const at = source.draw(placeGen(pool))
	return { renames: [source.draw(renameIn(pool, at, at))], drops: [] }
}

/** A command line renaming a side and dropping it too: one old name declared twice. */
const twiceGen: Gen<Listing> = (source) => {
	const pool = source.draw(poolGen)
	const from = source.draw(placeGen(pool))
	return {
		renames: [source.draw(renameIn(pool, from, source.draw(otherThan(pool, from))))],
		drops: [source.draw(spelledIn(pool, from))]
	}
}

/** A command line renaming two sides to the third: two old names merged into one new name. */
const mergedGen: Gen<Listing> = (source) => {
	const pool = source.draw(poolGen)
	const to = source.draw(placeGen(pool))
	const first = (to + 1) % pool.sides.length
	const second = (to + 2) % pool.sides.length
	return {
		renames: [source.draw(renameIn(pool, first, to)), source.draw(renameIn(pool, second, to))],
		drops: []
	}
}

/** A conversion of an alias group: a name of more than one spelling. */
const aliasedConversionGen: Gen<string> = (source) =>
	conversionOf(Arr.headNonEmpty(source.draw(element(groups))))

/**
 * A command line renaming a side spelled one way and dropping it spelled another way alike: one old name declared twice
 * under two spellings, its name of an alias group, the rename's new side of another conversion.
 */
const alikeRepeatGen: Gen<Listing> = (source) => {
	const form = source.draw(element(poolForms))
	const [renamed, target] = source.draw(
		uniqueArray(aliasedConversionGen, declaredOf, { min: 2, max: 2 })
	)
	const old = defined(renamed, "the renamed side's name")
	const group = defined(
		Option.getOrUndefined(Arr.findFirst(groups, (g) => Arr.contains(g, old))),
		"the renamed name's alias group"
	)
	const respelled = source.draw(
		element(
			nonEmpty(
				Arr.filter(group, (name) => name !== old),
				"another spelling alike"
			)
		)
	)
	const second = source.draw(lettersGen)
	return {
		renames: [
			`${form(old, second)}=${form(defined(target, "the new side's name"), source.draw(lettersGen))}`
		],
		drops: [form(respelled, second)]
	}
}

/**
 * D9's ruling on a command line: refused where a declaration does not parse; else where an old name repeats, or two
 * renames share a new one; else parsed.
 */
export const listRuling = (listing: Listing): Exclude<Listed, "an alike repeat"> => {
	const renames = Arr.map(listing.renames, renameRuling)
	const drops = Arr.map(listing.drops, sideOf)
	const parsedRenames = Arr.filter(renames, (r) => r !== undefined)
	const parsedDrops = Arr.filter(drops, (d) => d !== undefined)
	if (parsedRenames.length < renames.length || parsedDrops.length < drops.length) {
		return "refused"
	}
	if (repeats([...Arr.map(parsedRenames, (r) => r.from), ...parsedDrops])) {
		return "twice"
	}
	return repeats(Arr.map(parsedRenames, (r) => r.to)) ? "merged" : "parsed"
}

/** What a command line reaches: its ruling, and a repeat of names alike but spelled apart. */
export const listingFeatures = (listing: Listing): ReadonlyArray<Listed> => {
	const ruling = listRuling(listing)
	if (ruling !== "twice" && ruling !== "merged") {
		return [ruling]
	}
	const renames = Arr.filter(Arr.map(listing.renames, renameRuling), (r) => r !== undefined)
	const sides =
		ruling === "twice"
			? [
					...Arr.map(renames, (r) => r.from),
					...Arr.filter(Arr.map(listing.drops, sideOf), (d) => d !== undefined)
				]
			: Arr.map(renames, (r) => r.to)
	return repeatsBy(sides, deepEquals) ? [ruling] : [ruling, "an alike repeat"]
}

/**
 * The command lines a case reads: a drawn one, or, for a witness while a situation is pending, one constructed to reach
 * it.
 */
export const listingSpace = aimed(listingGen, [
	["parsed", parsedGen],
	["twice", twiceGen],
	["merged", mergedGen],
	["refused", refusedGen],
	["an alike repeat", alikeRepeatGen]
])

/** A handle rename's new side: a roster and a handle. */
interface Renamed {
	readonly roster: string
	readonly handle: string
}

/** The schema's rosters, of different conversions, and handle renames from a roster's old handles to rosters. */
interface RosterCase {
	readonly rosters: Arr.NonEmptyReadonlyArray<string>
	readonly renames: Arr.NonEmptyReadonlyArray<Renamed>
}

/**
 * One or two rosters of different conversions, and one to three handle renames, each to one of them spelled alike or to
 * a declared name the schema may lack, each from and to its own handle.
 */
export const rosterCaseGen: Gen<RosterCase> = (source) => {
	const rosters = nonEmpty(
		source.draw(uniqueArray(conversionGen, declaredOf, { min: 1, max: 2 })),
		"a roster"
	)
	const count = source.draw(int(1, 3))
	const renames = nonEmpty(
		upTo(count, (at) => ({
			roster: source.draw(
				weighted([
					[3, (inner) => inner.draw(alikeOf(inner.draw(element(rosters))))],
					[1, declaredGen]
				])
			),
			handle: `n${at}`
		})),
		"a handle rename"
	)
	return { rosters, renames }
}

export type Resolved = "resolved" | "resolved alike" | "two rosters" | "unknown"
