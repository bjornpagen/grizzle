import { catchSignal, compareText } from "#compiler/core/canonical.ts"
import { isList, isRecord } from "#compiler/core/record.ts"
import * as Result from "#compiler/core/result.ts"
import { trusted, trustedJson } from "#compiler/core/trusted.ts"

/**
 * Where a committed served file first parts from the one the compile writes, in the file's order: its text is no JSON
 * record (`unread`); one of its members besides its roles (`member`), such as its fingerprint; a role of the compile,
 * whose own fields differ or which the committed file lacks (`role`); a role past the compile's (`extraRole`); a
 * program of a role, which differs or which the committed file lacks (`program`); a program past the role's
 * (`extraProgram`); or nowhere, the two reading alike in another layout (`layout`). A role or program is compared with
 * every type it names read from the file's types table (served/json.ts), so a changed type parts the files at the first
 * program that names it.
 */
export type ServedPart =
	| { readonly kind: "unread" }
	| { readonly kind: "member"; readonly member: string }
	| { readonly kind: "role"; readonly role: string }
	| { readonly kind: "extraRole" }
	| { readonly kind: "program"; readonly role: string; readonly program: string }
	| { readonly kind: "extraProgram"; readonly role: string }
	| { readonly kind: "layout" }

/** Where a committed served file parts from the compile's, in words. */
export const servedPartText = (part: ServedPart): string => {
	switch (part.kind) {
		case "unread":
			return "which does not read as a served file"
		case "member":
			return `first at its ${part.member}`
		case "role":
			return `first at role ${part.role}`
		case "extraRole":
			return "first at a role the compile does not hold"
		case "program":
			return `first at program ${part.program} of role ${part.role}`
		case "extraProgram":
			return `first at a program of role ${part.role} the compile does not hold`
		case "layout":
			return "in its layout alone"
	}
}

/** The members of a served file's JSON record that hold its roles, a role's programs, and its types table. */
const rolesMember = "roles"
const membersMember = "members"
const typesMember = "types"

/** A type's occurrence in a served file (served/json.ts): `~t:` and its index in the file's types table. */
const typeOccurrence = "~t:"

/** A JSON record, which no list is. */
const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
	isRecord(value) && !isList(value)

/** JSON text read as any JSON value, or the SyntaxError of text that is no JSON (core/canonical.ts catchSignal). */
const parsedJson = (text: string): Result.Result<unknown, SyntaxError> =>
	catchSignal(SyntaxError, (): unknown => JSON.parse(text))

/** A JSON value with every type occurrence in it replaced by the entry of `types` it indexes. */
const withTypes = (json: unknown, types: ReadonlyArray<unknown>): unknown => {
	if (typeof json === "string") {
		return json.startsWith(typeOccurrence) ? types[Number(json.slice(typeOccurrence.length))] : json
	}
	if (isList(json)) {
		return json.map((item) => withTypes(item, types))
	}
	if (!isObject(json)) {
		return json
	}
	const out: Record<string, unknown> = {}
	for (const [key, member] of Object.entries(json)) {
		out[key] = withTypes(member, types)
	}
	return out
}

/** A served file's types table, each entry with the earlier entries it names read into it. */
const typesOf = (file: Readonly<Record<string, unknown>>): ReadonlyArray<unknown> => {
	const table = file[typesMember]
	const types: Array<unknown> = []
	for (const entry of isList(table) ? table : []) {
		types.push(withTypes(entry, types))
	}
	return types
}

/** Whether two JSON values are one value: the same scalar, or lists or records of the same members. */
const sameJson = (a: unknown, b: unknown): boolean => {
	if (isList(a) || isList(b)) {
		return (
			isList(a) && isList(b) && a.length === b.length && a.every((item, i) => sameJson(item, b[i]))
		)
	}
	if (isObject(a) && isObject(b)) {
		const keys = Object.keys(a)
		return (
			keys.length === Object.keys(b).length &&
			keys.every((key) => Object.hasOwn(b, key) && sameJson(a[key], b[key]))
		)
	}
	return a === b
}

/** The items of a list member of a JSON record; none when it holds no list. */
const itemsOf = (record: unknown, member: string): ReadonlyArray<unknown> => {
	const items = isObject(record) ? record[member] : undefined
	return isList(items) ? items : []
}

/** A JSON record with its member `skip` left out. */
const without = (record: unknown, skip: string): unknown => {
	if (!isObject(record)) {
		return record
	}
	const { [skip]: _skipped, ...rest } = record
	return rest
}

/** A role or program of the compile's own file: its name, which the compile always writes. */
interface Named {
	readonly name: string
}

/**
 * The first place where the compile's list of named records, `ours`, and the committed file's, `theirs`, part, by
 * position: a record of ours that `parted` finds parted from the committed one at its position, or which the committed
 * list lacks (`missing`); else a record past ours that the committed list holds (`extra`); none where they read alike.
 */
const firstParted = (
	ours: ReadonlyArray<unknown>,
	theirs: ReadonlyArray<unknown>,
	parted: (ours: unknown, theirs: unknown, named: Named) => ServedPart | undefined,
	missing: (named: Named) => ServedPart,
	extra: ServedPart
): ServedPart | undefined => {
	for (const [i, item] of ours.entries()) {
		const named = trusted<Named>(item)
		const committed = theirs[i]
		const found = committed === undefined ? missing(named) : parted(item, committed, named)
		if (found !== undefined) {
			return found
		}
	}
	return theirs.length > ours.length ? extra : undefined
}

/**
 * Where the committed served file's text `committed` first parts from `ours`, the text the compile writes, which it is
 * not (ServedPart). The committed text is anyone's to have edited: it is read as any JSON, never trusted; `ours` is
 * grizzle's own.
 */
export const servedDifference = (ours: string, committed: string): ServedPart => {
	const read = parsedJson(committed)
	if (!read.ok || !isObject(read.value)) {
		return { kind: "unread" }
	}
	const theirs = read.value
	const own = trustedJson<Readonly<Record<string, unknown>>>(ours)
	const ourTypes = typesOf(own)
	const theirTypes = typesOf(theirs)
	const alike = (a: unknown, b: unknown): boolean =>
		sameJson(withTypes(a, ourTypes), withTypes(b, theirTypes))
	const keys = [...new Set([...Object.keys(own), ...Object.keys(theirs)])].toSorted(compareText)
	for (const key of keys) {
		if (key === typesMember) {
			continue
		}
		const found =
			key !== rolesMember
				? alike(own[key], theirs[key])
					? undefined
					: ({ kind: "member", member: key } satisfies ServedPart)
				: firstParted(
						itemsOf(own, rolesMember),
						itemsOf(theirs, rolesMember),
						(role, theirRole, named) =>
							alike(without(role, membersMember), without(theirRole, membersMember))
								? firstParted(
										itemsOf(role, membersMember),
										itemsOf(theirRole, membersMember),
										(program, theirProgram, programNamed) =>
											alike(program, theirProgram)
												? undefined
												: { kind: "program", role: named.name, program: programNamed.name },
										(programNamed) => ({
											kind: "program",
											role: named.name,
											program: programNamed.name
										}),
										{ kind: "extraProgram", role: named.name }
									)
								: { kind: "role", role: named.name },
						(named) => ({ kind: "role", role: named.name }),
						{ kind: "extraRole" }
					)
		if (found !== undefined) {
			return found
		}
	}
	return alike(own[typesMember], theirs[typesMember])
		? { kind: "layout" }
		: { kind: "member", member: typesMember }
}
