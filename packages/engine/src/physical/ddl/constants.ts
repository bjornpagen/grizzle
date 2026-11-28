import { appendAll } from "@bjornpagen/grizzle-text/base/array"
import { defect, defined } from "@bjornpagen/grizzle-text/base/invariant"
import {
	extendNonEmpty,
	isNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray
} from "@bjornpagen/grizzle-text/base/nonempty"
import { maxStringLength, unwrap } from "#compiler/core/canonical.ts"
import { everyProperty, Refusal } from "#compiler/core/canonical.ts"
import { type CompileError, malformedDescription, resourceBound } from "#compiler/core/errors.ts"
import { type ConstantDigest, constantDigest } from "#compiler/core/fingerprint.ts"
import { identifierOf, type Identity, identity, type HeldName } from "#compiler/core/identity.ts"
import type { Identifier } from "#compiler/core/ids.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { compareStrings } from "#compiler/core/order.ts"
import { int8Max } from "#compiler/ir/carriers.ts"
import {
	type BlockCoordinate,
	blockRadices,
	type CellLayout,
	type CellSide,
	cellsDigestOf,
	cellsLiteralOf,
	type Constant,
	constantOf,
	type DependentSpace,
	dependentSpace,
	type Entry,
	keyCells,
	holdsPayloads,
	indexesOf,
	keyIndex,
	type KeySpace,
	payloadsDigestOf,
	payloadsLiteralOf,
	payloadsOf,
	rowMajorIndex,
	spaceSize,
	type Split,
	type Tuple
} from "#compiler/ir/cells.ts"
import { type Codebook, codeOf, liveHex, type RosterCodec } from "#compiler/ir/codes.ts"
import {
	exprClosure,
	predicateTree,
	type ScalarExpr,
	type TypedLiteral
} from "#compiler/ir/expr.ts"
import {
	type ClosedSlot,
	type ClosedTheoryRelation,
	generationOf,
	type LawField,
	type NativeColumn,
	type NativeOf
} from "#compiler/ir/law.ts"
import { baseTypeRef } from "#compiler/ir/physical.ts"
import type { PhysicalReason } from "#compiler/ir/products.ts"
import { closedCell } from "#compiler/ir/rel.ts"
import { baseOf, rosterOf, type ScalarType, textOf, typeLabel } from "#compiler/ir/scalar.ts"
import type { LawModel } from "#compiler/laws/model/model.ts"
import { literalKey } from "#compiler/laws/model/names.ts"
import type { InstallBuilder } from "#compiler/physical/ddl/context.ts"
import { persistentText } from "#compiler/physical/ddl/expr.ts"
import { enforcement, lawReasons, type Node } from "#compiler/physical/obligations/graph.ts"
import { matchAre } from "#compiler/scalar/regex/admit.ts"
import type { Owned } from "#compiler/schema/own.ts"
import type {
	CreateConstant,
	CreateDomain,
	Expr,
	ObjectName,
	PackConstant,
	PackLayout,
	SqlStatement
} from "#compiler/sql/ast.ts"
import { and, arrayOf, binary, call, cast, eq, ge, lit, lt, types } from "#compiler/sql/build.ts"
import {
	cellOfKey,
	type ClosedConstant,
	type ClosedKey,
	type ConstantFunctions,
	constantValue,
	held,
	pack,
	type Payloads,
	pairIn,
	payloadCode,
	payloadDigit
} from "#compiler/sql/constants.ts"
import { printObjectName, textArrayLiteral } from "#compiler/sql/print.ts"

/**
 * The most cells one closed relation's key space holds: a read computes a key's cell index in bigint arithmetic, the
 * mixed radix of its codes (sql/constants.ts cellOfKey), and its cells' array holds each index as a bigint, so every
 * index, the first past the key space a dependent key's guard reads among them, is at most bigint's greatest value, and
 * a larger one is "bigint out of range". A key space of more cells is refused when its constant is planned.
 *
 * @limitKind derived
 * @owner PostgreSQL 19.0
 * @unit cells
 * @scope the key space of one closed relation or side: the index a read computes from its key's codes
 * @derivation int8pl and int8mul refuse a result past the int8 range: "if (unlikely(pg_mul_s64_overflow(arg1, arg2,
 *   &result)))" then "errmsg("bigint out of range")"
 *   (https://github.com/postgres/postgres/blob/REL_19_0/src/backend/utils/adt/int8.c#L497, verified 2026-11-24); the
 *   greatest index, the key space's cells, is at most bigint's greatest value
 * @from {@link int8Max}
 */
export const constantMaxCells = int8Max

/**
 * The most payload codes one closed relation's constant holds: its payloads' array holds each payload code as a bigint,
 * and a read computes with it in bigint arithmetic (sql/constants.ts applied, payloadDigit), so the greatest code,
 * codes - 1, is at most bigint's greatest value, and a larger one is "out of range for type bigint". A payload space of
 * more codes is refused when its constant is planned.
 *
 * @limitKind derived
 * @owner PostgreSQL 19.0
 * @unit codes
 * @scope the payload space of one closed relation or side: its codes, each a bigint
 * @derivation pg_strtoint64_safe, which bigint's input reads an element by, refuses a value past the int8 range:
 *   "errmsg("value \"%s\" is out of range for type %s"" (https://github.com/postgres/postgres/blob/REL_19_0/src/backend/utils/adt/numutils.c#L649,
 *   verified 2026-11-24); the greatest payload code, codes - 1, is at most bigint's greatest value
 * @from {@link int8Max}
 */
export const payloadMaxCodes = int8Max + 1n

/**
 * The installation's constants: the functions a closed fact is read from, each an IMMUTABLE SQL function of no argument
 * named by the digest of its content, so equal contents are one function, a changed one is a new function, and none is
 * ever replaced in place (sql/ast.ts CreateConstant).
 *
 * - A roster installs its names constant, its handles in code order, a hole the empty name, as one name[], and the
 *   smallint domain over it, whose one CHECK admits exactly the codes whose name is not empty: every closed id column is
 *   typed by it, so it is the range proof every digit of a constant's index needs. A roster some set is typed over also
 *   installs its live-codes constant, the hex literal of its live codes' bits, and the bits domain over bit(n), n every
 *   code it has minted rounded up to whole hex digits, whose CHECK admits only live codes' bits, so a hole's bit and
 *   every padding bit are 0 in every stored set.
 * - A closed relation installs its constant's arrays (ir/cells.ts Constant): its cells, each row at the index its key
 *   gives its key fields' codes, ascending after a sentinel, which a membership and an application search alike, and,
 *   where its payload space holds more than one code, its payloads, each row's payload code in the cells' order; and a
 *   dictionary per open-typed payload field, the field's values in code order. A key is the mixed radix of its closed ids, or, where
 *   its slots count over an owner prefix, a dependent sum, each owner's block after the blocks before it: such a key
 *   also installs two kinds of owner function over the prefix, each owner's block's first cell and each count its slots
 *   read, which its readers index by (sql/constants.ts cellOfKey).
 * - A containment into a closed relation's side installs the side's arrays, as a closed relation of its own, which the
 *   table CHECK that holds the containment reads (`closedMembership`).
 *
 * Every array is stated as one bigint[] literal (sql/ast.ts PackConstant), the host's encoding of its entries, O(rows)
 * whatever the key space, under a comment of its layout, its row count and its content's digest, which `grizzle check`
 * decodes and holds to the digest. Equal arrays are one function: relations of one key set share their cells. A role is granted EXECUTE on every constant a statement it runs calls
 * (physical/ddl/roles.ts).
 */

/** The code space of one payload coordinate of a closed relation's cells: a closed id's roster, or an open field's
 * values. */
type CodeSpace =
	| { readonly kind: "roster"; readonly field: LawField; readonly codec: RosterCodec }
	| {
			readonly kind: "dictionary"
			readonly field: LawField
			/** The field's distinct values, in canonical text order, a value's code its position. */
			readonly values: ReadonlyArray<TypedLiteral>
			/** Each value's canonical text (laws/model/names.ts literalKey), in code order. */
			readonly keys: ReadonlyArray<string>
	  }

/**
 * The codes a coordinate holds: a roster's every minted code, holes included, or a dictionary's values, at least one: a
 * relation that holds no fact has an empty dictionary, whose one code no entry holds and no read reaches.
 */
const radixOf = (space: CodeSpace): number =>
	space.kind === "roster" ? space.codec.size : Math.max(1, space.values.length)

/** A closed id's code: its handle's in the roster's codes. */
const handleCode = (codec: RosterCodec, literal: TypedLiteral): number => {
	if (literal.kind !== "handle") {
		defect("a closed id's value is a handle of its roster")
	}
	return codeOf(codec, literal.handle)
}

/** A closed id field's roster codes, which every key field of a closed relation is typed by. */
const codecOfField = (codes: Codebook, field: LawField): RosterCodec => {
	const roster = rosterOf(baseOf(field.type))
	if (roster === undefined || baseOf(field.type).carrier !== "code") {
		defect(`the closed id ${field.name} is typed by its roster`)
	}
	return defined(codes.rosters.get(roster.closed), "the codebook holds every roster")
}

/** A payload field's code space over its values, and each value's code in it, in the values' order. */
interface PayloadColumn {
	readonly space: CodeSpace
	readonly codes: ReadonlyArray<number>
}

/**
 * The payload column of a field over `values`, the field's values in its relation's rows: a closed id's codes in its
 * roster, or an open field's dictionary of its distinct values and each value's position in it, each value's canonical
 * text read once.
 */
const payloadColumn = (
	codes: Codebook,
	field: LawField,
	values: ReadonlyArray<TypedLiteral>
): PayloadColumn => {
	if (baseOf(field.type).carrier === "code") {
		const codec = codecOfField(codes, field)
		return {
			space: { kind: "roster", field, codec },
			codes: values.map((value) => handleCode(codec, value))
		}
	}
	const keyed = values.map((value) => [literalKey(value), value] as const)
	const ordered = [...new Map(keyed)].toSorted(([a], [b]) => compareStrings(a, b))
	const positions = new Map(ordered.map(([key], code) => [key, code] as const))
	return {
		space: {
			kind: "dictionary",
			field,
			values: ordered.map(([, value]) => value),
			keys: ordered.map(([key]) => key)
		},
		codes: keyed.map(([key]) => defined(positions.get(key), "a value is in its field's dictionary"))
	}
}

/** One array of a constant planned: its function's identity, its layout and its constant. */
interface PlannedArray {
	readonly kind: "array"
	readonly named: Identity<"closedConstant">
	/** The array's content digest, which `named` mints from and its literal's comment states. */
	readonly digest: ConstantDigest<"closed-constant">
	readonly layout: PackLayout
	readonly constant: Constant
}

/** A constant planned: its entries, and the arrays it installs, its cells and its payloads (sql/constants.ts Payloads). */
interface PlannedCells {
	readonly constant: Constant
	readonly cells: PlannedArray
	readonly payloads: Payloads<PlannedArray>
}

/** A dictionary planned: its function's identity, its field, and its values in code order. */
interface PlannedDictionary {
	readonly kind: "dictionary"
	readonly named: Identity<"closedConstant">
	readonly field: LawField
	readonly values: ReadonlyArray<TypedLiteral>
}

type PlannedConstant = PlannedArray | PlannedDictionary

/** The arrays of `constant` planned, each named by its content's digest. */
const plannedOf = (constant: Constant): PlannedCells => {
	const array = (layout: PackLayout, digest: ConstantDigest<"closed-constant">): PlannedArray => ({
		kind: "array",
		named: identity.closedConstant(digest),
		digest,
		layout,
		constant
	})
	return {
		constant,
		cells: array(
			{ kind: "cells", cells: constant.cells },
			cellsDigestOf(constant.cells, indexesOf(constant))
		),
		payloads: holdsPayloads(constant)
			? {
					kind: "codes",
					function: array(
						{ kind: "payloads", points: constant.points },
						payloadsDigestOf(constant.points, payloadsOf(constant))
					)
				}
			: { kind: "one" }
	}
}

/** The arrays a planned constant installs: its cells, then its payloads where it holds them. */
const arraysOf = (planned: PlannedCells): ReadonlyArray<PlannedArray> =>
	planned.payloads.kind === "codes" ? [planned.cells, planned.payloads.function] : [planned.cells]

/**
 * The refusal of a constant whose payload space holds `codes` codes and whose key space holds `cells` cells, `what`
 * naming it: past the payload codes a bigint holds (payloadMaxCodes) or the cells a bigint index counts
 * (constantMaxCells); none when both fit.
 */
const constantBound = (codes: bigint, cells: bigint, what: string): CompileError | undefined =>
	payloadCodesBound(codes, what) ?? constantCellsBound(cells, what)

/**
 * The constant of `tuples` over `layout`, refused as ResourceBound when its payload space holds more codes than a bigint
 * payload code can (payloadMaxCodes), or its key space more cells than a bigint index can (constantMaxCells), each
 * measured before it is built (`what` names it). Tuples that repeat are one entry; two at one key with different
 * payloads are a key the declaration held, so their meeting is a defect. Every tuple's key is a point of the layout's key
 * space: the caller refuses one that is not.
 */
const plannedCells = (
	layout: CellLayout,
	tuples: ReadonlyArray<Tuple>,
	what: string
): PlannedCells => {
	const refusal = constantBound(spaceSize(layout.payload), keyCells(layout.key), what)
	if (refusal !== undefined) {
		throw new Refusal(refusal)
	}
	const encoded = constantOf(layout, tuples)
	if (!encoded.ok) {
		defect(`the declared key of ${what} holds its rows apart`)
	}
	return plannedOf(encoded.value)
}

/**
 * The refusal of a constant whose payload space holds `codes` codes, `what` naming it, when its greatest payload code,
 * codes - 1, is past bigint's greatest value (payloadMaxCodes); none when it fits.
 */
export const payloadCodesBound = (codes: bigint, what: string): CompileError | undefined =>
	codes > payloadMaxCodes
		? resourceBound(SourceLoc(what, []), {
				kind: "payloadCodes",
				constant: what,
				limit: payloadMaxCodes,
				needed: codes
			})
		: undefined

/**
 * The refusal of a constant whose key space holds `cells` cells, `what` naming it, when its cells are more than a bigint
 * index counts (constantMaxCells); none when they fit.
 */
const constantCellsBound = (cells: bigint, what: string): CompileError | undefined =>
	cells > constantMaxCells
		? resourceBound(SourceLoc(what, []), {
				kind: "constantCells",
				constant: what,
				limit: constantMaxCells,
				needed: cells
			})
		: undefined

/** A dictionary of `space`'s values, named by the digest of its element type and its values in code order. */
const plannedDictionary = (
	space: Extract<CodeSpace, { readonly kind: "dictionary" }>
): PlannedDictionary => ({
	kind: "dictionary",
	named: identity.closedConstant(
		constantDigest(
			"closed-constant",
			{ dictionary: typeLabel(baseOf(space.field.type)), values: space.keys },
			everyProperty
		)
	),
	field: space.field,
	values: space.values
})

/**
 * The ARE dictionary of a str.pattern payload field's dictionary space: each value's ARE, the one PostgreSQL's `~`
 * reads (scalar/regex/admit.ts matchAre), in the dictionary's code order, so (ARE())[c + 1] is code c's pattern as
 * ARE, read by the key its value is read by; named by the digest of the ARE texts themselves, so a changed translation
 * is a new function.
 */
const plannedAre = (
	space: Extract<CodeSpace, { readonly kind: "dictionary" }>
): PlannedDictionary => {
	const values = space.values.map((value): TypedLiteral => {
		if (value.kind !== "text") {
			defect("a str.pattern field's value is a text")
		}
		return { kind: "text", value: matchAre(value.value) }
	})
	return {
		kind: "dictionary",
		named: identity.closedConstant(
			constantDigest("closed-constant", { are: values.map((v) => literalKey(v)) }, everyProperty)
		),
		field: space.field,
		values
	}
}

/** A key field and its roster's codes, which its coordinate indexes by. */
interface KeyField {
	readonly field: LawField
	readonly codec: RosterCodec
}

/**
 * A key as planned: a product of its fields' codes, or a dependent sum over an owner prefix, its block's coordinates
 * each a closed id's codes or a slot of one of its counts (`slot`, the count's position among `counts`), with the
 * functions that give each owner its block's first cell and each of its counts, planned as closed relations over the
 * owner prefix.
 */
type PlannedKey =
	| {
			readonly kind: "product"
			readonly space: KeySpace
			readonly fields: NonEmptyReadonlyArray<KeyField>
	  }
	| {
			readonly kind: "dependent"
			readonly space: DependentSpace
			readonly owner: NonEmptyReadonlyArray<KeyField>
			readonly block: NonEmptyReadonlyArray<KeyField & { readonly slot: number | undefined }>
			readonly bases: PlannedCells
			readonly counts: NonEmptyReadonlyArray<PlannedCells>
	  }

/** The fields a planned key reads, one digit each, in key order. */
const keyFieldsOf = (key: PlannedKey): NonEmptyReadonlyArray<KeyField> =>
	key.kind === "product" ? key.fields : extendNonEmpty(key.owner, key.block)

/** The handle a code spells in a refusal: a live handle, or a hole's empty name. */
const codeName = (codec: RosterCodec, code: number): string =>
	defined(codec.names[code], "a code below its roster's size")

/**
 * A function of every owner of `owner`'s prefix, `value(o)` at the owner of index o, planned as a closed relation over
 * the prefix whose payload holds `codes` values: each owner an entry, holes included, so a read at any code the prefix's
 * domains admit finds its value. `value` is called once per owner, in index order, so a running sum may be its value.
 * Refused as ResourceBound before its entries are built when its payload codes or its owners are past a bigint's
 * (constantBound), or when its literal, a character and a comma at least an owner, is longer than one string the host
 * builds holds.
 */
const ownerFunction = (
	owner: NonEmptyReadonlyArray<KeyField>,
	codes: bigint,
	value: (index: bigint) => bigint,
	what: string
): PlannedCells => {
	const points = spaceSize(mapNonEmpty(owner, (f) => f.codec.size))
	const refusal = constantBound(codes, points, what)
	if (refusal !== undefined) {
		throw new Refusal(refusal)
	}
	const shortest = 2n * points + 2n
	if (shortest > BigInt(maxStringLength)) {
		throw new Refusal(
			resourceBound(SourceLoc(what, []), {
				kind: "stringLengthAtLeast",
				limit: maxStringLength,
				atLeast: Number(shortest)
			})
		)
	}
	const entries: Array<Entry> = []
	for (let index = 0n; index < points; index += 1n) {
		entries.push({ index, payload: value(index) })
	}
	return plannedOf({ cells: points, points: codes, entries })
}

/** One of a dependent key's counts: the fin it reads, and each owner's count by the owner's index. */
interface PlannedCount {
	readonly fin: ClosedSlot["fin"]
	readonly counts: ReadonlyMap<bigint, number>
}

/**
 * The key `fields` of a closed relation `relation` reads, in key order, as planned. It is a dependent sum when it begins
 * with the owner prefix its slots count over and holds a slot after it; otherwise, a side that leaves the prefix or
 * every slot out among them, it is the product of its fields' codes. Each owner's count is its count relation's row,
 * 0 for an owner that relation holds no row for; a count past the codes of a slot field it numbers is refused, since
 * no code would name its last slots.
 */
const plannedKey = (
	codes: Codebook,
	relation: ClosedTheoryRelation,
	fields: NonEmptyReadonlyArray<LawField>,
	what: string
): PlannedKey => {
	const keyed = mapNonEmpty(fields, (field): KeyField => ({
		field,
		codec: codecOfField(codes, field)
	}))
	const product: PlannedKey = {
		kind: "product",
		space: { kind: "product", sizes: mapNonEmpty(keyed, (f) => f.codec.size) },
		fields: keyed
	}
	const [first] = relation.slots
	if (first === undefined) {
		return product
	}
	const prefix = first.owner
	const owner = keyed.slice(0, prefix.length)
	const rest = keyed.slice(prefix.length)
	const slotOf = (name: string): ClosedSlot | undefined =>
		relation.slots.find((s) => s.field === name)
	if (
		!isNonEmpty(owner) ||
		!isNonEmpty(rest) ||
		!prefix.every((name, i) => owner[i]?.field.name === name) ||
		!rest.some((f) => slotOf(f.field.name) !== undefined)
	) {
		return product
	}
	const ownerSizes = mapNonEmpty(owner, (f) => f.codec.size)
	const fins: Array<PlannedCount> = []
	const countOf = (slot: ClosedSlot): number => {
		const at = fins.findIndex(
			(f) => f.fin.relation === slot.fin.relation && f.fin.count === slot.fin.count
		)
		if (at >= 0) {
			return at
		}
		const counts = new Map<bigint, number>()
		for (const row of slot.counts) {
			const index = defined(
				rowMajorIndex(
					ownerSizes,
					row.owner.map((literal, i) =>
						handleCode(defined(owner[i], "an owner field per owner value").codec, literal)
					)
				),
				"an owner's codes name a point of the owner prefix"
			)
			counts.set(index, Number(row.count))
		}
		fins.push({ fin: slot.fin, counts })
		return fins.length - 1
	}
	const block = mapNonEmpty(rest, (f) => {
		const slot = slotOf(f.field.name)
		return { ...f, slot: slot === undefined ? undefined : countOf(slot) }
	})
	for (const b of block) {
		const fin = b.slot === undefined ? undefined : defined(fins[b.slot], "a slot's count")
		if (fin !== undefined && mostOf(fin) > b.codec.size) {
			throw new Refusal(
				malformedDescription(
					SourceLoc(what, []),
					`slots of ${finText(fin.fin)}, each a code of ${b.field.name}'s roster ${b.codec.roster}; an owner counts ${mostOf(fin)} slots where the roster has ${b.codec.size} codes`
				)
			)
		}
	}
	const counts = new Map<bigint, NonEmptyReadonlyArray<number>>()
	for (const fin of fins) {
		for (const index of fin.counts.keys()) {
			counts.set(
				index,
				mapNonEmpty(nonEmptyFins(fins), (f) => f.counts.get(index) ?? 0)
			)
		}
	}
	const coordinates = mapNonEmpty(block, (b): BlockCoordinate =>
		b.slot === undefined ? { kind: "codes", size: b.codec.size } : { kind: "slots", count: b.slot }
	)
	const space = dependentSpace(ownerSizes, coordinates, counts)
	const cells = keyCells(space)
	let next = 0n
	return {
		kind: "dependent",
		space,
		owner,
		block,
		bases: ownerFunction(
			owner,
			cells + 1n,
			(index) => {
				const base = next
				next += spaceSize(blockRadices(coordinates, counts, index))
				return base
			},
			`the block bases of ${what}`
		),
		counts: mapNonEmpty(nonEmptyFins(fins), (fin) =>
			ownerFunction(
				owner,
				BigInt(mostOf(fin) + 1),
				(index) => BigInt(fin.counts.get(index) ?? 0),
				`the counts of ${finText(fin.fin)} over ${what}`
			)
		)
	}
}

/** The greatest count a fin gives an owner, 0 for one that gives none. */
const mostOf = (fin: PlannedCount): number => {
	let most = 0
	for (const count of fin.counts.values()) {
		most = Math.max(most, count)
	}
	return most
}

/** A fin as its declaration spells it, fin(O, "n"). */
const finText = (fin: ClosedSlot["fin"]): string =>
	`fin(${fin.relation}, ${JSON.stringify(fin.count)})`

/** A dependent key's counts, which its slots make at least one of. */
const nonEmptyFins = (fins: ReadonlyArray<PlannedCount>): NonEmptyReadonlyArray<PlannedCount> => {
	if (!isNonEmpty(fins)) {
		defect("a dependent key holds a slot")
	}
	return fins
}

/** A closed relation's or side's constants as planned: its key, its codes and the dictionaries. */
interface PlannedSide {
	readonly key: PlannedKey
	readonly cells: PlannedCells
	readonly payload: ReadonlyArray<CodeSpace>
	readonly dictionaries: ReadonlyArray<PlannedDictionary>
}

/** A closed relation's constants as planned: its side's over its whole heading, and each str.pattern payload field's
 * ARE dictionary (plannedAre). */
interface PlannedRelation extends PlannedSide {
	readonly ares: ReadonlyArray<PlannedDictionary>
}

/**
 * A row's key codes outside its key's space, refused: a slot code at or past its owner's count, which the relation's
 * fin says the owner does not hold. Every other code is its roster's, so this is the one way a declared row misses.
 */
const outsideFin = (
	key: PlannedKey,
	codes: NonEmptyReadonlyArray<number>,
	row: number,
	what: string
): never => {
	if (key.kind === "product") {
		defect("a closed id's code is a point of its roster's codes")
	}
	const owner = codes.slice(0, key.owner.length)
	const names = key.owner.map((f, i) => codeName(f.codec, defined(owner[i], "an owner code")))
	const index = defined(
		rowMajorIndex(key.space.owner, owner),
		"a row's owner codes name a point of the owner prefix"
	)
	const radices = blockRadices(key.space.block, key.space.counts, index)
	const past = key.block.flatMap((b, i) => {
		const code = defined(codes[key.owner.length + i], "a code per block field")
		const count = defined(radices[i], "a radix per block field")
		return b.slot !== undefined && code >= count ? [{ field: b.field.name, code, count }] : []
	})
	const [slot] = past
	if (slot === undefined) {
		defect("a row outside its key's space has a slot code past its owner's count")
	}
	throw new Refusal(
		malformedDescription(
			SourceLoc(what, []),
			`row ${row}'s slot ${slot.field} below the ${slot.count} slots its owner (${names.join(", ")}) counts; its code is ${slot.code}`
		)
	)
}

/**
 * The constants of `rows`, a closed relation `relation`'s or its side's, over the key fields `key` and the payload fields
 * `payloadFields`, `what` naming them. A row whose slot code is past its owner's count is refused (outsideFin).
 */
const plannedSide = (
	codes: Codebook,
	relation: ClosedTheoryRelation,
	key: NonEmptyReadonlyArray<LawField>,
	payloadFields: ReadonlyArray<LawField>,
	rows: ReadonlyArray<Split<TypedLiteral>>,
	what: string
): PlannedSide => {
	const planned = plannedKey(codes, relation, key, what)
	const fields = keyFieldsOf(planned)
	const columns = payloadFields.map((f, i) =>
		payloadColumn(
			codes,
			f,
			rows.map((row) => defined(row.payload[i], "a payload value per payload field"))
		)
	)
	const payload = columns.map((column) => column.space)
	const tuples = rows.map((row, r): Tuple => {
		const keyCodes = mapNonEmpty(fields, (f, i) =>
			handleCode(f.codec, defined(row.key[i], "a key value per key field"))
		)
		if (keyIndex(planned.space, keyCodes) === undefined) {
			outsideFin(planned, keyCodes, r, what)
		}
		return {
			key: keyCodes,
			payload: columns.map((column) => defined(column.codes[r], "a payload code per row"))
		}
	})
	return {
		key: planned,
		cells: plannedCells({ key: planned.space, payload: payload.map(radixOf) }, tuples, what),
		payload,
		dictionaries: payload.flatMap((space) =>
			space.kind === "dictionary" ? [plannedDictionary(space)] : []
		)
	}
}

/** A field of a closed relation by name: every name a side or key reads is one of its fields. */
const fieldNamed = (relation: ClosedTheoryRelation, name: string): LawField =>
	defined(
		relation.fields.find((f) => f.name === name),
		`a field ${name} of the closed relation ${relation.name}`
	)

/**
 * The installation's closed relations, by name, each with its constants planned: every closed relation the owned
 * schema declares, a roster aside (its codes are its names constant's). Planned before any name is read, since every
 * reader of the installation's names reads a closed relation's constants by them (PhysicalNames.closed).
 */
export interface ClosedPlan {
	readonly relations: ReadonlyMap<string, PlannedRelation>
}

/** Each closed relation of `owned` the theory holds, its constants planned over the installation's codes. */
export const planClosed = (
	owned: Owned,
	closed: ReadonlyArray<ClosedTheoryRelation>,
	codes: Codebook
): ClosedPlan => {
	const out = new Map<string, PlannedRelation>()
	for (const r of closed.toSorted((x, y) => compareStrings(x.name, y.name))) {
		const entry = owned.relations[r.name]
		if (entry?.kind !== "closedRelation") {
			continue
		}
		const key = r.primaryFields
		const payload = r.fields.filter((f) => !key.includes(f))
		const rows = r.rows.map((row): Split<TypedLiteral> => ({
			key: key.map((f) => closedCell(row, f.position)),
			payload: payload.map((f) => closedCell(row, f.position))
		}))
		const side = plannedSide(codes, r, key, payload, rows, `closed relation ${r.name}`)
		out.set(r.name, {
			...side,
			ares: side.payload.flatMap((space) =>
				space.kind === "dictionary" && textOf(space.field.type) === "pattern"
					? [plannedAre(space)]
					: []
			)
		})
	}
	return { relations: out }
}

/** A planned constant's function in the installed schema. */
const functionOf = (schema: string, named: Identity<"closedConstant">): ObjectName => ({
	schema,
	name: identifierOf(named)
})

/**
 * A closed relation's constants as readers address them, each function by its identifier alone (sql/constants.ts
 * ClosedConstant): what the snapshot records of every closed relation (deploy/snapshot DeploySnapshot.closed), so a
 * Db names them without packing a cell, and what the installation's names qualify under its schema (qualifiedClosed).
 */
export type NamedClosed = ClosedConstant<Identifier<"closedConstant">>

/** Each closed relation's constants as readers address them, by the relation's declared name. */
export type ClosedNames = ReadonlyMap<string, NamedClosed>

/** How readers address a planned key (ClosedKey), each owner function by its identifier. */
const namedKeyOf = (key: PlannedKey): ClosedKey<Identifier<"closedConstant">> =>
	key.kind === "product"
		? {
				kind: "product",
				coordinates: mapNonEmpty(key.fields, (f) => ({ field: f.field.name, radix: f.codec.size }))
			}
		: {
				kind: "dependent",
				owner: mapNonEmpty(key.owner, (f) => ({ field: f.field.name, radix: f.codec.size })),
				block: mapNonEmpty(key.block, (b) =>
					b.slot === undefined
						? { kind: "codes", field: b.field.name, radix: b.codec.size }
						: { kind: "slots", field: b.field.name, count: b.slot }
				),
				bases: namedFunctions(key.bases),
				counts: mapNonEmpty(key.counts, namedFunctions),
				cells: keyCells(key.space)
			}

/** A planned constant's functions as its readers address them (sql/constants.ts ConstantFunctions), by identifier. */
const namedFunctions = (
	planned: PlannedCells
): ConstantFunctions<Identifier<"closedConstant">> => ({
	cells: identifierOf(planned.cells.named),
	payloads:
		planned.payloads.kind === "codes"
			? { kind: "codes", function: identifierOf(planned.payloads.function.named) }
			: { kind: "one" }
})

/** The owner functions a planned key reads: none for a product, a dependent sum's bases and counts. */
const layoutOf = (key: PlannedKey): ReadonlyArray<PlannedCells> =>
	key.kind === "product" ? [] : [key.bases, ...key.counts]

/** How readers address a planned relation's constants (NamedClosed). */
const namedClosedOf = (plan: PlannedRelation): NamedClosed => {
	const dictionaries = new Map(plan.dictionaries.map((d) => [d.field.name, d] as const))
	const ares = new Map(plan.ares.map((d) => [d.field.name, d] as const))
	const constant = namedFunctions(plan.cells)
	const others = [
		...arraysOf(plan.cells).slice(1),
		...layoutOf(plan.key).flatMap(arraysOf),
		...plan.dictionaries,
		...plan.ares
	]
		.map((planned) => identifierOf(planned.named))
		.filter((fn, i, all) => fn !== constant.cells && all.indexOf(fn) === i)
	return {
		constant,
		key: namedKeyOf(plan.key),
		payload: plan.payload.map((space) => {
			const dictionary = dictionaries.get(space.field.name)
			const are = ares.get(space.field.name)
			return {
				field: space.field.name,
				radix: radixOf(space),
				dictionary: dictionary === undefined ? undefined : identifierOf(dictionary.named),
				are: are === undefined ? undefined : identifierOf(are.named)
			}
		}),
		functions: [constant.cells, ...others]
	}
}

/** Each planned closed relation's constants as readers address them, by name. */
export const closedNames = (plan: ClosedPlan): ClosedNames =>
	new Map([...plan.relations].map(([name, r]) => [name, namedClosedOf(r)] as const))

/** A constant's functions as readers address them in the installed schema `schema` (qualifiedClosed). */
const qualifiedFunctions = (
	schema: string,
	f: ConstantFunctions<Identifier<"closedConstant">>
): ConstantFunctions => ({
	cells: { schema, name: f.cells },
	payloads:
		f.payloads.kind === "codes"
			? { kind: "codes", function: { schema, name: f.payloads.function } }
			: { kind: "one" }
})

/** A key as readers address it in the installed schema `schema`: a dependent key's owner functions qualified there. */
const qualifiedKey = (schema: string, key: ClosedKey<Identifier<"closedConstant">>): ClosedKey =>
	key.kind === "product"
		? key
		: {
				...key,
				bases: qualifiedFunctions(schema, key.bases),
				counts: mapNonEmpty(key.counts, (c) => qualifiedFunctions(schema, c))
			}

/** Each closed relation's constants in the installed schema `schema`, as a read calls them (PhysicalNames.closed). */
export const qualifiedClosed = (
	schema: string,
	names: ClosedNames
): ReadonlyMap<string, ClosedConstant> => {
	const qualified = (name: Identifier<"closedConstant">): ObjectName => ({ schema, name })
	return new Map(
		[...names].map(([relation, c]): readonly [string, ClosedConstant] => [
			relation,
			{
				constant: qualifiedFunctions(schema, c.constant),
				key: qualifiedKey(schema, c.key),
				payload: c.payload.map((p) => ({
					field: p.field,
					radix: p.radix,
					dictionary: p.dictionary === undefined ? undefined : qualified(p.dictionary),
					are: p.are === undefined ? undefined : qualified(p.are)
				})),
				functions: mapNonEmpty(c.functions, qualified)
			}
		])
	)
}

/** A constant's revoke from PUBLIC, which holds EXECUTE on every new function: a role is granted what it calls. */
const revokeFromPublic = (fn: ObjectName): SqlStatement => ({
	kind: "revoke",
	privileges: ["ALL"],
	on: { kind: "FUNCTION", names: [{ ...fn, args: [] }] },
	from: [{ kind: "PUBLIC" }]
})

/**
 * One array of a constant as the migration states it, under its function (sql/ast.ts PackConstant): its literal, the
 * host's encoding (ir/cells.ts cellsLiteralOf, payloadsLiteralOf), with its layout, its row count and its content's
 * digest, the one its function's name digests, which `grizzle check` decodes the literal back to. A literal longer than
 * one string the host builds holds is refused as ResourceBound before it is joined. That bound is PostgreSQL's too: a
 * cells literal within it holds at most 60,886,888 indexes, which are distinct, the most being 0 to 60,886,887, each a
 * comma and its digits, and its payloads literal as many codes, so each array is under 500 MB, within the allocation
 * that reads it (MaxAllocSize), and each statement within a protocol message (core/wire.ts messageMaxBytes).
 */
const packOf = (schema: string, planned: PlannedArray): PackConstant => {
	const fn = functionOf(schema, planned.named)
	const text =
		planned.layout.kind === "cells"
			? cellsLiteralOf(planned.constant, maxStringLength)
			: payloadsLiteralOf(planned.constant, maxStringLength)
	if (!text.ok) {
		throw new Refusal(
			resourceBound(SourceLoc(printObjectName(fn), []), {
				kind: "stringLength",
				limit: maxStringLength,
				needed: text.error
			})
		)
	}
	return pack(fn, planned.layout, {
		text: text.value,
		rows: planned.constant.entries.length,
		digest: planned.digest
	})
}

/**
 * A dictionary's CREATE: its values as one array literal of their base type, each element the text its input function
 * reads, in code order, so (D())[c + 1] is code c's value.
 */
const dictionaryOf = (b: InstallBuilder, planned: PlannedDictionary): CreateConstant => {
	const array = defined(
		arrayOf(baseTypeRef(b.names, planned.field.type)),
		"a dictionary's payload field is never a set"
	)
	return {
		kind: "createConstant",
		language: "sql",
		name: functionOf(b.schema, planned.named),
		params: [],
		returns: array,
		body: lit.text(
			textArrayLiteral(planned.values.map((v) => persistentText(b.names, v, planned.field.type))),
			array
		)
	}
}

/** One planned constant as an object of the installation, after the schema; equal constants are one object, the first
 * added, which holds every reason it is there for. */
const addPlanned = (
	b: InstallBuilder,
	planned: PlannedConstant,
	reasons: ReadonlyArray<PhysicalReason>
): Node<"setup"> => {
	b.name(planned.named)
	const fn = functionOf(b.schema, planned.named)
	return b.addConstant(
		planned.named,
		{
			ddl: () => [
				planned.kind === "array" ? packOf(b.schema, planned) : dictionaryOf(b, planned),
				revokeFromPublic(fn)
			],
			reasons
		},
		[b.schemaNode]
	)
}

/** A planned relation's constants: its codes, its dependent key's owner functions, each dictionary and each ARE
 * dictionary. */
const constantsOf = (r: PlannedRelation): ReadonlyArray<PlannedConstant> => [
	...arraysOf(r.cells),
	...layoutOf(r.key).flatMap(arraysOf),
	...r.dictionaries,
	...r.ares
]

/** Every closed relation's constants as objects of the installation, in relation name order (constantsOf). */
export const addClosedRelations = (b: InstallBuilder, plan: ClosedPlan): void => {
	for (const [name, r] of plan.relations) {
		const why = [enforcement(`closed relation ${name}`)]
		for (const planned of constantsOf(r)) {
			addPlanned(b, planned, why)
		}
	}
}

/** What one roster installs: its names constant, its live-codes constant and its domain, and, when a set is typed over
 * it, its bits domain. */
export interface RosterObjects {
	readonly roster: HeldName
	readonly names: { readonly name: ObjectName; readonly node: Node<"setup"> }
	readonly live: { readonly name: ObjectName; readonly node: Node<"setup"> }
	readonly domain: { readonly name: ObjectName; readonly node: Node<"setup"> }
	readonly bits:
		| { readonly domain: { readonly name: ObjectName; readonly node: Node<"setup"> } }
		| undefined
}

/** The identities of a roster's constants (rosterConstants): its names constant and its live-codes constant. */
export interface RosterConstants {
	readonly names: Identity<"rosterConstant">
	readonly live: Identity<"rosterLive">
}

/**
 * The identities of a roster's constants, each named by its roster and the digest of what it holds: its names constant,
 * by its names in code order, which a role view's decoded column reads; and its live-codes constant, by its live codes
 * (liveHex), which its domain's CHECK and its sets' domain's CHECK read. Both CHECKs ask only whether a code is live, so
 * a handle's rename replaces the names constant alone and re-points neither.
 */
export const rosterConstants = (codec: RosterCodec): RosterConstants => ({
	names: identity.rosterConstant(
		codec.roster,
		constantDigest("roster-names", codec.names, everyProperty)
	),
	live: identity.rosterLive(
		codec.roster,
		constantDigest("roster-live", liveHex(codec), everyProperty)
	)
})

/** A roster's names constant's function, the one its domain's CHECK and a role view's decoded column read. */
export const namesConstant = (b: InstallBuilder, roster: HeldName): ObjectName => ({
	schema: b.schema,
	name: identifierOf(b.names.rosterConstants(roster).names)
})

/** An integer PostgreSQL types integer, which prints bare. */
const int = (value: number): Expr => lit.int(value, types.integer)

/**
 * The scalar expressions the installation lowers into its tables and domains from `model`, the roots of each: every
 * stored relation's generated field, and its law model's natives' (a table's CHECK, a law column's term and guard, a
 * closed check's guards, a contract domain's predicate). What a set literal or cast among them names (setRosters) and
 * the library functions they call (physical/ddl/library.ts libraryCalls) are installed for them.
 */
export const persistentExprs = (model: LawModel): ReadonlyArray<ScalarExpr> => {
	const roots: Array<ScalarExpr> = []
	for (const r of model.relations.values()) {
		for (const f of r.relation.fields) {
			const generation = generationOf(f)
			if (generation !== undefined) {
				roots.push(generation)
			}
		}
	}
	for (const { object: o } of model.natives) {
		switch (o.kind) {
			case "TableCheck":
				roots.push(o.predicate)
				continue
			case "LawColumn":
				if (o.value.kind === "generated") {
					roots.push(o.value.term)
					appendAll(roots, o.value.guard)
				}
				continue
			case "ClosedCheck":
				appendAll(
					roots,
					o.guard.map((g) => g.predicate)
				)
				continue
			case "Domain":
				if (o.check.kind === "checked") {
					for (const t of o.check.terms) {
						if (t.kind === "predicate") {
							roots.push(unwrap(predicateTree(t.predicate)))
						}
					}
				}
				continue
			case "PrimaryKey":
			case "Unique":
			case "RosterDomain":
			case "ForeignKey":
			case "WithoutOverlaps":
			case "PeriodForeignKey":
			case "ReverseIndex":
				continue
		}
	}
	return roots
}

/** The rosters some set is typed over: each a field of a stored relation holds a set of, or a persistent expression
 * the installation lowers holds a set of (persistentExprs), so every bits domain a column, a literal or a cast names
 * is installed. */
const setRosters = (b: InstallBuilder): ReadonlySet<HeldName> => {
	const out = new Set<HeldName>()
	const note = (t: ScalarType): void => {
		const base = baseOf(t)
		if (base.carrier === "bits") {
			out.add(base.roster.closed)
		}
	}
	for (const r of b.model.relations.values()) {
		for (const f of r.relation.fields) {
			note(f.type)
		}
	}
	for (const e of exprClosure(persistentExprs(b.model))) {
		note(e.type)
	}
	return out
}

/**
 * Each roster's objects, in roster name order, after the schema:
 *
 * - its names constant, `<roster>__names__<digest>() RETURNS name[] RETURN '{"h0","h1","",…}'::name[]`, code c's handle
 *   at subscript c + 1 and a hole the empty name, which a role view's decoded column reads;
 * - its live-codes constant, `<roster>__live__<digest>() RETURNS bit varying RETURN X'<hex>'::bit varying`, the set of
 *   its live codes at the width of a set over it (ir/codes.ts liveHex), n every code the roster has minted rounded up
 *   to whole bytes (RosterCodec.width), a hole's bit and every padding bit 0;
 * - its domain, `CREATE DOMAIN <roster> AS smallint CONSTRAINT check CHECK (VALUE IS NULL OR (CASE WHEN VALUE >= 0 AND
 *   VALUE < n THEN get_bit(L(), VALUE::integer) = 1 ELSE false END) IS TRUE)`, which admits exactly the live codes: a
 *   code past either end is refused before any bit is read, and a hole's bit is 0;
 * - for a roster some set is typed over (`setRosters`), its bits domain, `CREATE DOMAIN <roster>__bits__<n> AS bit(n)
 *   CONSTRAINT check CHECK (VALUE IS NULL OR ((VALUE & L()) = VALUE) IS TRUE)`, which admits only the live codes' bits,
 *   so a set that sets a hole's or a padding bit is refused.
 *
 * Both CHECKs read the live-codes constant alone, named by the live codes (rosterConstants), so a handle's rename,
 * which moves no code, replaces the names constant alone and leaves every domain as it stands.
 *
 * Each domain admits NULL, the printer's wrapper of every domain CHECK (sql/print.ts), so a closed read at an absent key,
 * C.row's NULL prefix or a law column outside its selection is NULL of the domain's type, which the law's three-valued
 * logic judges, and a column's NOT NULL, never the domain, refuses a NULL stored.
 *
 * A roster whose live codes change is a new live constant, and its domains' CHECKs re-point at it, keeping their names;
 * a grown one whose codes pass its width's last byte has a bits domain of the new width.
 */
export const addRosters = (b: InstallBuilder): ReadonlyArray<RosterObjects> => {
	const sets = setRosters(b)
	return Object.values(b.owned.relations)
		.flatMap((r) => (r.kind === "closed" ? [r] : []))
		.toSorted((x, y) => compareStrings(x.name, y.name))
		.map((r): RosterObjects => {
			const roster = r.name
			const codec = defined(b.names.codes.rosters.get(roster), "the codebook holds every roster")
			const constants = b.names.rosterConstants(roster)
			const why = [enforcement(`the codes of roster ${roster}`)]
			const namesNamed = constants.names
			const names: ObjectName = { schema: b.schema, name: b.name(namesNamed) }
			const namesType = types.name(true)
			const namesNode = b.addConstant(
				namesNamed,
				{
					ddl: () => [
						{
							kind: "createConstant",
							language: "sql",
							name: names,
							params: [],
							returns: namesType,
							body: lit.text(textArrayLiteral(codec.names), namesType)
						},
						revokeFromPublic(names)
					],
					reasons: why
				},
				[b.schemaNode]
			)
			const live = addLive(b, roster, codec, constants.live)
			const domainNamed = b.names.rosterNamed(roster)
			const domain = b.names.rosterDomain(roster)
			const domainName: ObjectName = { schema: domain.schema, name: b.name(domainNamed) }
			const value: Expr = { kind: "domainValue" }
			const create: CreateDomain = {
				kind: "createDomain",
				name: domainName,
				base: types.smallint,
				collation: undefined,
				constraints: [
					{
						name: b.name(identity.domainCheck(domainNamed)),
						predicate: {
							kind: "case",
							operand: undefined,
							whens: [
								{
									when: and([ge(value, int(0)), lt(value, int(codec.width))]),
									result: eq(
										call("get_bit", [constantValue(live.name), cast(value, types.integer)]),
										int(1)
									)
								}
							],
							else: lit.bool(false)
						}
					}
				]
			}
			const domainNode = b.addType(
				"domain",
				b.names.levelOf(roster),
				domainNamed,
				{ ddl: [create], reasons: why },
				[b.levelNode(roster), live.node]
			)
			return {
				roster,
				names: { name: names, node: namesNode },
				live,
				domain: { name: domainName, node: domainNode },
				bits: sets.has(roster) ? addBits(b, roster, codec, live) : undefined
			}
		})
}

/**
 * A roster's live-codes constant, `liveNamed` (rosterConstants), which its domain's CHECK and its sets' domain's read
 * (`addRosters`): named by its bits' digest, it reads no other object.
 */
const addLive = (
	b: InstallBuilder,
	roster: HeldName,
	codec: RosterCodec,
	liveNamed: Identity<"rosterLive">
): RosterObjects["live"] => {
	const live: ObjectName = { schema: b.schema, name: b.name(liveNamed) }
	const node = b.addConstant(
		liveNamed,
		{
			ddl: () => [
				{
					kind: "createConstant",
					language: "sql",
					name: live,
					params: [],
					returns: types.varbit,
					body: lit.bits(liveHex(codec), types.varbit)
				},
				revokeFromPublic(live)
			],
			reasons: [enforcement(`the live codes of roster ${roster}`)]
		},
		[b.schemaNode]
	)
	return { name: live, node }
}

/** A roster's bits domain over its live-codes constant `live` (`addRosters`), for a roster some set is typed over. */
const addBits = (
	b: InstallBuilder,
	roster: HeldName,
	codec: RosterCodec,
	live: RosterObjects["live"]
): RosterObjects["bits"] => {
	const why = [enforcement(`the live codes of roster ${roster}, which a set over it holds`)]
	const domainNamed = b.names.bitsNamed(roster)
	const domain: ObjectName = {
		schema: b.names.bitsDomain(roster).schema,
		name: b.name(domainNamed)
	}
	const value: Expr = { kind: "domainValue" }
	const domainNode = b.addType(
		"domain",
		b.names.levelOf(roster),
		domainNamed,
		{
			ddl: [
				{
					kind: "createDomain",
					name: domain,
					base: types.bit(codec.width),
					collation: undefined,
					constraints: [
						{
							name: b.name(identity.domainCheck(domainNamed)),
							predicate: eq(binary("&", value, constantValue(live.name)), value)
						}
					]
				}
			],
			reasons: why
		},
		[b.levelNode(roster), live.node]
	)
	return { domain: { name: domain, node: domainNode } }
}

/** Each distinct side the installation's ClosedChecks read, by its side and then its target relation's name, its
 * constants planned once (planSides). */
export type SidePlans = ReadonlyMap<CellSide<TypedLiteral>, ReadonlyMap<string, PlannedSide>>

/**
 * The constants of each distinct side of a closed relation the law model's ClosedChecks read, each planned once over
 * its rows, under the installation's codes: the law model builds each side of one content once
 * (laws/model/plan.ts closedSidesOf), however many containments read it, so the checks reading one side of one target
 * read one plan, which names their constants alike. A side's plan is named, in a refusal, by the first check that
 * reads it.
 */
export const planSides = (b: InstallBuilder): SidePlans => {
	const out = new Map<CellSide<TypedLiteral>, Map<string, PlannedSide>>()
	for (const { object: check } of b.natives) {
		if (check.kind !== "ClosedCheck") {
			continue
		}
		const closed = check.target
		const byTarget = out.getOrInsertComputed(check.side, () => new Map<string, PlannedSide>())
		if (!byTarget.has(closed.name)) {
			byTarget.set(
				closed.name,
				plannedSide(
					b.names.codes,
					closed,
					mapNonEmpty(check.side.key, (f) => fieldNamed(closed, f)),
					check.side.payload.map((f) => fieldNamed(closed, f)),
					[...check.side.rows.values()],
					`the side of ${closed.name} a containment from ${check.relation.name} reads`
				)
			)
		}
	}
	return out
}

/**
 * A containment into a closed relation's side as the table CHECK that holds it, after its constants, which it adds:
 * the side's codes as a closed relation of its own, with its key's owner functions where its key is a
 * dependent sum, read at the index its key gives the row's key columns (sql/constants.ts cellOfKey), `NOT (guard) IS
 * TRUE OR member`, the guard the source side's selection, each conjunct lowered over the row by `lower`. A row is on
 * the side only where its selection is true: one the selection leaves unknown, by a closed read at an absent key, is
 * off it as one it leaves false is, so the containment holds vacuously there, as a law column's `CASE WHEN` reads it.
 *
 * The guard is a RowGuard, the one representation of a selection over a row. An installed CHECK lowers it by the
 * persistent lowering (physical/ddl/expr.ts lowerPersistent), as every row CHECK and law column's guard is, so a
 * literal is typed by its base and never cast to a domain, whose later tightening would refuse every later insert;
 * only a probe's query, which runs once per statement, lowers a guard through write/probe.ts withinRow.
 *
 * A side of no payload is a set, held where its cells hold the row's cell, `S()[width_bucket(i, S())] = i` (sql/constants.ts
 * held). A side whose payload fields are closed ids holds the row's cell with its payloads holding p there, p the
 * mixed-radix code of the row's payload columns (pairIn). A side with an open-typed payload field compares each payload coordinate
 * on its own, a closed id's code with its column and an open value through its dictionary, `(D())[c + 1] = column`. An
 * absent key reads false or NULL, which the CHECK's IS TRUE refuses. Every key column is typed by its key field's roster domain (ir/law.ts ClosedCheck), so
 * every digit is below its roster's size, and a slot's below its owner's count reads its own cell while one at or past
 * it reads absent: no index aliases a neighbour's.
 */
export const closedMembership = (
	b: InstallBuilder,
	check: NativeOf<"ClosedCheck">,
	sides: SidePlans,
	column: (c: NativeColumn) => Expr,
	lower: (predicate: ScalarExpr) => Expr
): { readonly predicate: Expr; readonly constants: ReadonlyArray<Node<"setup">> } => {
	const plan = defined(
		sides.get(check.side)?.get(check.target.name),
		"every ClosedCheck's side is planned (planSides)"
	)
	const why = lawReasons(check.lawIds)
	const constants = [
		...arraysOf(plan.cells),
		...layoutOf(plan.key).flatMap(arraysOf),
		...plan.dictionaries
	].map((planned) => addPlanned(b, planned, why))
	const sourceOf = (field: string): Expr =>
		column(
			defined(
				check.pairs.find((p) => p.target.name === field),
				`a source column for the side's field ${field}`
			).source
		)
	const index = cellOfKey(
		qualifiedKey(b.schema, namedKeyOf(plan.key)),
		mapNonEmpty(keyFieldsOf(plan.key), (f) => sourceOf(f.field.name))
	)
	const functions = qualifiedFunctions(b.schema, namedFunctions(plan.cells))
	const radices = plan.payload.map(radixOf)
	const member = !isNonEmpty(plan.payload)
		? held(functions.cells, index)
		: plan.payload.every((space) => space.kind === "roster")
			? pairIn(
					functions,
					index,
					payloadCode(
						mapNonEmpty(plan.payload, (space) => ({
							digit: sourceOf(space.field.name),
							radix: radixOf(space)
						}))
					)
				)
			: and(
					mapNonEmpty(plan.payload, (space, position) => {
						const code = payloadDigit(functions, index, radices, position)
						const dictionary = plan.dictionaries.find((d) => d.field === space.field)
						return eq(
							dictionary === undefined
								? code
								: {
										kind: "subscript",
										array: constantValue(functionOf(b.schema, dictionary.named)),
										index: binary("+", code, int(1))
									},
							sourceOf(space.field.name)
						)
					})
				)
	const guards = check.guard.map((g) => lower(g.predicate))
	return {
		predicate: isNonEmpty(guards)
			? { kind: "or", args: [{ kind: "not", expr: { kind: "isTrue", expr: and(guards) } }, member] }
			: member,
		constants
	}
}
