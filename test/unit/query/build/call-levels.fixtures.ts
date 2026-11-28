/** What the property of call-levels.test.ts reads: its schemas, its calls, its space and its model. */

import { array, element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, Record as Rec } from "effect"
import { Fn } from "#compiler/public/compute.ts"
import { int4 } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { fn, relation, row, rows, schema } from "#compiler/public/schema.ts"

/**
 * A call of a declared function (Fn.rows, Fn.row) whose rows arguments are written over levels of one
 * schema: Base holds Item(item, pos) and two functions of `n` rows arguments a0, a1, ..., each rows of Line (pos):
 * `merged`, which returns rows of Line, and `split`, which returns one row of Split, whose field `lines` holds rows of
 * Line. Upper and Aside each extend Base by a relation of their own, so Base is a level of each and neither is a level
 * of the other. Each rows argument is the lines of Item, every one's or one item's (a bound query), built by a query(S)
 * call of its own over the level it names, as a caller builds each where it reads it: edullm's response_processing_of
 * takes 27, every one query(Installed).
 */

/** The rows each rows argument passes and each function returns. */
const Line = rows({ pos: int4 })

/** The one row `split` returns. */
const Split = rows({ lines: Line })

const Item = relation("Item", { item: int4, pos: int4 }, ["item", "pos"])

/** Upper's relation of its own. */
const Mark = relation("Mark", { mark: int4 }, ["mark"])

/** Aside's relation of its own. */
const Note = relation("Note", { note: int4 }, ["note"])

/** The name of the i-th rows argument. */
const argName = (i: number): string => `a${i}`

/** The arguments of a function of `n` rows arguments, each rows of Line. */
const lineArgs = (n: number): Readonly<Record<string, typeof Line>> =>
	Rec.fromEntries(Array.from({ length: n }, (_, i) => [argName(i), Line] as const))

const mergedOf = (n: number) =>
	fn("merged", {
		calls: [],
		args: lineArgs(n),
		returns: Line,
		volatility: "immutable",
		nullInput: "called",
		language: "sql",
		body: fn.body`SELECT p.pos FROM unnest(a0) AS p`
	})

const splitOf = (n: number) =>
	fn("split", {
		calls: [],
		args: lineArgs(n),
		returns: row(Split),
		volatility: "immutable",
		nullInput: "called",
		language: "sql",
		body: fn.body`SELECT ROW(a0)::${Split}`
	})

/** The levels a rows argument or a rule is written over. */
export const levelNames = ["base", "upper", "aside"] as const

export type LevelName = (typeof levelNames)[number]

/** The levels of each level: itself and Base, below it. */
const levelsOf: { readonly [L in LevelName]: ReadonlyArray<LevelName> } = {
	base: ["base"],
	upper: ["base", "upper"],
	aside: ["base", "aside"]
}

/** The two calls of rows. */
const callKinds = ["rowsOf", "rowOf"] as const

export type CallKind = (typeof callKinds)[number]

/** A rows argument: the level its query(S) is over, and whether it is bound to one item. */
export interface RowsArgument {
	readonly over: LevelName
	readonly bound: boolean
}

/** A case: the call and its rows arguments, in order. */
export interface CallCase {
	readonly kind: CallKind
	readonly args: ReadonlyArray<RowsArgument>
}

/** The most rows arguments a case passes: edullm's response_processing_of's, the most a caller passes. */
const mostArguments = 27

export const callCaseGen: Gen<CallCase> = (source) => ({
	kind: source.draw(element(callKinds)),
	args: source.draw(
		array(
			(s): RowsArgument => ({
				over: s.draw(element(levelNames)),
				bound: s.draw(element([false, true]))
			}),
			{ min: 1, max: mostArguments }
		)
	)
})

/** What the model says of a case: the level its call is over, the highest of its arguments', or none where neither of two is a level of the other. */
export const modelTop = (args: ReadonlyArray<RowsArgument>): LevelName | undefined => {
	const named = new Set(Arr.map(args, (a) => a.over))
	if (named.has("upper") && named.has("aside")) {
		return undefined
	}
	return named.has("upper") ? "upper" : named.has("aside") ? "aside" : "base"
}

/** Whether a rule over `over` may match a call over `top`: `top` is one of its levels. */
export const holds = (over: LevelName, top: LevelName): boolean => levelsOf[over].includes(top)

/** A case's shape: one rows argument, several over one level, several over levels one of which holds every other, or none does. */
const shapes = ["single", "oneLevel", "comparable", "incomparable"] as const

export type Shape = (typeof shapes)[number]

export const shapeOf = (args: ReadonlyArray<RowsArgument>): Shape => {
	const named = new Set(Arr.map(args, (a) => a.over))
	return args.length === 1
		? "single"
		: named.size === 1
			? "oneLevel"
			: modelTop(args) === undefined
				? "incomparable"
				: "comparable"
}

export type CallFeature = `${CallKind}:${Shape}`

/** Every call kind at every shape. */
export const callSituations: ReadonlyArray<CallFeature> = Arr.flatMap(callKinds, (k) =>
	Arr.map(shapes, (s): CallFeature => `${k}:${s}`)
)

/** The schemas of a case of `n` rows arguments: Base with its functions, and Upper and Aside over it. */
export const levelsFor = (n: number) => {
	const merged = mergedOf(n)
	const split = splitOf(n)
	const base = schema("Base", [Item, merged, split], [])
	const levels = {
		base,
		upper: schema.extend([base], "Upper", [Mark], []),
		aside: schema.extend([base], "Aside", [Note], [])
	}
	/** A rows argument: Item's lines, every item's or the one item 1, by a query(S) call of its own. */
	const argument = (a: RowsArgument) => {
		if (a.bound) {
			return query(levels[a.over])
				.rule((r) => {
					const { pos } = v(Item, "line")
					return r.match(Item, { item: r.param("item", int4), pos }).find({ pos })
				})
				.bind({ item: 1 })
		}
		return query(levels[a.over]).rule((r) => {
			const { item, pos } = v(Item, "line")
			return r.match(Item, { item, pos }).find({ pos })
		})
	}
	/** The call's rows, a source, its arguments built each by its own query(S) call now. */
	const source = (c: CallCase) => {
		const args = Rec.fromEntries(Arr.map(c.args, (a, i) => [argName(i), argument(a)] as const))
		return c.kind === "rowsOf" ? Fn.rows(merged, args) : Fn.row(split, args).lines
	}
	/** A rule over `over` that matches the source and finds its rows. */
	const matching = (over: LevelName, call: ReturnType<typeof source>) =>
		query(levels[over]).rule((r) => {
			const { pos } = v(call, "call")
			return r.match(call, { pos }).find({ pos })
		})
	return { levels, source, matching }
}
