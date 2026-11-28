/** What the properties of literal.test.ts read: its spaces, models and helpers. */

import type { NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import { assert, defined } from "@bjornpagen/testing/assert"
import { array, boolean, element, type Gen, int, subarray, weighted } from "@bjornpagen/testing/gen"
import { bigint } from "@bjornpagen/testing/values"
import { regex } from "arkregex"
import { Array as Arr, Option, Predicate, Record as Rec, String as Str } from "effect"
import type { Constant, Entry, LiteralFault } from "#compiler/ir/cells.ts"
import type { ExprDesc, LiteralDesc } from "#compiler/ir/desc.ts"
import { closedId, natural, slot } from "#compiler/public/fields.ts"
import { closed, fin, schema } from "#compiler/public/schema.ts"
import { admitClosedRelation, closedBuilder, relationDescOf } from "#compiler/schema/relation.ts"
import type { PackLayout } from "#compiler/sql/ast.ts"
import type { Token } from "#compiler/sql/lexer.ts"
import { lex } from "#compiler/sql/lexer.ts"
import {
	check,
	contained,
	counted,
	eq,
	f,
	field,
	fin as finDesc,
	fold,
	on,
	relation,
	type SchemaDesc
} from "#test/support/fixtures/ir/desc.ts"

/** Hex digits as grizzle writes them: 0-9 and A-F, none lowercase. */
const hexDigits = regex("^[0-9A-F]*$")

/** Every point of the space whose coordinates hold `sizes` codes each, first coordinate most significant. */
export const odometer = (sizes: ReadonlyArray<number>): ReadonlyArray<ReadonlyArray<number>> => {
	const origin: ReadonlyArray<ReadonlyArray<number>> = [[]]
	return Arr.reduce(sizes, origin, (prefixes, size) =>
		Arr.flatMap(prefixes, (prefix) =>
			Array.from({ length: size }, (_, digit) => [...prefix, digit])
		)
	)
}

/** The handle of code `code` in every roster these suites declare. */
const handleOf = (code: number): string => `h${code}`

/** A roster of `size` codes, h0 to h<size - 1>. */
const handlesOf = (size: number): NonEmptyReadonlyArray<string> => [
	handleOf(0),
	...Array.from({ length: size - 1 }, (_, code) => handleOf(code + 1))
]

/** An array's literal as the oracle reads it: its elements, or the fault a reader refuses it for. */
export type OracleRead =
	| { readonly kind: "elements"; readonly elements: ReadonlyArray<bigint> }
	| { readonly kind: "fault"; readonly fault: LiteralFault }

/** An element of a literal as grizzle spells an index or a code: decimal digits, no sign, no leading 0. */
const canonicalCode = regex("^(0|[1-9][0-9]*)$")

/**
 * A literal read over its layout by the oracle, element by element: refused where it is unbraced, or a cells literal not
 * led by the sentinel -1 (`array`); at the first element past any sentinel no canonical numeral (`element`), an index no
 * greater than the one before (`order`) or at or past the cells (`cell`), or a payload code at or past the payload codes
 * (`code`); otherwise its elements past any sentinel.
 */
export const oracleRead = (text: string, layout: PackLayout): OracleRead => {
	if (!Str.startsWith("{")(text) || !Str.endsWith("}")(text) || text.length < 2) {
		return { kind: "fault", fault: { kind: "array" } }
	}
	const all = text === "{}" ? [] : Str.split(",")(Str.slice(1, -1)(text))
	if (layout.kind === "cells" && all[0] !== "-1") {
		return { kind: "fault", fault: { kind: "array" } }
	}
	const elements = layout.kind === "cells" ? Arr.drop(all, 1) : all
	const read: Array<bigint> = []
	for (const [i, element] of elements.entries()) {
		const at = i + 1
		if (!canonicalCode.test(element)) {
			return { kind: "fault", fault: { kind: "element", at } }
		}
		const value = BigInt(element)
		if (layout.kind === "cells" && value <= (read.at(-1) ?? -1n)) {
			return { kind: "fault", fault: { kind: "order", at } }
		}
		if (layout.kind === "cells" && value >= layout.cells) {
			return { kind: "fault", fault: { kind: "cell", at, cell: value } }
		}
		if (layout.kind === "payloads" && value >= layout.points) {
			return { kind: "fault", fault: { kind: "code", at, code: value } }
		}
		read.push(value)
	}
	return { kind: "elements", elements: read }
}

/** The least index of two cells literals' elements one holds and the other does not; none where they agree. */
export const firstCellApart = (
	a: ReadonlyArray<bigint>,
	b: ReadonlyArray<bigint>
): bigint | undefined => {
	const inA = new Set(a)
	const inB = new Set(b)
	return Arr.reduce(
		Arr.filter([...a, ...b], (x) => !inA.has(x) || !inB.has(x)),
		undefined,
		(least: bigint | undefined, x) => (least === undefined || x < least ? x : least)
	)
}

/** The first place two payloads literals' elements part, one holding none or another there; none where they agree. */
export const firstPlaceApart = (
	a: ReadonlyArray<bigint>,
	b: ReadonlyArray<bigint>
): number | undefined =>
	Option.getOrUndefined(
		Arr.findFirstIndex(
			Array.from({ length: Math.max(a.length, b.length) }, (_, i) => i),
			(i) => a[i] !== b[i]
		)
	)

/** An edit of a literal: the edited text, and what the edit did, in words. */
export interface Edit {
	readonly text: string
	readonly what: string
}

/**
 * Every edit of a literal a reader must refuse: each element one up and one down, dropped, written twice and written with
 * a leading 0, an element past every other added, and a cells literal's sentinel dropped.
 */
export const editsOf = (text: string, layout: PackLayout): ReadonlyArray<Edit> => {
	const all = text === "{}" ? [] : Str.split(",")(Str.slice(1, -1)(text))
	const lead = layout.kind === "cells" ? Arr.take(all, 1) : []
	const elements = Arr.drop(all, lead.length)
	const literal = (es: ReadonlyArray<string>): string => `{${Arr.join([...lead, ...es], ",")}}`
	const replaced = (at: number, element: ReadonlyArray<string>): string =>
		literal([...elements.slice(0, at), ...element, ...elements.slice(at + 1)])
	const last = Arr.reduce(elements, -1n, (most, e) => (BigInt(e) > most ? BigInt(e) : most))
	return [
		...Arr.flatMap(elements, (element, at) => {
			const value = BigInt(element)
			return [
				{ text: replaced(at, [(value + 1n).toString()]), what: `entry ${at + 1} one up` },
				...(value > 0n
					? [{ text: replaced(at, [(value - 1n).toString()]), what: `entry ${at + 1} one down` }]
					: []),
				{ text: replaced(at, []), what: `entry ${at + 1} dropped` },
				{ text: replaced(at, [element, element]), what: `entry ${at + 1} written twice` },
				{ text: replaced(at, [`0${element}`]), what: `entry ${at + 1} with a leading 0` }
			]
		}),
		{
			text: literal([...elements, (last + 1n).toString()]),
			what: "an element past every other added"
		},
		...(layout.kind === "cells"
			? [{ text: `{${Arr.join(elements, ",")}}`, what: "the sentinel dropped" }]
			: [])
	]
}

/** A printed pack with its literal replaced by `text`. */
export const restated = (printed: string, from: string, text: string): string =>
	Str.replace(`'${from}'::`, `'${text}'::`)(printed)

type Payload = "no payload" | "a closed-id payload" | "an open payload"

export type DraftFeature =
	| Payload
	| "a padded set"
	| "a whole-digit set"
	| "a constant of payload codes"
	| "a constant of no row"
	| "a containment's side"
	| "an or fold"
	| "a set literal of no handle"

export interface Draft {
	/** Each roster's codes, R0 first. */
	readonly sizes: NonEmptyReadonlyArray<number>
	/** The roster of each key field of the closed relation C, in key order. */
	readonly key: NonEmptyReadonlyArray<number>
	readonly payload: Payload
	/** The roster of C's closed-id payload. */
	readonly payloadRoster: number
	/** C holds the key at index i when i mod 3 is below this. */
	readonly density: number
	/** The roster T's sets are over, and the codes of the set its row check holds them apart from. */
	readonly setRoster: number
	readonly literal: ReadonlyArray<number>
	readonly contained: boolean
	/** Whether the schema folds members' sets into their owner's, over which roster. */
	readonly fold: boolean
	readonly foldRoster: number
}

export const schemas: Gen<Draft> = (s) => {
	const sizes: NonEmptyReadonlyArray<number> = [
		s.draw(int(1, 9)),
		...s.draw(array(int(1, 9), { min: 0, max: 2 }))
	]
	const roster = int(0, sizes.length - 1)
	const setRoster = s.draw(roster)
	return {
		sizes,
		key: [s.draw(roster), ...(s.draw(boolean) ? [s.draw(roster)] : [])],
		payload: s.draw(element<Payload>(["no payload", "a closed-id payload", "an open payload"])),
		payloadRoster: s.draw(roster),
		density: s.draw(int(0, 3)),
		setRoster,
		literal: s.draw(subarray(Array.from({ length: defined(sizes[setRoster]) }, (_, code) => code))),
		contained: s.draw(boolean),
		fold: s.draw(boolean),
		foldRoster: s.draw(roster)
	}
}

/** Roster i's name. */
export const rosterName = (i: number): string => `R${i}`

/** A set over roster i, as a field's description. */
const setOver = (i: number) => ({ kind: "bits", roster: rosterName(i) }) as const

/** A set's or a value's literal, its type taken from the term it meets. */
const literalOfDesc = (value: LiteralDesc): ExprDesc => ({
	kind: "literal",
	value
})

/** A scalar operation's description. */
const computed = (
	fn: "union" | "intersection" | "difference" | "disjoint" | "singleton",
	args: ReadonlyArray<ExprDesc>
): ExprDesc => ({ kind: "compute", fn, args })

/** The schema a draw declares. */
export const schemaOf = (d: Draft): SchemaDesc => {
	const rosters = Arr.map(d.sizes, (size, i) =>
		closedBuilder(rosterName(i), handlesOf(size), "ordered", [])
	)
	const rosterAt = (i: number) => defined(rosters[i], "a drawn roster")
	const sizeAt = (i: number): number => defined(d.sizes[i], "a drawn roster's size")
	const keyNames = Arr.map(d.key, (_, j) => `k${j}`)
	const keySizes = Arr.map(d.key, sizeAt)
	const payloadField =
		d.payload === "a closed-id payload"
			? { p: closedId(rosterAt(d.payloadRoster)) }
			: d.payload === "an open payload"
				? { p: natural }
				: {}
	const rows = Arr.flatMap(odometer(keySizes), (digits, index) =>
		index % 3 < d.density
			? [
					{
						...Rec.fromEntries(Arr.map(digits, (digit, j) => [`k${j}`, handleOf(digit)] as const)),
						...(d.payload === "a closed-id payload"
							? { p: handleOf(index % sizeAt(d.payloadRoster)) }
							: d.payload === "an open payload"
								? { p: BigInt(index % 3) }
								: {})
					}
				]
			: []
	)
	const C = admitClosedRelation(
		"C",
		{
			...Rec.fromEntries(Arr.map(d.key, (r, j) => [`k${j}`, closedId(rosterAt(r))] as const)),
			...payloadField
		},
		keyNames,
		rows,
		[]
	).desc
	const sets = setOver(d.setRoster)
	const T = relation(
		"T",
		{
			id: f.uuid,
			a: sets,
			b: sets,
			u: f.generated(sets, computed("union", [field("a"), field("b")])),
			i: f.generated(sets, computed("intersection", [field("a"), field("b")])),
			d: f.generated(sets, computed("difference", [field("a"), field("b")])),
			one: f.generated(setOver(d.key[0]), computed("singleton", [field("kk0")])),
			...Rec.fromEntries(Arr.map(d.key, (r, j) => [`kk${j}`, f.closedId(rosterName(r))] as const))
		},
		["id"]
	)
	const folded = setOver(d.foldRoster)
	return {
		name: "Hex",
		relations: [
			...Arr.map(rosters, (r, i) => relationDescOf(r, rosterName(i))),
			C,
			T,
			...(d.fold
				? [
						relation(
							"Owner",
							{ id: f.uuid, n: f.drawn, seen: f.accumulated(folded, { handles: [] }) },
							["id"]
						),
						relation("Member", { id: f.uuid, owner: f.uuid, tags: folded }, ["id"])
					]
				: [])
		],
		statements: [
			check(
				"Apart",
				"T",
				eq(
					computed("disjoint", [
						field("a"),
						literalOfDesc({ handles: Arr.map(d.literal, handleOf) })
					]),
					literalOfDesc(true)
				)
			),
			...(d.contained
				? [
						contained(
							on(
								"T",
								Arr.map(d.key, (_, j) => `kk${j}`)
							),
							on("C", keyNames)
						)
					]
				: []),
			...(d.fold
				? [
						counted(on("Member", ["owner"]), finDesc("Owner", "n")),
						fold(
							finDesc("Owner", "n"),
							"or",
							on("Member", ["owner", "tags"]),
							on("Owner", ["id", "seen"])
						)
					]
				: [])
		],
		bases: []
	}
}

/** Every token of a migration file, a dollar-quoted body's own tokens in its place. */
const tokensOf = (text: string): ReadonlyArray<Token> => {
	const lexed = lex(text)
	assert.equal(lexed.error, undefined, "a migration file lexes whole")
	return Arr.flatMap(lexed.tokens, (t) => (t.kind === "dollar" ? tokensOf(t.body) : [t]))
}

/**
 * The type a cast at `i`, the `::` token, names, and the index past it: a bit type (bit or bit varying, or a bits
 * domain among `domains`) or another.
 */
const castAt = (
	tokens: ReadonlyArray<Token>,
	i: number,
	domains: ReadonlySet<string>
): { readonly bits: boolean; readonly end: number } => {
	const first = tokens[i + 1]
	if (first?.kind === "word") {
		const bitWord = first.upper === "BIT"
		const after = tokens[i + 2]
		const varying = after?.kind === "word" && bitWord
		const sized = after?.kind === "punct" && after.text === "("
		return { bits: bitWord, end: i + (varying ? 3 : sized ? 5 : 2) }
	}
	const schemaDot = tokens[i + 2]
	const named = schemaDot?.kind === "punct" && schemaDot.text === "." ? tokens[i + 3] : first
	const end = named === first ? i + 2 : i + 4
	return { bits: named?.kind === "quotedIdent" && domains.has(named.text), end }
}

/** What a file's text breaks of the one spelling: each violation in words, none for a file that keeps it. */
export const fileViolations = (
	text: string,
	domains: ReadonlySet<string>
): ReadonlyArray<string> => {
	const tokens = tokensOf(text)
	const isConcat = (t: Token | undefined): boolean => t?.kind === "operator" && t.text === "||"
	return Arr.flatMap(tokens, (t, i): ReadonlyArray<string> => {
		if (t.kind === "word" && t.upper === "STRING_AGG") {
			return ["string_agg"]
		}
		if (t.kind === "quotedIdent" && t.text === "string_agg") {
			return ["string_agg"]
		}
		if (t.kind !== "string") {
			return []
		}
		const next = tokens[i + 1]
		const cast =
			next?.kind === "punct" && next.text === "::" ? castAt(tokens, i + 1, domains) : undefined
		if (t.prefix === "B") {
			return [`a binary bit string B'${t.text}'`]
		}
		if (t.prefix === "X") {
			return [
				...(hexDigits.test(t.text) ? [] : [`the X'' at ${t.start} is no run of hex digits`]),
				...(cast === undefined ? [`X'${t.text}' uncast`] : []),
				...(isConcat(tokens[i - 1]) || (cast !== undefined && isConcat(tokens[cast.end]))
					? [`X'${t.text}' joined by ||`]
					: [])
			]
		}
		return t.prefix === undefined && cast?.bits === true
			? [`the text '${t.text}' cast to a bit type`]
			: []
	})
}

/** Every node of a value, objects and arrays walked through. */
const nodesOf = (value: unknown): ReadonlyArray<{ readonly [x: PropertyKey]: unknown }> =>
	Arr.isArray(value)
		? Arr.flatMap(value, nodesOf)
		: Predicate.isObject(value)
			? [value, ...Arr.flatMap(Rec.values(value), nodesOf)]
			: []

/** A node's string property, none where it holds another. */
const textAt = (node: { readonly [x: PropertyKey]: unknown }, key: string): string | undefined => {
	const value = node[key]
	return typeof value === "string" ? value : undefined
}

/** A node's object property, none where it holds another. */
const objectAt = (
	node: { readonly [x: PropertyKey]: unknown },
	key: string
): { readonly [x: PropertyKey]: unknown } | undefined => {
	const value = node[key]
	return Predicate.isObject(value) ? value : undefined
}

/**
 * What the snapshot's statements break of the one spelling, read off its AST: a text literal of a bit type, a bit
 * literal off hex digits or, typed by a bits domain, not of its width, a bits domain of another width, a live
 * constant other than its roster's live codes, and a pack whose literal the oracle refuses over its cells and payload
 * codes, or counts other rows than it holds.
 */
export const snapshotViolations = (
	snapshot: unknown,
	widths: ReadonlyMap<string, number>,
	lives: ReadonlySet<string>
): ReadonlyArray<string> =>
	Arr.flatMap(nodesOf(snapshot), (node): ReadonlyArray<string> => {
		const kind = textAt(node, "kind")
		const type = objectAt(node, "type") ?? objectAt(node, "base") ?? objectAt(node, "returns")
		const typeName = type === undefined ? undefined : textAt(type, "name")
		const bitTyped =
			typeName === "bit" ||
			typeName === "bit varying" ||
			(typeName !== undefined && widths.has(typeName))
		if (kind === "literal") {
			const value = objectAt(node, "value")
			const valueKind = value === undefined ? undefined : textAt(value, "kind")
			const hex = value === undefined ? undefined : textAt(value, "hex")
			if (valueKind === "text" && bitTyped) {
				return [`a text literal of ${typeName}`]
			}
			if (valueKind !== "bits") {
				return []
			}
			const width = typeName === undefined ? undefined : widths.get(typeName)
			return [
				...(hex !== undefined && hexDigits.test(hex) ? [] : ["a bit literal off hex digits"]),
				...(width !== undefined && (hex ?? "").length * 4 !== width
					? [`a set literal of ${hex ?? ""} at bit(${width})`]
					: [])
			]
		}
		if (kind === "createDomain" && type !== undefined && typeName === "bit") {
			const name = textAt(objectAt(node, "name") ?? {}, "name") ?? ""
			const width = widths.get(name)
			return width === undefined || type["length"] !== width
				? [`the bits domain ${name} over bit(${String(type["length"])})`]
				: []
		}
		if (kind === "createConstant" && typeName === "bit varying") {
			const body = objectAt(node, "body")
			const value = body === undefined ? undefined : objectAt(body, "value")
			const hex = value === undefined ? undefined : textAt(value, "hex")
			return hex !== undefined && lives.has(hex)
				? []
				: ["a live constant other than its live codes"]
		}
		if (kind === "packConstant") {
			const text = textAt(node, "text") ?? ""
			const layout = objectAt(node, "layout")
			const rows = node["rows"]
			const cells = layout?.["cells"]
			const points = layout?.["points"]
			const read: PackLayout | undefined =
				textAt(layout ?? {}, "kind") === "cells" && typeof cells === "bigint"
					? { kind: "cells", cells }
					: textAt(layout ?? {}, "kind") === "payloads" && typeof points === "bigint"
						? { kind: "payloads", points }
						: undefined
			if (read === undefined || typeof rows !== "number") {
				return ["a pack of no layout"]
			}
			const held = oracleRead(text, read)
			return held.kind === "fault"
				? [`a pack whose literal ${text} the oracle refuses: ${held.fault.kind}`]
				: held.elements.length === rows
					? []
					: [`a pack counting ${rows} rows where it holds ${held.elements.length}`]
		}
		return []
	})

export type LiteralFeature =
	| "a set"
	| "a function"
	| "a payload space at the most codes"
	| "a literal of no code"
	| "no cell held"
	| "every cell held"
	| "an edit out of order or range"
	| "an edit of another constant"

/** A drawn constant: its cells, its payload codes, and each cell's payload code where it holds one. */
export interface CodeString {
	readonly cells: number
	readonly points: bigint
	readonly held: ReadonlyArray<bigint | undefined>
}

/** The most payload codes a constant holds (physical/ddl/constants.ts payloadMaxCodes), the oracle's count. */
export const mostPoints = 2n ** 63n

export const strings: Gen<CodeString> = (s) => {
	const cells = s.draw(int(0, 40))
	const points = s.draw(
		weighted([
			[2, element([1n])],
			[5, bigint(2n, 9n)],
			[1, element([mostPoints - 1n, mostPoints])]
		])
	)
	const density = s.draw(int(0, 4))
	const payload = bigint(0n, points - 1n)
	return {
		cells,
		points,
		held: Array.from({ length: cells }, () =>
			s.draw(int(1, 4)) <= density ? s.draw(payload) : undefined
		)
	}
}

/** The constant a draw states. */
export const codeConstantOf = (d: CodeString): Constant => ({
	cells: BigInt(d.cells),
	points: d.points,
	entries: Arr.flatMap(d.held, (payload, index): ReadonlyArray<Entry> =>
		payload === undefined ? [] : [{ index: BigInt(index), payload }]
	)
})

const Version = closed.ordered("Version", ["v0", "v1"])

const Kind = closed.ordered("Kind", ["k0", "k1"])

const Position = closed.ordered("Position", ["p0", "p1", "p2"])

const Mark = closed.ordered("Mark", ["m0", "m1", "m2"])

type Shape = "a set" | "a function" | "a dependent key"

export type InstalledFeature =
	| Shape
	| "an edit out of order or range"
	| "an edit of another constant"
	| "an owner function"

/** The owners of the dependent key, version-major. */
const owners = [
	["v0", "k0"],
	["v0", "k1"],
	["v1", "k0"],
	["v1", "k1"]
] as const

/** A draw: the relation's shape, each owner's count where the key is dependent, and which points it holds. */
export interface InstalledDraw {
	readonly shape: Shape
	readonly counts: ReadonlyArray<number>
	readonly held: ReadonlyArray<boolean>
}

export const draws: Gen<InstalledDraw> = (s) => ({
	shape: s.draw(element<Shape>(["a set", "a function", "a dependent key"])),
	counts: Arr.map(owners, () => s.draw(int(0, 3))),
	held: s.draw(array(boolean, { min: 36, max: 36 }))
})

export const versionAt = (code: number): "v0" | "v1" => defined((["v0", "v1"] as const)[code])

export const kindAt = (code: number): "k0" | "k1" => defined((["k0", "k1"] as const)[code])

const positionAt = (code: number): "p0" | "p1" | "p2" =>
	defined((["p0", "p1", "p2"] as const)[code])

const markAt = (code: number): "m0" | "m1" | "m2" => defined((["m0", "m1", "m2"] as const)[code])

/** The key's points in cell order, each its fields' handles: the odometer, or the dependent sum owner by owner. */
export const pointsOf = (d: InstalledDraw): ReadonlyArray<ReadonlyArray<string>> =>
	d.shape === "a dependent key"
		? Arr.flatMap(owners, ([version, kind], o) =>
				Arr.map(odometer([defined(d.counts[o]), defined(d.counts[o])]), ([from, to]) => [
					version,
					kind,
					positionAt(defined(from)),
					positionAt(defined(to))
				])
			)
		: Arr.map(odometer([2, 2, 3]), ([v, k, p]) => [
				versionAt(defined(v)),
				kindAt(defined(k)),
				positionAt(defined(p))
			])

/** The schema a draw declares, its relation C over the shape's key, holding the points the draw holds. */
export const installedSchemaOf = (d: InstalledDraw) => {
	const points = pointsOf(d)
	const heldPoints = Arr.filter(points, (_, at) => d.held[at] === true)
	const Model = closed.relation(
		"Model",
		{ version: closedId(Version), parent: closedId(Kind), positions: natural },
		["version", "parent"],
		Arr.flatMap(owners, ([version, parent], o) => {
			const positions = defined(d.counts[o])
			return positions === 0 ? [] : [{ version, parent, positions: BigInt(positions) }]
		})
	)
	const position = slot(closedId(Position), fin(Model, "positions"))
	switch (d.shape) {
		case "a dependent key":
			return schema(
				"Changed",
				[
					Version,
					Kind,
					Position,
					Mark,
					Model,
					closed.relation(
						"C",
						{ version: closedId(Version), parent: closedId(Kind), from: position, to: position },
						["version", "parent", "from", "to"],
						Arr.map(heldPoints, ([version, parent, from, to]) => ({
							version: versionAt(Number(Str.slice(1)(defined(version)))),
							parent: kindAt(Number(Str.slice(1)(defined(parent)))),
							from: positionAt(Number(Str.slice(1)(defined(from)))),
							to: positionAt(Number(Str.slice(1)(defined(to))))
						}))
					)
				],
				[]
			)
		case "a set":
			return schema(
				"Changed",
				[
					Version,
					Kind,
					Position,
					Mark,
					Model,
					closed.relation(
						"C",
						{ version: closedId(Version), parent: closedId(Kind), at: closedId(Position) },
						["version", "parent", "at"],
						Arr.map(heldPoints, ([version, parent, at]) => ({
							version: versionAt(Number(Str.slice(1)(defined(version)))),
							parent: kindAt(Number(Str.slice(1)(defined(parent)))),
							at: positionAt(Number(Str.slice(1)(defined(at))))
						}))
					)
				],
				[]
			)
		case "a function":
			return schema(
				"Changed",
				[
					Version,
					Kind,
					Position,
					Mark,
					Model,
					closed.relation(
						"C",
						{
							version: closedId(Version),
							parent: closedId(Kind),
							at: closedId(Position),
							mark: closedId(Mark)
						},
						["version", "parent", "at"],
						Arr.map(heldPoints, ([version, parent, at], n) => ({
							version: versionAt(Number(Str.slice(1)(defined(version)))),
							parent: kindAt(Number(Str.slice(1)(defined(parent)))),
							at: positionAt(Number(Str.slice(1)(defined(at)))),
							mark: markAt(n % 3)
						}))
					)
				],
				[]
			)
	}
}
