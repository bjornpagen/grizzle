import { maxOf } from "#compiler/core/array.ts"
import { isNonEmpty, mapNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import type { PlainQuery } from "#compiler/lower/delivery.ts"
import type {
	ArraysSource,
	Expr,
	Select,
	SelectBody,
	SetCore,
	ValuePlaceholder
} from "#compiler/sql/ast.ts"
import {
	call,
	cast,
	col,
	cteRef,
	lit,
	provedCore,
	target,
	targetAs,
	types,
	unionAll,
	windowOf
} from "#compiler/sql/build.ts"
import type { NameSupply } from "#compiler/sql/naming.ts"
import { identityHooks, transformSelect } from "#compiler/sql/transform.ts"

/**
 * One part of a statement whose rows are several relations' rows, each behind its tag, as the host reads it: `rows`,
 * its rows as its own query sends them, their first `width` cells after the tag; or `numbered`, an ordered query's, the
 * cell after those its row number in its query's order, by which the host puts its rows back in that order, since no
 * arm of a UNION ALL orders its rows. The host reads a part's cells by position, never by name.
 */
export interface TaggedPart {
	readonly kind: "rows" | "numbered"
	readonly width: number
}

/**
 * How the host divides a statement's rows into its parts: all of them its one part's, or each part's behind its tag,
 * the part's position (TaggedPart).
 */
export type PartDivision =
	| { readonly kind: "one" }
	| { readonly kind: "tagged"; readonly parts: NonEmptyReadonlyArray<TaggedPart> }

/** A part's query as the CTE it is inside its statement, the CTE's columns, and how the host reads its rows. */
export interface PartQuery {
	readonly query: PlainQuery
	readonly columns: ReadonlyArray<string>
	readonly shape: TaggedPart
}

/**
 * The executable query `executable` (lower/template.ts executableQueryFrom) as one part of a statement of tagged parts,
 * its names drawn from `supply`: each of its outermost targets named a generated column, since inside the statement
 * the query is a CTE's, whose columns the CTE names, and only a statement's outermost output carries public names;
 * and, for one that orders its rows, each row's number in that order after its cells, which keeps its own ORDER BY and
 * LIMIT.
 */
export const partQuery = (executable: PlainQuery, supply: NameSupply): PartQuery => {
	const named = executable.body.targets.map((t) => ({
		expr: t.expr,
		column: supply.column({ kind: "internal", purpose: "part column" })
	}))
	const query: PlainQuery = {
		...executable,
		body: { ...executable.body, targets: named.map((t) => targetAs(t.expr, t.column)) }
	}
	const columns = named.map((t) => t.column)
	const width = columns.length
	if (!isNonEmpty(query.orderBy)) {
		return { query, columns, shape: { kind: "rows", width } }
	}
	const number = supply.column({ kind: "internal", purpose: "part row number" })
	return {
		query: {
			...query,
			body: {
				...query.body,
				targets: [
					...query.body.targets,
					targetAs(
						cast({ ...call("row_number", []), over: windowOf([], query.orderBy) }, types.text),
						number
					)
				]
			}
		},
		columns: [...columns, number],
		shape: { kind: "numbered", width }
	}
}

/**
 * The output name of a statement of tagged parts' tag column, and the prefix of each cell column's after it, which no
 * reader reads by name: the host reads a part's cells by position.
 *
 * @formatConstant the descriptive heading of a statement of tagged parts
 */
export const partTagColumn = "__part"

/** @formatConstant the descriptive heading of a statement of tagged parts */
export const partCellColumn = "__cell"

/** One part's rows as its statement's CTE holds them: the CTE's name and its columns, in order. */
export interface PartRows {
	readonly name: string
	readonly columns: ReadonlyArray<string>
}

/**
 * The body of a statement of tagged parts, and the cells every row carries after its tag: each part's rows behind its
 * tag, the text of the part's index from `first` on, padded with empty texts to the widest part's columns. Every
 * column is a text, the tag's too, so a statement of tagged parts is itself a part's rows when it rides another
 * statement as one of its parts (write/program/single.ts), its tag one of that part's cells.
 *
 *   SELECT '0'::text, "r50"."c100", "r50"."c101", ''::text FROM "r50"
 *   UNION ALL SELECT '1'::text, "r60"."c110", "r60"."c111", "r60"."c112" FROM "r60"
 */
export const taggedParts = (
	parts: NonEmptyReadonlyArray<PartRows>,
	first: number
): { readonly body: SelectBody; readonly width: number } => {
	const width = maxOf(
		parts.map((p) => p.columns.length),
		0
	)
	const arms = mapNonEmpty(parts, (p, at): SetCore => {
		const padding: ReadonlyArray<Expr> = Array.from({ length: width - p.columns.length }, () =>
			lit.text("", types.text)
		)
		return provedCore(
			"keyed",
			[
				target(lit.text(String(first + at), types.text)),
				...p.columns.map((c) => target(col(p.name, c))),
				...padding.map((e) => target(e))
			],
			[cteRef(p.name)],
			undefined
		)
	})
	return { body: unionAll("disjoint", arms), width }
}

/** `slot` numbered `offset` later. */
const moved = <P extends ValuePlaceholder>(slot: P, offset: number): P =>
	offset === 0 ? slot : { ...slot, number: slot.number + offset }

/** A relation input's arrays with each placeholder numbered `offset` later. */
const movedArrays = (source: ArraysSource, offset: number): ArraysSource =>
	source.kind === "count"
		? { kind: "count", count: moved(source.count, offset) }
		: {
				kind: "columns",
				columns: mapNonEmpty(source.columns, (c) => ({ ...c, array: moved(c.array, offset) })),
				ordinal: source.ordinal
			}

/**
 * A part's query and slots with each placeholder $n renumbered $n + offset: a part's placeholders number from $1, and
 * a statement of several parts numbers each part's past the earlier parts' (write/program/single.ts,
 * shapes/index.ts partedConservative).
 */
export const shiftedPart = <Slot extends ValuePlaceholder>(
	query: Select,
	params: ReadonlyArray<Slot>,
	offset: number
): { readonly query: Select; readonly params: ReadonlyArray<Slot> } =>
	offset === 0
		? { query, params }
		: {
				query: transformSelect(query, {
					...identityHooks,
					replaceSource: (item) =>
						item.kind === "arrays"
							? { ...item, source: movedArrays(item.source, offset) }
							: undefined,
					expr: (e) => (e.kind === "param" ? { ...e, slot: moved(e.slot, offset) } : e)
				}),
				params: params.map((slot) => moved(slot, offset))
			}
