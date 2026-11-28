/** What the property of judge-sources.test.ts reads: its space, its schemas and the judge's scans. */

import { assert, defined } from "@bjornpagen/testing/assert"
import { boolean, element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, Option, String as Str } from "effect"
import { type Installation, installOptions } from "#compiler/physical/install/compile.ts"
import { compileInstallation } from "#compiler/program/install.ts"
import { int4 } from "#compiler/public/fields.ts"
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
	type Expr,
	type FromItem,
	type FromSource,
	functionColumnNames,
	type OperandSelect,
	type PlStatement,
	readConditions,
	selectColumns
} from "#compiler/sql/ast.ts"
import { inertVisitor, visitExpr, visitSelect } from "#compiler/sql/transform.ts"
import { succeeded } from "#test/support/assert.ts"
import { judgedDeltaReadsOf } from "#test/support/judge.ts"
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
	| "an existence read index-only"

/**
 * T and S, each keyed by its document first, and each with a field no rule reads, `pay` and `note`; D, T's facts by
 * document and place with their `b`, selected by `a` where the shape selects, `a` an unread witness elsewhere, at a
 * document W holds where the shape is probed. The rule
 * judges D: S's references among its `b`s by document, which no key of T holds, so the judge holds it and no foreign key
 * does, its `b` at least 0, or its `b` once per document.
 */
const schemaOf = (shape: Shape) => {
	const T = relation("T", { doc: int4, at: int4, a: int4, b: int4, pay: int4 }, ["doc", "at"])
	const S = relation("S", { doc: int4, at: int4, ref: int4, note: int4 }, ["doc", "at"])
	const W = relation("W", { wdoc: int4 }, ["wdoc"])
	const probed = shape.judge === "probed"
	const Base = schema(
		"judge_sources",
		[T, S, W],
		probed
			? [
					unit("Document", { doc: int4 }),
					unit("Ws", { wdoc: int4 }),
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
 * columns of one table of pg_temp, the delta, read as the binding reads a stored table (sql/ast.ts FromSource `read`). */
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
			if (from?.kind !== "read" || more.length > 0) {
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
 * The table a FROM source reads, where it reads one of the installation's, bound as every stored read of a statement the
 * judge sends is (sql/ast.ts FromSource `read`), or a session's delta of one, which a judged statement reads through a
 * call of its reader or a CTE over one (`heads`).
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
	if (source.kind !== "read" && source.kind !== "probe") {
		return undefined
	}
	const { schema: holder, name } = source.table
	const table = tableNamed(name)
	return table !== undefined && Str.startsWith("judge_sources")(holder)
		? { kind: "stored", table }
		: undefined
}

/** The conjuncts of a WHERE, none where it states none. */
const conjunctsIn = (where: Expr | undefined): ReadonlyArray<Expr> =>
	where === undefined ? [] : where.kind === "and" ? Arr.flatMap(where.args, conjunctsIn) : [where]

/**
 * The column of the table a scan reads under `alias` that one of its conditions equates to `value`, a column of a source
 * outside the scan, which the scan delivers in that column's place, as the binding delivers a column its read binds by
 * equality to a value its level fixes: the column it reads, none where no condition equates one to it.
 */
const equatedColumn = (
	conditions: ReadonlyArray<Expr>,
	alias: string,
	value: Extract<Expr, { readonly kind: "column" }>
): string | undefined => {
	const isValue = (e: Expr): boolean =>
		e.kind === "column" && e.table === value.table && e.column === value.column
	const ownColumn = (e: Expr): string | undefined =>
		e.kind === "column" && e.table === alias ? e.column : undefined
	return Option.getOrUndefined(
		Arr.findFirst(conditions, (c) =>
			c.kind !== "binary" || c.op !== "="
				? Option.none()
				: Option.fromUndefinedOr(
						isValue(c.right) ? ownColumn(c.left) : isValue(c.left) ? ownColumn(c.right) : undefined
					)
		)
	)
}

/** One column a scan reads of its table, and the output of its derived table that delivers it. */
interface ScanColumn {
	readonly read: string
	readonly output: string
}

/**
 * A scan of a table: a derived table whose query reads that table alone, each of its targets a column of it, or a probe
 * of a stored table (sql/ast.ts FromSource `probe`), each of its columns one it reads; its alias, its columns, and the
 * columns of its table its own conditions read, a conjunct of the statement's the binding pushed into it among them
 * (sql/bind.ts), where the statement reads them in no reference to its outputs.
 */
interface Scan {
	readonly scanned: Scanned
	readonly alias: string
	readonly columns: ReadonlyArray<ScanColumn>
	/** The columns of its table the values it computes over it read, a group's aggregates' arguments. */
	readonly computed: ReadonlySet<string>
	readonly conditioned: ReadonlySet<string>
	/**
	 * The advice target of the stored read an existence test makes (`<alias>@<level>`, sql/advice.ts), a derived table
	 * whose every target is a literal, which reads its table only for whether a row its conditions hold stands, where
	 * those conditions read no column but those its seek binds, which the seek's index holds; none for any other scan.
	 */
	readonly existence: string | undefined
}

/** Each scan of a table in `statement`, at any depth, each column a delta's CTE delivers read as the delta's own. */
const scansOf = (
	statement: OperandSelect,
	heads: ReadonlyMap<string, Head>,
	readers: ReadonlyMap<string, Reader>
): ReadonlyArray<Scan> => {
	const scans: Array<Scan> = []
	const source = (item: FromSource): void => {
		if (item.kind === "probe") {
			const scanned = scannedBy(item, heads, readers)
			if (scanned !== undefined) {
				scans.push({
					scanned,
					alias: item.alias,
					columns: Arr.map(item.columns, (c) => ({ read: c.read, output: c.as })),
					computed: new Set(),
					conditioned: new Set(),
					existence: undefined
				})
			}
			return
		}
		if (item.kind !== "derived" || item.query.body.kind !== "core") {
			return
		}
		const [from, ...more] = item.query.body.from
		if (
			from === undefined ||
			more.length > 0 ||
			(from.kind !== "read" && from.kind !== "cte" && from.kind !== "function")
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
		const conditions = [...readConditions(from), ...conjunctsIn(item.query.body.where)]
		const targets = item.query.body.targets
		const literals = Arr.filter(targets, (t) => t.expr.kind === "literal").length
		/** The columns of the table each target that is no column reads, an aggregate's arguments, none of a literal. */
		const computed = new Set<string>()
		for (const t of targets) {
			if (t.expr.kind === "column") {
				continue
			}
			visitExpr(t.expr, {
				...inertVisitor,
				expr: (e) => {
					if (e.kind !== "column") {
						return
					}
					assert.equal(e.table, alias, `the scan ${item.alias} computes over its table alone`)
					const column = columnOf === undefined ? e.column : columnOf.get(e.column)
					if (column !== undefined) {
						computed.add(column)
					}
				}
			})
		}
		const columns = Arr.flatMap(targets, (t, i) => {
			const output = outputs[i]
			const own =
				t.expr.kind !== "column"
					? undefined
					: t.expr.table === alias
						? t.expr.column
						: equatedColumn(conditions, alias, t.expr)
			const read = own === undefined ? undefined : columnOf === undefined ? own : columnOf.get(own)
			return output !== undefined && read !== undefined ? [{ read, output }] : []
		})
		assert.equal(
			columns.length + Arr.filter(targets, (t) => t.expr.kind !== "column").length,
			outputs.length,
			`the scan ${item.alias} delivers columns of its table, values it computes over it and literals alone`
		)
		const conditioned = new Set<string>()
		for (const condition of conditions) {
			visitExpr(condition, {
				...inertVisitor,
				expr: (e) => {
					const column =
						e.kind !== "column" || e.table !== alias
							? undefined
							: columnOf === undefined
								? e.column
								: columnOf.get(e.column)
					if (column !== undefined) {
						conditioned.add(column)
					}
				}
			})
		}
		scans.push({
			scanned,
			alias: item.alias,
			columns,
			computed,
			conditioned,
			existence:
				from.kind === "read" &&
				from.access.kind === "seek" &&
				literals === targets.length &&
				Arr.every([...conditioned], (c) =>
					Arr.some(from.access.kind === "seek" ? from.access.bound : [], (b) => b.column === c)
				)
					? `${from.alias}@${item.alias}`
					: undefined
		})
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

/** The plan advice each routine of `installation` carries (sql/ast.ts CreateFunction `advice`), by its name. */
const advicesIn = (installation: Installation): ReadonlyMap<string, string> =>
	new Map(
		Arr.flatMap(installation.statements, (s): ReadonlyArray<readonly [string, string]> =>
			s.kind === "createFunction" ? [[s.name.name, s.advice]] : []
		)
	)

/**
 * Judges the scans of each statement of the judge of `shape`'s installation, the judge's and its parts', where its rules
 * stand (support/judge.ts judgedDeltaReadsOf): each reads only fields its rule binds of its relation (`readFields`), and
 * delivers each column it reads to some reference of the statement, reads it in a condition of its own, or keeps it as a
 * stored table's key; and each read an existence test makes, which needs no column but those its seek binds, all of
 * which the seek's index holds, is advised as an index-only scan in the routine that runs it (sql/advice.ts), never as
 * an index scan that fetches the rows a column it reads for nothing would need.
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
	const advices = advicesIn(installation)
	for (const { routine, statement: judgedStatement } of judgedDeltaReadsOf(installation)) {
		const statement = judgedStatement.query
		note(shape.judge === "whole" ? "a whole rule's statement" : "a probe's statement")
		const references = referencesOf(statement)
		const advice = defined(advices.get(routine.name), `the advice of ${routine.name}`)
		for (const scan of scansOf(statement, headsOf(statement, readers), readers)) {
			const { kind, table } = scan.scanned
			if (scan.existence !== undefined) {
				const target = scan.existence
				assert.ok(
					Str.includes(`INDEX_ONLY_SCAN(${target} `)(advice),
					`the existence read ${target} of ${table} is advised an index-only scan in ${routine.name}: ${advice}`
				)
				note("an existence read index-only")
			}
			for (const column of scan.computed) {
				assert.ok(
					read[table].has(column),
					`a scan of ${table} computes over ${column}, a field its rule binds`
				)
			}
			for (const { read: column, output } of scan.columns) {
				assert.ok(
					read[table].has(column),
					`a scan of ${table} reads ${column}, a field its rule binds`
				)
				assert.ok(
					references.has(`${scan.alias}.${output}`) ||
						scan.conditioned.has(column) ||
						(kind === "stored" && declared[table].key.has(column)),
					`a scan of ${table} delivers ${column} to a reference of the statement, reads it in a condition of its own, or keeps it as its key`
				)
			}
			if (scan.columns.length < declared[table].width) {
				note(kind === "stored" ? "a stored scan narrowed" : "a delta narrowed")
			}
		}
	}
}

/**
 * A guarded case: Value, a learner's scores of a package's nodes, keyed by the learner first, then by its package and
 * place in either order, so a probe of a write of Bound or Node reads it under a guard (analysis/theory/query.ts
 * probeGuard): the judge runs the probe only where a value of the written package stands, an existence read of Value at
 * the package; and the rule's check, a score at most its node's bound or at least it.
 */
export interface Guarded {
	readonly order: "package first" | "place first"
	readonly check: "le" | "ge"
}

export const guardedGen: Gen<Guarded> = (s) => ({
	order: s.draw(element<Guarded["order"]>(["package first", "place first"])),
	check: s.draw(element<Guarded["check"]>(["le", "ge"]))
})

export type GuardReached = "a guard over a write of Bound" | "a guard over a write of Node"

/** rule-guard's Scored in small (test/pg/laws/rule-guard.fixtures.ts): Value beside each bounded node of its package. */
const guardedSchemaOf = (g: Guarded) => {
	const Node = relation("Node", { pkg: int4, start: int4, parent: int4, kind: int4 }, [
		"pkg",
		"start"
	])
	const Bound = relation("Bound", { pkg: int4, kind: int4, bound: int4 }, ["pkg", "kind"])
	const Value = relation(
		"Value",
		{ child: int4, pkg: int4, start: int4, score: int4 },
		g.order === "package first" ? ["child", "pkg", "start"] : ["child", "start", "pkg"]
	)
	const Base = schema("judge_guards", [Node, Bound, Value], [])
	const bounded = query(Base).rule((r) => {
		const { pkg, start } = v(Node, "n")
		const { kind } = v(Node, "child")
		const { bound } = v(Bound, "b")
		return r
			.match(Node, { pkg, start, kind: 10 })
			.match(Node, { pkg, parent: start, kind })
			.match(Bound, { pkg, kind, bound })
			.find({ pkg, start, bound })
	})
	const Scored = derived(
		"Scored",
		query(Base).rule((r) => {
			const { child, pkg, start, score } = v(Value, "value")
			const { bound } = v(bounded, "node")
			return r
				.match(Value, { child, pkg, start, score })
				.match(bounded, { pkg, start, bound })
				.find({ bound, child, pkg, score, start })
		})
	)
	return schema.extend(
		[Base],
		"judge_guards_1",
		[Scored],
		[
			check("Within", Scored, (sc) =>
				g.check === "le" ? sc.le(sc.score, sc.bound) : sc.ge(sc.score, sc.bound)
			)
		]
	)
}

/** Each IF EXISTS a routine of `installation` runs, the query it tests, by its routine's name: a probe's guard among
 * them, and a dispatcher's test of whether a delta holds a row. */
const guardsIn = (
	installation: Installation
): ReadonlyArray<{ readonly routine: string; readonly query: OperandSelect }> => {
	const guards: Array<{ readonly routine: string; readonly query: OperandSelect }> = []
	const walk = (routine: string, body: ReadonlyArray<PlStatement>): void => {
		for (const statement of body) {
			if (statement.kind !== "if") {
				continue
			}
			for (const branch of statement.branches) {
				if (branch.condition.kind === "exists" && !branch.condition.not) {
					guards.push({ routine, query: branch.condition.query })
				}
				walk(routine, branch.body)
			}
		}
	}
	for (const s of installation.statements) {
		if (s.kind === "createFunction" && s.language === "plpgsql") {
			walk(s.name.name, s.body.body)
		}
	}
	return guards
}

/** A read of Value a guard makes: its advice target, the columns it delivers and its own conditions read, by its alias. */
interface ValueRead {
	readonly target: string
	readonly outputs: ReadonlyArray<string>
	readonly level: string
	readonly delivered: ReadonlySet<string>
	readonly conditioned: ReadonlySet<string>
}

/** The columns of the read under `alias` that `exprs` read. */
const columnsOf = (exprs: ReadonlyArray<Expr>, alias: string): ReadonlySet<string> => {
	const out = new Set<string>()
	for (const e of exprs) {
		visitExpr(e, {
			...inertVisitor,
			expr: (x) => {
				if (x.kind === "column" && x.table === alias) {
					out.add(x.column)
				}
			}
		})
	}
	return out
}

/** Each read of Value in `query`, a derived table whose one source is a bound read of the guarded schema's Value. */
const valueReadsOf = (query: OperandSelect): ReadonlyArray<ValueRead> => {
	const reads: Array<ValueRead> = []
	visitSelect(query, {
		...inertVisitor,
		fromItem: (item) => {
			const sources =
				item.kind === "joins" ? [item.first, ...Arr.map(item.steps, (st) => st.source)] : [item]
			for (const source of sources) {
				if (source.kind !== "derived" || source.query.body.kind !== "core") {
					continue
				}
				const [from, ...more] = source.query.body.from
				if (
					from?.kind !== "read" ||
					more.length > 0 ||
					from.table.name !== "value" ||
					!Str.startsWith("judge_guards")(from.table.schema)
				) {
					continue
				}
				reads.push({
					target: `${from.alias}@${source.alias}`,
					outputs: selectColumns(source.query),
					level: source.alias,
					delivered: columnsOf(
						Arr.map(source.query.body.targets, (t) => t.expr),
						from.alias
					),
					conditioned: columnsOf(
						[...readConditions(from), ...conjunctsIn(source.query.body.where)],
						from.alias
					)
				})
			}
		}
	})
	return reads
}

/** The relations whose deltas a guard reads, by the readers it calls (physical/ddl/rules.ts readers): a probe's guard
 * reads a written relation's, a dispatcher's test none. */
const deltasRead = (query: OperandSelect): ReadonlySet<string> => {
	const read = new Set<string>()
	visitSelect(query, {
		...inertVisitor,
		fromItem: (item) => {
			const sources =
				item.kind === "joins" ? [item.first, ...Arr.map(item.steps, (st) => st.source)] : [item]
			for (const source of sources) {
				if (source.kind === "function" && source.call.fn.kind === "qualified") {
					for (const relation of ["bound", "node"]) {
						if (Str.includes(`_${relation}_`)(source.call.fn.name)) {
							read.add(relation)
						}
					}
				}
			}
		}
	})
	return read
}

/**
 * Judges each guard of `g`'s installation: each read of Value it makes that delivers no column a reference of the
 * guard reads, its existence read, reads of Value only the columns its own conditions read, never a key no reader tells
 * the rows of apart (lower/optimize/prune narrowedBase), and is advised an index-only scan in its routine, its index
 * holding every column it reads, never an index scan whose needs another statement of the routine counted
 * (sql/bind.ts, each query PL/pgSQL hands the planner its own needs).
 */
export const guarded = (g: Guarded, note: (r: GuardReached) => void): void => {
	const owned = owning(guardedSchemaOf(g))
	const installation = succeeded(compileInstallation(owned, installOptions(owned)))
	const advices = advicesIn(installation)
	const guards = Arr.filter(guardsIn(installation), (guard) => deltasRead(guard.query).size > 0)
	assert.ok(guards.length > 0, "the judge guards a probe of Value")
	for (const guard of guards) {
		const advice = defined(advices.get(guard.routine), `the advice of ${guard.routine}`)
		const references = referencesOf(guard.query)
		const deltas = deltasRead(guard.query)
		if (deltas.has("bound")) {
			note("a guard over a write of Bound")
		}
		if (deltas.has("node")) {
			note("a guard over a write of Node")
		}
		const reads = valueReadsOf(guard.query)
		assert.ok(reads.length > 0, `the guard of ${guard.routine} reads Value`)
		for (const read of reads) {
			if (Arr.some(read.outputs, (o) => references.has(`${read.level}.${o}`))) {
				continue
			}
			for (const column of read.delivered) {
				assert.ok(
					read.conditioned.has(column),
					`the guard's existence read ${read.target} of Value reads ${column}, which its conditions read`
				)
			}
			assert.ok(
				Str.includes(`INDEX_ONLY_SCAN(${read.target} `)(advice),
				`the guard's existence read ${read.target} is advised an index-only scan in ${guard.routine}: ${advice}`
			)
		}
	}
}
