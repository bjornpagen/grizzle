/** What the properties of key-text-bytes.test.ts read: its spaces, models and helpers. */

import { indices } from "@bjornpagen/grizzle-text/base/array"
import { defined } from "@bjornpagen/testing/assert"
import {
	type Aimed,
	aimed,
	array,
	boolean,
	element,
	type Gen,
	int,
	weighted
} from "@bjornpagen/testing/gen"
import { Array as Arr, Option, Order } from "effect"
import {
	closedId,
	drawn,
	generated,
	natural,
	slot,
	bool,
	int2,
	int4
} from "#compiler/public/fields.ts"
import { closed as closedRelations, fin, relation } from "#compiler/public/schema.ts"
import {
	accumulatedField,
	admittedClosedId,
	closedBuilder as closed
} from "#compiler/schema/relation.ts"
import type { FieldBase, GeneratedField } from "#compiler/types/fields/field.ts"
import { Id, idKey } from "#test/support/ids.ts"

/** The type of a key's other field. */
type CompanionType = "uuid" | "natural" | "integer" | "smallint" | "boolean" | "closedId"

/**
 * How a companion is handed to keyTextBytes: as its type's descriptor, a caller's field, or as a field of its type that
 * grizzle or PostgreSQL writes, which keyTextBytes reads as that type: an accumulated or a generated field of any type,
 * drawn(natural), and a closed relation's slot over a closed id.
 */
type Reading = "caller" | "accumulated" | "generated" | "drawn" | "slot"

/** A key's other field: its type, which the installed relation declares it of, and how keyTextBytes is handed it. */
interface Companion {
	readonly type: CompanionType
	readonly reading: Reading
}

/** A code point's UTF-8 width, by its class: ASCII, two-byte, CJK and astral. */
type Width = 1 | 2 | 3 | 4

interface KeyCase {
	readonly companions: Arr.NonEmptyReadonlyArray<Companion>
	/** The key's order: each companion's position and the text's, `companions.length`, ranked. */
	readonly order: ReadonlyArray<number>
	/** The widths the text's code points are drawn from, and the width of each value's last code point. */
	readonly widths: Arr.NonEmptyReadonlyArray<Width>
	readonly last: Width
	readonly salt: number
}

export const Kind = closed("Kind", ["A", "B"], "ordered", [])

export const descriptorOf = (c: CompanionType): FieldBase => {
	switch (c) {
		case "uuid":
			return Id
		case "natural":
			return natural
		case "integer":
			return int4
		case "smallint":
			return int2
		case "boolean":
			return bool
		case "closedId":
			return admittedClosedId(Kind)
	}
}

/** The readings of a companion's type: a caller's, an accumulated and a generated field of every type, and its own. */
const readingsOf = (c: CompanionType): Arr.NonEmptyReadonlyArray<Reading> => {
	switch (c) {
		case "natural":
			return ["caller", "accumulated", "generated", "drawn"]
		case "boolean":
			return ["caller", "accumulated", "generated"]
		case "closedId":
			return ["caller", "accumulated", "generated", "slot"]
		case "uuid":
		case "integer":
		case "smallint":
			return ["caller", "accumulated", "generated"]
	}
}

/** The value an accumulated companion starts at, one of its type's. */
const startOf = (c: CompanionType): unknown => {
	switch (c) {
		case "uuid":
			return "00000000-0000-4000-8000-000000000000"
		case "natural":
			return 0n
		case "integer":
		case "smallint":
			return 0
		case "boolean":
			return false
		case "closedId":
			return "A"
	}
}

/**
 * The keys a field grizzle fills with a companion's values takes (scalar/contract.ts admitMintKey): Id's, the tests' id
 * key, since Id is a consumer's contract; none for any other type, natural grizzle's own among them.
 */
const mintOf = (c: CompanionType): ReadonlyArray<symbol> => {
	switch (c) {
		case "uuid":
			return [idKey]
		case "natural":
		case "integer":
		case "smallint":
		case "boolean":
		case "closedId":
			return []
	}
}

/** The owner of a closed relation's slots over Kind, and its count of them. */
const Owner = closed("Owner", ["owner"], "ordered", [])
const Slots = closedRelations.relation(
	"Slots",
	{ owner: closedId(Owner), n: natural },
	["owner"],
	[{ owner: "owner", n: 2n }]
)

/**
 * The field keyTextBytes is handed for a companion: its type's descriptor, or a field of its reading's kind of that
 * type, a generated one read off the relation it is generated in.
 */
export const fieldOf = (c: Companion): FieldBase | GeneratedField<FieldBase> => {
	const declared = descriptorOf(c.type)
	switch (c.reading) {
		case "caller":
			return declared
		case "accumulated":
			return accumulatedField(declared, startOf(c.type), mintOf(c.type))
		case "generated":
			return relation.generated("Companion", { id: Id, w: declared }, ["id"], (row) => ({
				x: generated(declared, row.w)
			})).fields.x
		case "drawn":
			return drawn(natural)
		case "slot":
			return slot(closedId(Kind), fin(Slots, "n"))
	}
}

/** Each companion's widest value as SQL writes it: a closed id is its code, the largest Kind numbers. */
export const widestOf = (c: CompanionType): string => {
	switch (c) {
		case "uuid":
			return "'ffffffff-ffff-ffff-ffff-ffffffffffff'"
		case "natural":
			return "9223372036854775807"
		case "integer":
			return "2147483647"
		case "smallint":
			return "32767"
		case "boolean":
			return "true"
		case "closedId":
			return "1"
	}
}

/** The first code point of each width's range and how many follow it, every one of them that width in UTF-8. */
const ranges: Readonly<Record<Width, readonly [number, number]>> = {
	1: [0x21, 0x5e],
	2: [0xa1, 0x75f],
	3: [0x4e00, 0x5200],
	4: [0x20000, 0xa000]
}

/**
 * A text of exactly `bytes` UTF-8 bytes: code points of `widths`, each fitting what is left, chosen by a generator
 * seeded with `salt` far enough apart that pglz finds no saving, then a last code point of width `last` where it fits.
 */
export const textOf = (
	bytes: number,
	widths: ReadonlyArray<Width>,
	last: Width,
	salt: number
): string => {
	let x = (salt * 2654435761) >>> 0
	const next = (): number => {
		x = (Math.imul(x, 1103515245) + 12345) >>> 0
		return x >>> 7
	}
	const tail: Width = last <= bytes ? last : 1
	let out = ""
	for (let left = bytes - (bytes === 0 ? 0 : tail); left > 0;) {
		const fits = Arr.filter(widths, (w) => w <= left)
		const w: Width =
			fits.length === 0 ? 1 : defined(fits[next() % fits.length], "a width that fits")
		const [first, count] = ranges[w]
		out += String.fromCodePoint(first + (next() % count))
		left -= w
	}
	if (bytes > 0) {
		const [first, count] = ranges[tail]
		out += String.fromCodePoint(first + (next() % count))
	}
	return out
}

export const utf8 = new TextEncoder()

/** The UTF-8 width of a text's last code point; none for the empty text. */
export const lastWidth = (text: string): Width | undefined => {
	const last = Arr.last(Arr.fromIterable(text))
	if (Option.isNone(last)) {
		return undefined
	}
	switch (utf8.encode(last.value).length) {
		case 1:
			return 1
		case 2:
			return 2
		case 3:
			return 3
		default:
			return 4
	}
}

const companionTypeGen: Gen<CompanionType> = weighted<CompanionType>([
	[3, element<CompanionType>(["uuid", "boolean"])],
	[2, element<CompanionType>(["natural", "integer", "smallint", "closedId"])]
])

/** A companion of `type`, handed to keyTextBytes by any reading its type has. */
const companionOf =
	(type: CompanionType): Gen<Companion> =>
	(source) => ({ type, reading: source.draw(element(readingsOf(type))) })

const companionGen: Gen<Companion> = (source) =>
	source.draw(companionOf(source.draw(companionTypeGen)))

/** The key's other fields, and whether the text stands last in the key. */
interface Fields {
	readonly companions: Arr.NonEmptyReadonlyArray<Companion>
	readonly textLast: boolean
}

/** One to five companions of any type, the text last or anywhere. */
const freeFieldsGen: Gen<Fields> = (source) => {
	const companions = source.draw(array(companionGen, { min: 1, max: 5 }))
	const first = defined(companions[0], "a companion")
	return { companions: [first, ...Arr.drop(companions, 1)], textLast: source.draw(boolean) }
}

/**
 * The tight layout (`tight`), by construction: the text last, after uuids and booleans, one or five booleans, so the
 * text starts one past a multiple of four and its own padding is the widest, three bytes.
 */
const tightFieldsGen: Gen<Fields> = (source) => {
	const booleans = source.draw(element([1, 5]))
	const uuids = source.draw(int(0, 5 - booleans))
	const types: Arr.NonEmptyReadonlyArray<CompanionType> = [
		"boolean",
		...Array.from({ length: booleans - 1 }, (): CompanionType => "boolean"),
		...Array.from({ length: uuids }, (): CompanionType => "uuid")
	]
	return {
		companions: Arr.map(types, (type) => source.draw(companionOf(type))),
		textLast: true
	}
}

const widthGen: Gen<Width> = element<Width>([1, 2, 3, 4])

/** A case over the fields `fields` draws: the key's order, the text's code point widths and its salt. */
const caseOver =
	(fields: Gen<Fields>): Gen<KeyCase> =>
	(source) => {
		const { companions: all, textLast } = source.draw(fields)
		const ranked = Arr.map(indices(all.length + 1), (position) => ({
			position,
			rank: textLast && position === all.length ? 0x10000 : source.draw(int(0, 0xffff))
		}))
		return {
			companions: all,
			order: Arr.map(
				Arr.sort(
					ranked,
					Order.mapInput(Order.Number, (p: { readonly rank: number }) => p.rank)
				),
				(p) => p.position
			),
			widths: [source.draw(widthGen), ...source.draw(array(widthGen, { min: 0, max: 3 }))],
			last: source.draw(widthGen),
			salt: source.draw(int(0, 0xffff))
		}
	}

const caseGen: Gen<KeyCase> = caseOver(
	weighted<Fields>([
		[3, freeFieldsGen],
		[1, tightFieldsGen]
	])
)

/** Free fields whose first companion is of `type`, handed to keyTextBytes by `reading`. */
const withCompanion =
	(type: CompanionType, reading: Exclude<Reading, "caller">): Gen<Fields> =>
	(source) => {
		const { companions, textLast } = source.draw(freeFieldsGen)
		return { companions: [{ type, reading }, ...Arr.drop(companions, 1)], textLast }
	}

/** The cases, each aimed at a kind of field a companion is handed as while it is pending, over a type that has it. */
export const caseSpace: Aimed<KeyCase, BytesFeature> = aimed(caseGen, [
	["accumulated companion", caseOver(withCompanion("integer", "accumulated"))],
	["generated companion", caseOver(withCompanion("uuid", "generated"))],
	["drawn companion", caseOver(withCompanion("natural", "drawn"))],
	["slot companion", caseOver(withCompanion("closedId", "slot"))]
])

/** Where the text stands in the key: its place among the key's fields, `companions.length` its own position. */
export const textPosition = (c: KeyCase): number =>
	defined(
		Option.getOrUndefined(Arr.findFirstIndex(c.order, (p) => p === c.companions.length)),
		"the text's place in the key"
	)

/**
 * Whether the budget is exactly the most an entry that carries the null bitmap holds in this order: the text last,
 * after companions that each align to one byte and so pad nothing, from the entry's data offset, its 8-byte header and
 * its null bitmap MAXALIGNed to 16, ending at an offset one past a multiple of four, so the text's own padding is the
 * widest, three bytes.
 */
export const tight = (c: KeyCase): boolean => {
	const textAt = textPosition(c)
	const before = Arr.map(Arr.take(c.order, textAt), (p) => defined(c.companions[p], "a companion"))
	const end = Arr.reduce(
		before,
		16,
		(o, comp) => o + (comp.type === "uuid" ? 16 : comp.type === "boolean" ? 1 : 0)
	)
	return (
		textAt === c.companions.length &&
		Arr.every(before, (comp) => comp.type === "uuid" || comp.type === "boolean") &&
		end % 4 === 1
	)
}

export type BytesFeature =
	| `${Exclude<Reading, "caller">} companion`
	| "tight budget"
	| "text first"
	| "text last"
	| "text between"
	| "a closed id beside it"
	| `last code point of ${Width} bytes`
