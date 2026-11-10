/**
 * Hex, the one spelling of every bit string grizzle writes (core/hex.ts): a closed relation's constant (ir/cells.ts
 * literalOf and constantOfLiteral, sql/print.ts writePack and readLiteralPack, physical/ddl/literal.ts literalPackFault),
 * a roster's live codes and bits domain, and a set's literal.
 *
 * - **Every bit string a drafted migration writes is one hex constant:** over generated schemas (one to three rosters
 *   of 1 to 9 codes, so most widths pad; a closed relation keyed by one or two of them with no payload, a closed-id
 *   payload or an open one, at a drawn density; a stored relation holding two sets over a drawn roster, their union,
 *   intersection and difference generated, the singleton of a closed id generated, the empty set with its code's bit
 *   set, a row check against a drawn set literal, and a containment into the closed
 *   relation; an or fold over a counted family whose accumulator starts at the empty set), the first migration's every
 *   file lexes to statements in which every bit-string constant is X'…' of hex digits cast, with no binary B'' constant,
 *   no text cast to a bit type, no string_agg and no || beside a bit string; and its snapshot's every bit literal is
 *   the bits kind of hex digits, a set's at its bits domain's width, every bits domain is bit(n) with n its roster's
 *   codes rounded up to whole digits, every live constant the hex of its roster's live codes, and every constant's
 *   literal the whole digits its cells take, its padding 0 and its row count its held cells.
 * - **decode ∘ encode = id:** over drawn strings of cells (0 to 40 cells of 1 to 9, 31 or 32 bits), the encoder's
 *   literal is the test oracle's hex of the cells' bits padded to whole digits, it decodes back to the constant, and
 *   its printed statement reads back to its parts and holds.
 * - **Any flipped digit is refused, naming the constant:** every digit of every drawn literal changed to another
 *   (the last digit, which holds the padding, to all fifteen others) is refused by `grizzle check`'s reader naming the
 *   constant's function, as a 1 set in the padding where the change sets one and otherwise as content its digest does
 *   not state; and over installed closed relations, product and dependent keys alike, every changed digit of a
 *   relation's own constant names the relation, the first cell it changes and that cell's key. A lowercase digit, an
 *   edited row count and a literal out of its printed form are refused too.
 *
 * Oracles: the test oracle's bit texts and hex (test/support/closed/bit-text.ts), sharing no code with the engine's
 * encoder; the odometer and the dependent sum's enumeration for a changed cell's key.
 */
import { describe, it } from "@effect/vitest"
import { type Case, drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, boolean, element, type Gen, int, subarray, weighted } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { bigint } from "@grizzle/testing/values"
import { searched } from "@grizzle/testing/vitest"
import { regex } from "arkregex"
import {
	Array as Arr,
	Effect,
	Formatter,
	Option,
	Predicate,
	Record as Rec,
	String as Str
} from "effect"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { maxStringLength } from "#compiler/core/limits.ts"
import type { NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import { draftMigration } from "#compiler/deploy/render/generate.ts"
import { emptySnapshot, noWorkload } from "#compiler/deploy/snapshot/build.ts"
import {
	type Constant,
	constantDigestOf,
	constantOfLiteral,
	type Entry,
	literalOf
} from "#compiler/ir/cells.ts"
import type { ExprDesc, LiteralDesc } from "#compiler/ir/desc.ts"
import { literalPackFault } from "#compiler/physical/ddl/literal.ts"
import {
	compileInstallation,
	type Installation,
	installOptions
} from "#compiler/physical/install/compile.ts"
import { closedId, natural, slot } from "#compiler/public/fields.ts"
import { closed, fin, schema } from "#compiler/public/schema.ts"
import {
	admitClosedRelation,
	closed as closedBuilder,
	relationDescOf
} from "#compiler/schema/relation.ts"
import type { ObjectName, PackConstant } from "#compiler/sql/ast.ts"
import { pack } from "#compiler/sql/constants.ts"
import type { Token } from "#compiler/sql/lexer.ts"
import { lex } from "#compiler/sql/lexer.ts"
import { printObjectName, printStatement, readLiteralPack } from "#compiler/sql/print.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import {
	hexOfText,
	installedText,
	setText,
	textOfHex,
	wholeDigits
} from "#test/support/closed/bit-text.ts"
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
import { parsedName } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { owning, ownedInput } from "#test/support/policy.ts"

/** Hex digits as grizzle writes them: 0-9 and A-F, none lowercase. */
const hexDigits = regex("^[0-9A-F]*$")

/** Every point of the space whose coordinates hold `sizes` codes each, first coordinate most significant. */
const odometer = (sizes: ReadonlyArray<number>): ReadonlyArray<ReadonlyArray<number>> => {
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

/** `text` with the character at `at` replaced by `character`. */
const replacedAt = (text: string, at: number, character: string): string =>
	`${Str.slice(0, at)(text)}${character}${Str.slice(at + 1)(text)}`

/** The hex digit of a value from 0 to 15, as grizzle writes it. */
const digitOf = (value: number): string => Str.toUpperCase(value.toString(16))

/** The value of a hex digit. */
const valueOf = (digit: string): number => Number.parseInt(digit, 16)

/**
 * The cells of a bit text of `width`-bit cells, `cells` of them, each its value: the oracle's decoder, a cell past the
 * text reading 0.
 */
const cellsOfText = (text: string, cells: bigint, width: number): ReadonlyArray<bigint> =>
	Array.from({ length: Number(cells) }, (_, index) => {
		const run = Str.slice(index * width, (index + 1) * width)(text)
		return run === "" ? 0n : BigInt(`0b${run}`)
	})

/** What a changed literal states: a 1 among the bits that pad it, or otherwise other cells, first at a cell. */
type Changed = { readonly kind: "padding" } | { readonly kind: "cell"; readonly cell: bigint }

/**
 * What `after` states that `before`, whose padding is 0, does not, read as `cells` cells of `width` bits: a padding
 * bit set, which a reader refuses before it reads a cell, or the first cell whose bits differ.
 */
const changedAt = (before: string, after: string, cells: bigint, width: number): Changed => {
	const text = textOfHex(after)
	if (Str.includes("1")(Str.slice(Number(cells) * width)(text))) {
		return { kind: "padding" }
	}
	const was = cellsOfText(textOfHex(before), cells, width)
	const now = cellsOfText(text, cells, width)
	const first = Arr.findFirstIndex(was, (value, i) => now[i] !== value)
	return Option.isSome(first) ? { kind: "cell", cell: BigInt(first.value) } : { kind: "padding" }
}

/**
 * Every literal a digit changed to another makes: each digit to the value one to fifteen past its own (the offset the
 * digit's position gives), and the last digit, where the padding lies, to every other value.
 */
const flips = (hex: string): ReadonlyArray<string> =>
	Arr.flatMap(
		Array.from({ length: hex.length }, (_, at) => at),
		(at) => {
			const own = valueOf(defined(hex[at], "a digit"))
			const offsets =
				at === hex.length - 1 ? Array.from({ length: 15 }, (_, k) => k + 1) : [1 + (at % 15)]
			return Arr.map(offsets, (offset) => replacedAt(hex, at, digitOf((own + offset) % 16)))
		}
	)

/** A printed pack with its literal replaced by `hex`. */
const restated = (printed: string, from: string, hex: string): string =>
	Str.replace(`X'${from}'`, `X'${hex}'`)(printed)

describe("a drafted migration's bit strings", () => {
	type Payload = "no payload" | "a closed-id payload" | "an open payload"
	type Feature =
		| Payload
		| "a padded set"
		| "a whole-digit set"
		| "a padded constant"
		| "a whole-digit constant"
		| "a constant of no row"
		| "a containment's side"
		| "an or fold"
		| "a set literal of no handle"

	interface Drawn {
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

	const schemas: Gen<Drawn> = (s) => {
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
			literal: s.draw(
				subarray(Array.from({ length: defined(sizes[setRoster]) }, (_, code) => code))
			),
			contained: s.draw(boolean),
			fold: s.draw(boolean),
			foldRoster: s.draw(roster)
		}
	}

	/** Roster i's name. */
	const rosterName = (i: number): string => `R${i}`

	/** A set over roster i, as a field's description. */
	const setOver = (i: number) => ({ kind: "bits", roster: rosterName(i) }) as const

	/** A set's or a value's literal, its type taken from the term it meets. */
	const literalOfDesc = (value: LiteralDesc): ExprDesc => ({
		kind: "literal",
		value
	})

	/** A Compute operation's description. */
	const computed = (
		fn: "union" | "intersection" | "difference" | "disjoint" | "singleton",
		args: ReadonlyArray<ExprDesc>
	): ExprDesc => ({ kind: "compute", fn, args })

	/** The schema a draw declares. */
	const schemaOf = (d: Drawn): SchemaDesc => {
		const rosters = Arr.map(d.sizes, (size, i) => closedBuilder(rosterName(i), handlesOf(size), []))
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
							...Rec.fromEntries(
								Arr.map(digits, (digit, j) => [`k${j}`, handleOf(digit)] as const)
							),
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
			extends: undefined
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
	const fileViolations = (text: string, domains: ReadonlySet<string>): ReadonlyArray<string> => {
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
	const textAt = (
		node: { readonly [x: PropertyKey]: unknown },
		key: string
	): string | undefined => {
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
	 * constant other than its roster's live codes, and a pack whose literal is not the whole digits of its cells, sets
	 * a padding bit or counts other rows.
	 */
	const snapshotViolations = (
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
				const hex = textAt(node, "hex") ?? ""
				const cells = node["cells"]
				const width = node["width"]
				const rows = node["rows"]
				if (typeof cells !== "bigint" || typeof width !== "number" || typeof rows !== "number") {
					return ["a pack of no layout"]
				}
				const bits = Number(cells) * width
				const text = textOfHex(hex)
				const held = Arr.filter(cellsOfText(text, cells, width), (cell) => cell !== 0n).length
				return [
					...(hexDigits.test(hex) ? [] : ["a pack off hex digits"]),
					...(text.length === wholeDigits(bits)
						? []
						: [`a pack of ${hex.length} digits for ${bits} bits`]),
					...(Str.includes("1")(Str.slice(bits)(text)) ? ["a pack setting a padding bit"] : []),
					...(held === rows ? [] : [`a pack counting ${rows} rows where it holds ${held}`])
				]
			}
			return []
		})

	it.effect(
		"writes every bit string of a drafted migration as one hex constant, and its snapshot alike",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/physical/hex-drafted",
						oracle: {
							kind: "specification",
							name: "the one spelling: X'…' of whole hex digits, cast, at the bits domain's width, nothing else"
						},
						draw: drawn(schemas),
						literal: Formatter.format,
						coverage: required<Feature>(
							[
								"no payload",
								"a closed-id payload",
								"an open payload",
								"a padded set",
								"a whole-digit set",
								"a padded constant",
								"a whole-digit constant",
								"a constant of no row",
								"a containment's side",
								"an or fold",
								"a set literal of no handle"
							],
							{ cases: 160, sense: notesOnly }
						),
						kept: [],
						runs: 80,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(d: Drawn, c: Case<Feature>) =>
						Effect.sync(() => {
							const owned = owning(schemaOf(d))
							const installation = succeeded(
								compileInstallation(owned, installOptions(owned, "owner"))
							)
							const draft = succeeded(
								draftMigration({
									previous: emptySnapshot({ schemaName: "Hex", schema: installation.names.schema }),
									installation,
									workload: noWorkload,
									declared: { renames: [], drops: [] },
									abandoned: []
								})
							)
							const widths = new Map(
								Arr.map(d.sizes, (size, i) => {
									const domain = identity.bitsDomain(parsedName(rosterName(i)), wholeDigits(size))
									return [identifierOf(domain), wholeDigits(size)] as const
								})
							)
							const setRosters = [d.setRoster, d.key[0], ...(d.fold ? [d.foldRoster] : [])]
							const lives = new Set(
								Arr.map(setRosters, (r) => {
									const size = defined(d.sizes[r])
									return hexOfText(
										setText(
											size,
											Array.from({ length: size }, (_, code) => code)
										)
									)
								})
							)
							const domains = new Set(widths.keys())
							for (const file of draft.folder.files) {
								assert.deepEqual(fileViolations(file.text, domains), [], file.name)
							}
							assert.deepEqual(
								snapshotViolations(draft.snapshot, widths, lives),
								[],
								"the snapshot's bit strings"
							)
							c.note(d.payload)
							for (const r of setRosters) {
								c.note(defined(d.sizes[r]) % 4 === 0 ? "a whole-digit set" : "a padded set")
							}
							for (const s of installation.statements) {
								if (s.kind !== "packConstant") {
									continue
								}
								const bits = s.cells * BigInt(s.width)
								c.note(bits % 4n === 0n ? "a whole-digit constant" : "a padded constant")
								if (s.rows === 0) {
									c.note("a constant of no row")
								}
							}
							if (d.contained) {
								c.note("a containment's side")
							}
							if (d.fold) {
								c.note("an or fold")
							}
							if (d.literal.length === 0) {
								c.note("a set literal of no handle")
							}
						})
				)
			)
	)
})

describe("a closed constant's hex literal", () => {
	type Feature =
		| "a padded literal"
		| "a whole-digit literal"
		| "a literal of no digit"
		| "a 32-bit cell"
		| "no cell held"
		| "every cell held"
		| "a change in the padding alone"
		| "a change in a cell"

	/** A drawn string of cells: its count, its cells' width, and each held cell's payload code. */
	interface Drawn {
		readonly cells: number
		readonly width: number
		readonly held: ReadonlyArray<bigint | undefined>
	}

	const strings: Gen<Drawn> = (s) => {
		const cells = s.draw(int(0, 40))
		const width = s.draw(
			weighted([
				[6, int(1, 9)],
				[1, element([31, 32])]
			])
		)
		const density = s.draw(int(0, 4))
		const payload = bigint(0n, (1n << BigInt(width)) - 2n)
		return {
			cells,
			width,
			held: Array.from({ length: cells }, () =>
				s.draw(int(1, 4)) <= density ? s.draw(payload) : undefined
			)
		}
	}

	/** The constant a draw states. */
	const constantOf = (d: Drawn): Constant => ({
		cells: BigInt(d.cells),
		width: d.width,
		entries: Arr.flatMap(d.held, (payload, index): ReadonlyArray<Entry> =>
			payload === undefined ? [] : [{ index: BigInt(index), payload }]
		)
	})

	it.effect(
		"decodes to its constant, is the oracle's hex of its padded bits, reads back printed, and refuses every changed digit",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/physical/hex-literal",
						oracle: {
							kind: "second-implementation",
							name: "the test oracle's bit text of the cells, padded to whole hex digits and written in hex"
						},
						draw: drawn(strings),
						literal: Formatter.format,
						coverage: required<Feature>(
							[
								"a padded literal",
								"a whole-digit literal",
								"a literal of no digit",
								"a 32-bit cell",
								"no cell held",
								"every cell held",
								"a change in the padding alone",
								"a change in a cell"
							],
							{ cases: 300, sense: notesOnly }
						),
						kept: [],
						runs: 300,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(d: Drawn, c: Case<Feature>) =>
						Effect.sync(() => {
							const constant = constantOf(d)
							const hex = literalOf(constant)
							assert.equal(
								hex,
								hexOfText(succeeded(installedText(constant, maxStringLength.value))),
								"the literal is the oracle's hex of the cells' bits padded to whole digits"
							)
							assert.deepEqual(
								succeeded(constantOfLiteral(hex, constant.cells, constant.width)),
								constant,
								"decode ∘ encode = id"
							)
							const digest = constantDigestOf(constant)
							const fn: ObjectName = {
								schema: "hex",
								name: identifierOf(identity.closedConstant(digest))
							}
							const rows = constant.entries.length
							const printed = printStatement(
								pack(fn, constant.cells, constant.width, { hex, rows, digest })
							)
							assert.deepEqual(readLiteralPack(printed), {
								function: printObjectName(fn),
								rows: BigInt(rows),
								cells: constant.cells,
								width: BigInt(constant.width),
								digest,
								hex
							})
							assert.equal(
								literalPackFault(undefined, printed),
								undefined,
								"an untampered literal holds"
							)
							for (const flipped of flips(hex)) {
								const changed = changedAt(hex, flipped, constant.cells, constant.width)
								const fault = literalPackFault(undefined, restated(printed, hex, flipped))
								assert.deepEqual(
									fault === undefined
										? undefined
										: {
												kind: fault.kind,
												function: "function" in fault ? fault.function : undefined
											},
									{
										kind: changed.kind === "padding" ? "layout" : "content",
										function: printObjectName(fn)
									},
									`X'${flipped}' for X'${hex}'`
								)
								c.note(
									changed.kind === "padding"
										? "a change in the padding alone"
										: "a change in a cell"
								)
							}
							const letter = Arr.findFirstIndex(Array.from(hex), (digit) => valueOf(digit) >= 10)
							if (Option.isSome(letter)) {
								const lower = replacedAt(
									hex,
									letter.value,
									Str.toLowerCase(defined(hex[letter.value]))
								)
								assert.deepEqual(literalPackFault(undefined, restated(printed, hex, lower)), {
									kind: "layout",
									function: printObjectName(fn),
									fault: { kind: "digit", at: letter.value }
								})
							}
							assert.deepEqual(
								literalPackFault(
									undefined,
									Str.replace(`${rows} rows in `, `${rows + 1} rows in `)(printed)
								),
								{
									kind: "rows",
									function: printObjectName(fn),
									stated: BigInt(rows + 1),
									held: BigInt(rows)
								}
							)
							assert.deepEqual(literalPackFault(undefined, Str.replace("X'", "Y'")(printed)), {
								kind: "form"
							})
							assert.deepEqual(
								literalPackFault(undefined, `${printed} || X'0'::bit varying`),
								{ kind: "form" },
								"a literal joined to another is out of the form"
							)
							const bits = d.cells * d.width
							c.note(
								bits === 0
									? "a literal of no digit"
									: bits % 4 === 0
										? "a whole-digit literal"
										: "a padded literal"
							)
							if (d.width >= 31 && d.cells > 0) {
								c.note("a 32-bit cell")
							}
							if (d.cells > 0 && rows === 0) {
								c.note("no cell held")
							}
							if (d.cells > 0 && rows === d.cells) {
								c.note("every cell held")
							}
						})
				)
			)
	)
})

describe("a changed digit of an installed relation's constant", () => {
	const Version = closed("Version", ["v0", "v1"])
	const Kind = closed("Kind", ["k0", "k1"])
	const Position = closed("Position", ["p0", "p1", "p2"])
	const Mark = closed("Mark", ["m0", "m1", "m2"])

	type Shape = "a set" | "a function" | "a dependent key"
	type Feature =
		| Shape
		| "a change in the padding alone"
		| "a change in a cell"
		| "an owner function"

	/** The owners of the dependent key, version-major. */
	const owners = [
		["v0", "k0"],
		["v0", "k1"],
		["v1", "k0"],
		["v1", "k1"]
	] as const

	/** A draw: the relation's shape, each owner's count where the key is dependent, and which points it holds. */
	interface Drawn {
		readonly shape: Shape
		readonly counts: ReadonlyArray<number>
		readonly held: ReadonlyArray<boolean>
	}

	const draws: Gen<Drawn> = (s) => ({
		shape: s.draw(element<Shape>(["a set", "a function", "a dependent key"])),
		counts: Arr.map(owners, () => s.draw(int(0, 3))),
		held: s.draw(array(boolean, { min: 36, max: 36 }))
	})

	const versionAt = (code: number): "v0" | "v1" => defined((["v0", "v1"] as const)[code])
	const kindAt = (code: number): "k0" | "k1" => defined((["k0", "k1"] as const)[code])
	const positionAt = (code: number): "p0" | "p1" | "p2" =>
		defined((["p0", "p1", "p2"] as const)[code])
	const markAt = (code: number): "m0" | "m1" | "m2" => defined((["m0", "m1", "m2"] as const)[code])

	/** The key's points in cell order, each its fields' handles: the odometer, or the dependent sum owner by owner. */
	const pointsOf = (d: Drawn): ReadonlyArray<ReadonlyArray<string>> =>
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
	const schemaOf = (d: Drawn) => {
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
					{
						Version,
						Kind,
						Position,
						Mark,
						Model,
						C: closed.relation(
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
					},
					[]
				)
			case "a set":
				return schema(
					"Changed",
					{
						Version,
						Kind,
						Position,
						Mark,
						Model,
						C: closed.relation(
							"C",
							{ version: closedId(Version), parent: closedId(Kind), at: closedId(Position) },
							["version", "parent", "at"],
							Arr.map(heldPoints, ([version, parent, at]) => ({
								version: versionAt(Number(Str.slice(1)(defined(version)))),
								parent: kindAt(Number(Str.slice(1)(defined(parent)))),
								at: positionAt(Number(Str.slice(1)(defined(at))))
							}))
						)
					},
					[]
				)
			case "a function":
				return schema(
					"Changed",
					{
						Version,
						Kind,
						Position,
						Mark,
						Model,
						C: closed.relation(
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
					},
					[]
				)
		}
	}

	it.effect(
		"names the relation, the first cell a change reaches and its key, or the padding it sets, for every digit",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/physical/hex-installed",
						oracle: {
							kind: "second-implementation",
							name: "the odometer and the dependent sum's enumeration of the key, and the oracle's cells of each literal"
						},
						draw: drawn(draws),
						literal: Formatter.format,
						coverage: required<Feature>(
							[
								"a set",
								"a function",
								"a dependent key",
								"a change in the padding alone",
								"a change in a cell",
								"an owner function"
							],
							{ cases: 120, sense: notesOnly }
						),
						kept: [],
						runs: 60,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(d: Drawn, c: Case<Feature>) =>
						Effect.sync(() => {
							const owned = succeeded(ownedInput(schemaOf(d)))
							const installation: Installation = succeeded(
								compileInstallation(owned, installOptions(owned, "owner"))
							)
							const keysOf = (relation: string): ReadonlyArray<ReadonlyArray<string>> =>
								relation === "C"
									? pointsOf(d)
									: Arr.map(odometer([2, 2]), ([v, k]) => [
											versionAt(defined(v)),
											kindAt(defined(k))
										])
							/** The declared closed relation whose own constant `fn` is, the first in declared order. */
							const relationOf = (fn: string): string | undefined =>
								Arr.findFirst(Rec.values(installation.owned.relations), (r) => {
									if (r.desc.kind !== "closedRelation") {
										return false
									}
									const constant = installation.names.closed(r.desc.name)
									return (
										printObjectName(constant.function) === fn ||
										printObjectName(constant.keys) === fn
									)
								}).pipe(
									Option.map((r) => r.desc.name),
									Option.getOrUndefined
								)
							const packs = Arr.filter(
								installation.statements,
								(s): s is PackConstant => s.kind === "packConstant"
							)
							for (const p of packs) {
								const printed = printStatement(p)
								assert.equal(
									literalPackFault(installation, printed),
									undefined,
									"the drafted literal holds"
								)
								const relation = relationOf(printObjectName(p.function))
								if (relation === undefined) {
									c.note("an owner function")
								}
								for (const flipped of flips(p.hex)) {
									const changed = changedAt(p.hex, flipped, p.cells, p.width)
									const fault = literalPackFault(installation, restated(printed, p.hex, flipped))
									const fn = printObjectName(p.function)
									if (changed.kind === "padding") {
										assert.deepEqual(
											fault === undefined
												? undefined
												: {
														kind: fault.kind,
														function: "function" in fault ? fault.function : undefined
													},
											{ kind: "layout", function: fn },
											`X'${flipped}' sets the padding of ${fn}`
										)
										c.note("a change in the padding alone")
										continue
									}
									assert.deepEqual(
										fault,
										{
											kind: "content",
											function: fn,
											relation,
											differs: {
												cell: changed.cell,
												key:
													relation === undefined
														? undefined
														: defined(keysOf(relation)[Number(changed.cell)], "the cell's point")
											}
										},
										`X'${flipped}' changes ${fn}`
									)
									c.note("a change in a cell")
								}
							}
							c.note(d.shape)
						})
				)
			)
	)
})
