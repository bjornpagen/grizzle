/**
 * The renames and drops `grizzle generate` declares (D9): `--rename <old>=<new>` and `--drop <old>`, each given as
 * often as there are names to declare, each side a relation `Relation`, a field `Relation.field`, a roster's handle
 * `Roster#handle` or a login `@login`. A draft guesses no rename: a name the previous snapshot holds and the schema
 * does not is renamed only where a rename declares it and dropped only where a drop does, and the draft refuses one
 * neither declares, naming it (deploy/render/generate.ts DraftInput.declared). A handle keeps its code across a rename,
 * and a login its PostgreSQL role, which is renamed in place with its password and grants.
 *
 * Relation, field, roster and login names are declared names, ASCII letters, digits and underscores
 * (core/identity.ts parseDeclaredName), which never hold `.`, `#`, `=` or `@`; a handle is text its roster's names
 * constant holds in a PostgreSQL name: not empty, which is a hole's name, at most handleMaxBytes UTF-8 bytes, with no
 * NUL, which ends a name, and no lone surrogate, which no UTF-8 encodes. So a side with `#` is a handle, its roster
 * before the first `#`; a side that starts with `@` is a login; and a side with `.` a field. A handle may hold `=`: a
 * handle rename is split where both sides spell a handle, and one with two such places reads two ways and is refused.
 *
 * The reader refuses what a declaration's text alone shows wrong, before the configuration is read: a side of none
 * of the four spellings; a rename between two kinds of name; a rename to the name itself; a name renamed or dropped
 * twice; two names renamed to one. The `from` side names what the previous snapshot declares, its field's relation or
 * its handle's roster included, and the `to` side what the schema declares, so `--rename R.f=S.g` beside
 * `--rename R=S` renames a field of a renamed relation. Whether each name is one the snapshot or the schema holds, and
 * whether the renames agree, is the draft's to decide (deploy/diff/plan.ts Declarations). A swap (`A=B` and `B=A`) and
 * a chain (`A=B` and `B=C`) are renames like any other, which the draft orders.
 */
import { Array as Arr, Data, Formatter, Option, Result, String as Str } from "effect"
import {
	conversionOf,
	type DeclaredName,
	declaredAlike,
	parseDeclaredName
} from "#compiler/core/identity.ts"
import { handleMaxBytes } from "#compiler/core/limits.ts"
import { utf8Length } from "#compiler/core/sha256.ts"
import type { Declarations, Named, Rename } from "#compiler/deploy/diff/plan.ts"
import type { HandleRenames, RosterRenames } from "#compiler/ir/codes.ts"
import type { Roster } from "#compiler/ir/scalar.ts"

/** The sign a login's name follows, which no declared name holds. */
const loginSign = "@"

/** No rename and no drop declared. */
export const noDeclarations: Declarations = Object.freeze({ renames: [], drops: [] })

/** A name as a refusal prints it, in the spelling it is declared in. */
export const namedText = (n: Named): string => {
	switch (n.kind) {
		case "relation":
			return n.relation
		case "field":
			return `${n.relation}.${n.field}`
		case "handle":
			return `${n.roster}#${n.handle}`
		case "login":
			return `${loginSign}${n.login}`
	}
}

/** What a declaration's text shows wrong (see the header). */
export type DeclarationFault =
	| {
			readonly kind: "spelling"
			readonly flag: "rename" | "drop"
			readonly given: string
			readonly problem: string
	  }
	| { readonly kind: "kinds"; readonly given: string }
	| { readonly kind: "unchanged"; readonly given: string }
	| { readonly kind: "ambiguous"; readonly given: string; readonly readings: number }
	| { readonly kind: "twice"; readonly name: string }
	| { readonly kind: "merged"; readonly name: string }
	| { readonly kind: "custom" }
	| { readonly kind: "unknownRoster"; readonly roster: string }

/** A rename or drop of the command line is refused for `fault`. */
export class DeclarationRefused extends Data.TaggedError("DeclarationRefused")<{
	readonly fault: DeclarationFault
}> {
	override get message(): string {
		const fault = this.fault
		switch (fault.kind) {
			case "spelling":
				return `--${fault.flag} ${fault.given} is not ${fault.flag === "rename" ? "<old>=<new>, each side" : "<old>,"} Relation, Relation.field, Roster#handle or @login: ${fault.problem}`
			case "kinds":
				return `--rename ${fault.given} renames one kind of name to another; both sides are relations, fields, handles or logins`
			case "unchanged":
				return `--rename ${fault.given} renames a name to itself`
			case "ambiguous":
				return `--rename ${fault.given} reads ${fault.readings} ways, a handle holding =<Roster>#, which only the split between its sides may`
			case "twice":
				return `${fault.name} is declared twice: a name is renamed or dropped once`
			case "merged":
				return `two names are renamed to ${fault.name}: a rename gives each name its own`
			case "custom":
				return "grizzle generate --custom drafts nothing, so it takes no --rename or --drop; declare them on the draft"
			case "unknownRoster":
				return `--rename names roster ${fault.roster} after its =, which the schema does not declare; a handle rename's new side names its roster as the schema declares it`
		}
	}
}

/** The refusal of `fault`. */
const refused = (fault: DeclarationFault): Result.Result<never, DeclarationRefused> =>
	Result.fail(new DeclarationRefused({ fault }))

/** A declared name's text, parsed, or the spelling fault of `given` under `flag`. */
const declared = (
	text: string,
	flag: "rename" | "drop",
	given: string
): Result.Result<DeclaredName, DeclarationRefused> => {
	const parsed = parseDeclaredName(text)
	return parsed.ok
		? Result.succeed(parsed.value)
		: refused({
				kind: "spelling",
				flag,
				given,
				problem: `${Str.isEmpty(text) ? "an empty name" : Formatter.format(text)}: ${parsed.error}`
			})
}

/** What keeps `handle` from being a handle's text (see the header), or none. */
const handleProblem = (handle: string): string | undefined => {
	if (Str.isEmpty(handle)) {
		return "a handle is not empty"
	}
	if (Str.includes("\u0000")(handle)) {
		return "a handle holds no NUL, which ends a PostgreSQL name"
	}
	if (!handle.isWellFormed()) {
		return "a handle holds no lone surrogate, which no UTF-8 encodes"
	}
	const bytes = utf8Length(handle)
	return bytes > handleMaxBytes.value
		? `a handle of at most ${handleMaxBytes.value} UTF-8 bytes, the most a name holds, not ${bytes}`
		: undefined
}

/** One side's text as a name: a handle where it holds `#`, a login where it starts with `@`, a field where it holds
 * `.`, else a relation. */
const namedOf = (
	text: string,
	flag: "rename" | "drop",
	given: string
): Result.Result<Named, DeclarationRefused> => {
	const hash = Str.indexOf("#")(text)
	if (Option.isSome(hash)) {
		const handle = Str.slice(hash.value + 1)(text)
		const problem = handleProblem(handle)
		if (problem !== undefined) {
			return refused({ kind: "spelling", flag, given, problem })
		}
		return Result.map(declared(Str.slice(0, hash.value)(text), flag, given), (roster): Named => ({
			kind: "handle",
			roster,
			handle
		}))
	}
	if (Str.startsWith(loginSign)(text)) {
		return Result.map(declared(Str.slice(loginSign.length)(text), flag, given), (login): Named => ({
			kind: "login",
			login
		}))
	}
	const [relation, field, ...more] = Str.split(text, ".")
	if (field === undefined) {
		return Result.map(declared(text, flag, given), (r): Named => ({
			kind: "relation",
			relation: r
		}))
	}
	if (more.length > 0) {
		return refused({ kind: "spelling", flag, given, problem: "a field is Relation.field, one dot" })
	}
	return Result.flatMap(declared(relation, flag, given), (r) =>
		Result.map(declared(field, flag, given), (f): Named => ({
			kind: "field",
			relation: r,
			field: f
		}))
	)
}

/** Whether `text` is a handle's spelling: a declared name, `#`, and a handle's text. */
const handleSide = (text: string): boolean =>
	Option.match(Str.indexOf("#")(text), {
		onNone: () => false,
		onSome: (hash) =>
			parseDeclaredName(Str.slice(0, hash)(text)).ok &&
			handleProblem(Str.slice(hash + 1)(text)) === undefined
	})

/**
 * A rename's text split into its two sides (see the header), or its refusal: the text between `=`s is cut into its
 * pieces, and a split after the first k is the first k pieces and the rest, each joined by `=` again. A rename whose
 * old side is a handle splits where both sides spell a handle; with no such split it splits at its first `=`, whose
 * sides then name what the refusal of their reading says.
 */
const sidesOf = (given: string): Result.Result<readonly [string, string], DeclarationRefused> => {
	const pieces = Str.split(given, "=")
	const [old] = pieces
	if (pieces.length < 2) {
		return refused({
			kind: "spelling",
			flag: "rename",
			given,
			problem: "a rename is <old>=<new>, and it holds no ="
		})
	}
	const splitAt = (k: number): readonly [string, string] => [
		Arr.join(Arr.take(pieces, k), "="),
		Arr.join(Arr.drop(pieces, k), "=")
	]
	if (!Str.includes("#")(old)) {
		return Result.succeed(splitAt(1))
	}
	const splits = Arr.filter(Arr.range(1, pieces.length - 1), (k) => {
		const [from, to] = splitAt(k)
		return handleSide(from) && handleSide(to)
	})
	const [only, ...more] = splits
	if (more.length > 0) {
		return refused({ kind: "ambiguous", given, readings: splits.length })
	}
	return Result.succeed(splitAt(only ?? 1))
}

/** Whether two names of one kind are one name: declared names as the naming door reads them, handles exactly. */
const sameNamed = (a: Named, b: Named): boolean => {
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

/** The key one name is told apart by: its kind and its declared names as the naming door reads them. */
const keyOf = (n: Named): string => {
	switch (n.kind) {
		case "relation":
			return `relation ${conversionOf(n.relation)}`
		case "field":
			return `field ${conversionOf(n.relation)}.${conversionOf(n.field)}`
		case "handle":
			return `handle ${conversionOf(n.roster)}#${n.handle}`
		case "login":
			return `login ${conversionOf(n.login)}`
	}
}

/** One `--rename` value, read (see the header). */
export const parseRename = (given: string): Result.Result<Rename, DeclarationRefused> =>
	Result.flatMap(sidesOf(given), ([old, renamed]) =>
		Result.flatMap(namedOf(old, "rename", given), (from) =>
			Result.flatMap(
				namedOf(renamed, "rename", given),
				(to): Result.Result<Rename, DeclarationRefused> => {
					if (from.kind !== to.kind) {
						return refused({ kind: "kinds", given })
					}
					if (sameNamed(from, to)) {
						return refused({ kind: "unchanged", given })
					}
					return Result.succeed({ from, to })
				}
			)
		)
	)

/** One `--drop` value, read (see the header). */
export const parseDrop = (given: string): Result.Result<Named, DeclarationRefused> =>
	namedOf(given, "drop", given)

/**
 * The declarations of a command line's `--rename` and `--drop` values, each read and the whole checked (see the
 * header): no name is renamed or dropped twice, and no two are renamed to one.
 */
export const parseDeclarations = (
	renames: ReadonlyArray<string>,
	drops: ReadonlyArray<string>
): Result.Result<Declarations, DeclarationRefused> =>
	Result.gen(function* () {
		const read: Array<Rename> = []
		for (const given of renames) {
			read.push(yield* parseRename(given))
		}
		const dropped: Array<Named> = []
		for (const given of drops) {
			dropped.push(yield* parseDrop(given))
		}
		const declaredOnce = new Set<string>()
		for (const old of [...Arr.map(read, (r) => r.from), ...dropped]) {
			const key = keyOf(old)
			if (declaredOnce.has(key)) {
				return yield* refused({ kind: "twice", name: namedText(old) })
			}
			declaredOnce.add(key)
		}
		const renamedTo = new Set<string>()
		for (const { to } of read) {
			const key = keyOf(to)
			if (renamedTo.has(key)) {
				return yield* refused({ kind: "merged", name: namedText(to) })
			}
			renamedTo.add(key)
		}
		return { renames: read, drops: dropped }
	})

/**
 * The handle renames of `declarations`, by the roster of the schema's `rosters` each new side names, the one whose name
 * is alike (core/identity.ts declaredAlike): what a draft gives draftCodebook (ir/codes.ts), which drafts each
 * roster's codes by its name in the schema. A new side naming no roster of `rosters` is refused, naming it.
 */
export const rosterRenames = (
	declarations: Declarations,
	rosters: ReadonlyArray<Roster>
): Result.Result<RosterRenames, DeclarationRefused> => {
	const byRoster = new Map<DeclaredName, Map<string, string>>()
	for (const { from, to } of declarations.renames) {
		if (from.kind !== "handle" || to.kind !== "handle") {
			continue
		}
		const roster = Arr.findFirst(rosters, (r) => declaredAlike(r.closed, to.roster))
		if (Option.isNone(roster)) {
			return refused({ kind: "unknownRoster", roster: to.roster })
		}
		const closed = roster.value.closed
		const handles = byRoster.get(closed) ?? new Map<string, string>()
		handles.set(from.handle, to.handle)
		byRoster.set(closed, handles)
	}
	return Result.succeed(
		new Map(
			Arr.map([...byRoster], ([roster, handles]): readonly [DeclaredName, HandleRenames] => [
				roster,
				handles
			])
		)
	)
}
