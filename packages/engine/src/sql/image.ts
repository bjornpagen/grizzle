import { mapNonEmpty } from "@bjornpagen/grizzle-text/base/nonempty"
import {
	type Expr,
	type FromItem,
	type FromSource,
	type JoinStep,
	nameKey,
	type NameKey,
	type ObjectName,
	type OperandBody,
	type OperandSelect,
	type Select,
	type SelectCore
} from "#compiler/sql/ast.ts"
import { and, call, eq } from "#compiler/sql/build.ts"
import { printExpr } from "#compiler/sql/print.ts"
import { identityHooks, Transform } from "#compiler/sql/transform.ts"

/** A stored column as a statement reads it: by the table or view it is a column of, and its name there. */
export interface StoredColumn {
	readonly table: ObjectName
	readonly column: string
}

/**
 * The stored columns a lookup index holds by their image (`imageOf`) in place of the text: each text column of no byte
 * bound (schema/representability.ts imagedText), by the table or plain view a statement reads it through.
 */
export interface ImagedColumns {
	readonly has: (column: StoredColumn) => boolean
	/** The imaged columns of a table or view, by name. */
	readonly of: (table: ObjectName) => ReadonlyArray<string>
}

/**
 * The image of a text a lookup index holds in its place: `pg_catalog.md5(text)`, its 32 hexadecimal digits, IMMUTABLE
 * and LEAKPROOF, which every B-tree entry holds, where a text whose pattern proves no byte bound fits none
 * (schema/representability.ts imagedText). A lookup reads it as a point lookup: every statement grizzle writes that
 * compares such a column by equality states the equality of the two sides' images beside it (`statingImages`), which
 * PostgreSQL matches to the index's expression and reads as an index condition, and the column's own equality rechecks
 * the rows the image finds, so a collision of two texts' digests reads one row more and decides nothing: an image, never
 * a proof.
 *
 * md5 is the one function of a text PostgreSQL marks leakproof (pg_proc.proleakproof) whose value an index entry holds
 * whatever the text: hashtext, hashtextextended, textsend and convert_to are not, and sha256 reads only bytea, which no
 * leakproof cast reaches. Only a leakproof condition passes into a security-barrier view (a role's query entry, through
 * which a role reads rows it may see), so with any other the lookup through such a view reads every row of the image's
 * other columns. A server in FIPS mode refuses md5, and with it every write of a table such an index is on.
 *
 * Its equality agrees with the text's: every text grizzle stores is collated pg_catalog.pg_c_utf8, which is
 * deterministic, so texteq compares a text's bytes, of which md5 is a function; its digits are ASCII, which every
 * deterministic collation compares alike. The index's expression reads the column under its own collation, which a
 * probe's image of that column reads too, so PostgreSQL's match of the probe to the index, which compares the
 * expressions with their collations (indxpath.c match_index_to_operand), holds.
 */
export const imageOf = (text: Expr): Expr => call("md5", [text])

/** The column an expression reads first, through the first argument of each call around it, when it reads one. */
const firstColumn = (e: Expr): Expr | undefined => {
	if (e.kind === "column") {
		return e
	}
	const [first] = e.kind === "call" ? e.args : []
	return first === undefined ? undefined : firstColumn(first)
}

/**
 * The column of the table an index is on whose image an index key's expression is, when it is one: an expression that
 * prints as the image of the unqualified column it reads (`imageOf`).
 */
export const imagedColumnOf = (e: Expr): string | undefined => {
	const text = firstColumn(e)
	return text?.kind === "column" &&
		text.table === undefined &&
		printExpr(e) === printExpr(imageOf(text))
		? text.column
		: undefined
}

/** The imaged columns `columns`, each a text column of no byte bound by the table or plain view it is read through. */
export const imagedColumns = (columns: Iterable<StoredColumn>): ImagedColumns => {
	const byTable = new Map<NameKey, Set<string>>()
	for (const c of columns) {
		const key = nameKey(c.table)
		const held = byTable.get(key) ?? new Set<string>()
		held.add(c.column)
		byTable.set(key, held)
	}
	return {
		has: (c) => byTable.get(nameKey(c.table))?.has(c.column) === true,
		of: (table) => [...(byTable.get(nameKey(table)) ?? [])]
	}
}

/**
 * The stored column a column reference of a core reads, through the core's FROM: a table's column, or a derived table's
 * column whose query delivers it from a stored column, a plain core's target or a query's that reads one, under no
 * WITH; none for any other source, a CTE's, a function's or an input's, which an index of a table never serves.
 */
const originIn = (from: ReadonlyArray<FromItem>, ref: Expr): StoredColumn | undefined => {
	if (ref.kind !== "column" || ref.table === undefined) {
		return undefined
	}
	const alias = ref.table
	const source = sourcesOf(from).find((s) => sourceAlias(s) === alias)
	if (source === undefined) {
		return undefined
	}
	switch (source.kind) {
		case "table":
			return typeof source.table === "string"
				? undefined
				: { table: source.table, column: ref.column }
		case "derived": {
			const at = source.columns.indexOf(ref.column)
			return at < 0 ? undefined : deliveredAt(source.query, at)
		}
		case "probe":
		case "met":
		case "metRows":
		case "cte":
		case "transition":
		case "enclosing":
		case "function":
		case "arrays":
		case "values":
		case "context":
			return undefined
	}
}

/** The stored column a query delivers as its column `at`, when it delivers one (`originIn`). */
const deliveredAt = (query: OperandSelect, at: number): StoredColumn | undefined =>
	query.with === undefined ? bodyAt(query.body, at) : undefined

const bodyAt = (body: OperandBody, at: number): StoredColumn | undefined => {
	switch (body.kind) {
		case "core": {
			const target = body.targets[at]
			return target === undefined ? undefined : originIn(body.from, target.expr)
		}
		case "select":
			return deliveredAt(body, at)
		case "setOp":
			return undefined
	}
}

/** Every source of a FROM, a join chain's each. */
const sourcesOf = (from: ReadonlyArray<FromItem>): ReadonlyArray<FromSource> =>
	from.flatMap((item): ReadonlyArray<FromSource> =>
		item.kind === "joins" ? [item.first, ...item.steps.map((s) => s.source)] : [item]
	)

/** The name a source's columns are qualified by: its alias, or a CTE's own name where it has none. */
const sourceAlias = (source: FromSource): string =>
	source.kind === "cte" ? (source.alias ?? source.name) : source.alias

/**
 * A conjunction with the equality of the images beside each conjunct that compares an imaged column of `from` by
 * equality, right after it: `a = b AND image(a) = image(b)` holds exactly where `a = b` does, NULL where it is NULL,
 * since equal texts have one image (`imageOf`) and the image of NULL is NULL.
 */
const imagedConjunction = (e: Expr, from: ReadonlyArray<FromItem>, imaged: ImagedColumns): Expr => {
	const conjuncts = e.kind === "and" ? e.args : [e]
	const reads = (side: Expr): boolean => {
		const origin = originIn(from, side)
		return origin !== undefined && imaged.has(origin)
	}
	const [first, ...rest] = conjuncts.flatMap((c): ReadonlyArray<Expr> =>
		c.kind === "binary" &&
		c.op === "=" &&
		c.schema === undefined &&
		(reads(c.left) || reads(c.right))
			? [c, eq(imageOf(c.left), imageOf(c.right))]
			: [c]
	)
	return first === undefined || rest.length + 1 === conjuncts.length ? e : and([first, ...rest])
}

/** A core whose WHERE and join conditions each state its imaged columns' equalities of images (`imagedConjunction`). */
const imagedCore = (core: SelectCore, imaged: ImagedColumns): SelectCore => {
	const where =
		core.where === undefined ? undefined : imagedConjunction(core.where, core.from, imaged)
	const from = core.from.map((item): FromItem => {
		if (item.kind !== "joins") {
			return item
		}
		const steps = mapNonEmpty(item.steps, (s): JoinStep => {
			switch (s.kind) {
				case "on":
				case "left": {
					const on = imagedConjunction(s.on, core.from, imaged)
					return on === s.on ? s : { ...s, on }
				}
				case "cross":
					return s
			}
		})
		return steps.every((s, i) => s === item.steps[i]) ? item : { ...item, steps }
	})
	return where === core.where && from.every((item, i) => item === core.from[i])
		? core
		: { ...core, where, from }
}

/**
 * A query whose every core states, beside each equality that compares one of `imaged`, a column a lookup index holds
 * by its image, the equality of the two sides' images (`imageOf`), so PostgreSQL reads the lookup through that index as
 * a point lookup. A query that compares none is the query itself.
 */
export const statingImages = (query: Select, imaged: ImagedColumns): Select =>
	new Transform({ ...identityHooks, core: (core) => imagedCore(core, imaged) }).setQuery(query)
