/** What the property of judge-sources.test.ts reads: its space, its schemas and the judge's scans. */

import { assert } from "@bjornpagen/testing/assert"
import { boolean, element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, Option, String as Str } from "effect"
import {
	compileInstallation,
	type Installation,
	installOptions
} from "#compiler/physical/install/compile.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import {
	check,
	contained,
	derived,
	key,
	mutable,
	on,
	relation,
	schema,
	unit
} from "#compiler/public/schema.ts"
import {
	cteColumns,
	type FromItem,
	type FromSource,
	functionColumnNames,
	type OperandSelect,
	selectColumns
} from "#compiler/sql/ast.ts"
import { inertVisitor, visitSelect } from "#compiler/sql/transform.ts"
import { succeeded } from "#test/support/assert.ts"
import { judgedStatementsOf } from "#test/support/judge.ts"
import { owning } from "#test/support/policy.ts"

/** A rule's law over D: a containment of S into it, a check over its facts, or a key over a projection of them. */
type Law = "contained" | "check" | "key"

/**
 * One case: its law; whether D's arm selects T by a literal of `a`; and its judge: whole, T and S immutable, so the
 * rule is unit-local, or probed, both mutable in their document's unit and D's arm joining W, mutable in a unit of its
 * own, so the rule reads two units.
 */
interface Shape {
	readonly law: Law
	readonly selected: boolean
	readonly judge: "whole" | "probed"
}

export const shapeGen: Gen<Shape> = (s) => ({
	law: s.draw(element<Law>(["contained", "check", "key"])),
	selected: s.draw(boolean),
	judge: s.draw(element<Shape["judge"]>(["whole", "probed"]))
})

export type Reached =
	| "a whole rule's statement"
	| "a probe's statement"
	| "a stored scan narrowed"
	| "a delta narrowed"

/**
 * T and S, each keyed by its document first, and each with a field no rule reads, `pay` and `note`; D, T's facts by
 * document and place with their `b`, selected by `a` where the shape selects, `a` an unread witness elsewhere, at a
 * document W holds where the shape is probed. The rule
 * judges D: S's references among its `b`s by document, which no key of T holds, so the judge holds it and no foreign key
 * does, its `b` at least 0, or its `b` once per document.
 */
const schemaOf = (shape: Shape) => {
	const T = relation(
		"T",
		{ doc: pg.integer, at: pg.integer, a: pg.integer, b: pg.integer, pay: pg.integer },
		["doc", "at"]
	)
	const S = relation("S", { doc: pg.integer, at: pg.integer, ref: pg.integer, note: pg.integer }, [
		"doc",
		"at"
	])
	const W = relation("W", { wdoc: pg.integer }, ["wdoc"])
	const probed = shape.judge === "probed"
	const Base = schema(
		"judge_sources",
		[T, S, W],
		probed
			? [
					unit("Document", { doc: pg.integer }),
					unit("Ws", { wdoc: pg.integer }),
					mutable(T),
					mutable(S),
					mutable(W)
				]
			: []
	)
	const D = derived(
		"D",
		query(Base).rule((r) => {
			const { doc, at, a, b } = v(T, "t")
			const matched = r.match(T, { doc, at, a: shape.selected ? 1 : a, b })
			return probed
				? matched.match(W, { wdoc: doc }).find({ doc, at, b })
				: matched.find({ doc, at, b })
		})
	)
	const law = (() => {
		switch (shape.law) {
			case "contained":
				return contained(on(S, "doc", "ref"), on(D, "doc", "b"))
			case "check":
				return check("Positive", D, (d) => d.ge(d.b, 0))
			case "key":
				return key(on(D, "doc", "b"))
		}
	})()
	return schema.extend([Base], "judge_sources_1", [D], [law])
}

/** The tables of the schema, by their names as installed. */
const tables = ["t", "s", "w"] as const
type Table = (typeof tables)[number]

/** What each table declares: its width, every field, and its primary key's columns, which a stored scan keeps. */
const declared: {
	readonly [K in Table]: { readonly width: number; readonly key: ReadonlySet<string> }
} = {
	t: { width: 5, key: new Set(["doc", "at"]) },
	s: { width: 4, key: new Set(["doc", "at"]) },
	w: { width: 1, key: new Set(["wdoc"]) }
}

/**
 * The fields the shape's rule binds of each table, its key's among them: of T every field D's arm matches, its
 * document, place, `a` and `b`; of S, which a containment alone reads, its document, place and reference; of W, which
 * a probed shape's arm alone reads, its key. Never `pay` or `note`.
 */
const readFields = (shape: Shape): { readonly [K in Table]: ReadonlySet<string> } => ({
	t: new Set(["doc", "at", "a", "b"]),
	s: new Set(shape.law === "contained" ? ["doc", "at", "ref"] : []),
	w: new Set(shape.judge === "probed" ? ["wdoc"] : [])
})

const tableNamed = (name: string): Table | undefined =>
	Option.getOrUndefined(Arr.findFirst(tables, (t) => t === name))

/** A table a scan reads: a stored table of the installation, or a session's delta of one. */
interface Scanned {
	readonly kind: "stored" | "delta"
	readonly table: Table
}

/** The prefixes of a session's delta's table, one per side, before its relation's name and its digest. */
const deltaPrefixes = ["__delta_news_", "__delta_olds_"] as const

/** The relation a session's delta holds a side of, by its CTE's name: what lies between its prefix and its digest. */
const deltaOf = (name: string): Table | undefined => {
	const prefix = Option.getOrUndefined(Arr.findFirst(deltaPrefixes, (p) => Str.startsWith(p)(name)))
	if (prefix === undefined) {
		return undefined
	}
	const rest = Str.slice(prefix.length)(name)
	return Option.getOrUndefined(
		Option.flatMap(Str.lastIndexOf("_")(rest), (end) =>
			Option.fromUndefinedOr(tableNamed(Str.slice(0, end)(rest)))
		)
	)
}

/** A delta's reader (physical/ddl/rules.ts readers): the delta it reads, and the columns it returns, in order. */
interface Reader {
	readonly delta: string
	readonly columns: ReadonlyArray<string>
}

/** Each delta's reader in `installation`, by its function's name: a PL/pgSQL function whose one statement returns the
 * columns of one table of pg_temp, the delta. */
const readersIn = (installation: Installation): ReadonlyMap<string, Reader> =>
	new Map(
		Arr.flatMap(installation.statements, (s): ReadonlyArray<readonly [string, Reader]> => {
			if (s.kind !== "createFunction" || s.language !== "plpgsql") {
				return []
			}
			const [only, ...rest] = s.body.body
			if (only.kind !== "returnQuery" || rest.length > 0 || only.query.body.kind !== "core") {
				return []
			}
			const [from, ...more] = only.query.body.from
			if (from?.kind !== "table" || typeof from.table === "string" || more.length > 0) {
				return []
			}
			const columns = Arr.flatMap(only.query.body.targets, (t) =>
				t.expr.kind === "column" ? [t.expr.column] : []
			)
			return [[s.name.name, { delta: from.table.name, columns }]]
		})
	)

/** A read of a delta's reader a judged statement holds (physical/ddl/deltas.ts headed): the call where the statement
 * reads it once, or the CTE over the call it reads twice or more through; the delta's table, and each of the read's
 * columns' column of the delta. */
interface Head {
	readonly table: Table
	readonly columnOf: ReadonlyMap<string, string>
}

/** `source` as a call of a delta's reader (`Head`), none where it calls none. */
const calledHead = (
	source: FromSource | undefined,
	columns: ReadonlyArray<string>,
	readers: ReadonlyMap<string, Reader>
): Head | undefined => {
	const reader =
		source?.kind === "function" && source.call.fn.kind === "qualified"
			? readers.get(source.call.fn.name)
			: undefined
	const table = reader === undefined ? undefined : deltaOf(reader.delta)
	return reader === undefined || table === undefined
		? undefined
		: {
				table,
				columnOf: new Map(
					Arr.flatMap(columns, (c, at) => {
						const column = reader.columns[at]
						return column === undefined ? [] : [[c, column] as const]
					})
				)
			}
}

/** Each CTE of `statement` that reads a delta's reader, by its name (`Head`). */
const headsOf = (
	statement: OperandSelect,
	readers: ReadonlyMap<string, Reader>
): ReadonlyMap<string, Head> => {
	const heads = new Map<string, Head>()
	visitSelect(statement, {
		...inertVisitor,
		with: (w) => {
			for (const cte of w.ctes) {
				const body = cte.query
				if (body.kind !== "select" || body.body.kind !== "core") {
					continue
				}
				const [from] = body.body.from
				const head = from?.kind === "joins" ? undefined : calledHead(from, cteColumns(cte), readers)
				if (head !== undefined) {
					heads.set(cte.name, head)
				}
			}
		}
	})
	return heads
}

/**
 * The table a FROM source reads, where it reads one of the installation's, or a session's delta of one, which a judged
 * statement reads through a call of its reader or a CTE over one (`heads`).
 */
const scannedBy = (
	source: FromSource,
	heads: ReadonlyMap<string, Head>,
	readers: ReadonlyMap<string, Reader>
): Scanned | undefined => {
	if (source.kind === "cte") {
		const head = heads.get(source.name)
		return head === undefined ? undefined : { kind: "delta", table: head.table }
	}
	if (source.kind === "function") {
		const head = calledHead(source, functionColumnNames(source.columns), readers)
		return head === undefined ? undefined : { kind: "delta", table: head.table }
	}
	if (source.kind !== "table" || typeof source.table === "string") {
		return undefined
	}
	const { schema: holder, name } = source.table
	const table = tableNamed(name)
	return table !== undefined && Str.startsWith("judge_sources")(holder)
		? { kind: "stored", table }
		: undefined
}

/** One column a scan reads of its table, and the output of its derived table that delivers it. */
interface ScanColumn {
	readonly read: string
	readonly output: string
}

/**
 * A scan of a table: a derived table whose query reads that table alone, each of its targets a column of it; its alias
 * and its columns.
 */
interface Scan {
	readonly scanned: Scanned
	readonly alias: string
	readonly columns: ReadonlyArray<ScanColumn>
}

/** Each scan of a table in `statement`, at any depth, each column a delta's CTE delivers read as the delta's own. */
const scansOf = (
	statement: OperandSelect,
	heads: ReadonlyMap<string, Head>,
	readers: ReadonlyMap<string, Reader>
): ReadonlyArray<Scan> => {
	const scans: Array<Scan> = []
	const source = (item: FromSource): void => {
		if (item.kind !== "derived" || item.query.body.kind !== "core") {
			return
		}
		const [from, ...more] = item.query.body.from
		if (
			from === undefined ||
			more.length > 0 ||
			(from.kind !== "table" && from.kind !== "cte" && from.kind !== "function")
		) {
			return
		}
		const scanned = scannedBy(from, heads, readers)
		if (scanned === undefined) {
			return
		}
		const alias = from.kind === "cte" ? (from.alias ?? from.name) : from.alias
		const columnOf =
			from.kind === "cte"
				? heads.get(from.name)?.columnOf
				: from.kind === "function"
					? calledHead(from, functionColumnNames(from.columns), readers)?.columnOf
					: undefined
		const outputs = selectColumns(item.query)
		const columns = Arr.flatMap(item.query.body.targets, (t, i) => {
			const output = outputs[i]
			const read =
				t.expr.kind !== "column"
					? undefined
					: columnOf === undefined
						? t.expr.column
						: columnOf.get(t.expr.column)
			return output !== undefined &&
				read !== undefined &&
				t.expr.kind === "column" &&
				t.expr.table === alias
				? [{ read, output }]
				: []
		})
		assert.equal(
			columns.length,
			outputs.length,
			`the scan ${item.alias} reads columns of its table alone`
		)
		scans.push({ scanned, alias: item.alias, columns })
	}
	const item = (i: FromItem): void => {
		if (i.kind === "joins") {
			source(i.first)
			for (const step of i.steps) {
				source(step.source)
			}
			return
		}
		source(i)
	}
	visitSelect(statement, { ...inertVisitor, fromItem: item })
	return scans
}

/** Every column reference of `statement`, as `<alias>.<column>`. */
const referencesOf = (statement: OperandSelect): ReadonlySet<string> => {
	const out = new Set<string>()
	visitSelect(statement, {
		...inertVisitor,
		expr: (e) => {
			if (e.kind === "column" && e.table !== undefined) {
				out.add(`${e.table}.${e.column}`)
			}
		}
	})
	return out
}

/**
 * Judges the scans of each statement of the judge of `shape`'s installation, the judge's and its parts', where its rules
 * stand (support/judge.ts judgedStatementsOf): each reads only fields its rule binds of its relation (`readFields`), and
 * delivers each column it reads to some reference of the statement but a stored table's key, which its scan keeps.
 */
export const judged = (shape: Shape, note: (r: Reached) => void): void => {
	const owned = owning(schemaOf(shape))
	const installation = succeeded(compileInstallation(owned, installOptions(owned)))
	const read = readFields(shape)
	const readers = readersIn(installation)
	for (const [name, reader] of readers) {
		const table = deltaOf(reader.delta)
		for (const column of table === undefined ? [] : reader.columns) {
			assert.ok(
				table !== undefined && read[table].has(column),
				`the reader ${name} returns ${column} of ${table ?? reader.delta}'s delta, a field its rule binds`
			)
		}
	}
	for (const { query: statement } of judgedStatementsOf(installation)) {
		note(shape.judge === "whole" ? "a whole rule's statement" : "a probe's statement")
		const references = referencesOf(statement)
		for (const scan of scansOf(statement, headsOf(statement, readers), readers)) {
			const { kind, table } = scan.scanned
			for (const { read: column, output } of scan.columns) {
				assert.ok(
					read[table].has(column),
					`a scan of ${table} reads ${column}, a field its rule binds`
				)
				assert.ok(
					references.has(`${scan.alias}.${output}`) ||
						(kind === "stored" && declared[table].key.has(column)),
					`a scan of ${table} delivers ${column} to a reference of the statement, or keeps it as its key`
				)
			}
			if (scan.columns.length < declared[table].width) {
				note(kind === "stored" ? "a stored scan narrowed" : "a delta narrowed")
			}
		}
	}
}
