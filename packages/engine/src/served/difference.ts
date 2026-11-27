import { defect } from "@bjornpagen/grizzle-text/base/invariant"
import { catchSignal } from "@bjornpagen/grizzle-text/base/result"
import { readJson, type TextChunks } from "@bjornpagen/grizzle-text/chunks"
import { collectedEquals } from "#compiler/core/canonical.ts"
import { compareStrings } from "#compiler/core/order.ts"
import { isList, isRecord } from "#compiler/core/record.ts"
import { trusted } from "#compiler/core/trusted.ts"
import type { ServedFile } from "#compiler/served/forms.ts"
import { servedFile } from "#compiler/served/json.ts"

/**
 * Where a committed served file first parts from the one the compile writes, in the file's order: its text is no JSON
 * record (`unread`); one of its members besides its roles (`member`), such as its fingerprint; a role of the compile,
 * whose own fields differ or which the committed file lacks (`role`); a role past the compile's (`extraRole`); a
 * program of a role, which differs or which the committed file lacks (`program`); a program past the role's
 * (`extraProgram`); or nowhere, the two reading alike in another layout (`layout`). A role or program is compared as a
 * layer reads it (served/json.ts servedFile), every type it names its own value, so a changed type parts the files at
 * the first program that names it.
 */
export type ServedParting =
	| { readonly kind: "unread" }
	| { readonly kind: "member"; readonly member: string }
	| { readonly kind: "role"; readonly role: string }
	| { readonly kind: "extraRole" }
	| { readonly kind: "program"; readonly role: string; readonly program: string }
	| { readonly kind: "extraProgram"; readonly role: string }
	| { readonly kind: "layout" }

/** Where a committed served file parts from the compile's, in words. */
export const servedPartingText = (part: ServedParting): string => {
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

/** The members of a served file that hold its roles and a role's programs. */
const rolesMember = "roles"
const membersMember = "members"

/** A record, which no list, Map or Set is. */
const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
	isRecord(value) && !isList(value) && !(value instanceof Map) && !(value instanceof Set)

/**
 * A served file's text, held as its chunks, read as JSON (grizzle-text readJson) through the one reader of its JSON
 * form (served/json.ts servedFile), every value JSON cannot hold rebuilt; undefined for text that is no JSON, or that the
 * reader refuses. The committed text is anyone's to have edited, so whatever it holds is read as values of any shape.
 */
const revived = (text: TextChunks): Readonly<Record<string, unknown>> | undefined => {
	const json = readJson(text)
	if (!json.ok) {
		return undefined
	}
	const read = catchSignal(Error, (): ServedFile | undefined => {
		const file = servedFile(json.value)
		return file.ok ? file.value : undefined
	})
	return read.ok ? read.value : undefined
}

/** The items of a list member of a record; none when it holds no list. */
const itemsOf = (record: unknown, member: string): ReadonlyArray<unknown> => {
	const items = isObject(record) ? record[member] : undefined
	return isList(items) ? items : []
}

/** A record with its member `skip` left out. */
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
	parted: (ours: unknown, theirs: unknown, named: Named) => ServedParting | undefined,
	missing: (named: Named) => ServedParting,
	extra: ServedParting
): ServedParting | undefined => {
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
 * not (ServedParting). Both are read as a layer reads them (served/json.ts servedFile) and compared as the values read,
 * so a changed type parts the files at the first program that names it and nothing of the files' JSON form is read
 * here; the committed text is anyone's to have edited, and one no served file's reader reads is `unread`.
 */
export const servedDifference = (ours: TextChunks, committed: TextChunks): ServedParting => {
	const theirs = revived(committed)
	if (theirs === undefined) {
		return { kind: "unread" }
	}
	const own = revived(ours)
	if (own === undefined) {
		defect("the compile's own served file reads back")
	}
	const keys = [...new Set([...Object.keys(own), ...Object.keys(theirs)])].toSorted(compareStrings)
	for (const key of keys) {
		const found =
			key !== rolesMember
				? collectedEquals(own[key], theirs[key])
					? undefined
					: ({ kind: "member", member: key } satisfies ServedParting)
				: firstParted(
						itemsOf(own, rolesMember),
						itemsOf(theirs, rolesMember),
						(role, theirRole, named) =>
							collectedEquals(without(role, membersMember), without(theirRole, membersMember))
								? firstParted(
										itemsOf(role, membersMember),
										itemsOf(theirRole, membersMember),
										(program, theirProgram, programNamed) =>
											collectedEquals(program, theirProgram)
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
	return { kind: "layout" }
}
