/** What the property of key-order.test.ts reads: its declarations, written in a case's key orders, and what grizzle
 * installs and serves of them. */

import { constant, type Gen, oneOf } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect } from "effect"
import { firstCodebook } from "#compiler/ir/codes.ts"
import { Fn } from "#compiler/public/compute.ts"
import { bool, float8, int4 } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { fn, relation, row, rows, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { rostersOf } from "#compiler/schema/own.ts"
import { printStatement } from "#compiler/sql/print.ts"
import { joined } from "#test/support/chunked.ts"
import { inOrder, orderOf } from "#test/support/key-order.ts"
import { asDrafted, compile } from "#test/support/migrate/kit.ts"
import { compiledLogin } from "#test/support/served-login.ts"
import { fullWorld } from "#test/support/worlds.ts"

/**
 * The declarations: `Single`, QTI's single value as edullm's grading declares it (b, base, f, field, m, n, t, u, w), the
 * heading whose attribute order sort-keys reordered; `Glyphs`, of names whose code point order is neither their UTF-16
 * code units' (U+E000 before U+10000) nor a case-folded one (Z, _, z); and `Out`, a heading of a value, rows of each
 * and one row of Single. `kernelSin(iy, x, y)` returns a value, as edullm's fdlibm port does; `pick` takes a value for
 * each of Single's fields and returns rows of it; `wrap` takes a text and rows of Single and returns one row of Out.
 * The programs call each as a query calls one: Fn.call of kernelSin, Fn.rows of pick at a stored seed's
 * values, and Fn.row of wrap, reading its field of Single's rows, at rows a query builds. Every record a
 * declaration or a call writes is written in the case's order of its keys; each body's text is the same in every case,
 * positional in its names' order, as the README tells a body to be.
 */

/** Any text. */
const Text = str.regex("^.*$", "su")

const singleFields = {
	b: bool,
	base: Text,
	f: float8,
	field: Text,
	m: int4,
	n: int4,
	t: Text,
	u: Text,
	w: Text
} as const
const singleNames = ["b", "base", "f", "field", "m", "n", "t", "u", "w"] as const

const glyphFields = {
	Z: int4,
	_: int4,
	z: int4,
	"\uE000": int4,
	"\u{10000}": int4
} as const
const glyphNames = ["Z", "_", "z", "\uE000", "\u{10000}"] as const

const outNames = ["flow", "glyphs", "one", "singles"] as const
const sinNames = ["iy", "x", "y"] as const
const wrapNames = ["flow", "singles"] as const

/** The order each record of a case writes its keys in: each heading's, each function's arguments' and each call's. */
export interface KeyOrders {
	readonly single: ReadonlyArray<(typeof singleNames)[number]>
	readonly glyphs: ReadonlyArray<(typeof glyphNames)[number]>
	readonly out: ReadonlyArray<(typeof outNames)[number]>
	readonly sinArgs: ReadonlyArray<(typeof sinNames)[number]>
	readonly pickArgs: ReadonlyArray<(typeof singleNames)[number]>
	readonly wrapArgs: ReadonlyArray<(typeof wrapNames)[number]>
	readonly sinCall: ReadonlyArray<(typeof sinNames)[number]>
	readonly pickCall: ReadonlyArray<(typeof singleNames)[number]>
	readonly wrapCall: ReadonlyArray<(typeof wrapNames)[number]>
}

/** Every record written in its names' order, as sort-keys writes it. */
export const sortedOrders: KeyOrders = {
	single: singleNames,
	glyphs: glyphNames,
	out: outNames,
	sinArgs: sinNames,
	pickArgs: singleNames,
	wrapArgs: wrapNames,
	sinCall: sinNames,
	pickCall: singleNames,
	wrapCall: wrapNames
}

/** A case's orders: every record's drawn, or every one sorted, as a source sort-keys holds writes them. */
export const keyOrdersGen: Gen<KeyOrders> = oneOf<KeyOrders>([
	constant(sortedOrders),
	(source) => ({
		single: source.draw(orderOf(singleNames)),
		glyphs: source.draw(orderOf(glyphNames)),
		out: source.draw(orderOf(outNames)),
		sinArgs: source.draw(orderOf(sinNames)),
		pickArgs: source.draw(orderOf(singleNames)),
		wrapArgs: source.draw(orderOf(wrapNames)),
		sinCall: source.draw(orderOf(sinNames)),
		pickCall: source.draw(orderOf(singleNames)),
		wrapCall: source.draw(orderOf(wrapNames))
	})
])

/** The declarations and programs with every record written in `o`'s orders: the schema and its login. */
const declaredIn = (o: KeyOrders) => {
	const Single = rows(inOrder(singleFields, o.single))
	const Glyphs = rows(inOrder(glyphFields, o.glyphs))
	const Out = rows(
		inOrder({ flow: Text, glyphs: Glyphs, one: row(Single), singles: Single }, o.out)
	)
	const kernelSin = fn("kernelSin", {
		calls: [],
		args: inOrder({ iy: int4, x: float8, y: float8 }, o.sinArgs),
		returns: float8,
		volatility: "immutable",
		nullInput: "called",
		language: "sql",
		body: fn.body`SELECT $2 + $3 * $1`
	})
	const pick = fn("pick", {
		calls: [],
		args: inOrder(singleFields, o.pickArgs),
		returns: Single,
		volatility: "immutable",
		nullInput: "called",
		language: "sql",
		body: fn.body`SELECT b, base, f, field, m, n, t, u, w`
	})
	const wrap = fn("wrap", {
		calls: [],
		args: inOrder({ flow: Text, singles: Single }, o.wrapArgs),
		returns: row(Out),
		volatility: "immutable",
		nullInput: "called",
		language: "sql",
		body: fn.body`SELECT ROW(flow, ARRAY[]::${Glyphs}[], singles[1], singles)::${Out}`
	})
	const Seed = relation(
		"Seed",
		{
			b: bool,
			base: Text,
			f: float8,
			field: Text,
			id: int4,
			iy: int4,
			m: int4,
			n: int4,
			t: Text,
			u: Text,
			w: Text,
			x: float8,
			y: float8
		},
		["id"]
	)
	const s = schema("KeyOrder", [Seed, kernelSin, pick, wrap], [])
	const singlesOf = query(s).rule((r) => {
		const { b, base, f, field, m, n, t, u, w } = v(Seed, "seed")
		return r
			.match(Seed, { b, base, f, field, m, n, t, u, w })
			.find({ b, base, f, field, m, n, t, u, w })
	})
	const picked = query(s).rule((r) => {
		const seed = v(Seed, "seed")
		const { b, base, f, field, iy, m, n, t, u, w, x, y } = seed
		const run = Fn.rows(pick, inOrder({ b, base, f, field, m, n, t, u, w }, o.pickCall))
		const p = v(run, "picked")
		return r
			.match(Seed, seed)
			.match(run, p)
			.find({
				id: seed.id,
				pb: p.b,
				pbase: p.base,
				pf: p.f,
				pfield: p.field,
				pm: p.m,
				pn: p.n,
				pt: p.t,
				pu: p.u,
				pw: p.w,
				sin: Fn.call(kernelSin, inOrder({ iy, x, y }, o.sinCall))
			})
	})
	const wrapped = query(s).rule((r) => {
		const { singles } = Fn.row(
			wrap,
			inOrder({ flow: r.param("flow", Text), singles: singlesOf }, o.wrapCall)
		)
		const q = v(singles, "single")
		return r.match(singles, q).find(q)
	})
	return { schema: s, login: fullWorld(s, { picked, wrapped }, []).server }
}

/** What grizzle makes of the declarations in `o`'s orders: the installation's statements, printed, and the login's
 * served file, its programs' SQL among it, as text. */
export interface Made {
	readonly statements: ReadonlyArray<string>
	readonly served: string
	/** Each row type's attribute names and each declared function's parameter names, in the order they install. */
	readonly installedNames: ReadonlyArray<ReadonlyArray<string>>
}

export const madeIn = (o: KeyOrders): Effect.Effect<Made> =>
	Effect.gen(function* () {
		const declared = declaredIn(o)
		const installation = compile(declared.schema, asDrafted)
		const compiled = yield* Effect.orDie(
			compiledLogin(declared.login, (owned) => firstCodebook(rostersOf(owned)))
		)
		return {
			statements: Arr.map(installation.statements, printStatement),
			served: joined(compiled.entry.text),
			installedNames: Arr.flatMap(installation.statements, (s) =>
				s.kind === "createRowType"
					? [Arr.map(s.attributes, (a) => a.name)]
					: s.kind === "createDeclaredFunction"
						? [Arr.map(s.params, (p) => p.name)]
						: []
			)
		}
	})

/** Whether `order` writes its record's keys out of their names' order. */
const unsorted = (order: ReadonlyArray<string>, sorted: ReadonlyArray<string>): boolean =>
	Arr.some(order, (name, i) => name !== sorted[i])

export type KeyOrderFeature =
	| "a heading written out of its names' order"
	| "an argument list written out of its names' order"
	| "a call's arguments written out of their names' order"
	| "every record written in its names' order"

/** The features a case's orders reach. */
export const featuresOf = (o: KeyOrders): ReadonlyArray<KeyOrderFeature> => {
	const heading =
		unsorted(o.single, sortedOrders.single) ||
		unsorted(o.glyphs, sortedOrders.glyphs) ||
		unsorted(o.out, sortedOrders.out)
	const args =
		unsorted(o.sinArgs, sortedOrders.sinArgs) ||
		unsorted(o.pickArgs, sortedOrders.pickArgs) ||
		unsorted(o.wrapArgs, sortedOrders.wrapArgs)
	const calls =
		unsorted(o.sinCall, sortedOrders.sinCall) ||
		unsorted(o.pickCall, sortedOrders.pickCall) ||
		unsorted(o.wrapCall, sortedOrders.wrapCall)
	return [
		...(heading ? (["a heading written out of its names' order"] as const) : []),
		...(args ? (["an argument list written out of its names' order"] as const) : []),
		...(calls ? (["a call's arguments written out of their names' order"] as const) : []),
		...(heading || args || calls ? [] : (["every record written in its names' order"] as const))
	]
}
