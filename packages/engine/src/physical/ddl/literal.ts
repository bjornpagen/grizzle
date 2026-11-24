import { defined } from "@bjornpagen/grizzle-text/base/invariant"
import type * as Result from "@bjornpagen/grizzle-text/base/result"
import type { ConstantDigest } from "#compiler/core/fingerprint.ts"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import {
	cellsDigestOf,
	cellsOfLiteral,
	type LiteralFault,
	payloadsDigestOf,
	payloadsOfLiteral
} from "#compiler/ir/cells.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"
import type { PackConstant, PackLayout } from "#compiler/sql/ast.ts"
import type { ClosedKey, ConstantFunctions } from "#compiler/sql/constants.ts"
import { looksLikeLiteralPack, printObjectName, readLiteralPack } from "#compiler/sql/print.ts"

/**
 * What `grizzle check` holds a migration's closed constant to (sql/print.ts writePack), its one reader of them: an
 * array's literal is trusted only when it decodes to the content its comment states and its function's name digests,
 * and holds the rows its comment counts.
 *
 * - `form`: a statement that begins as a literal pack's comment does but departs from the printed form;
 * - `layout`: a literal that is no array of its layout (ir/cells.ts LiteralFault): unbraced, a cells literal not led by
 *   the sentinel -1, an element not spelled as the host spells it, indexes out of strictly ascending order, an index
 *   past the cells or a payload code past the payload codes its comment states;
 * - `content`: a literal whose elements digest neither to the content its comment states nor to its function's name,
 *   edited after it was drafted, or a comment or name edited away from it: the function it creates, the closed
 *   relation whose constant it is where the schema declares one, and the first cell where it and the schema's declared
 *   rows part, with the key's handles there, where the schema still plans the function and, for a payloads literal, the
 *   cells it pairs with;
 * - `rows`: a comment whose row count is not the elements its literal holds, one per row.
 */
export type PackFault =
	| { readonly kind: "form" }
	| { readonly kind: "layout"; readonly function: string; readonly fault: LiteralFault }
	| {
			readonly kind: "content"
			readonly function: string
			readonly relation: string | undefined
			readonly differs:
				| { readonly cell: bigint; readonly key: ReadonlyArray<string> | undefined }
				| undefined
	  }
	| {
			readonly kind: "rows"
			readonly function: string
			readonly stated: bigint
			readonly held: bigint
	  }

/** A literal read over its layout: its elements, an index or a payload code each, or the fault it is refused for. */
const elementsOf = (
	text: string,
	layout: PackLayout
): Result.Result<ReadonlyArray<bigint>, LiteralFault> =>
	layout.kind === "cells"
		? cellsOfLiteral(text, layout.cells)
		: payloadsOfLiteral(text, layout.points)

/** The digest a literal's elements state over its layout: its cells' or its payloads' (ir/cells.ts). */
const digestOf = (
	elements: ReadonlyArray<bigint>,
	layout: PackLayout
): ConstantDigest<"closed-constant"> =>
	layout.kind === "cells"
		? cellsDigestOf(layout.cells, elements)
		: payloadsDigestOf(layout.points, elements)

/** A pack's elements, read back from its literal; none for a literal off its layout. */
const heldElements = (pack: PackConstant): ReadonlyArray<bigint> | undefined => {
	const read = elementsOf(pack.text, pack.layout)
	return read.ok ? read.value : undefined
}

/**
 * The first cell where two cells literals, each its indexes ascending, part: the least index one holds and the other
 * does not; none where they agree.
 */
const firstCellApart = (a: ReadonlyArray<bigint>, b: ReadonlyArray<bigint>): bigint | undefined => {
	for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
		const x = a[i]
		const y = b[i]
		if (x === undefined || y === undefined) {
			return x ?? y
		}
		if (x !== y) {
			return x < y ? x : y
		}
	}
	return undefined
}

/** The first position where two payloads literals part, one holding a code the other does not or another; none alike. */
const firstPositionApart = (
	a: ReadonlyArray<bigint>,
	b: ReadonlyArray<bigint>
): number | undefined => {
	for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
		if (a[i] !== b[i]) {
			return i
		}
	}
	return undefined
}

/** The digits of `index` in the mixed-radix space of `radices`, the first most significant. */
const digitsOf = (radices: ReadonlyArray<bigint>, index: bigint): ReadonlyArray<bigint> => {
	const out: Array<bigint> = []
	let rest = index
	for (const radix of radices.toReversed()) {
		out.unshift(rest % radix)
		rest /= radix
	}
	return out
}

/**
 * The key codes of cell `cell` of the closed key `key`, its fields' codes in key order, read back as its readers index
 * it: a product's mixed radix, or a dependent sum's owner, the one whose block holds the cell by the bases and counts
 * its owner functions hold (`valuesOf`, each function's value at each owner index), then the block's mixed radix at
 * that owner's radices; none for a cell no block holds.
 */
const keyCodesAt = (
	key: ClosedKey,
	cell: bigint,
	valuesOf: (f: ConstantFunctions) => ReadonlyMap<bigint, bigint>
): ReadonlyArray<bigint> | undefined => {
	if (key.kind === "product") {
		return digitsOf(
			key.coordinates.map((c) => BigInt(c.radix)),
			cell
		)
	}
	const bases = valuesOf(key.bases)
	const counts = key.counts.map(valuesOf)
	const ownerRadices = key.owner.map((c) => BigInt(c.radix))
	const owners = ownerRadices.reduce((n, r) => n * r, 1n)
	for (let owner = 0n; owner < owners; owner += 1n) {
		const radices = key.block.map((b) =>
			b.kind === "codes" ? BigInt(b.radix) : (counts[b.count]?.get(owner) ?? 0n)
		)
		const block = radices.reduce((n, r) => n * r, 1n)
		const base = bases.get(owner) ?? 0n
		if (block > 0n && cell >= base && cell < base + block) {
			return [...digitsOf(ownerRadices, owner), ...digitsOf(radices, cell - base)]
		}
	}
	return undefined
}

/** The installation's literal packs, by their functions' printed names. */
const packsOf = (installation: Installation): ReadonlyMap<string, PackConstant> =>
	new Map(
		installation.statements.flatMap((s) =>
			s.kind === "packConstant" ? [[printObjectName(s.function), s] as const] : []
		)
	)

/**
 * Every constant the installation's names read, each with the declared closed relation whose own it is, where it is
 * one: each closed relation's, then its dependent key's owner functions, which no relation names.
 */
const namedConstants = (
	installation: Installation
): ReadonlyArray<{
	readonly functions: ConstantFunctions
	readonly relation: string | undefined
}> =>
	Object.values(installation.owned.relations).flatMap((r) => {
		const desc = r.desc
		if (desc.kind !== "closedRelation") {
			return []
		}
		const c = installation.names.closed(desc.name)
		const owners = c.key.kind === "product" ? [] : [c.key.bases, ...c.key.counts]
		return [
			{ functions: c.constant, relation: desc.name },
			...owners.map((functions) => ({ functions, relation: undefined }))
		]
	})

/**
 * The cell at which a planned pack and an edited literal of it part: a cells literal's first cell apart, or a payloads
 * literal's first position apart read as the cell its paired cells hold there, where a constant the installation's
 * names read pairs with it; none where none does.
 */
const cellApart = (
	installation: Installation,
	planned: PackConstant,
	expected: ReadonlyArray<bigint>,
	read: ReadonlyArray<bigint>
): bigint | undefined => {
	if (planned.layout.kind === "cells") {
		return firstCellApart(expected, read)
	}
	const position = firstPositionApart(expected, read)
	const fn = printObjectName(planned.function)
	const paired = namedConstants(installation).find(
		(c) =>
			c.functions.payloads.kind === "codes" && printObjectName(c.functions.payloads.function) === fn
	)
	const cells =
		paired === undefined
			? undefined
			: packsOf(installation).get(printObjectName(paired.functions.cells))
	const indexes = cells === undefined ? undefined : heldElements(cells)
	return position === undefined || indexes === undefined ? undefined : indexes[position]
}

/**
 * The declared closed relation one of whose arrays the installation installs as `fn`, and the handles of its key at
 * `cell`, each field's handle by the installation's codes, where a cell is given and a block holds it; none for a side's
 * or an owner function's array, which no relation names.
 */
const relationAt = (
	installation: Installation,
	fn: string,
	cell: bigint | undefined
): { readonly relation: string; readonly key: ReadonlyArray<string> | undefined } | undefined => {
	const packs = packsOf(installation)
	const valuesOf = (f: ConstantFunctions): ReadonlyMap<bigint, bigint> => {
		const cellsPack = packs.get(printObjectName(f.cells))
		const indexes = cellsPack === undefined ? [] : (heldElements(cellsPack) ?? [])
		const payloadsPack =
			f.payloads.kind === "codes" ? packs.get(printObjectName(f.payloads.function)) : undefined
		const payloads = payloadsPack === undefined ? undefined : heldElements(payloadsPack)
		return new Map(indexes.map((index, i) => [index, payloads?.[i] ?? 0n] as const))
	}
	for (const r of Object.values(installation.owned.relations)) {
		const desc = r.desc
		if (desc.kind !== "closedRelation") {
			continue
		}
		const c = installation.names.closed(desc.name)
		const own = [
			printObjectName(c.constant.cells),
			...(c.constant.payloads.kind === "codes"
				? [printObjectName(c.constant.payloads.function)]
				: [])
		]
		if (!own.includes(fn)) {
			continue
		}
		const codes = cell === undefined ? undefined : keyCodesAt(c.key, cell, valuesOf)
		/** A closed id's handle by the installation's codes; a fin slot's index, which no roster names. */
		const handleOf = (field: string, code: bigint): string => {
			const type = defined(desc.fields[field], "a closed relation declares each of its key fields")
			if (type.kind !== "closedId") {
				return String(code)
			}
			const codec = defined(
				[...installation.names.codes.rosters.values()].find((held) => held.roster === type.roster),
				"the codebook holds every roster"
			)
			return defined(codec.names[Number(code)], "a key code below its roster's size")
		}
		return {
			relation: desc.name,
			key:
				codes === undefined
					? undefined
					: desc.key.map((field, i) =>
							handleOf(field, defined(codes[i], "a code of each key field"))
						)
		}
	}
	return undefined
}

/**
 * A migration statement's literal pack held to its content (PackFault): none for a statement that is no literal pack,
 * or for one whose literal digests to its stated content and to its function's name and holds its stated rows. A
 * changed literal digests to another name than the one it creates, so it is refused, with the relation it packs and the
 * cell where it parts from the rows the installation's schema declares, where an installation is given and its schema
 * still plans that function.
 */
export const literalPackFault = (
	installation: Installation | undefined,
	statement: string
): PackFault | undefined => {
	if (!looksLikeLiteralPack(statement)) {
		return undefined
	}
	const pack = readLiteralPack(statement)
	if (pack === undefined) {
		return { kind: "form" }
	}
	const read = elementsOf(pack.text, pack.layout)
	if (!read.ok) {
		return { kind: "layout", function: pack.function, fault: read.error }
	}
	const digest = digestOf(read.value, pack.layout)
	const named = quoteIdent(identifierOf(identity.closedConstant(digest)))
	if (digest === pack.digest && pack.function.endsWith(`.${named}`)) {
		const held = BigInt(read.value.length)
		return held === pack.rows
			? undefined
			: { kind: "rows", function: pack.function, stated: pack.rows, held }
	}
	const planned = installation === undefined ? undefined : packsOf(installation).get(pack.function)
	const expected = planned === undefined ? undefined : heldElements(planned)
	const cell =
		installation === undefined || planned === undefined || expected === undefined
			? undefined
			: cellApart(installation, planned, expected, read.value)
	const at = installation === undefined ? undefined : relationAt(installation, pack.function, cell)
	return {
		kind: "content",
		function: pack.function,
		relation: at?.relation,
		differs: cell === undefined ? undefined : { cell, key: at?.key }
	}
}
