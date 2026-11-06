/**
 * A roster's codes as an installation holds them.
 *
 * A closed id is stored as its handle's code, and a roster's codes depend on the codes it held before: a handle keeps
 * its code across every migration, a removed handle leaves a hole no handle takes again, and a new handle takes the
 * next code. So no schema alone determines them. They are installation data, drafted from the previous installation's
 * codes, recorded with it, and given to every compilation of the schema's artifacts, while a closed id's type holds
 * only its roster's live handles in code order and stays the same type in a fresh installation and a migrated one.
 */
import { sameOrder } from "#compiler/core/array.ts"
import { type CompileError, unsupported } from "#compiler/core/errors.ts"
import { bitInputText, hexText, setBit, wholeDigitBits, zeroDigits } from "#compiler/core/hex.ts"
import type { DeclaredName } from "#compiler/core/identity.ts"
import { defect } from "#compiler/core/invariant.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import * as Result from "#compiler/core/result.ts"
import { type Reordered, type RosterCodes, rosterCodes } from "#compiler/ir/cells.ts"
import type { Roster } from "#compiler/ir/scalar.ts"

/** One roster's declared renames, old handle to new. */
export type HandleRenames = ReadonlyMap<string, string>

/** Every roster's declared renames, by roster. */
export type RosterRenames = ReadonlyMap<DeclaredName, HandleRenames>

/** No rename declared. */
export const noRenames: RosterRenames = new Map()

const noHandleRenames: HandleRenames = new Map()

/**
 * One roster's codes, read both ways, built only by rosterCodec. `codes` is what an installation records; `size`
 * counts every code minted, holes included, so it is one past the greatest code the roster's domain admits; `width` is
 * n of a set's bit(n), `size` rounded up to whole hex digits (core/hex.ts), so a set's one spelling is whole digits and
 * its bits past `size`, its padding, are 0; `codeOf` is each live handle's code; `names` is each code's handle in code
 * order, a hole the empty name, which no handle is.
 */
export interface RosterCodec {
	readonly roster: DeclaredName
	readonly codes: RosterCodes
	readonly size: number
	readonly width: number
	readonly codeOf: ReadonlyMap<string, number>
	readonly names: ReadonlyArray<string>
}

/**
 * The codes of every roster an installation holds, by declared name: what an installation records, what a draft
 * makes from the previous installation's, and what every compilation of the schema's artifacts reads.
 */
export interface Codebook {
	readonly rosters: ReadonlyMap<DeclaredName, RosterCodec>
}

/** The codebook of no roster: an installation that holds none. */
export const emptyCodebook: Codebook = Object.freeze({ rosters: new Map() })

/** A declaration that puts a roster's handles out of their codes' order, refused before anything is drafted. */
export interface RosterReordered extends Reordered {
	readonly roster: DeclaredName
}

/** The codec of `roster`'s codes, frozen: each live handle's code and each code's name, a hole the empty name. */
export const rosterCodec = (roster: DeclaredName, codes: RosterCodes): RosterCodec => {
	const codeOf = new Map<string, number>()
	const names = codes.map((slot, code): string => {
		if (slot.kind === "hole") {
			return ""
		}
		codeOf.set(slot.handle, code)
		return slot.handle
	})
	return Object.freeze({
		roster,
		codes: Object.freeze([...codes]),
		size: codes.length,
		width: wholeDigitBits(codes.length),
		codeOf,
		names: Object.freeze(names)
	})
}

/**
 * The codebook for `rosters` drafted from `previous`: each roster's codes by rosterCodes, from the codes `previous`
 * holds for it and the renames declared for it alone; a roster new to the installation numbers its handles from 0; a
 * roster `previous` holds and `rosters` lacks leaves with its codes. The first roster declared out of its codes' order
 * is refused.
 */
export const draftCodebook = (
	previous: Codebook,
	renames: RosterRenames,
	rosters: ReadonlyArray<Roster>
): Result.Result<Codebook, RosterReordered> => {
	const drafted = new Map<DeclaredName, RosterCodec>()
	for (const roster of rosters) {
		const before = previous.rosters.get(roster.closed)?.codes ?? []
		const codes = rosterCodes(before, renames.get(roster.closed) ?? noHandleRenames, roster.handles)
		if (!codes.ok) {
			return Result.err({ roster: roster.closed, ...codes.error })
		}
		drafted.set(roster.closed, rosterCodec(roster.closed, codes.value))
	}
	return Result.ok(Object.freeze({ rosters: drafted }))
}

/**
 * A fresh installation's codebook: drafted from no codes, so each handle's code is its position. A draft from no codes
 * mints each handle's code in declared order, so it never refuses.
 */
export const firstCodebook = (rosters: ReadonlyArray<Roster>): Codebook => {
	const drafted = draftCodebook(emptyCodebook, noRenames, rosters)
	if (!drafted.ok) {
		throw defect("a roster drafted from no codes numbers its handles in declared order")
	}
	return drafted.value
}

/**
 * The refusal of a declaration that puts a roster's handles out of their codes' order: UnsupportedOperation at the
 * roster's handle declared out of order. A stored code never changes meaning, so a roster's order, which is its
 * comparison order, is its codes' order, and a new handle goes after every handle declared before it.
 */
export const reorderRefusal = (r: RosterReordered): CompileError =>
	unsupported(
		SourceLoc(`closed relation ${r.roster}`, ["handles", r.later]),
		`append new handles; a roster's order is its codes' order: ${JSON.stringify(r.later)} holds a lower code than ${JSON.stringify(r.earlier)}, which is declared before it`
	)

/**
 * The hex digits of a set of `codec`'s live handles, bit(width)'s whole digits: bit c is 1 exactly when the set holds
 * the handle of code c, so a hole's bit and every padding bit past `size` are 0. A handle the roster does not hold live
 * is a defect: a set is admitted against the roster first.
 */
export const handlesHex = (codec: RosterCodec, handles: Iterable<string>): string => {
	const digits = zeroDigits(codec.width)
	for (const handle of handles) {
		setBit(digits, codeOf(codec, handle))
	}
	return hexText(digits)
}

/**
 * A set's one text, the text bit's input function reads as its hex digits (core/hex.ts bitInputText, handlesHex): the
 * parameter text, an array element's and the fact identity's part.
 */
export const handlesText = (codec: RosterCodec, handles: Iterable<string>): string =>
	bitInputText(handlesHex(codec, handles))

/**
 * The hex digits of the roster's live codes, the set of every live handle: bit c is 1 exactly where code c names a
 * handle, and every hole's and padding bit is 0. It is the mask the bits domain's CHECK holds a set within.
 */
export const liveHex = (codec: RosterCodec): string => {
	const digits = zeroDigits(codec.width)
	for (const [code, name] of codec.names.entries()) {
		if (name !== "") {
			setBit(digits, code)
		}
	}
	return hexText(digits)
}

/**
 * The first of `rosters` whose codes `book` does not hold exactly as its live handles in declared order, or undefined
 * when the book serves them all: what an installation's recorded codebook is checked by once, where it is read, since
 * every codec and every literal of the schema's artifacts reads it.
 */
export const unservedRoster = (
	book: Codebook,
	rosters: ReadonlyArray<Roster>
): Roster | undefined =>
	rosters.find((roster) => {
		const codec = book.rosters.get(roster.closed)
		return (
			codec === undefined ||
			!sameOrder(
				codec.names.filter((name) => name !== ""),
				roster.handles
			)
		)
	})

/**
 * The codec of `roster`. A schema's codebook holds every roster the schema declares, its live handles in the roster's
 * order (unservedRoster), so a roster it lacks is a defect.
 */
export const codecOf = (book: Codebook, roster: Roster): RosterCodec => {
	const codec = book.rosters.get(roster.closed)
	if (codec === undefined) {
		throw defect(`the installation's codebook holds roster ${roster.closed}`)
	}
	return codec
}

/** A live handle's code. The codec admits only its roster's live handles, so a handle it does not hold is a defect. */
export const codeOf = (codec: RosterCodec, handle: string): number => {
	const code = codec.codeOf.get(handle)
	if (code === undefined) {
		throw defect(`${JSON.stringify(handle)} is a live handle of roster ${codec.roster}`)
	}
	return code
}

/**
 * The live handle a stored code names. A stored code is a live one: its column's domain admits no other, and VALIDATE
 * leaves no row holding a removed handle's code, so a hole or a code past `size` is a defect.
 */
export const handleAt = (codec: RosterCodec, code: number): string => {
	const name = codec.names[code]
	if (name === undefined || name === "") {
		throw defect(`code ${code} names a live handle of roster ${codec.roster}`)
	}
	return name
}

/**
 * Each roster's names in code order, a hole the empty name, by the roster's name: what a decoder binds a closed id's
 * column by. A decoder binds only columns of rosters the schema declares, which its codebook holds, so another is a
 * defect.
 */
export const codeNames = (book: Codebook): ((roster: string) => ReadonlyArray<string>) => {
	const byName = new Map<string, ReadonlyArray<string>>(
		Array.from(book.rosters, ([roster, codec]) => [roster, codec.names])
	)
	return (roster) => {
		const names = byName.get(roster)
		if (names === undefined) {
			throw defect(`the installation's codebook holds roster ${roster}`)
		}
		return names
	}
}
