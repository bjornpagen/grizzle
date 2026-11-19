/** What the property of judge-sources.test.ts reads: its space, its schemas and the judge's scans. */

import { boolean, element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, Option, String as Str } from "effect"
import { compileInstallation, installOptions } from "#compiler/physical/install/compile.ts"
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
	schema
} from "#compiler/public/schema.ts"
import type { FromItem, FromSource, OperandSelect, PlStatement } from "#compiler/sql/ast.ts"
import { inertVisitor, visitSelect } from "#compiler/sql/transform.ts"
import { assert, succeeded } from "#test/support/assert.ts"
import { judgeBodiesOf } from "#test/support/judge.ts"
import { owning } from "#test/support/policy.ts"
import { owner } from "#test/unit/physical/fixtures.ts"

/** A rule's law over D: a containment of S into it, a check over its facts, or a key over a projection of them. */
type Law = "contained" | "check" | "key"

/**
 * One case: its law; whether D's arm selects T by a literal of `a`; and its judge: whole, T and S immutable, so the
 * rule is unit-local, or probed, both mutable.
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
 * document and place with their `b`, selected by `a` where the shape selects, `a` an unread witness elsewhere. The rule
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
	const Base = schema(
		"judge_sources",
		[T, S],
		shape.judge === "probed" ? [mutable(T), mutable(S)] : []
	)
	const D = derived(
		"D",
		query(Base).rule((r) => {
			const { doc, at, a, b } = v(T, "t")
			return r.match(T, { doc, at, a: shape.selected ? 1 : a, b }).find({ doc, at, b })
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
	return schema.extend(Base, "judge_sources_1", [D], [law])
}

/** The tables of the schema, by their names as installed. */
const tables = ["t", "s"] as const
type Table = (typeof tables)[number]

/** What each table declares: its width, every field, and its primary key's columns, which a stored scan keeps. */
const declared: {
	readonly [K in Table]: { readonly width: number; readonly key: ReadonlySet<string> }
} = {
	t: { width: 5, key: new Set(["doc", "at"]) },
	s: { width: 4, key: new Set(["doc", "at"]) }
}

/**
 * The fields the shape's rule binds of each table, its key's among them: of T every field D's arm matches, its
 * document, place, `a` and `b`; of S, which a containment alone reads, its document, place and reference. Never `pay`
 * or `note`.
 */
const readFields = (shape: Shape): { readonly [K in Table]: ReadonlySet<string> } => ({
	t: new Set(["doc", "at", "a", "b"]),
	s: new Set(shape.law === "contained" ? ["doc", "at", "ref"] : [])
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

/** The relation a session's delta table holds a side of, by its name: what lies between its prefix and its digest. */
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

/** The table a FROM source reads, where it reads one of the installation's or a session's delta of one. */
const scannedBy = (source: FromSource): Scanned | undefined => {
	if (source.kind !== "table" || typeof source.table === "string") {
		return undefined
	}
	const { schema: holder, name } = source.table
	if (holder === "pg_temp") {
		const table = deltaOf(name)
		return table === undefined ? undefined : { kind: "delta", table }
	}
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

/** Each scan of a table in `statement`, at any depth. */
const scansOf = (statement: OperandSelect): ReadonlyArray<Scan> => {
	const scans: Array<Scan> = []
	const source = (item: FromSource): void => {
		if (item.kind !== "derived" || item.query.body.kind !== "core") {
			return
		}
		const [from, ...more] = item.query.body.from
		if (from === undefined || more.length > 0 || from.kind !== "table") {
			return
		}
		const scanned = scannedBy(from)
		if (scanned === undefined) {
			return
		}
		const columns = Arr.flatMap(item.query.body.targets, (t, i) => {
			const output = item.columns[i]
			return output !== undefined && t.expr.kind === "column" && t.expr.table === from.alias
				? [{ read: t.expr.column, output }]
				: []
		})
		assert.equal(
			columns.length,
			item.columns.length,
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

/** Every statement the judge tests by EXISTS to raise, at any depth of its body, whatever guards it stands under. */
const judgedStatements = (body: ReadonlyArray<PlStatement>): ReadonlyArray<OperandSelect> =>
	Arr.flatMap(body, (s) =>
		s.kind === "if"
			? Arr.flatMap(s.branches, (b) => [
					...(b.condition.kind === "exists" && b.body[0]?.kind === "raise"
						? [b.condition.query]
						: []),
					...judgedStatements(b.body)
				])
			: []
	)

/**
 * Judges the scans of each statement of the judge of `shape`'s installation, the judge's and its parts', where its rules
 * stand (support/judge.ts judgeBodiesOf): each reads only fields its rule binds of its relation (`readFields`), and
 * delivers each column it reads to some reference of the statement but a stored table's key, which its scan keeps.
 */
export const judged = (shape: Shape, note: (r: Reached) => void): void => {
	const owned = owning(schemaOf(shape))
	const installation = succeeded(compileInstallation(owned, installOptions(owned, owner)))
	const read = readFields(shape)
	const statements = judgedStatements(judgeBodiesOf(installation))
	for (const statement of statements) {
		note(shape.judge === "whole" ? "a whole rule's statement" : "a probe's statement")
		const references = referencesOf(statement)
		for (const scan of scansOf(statement)) {
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
