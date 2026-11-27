/** What the property of delta-reads.test.ts reads: its space, its schemas and the judge's calls of the deltas' readers. */

import { assert } from "@bjornpagen/testing/assert"
import { element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Option, String as Str } from "effect"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"
import { installOptions } from "#compiler/physical/install/compile.ts"
import { compileInstallation } from "#compiler/program/install.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, type Rule, v } from "#compiler/public/query.ts"
import {
	check,
	contained,
	derived,
	key,
	mutable,
	on,
	relation,
	schema,
	sealed,
	unit
} from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { queryOver, varsOver } from "#compiler/query/build/query.ts"
import type { FinishedValue, RuleValue } from "#compiler/query/build/rule.ts"
import { derivedBuilder } from "#compiler/schema/relation.ts"
import { schemaBuilder } from "#compiler/schema/schema.ts"
import { containedBuilder, onBuilder } from "#compiler/schema/statements.ts"
import type {
	ColumnDefinition,
	CteBody,
	Expr,
	FromItem,
	FromSource,
	OperandSelect,
	PlStatement
} from "#compiler/sql/ast.ts"
import { readConditions } from "#compiler/sql/ast.ts"
import { and, cUtf8Collation } from "#compiler/sql/build.ts"
import { printExpr, printObjectName } from "#compiler/sql/print.ts"
import { inertVisitor, visitSelect } from "#compiler/sql/transform.ts"
import { succeeded } from "#test/support/assert.ts"
import { judgedStatementsOf, upkeepReadsOf } from "#test/support/judge.ts"
import { everyCallCount } from "#test/support/kernel/calls.ts"
import { owning } from "#test/support/policy.ts"

/**
 * A rule's law over D: a check over its facts, a containment of S into it by a number or by a text, or a key over a
 * projection of them.
 */
type Law = "check" | "contained" | "tagged" | "key"

/** A short lowercase word, a text of bounded bytes. */
const word = str.regex("^[a-z]{1,8}$")

/**
 * One case: its law; D's arms, each T's facts of one literal of `a`; and its judge: whole, T and S immutable, so the
 * rule is unit-local and one statement reads every arm of D over a delta of T, or probed, both mutable in their
 * document's unit and each arm joining W, mutable in a unit of its own, so the rule reads two units, a probe of each
 * arm reading the delta once.
 */
interface Shape {
	readonly law: Law
	readonly arms: 1 | 2 | 3 | 4
	readonly judge: "whole" | "probed"
}

export const shapeGen: Gen<Shape> = (s) => ({
	law: s.draw(element<Law>(["check", "contained", "tagged", "key"])),
	arms: s.draw(element<Shape["arms"]>([1, 2, 3, 4])),
	judge: s.draw(element<Shape["judge"]>(["whole", "probed"]))
})

export type Reached =
	| "a delta read once"
	| "a delta read twice"
	| "a delta read three times or more"
	| "a statement reading two deltas"
	| "a whole rule's statement"
	| "a probe's statement"

/**
 * T and S, each keyed by its document first; D, the union of `arms` rules over T, the k-th T's facts whose `a` is k, by
 * document and place with their `b`. The rule judges D: its `b` at least 0, S's references among its `b`s by document,
 * or its `b` once per document.
 */
const schemaOf = (shape: Shape) => {
	const T = relation(
		"T",
		{ doc: pg.integer, at: pg.integer, a: pg.integer, b: pg.integer, tag: word },
		["doc", "at"]
	)
	const S = relation("S", { doc: pg.integer, at: pg.integer, ref: pg.integer, label: word }, [
		"doc",
		"at"
	])
	const W = relation("W", { wdoc: pg.integer }, ["wdoc"])
	const probed = shape.judge === "probed"
	const Base = schema(
		"delta_reads",
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
	/** The k-th arm: T's facts whose `a` is k, at a document W holds where the judge probes. */
	const arm = (k: number) => (r: Rule<typeof Base>) => {
		const { doc, at, b, tag } = v(T, "t")
		const matched = r.match(T, { doc, at, a: k, b, tag })
		return probed
			? matched.match(W, { wdoc: doc }).find({ doc, at, b, tag })
			: matched.find({ doc, at, b, tag })
	}
	const first = query(Base).rule(arm(1))
	const second = first.rule(arm(2))
	const third = second.rule(arm(3))
	const fourth = third.rule(arm(4))
	const D = derived(
		"D",
		shape.arms === 1 ? first : shape.arms === 2 ? second : shape.arms === 3 ? third : fourth
	)
	const law = (() => {
		switch (shape.law) {
			case "check":
				return check("Positive", D, (d) => d.ge(d.b, 0))
			case "contained":
				return contained(on(S, "doc", "ref"), on(D, "doc", "b"))
			case "tagged":
				return contained(on(S, "doc", "label"), on(D, "doc", "tag"))
			case "key":
				return key(on(D, "doc", "b"))
		}
	})()
	return schema.extend([Base], "delta_reads_1", [D], [law])
}

/** How often a statement calls one function it reads rows of, and how many FROM sources read the rows of its calls. */
interface Calls {
	readonly calls: number
	readonly reads: number
}

/** The functions a query reads rows of, at any depth, a name for each FROM source that calls one. */
const calledIn = (query: OperandSelect): ReadonlyArray<string> => {
	const names: Array<string> = []
	visitSelect(query, {
		...inertVisitor,
		fromItem: (item) => {
			if (item.kind === "function" && item.call.fn.kind === "qualified") {
				names.push(item.call.fn.name)
			}
		}
	})
	return names
}

/**
 * How often `statement` calls each function it reads rows of, by the function's name, as PostgreSQL evaluates it, and
 * the reads of the rows of those calls: a call in the statement's body, its WITH aside, is made where it stands, once,
 * and read there; a call in a CTE of its WITH, once for each FROM that reads the CTE where the CTE is NOT MATERIALIZED,
 * which PostgreSQL spells at each such read (subselect.c inline_cte), once for the statement where any FROM reads one
 * that is not (a MATERIALIZED CTE, computed once, or one PostgreSQL decides, computed once where read twice or more and
 * spelled at its one read otherwise), and never for a CTE no FROM reads, its rows read by each FROM that reads the CTE.
 */
const callsOf = (statement: OperandSelect): ReadonlyMap<string, Calls> => {
	const out = new Map<string, Calls>()
	const add = (name: string, calls: number, reads: number): void => {
		const held = out.get(name)
		out.set(
			name,
			held === undefined
				? { calls, reads }
				: { calls: held.calls + calls, reads: held.reads + reads }
		)
	}
	const readsOf = new Map<string, number>()
	visitSelect(statement, {
		...inertVisitor,
		fromItem: (item) => {
			if (item.kind === "cte") {
				readsOf.set(item.name, (readsOf.get(item.name) ?? 0) + 1)
			}
		}
	})
	for (const name of calledIn({ ...statement, with: undefined })) {
		add(name, 1, 1)
	}
	for (const cte of statement.with === undefined ? [] : statement.with.ctes) {
		const body = cte.query
		if (body.kind !== "select") {
			assert.fail(`the judged statement's CTE ${cte.name} writes`)
		}
		const reads = readsOf.get(cte.name) ?? 0
		const calls = reads === 0 ? 0 : cte.materialized === "NOT MATERIALIZED" ? reads : 1
		for (const name of calledIn(body)) {
			add(name, calls, reads)
		}
	}
	return out
}

/**
 * Judges the calls of each statement of the judge of `shape`'s installation, the judge's and its parts', where its rules
 * stand (support/judge.ts judgedStatementsOf): it calls a function, a delta's reader, the only function any of them
 * reads rows of, and each one it calls it calls once, however many of its FROM sources read the rows of the call.
 */
export const judged = (shape: Shape, note: (r: Reached) => void): void => {
	const owned = owning(schemaOf(shape))
	const installation = succeeded(compileInstallation(owned, installOptions(owned)))
	const statements = judgedStatementsOf(installation)
	assert.ok(statements.length > 0, "the rule is judged")
	for (const { query: statement } of statements) {
		note(shape.judge === "whole" ? "a whole rule's statement" : "a probe's statement")
		const calls = callsOf(statement)
		assert.ok(calls.size > 0, "a judged statement reads a delta through its reader")
		if (calls.size >= 2) {
			note("a statement reading two deltas")
		}
		for (const [name, c] of calls) {
			assert.equal(
				c.calls,
				1,
				`a judged statement calls the reader ${name} ${c.calls} times, its rows read by ${c.reads} FROM sources`
			)
			note(
				c.reads === 1
					? "a delta read once"
					: c.reads === 2
						? "a delta read twice"
						: "a delta read three times or more"
			)
		}
	}
}

/**
 * The literal `where`, a reader's condition, fixes the delta's `a` to: where it is that equality or an AND one of whose
 * arguments is, the rule's own conditions beside it; none otherwise.
 */
const fixedA = (where: Expr | undefined): number | undefined => {
	if (where?.kind === "and") {
		return Arr.findFirst(where.args, (e) => fixedA(e) !== undefined).pipe(
			Option.flatMapNullishOr(fixedA),
			Option.getOrUndefined
		)
	}
	if (where?.kind !== "binary" || where.op !== "=") {
		return undefined
	}
	const { left, right } = where
	const value = right.kind === "cast" ? right.expr : right
	return left.kind === "column" &&
		left.table === "r1" &&
		left.column === "a" &&
		value.kind === "literal" &&
		value.value.kind === "int"
		? Number(value.value.value)
		: undefined
}

/**
 * Each reader of T's deltas in `installation`, by its function's name: the condition its one SELECT of the delta reads
 * the rows it returns under, none for a reader of every row (physical/ddl/deltas.ts addReaders).
 */
/**
 * A reader's one read of a table and the conditions it reads its rows under, where its one statement reads one: the
 * table as the binding reads it (sql/ast.ts FromSource `read`), each condition its access states first
 * (readConditions), then its level's WHERE, as they print.
 */
const readerRead = (
	query: OperandSelect
): { readonly table: string; readonly condition: Expr | undefined } | undefined => {
	if (query.body.kind !== "core") {
		return undefined
	}
	const [from, ...more] = query.body.from
	if (from?.kind !== "read" || more.length > 0) {
		return undefined
	}
	const where = query.body.where
	const [first, ...rest] = [...readConditions(from), ...(where === undefined ? [] : [where])]
	return {
		table: from.table.name,
		condition: first === undefined ? undefined : and([first, ...rest])
	}
}

const tReadersIn = (installation: Installation): ReadonlyMap<string, Expr | undefined> =>
	new Map(
		Arr.flatMap(
			installation.statements,
			(s): ReadonlyArray<readonly [string, Expr | undefined]> => {
				if (s.kind !== "createFunction" || s.language !== "plpgsql") {
					return []
				}
				const [only, ...rest] = s.body.body
				const read =
					only.kind === "returnQuery" && rest.length === 0 ? readerRead(only.query) : undefined
				return read !== undefined &&
					(Str.startsWith("__delta_news_t_")(read.table) ||
						Str.startsWith("__delta_olds_t_")(read.table))
					? [[s.name.name, read.condition]]
					: []
			}
		)
	)

/**
 * Whether a write of T can break `shape`'s law, so its judge reads T's delta: a check or a key over D, broken by a fact
 * T's added rows give D; a containment of S into D, broken only by a fact D loses, which a removal of T's rows withdraws,
 * so only where T is open, its judge probed. Where it is closed, no served write removes a row of T, and a data step,
 * the one writer that does, is judged by its bracket's re-check (physical/ddl/recheck.ts): PROVABLE's construction
 * (9b52e18fb3), under which a closed relation's removed rows are never captured or read.
 */
const tCanBreak = (shape: Shape): boolean => {
	switch (shape.law) {
		case "check":
		case "key":
			return true
		case "contained":
		case "tagged":
			return shape.judge === "probed"
	}
}

/**
 * Judges each statement's reads of T's deltas in `shape`'s installation (support/judge.ts judgedStatementsOf): each
 * calls a reader whose one condition fixes T's `a` to the literal of one of the shape's arms, and, where a write of T can
 * break the law (`tCanBreak`), the arms' literals are each read by some statement, so no statement reads T's delta whole
 * and each arm reads its own rows; where none can, no statement reads T's delta at all.
 */
export const selected = (shape: Shape, note: (r: Reached) => void): void => {
	const owned = owning(schemaOf(shape))
	const installation = succeeded(compileInstallation(owned, installOptions(owned)))
	const readers = tReadersIn(installation)
	const literals = new Set<number>()
	for (const { query: statement } of judgedStatementsOf(installation)) {
		note(shape.judge === "whole" ? "a whole rule's statement" : "a probe's statement")
		const called = calledIn(statement)
		if (new Set(called).size >= 2) {
			note("a statement reading two deltas")
		}
		for (const name of called) {
			if (!readers.has(name)) {
				continue
			}
			note("a delta read once")
			const condition = readers.get(name)
			const literal = fixedA(condition)
			assert.ok(
				literal !== undefined && literal >= 1 && literal <= shape.arms,
				`a judged statement reads T's delta through ${name} under ${condition === undefined ? "no condition" : printExpr(condition)}, which fixes a to no arm's literal`
			)
			literals.add(literal)
		}
	}
	if (!tCanBreak(shape)) {
		assert.equal(
			literals.size,
			0,
			"no statement reads T's delta: a containment into D over a closed T is broken by no served write of T"
		)
		return
	}
	const arms = Array.from({ length: shape.arms }, (_, i) => i + 1)
	assert.ok(
		Arr.every(arms, (k) => literals.has(k)),
		`every arm's rows of T's delta are read, a fixed to each of ${Arr.join(Arr.map(arms, String), ", ")}, not only ${Arr.join(Arr.map([...literals], String), ", ")}`
	)
}

/** The module whose calls the judged prints count: the printer's one door and the composed statements' text maker. */
const counted = "packages/engine/src/sql/emit.ts"

/**
 * The installation of `shape`'s schema compiled, counted: the statements it prints (sql/emit.ts emitText) and the
 * statements its lowerings compose into others, which nothing prints (sql/emit.ts unprintedText), every call of the
 * module counted (kernel/calls.ts everyCallCount).
 */
export const printsAt = (shape: Shape) =>
	Effect.gen(function* () {
		const owned = owning(schemaOf(shape))
		const [, counts] = yield* everyCallCount(
			Effect.sync(() => succeeded(compileInstallation(owned, installOptions(owned)))),
			(file) => file === counted
		)
		const callsOf = (name: string): number =>
			Arr.reduce(
				Arr.filter([...counts], ([key]) => Str.endsWith(` ${name}`)(key)),
				0,
				(n, [, k]) => n + k
			)
		return { prints: callsOf("emitText"), composed: callsOf("unprintedText") }
	})

/** Each delta reader in `installation`, by its function's name: the delta it reads and its condition printed, empty for
 * a reader of every row. */
const deltaReadersIn = (
	installation: Installation
): ReadonlyMap<string, { readonly delta: string; readonly condition: string }> =>
	new Map(
		Arr.flatMap(installation.statements, (s) => {
			if (s.kind !== "createFunction" || s.language !== "plpgsql") {
				return []
			}
			const [only, ...rest] = s.body.body
			const read =
				only.kind === "returnQuery" && rest.length === 0 ? readerRead(only.query) : undefined
			return read !== undefined && Str.startsWith("__delta_")(read.table)
				? [
						[
							s.name.name,
							{
								delta: read.table,
								condition: read.condition === undefined ? "" : printExpr(read.condition)
							}
						] as const
					]
				: []
		})
	)

/** A call of a delta's reader a statement holds: its reader, the columns it defines, and the columns read of it. */
interface ReaderCall {
	readonly reader: string
	readonly definitions: ReadonlyArray<ColumnDefinition>
	readonly read: ReadonlySet<string>
}

/**
 * Each call of a delta's reader `statement` holds (`readers`), with the columns the statement reads of it: of a call
 * where its read stands, the columns read under its alias; of one a CTE holds, the columns read under the alias of each
 * read of the CTE.
 */
const readerCallsOf = (
	statement: OperandSelect,
	readers: ReadonlyMap<string, unknown>
): ReadonlyArray<ReaderCall> => {
	const refs = new Map<string, Set<string>>()
	const cteReads = new Map<string, Array<string>>()
	const calls: Array<{
		readonly reader: string
		readonly alias: string
		readonly definitions: ReadonlyArray<ColumnDefinition>
	}> = []
	const source = (item: FromSource): void => {
		if (item.kind === "cte") {
			cteReads.set(item.name, [...(cteReads.get(item.name) ?? []), item.alias ?? item.name])
		}
		if (
			item.kind === "function" &&
			item.call.fn.kind === "qualified" &&
			readers.has(item.call.fn.name)
		) {
			calls.push({
				reader: item.call.fn.name,
				alias: item.alias,
				definitions: item.columns.kind === "defined" ? item.columns.definitions : []
			})
		}
	}
	visitSelect(statement, {
		...inertVisitor,
		fromItem: (item) => {
			if (item.kind === "joins") {
				source(item.first)
				for (const step of item.steps) {
					source(step.source)
				}
				return
			}
			source(item)
		},
		expr: (e) => {
			if (e.kind === "column" && e.table !== undefined) {
				refs.set(e.table, new Set([...(refs.get(e.table) ?? []), e.column]))
			}
		}
	})
	/** The CTE each call a CTE of the statement holds lies in, by the call's alias. */
	const heldBy = new Map(
		Arr.flatMap(statement.with?.ctes ?? [], (cte) => {
			const body = cte.query
			const [from] = body.kind === "select" && body.body.kind === "core" ? body.body.from : []
			return from?.kind === "function" ? [[from.alias, cte.name] as const] : []
		})
	)
	return Arr.map(calls, (call) => {
		const cte = heldBy.get(call.alias)
		const aliases = cte === undefined ? [call.alias] : (cteReads.get(cte) ?? [])
		return {
			reader: call.reader,
			definitions: call.definitions,
			read: new Set(Arr.flatMap(aliases, (alias) => [...(refs.get(alias) ?? [])]))
		}
	})
}

/**
 * The source a query reads first: its core's first FROM item, through every derived table that wraps one, as a CTE
 * holds a reader's call under the fence and the DISTINCT its readers read it through (`WITH r6 AS MATERIALIZED (SELECT
 * DISTINCT r5.c4 FROM (SELECT r1.c1 FROM reader() AS r1 OFFSET 0) AS r5)`), where it held the call as its own FROM.
 */
const firstSource = (query: CteBody): FromItem | undefined => {
	const [from] = query.kind === "select" && query.body.kind === "core" ? query.body.from : []
	return from?.kind === "derived" ? firstSource(from.query) : from
}

/**
 * Judges each call of a delta's reader in `shape`'s installation's judged statements (support/judge.ts
 * judgedStatementsOf): it defines exactly the columns its statement reads of it, its delta's first column alone where
 * the statement reads none, since PostgreSQL defines no call's rows by an empty list; each text column it defines it
 * defines under pg_catalog.pg_c_utf8, the collation a definition list gives the column a function returns; and no two
 * calls of one statement read one selection of one delta, so a statement produces each selection's rows once.
 */
export const projected = (shape: Shape, note: (r: ProjectedReached) => void): void => {
	const owned = owning(schemaOf(shape))
	const installation = succeeded(compileInstallation(owned, installOptions(owned)))
	const readers = deltaReadersIn(installation)
	for (const { query: statement } of judgedStatementsOf(installation)) {
		note(shape.judge === "whole" ? "a whole rule's statement" : "a probe's statement")
		const calls = readerCallsOf(statement, readers)
		const selections = new Set<string>()
		for (const call of calls) {
			const defined = new Set(Arr.map(call.definitions, (d) => d.name))
			const reader = readers.get(call.reader)
			const selection = `${reader?.delta ?? ""} ${reader?.condition ?? ""}`
			assert.ok(
				!selections.has(selection),
				`a statement reads the selection ${selection} through two calls of its readers`
			)
			selections.add(selection)
			if (call.read.size === 0) {
				note("a reader of no column read")
				assert.equal(defined.size, 1, `the call of ${call.reader} reads no column, and defines one`)
			} else {
				assert.ok(
					defined.size === call.read.size && Arr.every([...call.read], (c) => defined.has(c)),
					`the call of ${call.reader} defines ${Arr.join([...defined], ", ")}, the columns its statement reads of it being ${Arr.join([...call.read], ", ")}`
				)
			}
			for (const d of call.definitions) {
				if (d.type.kind === "builtin" && d.type.name === "text") {
					note("a text column delivered")
					assert.ok(
						d.collation !== undefined &&
							printObjectName(d.collation) === printObjectName(cUtf8Collation),
						`the call of ${call.reader} defines its text column ${d.name} under pg_catalog.pg_c_utf8`
					)
				}
			}
		}
		if (statement.with !== undefined && Arr.some(calls, (call) => call.read.size > 0)) {
			const shared = Arr.some(statement.with.ctes, (cte) => {
				const from = firstSource(cte.query)
				return (
					from?.kind === "function" &&
					readers.has(from.call.fn.kind === "qualified" ? from.call.fn.name : "")
				)
			})
			if (shared) {
				note("a reader read twice or more in one statement")
			}
		}
	}
}

export type ProjectedReached =
	| "a whole rule's statement"
	| "a probe's statement"
	| "a text column delivered"
	| "a reader read twice or more in one statement"
	| "a reader of no column read"

/**
 * One upkeep: D stored at T's document's unit, the union of `arms` rules over T, the k-th T's facts whose `a` is k, by
 * document and place with their `b` and `tag`, each regardless of S, where S holds no row at its place, or where U holds
 * a row there whose `w` and `x` are both positive, a range of two columns no index range serves; T, S and U `held` in
 * the document's unit closed, open (each mutable in it) or sealed.
 */
interface Upkept {
	readonly arms: 1 | 2 | 3 | 4
	readonly beside: "none" | "unless S" | "with U"
	readonly held: "closed" | "open" | "sealed"
}

export const upkeptGen: Gen<Upkept> = (s) => ({
	arms: s.draw(element<Upkept["arms"]>([1, 2, 3, 4])),
	beside: s.draw(element<Upkept["beside"]>(["none", "unless S", "with U"])),
	held: s.draw(element<Upkept["held"]>(["closed", "open", "sealed"]))
})

export type UpkeepReached =
	| "a region of one arm"
	| "a region of two arms or more"
	| "a checked form"
	| "a monotone form"
	| "a closed form"
	| "a unit form"
	| "an upkeep's DELETE"
	| "an upkeep's INSERT"
	| "a reader read twice or more in one statement"
	| "a statement reading two deltas"

/**
 * T, S and U, each keyed by its document first, at the document's unit, held as the shape says; D, stored, the union
 * of `shape`'s arms over T.
 */
const upkeptSchemaOf = (shape: Upkept) => {
	const T = relation(
		"T",
		{ doc: pg.integer, at: pg.integer, a: pg.integer, b: pg.integer, tag: word },
		["doc", "at"]
	)
	const S = relation("S", { doc: pg.integer, at: pg.integer }, ["doc", "at"])
	const U = relation("U", { doc: pg.integer, at: pg.integer, w: pg.integer, x: pg.integer }, [
		"doc",
		"at",
		"w"
	])
	const document = unit("Document", { doc: pg.integer })
	/** The base, its relations open in the document's unit, or closed in it, sealed or not: no mutable relation is
	 * under a sealed unit, which the schema's type refuses. */
	const Base =
		shape.held === "open"
			? schema("upkeep_reads", [T, S, U], [document, mutable(T), mutable(S), mutable(U)])
			: schema("upkeep_reads", [T, S, U], [shape.held === "sealed" ? sealed(document) : document])
	/** The k-th arm: T's facts whose `a` is k, where S holds no row at their place, or U holds one there whose `w` and
	 * `x` are both positive, if the shape says so. */
	const arm = (k: number) => (r: Rule<typeof Base>) => {
		const { doc, at, b, tag } = v(T, "t")
		const { w, x } = v(U, "u")
		const matched = r.match(T, { doc, at, a: k, b, tag })
		switch (shape.beside) {
			case "none":
				return matched.find({ doc, at, b, tag })
			case "unless S":
				return matched.where(r.not(S, { doc, at })).find({ doc, at, b, tag })
			case "with U":
				return matched
					.match(U, { doc, at, w, x })
					.where(r.gt(w, 0), r.gt(x, 0))
					.find({ doc, at, b, tag })
		}
	}
	const first = query(Base).rule(arm(1))
	const second = first.rule(arm(2))
	const third = second.rule(arm(3))
	const fourth = third.rule(arm(4))
	const D = derived(
		"D",
		shape.arms === 1 ? first : shape.arms === 2 ? second : shape.arms === 3 ? third : fourth
	)
	return schema.extend([Base], "upkeep_reads_1", [D], [])
}

/**
 * The form D's upkeep takes in `shape` (analysis/theory/upkeep.ts): the unit form over a sealed unit, whose founding
 * write's delta is the whole unit; the checked form where every arm reads T at its key from the fact beside S's
 * negation, whose added rows withdraw facts, or, T open, alone; the monotone form where an arm reads an open U by a
 * probe, two ranges past a part of its key, so a fact lost is checked at no fact and its unit is re-derived; and the
 * closed form (ClosedLoss) where every holder is closed and none is negated, so no served write makes D lose a fact and
 * its upkeep is the INSERT of what a write gains alone, a data step's bracket refilling the table
 * (physical/ddl/recheck.ts). The box's holders were all closed and U read at (doc, at) alone, so its shapes were checked
 * alone and monotone beside U; since PROVABLE (9b52e18fb3) a closed relation's removed rows are read by none, so those
 * are closed forms, and since SEALED-P3's existence-only seeks (dc3e0c7f10) U read at a prefix of its key for its
 * existence alone is reached, so the monotone form needs an open U read by a probe.
 */
const formOf = (shape: Upkept): "checked" | "monotone" | "closed" | "unit" => {
	if (shape.held === "sealed") {
		return "unit"
	}
	if (shape.beside === "unless S") {
		return "checked"
	}
	if (shape.held === "closed") {
		return "closed"
	}
	return shape.beside === "with U" ? "monotone" : "checked"
}

/**
 * Whether the statement at `at` of D's upkeep in its `held` form reads T's delta: every one but a checked form's DELETE
 * over a closed T, whose lost facts S's added rows alone withdraw, a closed relation's removed rows read by none
 * (PROVABLE, 9b52e18fb3).
 */
const readsT = (shape: Upkept, held: ReturnType<typeof formOf>, at: number): boolean =>
	!(held === "checked" && shape.held === "closed" && at === 0)

/** How many statements D's upkeep in each form runs: a unit form's and a checked form's DELETE and INSERT, a monotone
 * form's DELETE and INSERT of the units T's removed rows touch and INSERT of the facts its added rows gain, and a closed
 * form's INSERT of what a write gains alone. */
const statementsOf = {
	unit: 2,
	checked: 2,
	monotone: 3,
	closed: 1
} as const satisfies Record<ReturnType<typeof formOf>, number>

/**
 * Judges the reads of each statement of D's upkeep in `shape`'s installation (support/judge.ts upkeepReadsOf), by its
 * form (`formOf`): a unit form's DELETE and INSERT; a checked form's DELETE of the facts its lost rules find and INSERT
 * of the facts its gained rules find; a monotone form's DELETE and INSERT of the units T's removed rows touch and its
 * INSERT of the facts its added rows gain; a closed form's INSERT of the facts its added rows gain. Each reads T's deltas
 * through readers whose one condition fixes T's `a` to an arm's literal, every arm's literal among them (`readsT`: but
 * a checked form's DELETE over a closed T, which reads none), so none reads T's delta whole; it calls each reader once,
 * however many of its reads read its rows, the DELETE's region and the region its definition reads alike, through one
 * call of each selection, the reader a selection read at two sites shares (physical/ddl/deltas.ts `shared`, reached by
 * an upkeep's statements alone, since the lowering holds a delta a rule's statement reads twice in a CTE of its own);
 * and each call defines exactly the columns the statement reads of it.
 */
export const upkept = (shape: Upkept, note: (r: UpkeepReached) => void): void => {
	const owned = owning(upkeptSchemaOf(shape))
	const installation = succeeded(compileInstallation(owned, installOptions(owned)))
	const tReaders = tReadersIn(installation)
	const readers = deltaReadersIn(installation)
	const statements = upkeepReadsOf(installation, "D")
	const upkeep = Arr.findFirst(installation.laws.theory.upkeeps, (u) => u.relation === "D")
	assert.ok(Option.isSome(upkeep), "D stored, an upkeep of the installation's")
	const form = upkeep.value.form
	const held =
		form.kind === "unit"
			? "unit"
			: form.lost.kind === "checked"
				? "checked"
				: form.lost.kind === "closed"
					? "closed"
					: "monotone"
	assert.equal(held, formOf(shape), `D's upkeep is its shape's form`)
	assert.equal(statements.length, statementsOf[held], `the statements of D's ${held} form's upkeep`)
	note(`a ${held} form`)
	note(shape.arms === 1 ? "a region of one arm" : "a region of two arms or more")
	for (const [at, statement] of statements.entries()) {
		note(at === 0 && held !== "closed" ? "an upkeep's DELETE" : "an upkeep's INSERT")
		const literals = new Set<number>()
		for (const name of calledIn(statement)) {
			if (!tReaders.has(name)) {
				continue
			}
			const condition = tReaders.get(name)
			const literal = fixedA(condition)
			assert.ok(
				literal !== undefined && literal >= 1 && literal <= shape.arms,
				`D's upkeep reads T's delta through ${name} under ${condition === undefined ? "no condition" : printExpr(condition)}, which fixes a to no arm's literal`
			)
			literals.add(literal)
		}
		const arms = Array.from({ length: shape.arms }, (_, i) => i + 1)
		if (readsT(shape, held, at)) {
			assert.ok(
				Arr.every(arms, (k) => literals.has(k)),
				`each statement of D's upkeep reads every arm's rows of T's delta, a fixed to each of ${Arr.join(Arr.map(arms, String), ", ")}, not only ${Arr.join(Arr.map([...literals], String), ", ")}`
			)
		} else {
			assert.equal(
				literals.size,
				0,
				"the checked form's DELETE over a closed T reads no row of T's delta, its facts withdrawn by S's added rows alone"
			)
		}
		const calls = callsOf(statement)
		/** Whether the statement calls a reader of a delta of `relation`, its name's stem T's `t`, S's `s`. */
		const reads = (relation: string): boolean =>
			Arr.some([...calls.keys()], (name) =>
				Arr.some(["news", "olds"], (side) =>
					Str.startsWith(`__delta_${side}_${relation}_`)(readers.get(name)?.delta ?? "")
				)
			)
		if (reads("t") && reads("s")) {
			note("a statement reading two deltas")
		}
		for (const [name, c] of calls) {
			assert.equal(
				c.calls,
				1,
				`a statement of D's upkeep calls the reader ${name} ${c.calls} times, its rows read by ${c.reads} FROM sources`
			)
			if (c.reads >= 2) {
				note("a reader read twice or more in one statement")
			}
		}
		const selections = new Set<string>()
		for (const call of readerCallsOf(statement, readers)) {
			const reader = readers.get(call.reader)
			const selection = `${reader?.delta ?? ""} ${reader?.condition ?? ""}`
			assert.ok(
				!selections.has(selection),
				`a statement of D's upkeep reads the selection ${selection} through two calls of its readers`
			)
			selections.add(selection)
			const defined = new Set(Arr.map(call.definitions, (d) => d.name))
			assert.ok(
				call.read.size === 0
					? defined.size === 1
					: defined.size === call.read.size && Arr.every([...call.read], (c) => defined.has(c)),
				`the call of ${call.reader} in D's upkeep defines ${Arr.join([...defined], ", ")}, the columns its statement reads of it being ${Arr.join([...call.read], ", ")}`
			)
		}
	}
}

/**
 * One judge of A's facts: Media, A's facts of governor 1, stored, or stored with a stored relation reading it in turn,
 * held in R by a containment; and Named, the names of A's facts of governor 2, held in Q by a rule over A, or none.
 * Media is stored in every case: its unit's key holds A's key, so its upkeep reads one row of A at a key
 * (analysis/derived/storage.ts keyedAt); a live Media over A in a unit cannot be stated, so A's side of news read by
 * rules alone is no case of this box (JUDGEDELTA2's netting census: a live arm needs a definition that is not
 * unit-local).
 */
interface Netted {
	readonly media: "stored" | "stored beneath another"
	readonly named: boolean
	/** Whether Media folds A's facts of governor 1 to the greatest name at each start, a fold, which no delta form keeps
	 * (analysis/theory/upkeep.ts), so its upkeep is a unit form, which reads A's news at the units its rows name alone. */
	readonly folds: boolean
}

export const nettedGen: Gen<Netted> = (s) => ({
	media: s.draw(element<Netted["media"]>(["stored", "stored beneath another"])),
	named: s.draw(element([false, true])),
	folds: s.draw(element([false, true]))
})

export type NettedReached =
	| "A's news read by an upkeep and a rule"
	| "A's news read by an upkeep alone"
	| "A's news read by a delta form"
	| "A's news read by a unit form alone"
	| "a stored relation's news read above it"

/** A, mutable in its package's unit; R and Q in their pack's; Media and Named over A as `shape` says (`Netted`). */
const nettedSchemaOf = (shape: Netted) => {
	const A = relation(
		"A",
		{
			package: pg.integer,
			path: pg.integer,
			start: pg.integer,
			name: pg.integer,
			governor: pg.integer
		},
		["package", "path", "start", "name"]
	)
	const R = relation(
		"R",
		{ pack: pg.integer, path: pg.integer, start: pg.integer, name: pg.integer },
		["pack", "path", "start", "name"]
	)
	const Q = relation("Q", { pack: pg.integer, name: pg.integer }, ["pack", "name"])
	const Base = schema(
		"netted",
		[A, R, Q],
		[
			mutable(A),
			mutable(R),
			mutable(Q),
			unit("Package", { package: pg.integer }),
			unit("Pack", { pack: pg.integer })
		]
	)
	/** Media, Named and Placed by the untyped builders (schema/relation.ts derivedBuilder), so one Media reads as either
	 * of the shape's definitions, its facts' key or a fold of them, at one heading. */
	const Media = derivedBuilder(
		"Media",
		queryOver(Base).rule((r: RuleValue): FinishedValue => {
			const a = varsOver(A, "a")
			const [p, path, start, name] = [a["package"], a["path"], a["start"], a["name"]]
			const matched = r.match(A, { package: p, path, start, name, governor: 1 })
			return matched.find({ package: p, path, start, name: shape.folds ? r.max(name) : name })
		}),
		[]
	)
	const Named = derivedBuilder(
		"Named",
		queryOver(Base).rule((r: RuleValue): FinishedValue => {
			const a = varsOver(A, "a")
			return r
				.match(A, { package: a["package"], name: a["name"], governor: 2 })
				.find({ package: a["package"], name: a["name"] })
		}),
		[]
	)
	const held = containedBuilder(
		onBuilder(Media, ["package", "path", "start", "name"]),
		onBuilder(R, ["pack", "path", "start", "name"])
	)
	const First = schemaBuilder.extend(
		[Base],
		"netted_1",
		shape.named ? [Media, Named] : [Media],
		shape.named
			? [
					held,
					containedBuilder(onBuilder(Named, ["package", "name"]), onBuilder(Q, ["pack", "name"]))
				]
			: [held],
		[]
	)
	if (shape.media !== "stored beneath another") {
		return First
	}
	const Placed = derivedBuilder(
		"Placed",
		queryOver(First).rule((r: RuleValue): FinishedValue => {
			const m = varsOver(Media, "m")
			const [p, path, start] = [m["package"], m["path"], m["start"]]
			return r.match(Media, { package: p, path, start }).find({ package: p, path, start })
		}),
		[]
	)
	return schemaBuilder.extend([First], "netted_2", [Placed], [], [])
}

/** Each delta a statement among `body` nets (physical/ddl/deltas.ts netted), at any depth of its IFs, in order. */
const nettedIn = (body: ReadonlyArray<PlStatement>): ReadonlyArray<string> =>
	Arr.flatMap(body, (st): ReadonlyArray<string> => {
		if (st.kind === "if") {
			return [...Arr.flatMap(st.branches, (b) => nettedIn(b.body)), ...nettedIn(st.else)]
		}
		if (st.kind === "whenFound") {
			return nettedIn(st.body)
		}
		if (st.kind !== "modify" || st.statement.kind !== "delete") {
			return []
		}
		const { table, where } = st.statement
		return typeof table !== "string" &&
			table.schema === "pg_temp" &&
			Str.startsWith("__delta_news_")(table.name) &&
			where?.kind === "inQuery" &&
			where.expr.kind === "column" &&
			where.expr.column === "ctid"
			? [table.name]
			: []
	})

/** Whether `body` calls a function of the judge's (a part's), at any depth of its IFs. */
const callsAPart = (body: ReadonlyArray<PlStatement>): boolean =>
	Arr.some(body, (st) =>
		st.kind === "if"
			? Arr.some(st.branches, (b) => callsAPart(b.body)) || callsAPart(st.else)
			: st.kind === "perform"
	)

/**
 * Judges the nettings of the judge of `shape`'s installation: its run nets A's side of news once where a rule reads it,
 * Media's containment over a derived Media or Named's rule, or where Media's upkeep is a delta form, whose gained rules
 * read A's images themselves (analysis/theory/upkeep.ts), in the judge's own body before it calls any part, so every rule
 * and every upkeep reads it netted, and never where only a unit form reads it, which needs the units its rows name alone;
 * no part, block or upkeep nets a delta; and no stored relation's side of news is netted, its upkeep writing each image
 * once.
 */
export const nettedOnce = (shape: Netted, note: (r: NettedReached) => void): void => {
	const owned = owning(nettedSchemaOf(shape))
	const installation = succeeded(compileInstallation(owned, installOptions(owned)))
	const judge = identifierOf(identity.ruleJudge())
	const functions = Arr.flatMap(installation.statements, (st) =>
		st.kind === "createFunction" && st.language === "plpgsql" ? [st] : []
	)
	const [judgeFn] = Arr.filter(functions, (f) => f.name.name === judge)
	assert.ok(judgeFn !== undefined, "the installation holds the rule judge")
	note(shape.named ? "A's news read by an upkeep and a rule" : "A's news read by an upkeep alone")
	if (shape.media === "stored beneath another") {
		note("a stored relation's news read above it")
	}
	for (const f of functions) {
		if (f.name.name !== judge) {
			const nets = nettedIn(f.body.body)
			assert.equal(
				nets.length,
				0,
				`${f.name.name}, no run of the judge's own, nets ${Arr.join(nets, ", ")}`
			)
		}
	}
	const body = judgeFn.body.body
	const nets = nettedIn(body)
	const aNews = Arr.filter(nets, Str.startsWith("__delta_news_a_"))
	const delta = Arr.some(
		installation.laws.theory.upkeeps,
		(u) => u.relation === "Media" && u.form.kind === "delta"
	)
	if (delta) {
		note("A's news read by a delta form")
	}
	if (!delta && !shape.named) {
		note("A's news read by a unit form alone")
	}
	const ruled = shape.named || delta
	assert.equal(
		aNews.length,
		ruled ? 1 : 0,
		`the judge nets A's side of news ${ruled ? "once, a rule or a delta form's gained rules reading it," : "never, a unit form alone reading it,"} not ${aNews.length} times`
	)
	assert.equal(
		nets.length,
		aNews.length,
		`the judge nets A's side of news and no stored relation's: ${Arr.join(nets, ", ")}`
	)
	const firstPart = Arr.findFirstIndex(body, (st) => callsAPart([st]))
	const netting = Arr.findFirstIndex(body, (st) => nettedIn([st]).length > 0)
	if (ruled) {
		assert.ok(
			Option.isSome(netting) &&
				Option.match(firstPart, { onNone: () => true, onSome: (at) => netting.value < at }),
			`the judge nets A's side of news, at its statement ${String(Option.getOrUndefined(netting))}, before it calls a part, at its statement ${String(Option.getOrUndefined(firstPart))}`
		)
	}
}
