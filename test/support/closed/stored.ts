/**
 * A closed id as its column stores it: its handle's code under the installation's codes, the smallint its roster's
 * domain admits, never the handle's text. A test whose model holds handles (a host's facts, a fixture's rows) spells
 * each handle it writes in SQL as its code, and reads each code a column returns back as its handle, through the
 * installation's own codebook, which no schema alone determines.
 */
import { Array as Arr, Formatter, Option, Result } from "effect"
import { codecOf, codeOf } from "#compiler/ir/codes.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"
import { quoteString } from "#compiler/sql/print.ts"
import { strictReader } from "#test/support/kernel/strict.ts"

/** A stored relation's field that holds a closed id, spelled and read by its roster's codes under the installation's. */
export interface ClosedField {
	/** A live handle as the literal its column stores: its code's digits, quoted, so the literal takes the column's domain. */
	readonly literal: (handle: string) => string
	/**
	 * The handle a code's output text names, read strictly: a text that is no live code of the roster is a defect of what
	 * PostgreSQL stored, since the roster's domain admits no other.
	 */
	readonly handle: (text: string) => string
}

const closedFieldOf = (
	installation: Installation,
	at: string,
	type: Extract<ScalarType, { readonly carrier: "code" }>
): ClosedField => {
	const codec = codecOf(installation.names.codes, type.roster)
	const read = strictReader(type, installation.names.codes)
	return {
		literal: (handle) => quoteString(String(codeOf(codec, handle))),
		handle: (text) => {
			const handle = read(text)
			if (Result.isFailure(handle) || typeof handle.success !== "string") {
				throw new Error(
					`${at} stores ${Formatter.format(text)}, which names no live handle of ${codec.roster}`
				)
			}
			return handle.success
		}
	}
}

/**
 * The closed id `relation`'s `field` holds, or undefined for a field of any other type, whose value its column stores
 * as itself. A relation or a field the installation's theory does not hold is a defect of the test that names it.
 */
export const closedField = (
	installation: Installation,
	relation: string,
	field: string
): ClosedField | undefined => {
	const f = Arr.findFirst(
		installation.laws.theory.relations[relation]?.fields ?? [],
		(x) => x.name === field
	)
	if (Option.isNone(f)) {
		throw new Error(
			`the test names ${relation}.${field}, which the installation stores no column of`
		)
	}
	const type = f.value.type
	return type.carrier === "code"
		? closedFieldOf(installation, `${relation}.${field}`, type)
		: undefined
}

/**
 * A column's output text as a test whose model holds handles names it: a closed id's code as the handle it names, any
 * other text as itself.
 */
export const namedText = (
	installation: Installation,
	relation: string,
	field: string
): ((text: string) => string) => {
	const closed = closedField(installation, relation, field)
	return closed === undefined ? (text) => text : closed.handle
}
