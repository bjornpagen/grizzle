/** What the property of function-bodies.test.ts reads: a case's schema owned, and the rule restated over its sketch. */

import type * as Result from "@bjornpagen/grizzle-text/base/result"
import { defined } from "@bjornpagen/testing/assert"
import { Array as Arr } from "effect"
import type { CompileError } from "#compiler/core/errors.ts"
import type { SourceLoc } from "#compiler/core/loc.ts"
import { schema } from "#compiler/public/schema.ts"
import { functionDescOf } from "#compiler/schema/function.ts"
import { type Owned, own } from "#compiler/schema/own.ts"
import { schemaDescOf } from "#compiler/schema/schema.ts"
import {
	bodyParts,
	type Declarations,
	drawnFunctions,
	type FunctionSketch,
	type HeadingSketch,
	helperOf,
	reachOf
} from "#test/support/declared-functions.ts"

export type BodySituation =
	| "owned"
	| "refused"
	| "a body naming its own signature's heading"
	| "a body naming a callee's heading alone"
	| "a body naming a heading beyond its reach"

/** Whether two headings are one: the same fields, each of the same name and value type, in order. */
const sameHeading = (a: HeadingSketch, b: HeadingSketch): boolean =>
	a.fields.length === b.fields.length &&
	Arr.every(a.fields, ([name, type], i) => {
		const other = b.fields[i]
		return other?.[0] === name && other[1] === type
	})

/** The headings a function's body names, by their places. */
const namedBy = (v: Declarations, f: FunctionSketch): ReadonlyArray<number> =>
	Arr.dedupe(Arr.flatMap(bodyParts(v, f), (p) => (typeof p === "string" ? [] : [p.heading])))

/** Whether heading `h` is, by content, one of the headings at `among`. */
const oneOf = (v: Declarations, h: number, among: ReadonlyArray<number>): boolean => {
	const heading = defined(v.headings[h], `heading ${h}`)
	return Arr.some(among, (r) => sameHeading(heading, defined(v.headings[r], `heading ${r}`)))
}

/** The drawn functions whose bodies name a heading no signature of their reach takes, by name. */
export const bodyNamesOutsideReach = (v: Declarations): ReadonlyArray<string> =>
	Arr.flatMap(v.functions, (f) =>
		Arr.some(namedBy(v, f), (h) => !oneOf(v, h, reachOf(v, f))) ? [f.name] : []
	)

/** The situations a case reaches by its bodies' names. */
export const situationsOf = (v: Declarations): ReadonlyArray<BodySituation> =>
	Arr.dedupe(
		Arr.flatMap(v.functions, (f) =>
			Arr.map(namedBy(v, f), (h): BodySituation => {
				const own = reachOf(v, { ...f, callees: [] })
				return oneOf(v, h, own)
					? "a body naming its own signature's heading"
					: oneOf(v, h, reachOf(v, f))
						? "a body naming a callee's heading alone"
						: "a body naming a heading beyond its reach"
			})
		)
	)

/** A case's schema owned, beside each drawn function's source location by name. */
export const ownedFunctions = (
	v: Declarations
): {
	readonly owned: Result.Result<Owned, CompileError>
	readonly locs: ReadonlyMap<string, SourceLoc>
} => {
	const helper = helperOf()
	const functions = drawnFunctions(v, helper)
	const s = schema("Bodies", [helper, ...functions], [])
	return {
		owned: own(defined(schemaDescOf(s), "the case's description")),
		locs: new Map(
			Arr.map(functions, (f) => {
				const desc = defined(functionDescOf(f), "a declared function's description")
				return [desc.name, desc.loc] as const
			})
		)
	}
}
