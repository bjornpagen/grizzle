/**
 * A roster's codes as an installation holds them.
 *
 * A closed id is stored as its handle's code, and a roster's codes depend on the codes it held before: a handle keeps
 * its code across every migration, a removed handle leaves a hole no handle takes again, and a new handle takes the
 * next code. So no schema alone determines them. They are installation data, drafted from the previous installation's
 * codes, recorded with it, and given to every compilation of the schema's artifacts, while a closed id's type holds
 * only its roster's live handles in its order (ir/scalar.ts Roster) and stays the same type in a fresh installation and
 * a migrated one.
 */
import { defect } from "@bjornpagen/grizzle-text/base/invariant"
import * as Result from "@bjornpagen/grizzle-text/base/result"
import { type CompileError, unsupported } from "#compiler/core/errors.ts"
import { bitInputText, hexText, setBit, wholeByteBits, zeroDigits } from "#compiler/core/hex.ts"
import type { HeldName } from "#compiler/core/identity.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { type Reordered, type RosterCodes, rosterCodes } from "#compiler/ir/cells.ts"
import { noSpellings, type Spellings } from "#compiler/ir/pattern.ts"
import type { Roster } from "#compiler/ir/scalar.ts"

/** One roster's declared renames, old handle to new. */
export type HandleRenames = ReadonlyMap<string, string>

/** Every roster's declared renames, by roster. */
export type RosterRenames = ReadonlyMap<HeldName, HandleRenames>

/** No rename declared. */
export const noRenames: RosterRenames = new Map()

const noHandleRenames: HandleRenames = new Map()

/**
 * A roster's order of its live handles, the one order a closed id's and a set's comparison reads
 * (scalar/values/identity.ts compareValues): each live handle's rank, two handles comparing as their ranks do. One
 * comparison, with two sources of one fact:
 * - an installation's codes (RosterCodec), PostgreSQL's own order of the stored ids, every roster's. A host order of
 *   stored values, which must meet SQL's ORDER BY over the code column, reads it: a reader's merge and a page's fetch
 *   order, whose ties a closed id of any roster breaks by its code (scalar/registry.ts breaksTies), and a fold's max.
 * - a roster's declaration (declaredOrder), which a schema states before any installation holds its codes, and which
 *   the evaluator reads (scalar/compute/evaluate.ts), a contract literal's check and the optimizer's folding among its
 *   callers. An ordered roster's declared order is its codes' order, since a declaration out of it is refused
 *   (ir/cells.ts rosterCodes); an unordered roster's closed ids have no order of the language (scalar/native.ts
 *   unorderedCodeCapabilities), so the evaluator reads only equality of them, which every rank gives alike.
 */
export interface HandleOrder {
	readonly rank: ReadonlyMap<string, number>
}

/**
 * One roster's codes, read both ways, built only by rosterCodec. `codes` is what an installation records; `size`
 * counts every code minted, holes included, so it is one past the greatest code the roster's domain admits; `width` is
 * n of a set's bit(n), `size` rounded up to whole bytes (core/hex.ts wholeByteBits), one byte at least, since
 * PostgreSQL's bit(n) holds a bit at least, which an empty roster's set is all padding of: PostgreSQL stores a bit(n) in
 * whole bytes, so the padding costs no storage and a roster grows into it under the same width, and a set's one spelling
 * is whole hex digits, its bits past `size`, its padding, 0; `rank` is each live handle's code, which is the roster's order
 * (HandleOrder); `names` is each code's handle in code order, a hole the empty name, which no handle is.
 */
export interface RosterCodec extends HandleOrder {
	readonly roster: HeldName
	readonly codes: RosterCodes
	readonly size: number
	readonly width: number
	readonly names: ReadonlyArray<string>
}

/** Each declared roster's order (HandleOrder), made once per roster. */
const declaredOrders = new WeakMap<Roster, HandleOrder>()

/**
 * A roster's declared order (HandleOrder): each live handle's position among its handles. An ordered roster's is its
 * codes' order in every installation, since a declaration out of it is refused (rosterCodes); an unordered roster's is
 * its handles' canonical order (ir/scalar.ts handlesInOrder), which no code follows and which only equality reads.
 */
export const declaredOrder = (roster: Roster): HandleOrder => {
	const known = declaredOrders.get(roster)
	if (known !== undefined) {
		return known
	}
	const order: HandleOrder = Object.freeze({
		rank: new Map(roster.handles.map((handle, position) => [handle, position] as const))
	})
	declaredOrders.set(roster, order)
	return order
}

/**
 * The codes of every roster an installation holds, by declared name: what an installation records, what a draft
 * makes from the previous installation's, and what every compilation of the schema's artifacts reads.
 */
export interface Codebook {
	readonly rosters: ReadonlyMap<HeldName, RosterCodec>
	/**
	 * The spelling the installation's history holds of each pattern language (ir/pattern.ts Spellings): a draft's, its
	 * previous installation's, which a language it installs again keeps; a fresh installation's and a layer's, none,
	 * so each language takes its first spelling (installedSpellings).
	 */
	readonly spellings: Spellings
}

/** The codebook of no roster: an installation that holds none. */
export const emptyCodebook: Codebook = Object.freeze({ rosters: new Map(), spellings: noSpellings })

/** A declaration that puts a roster's handles out of their codes' order, refused before anything is drafted. */
export interface RosterReordered extends Reordered {
	readonly roster: HeldName
}

/** The codec of `roster`'s codes, frozen: each live handle's code and each code's name, a hole the empty name. */
export const rosterCodec = (roster: HeldName, codes: RosterCodes): RosterCodec => {
	const rank = new Map<string, number>()
	const names = codes.map((slot, code): string => {
		if (slot.kind === "hole") {
			return ""
		}
		rank.set(slot.handle, code)
		return slot.handle
	})
	return Object.freeze({
		roster,
		codes: Object.freeze([...codes]),
		size: codes.length,
		width: wholeByteBits(Math.max(codes.length, 1)),
		rank,
		names: Object.freeze(names)
	})
}

/**
 * What a draft makes of a roster the previous installation records: continued as the schema's roster `as`, which carries
 * its codes on, or ended, its codes with it.
 */
export type RosterFate =
	| { readonly kind: "continued"; readonly as: HeldName }
	| { readonly kind: "ended" }

/**
 * A roster the previous installation records, by its codes under its recorded name, and what a draft makes of it: the
 * one reading of which roster a roster of the schema continues (deploy/snapshot/build.ts rosterFates), which the codes
 * a draft drafts (draftCodebook) and the conversions of a column between rosters (deploy/diff/diff.ts) both follow.
 */
export interface PreviousRoster {
	readonly codec: RosterCodec
	readonly fate: RosterFate
}

/** No roster before: an installation's first draft. */
export const noPreviousRosters: ReadonlyArray<PreviousRoster> = []

/** Each roster of `book` continued as itself, under its own name: a target installation's rosters, as the diff reads its
 * domains, and the rosters of an installation a test drafts again without a snapshot. */
export const keptRosters = (book: Codebook): ReadonlyArray<PreviousRoster> =>
	[...book.rosters.values()].map((codec) => ({
		codec,
		fate: { kind: "continued", as: codec.roster }
	}))

/**
 * The codebook for `rosters` drafted from `previous`: each roster's codes by rosterCodes, from the codes of the one
 * previous roster that continues as it and the renames declared for it alone; a roster no previous roster continues as
 * is new to the installation and numbers its handles from 0, in its order; a previous roster that ends leaves with its
 * codes. The first ordered roster declared out of its codes' order is refused; an unordered roster never is.
 */
export const draftCodebook = (
	previous: ReadonlyArray<PreviousRoster>,
	renames: RosterRenames,
	rosters: ReadonlyArray<Roster>,
	spellings: Spellings
): Result.Result<Codebook, RosterReordered> => {
	const continued = new Map(
		previous.flatMap(({ codec, fate }) =>
			fate.kind === "continued" ? [[fate.as, codec.codes] as const] : []
		)
	)
	const drafted = new Map<HeldName, RosterCodec>()
	for (const roster of rosters) {
		const before = continued.get(roster.closed) ?? []
		const codes = rosterCodes(before, renames.get(roster.closed) ?? noHandleRenames, roster)
		if (!codes.ok) {
			return Result.err({ roster: roster.closed, ...codes.error })
		}
		drafted.set(roster.closed, rosterCodec(roster.closed, codes.value))
	}
	return Result.ok(Object.freeze({ rosters: drafted, spellings }))
}

/**
 * A fresh installation's codebook: drafted from no codes, so each handle's code is its position in its roster's order
 * (ir/scalar.ts Roster). A draft from no codes mints each handle's code in that order, so it never refuses.
 */
export const firstCodebook = (rosters: ReadonlyArray<Roster>): Codebook => {
	const drafted = draftCodebook(noPreviousRosters, noRenames, rosters, noSpellings)
	if (!drafted.ok) {
		defect("a roster drafted from no codes numbers its handles in declared order")
	}
	return drafted.value
}

/**
 * What a reordered roster's declaration does instead: append its new handles, since an ordered roster's order is its
 * codes' order, or declare it closed.unordered where its order means nothing.
 */
const reorderFix =
	"append new handles, since an ordered roster's order is its codes' order, or declare the roster closed.unordered where its order means nothing"

/**
 * The refusal of a declaration that puts an ordered roster's handles out of their codes' order: UnsupportedOperation at
 * the roster's handle declared out of order. A stored code never changes meaning, so an ordered roster's order, which
 * is its comparison order, is its codes' order, and a new handle goes after every handle declared before it; a roster
 * whose order means nothing is closed.unordered, whose handles any order declares.
 */
export const reorderRefusal = (r: RosterReordered): CompileError =>
	unsupported(
		SourceLoc(`closed relation ${r.roster}`, ["handles", r.later]),
		`${reorderFix}: ${JSON.stringify(r.later)} holds a lower code than ${JSON.stringify(r.earlier)}, which is declared before it`
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
 * The codec of `roster`. A schema's codebook holds every roster the schema declares, its live handles in the roster's
 * order, so a roster it lacks is a defect.
 */
export const codecOf = (book: Codebook, roster: Roster): RosterCodec => {
	const codec = book.rosters.get(roster.closed)
	if (codec === undefined) {
		defect(`the installation's codebook holds roster ${roster.closed}`)
	}
	return codec
}

/** A live handle's code. The codec admits only its roster's live handles, so a handle it does not hold is a defect. */
export const codeOf = (codec: RosterCodec, handle: string): number => {
	const code = codec.rank.get(handle)
	if (code === undefined) {
		defect(`${JSON.stringify(handle)} is a live handle of roster ${codec.roster}`)
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
		defect(`code ${code} names a live handle of roster ${codec.roster}`)
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
			defect(`the installation's codebook holds roster ${roster}`)
		}
		return names
	}
}

/**
 * The codebook of rosters' recorded codes, each under its declared name, in the order given. The names are a snapshot's
 * or a served file's, which `grizzle generate` wrote under names the declared-name rule admits and which their readers
 * trust as they read them, so none is parsed again here.
 */
export const rosterCodebook = (rosters: Iterable<readonly [HeldName, RosterCodes]>): Codebook => {
	const book = new Map<HeldName, RosterCodec>()
	for (const [name, codes] of rosters) {
		book.set(name, rosterCodec(name, codes))
	}
	return book.size === 0 ? emptyCodebook : Object.freeze({ rosters: book, spellings: noSpellings })
}

/**
 * One field of an arm in a variant's layout (variantLayout): the field, `at`, the attribute its value is, and, for a
 * float, `zero`, the attribute after it that holds whether the value is -0, which the variant's domain's CHECK holds
 * equal to its sign (physical/ddl/variants.ts): so the composite's record equality, hash and order tell -0 from 0, as
 * the variant's one equality, its identity, does (scalar/variant-digest.ts), where float8's own equality holds them one.
 */
export interface FieldLayout<F> {
	readonly field: F
	readonly at: number
	readonly zero: number | undefined
}

/** One arm of a variant's layout (variantLayout): its handle, its code, and each of its fields' attributes. */
export interface ArmLayout<F> {
	readonly handle: string
	readonly code: number
	readonly fields: ReadonlyArray<FieldLayout<F>>
}

/**
 * A variant's layout under its tag's codes (ir/scalar.ts VariantType): its arms in their codes' order, `names` each
 * code's handle, a hole the empty name (RosterCodec names), each field at its attributes' positions in the variant's
 * composite (FieldLayout), `float` telling a float field, which takes two: 1 past the tag, then every arm of a lower
 * code's fields, its own in declared order. A handle no arm names, outside the subset of the roster the variant holds,
 * takes no attribute. A handle keeps its code across every migration and a new one takes the next, so an arm appended
 * to the roster, or of a handle past every arm's code, appends its attributes to the composite and a handle's rename
 * moves none. The one layout the composite, its domain's CHECK, a term reading an arm's field, the codec's record text
 * and the reader's conversion share.
 */
export const variantLayout = <F>(
	arms: ReadonlyArray<{ readonly handle: string; readonly fields: ReadonlyArray<F> }>,
	names: ReadonlyArray<string>,
	float: (field: F) => boolean
): ReadonlyArray<ArmLayout<F>> => {
	const byHandle = new Map(arms.map((arm) => [arm.handle, arm] as const))
	const layout: Array<ArmLayout<F>> = []
	let at = 1
	for (const [code, handle] of names.entries()) {
		const arm = byHandle.get(handle)
		if (arm !== undefined) {
			const fields = arm.fields.map((field): FieldLayout<F> => {
				const value = at
				const zero = float(field) ? value + 1 : undefined
				at = (zero ?? value) + 1
				return { field, at: value, zero }
			})
			layout.push({ handle, code, fields })
		}
	}
	if (layout.length !== arms.length) {
		defect("each arm of a variant is of a live handle of its roster")
	}
	return layout
}
