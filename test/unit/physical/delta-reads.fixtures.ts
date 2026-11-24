/** What the property of delta-reads.test.ts reads: its space, its schemas and the judge's calls of the deltas' readers. */

import { assert } from "@bjornpagen/testing/assert"
import { element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, Option, String as Str } from "effect"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { withDerivedRelations } from "#compiler/physical/derived/objects.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"
import { compileInstallation, installOptions } from "#compiler/physical/install/compile.ts"
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
	unit
} from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import type {
	ColumnDefinition,
	Expr,
	FromSource,
	OperandSelect,
	PlStatement
} from "#compiler/sql/ast.ts"
import { cUtf8Collation } from "#compiler/sql/build.ts"
import { printExpr, printObjectName } from "#compiler/sql/print.ts"
import { inertVisitor, visitSelect } from "#compiler/sql/transform.ts"
import { succeeded } from "#test/support/assert.ts"
import { judgedStatementsOf, upkeepReadsOf } from "#test/support/judge.ts"
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
const tReadersIn = (installation: Installation): ReadonlyMap<string, Expr | undefined> =>
	new Map(
		Arr.flatMap(
			installation.statements,
			(s): ReadonlyArray<readonly [string, Expr | undefined]> => {
				if (s.kind !== "createFunction" || s.language !== "plpgsql") {
					return []
				}
				const [only, ...rest] = s.body.body
				if (only.kind !== "returnQuery" || rest.length > 0 || only.query.body.kind !== "core") {
					return []
				}
				const [from] = only.query.body.from
				return from?.kind === "table" &&
					typeof from.table !== "string" &&
					(Str.startsWith("__delta_news_t_")(from.table.name) ||
						Str.startsWith("__delta_olds_t_")(from.table.name))
					? [[s.name.name, only.query.body.where]]
					: []
			}
		)
	)

/**
 * Judges each statement's reads of T's deltas in `shape`'s installation (support/judge.ts judgedStatementsOf): each
 * calls a reader whose one condition fixes T's `a` to the literal of one of the shape's arms, and the arms' literals
 * are each read by some statement, so no statement reads T's delta whole and each arm reads its own rows.
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
	const arms = Array.from({ length: shape.arms }, (_, i) => i + 1)
	assert.ok(
		Arr.every(arms, (k) => literals.has(k)),
		`every arm's rows of T's delta are read, a fixed to each of ${Arr.join(Arr.map(arms, String), ", ")}, not only ${Arr.join(Arr.map([...literals], String), ", ")}`
	)
}

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
			if (only.kind !== "returnQuery" || rest.length > 0 || only.query.body.kind !== "core") {
				return []
			}
			const [from] = only.query.body.from
			const where = only.query.body.where
			return from?.kind === "table" &&
				typeof from.table !== "string" &&
				Str.startsWith("__delta_")(from.table.name)
				? [
						[
							s.name.name,
							{ delta: from.table.name, condition: where === undefined ? "" : printExpr(where) }
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
				const body = cte.query
				const [from] = body.kind === "select" && body.body.kind === "core" ? body.body.from : []
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
 * document and place with their `b` and `tag`, each where S holds no row at its place or regardless of S.
 */
interface Upkept {
	readonly arms: 1 | 2 | 3 | 4
	readonly unlessS: boolean
}

export const upkeptGen: Gen<Upkept> = (s) => ({
	arms: s.draw(element<Upkept["arms"]>([1, 2, 3, 4])),
	unlessS: s.draw(element([false, true]))
})

export type UpkeepReached =
	| "a region of one arm"
	| "a region of two arms or more"
	| "an upkeep's DELETE"
	| "an upkeep's INSERT"
	| "a reader read twice or more in one statement"
	| "a statement reading two deltas"

/** T and S, each keyed by its document first, at the document's unit; D, stored, the union of `shape`'s arms over T. */
const upkeptSchemaOf = (shape: Upkept) => {
	const T = relation(
		"T",
		{ doc: pg.integer, at: pg.integer, a: pg.integer, b: pg.integer, tag: word },
		["doc", "at"]
	)
	const S = relation("S", { doc: pg.integer, at: pg.integer }, ["doc", "at"])
	const Base = schema("upkeep_reads", [T, S], [unit("Document", { doc: pg.integer })])
	/** The k-th arm: T's facts whose `a` is k, where S holds no row at their place if the shape says so. */
	const arm = (k: number) => (r: Rule<typeof Base>) => {
		const { doc, at, b, tag } = v(T, "t")
		const matched = r.match(T, { doc, at, a: k, b, tag })
		return shape.unlessS
			? matched.where(r.not(S, { doc, at })).find({ doc, at, b, tag })
			: matched.find({ doc, at, b, tag })
	}
	const first = query(Base).rule(arm(1))
	const second = first.rule(arm(2))
	const third = second.rule(arm(3))
	const fourth = third.rule(arm(4))
	const D = derived.stored(
		"D",
		shape.arms === 1 ? first : shape.arms === 2 ? second : shape.arms === 3 ? third : fourth
	)
	return schema.extend([Base], "upkeep_reads_1", [D], [])
}

/**
 * Judges the reads of each statement of D's upkeep in `shape`'s installation (support/judge.ts upkeepReadsOf), its
 * DELETE and its INSERT: each reads T's deltas through readers whose one condition fixes T's `a` to an arm's literal,
 * every arm's literal among them, so neither reads T's delta whole; it calls each reader once, however many of its reads
 * read its rows, the DELETE's region and the region its definition reads alike; and each call defines exactly the
 * columns the statement reads of it.
 */
export const upkept = (shape: Upkept, note: (r: UpkeepReached) => void): void => {
	const owned = owning(upkeptSchemaOf(shape))
	const installation = succeeded(
		compileInstallation(owned, withDerivedRelations(installOptions(owned)))
	)
	const tReaders = tReadersIn(installation)
	const readers = deltaReadersIn(installation)
	const statements = upkeepReadsOf(installation, "D")
	assert.equal(statements.length, 2, "D's upkeep is a DELETE and an INSERT")
	note(shape.arms === 1 ? "a region of one arm" : "a region of two arms or more")
	for (const [at, statement] of statements.entries()) {
		note(at === 0 ? "an upkeep's DELETE" : "an upkeep's INSERT")
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
		assert.ok(
			Arr.every(arms, (k) => literals.has(k)),
			`each statement of D's upkeep reads every arm's rows of T's delta, a fixed to each of ${Arr.join(Arr.map(arms, String), ", ")}, not only ${Arr.join(Arr.map([...literals], String), ", ")}`
		)
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
		for (const call of readerCallsOf(statement, readers)) {
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
 * One judge of A's facts: Media, A's facts of governor 1, a derived relation, a stored one, or a stored one a stored
 * relation reads in turn, each held in R by a containment; and Named, the names of A's facts of governor 2, held in Q
 * by a rule over A, or none.
 */
interface Netted {
	readonly media: "derived" | "stored" | "stored beneath another"
	readonly named: boolean
}

export const nettedGen: Gen<Netted> = (s) => ({
	media: s.draw(element<Netted["media"]>(["derived", "stored", "stored beneath another"])),
	named: s.draw(element([false, true]))
})

export type NettedReached =
	| "A's news read by an upkeep and a rule"
	| "A's news read by rules alone"
	| "A's news read by an upkeep alone"
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
	const mediaQuery = query(Base).rule((r) => {
		const { package: p, path, start, name } = v(A, "a")
		return r
			.match(A, { package: p, path, start, name, governor: 1 })
			.find({ package: p, path, start, name })
	})
	const Media =
		shape.media === "derived" ? derived("Media", mediaQuery) : derived.stored("Media", mediaQuery)
	const Named = derived(
		"Named",
		query(Base).rule((r) => {
			const { package: p, name } = v(A, "a")
			return r.match(A, { package: p, name, governor: 2 }).find({ package: p, name })
		})
	)
	const held = contained(
		on(Media, "package", "path", "start", "name"),
		on(R, "pack", "path", "start", "name")
	)
	const First = schema.extend(
		[Base],
		"netted_1",
		shape.named ? [Media, Named] : [Media],
		shape.named ? [held, contained(on(Named, "package", "name"), on(Q, "pack", "name"))] : [held]
	)
	if (shape.media !== "stored beneath another") {
		return First
	}
	const Placed = derived.stored(
		"Placed",
		query(First).rule((r) => {
			const { package: p, path, start } = v(Media, "m")
			return r.match(Media, { package: p, path, start }).find({ package: p, path, start })
		})
	)
	return schema.extend([First], "netted_2", [Placed], [])
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
 * Media's containment over a derived Media or Named's rule, in the judge's own body before it calls any part, so every
 * rule and every upkeep reads it netted, and never where only an upkeep reads it, which needs the units its rows name
 * alone; no part, block or upkeep nets a delta; and no stored relation's side of news is netted, its upkeep writing each
 * image once.
 */
export const nettedOnce = (shape: Netted, note: (r: NettedReached) => void): void => {
	const owned = owning(nettedSchemaOf(shape))
	const installation = succeeded(
		compileInstallation(owned, withDerivedRelations(installOptions(owned)))
	)
	const judge = identifierOf(identity.ruleJudge())
	const functions = Arr.flatMap(installation.statements, (st) =>
		st.kind === "createFunction" && st.language === "plpgsql" ? [st] : []
	)
	const [judgeFn] = Arr.filter(functions, (f) => f.name.name === judge)
	assert.ok(judgeFn !== undefined, "the installation holds the rule judge")
	note(
		shape.media === "derived"
			? "A's news read by rules alone"
			: shape.named
				? "A's news read by an upkeep and a rule"
				: "A's news read by an upkeep alone"
	)
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
	const ruled = shape.media === "derived" || shape.named
	assert.equal(
		aNews.length,
		ruled ? 1 : 0,
		`the judge nets A's side of news ${ruled ? "once, a rule reading it," : "never, an upkeep alone reading it,"} not ${aNews.length} times`
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
