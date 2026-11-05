/**
 * The rename declaration reader (packages/grizzle/src/cli/renames.ts) against D9's grammar, stated as a checker that
 * shares no code with it:
 *
 * - a side is NAME (a relation), NAME.NAME (a field), NAME#HANDLE (a roster's handle) or @NAME (a login), where NAME
 *   is an ASCII letter, then ASCII letters, digits and underscores, and HANDLE is text a PostgreSQL name holds: not
 *   empty, at most 63 UTF-8 bytes, with no NUL and no lone surrogate;
 * - a rename's readings are the splits of its text at one `=` into two sides of one kind; it parses exactly when it
 *   has one reading and its two sides differ, and then to that reading;
 * - a drop parses exactly when its text is a side;
 * - a command line's declarations parse exactly when each does, no old name is renamed or dropped twice, and no two
 *   renames share a new name, each kind kept in the order given;
 * - a handle rename's new roster resolves to the schema's roster whose name is alike, and one the schema lacks is
 *   refused.
 *
 * The boxes, exhausted: every rename of two sides and every single side, each side of every form over seven name
 * tokens and eleven handle tokens (the valid ones beside the empty text, a leading underscore, a hyphen, a non-ASCII
 * letter, a NUL and a lone surrogate from the library's wild values, and handles of 63 bytes and one byte more), the
 * handle tokens holding `=`, `#`, `@` and `=Kind#` so a handle rename splits two ways and a handle holds a login's
 * sign; every list of up to three renames and two drops over a pool holding a swap, a chain, a repeat, a merge and a
 * login's rename and drop; and every roster a handle rename can name.
 * The names of the pools are pairwise not alike, so the checker compares them as text.
 */
import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { array, element, type Gen } from "@grizzle/testing/gen"
import { passed } from "@grizzle/testing/lsw"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Result, String as Str } from "effect"
import {
	type DeclarationRefused,
	parseDeclarations,
	parseDrop,
	parseRename,
	rosterRenames
} from "#cli/renames.ts"
import { type DeclaredName, parseDeclaredName } from "#compiler/core/identity.ts"
import type { Declarations, Named, Rename } from "#compiler/deploy/diff/plan.ts"
import { assert, deepEquals, succeeded } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"

/** A name the test declares, through the naming door. */
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

/** Name tokens: three declared names, pairwise not alike, then four that are none. */
const names = ["Node", "Tag", "a", "", "_x", "a-b", "é"] as const
/**
 * Handle tokens: seven handles, two holding `=` and one `=Kind#`, one `@`, one of the 63 bytes a name holds, then four
 * that are none.
 */
const handles = [
	"a",
	"b-c",
	"=",
	"x=Kind#y",
	"#",
	"@Tag",
	Str.repeat(63)("h"),
	"",
	nul,
	loneSurrogate,
	Str.repeat(64)("h")
] as const

/** Whether `ch` is an ASCII letter. */
const isLetter = (ch: string): boolean => (ch >= "A" && ch <= "Z") || (ch >= "a" && ch <= "z")

/** D9's NAME: an ASCII letter, then ASCII letters, digits and underscores. */
const isName = (text: string): boolean =>
	!Str.isEmpty(text) &&
	Arr.every(Str.split(text, ""), (ch, at) =>
		at === 0 ? isLetter(ch) : isLetter(ch) || (ch >= "0" && ch <= "9") || ch === "_"
	)

/** D9's HANDLE: what a PostgreSQL name holds, 63 bytes of UTF-8 at most. */
const isHandle = (text: string): boolean =>
	!Str.isEmpty(text) &&
	!Str.includes("\u0000")(text) &&
	text.isWellFormed() &&
	new TextEncoder().encode(text).length <= 63

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

/** What D9 makes of a rename's text: its one reading of two different sides, or a refusal. */
const renameRuling = (text: string): Rename | undefined => {
	const [only, ...more] = readingsOf(text)
	return only === undefined || more.length > 0 || deepEquals(only.from, only.to) ? undefined : only
}

/** A side of each form over the token pools, as a rename or drop spells it. */
const sides: Readonly<{ 0: string }> & ReadonlyArray<string> = [
	...names,
	...Arr.flatMap(names, (relation) => Arr.map(names, (field) => `${relation}.${field}`)),
	...Arr.flatMap(names, (roster) => Arr.map(handles, (handle) => `${roster}#${handle}`)),
	...Arr.map(names, (login) => `@${login}`)
] as const

type Spelled =
	| "a parsed rename"
	| "a parsed login rename"
	| "a refused rename"
	| "an ambiguous rename"
	| "an unchanged rename"

type Dropped = "a parsed drop" | "a parsed login drop" | "a refused drop"

/** The verdict a refusal or a parse is, as the features count it. */
const verdictOf = (result: Result.Result<unknown, DeclarationRefused>): string =>
	Result.isSuccess(result) ? "parsed" : result.failure.fault.kind

describe("the rename declaration reader", () => {
	it.effect(
		"reads every rename as D9 does: one reading of two different sides, or a refusal",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/cli/renames-spelling",
						generator: (source) => [element(sides)(source), element(sides)(source)] as const,
						literal: Formatter.format,
						limit: sides.length * sides.length,
						coverage: requiredInSpace<Spelled>([
							"a parsed rename",
							"a parsed login rename",
							"a refused rename",
							"an ambiguous rename",
							"an unchanged rename"
						]),
						caseHang,
						box: "every pair of sides of every form over seven name tokens and eleven handle tokens",
						oracle: { kind: "specification", name: "D9's grammar, read as every split at an =" }
					},
					([from, to], c) =>
						Effect.sync(() => {
							const text = `${from}=${to}`
							const read = parseRename(text)
							const ruling = renameRuling(text)
							if (readingsOf(text).length > 1) {
								c.note("an ambiguous rename")
							}
							if (ruling === undefined) {
								assert.ok(Result.isFailure(read), `D9 refuses ${Formatter.format(text)}`)
								const readings = readingsOf(text)
								const [only] = readings
								if (readings.length === 1 && only !== undefined && deepEquals(only.from, only.to)) {
									c.note("an unchanged rename")
								}
								c.note("a refused rename")
								return
							}
							assert.deepEqual(succeeded(read), ruling, `D9 reads ${Formatter.format(text)}`)
							c.note("a parsed rename")
							if (ruling.from.kind === "login") {
								c.note("a parsed login rename")
							}
						})
				)
			)
	)

	it.effect("reads every drop as D9 reads a side, and a rename of one side as a refusal", (ctx) =>
		searched(
			ctx,
			exhaust(
				{
					suite: "unit/cli/renames-drop",
					generator: element(sides),
					literal: Formatter.format,
					limit: sides.length,
					coverage: requiredInSpace<Dropped>([
						"a parsed drop",
						"a parsed login drop",
						"a refused drop"
					]),
					caseHang,
					box: "every side of every form over seven name tokens and eleven handle tokens",
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

	/** The pools of whole command lines: a swap, a chain, a repeated old name, a merge, a login's rename, and drops of
	 * each. */
	const renamePool = [
		"Node=Tag",
		"Tag=Node",
		"Tag=a",
		"Node=a",
		"Kind#a=Kind#b",
		"@Node=@Tag"
	] as const
	const dropPool = ["Node", "Kind#a", "@Node"] as const

	type Listed = "parsed" | "twice" | "merged"

	/** D9's ruling on a command line: refused where an old name repeats or two renames share a new one. */
	const listRuling = (
		renames: ReadonlyArray<string>,
		drops: ReadonlyArray<string>
	): "parsed" | "twice" | "merged" => {
		const sides = Arr.map(renames, (r) => around(r, "=") ?? [r, r])
		const olds = [...Arr.map(sides, ([old]) => old), ...drops]
		if (new Set(olds).size < olds.length) {
			return "twice"
		}
		const news = Arr.map(sides, ([, renamed]) => renamed)
		return new Set(news).size < news.length ? "merged" : "parsed"
	}

	const lists: Gen<readonly [ReadonlyArray<string>, ReadonlyArray<string>]> = (source) => [
		array(element(renamePool), { min: 0, max: 3 })(source),
		array(element(dropPool), { min: 0, max: 2 })(source)
	]

	it.effect(
		"refuses a command line that renames or drops a name twice, or renames two to one",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/cli/renames-lists",
						generator: lists,
						literal: Formatter.format,
						limit: (1 + 6 + 36 + 216) * (1 + 3 + 9),
						coverage: requiredInSpace<Listed>(["parsed", "twice", "merged"]),
						caseHang,
						box: "every list of up to three renames and two drops over a pool of six renames and three drops",
						oracle: {
							kind: "specification",
							name: "D9: one declaration per old name and per new name"
						}
					},
					([renames, drops], c) =>
						Effect.sync(() => {
							const ruling = listRuling(renames, drops)
							const read = parseDeclarations(renames, drops)
							c.note(ruling)
							if (ruling === "parsed") {
								const declared: Declarations = succeeded(read)
								assert.deepEqual(declared, {
									renames: Arr.map(renames, (r) => succeeded(parseRename(r))),
									drops: Arr.map(drops, (d) => succeeded(parseDrop(d)))
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
				exhaust(
					{
						suite: "unit/cli/renames-rosters",
						generator: element(["Kind", "kind", "Other"] as const),
						literal: Formatter.format,
						limit: 3,
						coverage: requiredInSpace<"resolved" | "unknown">(["resolved", "unknown"]),
						caseHang,
						box: "a handle rename to the schema's roster, to one alike, and to one it lacks",
						oracle: { kind: "specification", name: "declaredAlike rosters are one roster" }
					},
					(roster, c) =>
						Effect.sync(() => {
							const declared = succeeded(parseDeclarations([`Kind#old=${roster}#new`], []))
							const kind = parsedName("Kind")
							const resolved = rosterRenames(declared, [{ closed: kind, handles: ["new"] }])
							if (roster === "Other") {
								assert.equal(verdictOf(resolved), "unknownRoster")
								c.note("unknown")
								return
							}
							assert.deepEqual(succeeded(resolved), new Map([[kind, new Map([["old", "new"]])]]))
							c.note("resolved")
						})
				)
			)
	)
})
