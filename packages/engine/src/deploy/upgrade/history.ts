/**
 * An installation's history as `grizzle upgrade` reads it off the live database, which no schema determines and whose
 * committed record is of another format (the shell's cli/upgrade.ts): each roster's codes, read off the names constant
 * the roster's domain's CHECK reads; and the spelling of each pattern language, proven one of the spellings the schema
 * writes by an object reading it that the database holds as the target's. A table's attribute numbers are pg_attribute's
 * own count (deploy/render/generate.ts LiveInstallation). Each is proven by the drift check of the target compiled under
 * it: a roster's names constant is named by its codes' digest, so the target installs the live one exactly when it reads
 * the live codes, and an object reading a language holds the ARE of its spelling.
 */
import * as Result from "@bjornpagen/grizzle-text/base/result"
import { identifierOf, type DeclaredName } from "#compiler/core/identity.ts"
import type { CodeSlot } from "#compiler/ir/cells.ts"
import { type PreviousRoster, rosterCodec } from "#compiler/ir/codes.ts"
import type { Spellings } from "#compiler/ir/pattern.ts"
import type { PhysicalObject } from "#compiler/ir/products.ts"
import type { Roster } from "#compiler/ir/scalar.ts"
import { rosterConstants } from "#compiler/physical/ddl/constants.ts"
import { matchAre } from "#compiler/scalar/regex/admit.ts"
import type { ObjectName, SqlStatement } from "#compiler/sql/ast.ts"

/** An installed constant of names as the upgrade read it: its qualified name and its elements, in its order. */
export interface LiveNames {
	readonly constant: ObjectName
	readonly names: ReadonlyArray<string>
}

/**
 * A roster whose codes do not read off the live database: no installed constant of names is its names constant under
 * the codes it holds (`none`), as where a format names the constant otherwise or the installation does not hold the
 * roster, or several are (`several`).
 */
export interface RosterUnread {
	readonly roster: DeclaredName
	readonly found: "none" | "several"
}

/** A code of a names constant: a hole, the empty name no handle is, or the live handle it names. */
const slotOf = (name: string): CodeSlot =>
	name === "" ? { kind: "hole" } : { kind: "live", handle: name }

/**
 * Each roster of `rosters` with the codes the live installation holds, continued as itself: the codes of the one
 * installed constant of names, among `constants`, whose name is the roster's names constant's under the codes it holds
 * (physical/ddl/constants.ts rosterConstants), the constant the roster's domain's CHECK reads, code c at its element
 * c + 1. Its name digests its content and its roster, so no other constant's is; a roster none is, or several are, is
 * RosterUnread. Never a code assigned by default: a roster the installation holds keeps every stored code's meaning,
 * holes and renamed handles among them.
 */
export const liveRosters = (
	rosters: ReadonlyArray<Roster>,
	constants: ReadonlyArray<LiveNames>
): Result.Result<ReadonlyArray<PreviousRoster>, RosterUnread> => {
	const out: Array<PreviousRoster> = []
	for (const roster of rosters) {
		const found = constants.flatMap((c): ReadonlyArray<PreviousRoster> => {
			const codec = rosterCodec(roster.closed, c.names.map(slotOf))
			return identifierOf(rosterConstants(codec).names) === c.constant.name
				? [{ codec, fate: { kind: "continued", as: roster.closed } }]
				: []
		})
		const [only, second] = found
		if (only === undefined || second !== undefined) {
			return Result.err({ roster: roster.closed, found: only === undefined ? "none" : "several" })
		}
		out.push(only)
	}
	return Result.ok(out)
}

/**
 * The identities of the objects of `objects` that read each language of `spellings`, by the language's key: each whose
 * statements hold the ARE of the language's spelling (scalar/regex/admit.ts matchAre), the one text a pattern of the
 * language lowers to wherever a statement reads it (lower/conservative/expr/index.ts patternAre). A language no object
 * reads is read by none, so no installed object holds its spelling.
 */
export const spellingReaders = (
	objects: ReadonlyArray<PhysicalObject<SqlStatement>>,
	spellings: Spellings
): ReadonlyMap<string, ReadonlySet<string>> => {
	const languageOf = new Map(
		[...spellings].map(([language, spelling]) => [matchAre(spelling), language])
	)
	const readers = new Map<string, Set<string>>(
		[...spellings.keys()].map((l) => [l, new Set<string>()])
	)
	for (const o of objects) {
		for (const language of languagesIn(o.ddl, languageOf)) {
			readers.get(language)?.add(o.ident)
		}
	}
	return readers
}

/** The languages whose AREs, by `languageOf`, `value` holds as a text, through its arrays and data properties alone. */
const languagesIn = (
	value: unknown,
	languageOf: ReadonlyMap<string, string>
): ReadonlySet<string> => {
	const out = new Set<string>()
	const seen = new Set<object>()
	const visit = (x: unknown): void => {
		if (typeof x === "string") {
			const language = languageOf.get(x)
			if (language !== undefined) {
				out.add(language)
			}
			return
		}
		if (typeof x !== "object" || x === null || seen.has(x)) {
			return
		}
		seen.add(x)
		for (const property of Object.values(Object.getOwnPropertyDescriptors(x))) {
			if ("value" in property) {
				visit(property.value)
			}
		}
	}
	visit(value)
	return out
}
