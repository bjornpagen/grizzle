/**
 * The rename declaration reader (packages/grizzle/src/cli/renames.ts) against D9's grammar, stated as a checker that
 * shares no code with it but the naming door's rule of a declared name (core/identity.ts parseDeclaredName) and its
 * reading of two names as one (declaredAlike):
 *
 * - a side is NAME (a relation), NAME.NAME (a field), NAME#HANDLE (a roster's handle) or @NAME (a login), where NAME
 *   is a declared name and HANDLE is text a PostgreSQL name holds: not empty, at most 63 UTF-8 bytes, with no NUL and
 *   no lone surrogate;
 * - a rename's readings are the splits of its text at one `=` into two sides of one kind; it parses exactly when it
 *   has one reading and its two sides are not one name, and then to that reading;
 * - a drop parses exactly when its text is a side;
 * - a command line's declarations parse exactly when each does, no old name is renamed or dropped twice, and no two
 *   renames share a new name, each kind kept in the order given;
 * - a handle rename's new roster resolves to the schema's roster whose name is alike, and one the schema lacks is
 *   refused, naming it.
 *
 * The spaces, generated: sides of every form, their names drawn from the identifier dictionary
 * (test/support/kernel/dict.ts), admitted and refused, alias groups among them, and the empty text; their handles from
 * a few letters, the signs `=`, `#`, `@` and `.`, characters of two, three and four UTF-8 bytes, a NUL and a lone
 * surrogate, short, straddling the 63 bytes a name holds, or holding a side of their own after an `=`, so a handle
 * rename splits two ways; renames of two sides, of two sides of one form, of a side and itself, and of a handle that
 * holds a side; command lines of up to three renames and two drops over a pool of three sides of one form, so swaps,
 * chains, repeats and merges arise, alike names among them; and handle renames to the schema's rosters, respelled
 * alike, or to a roster it may lack.
 */
import { describe, it } from "@effect/vitest"
import { type Case, drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import {
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
} from "@grizzle/testing/gen"
import { passed } from "@grizzle/testing/lsw"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Result, String as Str } from "effect"
import {
	type DeclarationRefused,
	parseDeclarations,
	parseDrop,
	parseRename,
	rosterRenames
} from "#cli/renames.ts"
import {
	conversionOf,
	type DeclaredName,
	declaredAlike,
	parseDeclaredName
} from "#compiler/core/identity.ts"
import { handleMaxBytes } from "#compiler/core/limits.ts"
import type { Named, Rename } from "#compiler/deploy/diff/plan.ts"
import { Roster } from "#compiler/ir/scalar.ts"
import { assert, deepEquals, defined, nonEmpty, succeeded } from "#test/support/assert.ts"
import { aliasGroups, dictionaryNameGen, refusedNames } from "#test/support/kernel/dict.ts"
import { caseHang } from "#test/support/limits.ts"
import { upTo } from "#test/support/up-to.ts"

/** A name the checker reads, through the naming door. */
const parsedName = (name: string): DeclaredName => succeeded(parseDeclaredName(name))

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
		int(
			Math.floor((handleMaxBytes.value - 3) / width),
			Math.ceil((handleMaxBytes.value + 3) / width)
		)
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
const sideGen: Gen<string> = oneOf(forms)

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

/** D9's NAME: a declared name. */
const isName = (text: string): boolean => parseDeclaredName(text).ok

/** D9's HANDLE: what a PostgreSQL name holds, 63 bytes of UTF-8 at most. */
const isHandle = (text: string): boolean =>
	!Str.isEmpty(text) &&
	!Str.includes("\u0000")(text) &&
	text.isWellFormed() &&
	new TextEncoder().encode(text).length <= handleMaxBytes.value

/** The text before the first `sign` of `text` and the text after it, or none where it holds none. */
const around = (text: string, sign: string): readonly [string, string] | undefined => {
	const units = Str.split(text, "")
	const at = units.indexOf(sign)
	return at < 0
		? undefined
		: [Arr.join(Arr.take(units, at), ""), Arr.join(Arr.drop(units, at + 1), "")]
}

/** A side's text read as D9 reads it, or none: a `#` makes a handle, a leading `@` a login, a `.` a field. */
const sideOf = (text: string): Named | undefined => {
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
const sameSide = (a: Named, b: Named): boolean => {
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
const readingsOf = (text: string): ReadonlyArray<Rename> => {
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
const renameRuling = (text: string): Rename | undefined => {
	const [only, ...more] = readingsOf(text)
	return only === undefined || more.length > 0 || sameSide(only.from, only.to) ? undefined : only
}

/** Whether two of `sides` are one name by `same`. */
const repeatsBy = (sides: ReadonlyArray<Named>, same: (a: Named, b: Named) => boolean): boolean =>
	Arr.some(sides, (a, at) => Arr.some(Arr.drop(sides, at + 1), (b) => same(a, b)))

/** Whether two of `sides` are one name. */
const repeats = (sides: ReadonlyArray<Named>): boolean => repeatsBy(sides, sameSide)

type Spelled =
	| "a parsed rename"
	| "a parsed login rename"
	| "a parsed handle rename"
	| "a refused rename"
	| "an ambiguous rename"
	| "an unchanged rename"
	| "an alike rename refused"

type Dropped = "a parsed drop" | "a parsed login drop" | "a parsed handle drop" | "a refused drop"

type Listed = "parsed" | "twice" | "merged" | "refused" | "an alike repeat"

/** The verdict a refusal or a parse is, as the features count it. */
const verdictOf = (result: Result.Result<unknown, DeclarationRefused>): string =>
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

/**
 * A command line over a pool of three sides of one form, their names declared names of three conversions, so no two
 * are one name, each second part one or two letters: up to three renames, each from one side to another or from a side
 * to itself, and up to two drops, each naming a side as pooled or respelled alike where its alias group allows.
 */
const listingGen: Gen<Listing> = (source) => {
	const form = source.draw(element(poolForms))
	const pool = nonEmpty(
		Arr.map(
			source.draw(uniqueArray(declaredGen, (n) => conversionOf(n), { min: 3, max: 3 }, 8)),
			(name) => ({ name, second: source.draw(lettersGen) })
		),
		"the pool"
	)
	const pooledAt = (at: number) => defined(pool[at], "a pooled side")
	const spelled =
		(at: number): Gen<string> =>
		(inner) => {
			const side = pooledAt(at)
			const name = inner.draw(
				weighted<string>([
					[3, constant(side.name)],
					[1, alikeOf(side.name)]
				])
			)
			return form(name, side.second)
		}
	const index = int(0, pool.length - 1)
	const renamed: Gen<string> = weighted<string>([
		[
			4,
			(inner) => {
				const from = inner.draw(index)
				const to = (from + inner.draw(int(1, pool.length - 1))) % pool.length
				return `${inner.draw(spelled(from))}=${inner.draw(spelled(to))}`
			}
		],
		[
			1,
			(inner) => {
				const at = inner.draw(index)
				return `${inner.draw(spelled(at))}=${inner.draw(spelled(at))}`
			}
		]
	])
	return {
		renames: source.draw(array(renamed, { min: 0, max: 3 })),
		drops: source.draw(array((inner) => inner.draw(spelled(inner.draw(index))), { min: 0, max: 2 }))
	}
}

/**
 * D9's ruling on a command line: refused where a declaration does not parse; else where an old name repeats, or two
 * renames share a new one; else parsed.
 */
const listRuling = (listing: Listing): Exclude<Listed, "an alike repeat"> => {
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
const listingFeatures = (listing: Listing): ReadonlyArray<Listed> => {
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

/** How many candidates a steered case draws for a command line that reaches a pending situation. */
const aimCandidates = 32

/**
 * The command line a case reads: the drawn one, or, where steering names situations no case has reached, the first of
 * up to `aimCandidates` further draws that reaches one, else the drawn one.
 */
const aimedListing = (drawnListing: Listing, c: Case<Listed>): Listing =>
	Option.match(c.steering, {
		onNone: () => drawnListing,
		onSome: (pending) => {
			const reaches = (l: Listing) => Arr.some(listingFeatures(l), (f) => pending.has(f))
			return reaches(drawnListing)
				? drawnListing
				: Option.getOrElse(
						Arr.findFirst(
							c.draw(array(listingGen, { min: aimCandidates, max: aimCandidates })),
							reaches
						),
						() => drawnListing
					)
		}
	})

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
const rosterCaseGen: Gen<RosterCase> = (source) => {
	const rosters = nonEmpty(
		source.draw(uniqueArray(declaredGen, (n) => conversionOf(n), { min: 1, max: 2 }, 8)),
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

type Resolved = "resolved" | "resolved alike" | "two rosters" | "unknown"

describe("the rename declaration reader", () => {
	it.effect(
		"reads every rename as D9 does: one reading of two sides that are not one name, or a refusal",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/cli/renames-spelling",
						draw: drawn(renameGen),
						literal: Formatter.format,
						coverage: required<Spelled>(
							[
								"a parsed rename",
								"a parsed login rename",
								"a parsed handle rename",
								"a refused rename",
								"an ambiguous rename",
								"an unchanged rename",
								"an alike rename refused"
							],
							{ cases: 300, sense: notesOnly }
						),
						kept: [],
						runs: 300,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang,
						oracle: { kind: "specification", name: "D9's grammar, read as every split at an =" }
					},
					([from, to], c) =>
						Effect.sync(() => {
							const text = `${from}=${to}`
							const read = parseRename(text)
							const readings = readingsOf(text)
							const ruling = renameRuling(text)
							if (readings.length > 1) {
								c.note("an ambiguous rename")
							}
							if (ruling === undefined) {
								assert.ok(Result.isFailure(read), `D9 refuses ${Formatter.format(text)}`)
								const [only] = readings
								if (readings.length === 1 && only !== undefined && sameSide(only.from, only.to)) {
									c.note("an unchanged rename")
									if (!deepEquals(only.from, only.to)) {
										c.note("an alike rename refused")
									}
								}
								c.note("a refused rename")
								return
							}
							assert.deepEqual(succeeded(read), ruling, `D9 reads ${Formatter.format(text)}`)
							c.note("a parsed rename")
							if (ruling.from.kind === "login") {
								c.note("a parsed login rename")
							}
							if (ruling.from.kind === "handle") {
								c.note("a parsed handle rename")
							}
						})
				)
			)
	)

	it.effect("reads every drop as D9 reads a side, and a rename of one side as a refusal", (ctx) =>
		searched(
			ctx,
			explore(
				{
					suite: "unit/cli/renames-drop",
					draw: drawn(sideGen),
					literal: Formatter.format,
					coverage: required<Dropped>(
						["a parsed drop", "a parsed login drop", "a parsed handle drop", "a refused drop"],
						{ cases: 200, sense: notesOnly }
					),
					kept: [],
					runs: 200,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang,
					oracle: { kind: "specification", name: "D9's grammar of a side" }
				},
				(text, c) =>
					Effect.sync(() => {
						const side = sideOf(text)
						const read = parseDrop(text)
						if (side === undefined) {
							assert.ok(Result.isFailure(read), `D9 refuses ${Formatter.format(text)}`)
							c.note("a refused drop")
						} else {
							assert.deepEqual(succeeded(read), side)
							c.note("a parsed drop")
							if (side.kind === "login") {
								c.note("a parsed login drop")
							}
							if (side.kind === "handle") {
								c.note("a parsed handle drop")
							}
						}
						assert.equal(
							Result.isSuccess(parseRename(text)),
							renameRuling(text) !== undefined,
							"a rename of one side parses only where a handle holds its ="
						)
					})
			)
		)
	)

	it.effect(
		"refuses a command line that renames or drops a name twice, or renames two to one",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/cli/renames-lists",
						draw: drawn(listingGen),
						literal: Formatter.format,
						coverage: required<Listed>(
							["parsed", "twice", "merged", "refused", "an alike repeat"],
							{ cases: 300, sense: notesOnly }
						),
						kept: [],
						runs: 300,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang,
						oracle: {
							kind: "specification",
							name: "D9: one declaration per old name and per new name, names alike being one"
						}
					},
					(drawnListing, c) =>
						Effect.sync(() => {
							const listing = aimedListing(drawnListing, c)
							const ruling = listRuling(listing)
							const read = parseDeclarations(listing.renames, listing.drops)
							c.noteAll(listingFeatures(listing))
							if (ruling === "refused") {
								assert.ok(
									Result.isFailure(read) &&
										read.failure.fault.kind !== "twice" &&
										read.failure.fault.kind !== "merged",
									"a declaration that does not parse refuses the command line"
								)
								return
							}
							if (ruling === "parsed") {
								assert.deepEqual(succeeded(read), {
									renames: Arr.map(listing.renames, (r) => succeeded(parseRename(r))),
									drops: Arr.map(listing.drops, (d) => succeeded(parseDrop(d)))
								})
								return
							}
							assert.equal(verdictOf(read), ruling)
						})
				)
			)
	)

	it.effect(
		"resolves a handle rename's roster to the schema's alike one, and refuses one it lacks",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/cli/renames-rosters",
						draw: drawn(rosterCaseGen),
						literal: Formatter.format,
						coverage: required<Resolved>(["resolved", "resolved alike", "two rosters", "unknown"], {
							cases: 200,
							sense: notesOnly
						}),
						kept: [],
						runs: 200,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang,
						oracle: { kind: "specification", name: "declaredAlike rosters are one roster" }
					},
					(r, c) =>
						Effect.sync(() => {
							if (r.rosters.length > 1) {
								c.note("two rosters")
							}
							const declared = succeeded(
								parseDeclarations(
									Arr.map(r.renames, (to, at) => `Kind#h${at}=${to.roster}#${to.handle}`),
									[]
								)
							)
							const schema = Arr.map(r.rosters, (name) => parsedName(name))
							const resolved = rosterRenames(
								declared,
								Arr.map(schema, (closed) => new Roster(closed, ["n0"]))
							)
							const expected = new Map<DeclaredName, Map<string, string>>()
							for (const [at, to] of r.renames.entries()) {
								const roster = Arr.findFirst(schema, (closed) =>
									declaredAlike(closed, parsedName(to.roster))
								)
								if (Option.isNone(roster)) {
									assert.ok(
										Result.isFailure(resolved) &&
											resolved.failure.fault.kind === "unknownRoster" &&
											resolved.failure.fault.roster === to.roster,
										`${to.roster} is no roster of the schema`
									)
									c.note("unknown")
									return
								}
								if (roster.value !== to.roster) {
									c.note("resolved alike")
								}
								const handles = expected.get(roster.value) ?? new Map<string, string>()
								handles.set(`h${at}`, to.handle)
								expected.set(roster.value, handles)
							}
							assert.deepEqual(succeeded(resolved), expected)
							c.note("resolved")
						})
				)
			)
	)
})
