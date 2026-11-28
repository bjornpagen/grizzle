/** The rule judge's PL/pgSQL, as an installation creates it (physical/ddl/rules.ts addRules). */

import { mapNonEmpty } from "@bjornpagen/grizzle-text/base/nonempty"
import { assert, defined } from "@bjornpagen/testing/assert"
import { Array as Arr, Effect, Option, String as Str } from "effect"
import {
	type PlanNode,
	parsePlan,
	planNodes,
	rowsGenerated,
	rowsRead,
	scannedRows
} from "#bench/harness/explain.ts"
import { type Identity, identifierOf, identity, upkeepParts } from "#compiler/core/identity.ts"
import type { IdentityKind } from "#compiler/core/ids.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"
import {
	type Expr,
	type FromSource,
	functionColumnNames,
	judgeLogColumns,
	type ObjectName,
	type OperandSelect,
	type PlStatement,
	type TypeRef
} from "#compiler/sql/ast.ts"
import { eq, param, simpleSelect } from "#compiler/sql/build.ts"
import {
	printExpr,
	printObjectName,
	printPlannedQuery,
	printStatement
} from "#compiler/sql/print.ts"
import { identityHooks, Transform } from "#compiler/sql/transform.ts"
import { routineAdviceHeld } from "#test/support/advice.ts"
import { succeeded } from "#test/support/assert.ts"
import { tableOfSource } from "#test/support/sql.ts"
import type { RawSession } from "#test/support/substrate/session.ts"

/** A test session's read of rows: a statement and its parameters, its rows positional. */
type Values<E> = (
	sql: string,
	params: ReadonlyArray<unknown>
) => Effect.Effect<ReadonlyArray<ReadonlyArray<unknown>>, E>

/**
 * The bodies of the judge and of each of its parts and blocks, each a function of its own: the judge runs a part where
 * the transaction wrote one of its deltas, a part each block where a selection it takes holds a row, and every
 * statement that tests a rule stands in a block. A part and a block are named by their identities' stems, the judge's
 * own followed by a relation's or a law's (core/identity.ts ruleJudgePart, ruleJudgeBlock).
 */
export const judgeBodiesOf = (installation: Installation): ReadonlyArray<PlStatement> =>
	Arr.flatMap(judgeFunctionsOf(installation), (f) => f.body)

/**
 * A PL/pgSQL function of the judge's (`judgeFunctionsOf`, `upkeepFunctionsOf`): its name, its arguments, each by its
 * type, an array of its delta's row type, which names it (physical/ddl/deltas.ts deltaArrayType), and its body.
 */
export interface JudgeFunction {
	readonly fn: ObjectName
	readonly params: ReadonlyMap<string, TypeRef>
	/** Its variables' types, its arguments' and its declarations', by name. */
	readonly typed: ReadonlyMap<string, TypeRef>
	readonly body: ReadonlyArray<PlStatement>
}

/** `installation`'s PL/pgSQL function `named` (`JudgeFunction`), none where it creates none. */
const functionNamed = (installation: Installation, named: string): Option.Option<JudgeFunction> =>
	Arr.findFirst(installation.statements, (s): Option.Option<JudgeFunction> =>
		s.kind === "createFunction" && s.language === "plpgsql" && s.name.name === named
			? Option.some({
					fn: s.name,
					params: new Map(Arr.map(s.params, (p) => [p.name, p.type] as const)),
					typed: new Map(
						Arr.map([...s.params, ...s.body.declare], (d) => [d.name, d.type] as const)
					),
					body: s.body.body
				})
			: Option.none()
	)

/** The judge and each of its parts and blocks (`judgeBodiesOf`). */
export const judgeFunctionsOf = (installation: Installation): ReadonlyArray<JudgeFunction> => {
	const judge = identifierOf(identity.ruleJudge())
	return Arr.flatMap(installation.statements, (s): ReadonlyArray<JudgeFunction> =>
		s.kind === "createFunction" &&
		s.language === "plpgsql" &&
		(s.name.name === judge || Str.startsWith(`${judge}_`)(s.name.name))
			? [
					{
						fn: s.name,
						params: new Map(Arr.map(s.params, (p) => [p.name, p.type] as const)),
						typed: new Map(
							Arr.map([...s.params, ...s.body.declare], (d) => [d.name, d.type] as const)
						),
						body: s.body.body
					}
				]
			: []
	)
}

/**
 * A delta a table's capture logs (physical/ddl/rules.ts addCapture): its name, and the attributes of its row type, a side
 * of news's count among them.
 */
export interface CapturedDelta {
	readonly name: string
	readonly columns: ReadonlyArray<string>
}

/** The deltas `body` logs, at any depth of the conditions it stands under: each column of its INSERT into the delta log. */
const loggedDeltas = (body: ReadonlyArray<PlStatement>): ReadonlyArray<string> =>
	Arr.flatMap(body, (s): ReadonlyArray<string> => {
		switch (s.kind) {
			case "if":
				return [...Arr.flatMap(s.branches, (b) => loggedDeltas(b.body)), ...loggedDeltas(s.else)]
			case "into":
				return s.statement.kind === "insert" &&
					Arr.contains(s.statement.columns, judgeLogColumns.prev)
					? Arr.filter(s.statement.columns, (c) => c !== judgeLogColumns.prev)
					: []
			case "wholeReads":
				return loggedDeltas(s.body)
			case "assign":
			case "case":
			case "forQuery":
			case "perform":
			case "raise":
			case "return":
			case "returnQuery":
			case "whenFound":
			case "modify":
				return []
		}
	})

/** Each delta's row type's attributes, by the delta's name (physical/ddl/deltas.ts deltaRowTypeCreate). */
const rowTypesOf = (installation: Installation): ReadonlyMap<string, ReadonlyArray<string>> =>
	new Map(
		Arr.flatMap(installation.statements, (s) =>
			s.kind === "createRowType"
				? [[s.name.name, Arr.map(s.attributes, (a) => a.name)] as const]
				: []
		)
	)

/**
 * The deltas `relation`'s capture logs (physical/ddl/rules.ts addCapture), each once, in the order its body logs them,
 * each with its row type's attributes.
 */
export const capturedDeltasOf = (
	installation: Installation,
	relation: string
): ReadonlyArray<CapturedDelta> => {
	const attributes = rowTypesOf(installation)
	return Option.match(functionNamed(installation, identifierOf(identity.ruleCapture(relation))), {
		onNone: () => [],
		onSome: (capture) =>
			Arr.map(Arr.dedupe(loggedDeltas(capture.body)), (name) => ({
				name,
				columns: defined(attributes.get(name), `the row type of delta ${name}`)
			}))
	})
}

/** A RAISE of PL/pgSQL. */
type Raise = Extract<PlStatement, { readonly kind: "raise" }>

/**
 * A statement the judge tests a rule by: a whenFound (sql/build.ts) of a block, `query` the rule's query it reads whole,
 * and `raise`, what it runs where the query returns a row.
 */
export interface JudgedStatement {
	readonly query: OperandSelect
	readonly raise: Raise
}

/**
 * The statements `body` tests a rule by (`JudgedStatement`), at any depth of the guards they stand under: an IF's, or a
 * probe's guard (analysis/theory/query.ts probeGuard), a statement whose rows raise nothing but run what it guards.
 */
export const judgedStatementsIn = (
	body: ReadonlyArray<PlStatement>
): ReadonlyArray<JudgedStatement> =>
	Arr.flatMap(body, (s): ReadonlyArray<JudgedStatement> => {
		if (s.kind === "if") {
			return [
				...Arr.flatMap(s.branches, (b) => judgedStatementsIn(b.body)),
				...judgedStatementsIn(s.else)
			]
		}
		if (s.kind !== "whenFound") {
			return []
		}
		const [first] = s.body
		return first.kind === "raise" ? [{ query: s.query, raise: first }] : judgedStatementsIn(s.body)
	})

/** Every statement the judge's blocks test a rule by (`JudgedStatement`), in their bodies' order. */
export const judgedStatementsOf = (installation: Installation): ReadonlyArray<JudgedStatement> =>
	judgedStatementsIn(judgeBodiesOf(installation))

/**
 * A statement a PL/pgSQL body runs for its effect: an upkeep's (physical/ddl/rules.ts upkeepBlock), a write it runs
 * once, the DELETE of its removal, its target read at the tuple ids its USING's query returns, or its INSERT.
 */
type Modified = Extract<PlStatement, { readonly kind: "modify" }>["statement"]

/**
 * The bodies of stored relation `relation`'s upkeep blocks (physical/ddl/rules.ts upkeepBlock, identity.storedUpkeep),
 * each block's in its function's order, the blocks in their parts' (upkeepParts): a unit form's one, or a delta form's
 * removal of the facts a write withdraws, then its insert of the facts it gains.
 */
export const upkeepBodyOf = (
	installation: Installation,
	relation: string
): ReadonlyArray<PlStatement> =>
	Arr.flatMap(upkeepFunctionsOf(installation, relation), (f) => f.body)

/** Whether `named`, an identity the installation minted, is part `part` of stored relation `relation`'s upkeep. */
const isUpkeepPart = (
	named: Identity<IdentityKind>,
	relation: string,
	part: (typeof upkeepParts)[number]
): boolean => {
	if (named.kind !== "storedUpkeep" || named.parts[0] !== relation) {
		return false
	}
	const second = named.parts[1]
	return part === "units" ? second !== "lost" && second !== "gained" : second === part
}

/**
 * The functions of stored relation `relation`'s upkeep (`upkeepBodyOf`), in their parts' order: each named by its part
 * and the selections it takes (identity.storedUpkeep), found among the identities the installation minted.
 */
export const upkeepFunctionsOf = (
	installation: Installation,
	relation: string
): ReadonlyArray<JudgeFunction> =>
	Arr.flatMap(upkeepParts, (part) => {
		const named = new Set(
			Arr.flatMap(installation.identities, (i): ReadonlyArray<string> =>
				isUpkeepPart(i, relation, part) ? [identifierOf(i)] : []
			)
		)
		return Arr.flatMap([...named], (name) => Option.toArray(functionNamed(installation, name)))
	})

/** The statements of the upkeep of stored relation `relation` (`upkeepFunctionsOf`), each with its block's function. */
const upkeepRunsOf = (
	installation: Installation,
	relation: string
): ReadonlyArray<{ readonly routine: JudgeFunction; readonly run: Modified }> =>
	Arr.flatMap(upkeepFunctionsOf(installation, relation), (routine) =>
		Arr.flatMap(
			routine.body,
			(s): ReadonlyArray<{ readonly routine: JudgeFunction; readonly run: Modified }> =>
				s.kind === "modify" ? [{ routine, run: s.statement }] : []
		)
	)

/**
 * The reads of each statement of the upkeep of stored relation `relation` (`upkeepRunsOf`), each as the query of the
 * rows it reads: a DELETE's, the query of its USING, whose rows it reads the table at by their ids alone; an INSERT's,
 * the query its rows come from.
 */
export const upkeepReadsOf = (
	installation: Installation,
	relation: string
): ReadonlyArray<OperandSelect> =>
	Arr.flatMap(upkeepRunsOf(installation, relation), ({ run: m }): ReadonlyArray<OperandSelect> => {
		if (m.kind === "delete") {
			return Arr.flatMap(m.using, (u) => (u.kind === "derived" ? [u.query] : []))
		}
		return m.kind === "insert" && m.source.kind === "query" ? [m.source.query] : []
	})

/**
 * A judged statement as the SQL PostgreSQL plans for it: the SELECT whose keyword its PERFORM replaces, `SELECT 1 FROM
 * (<query>) AS "found"`, for all its rows (pl_exec.c exec_stmt_perform).
 */
export const plannedQueryOf = (statement: JudgedStatement): string =>
	printPlannedQuery({ kind: "found", query: statement.query })

/**
 * A query whose rows a rule breaks by, a judged statement's or a rule's check over every row (deploy/snapshot
 * violation.ts lawChecks), as a test of the state: whether it returns a row.
 */
export const foundQueryOf = (query: OperandSelect): string =>
	`SELECT EXISTS ${printExpr({ kind: "subquery", query })}`

/** The rule a judged statement raises under: its raise's CONSTRAINT, the rule's trigger name. */
export const raisedRule = (statement: JudgedStatement): Option.Option<string> =>
	Arr.findFirst(statement.raise.using, (o) => o.option === "CONSTRAINT").pipe(
		Option.flatMap((o) =>
			o.value.kind === "literal" && o.value.value.kind === "text"
				? Option.some(o.value.value.value)
				: Option.none()
		)
	)

/**
 * The delta a variable of `routine` holds rows of, `variable` by its name, an argument or a declaration of the routine:
 * its type's, an array of the delta's row type.
 */
const deltaOfVariable = (routine: JudgeFunction, variable: string): string | undefined => {
	const type = routine.typed.get(variable)
	return type?.kind === "named" ? type.name : undefined
}

/**
 * A read of a delta's array a statement of `routine` makes (physical/ddl/deltas.ts headed): the FROM item that unnests
 * one of its arguments, the delta's rows or a selection of them, `unnest(<argument>) AS <alias>(c1, ..., cn)`; the
 * delta, by its name, and each column the item names, c<i>, the delta's i-th attribute (`rowTypesOf`).
 */
export interface ArrayRead {
	readonly delta: string
	readonly columnOf: ReadonlyMap<string, string>
}

/** `source` as a read of a delta's array by `routine` of `installation` (`ArrayRead`), none where it reads none. */
export const arrayReadOf = (
	installation: Installation,
	routine: JudgeFunction,
	source: FromSource
): ArrayRead | undefined => {
	const [array] = source.kind === "function" ? source.call.args : []
	const delta = array?.kind === "plVar" ? deltaOfVariable(routine, array.name) : undefined
	const attributes = delta === undefined ? undefined : rowTypesOf(installation).get(delta)
	if (delta === undefined || attributes === undefined || source.kind !== "function") {
		return undefined
	}
	const names = functionColumnNames(source.columns)
	return {
		delta,
		columnOf: new Map(
			Arr.flatMap(names, (c, at) => {
				const attribute = attributes[at]
				return attribute === undefined ? [] : [[c, attribute] as const]
			})
		)
	}
}

/** The tables a statement reads: its deltas, by name, and its stored tables, printed (`tablesReadBy`). */
interface TablesRead {
	readonly deltas: ReadonlyArray<string>
	readonly stored: ReadonlyArray<string>
}

/**
 * The tables the statement `walk` visits reads, in the order its FROM items name them, at any depth, its subqueries'
 * among them: its deltas, each the delta of the argument of `routine` a FROM unnests (physical/ddl/deltas.ts headed),
 * and its stored tables, every table a FROM names, printed as pg_locks' regclass reads them. A write's target is no FROM
 * of it: an upkeep's DELETE or INSERT reads its stored relation's table only where a FROM of it names the table.
 */
const tablesReadBy = (
	walk: (transform: Transform) => unknown,
	routine: JudgeFunction
): TablesRead => {
	const deltas: Array<string> = []
	const stored: Array<string> = []
	walk(
		new Transform({
			...identityHooks,
			fromSource: (source) => {
				const table = tableOfSource(source)
				if (table !== undefined) {
					stored.push(printObjectName(table))
				}
				const [array] = source.kind === "function" ? source.call.args : []
				const delta = array?.kind === "plVar" ? deltaOfVariable(routine, array.name) : undefined
				if (delta !== undefined) {
					deltas.push(delta)
				}
				return source
			}
		})
	)
	return { deltas, stored }
}

/** A statement of the judge that tests a rule (`JudgedStatement`), in its block, with the tables it reads. */
export interface RuleStatement {
	readonly kind: "rule"
	readonly routine: JudgeFunction
	readonly statement: JudgedStatement
	readonly deltas: ReadonlySet<string>
	readonly stored: ReadonlySet<string>
}

/**
 * A statement of a stored relation's upkeep (physical/ddl/rules.ts upkeepBlock, `Modified`), `relation` the stored
 * relation whose table it writes: its DELETE of the rows the relation's definition no longer derives at the units
 * the transaction wrote, or its INSERT of those it newly derives there, with the tables it reads, and `writes`, the
 * deltas its stored table's capture logs where a rule or an upkeep reads the relation (`capturedDeltasOf`), which the
 * upkeep's writes fill inside the judge, before every statement over them runs.
 */
export interface UpkeepStatement {
	readonly kind: "upkeep"
	readonly routine: JudgeFunction
	readonly relation: string
	readonly statement: Modified
	readonly deltas: ReadonlySet<string>
	readonly stored: ReadonlySet<string>
	readonly writes: ReadonlySet<string>
}

/**
 * A statement the judge runs over the transaction's deltas, where a selection it reads holds a row: a rule's test
 * (`RuleStatement`), or a stored relation's upkeep's write (`UpkeepStatement`), each beside the deltas it reads, by name,
 * each the delta of an argument of its block it unnests, and the stored tables it reads, printed.
 */
export type JudgeStatement = RuleStatement | UpkeepStatement

/** `statement` walked by `transform`, by its kind. */
const modified = (transform: Transform, statement: Modified): Modified => {
	switch (statement.kind) {
		case "insert":
			return transform.insert(statement)
		case "update":
			return transform.update(statement)
		case "delete":
			return transform.delete(statement)
		case "merge":
			return transform.merge(statement)
	}
}

/** A statement the judge tests a rule by in its block `routine`, with the tables it reads (`RuleStatement`). */
const ruleStatementOf = (routine: JudgeFunction, statement: JudgedStatement): RuleStatement => {
	const read = tablesReadBy((t) => t.select(statement.query), routine)
	return {
		kind: "rule",
		routine,
		statement,
		deltas: new Set(read.deltas),
		stored: new Set(read.stored)
	}
}

/** Every statement the judge's blocks test a rule by (`judgedStatementsOf`), each in its block, with the tables it
 * reads. */
const ruleStatementsOf = (installation: Installation): ReadonlyArray<RuleStatement> =>
	Arr.flatMap(judgeFunctionsOf(installation), (f) =>
		Arr.map(judgedStatementsIn(f.body), (statement) => ruleStatementOf(f, statement))
	)

/**
 * Every statement of every stored relation's upkeep (analysis/theory/unit.ts StoredUpkeep), each relation's in its
 * functions' order (`upkeepRunsOf`), its DELETE before its INSERT, the relations in the theory's order, each after every
 * stored relation it reads, as phase A runs them stratum by stratum (physical/ddl/rules.ts addRules), each with the
 * deltas and stored tables it reads and the deltas its stored table's capture logs.
 */
const upkeepJudgeStatementsOf = (installation: Installation): ReadonlyArray<UpkeepStatement> =>
	Arr.flatMap(installation.laws.theory.upkeeps, (upkeep) => {
		const statements = upkeepRunsOf(installation, upkeep.relation)
		assert.ok(
			Arr.isReadonlyArrayNonEmpty(statements),
			`the upkeep of stored relation ${upkeep.relation}, its DELETE and its INSERT`
		)
		const writes = new Set(Arr.map(capturedDeltasOf(installation, upkeep.relation), (d) => d.name))
		return Arr.map(statements, ({ routine, run: statement }): UpkeepStatement => {
			const read = tablesReadBy((t) => modified(t, statement), routine)
			return {
				kind: "upkeep",
				routine,
				relation: upkeep.relation,
				statement,
				deltas: new Set(read.deltas),
				stored: new Set(read.stored),
				writes
			}
		})
	})

/**
 * Every statement the judge runs over the transaction's deltas (`JudgeStatement`), in the order it runs them: phase A's,
 * every stored relation's upkeep (`upkeepJudgeStatementsOf`), then phase B's, every rule's (`judgedStatementsOf`). The one
 * way a property picks the statements over a delta, a rule's and an upkeep's alike.
 */
export const judgeStatementsOf = (installation: Installation): ReadonlyArray<JudgeStatement> => [
	...upkeepJudgeStatementsOf(installation),
	...ruleStatementsOf(installation)
]

/**
 * The statements of `judgeStatementsOf` that test a rule, for a property of a rule's statements, its raise or its
 * query: those of phase B alone.
 */
export const judgedDeltaReadsOf = (installation: Installation): ReadonlyArray<RuleStatement> =>
	ruleStatementsOf(installation)

/** The deltas a statement of the judge fills as it runs: an upkeep's `writes`; a rule's test writes nothing. */
export const filledBy = (statement: JudgeStatement): ReadonlySet<string> => {
	switch (statement.kind) {
		case "rule":
			return new Set()
		case "upkeep":
			return statement.writes
	}
}

/** A judged statement explained over the deltas the transaction's captures logged: the statement and its plan. */
export interface JudgedPlan {
	readonly statement: JudgedStatement
	readonly plan: PlanNode
}

/**
 * A statement of the judge explained as the judge runs it (`judgeRun`): the statement and the plan PostgreSQL ran it by
 * (`planOf`).
 */
export interface JudgePlan<S extends JudgeStatement> {
	readonly statement: S
	readonly plan: PlanNode
}

/** One EXPLAIN ANALYZE of `sql` over `params`, its plan. */
const explained = <E>(
	values: Values<E>,
	sql: string,
	params: ReadonlyArray<unknown>
): Effect.Effect<PlanNode, E> =>
	Effect.map(
		values(`EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, SETTINGS, FORMAT JSON) ${sql}`, params),
		(rows) => succeeded(parsePlan(rows[0]?.[0]), "one EXPLAIN plan").plan
	)

/** The delta log of `installation` (sql/ast.ts CreateJudgeLog `deltas`), printed. */
const deltaLogOf = (installation: Installation): string =>
	defined(
		Arr.findFirst(installation.statements, (s) =>
			s.kind === "createJudgeLog" && s.log.kind === "deltas"
				? Option.some(printObjectName(s.table))
				: Option.none()
		).pipe(Option.getOrUndefined),
		"the installation's delta log"
	)

/**
 * `e` with each variable of `bound` read from the placeholder of its place: the text the session sends it at, its
 * value bound as a parameter of that type, and the values in that order.
 */
const boundOver = (
	e: Expr,
	bound: ReadonlyArray<{ readonly name: string; readonly type: TypeRef }>
): Expr =>
	new Transform({
		...identityHooks,
		expr: (x) => {
			if (x.kind !== "plVar") {
				return x
			}
			const at = Arr.findFirstIndex(bound, (b) => b.name === x.name).pipe(Option.getOrUndefined)
			const b = at === undefined ? undefined : bound[at]
			return at === undefined || b === undefined ? x : param(at + 1, b.type)
		}
	}).expr(e)

/**
 * The variables `walk` reads, each once, in the order it first reads them, each with its type in `routine`: what a
 * session binds the placeholders of a query of the routine's to, PostgreSQL requiring each placeholder it is sent to be
 * one the query reads.
 */
const readVariables = (
	walk: (transform: Transform) => unknown,
	routine: JudgeFunction
): ReadonlyArray<{ readonly name: string; readonly type: TypeRef }> => {
	const read = new Set<string>()
	walk(
		new Transform({
			...identityHooks,
			expr: (x) => {
				if (x.kind === "plVar") {
					read.add(x.name)
				}
				return x
			}
		})
	)
	return Arr.map([...read], (name) => ({
		name,
		type: defined(routine.typed.get(name), `the type of ${name} in ${routine.fn.name}`)
	}))
}

/** The variables of a routine as an interpretation of its body holds them (`interpreted`): each one's value, as text. */
type Variables = Map<string, unknown>

/**
 * The text of the query `select` with each variable it reads a placeholder, each column of its rows as text, and the
 * values of those variables in their places: what a session sends to read the query's rows as PL/pgSQL reads them.
 */
const sentQuery = (
	routine: JudgeFunction,
	env: Variables,
	select: OperandSelect,
	width: number
): { readonly sql: string; readonly params: ReadonlyArray<unknown> } => {
	const bound = readVariables((t) => t.select(select), routine)
	const transform = new Transform({
		...identityHooks,
		expr: (x) => (x.kind === "plVar" ? boundOver(x, bound) : x)
	})
	const columns = Array.from({ length: width }, (_, i) => `c${i + 1}`)
	return {
		sql: `SELECT ${Arr.join(
			Arr.map(columns, (c) => `x.${c}::text`),
			", "
		)} FROM (${printPlannedQuery({ kind: "query", query: transform.select(select) })}) AS x (${Arr.join(columns, ", ")})`,
		params: Arr.map(bound, (b) => env.get(b.name) ?? null)
	}
}

/** `e` as a query of one row of one column (`sentQuery`). */
const valueQuery = (e: Expr): OperandSelect =>
	simpleSelect([{ expr: e, alias: undefined }], [], undefined)

/**
 * Interprets `body`, statements of `routine`, over `env` as PL/pgSQL runs them, each query and expression read by the
 * session (`values`): an assignment, a statement INTO variables, a FOR over a query's rows, a CASE and an IF; a PERFORM,
 * a block's call, runs nothing. What the judge's netting and a part's making of its selections compute (physical/ddl/
 * deltas.ts netted, selectionsMade), each variable's value as text in `env`.
 */
const interpreted = <E>(
	values: Values<E>,
	routine: JudgeFunction,
	env: Variables,
	body: ReadonlyArray<PlStatement>
): Effect.Effect<void, E> =>
	Effect.forEach(
		body,
		(s): Effect.Effect<void, E> => {
			const rows = (select: OperandSelect, width: number) => {
				const q = sentQuery(routine, env, select, width)
				return values(q.sql, q.params)
			}
			const value = (e: Expr) => Effect.map(rows(valueQuery(e), 1), (r) => r[0]?.[0] ?? null)
			switch (s.kind) {
				case "assign":
					return Effect.map(value(s.value), (v) => {
						env.set(s.target, v)
					})
				case "into":
					return s.statement.kind !== "select"
						? Effect.void
						: Effect.map(rows(s.statement, s.into.length), (r) => {
								for (const [at, name] of s.into.entries()) {
									env.set(name, r[0]?.[at] ?? null)
								}
							})
				case "forQuery":
					return Effect.flatMap(rows(s.query, s.variables.length), (found) =>
						Effect.forEach(
							found,
							(row) => {
								for (const [at, name] of s.variables.entries()) {
									env.set(name, row[at] ?? null)
								}
								return interpreted(values, routine, env, s.body)
							},
							{ discard: true }
						)
					)
				case "case":
					return Effect.flatMap(
						Effect.forEach(s.whens, (w) =>
							Effect.map(
								value({ kind: "or", args: mapNonEmpty(w.values, (v) => eq(s.operand, v)) }),
								(hit) => ({ w, hit: hit === "true" })
							)
						),
						(hits) => {
							const hit = Arr.findFirst(hits, (h) => h.hit).pipe(Option.getOrUndefined)
							return hit === undefined ? Effect.void : interpreted(values, routine, env, hit.w.body)
						}
					)
				case "if":
					return Effect.flatMap(
						Effect.forEach(s.branches, (b) =>
							Effect.map(value(b.condition), (hit) => ({ b, hit: hit === "true" }))
						),
						(hits) => {
							const hit = Arr.findFirst(hits, (h) => h.hit).pipe(Option.getOrUndefined)
							return interpreted(values, routine, env, hit === undefined ? s.else : hit.b.body)
						}
					)
				case "perform":
				case "whenFound":
				case "wholeReads":
				case "raise":
				case "return":
				case "modify":
				case "returnQuery":
					return Effect.void
			}
		},
		{ discard: true }
	)

/** Whether `body` sets `variable`, at any depth: an assignment's or an INTO's target, or a FOR's variable. */
const sets = (body: ReadonlyArray<PlStatement>, variable: string): boolean =>
	Arr.some(body, (s) => {
		switch (s.kind) {
			case "assign":
				return s.target === variable
			case "into":
				return Arr.contains(s.into, variable)
			case "forQuery":
				return Arr.contains(s.variables, variable) || sets(s.body, variable)
			case "case":
				return Arr.some(s.whens, (w) => sets(w.body, variable))
			case "if":
				return Arr.some(s.branches, (b) => sets(b.body, variable)) || sets(s.else, variable)
			case "perform":
			case "whenFound":
			case "wholeReads":
			case "raise":
			case "return":
			case "modify":
			case "returnQuery":
				return false
		}
	})

/**
 * The judge's first netting of the delta `delta` (physical/ddl/deltas.ts netted, rules.ts nettingsOf): the statement of
 * the judge's body, the IF over whether the delta holds a row, that sets the delta's variable from its rows alone, never
 * the claim, which sets it from the log's rows it deletes; none where the judge nets no such delta, a side of olds.
 */
const nettingOf = (judge: JudgeFunction, delta: string): ReadonlyArray<PlStatement> =>
	Arr.filter(judge.body, (s) => s.kind === "if" && sets([s], delta)).slice(0, 1)

/**
 * The rows of the delta `delta` the judge's claim would take from the transaction's log as it holds them now, as text,
 * each capture's aggregated as the claim aggregates them (physical/ddl/rules.ts claimed), netted where the judge nets the
 * delta (deltas.ts netted, `nettingOf`): what the judge passes each part that reads the delta.
 */
export const nettedValue = <E>(
	values: Values<E>,
	installation: Installation,
	delta: string
): Effect.Effect<unknown, E> =>
	Effect.gen(function* () {
		const judge = defined(
			Arr.findFirst(
				judgeFunctionsOf(installation),
				(f) => f.fn.name === identifierOf(identity.ruleJudge())
			).pipe(Option.getOrUndefined),
			"the judge"
		)
		const raw = yield* values(
			`SELECT COALESCE(pg_catalog.array_agg(r2), '{}')::text FROM ${deltaLogOf(installation)} AS r1, LATERAL pg_catalog.unnest(r1.${quoteIdent(delta)}) AS r2`,
			[]
		)
		const env: Variables = new Map([[delta, raw[0]?.[0] ?? null]])
		yield* interpreted(values, judge, env, nettingOf(judge, delta))
		return env.get(delta) ?? null
	})

/**
 * The value of the argument `variable` of `routine` as the judge passes it where the transaction's log holds what it
 * holds now, as text: each delta's rows the log holds, each capture's, aggregated as the judge's claim aggregates them
 * (physical/ddl/rules.ts claimed), netted where the judge nets the delta (deltas.ts netted); then, where `variable` is a
 * selection, the part that makes it interpreted over its deltas so (`interpreted`), the rows it admits (deltas.ts
 * selectionsMade), the empty array where none stands.
 */
const argumentValue = <E>(
	values: Values<E>,
	installation: Installation,
	routine: JudgeFunction,
	variable: string
): Effect.Effect<unknown, E> =>
	Effect.gen(function* () {
		const functions = judgeFunctionsOf(installation)
		const nettedOf = (delta: string) => nettedValue(values, installation, delta)
		const delta = defined(deltaOfVariable(routine, variable), `the delta of argument ${variable}`)
		if (variable === delta) {
			return yield* nettedOf(delta)
		}
		const part = defined(
			Arr.findFirst(functions, (f) => sets(f.body, variable)).pipe(Option.getOrUndefined),
			`the part that makes the selection ${variable}`
		)
		const env: Variables = new Map()
		for (const name of part.params.keys()) {
			const netted = yield* nettedOf(name)
			env.set(name, netted)
		}
		yield* interpreted(values, part, env, part.body)
		return env.get(variable) ?? null
	})

/**
 * `query`, a query of the judge's routine `routine`, as a session sends it where the transaction's log holds what it
 * holds now: its text, each variable it reads a placeholder of its type, and each one's value as the judge would pass it
 * (`argumentValue`), so a measurement runs the routine's query over the rows the judge would read, read before anything
 * runs the judge, SET CONSTRAINTS ALL IMMEDIATE or COMMIT, whose claim empties the log.
 */
export const boundQuery = <E>(
	values: Values<E>,
	installation: Installation,
	routine: JudgeFunction,
	query: OperandSelect
): Effect.Effect<{ readonly sql: string; readonly params: ReadonlyArray<unknown> }, E> =>
	Effect.gen(function* () {
		const bound = readVariables((t) => t.select(query), routine)
		const params = yield* Effect.forEach(bound, (b) =>
			argumentValue(values, installation, routine, b.name)
		)
		const transform = new Transform({
			...identityHooks,
			expr: (x) => (x.kind === "plVar" ? boundOver(x, bound) : x)
		})
		return { sql: printPlannedQuery({ kind: "query", query: transform.select(query) }), params }
	})

/**
 * Whether the judge runs `statement` over the transaction's log as it holds it now: where an argument of its block
 * holds a row (`argumentValue`), since a part calls each block where one does (physical/ddl/rules.ts partBody). Read
 * before anything runs the judge, SET CONSTRAINTS ALL IMMEDIATE or COMMIT, whose claim empties the log.
 */
export const runsNow = <E>(
	values: Values<E>,
	installation: Installation,
	statement: JudgeStatement
): Effect.Effect<boolean, E> =>
	Effect.map(
		Effect.forEach([...statement.routine.params.keys()], (name) =>
			argumentValue(values, installation, statement.routine, name)
		),
		(held) => Arr.some(held, (a) => a !== "{}")
	)

/**
 * Each of `statements` the judge runs over the transaction's deltas, in their order, explained (EXPLAIN ANALYZE) as it
 * runs it: each statement whose block's arguments hold a row at its turn (physical/ddl/rules.ts partBody), each argument
 * its value as the judge would pass it over the log as it stands then (`argumentValue`), under its block's advice
 * (test/support/advice.ts routineAdviceHeld). An upkeep's write runs, as EXPLAIN ANALYZE runs a write, so its stored
 * table's captures log the rows it writes into the deltas it `writes`, which the statements after it read, as phase A's
 * writes do for phase B (rules.ts addRules); its writes stand after the measurement, as the judge's would, so a case that
 * measures again first ends the transaction or runs the judge, and measures over a write of its own. Explained before
 * anything runs the judge, SET CONSTRAINTS ALL IMMEDIATE or COMMIT, whose claim deletes the log's rows, so a statement
 * explained after it reads no row. A case writes through the captures of `installation`, explains, and only then runs
 * the judge, or defers it to a COMMIT it never reaches. The one measurement of the judge's statements every property
 * makes: one where no explained statement's arguments hold a row is refused, so no bound over the judge's work holds
 * over a log the judge claimed.
 */
export const judgeRun = <S extends JudgeStatement, E>(
	values: Values<E>,
	installation: Installation,
	statements: ReadonlyArray<S>
): Effect.Effect<ReadonlyArray<JudgePlan<S>>, E> =>
	Effect.gen(function* () {
		const plans: Array<JudgePlan<S>> = []
		for (const statement of statements) {
			const routine = statement.routine
			const held = yield* Effect.forEach([...routine.params.keys()], (name) =>
				argumentValue(values, installation, routine, name)
			)
			if (!Arr.some(held, (a) => a !== "{}")) {
				continue
			}
			const bound = readVariables(
				(t) =>
					statement.kind === "rule"
						? t.select(statement.statement.query)
						: modified(t, statement.statement),
				routine
			)
			const args = Arr.map(bound, (b) => held[[...routine.params.keys()].indexOf(b.name)] ?? null)
			const transform = new Transform({
				...identityHooks,
				expr: (x) => (x.kind === "plVar" ? boundOver(x, bound) : x)
			})
			const sql =
				statement.kind === "rule"
					? printPlannedQuery({ kind: "found", query: transform.select(statement.statement.query) })
					: printStatement(modified(transform, statement.statement))
			yield* values(routineAdviceHeld(routine.fn), [])
			plans.push({ statement, plan: yield* explained(values, sql, args) })
		}
		assert.ok(
			Arr.isReadonlyArrayNonEmpty(plans),
			"a judged statement reads a delta the transaction's captures logged a row into (explain before SET CONSTRAINTS ALL IMMEDIATE or COMMIT runs the judge, whose claim empties the log)"
		)
		return plans
	})

/**
 * Each of `statements`, rules' tests, the judge runs over the transaction's deltas, explained (`judgeRun`): the
 * measurement of a property of a rule's statements, which reads each plan beside its raise or its query.
 */
export const judgedPlans = <E>(
	values: Values<E>,
	installation: Installation,
	statements: ReadonlyArray<JudgedStatement>
): Effect.Effect<ReadonlyArray<JudgedPlan>, E> => {
	const functions = judgeFunctionsOf(installation)
	/** The block whose body tests a rule by `statement`. */
	const routineOf = (statement: JudgedStatement): JudgeFunction =>
		defined(
			Arr.findFirst(functions, (f) =>
				Arr.some(judgedStatementsIn(f.body), (s) => s.query === statement.query)
			).pipe(Option.getOrUndefined),
			"the judge's block holding a judged statement"
		)
	return Effect.map(
		judgeRun(
			values,
			installation,
			Arr.map(statements, (statement) => ruleStatementOf(routineOf(statement), statement))
		),
		(plans) =>
			Arr.map(plans, (p): JudgedPlan => ({ statement: p.statement.statement, plan: p.plan }))
	)
}

/**
 * Each statement of the upkeep of stored relation `relation` (`upkeepRunsOf`) explained (EXPLAIN ANALYZE) over the
 * transaction's log as the judge would run it (`judgeRun`), in its body's order, the removal's effect before the INSERT,
 * its writes standing after: what a case whose transaction rolls back whole explains itself, before anything runs the
 * judge, SET CONSTRAINTS ALL IMMEDIATE or COMMIT, whose claim empties the log.
 */
export const upkeepRuns = <E>(
	values: Values<E>,
	installation: Installation,
	relation: string
): Effect.Effect<ReadonlyArray<PlanNode>, E> =>
	Effect.map(
		judgeRun(
			values,
			installation,
			Arr.filter(upkeepJudgeStatementsOf(installation), (s) => s.relation === relation)
		),
		(plans) => Arr.map(plans, (p) => p.plan)
	)

/**
 * The upkeep's statements explained (`upkeepRuns`) under a savepoint the explanation rolls back to, so the upkeep's
 * table and the log stand as the captures left them.
 */
export const upkeepPlans = <E>(
	query: (sql: string) => Effect.Effect<unknown, E>,
	values: Values<E>,
	installation: Installation,
	relation: string
): Effect.Effect<ReadonlyArray<PlanNode>, E> =>
	Effect.gen(function* () {
		yield* query("SAVEPOINT upkeep_explained")
		const plans = yield* upkeepRuns(values, installation, relation)
		yield* query("ROLLBACK TO SAVEPOINT upkeep_explained")
		return plans
	})

/** The rows a scan reads a loop: its output and what its filters removed. */
export const scannedRowsOf = (n: PlanNode): number =>
	n.actualRows + n.rowsRemovedByFilter + n.rowsRemovedByIndexRecheck

/**
 * The table a plan node reads rows of, when it scans one: a sequential, index, index-only, bitmap heap or TID scan's
 * relation. A bitmap index scan's entries are its heap scan's rows, but those that rolled-back cases left in the
 * database's indexes besides, which no visible row answers.
 */
export const scannedTableOf = (n: PlanNode): Option.Option<string> =>
	n.nodeType !== "Bitmap Index Scan" && Str.endsWith(" Scan")(n.nodeType)
		? n.relation
		: Option.none()

/**
 * A read's work: its work as its scans read it (`scannedWork`) and every row each scan of a CTE reads over all of its
 * loops, its output and what its filter removed, where a CTE read at a correlated row's value is scanned whole for each
 * such row. A table the read's plan reads whole counts every row it reads, as any other read does: under its carried
 * advice the plan is the compiler's proof, and a whole read is one it proved (test/support/advice.ts).
 */
export const readWork = (plan: PlanNode): number =>
	scannedWork(plan) +
	Arr.reduce(
		Arr.filter(Arr.fromIterable(planNodes(plan)), (n) => n.nodeType === "CTE Scan"),
		0,
		(sum, n) => sum + scannedRows(n)
	)

/**
 * A plan's work as its scans read it: every row each scan of a stored relation reads (rowsRead) and each read of a
 * delta's array yields (rowsGenerated), over all of their loops. A row is counted where a scan reads it, never again at
 * a node it passes through: PostgreSQL sorted a touched group's two attempts read by (child, n) beside a few hundred
 * groups, and read them in order by the primary key beside a thousand, the same two rows read either way
 * (rule-aggregate.test.ts's locality).
 */
export const scannedWork = (plan: PlanNode): number => rowsRead(plan) + rowsGenerated(plan)

/** Statements run as one transaction committed on `session`, the judge run at its COMMIT, rolled back where one fails. */
export const committedJudged = (
	session: Pick<RawSession, "begin" | "query" | "commit" | "rollback">,
	statements: ReadonlyArray<string>
) =>
	Effect.gen(function* () {
		yield* session.begin
		for (const sql of statements) {
			yield* Effect.onError(session.query(sql, []), () => Effect.ignore(session.rollback))
		}
		yield* session.commit
	})
