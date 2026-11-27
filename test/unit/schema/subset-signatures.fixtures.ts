/** What subset-signatures.test.ts reads: its roster, its box of signatures and what ownership makes of each. */

import type * as Result from "@bjornpagen/grizzle-text/base/result"
import { defined } from "@bjornpagen/testing/assert"
import { element, type Gen } from "@bjornpagen/testing/gen"
import type { CompileError } from "#compiler/core/errors.ts"
import { closedId, pg } from "#compiler/public/fields.ts"
import { closed, fn, row, rows, schema } from "#compiler/public/schema.ts"
import { own } from "#compiler/schema/own.ts"
import { schemaDescOf } from "#compiler/schema/schema.ts"

/** Where a closed id stands in a declared function's signature. */
const places = ["an argument", "a result", "rows of a heading", "a row of a heading"] as const
type Place = (typeof places)[number]

/** The closed id a signature holds: of its whole roster, of `only` a subset, or of every handle `except` one. */
const forms = ["whole", "only", "except"] as const
type Form = (typeof forms)[number]

/** A case: a closed id of a form at a place. */
export interface SignatureCase {
	readonly place: Place
	readonly form: Form
}

/** The box: every form at every place. */
export const signatureCases: Gen<SignatureCase> = (s) => ({
	place: s.draw(element(places)),
	form: s.draw(element(forms))
})

/** The roster every case's closed id is of. */
const Mark = closed.ordered("Mark", ["p", "q", "r"])

/** A case's closed id. */
const markOf = (form: Form) => {
	switch (form) {
		case "whole":
			return closedId(Mark)
		case "only":
			return closedId(Mark, { only: ["p"] })
		case "except":
			return closedId(Mark, { except: ["p"] })
	}
}

/**
 * The definition of a function holding `mark` at `place`, as a JavaScript caller hands fn it: its body is text grizzle
 * never reads, so the case is its signature alone.
 */
const declared = (place: Place, mark: unknown): unknown => {
	const heading: unknown = Reflect.apply(rows, undefined, [{ mark, n: pg.integer }])
	const common = {
		calls: [],
		volatility: "immutable",
		nullInput: "called",
		language: "sql",
		body: fn.body`SELECT $1`
	}
	switch (place) {
		case "an argument":
			return { ...common, args: { mark }, returns: pg.integer }
		case "a result":
			return { ...common, args: { n: pg.integer }, returns: mark }
		case "rows of a heading":
			return { ...common, args: { n: pg.integer }, returns: heading }
		case "a row of a heading": {
			const one: unknown = Reflect.apply(row, undefined, [heading])
			return { ...common, args: { one }, returns: one }
		}
	}
}

/** A case's schema, Mark and its one function, owned as `grizzle generate` owns it, or its refusal. */
export const ownedCase = (c: SignatureCase): Result.Result<unknown, CompileError> => {
	const f: unknown = Reflect.apply(fn, undefined, ["marked", declared(c.place, markOf(c.form))])
	const s: unknown = Reflect.apply(schema, undefined, ["Signatures", [Mark, f], []])
	return own(defined(schemaDescOf(s), "the case's description"))
}
