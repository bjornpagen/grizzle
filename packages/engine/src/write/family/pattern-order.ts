import { defect } from "#compiler/core/invariant.ts"
import { mapNonEmpty, type NonEmptyReadonlyArray, sortNonEmpty } from "#compiler/core/nonempty.ts"
import { compareCodePoints } from "#compiler/core/text.ts"
import type { ScalarExpr } from "#compiler/ir/expr.ts"
import type { RelationInfo } from "#compiler/ir/law.ts"
import type { NamedNative } from "#compiler/laws/model/model.ts"
import type { MemberCell } from "#compiler/runtime/write/draw.ts"
import type { RowLayout } from "#compiler/write/family/statements.ts"

/**
 * The fields of `relation` whose values decide a pattern a row is matched against: those a match's pattern operand
 * reads in one of its row CHECKs or generated fields, through the generated fields it reads. A match against a fixed
 * pattern reads none.
 */
const patternFields = (
	relation: RelationInfo,
	natives: ReadonlyArray<NamedNative>
): ReadonlySet<string> => {
	const fields = new Set<string>()
	const generated = new Map(
		relation.fields.flatMap((f) =>
			f.writing.kind === "generated" ? [[f.name, f.writing.expr] as const] : []
		)
	)
	const reads = (e: ScalarExpr, through: ReadonlySet<string>): void => {
		if (e.kind === "column") {
			const expr = generated.get(e.column.name)
			if (expr === undefined) {
				fields.add(e.column.name)
			} else if (!through.has(e.column.name)) {
				reads(expr, new Set([...through, e.column.name]))
			}
		}
		for (const a of e.args) {
			reads(a, through)
		}
	}
	const matches = (e: ScalarExpr): void => {
		if (e.kind === "op" && "patterns" in e) {
			for (const pattern of e.args.slice(1)) {
				reads(pattern, new Set())
			}
		}
		for (const a of e.args) {
			matches(a)
		}
	}
	for (const n of natives) {
		if (
			n.namespace === "constraint" &&
			n.object.kind === "TableCheck" &&
			n.object.relation.name === relation.name
		) {
			matches(n.object.predicate)
		}
	}
	for (const expr of generated.values()) {
		matches(expr)
	}
	return fields
}

/**
 * The positions in a row's texts (draw.ts rowTexts) of the fields that decide its patterns (`patternFields`), in
 * layout order: none for a relation whose every match reads a fixed pattern.
 */
export const patternPositions = (
	relation: RelationInfo,
	natives: ReadonlyArray<NamedNative>,
	layout: RowLayout
): ReadonlySet<number> => {
	const fields = patternFields(relation, natives)
	return new Set(
		[...layout.key, ...layout.columns].flatMap((c, i) =>
			c.column.kind === "field" && fields.has(c.column.field.name) ? [i] : []
		)
	)
}

/**
 * A pattern input's cell as its text. The one site of the fact that a field a pattern reads is a text's: no pattern
 * reads a bytes field, whose value alone travels as no text, so a bytes value here is a defect.
 */
const patternText = (cell: string | MemberCell): string => {
	if (typeof cell !== "string") {
		throw defect("a field a pattern reads is a text")
	}
	return cell
}

/** Texts in lexicographic order, each by code point, a text before every longer one it begins. */
const lexicographic = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): number => {
	for (const [i, x] of a.entries()) {
		const y = b[i]
		if (y === undefined) {
			return 1
		}
		const order = compareCodePoints(x, y)
		if (order !== 0) {
			return order
		}
	}
	return a.length < b.length ? -1 : 0
}

/**
 * A statement's rows ordered by their pattern input, their texts (`textsOf`) at `positions`, ties kept in the order
 * they came: rows of one pattern are consecutive, so PostgreSQL compiles each pattern once per statement however many
 * patterns there are, where rows cycling through more patterns than its cache of compiled ones holds would compile one
 * per row.
 */
export const byPatternInput = <R>(
	rows: NonEmptyReadonlyArray<R>,
	textsOf: (row: R) => ReadonlyArray<string | MemberCell>,
	positions: ReadonlySet<number>
): NonEmptyReadonlyArray<R> => {
	if (positions.size === 0) {
		return rows
	}
	const inputOf = (row: R): ReadonlyArray<string> =>
		textsOf(row).flatMap((cell, i) => (positions.has(i) ? [patternText(cell)] : []))
	const keyed = mapNonEmpty(rows, (row) => ({ row, input: inputOf(row) }))
	return mapNonEmpty(
		sortNonEmpty(keyed, (x, y) => lexicographic(x.input, y.input)),
		(k) => k.row
	)
}
