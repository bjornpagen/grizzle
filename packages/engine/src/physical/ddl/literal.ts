import { identifierOf, identity } from "#compiler/core/identity.ts"
import { defined } from "#compiler/core/invariant.ts"
import {
	constantDigestOf,
	constantOfLiteral,
	type Entry,
	type LiteralFault
} from "#compiler/ir/cells.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"
import type { PackConstant } from "#compiler/sql/ast.ts"
import type { ClosedKey } from "#compiler/sql/constants.ts"
import {
	looksLikeLiteralPack,
	printObjectName,
	quoteIdent,
	readLiteralPack
} from "#compiler/sql/print.ts"

/**
 * What `grizzle check` holds a migration's closed constant to (sql/print.ts writePack), its one reader of them: a
 * constant's hex literal is trusted only when it decodes to the content its comment states and its function's name
 * digests, and holds the rows its comment counts.
 *
 * - `form`: a statement that begins as a literal pack's comment does but departs from the printed form;
 * - `layout`: a literal with a character no hex digit, of other than the whole digits its stated cells times width
 *   take, or with a 1 among the bits that pad it past its last cell;
 * - `content`: a literal whose cells digest neither to the content its comment states nor to its function's name,
 *   edited after it was drafted, or a comment or name edited away from it: the function it creates, the closed
 *   relation whose constant it is where the schema declares one, and the first cell where it and the schema's declared
 *   rows part, with the key's handles there, where the schema still plans the function;
 * - `rows`: a comment whose row count is not the cells its literal holds, one per row.
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

/** The cells a pack fills: each held cell's index and payload code, in index order; none for a literal off its layout. */
const heldCells = (pack: PackConstant): ReadonlyArray<Entry> | undefined => {
	const read = constantOfLiteral(pack.hex, pack.cells, pack.width)
	return read.ok ? read.value.entries : undefined
}

/**
 * The first cell where two lists of held cells, each in index order, part: one holds it and the other does not, or
 * holds another payload there; none where they agree.
 */
const firstDifference = (a: ReadonlyArray<Entry>, b: ReadonlyArray<Entry>): bigint | undefined => {
	for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
		const x = a[i]
		const y = b[i]
		if (x === undefined || y === undefined) {
			return (x ?? y)?.index
		}
		if (x.index !== y.index) {
			return x.index < y.index ? x.index : y.index
		}
		if (x.payload !== y.payload) {
			return x.index
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
	valuesOf: (fn: string) => ReadonlyMap<bigint, bigint>
): ReadonlyArray<bigint> | undefined => {
	if (key.kind === "product") {
		return digitsOf(
			key.coordinates.map((c) => BigInt(c.radix)),
			cell
		)
	}
	const bases = valuesOf(printObjectName(key.bases.function))
	const counts = key.counts.map((c) => valuesOf(printObjectName(c.function)))
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

/**
 * The declared closed relation whose own constant the installation installs as `fn`, and the handles of its key at
 * `cell`, each field's handle by the installation's codes, where a cell is given and a block holds it; none for a
 * side's constant, which no relation names.
 */
const relationAt = (
	installation: Installation,
	fn: string,
	cell: bigint | undefined
): { readonly relation: string; readonly key: ReadonlyArray<string> | undefined } | undefined => {
	const packs = new Map(
		installation.statements.flatMap((s) =>
			s.kind === "packConstant" ? [[printObjectName(s.function), s] as const] : []
		)
	)
	const valuesOf = (name: string): ReadonlyMap<bigint, bigint> => {
		const pack = packs.get(name)
		const cells = pack === undefined ? [] : (heldCells(pack) ?? [])
		return new Map(cells.map((e) => [e.index, e.payload] as const))
	}
	for (const r of Object.values(installation.owned.relations)) {
		const desc = r.desc
		if (desc.kind !== "closedRelation") {
			continue
		}
		const c = installation.names.closed(desc.name)
		if (printObjectName(c.function) !== fn && printObjectName(c.keys) !== fn) {
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
	const read = constantOfLiteral(pack.hex, pack.cells, Number(pack.width))
	if (!read.ok) {
		return { kind: "layout", function: pack.function, fault: read.error }
	}
	const digest = constantDigestOf(read.value)
	const named = quoteIdent(identifierOf(identity.closedConstant(digest)))
	if (digest === pack.digest && pack.function.endsWith(`.${named}`)) {
		const held = BigInt(read.value.entries.length)
		return held === pack.rows
			? undefined
			: { kind: "rows", function: pack.function, stated: pack.rows, held }
	}
	const planned = (installation?.statements ?? []).flatMap((s) =>
		s.kind === "packConstant" && printObjectName(s.function) === pack.function ? [s] : []
	)[0]
	const expected = planned === undefined ? undefined : heldCells(planned)
	const cell = expected === undefined ? undefined : firstDifference(expected, read.value.entries)
	const at = installation === undefined ? undefined : relationAt(installation, pack.function, cell)
	return {
		kind: "content",
		function: pack.function,
		relation: at?.relation,
		differs: cell === undefined ? undefined : { cell, key: at?.key }
	}
}
