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
	helperOf,
	reachOf,
	type TypeSketch
} from "#test/support/declared-functions.ts"

export type BodySituation =
	| "owned"
	| "refused"
	| "a body naming its own signature's heading"
	| "a body naming a callee's heading alone"
	| "a body naming a heading beyond its reach"
	| "a body naming a heading a field of its reach holds"

/** A heading's content as declared: each field's name and value type, a heading it holds rows or a row of by its own
 * content, so two headings are one exactly where their keys are. */
const declaredKey = (v: Declarations, at: number): string =>
	Arr.join(
		Arr.map(defined(v.headings[at], `heading ${at}`).fields, ([name, t]) =>
			t.kind === "value"
				? `${name} ${t.type}`
				: `${name} ${t.kind} of (${declaredKey(v, t.heading)})`
		),
		", "
	)

/** The headings a function's body names, by their places. */
const namedBy = (v: Declarations, f: FunctionSketch): ReadonlyArray<number> =>
	Arr.dedupe(Arr.flatMap(bodyParts(v, f), (p) => (typeof p === "string" ? [] : [p.heading])))

/** Whether heading `h` is, by content, one of the headings at `among`. */
const oneOf = (v: Declarations, h: number, among: ReadonlyArray<number>): boolean =>
	Arr.some(among, (r) => declaredKey(v, r) === declaredKey(v, h))

/** The drawn functions whose bodies name a heading no signature of their reach takes, by name. */
export const bodyNamesOutsideReach = (v: Declarations): ReadonlyArray<string> =>
	Arr.flatMap(v.functions, (f) =>
		Arr.some(namedBy(v, f), (h) => !oneOf(v, h, reachOf(v, f))) ? [f.name] : []
	)

/** The headings a function's own signature and its callees' are rows or a row of, none a field holds. */
const directlyOf = (v: Declarations, f: FunctionSketch): ReadonlyArray<number> =>
	Arr.flatMap(
		[f, ...Arr.flatMap(f.callees, (callee) => Arr.filter(v.functions, (g) => g.name === callee))],
		(g) =>
			Arr.flatMap([...Arr.map(g.args, (a) => a.type), g.returns], (t: TypeSketch) =>
				t.kind === "value" ? [] : [t.heading]
			)
	)

/** The situations a case reaches by its bodies' names. */
export const situationsOf = (v: Declarations): ReadonlyArray<BodySituation> =>
	Arr.dedupe(
		Arr.flatMap(v.functions, (f) =>
			Arr.flatMap(namedBy(v, f), (h): ReadonlyArray<BodySituation> => {
				const own = reachOf(v, { ...f, callees: [] })
				const reach = reachOf(v, f)
				const where: BodySituation = oneOf(v, h, own)
					? "a body naming its own signature's heading"
					: oneOf(v, h, reach)
						? "a body naming a callee's heading alone"
						: "a body naming a heading beyond its reach"
				return oneOf(v, h, reach) && !oneOf(v, h, directlyOf(v, f))
					? [where, "a body naming a heading a field of its reach holds"]
					: [where]
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
