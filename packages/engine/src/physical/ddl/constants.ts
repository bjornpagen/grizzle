import { compareText, everyProperty, Refusal } from "#compiler/core/canonical.ts"
import { type CompileError, malformedDescription, resourceBound } from "#compiler/core/errors.ts"
import { type ConstantDigest, constantDigest } from "#compiler/core/fingerprint.ts"
import { hexDigitsFor } from "#compiler/core/hex.ts"
import {
	type DeclaredName,
	type Identity,
	identifierOf,
	identity
} from "#compiler/core/identity.ts"
import { defect, defined } from "#compiler/core/invariant.ts"
import { cellMaxCodes, constantMaxBits, maxStringLength } from "#compiler/core/limits.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import {
	extendNonEmpty,
	isNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray
} from "#compiler/core/nonempty.ts"
import {
	type BlockCoordinate,
	blockRadices,
	type CellLayout,
	type CellSide,
	cellWidth,
	type Constant,
	constantDigestOf,
	constantOf,
	type DependentSpace,
	dependentSpace,
	keyCells,
	keyIndex,
	type KeySpace,
	literalOf,
	rowMajorIndex,
	type Split,
	spaceSize,
	type Tuple
} from "#compiler/ir/cells.ts"
import { type Codebook, codeOf, liveHex, type RosterCodec } from "#compiler/ir/codes.ts"
import type { ScalarExpr, TypedLiteral } from "#compiler/ir/expr.ts"
import type {
	ClosedSlot,
	ClosedTheoryRelation,
	LawField,
	NativeColumn,
	NativeOf
} from "#compiler/ir/law.ts"
import { baseTypeRef } from "#compiler/ir/physical.ts"
import type { PhysicalReason } from "#compiler/ir/products.ts"
import { baseOf, rosterOf, type ScalarType, typeLabel } from "#compiler/ir/scalar.ts"
import { literalKey } from "#compiler/laws/model/names.ts"
import type { InstallBuilder } from "#compiler/physical/ddl/context.ts"
import { persistentText } from "#compiler/physical/ddl/expr.ts"
import { enforcement, lawReasons, type Node } from "#compiler/physical/obligations/graph.ts"
import type { Owned } from "#compiler/schema/own.ts"
import type {
	CreateConstant,
	CreateDomain,
	Expr,
	ObjectName,
	PackConstant,
	SqlStatement
} from "#compiler/sql/ast.ts"
import { and, arrayOf, binary, eq, lit, ne, types } from "#compiler/sql/build.ts"
import {
	type ClosedConstant,
	type ClosedKey,
	constantValue,
	inSet,
	cellOfKey,
	type OwnerFunction,
	pack,
	pairIn,
	payloadCode,
	payloadDigit
} from "#compiler/sql/constants.ts"
import { printObjectName } from "#compiler/sql/print.ts"

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
 * - A closed relation installs its string of cells, read at the index its key gives its key fields' codes, its key
 *   set, one bit per point of its key space, and a dictionary per open-typed payload field, the field's values in code
 *   order. A relation of no payload is its own key set, one function. A key is the mixed radix of its closed ids, or,
 *   where its slots count over an owner prefix, a dependent sum, each owner's block after the blocks before it: such a
 *   key also installs two kinds of owner function over the prefix, each owner's block's first cell and each count its
 *   slots read, which its readers index by (sql/constants.ts cellOfKey).
 * - A containment into a closed relation's side installs the side's string of cells, as a closed relation of its own,
 *   which the table CHECK that holds the containment reads (`closedMembership`).
 *
 * Every string of cells is stated as one hex literal (sql/ast.ts PackConstant), the host's encoding of its cells padded
 * with 0 bits to whole digits, under a comment of its row count and content digest, which `grizzle check` decodes and
 * holds to the digest. A role is granted EXECUTE on every constant a statement it runs calls (physical/ddl/roles.ts).
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
			readonly codes: ReadonlyMap<string, number>
	  }

/**
 * The codes a coordinate holds: a roster's every minted code, holes included, or a dictionary's values, at least one: a
 * relation that holds no fact has an empty dictionary, whose cells still take one bit, since PostgreSQL has no bit(0)
 * and no code of it is ever read.
 */
const radixOf = (space: CodeSpace): number =>
	space.kind === "roster" ? space.codec.size : Math.max(1, space.values.length)

/** A literal's code in its coordinate's space: a live handle's code, or a value's position in its dictionary. */
const codeIn = (space: CodeSpace, literal: TypedLiteral): number => {
	if (space.kind === "roster") {
		return handleCode(space.codec, literal)
	}
	return defined(space.codes.get(literalKey(literal)), "a value is in its field's dictionary")
}

/** A closed id's code: its handle's in the roster's codes. */
const handleCode = (codec: RosterCodec, literal: TypedLiteral): number => {
	if (literal.kind !== "handle") {
		throw defect("a closed id's value is a handle of its roster")
	}
	return codeOf(codec, literal.handle)
}

/** A closed id field's roster codes, which every key field of a closed relation is typed by. */
const codecOfField = (codes: Codebook, field: LawField): RosterCodec => {
	const roster = rosterOf(baseOf(field.type))
	if (roster === undefined || baseOf(field.type).carrier !== "code") {
		throw defect(`the closed id ${field.name} is typed by its roster`)
	}
	return defined(codes.rosters.get(roster.closed), "the codebook holds every roster")
}

/** The code space of a payload field over `values`, the field's values in its relation's rows. */
const payloadSpace = (
	codes: Codebook,
	field: LawField,
	values: ReadonlyArray<TypedLiteral>
): CodeSpace => {
	if (baseOf(field.type).carrier === "code") {
		return { kind: "roster", field, codec: codecOfField(codes, field) }
	}
	const distinct = new Map(values.map((v) => [literalKey(v), v] as const))
	const ordered = [...distinct].toSorted(([a], [b]) => compareText(a, b))
	return {
		kind: "dictionary",
		field,
		values: ordered.map(([, v]) => v),
		codes: new Map(ordered.map(([key], code) => [key, code] as const))
	}
}

/** A string of cells planned: its function's identity and its content. */
interface PlannedCells {
	readonly kind: "cells"
	readonly named: Identity<"closedConstant">
	/** The constant's content digest, which `named` mints from and its literal's comment states. */
	readonly digest: ConstantDigest<"closed-constant">
	readonly constant: Constant
}

/** A dictionary planned: its function's identity, its field, and its values in code order. */
interface PlannedDictionary {
	readonly kind: "dictionary"
	readonly named: Identity<"closedConstant">
	readonly field: LawField
	readonly values: ReadonlyArray<TypedLiteral>
}

type PlannedConstant = PlannedCells | PlannedDictionary

/**
 * The string of cells of `tuples` over `layout`, refused as ResourceBound when its payload space holds more codes than
 * a cell read as an integer can, or it is longer than PostgreSQL's longest bit string, each measured before it is built
 * (`what` names it). Tuples that repeat are one cell; two at one key with different payloads are a key the declaration
 * held, so their meeting is a defect. Every tuple's key is a point of the layout's key space: the caller refuses one
 * that is not.
 */
const plannedCells = (
	layout: CellLayout,
	tuples: ReadonlyArray<Tuple>,
	what: string
): PlannedCells => {
	const loc = SourceLoc(what, [])
	const codes = spaceSize(layout.payload)
	const tooWide = cellCodesBound(codes, what)
	if (tooWide !== undefined) {
		throw new Refusal(tooWide)
	}
	const bits = keyCells(layout.key) * BigInt(cellWidth(codes))
	if (bits > BigInt(constantMaxBits.value)) {
		throw new Refusal(
			resourceBound(loc, {
				kind: "constantBits",
				constant: what,
				limit: constantMaxBits.value,
				needed: bits
			})
		)
	}
	const encoded = constantOf(layout, tuples)
	if (!encoded.ok) {
		throw defect(`the declared key of ${what} holds its rows apart`)
	}
	const digest = constantDigestOf(encoded.value)
	return { kind: "cells", named: identity.closedConstant(digest), digest, constant: encoded.value }
}

/**
 * The refusal of a constant whose payload space holds `codes` codes, `what` naming it, when its greatest cell, 1 +
 * (codes - 1), is past the greatest integer a cell is read as (core/limits.ts cellMaxCodes); none when it fits.
 */
export const cellCodesBound = (codes: bigint, what: string): CompileError | undefined =>
	codes > BigInt(cellMaxCodes.value)
		? resourceBound(SourceLoc(what, []), {
				kind: "cellCodes",
				constant: what,
				limit: cellMaxCodes.value,
				needed: codes
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
			{ dictionary: typeLabel(baseOf(space.field.type)), values: space.values.map(literalKey) },
			everyProperty
		)
	),
	field: space.field,
	values: space.values
})

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

/** The digits of `index` in the mixed-radix space of `sizes`, the first most significant. */
const digitsOf = (
	sizes: NonEmptyReadonlyArray<number>,
	index: bigint
): NonEmptyReadonlyArray<number> => {
	let rest = index
	const out: Array<number> = []
	for (const size of sizes.toReversed()) {
		out.unshift(Number(rest % BigInt(size)))
		rest /= BigInt(size)
	}
	return mapNonEmpty(sizes, (_, i) => defined(out[i], "a digit per coordinate"))
}

/**
 * A function of every owner of `owner`'s prefix, `value(o)` at the owner of index o, planned as a closed relation over
 * the prefix whose payload holds `codes` values: each owner a row, holes included, so a read at any code the prefix's
 * domains admit finds its value. `value` is called once per owner, in index order, so a running sum may be its value.
 * Refused as ResourceBound before its rows are built when the prefix's product is longer than PostgreSQL's longest bit
 * string can hold one cell of each.
 */
const ownerFunction = (
	owner: NonEmptyReadonlyArray<KeyField>,
	codes: bigint,
	value: (index: bigint) => bigint,
	what: string
): PlannedCells => {
	const sizes = mapNonEmpty(owner, (f) => f.codec.size)
	const points = spaceSize(sizes)
	const bits = points * BigInt(cellWidth(codes))
	if (bits > BigInt(constantMaxBits.value)) {
		throw new Refusal(
			resourceBound(SourceLoc(what, []), {
				kind: "constantBits",
				constant: what,
				limit: constantMaxBits.value,
				needed: bits
			})
		)
	}
	const tuples: Array<Tuple> = []
	for (let index = 0n; index < points; index += 1n) {
		tuples.push({ key: digitsOf(sizes, index), payload: [Number(value(index))] })
	}
	return plannedCells({ key: { kind: "product", sizes }, payload: [Number(codes)] }, tuples, what)
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
		throw defect("a dependent key holds a slot")
	}
	return fins
}

/** A closed relation's or side's constants as planned: its key, the string of cells, the key set and the dictionaries. */
interface PlannedRelation {
	readonly key: PlannedKey
	readonly cells: PlannedCells
	readonly keys: PlannedCells
	readonly payload: ReadonlyArray<CodeSpace>
	readonly dictionaries: ReadonlyArray<PlannedDictionary>
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
		throw defect("a closed id's code is a point of its roster's codes")
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
		throw defect("a row outside its key's space has a slot code past its owner's count")
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
const plannedRelation = (
	codes: Codebook,
	relation: ClosedTheoryRelation,
	key: NonEmptyReadonlyArray<LawField>,
	payloadFields: ReadonlyArray<LawField>,
	rows: ReadonlyArray<Split<TypedLiteral>>,
	what: string
): PlannedRelation => {
	const planned = plannedKey(codes, relation, key, what)
	const fields = keyFieldsOf(planned)
	const payload = payloadFields.map((f, i) =>
		payloadSpace(
			codes,
			f,
			rows.map((row) => defined(row.payload[i], "a payload value per payload field"))
		)
	)
	const tuples = rows.map((row, r): Tuple => {
		const keyCodes = mapNonEmpty(fields, (f, i) =>
			handleCode(f.codec, defined(row.key[i], "a key value per key field"))
		)
		if (keyIndex(planned.space, keyCodes) === undefined) {
			outsideFin(planned, keyCodes, r, what)
		}
		return {
			key: keyCodes,
			payload: payload.map((space, i) =>
				codeIn(space, defined(row.payload[i], "a payload value per payload field"))
			)
		}
	})
	return {
		key: planned,
		cells: plannedCells({ key: planned.space, payload: payload.map(radixOf) }, tuples, what),
		keys: plannedCells(
			{ key: planned.space, payload: [] },
			tuples.map((t) => ({ key: t.key, payload: [] })),
			`the key set of ${what}`
		),
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
	for (const r of closed.toSorted((x, y) => compareText(x.name, y.name))) {
		const entry = owned.relations[r.name]
		if (entry?.kind !== "closedRelation") {
			continue
		}
		const key = r.primaryFields
		const payload = r.fields.filter((f) => !key.includes(f))
		const rows = r.rows.map((row): Split<TypedLiteral> => ({
			key: key.map((f) => defined(row[f.position], "a value per field")),
			payload: payload.map((f) => defined(row[f.position], "a value per field"))
		}))
		out.set(r.name, plannedRelation(codes, r, key, payload, rows, `closed relation ${r.name}`))
	}
	return { relations: out }
}

/** A planned constant's function in the installed schema. */
const functionOf = (schema: string, named: Identity<"closedConstant">): ObjectName => ({
	schema,
	name: identifierOf(named)
})

/** How readers address a planned key (ClosedKey), under the installed schema. */
const closedKeyOf = (schema: string, key: PlannedKey): ClosedKey =>
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
				bases: ownerFunctionOf(schema, key.bases),
				counts: mapNonEmpty(key.counts, (c) => ownerFunctionOf(schema, c)),
				cells: Number(keyCells(key.space))
			}

/** An owner function as its readers address it: its function and its cells' width. */
const ownerFunctionOf = (schema: string, planned: PlannedCells): OwnerFunction => ({
	function: functionOf(schema, planned.named),
	width: planned.constant.width
})

/** The owner functions a planned key reads: none for a product, a dependent sum's bases and counts. */
const layoutOf = (key: PlannedKey): ReadonlyArray<PlannedCells> =>
	key.kind === "product" ? [] : [key.bases, ...key.counts]

/** How readers address a planned relation's constants (PhysicalNames.closed), under the installed schema. */
const closedConstantOf = (schema: string, plan: PlannedRelation): ClosedConstant => {
	const dictionaries = new Map(plan.dictionaries.map((d) => [d.field.name, d] as const))
	const cells = functionOf(schema, plan.cells.named)
	const others = [plan.keys, ...layoutOf(plan.key), ...plan.dictionaries]
		.map((planned) => functionOf(schema, planned.named))
		.filter(
			(fn, i, all) => fn.name !== cells.name && all.findIndex((f) => f.name === fn.name) === i
		)
	return {
		function: functionOf(schema, plan.cells.named),
		key: closedKeyOf(schema, plan.key),
		width: plan.cells.constant.width,
		payload: plan.payload.map((space) => {
			const dictionary = dictionaries.get(space.field.name)
			return {
				field: space.field.name,
				radix: radixOf(space),
				dictionary: dictionary === undefined ? undefined : functionOf(schema, dictionary.named)
			}
		}),
		keys: functionOf(schema, plan.keys.named),
		functions: [cells, ...others]
	}
}

/** Each planned closed relation's constants as its readers address them, by name. */
export const closedConstants = (
	schema: string,
	plan: ClosedPlan
): ReadonlyMap<string, ClosedConstant> =>
	new Map([...plan.relations].map(([name, r]) => [name, closedConstantOf(schema, r)] as const))

/** A constant's revoke from PUBLIC, which holds EXECUTE on every new function: a role is granted what it calls. */
const revokeFromPublic = (fn: ObjectName): SqlStatement => ({
	kind: "revoke",
	privileges: ["ALL"],
	on: { kind: "FUNCTION", names: [{ ...fn, args: [] }] },
	from: [{ kind: "PUBLIC" }]
})

/**
 * A string of cells as the migration states it, under its function (sql/ast.ts PackConstant): its hex literal, the
 * host's encoding (ir/cells.ts literalOf), with its row count and its content's digest, the one its function's name
 * digests, which `grizzle check` decodes the literal back to. A literal of more digits than one string the host builds
 * holds is refused as ResourceBound before it is built.
 */
const packOf = (schema: string, planned: PlannedCells): PackConstant => {
	const fn = functionOf(schema, planned.named)
	const { cells, width } = planned.constant
	const digits = hexDigitsFor(Number(cells * BigInt(width)))
	if (digits > maxStringLength.value) {
		throw new Refusal(
			resourceBound(SourceLoc(printObjectName(fn), []), {
				kind: "stringLength",
				limit: maxStringLength.value,
				needed: digits
			})
		)
	}
	return pack(fn, cells, width, {
		hex: literalOf(planned.constant),
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
		name: functionOf(b.schema, planned.named),
		params: [],
		returns: array,
		body: lit.text(
			arrayText(planned.values.map((v) => persistentText(b.names, v, planned.field.type))),
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
			ddl: [
				planned.kind === "cells" ? packOf(b.schema, planned) : dictionaryOf(b, planned),
				revokeFromPublic(fn)
			],
			reasons
		},
		[b.schemaNode]
	)
}

/** A planned relation's constants: its cells, its key set (the cells themselves for no payload), its dependent key's
 * owner functions and each dictionary. */
const constantsOf = (r: PlannedRelation): ReadonlyArray<PlannedConstant> => [
	r.cells,
	r.keys,
	...layoutOf(r.key),
	...r.dictionaries
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

/**
 * The text of an array literal of `elements`, each double-quoted with its backslashes and quotes escaped, so an empty
 * element, a hole's name, and one holding a comma, a brace or a space read back as themselves.
 */
const arrayText = (elements: ReadonlyArray<string>): string =>
	`{${elements.map((e) => `"${e.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`).join(",")}}`

/** What one roster installs: its names constant and its domain, and, when a set is typed over it, its live-codes
 * constant and its bits domain. */
export interface RosterObjects {
	readonly roster: DeclaredName
	readonly names: { readonly name: ObjectName; readonly node: Node<"setup"> }
	readonly domain: { readonly name: ObjectName; readonly node: Node<"setup"> }
	readonly bits:
		| {
				readonly live: { readonly name: ObjectName; readonly node: Node<"setup"> }
				readonly domain: { readonly name: ObjectName; readonly node: Node<"setup"> }
		  }
		| undefined
}

/** The identity of a roster's names constant: its roster and the digest of its names in code order. */
const namesIdentity = (codec: RosterCodec): Identity<"rosterConstant"> =>
	identity.rosterConstant(codec.roster, constantDigest("roster-names", codec.names, everyProperty))

/** A roster's names constant's function, the one its domain's CHECK and a role view's decoded column read. */
export const namesConstant = (b: InstallBuilder, roster: DeclaredName): ObjectName => ({
	schema: b.schema,
	name: identifierOf(
		namesIdentity(defined(b.names.codes.rosters.get(roster), "the codebook holds every roster"))
	)
})

/** The empty name, a hole's: no handle is empty, so a code is live exactly when its name is not this. */
const holeName = lit.text("", types.name(false))

/** An integer PostgreSQL types integer, which prints bare. */
const int = (value: number): Expr => lit.int(value, types.integer)

/** The rosters some set is typed over: each a field of a stored relation holds a set of, or a persistent expression
 * the installation lowers holds a set of, so every bits domain a column, a literal or a cast names is installed. */
const setRosters = (b: InstallBuilder): ReadonlySet<DeclaredName> => {
	const out = new Set<DeclaredName>()
	const note = (t: ScalarType): void => {
		const base = baseOf(t)
		if (base.carrier === "bits") {
			out.add(base.roster.closed)
		}
	}
	const walk = (e: ScalarExpr): void => {
		note(e.type)
		for (const a of e.args) {
			walk(a)
		}
	}
	for (const r of b.model.relations.values()) {
		for (const f of r.relation.fields) {
			note(f.type)
			if (f.writing.kind === "generated") {
				walk(f.writing.expr)
			}
		}
	}
	for (const { object: o } of b.natives) {
		switch (o.kind) {
			case "TableCheck":
				walk(o.predicate)
				continue
			case "LawColumn":
				if (o.value.kind === "generated") {
					walk(o.value.term)
					for (const g of o.value.guard) {
						walk(g)
					}
				}
				continue
			case "ClosedCheck":
				for (const g of o.guard) {
					walk(g.predicate)
				}
				continue
			case "PrimaryKey":
			case "Unique":
			case "Domain":
			case "RosterDomain":
			case "ForeignKey":
			case "WithoutOverlaps":
			case "PeriodForeignKey":
			case "ReverseIndex":
				continue
		}
	}
	return out
}

/**
 * Each roster's objects, in roster name order, after the schema:
 *
 * - its names constant, `<roster>__names__<digest>() RETURNS name[] RETURN '{"h0","h1","",…}'::name[]`, code c's handle
 *   at subscript c + 1 and a hole the empty name;
 * - its domain, `CREATE DOMAIN <roster> AS smallint CONSTRAINT check CHECK (VALUE IS NULL OR ((N())[VALUE + 1] <>
 *   ''::name) IS TRUE)`, which admits exactly the live codes: a code past either end reads NULL, and a hole the empty
 *   name;
 * - for a roster some set is typed over (`setRosters`), its live-codes constant,
 *   `<roster>__live__<digest>() RETURNS bit varying RETURN X'<hex>'::bit varying`, the set of its live codes at the
 *   width of a set over it (ir/codes.ts liveHex), and its bits domain, `CREATE DOMAIN <roster>__bits__<n> AS bit(n)
 *   CONSTRAINT check CHECK (VALUE IS NULL OR ((VALUE & L()) = VALUE) IS TRUE)`, n every code the roster has minted
 *   rounded up to whole hex digits (RosterCodec.width), which admits only the live codes' bits: a hole's bit and every
 *   padding bit are 0 in L, so a set that sets one is refused.
 *
 * Each domain admits NULL, the printer's wrapper of every domain CHECK (sql/print.ts), so a closed read at an absent key,
 * C.row's NULL prefix or a law column outside its selection is NULL of the domain's type, which the law's three-valued
 * logic judges, and a column's NOT NULL, never the domain, refuses a NULL stored.
 *
 * A changed roster is a new names constant (and live constant), and its domains' CHECKs re-point at them, keeping their
 * names; a grown one whose width passes a whole hex digit has a bits domain of the new width.
 */
export const addRosters = (b: InstallBuilder): ReadonlyArray<RosterObjects> => {
	const sets = setRosters(b)
	return Object.values(b.owned.relations)
		.flatMap((r) => (r.kind === "closed" ? [r] : []))
		.toSorted((x, y) => compareText(x.name, y.name))
		.map((r): RosterObjects => {
			const roster = r.name
			const codec = defined(b.names.codes.rosters.get(roster), "the codebook holds every roster")
			const digest = constantDigest("roster-names", codec.names, everyProperty)
			const why = [enforcement(`the codes of roster ${roster}`)]
			const namesNamed = namesIdentity(codec)
			const names: ObjectName = { schema: b.schema, name: b.name(namesNamed) }
			const namesType = types.name(true)
			const namesNode = b.addConstant(
				namesNamed,
				{
					ddl: [
						{
							kind: "createConstant",
							name: names,
							params: [],
							returns: namesType,
							body: lit.text(arrayText(codec.names), namesType)
						},
						revokeFromPublic(names)
					],
					reasons: why
				},
				[b.schemaNode]
			)
			const domainNamed = identity.rosterDomain(roster)
			const domain = b.names.rosterDomain(roster)
			const domainName: ObjectName = { schema: domain.schema, name: b.name(domainNamed) }
			const create: CreateDomain = {
				kind: "createDomain",
				name: domainName,
				base: types.smallint,
				collation: undefined,
				constraints: [
					{
						name: b.name(identity.domainCheck(domainNamed)),
						predicate: ne(
							{
								kind: "subscript",
								array: constantValue(names),
								index: binary("+", { kind: "domainValue" }, int(1))
							},
							holeName
						)
					}
				]
			}
			const domainNode = b.addType("domain", domainNamed, { ddl: [create], reasons: why }, [
				b.schemaNode,
				namesNode
			])
			return {
				roster,
				names: { name: names, node: namesNode },
				domain: { name: domainName, node: domainNode },
				bits: sets.has(roster) ? addBits(b, roster, codec, digest) : undefined
			}
		})
}

/**
 * A roster's live-codes constant and its bits domain over it (`addRosters`). The live constant's bits are a function of
 * the roster's names, so it is named by the names constant's digest, and it reads no other object.
 */
const addBits = (
	b: InstallBuilder,
	roster: DeclaredName,
	codec: RosterCodec,
	digest: Parameters<typeof identity.rosterLive>[1]
): RosterObjects["bits"] => {
	const why = [enforcement(`the live codes of roster ${roster}, which a set over it holds`)]
	const liveNamed = identity.rosterLive(roster, digest)
	const live: ObjectName = { schema: b.schema, name: b.name(liveNamed) }
	const liveNode = b.addConstant(
		liveNamed,
		{
			ddl: [
				{
					kind: "createConstant",
					name: live,
					params: [],
					returns: types.varbit,
					body: lit.bits(liveHex(codec), types.varbit)
				},
				revokeFromPublic(live)
			],
			reasons: why
		},
		[b.schemaNode]
	)
	const domainNamed = identity.bitsDomain(roster, codec.width)
	const domain: ObjectName = {
		schema: b.names.bitsDomain(roster).schema,
		name: b.name(domainNamed)
	}
	const value: Expr = { kind: "domainValue" }
	const domainNode = b.addType(
		"domain",
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
							predicate: eq(binary("&", value, constantValue(live)), value)
						}
					]
				}
			],
			reasons: why
		},
		[b.schemaNode, liveNode]
	)
	return { live: { name: live, node: liveNode }, domain: { name: domain, node: domainNode } }
}

/**
 * A containment into a closed relation's side as the table CHECK that holds it, after its constants, which it adds:
 * the side's string of cells as a closed relation of its own, with its key's owner functions where its key is a
 * dependent sum, read at the index its key gives the row's key columns (sql/constants.ts cellOfKey), `NOT (guard) IS
 * TRUE OR member`, the guard the source side's selection, each conjunct lowered over the row by `lower`. A row is on
 * the side only where its selection is true: one the selection leaves unknown, by a closed read at an absent key, is
 * off it as one it leaves false is, so the containment holds vacuously there, as a law column's `CASE WHEN` reads it.
 *
 * The guard is C2's RowGuard, the one representation of a selection over a row. An installed CHECK lowers it by the
 * persistent lowering (physical/ddl/expr.ts lowerPersistent), as every row CHECK and law column's guard is, so a
 * literal is typed by its base and never cast to a domain, whose later tightening would refuse every later insert;
 * only a probe's query, which runs once per statement, lowers a guard through write/insert/unique.ts withinRow.
 *
 * A side of no payload is a set, `substring(S(), i + 1, 1)::integer = 1`. A side whose payload fields are closed ids
 * compares its one cell, `substring(S(), i · w + 1, w)::integer = 1 + p`, p the mixed-radix code of the row's payload
 * columns. A side with an open-typed payload field compares each payload coordinate on its own, a closed id's code
 * with its column and an open value through its dictionary, `(D())[c + 1] = column`. An absent key reads NULL, which
 * the CHECK's IS TRUE refuses. Every key column is typed by its key field's roster domain (ir/law.ts ClosedCheck), so
 * every digit is below its roster's size, and a slot's below its owner's count reads its own cell while one at or past
 * it reads absent: no index aliases a neighbour's.
 */
export const closedMembership = (
	b: InstallBuilder,
	check: NativeOf<"ClosedCheck">,
	column: (c: NativeColumn) => Expr,
	lower: (predicate: ScalarExpr) => Expr
): { readonly predicate: Expr; readonly constants: ReadonlyArray<Node<"setup">> } => {
	const side: CellSide<TypedLiteral> = check.side
	const closed = check.target
	const plan = plannedRelation(
		b.names.codes,
		closed,
		mapNonEmpty(side.key, (f) => fieldNamed(closed, f)),
		side.payload.map((f) => fieldNamed(closed, f)),
		[...side.rows.values()],
		`the side of ${closed.name} a containment from ${check.relation.name} reads`
	)
	const why = lawReasons(check.lawIds)
	const constants = [plan.cells, ...layoutOf(plan.key), ...plan.dictionaries].map((planned) =>
		addPlanned(b, planned, why)
	)
	const sourceOf = (field: string): Expr =>
		column(
			defined(
				check.pairs.find((p) => p.target.name === field),
				`a source column for the side's field ${field}`
			).source
		)
	const index = cellOfKey(
		closedKeyOf(b.schema, plan.key),
		mapNonEmpty(keyFieldsOf(plan.key), (f) => sourceOf(f.field.name))
	)
	const cells = functionOf(b.schema, plan.cells.named)
	const width = plan.cells.constant.width
	const radices = plan.payload.map(radixOf)
	const member = !isNonEmpty(plan.payload)
		? inSet(cells, index)
		: plan.payload.every((space) => space.kind === "roster")
			? pairIn(
					cells,
					index,
					width,
					payloadCode(
						mapNonEmpty(plan.payload, (space) => ({
							digit: sourceOf(space.field.name),
							radix: radixOf(space)
						}))
					)
				)
			: and(
					mapNonEmpty(plan.payload, (space, position) => {
						const code = payloadDigit(cells, index, width, radices, position)
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
