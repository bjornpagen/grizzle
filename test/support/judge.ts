/** The rule judge's PL/pgSQL, as an installation creates it (physical/ddl/rules.ts addRules). */

import { assert, defined } from "@bjornpagen/testing/assert"
import { Array as Arr, Effect, Option, String as Str } from "effect"
import {
	explainServerStatement,
	type MalformedPlan,
	type PlanNode,
	parsePlan,
	planNodes,
	rowsGenerated,
	rowsRead,
	scannedRows
} from "#bench/harness/explain.ts"
import type { BenchSession } from "#bench/harness/session.ts"
import { identifierOf, identity, upkeepParts } from "#compiler/core/identity.ts"
import { temporarySchema } from "#compiler/core/temporary.ts"
import { quoteIdent, quoteString } from "#compiler/core/text.ts"
import { standUpsOf } from "#compiler/deploy/diff/diff.ts"
import type { DeploySnapshot } from "#compiler/deploy/snapshot/types.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"
import type {
	ObjectName,
	OperandSelect,
	PlBlock,
	PlDeclaration,
	PlStatement,
	Select
} from "#compiler/sql/ast.ts"
import { lit } from "#compiler/sql/build.ts"
import {
	printExpr,
	printObjectName,
	printPlannedQuery,
	printStatement
} from "#compiler/sql/print.ts"
import { identityHooks, Transform } from "#compiler/sql/transform.ts"
import { routineAdviceHeld } from "#test/support/advice.ts"
import { succeeded } from "#test/support/assert.ts"
import { standUpCallsOf } from "#test/support/kernel/naming.ts"
import type { SqlError } from "#test/support/pg.ts"
import { tableOfSource } from "#test/support/sql.ts"
import type { CaseSession, RawSession } from "#test/support/substrate/session.ts"

/**
 * The bodies of the judge and of each of its parts, each a function of its own: the judge runs a part where the session
 * holds one of its deltas, and every statement that tests a rule stands in a part. A part is named by its identity's
 * stem, the judge's own followed by its first delta's relation (core/identity.ts ruleJudgePart).
 */
export const judgeBodiesOf = (installation: Installation): ReadonlyArray<PlStatement> =>
	Arr.flatMap(judgeFunctionsOf(installation), (f) => f.body)

/** The judge and each of its parts (`judgeBodiesOf`), each by its function's name and its body. */
const judgeFunctionsOf = (
	installation: Installation
): ReadonlyArray<{ readonly fn: ObjectName; readonly body: ReadonlyArray<PlStatement> }> => {
	const judge = identifierOf(identity.ruleJudge())
	return Arr.flatMap(installation.statements, (s) =>
		s.kind === "createFunction" &&
		s.language === "plpgsql" &&
		(s.name.name === judge || Str.startsWith(`${judge}_`)(s.name.name))
			? [{ fn: s.name, body: s.body.body }]
			: []
	)
}

/**
 * The stand-ups of `installation` (kernel/naming.ts standUpCallsOf) sent on `session`: outside a transaction each commits alone, so
 * the session holds the judge's tables for every transaction after; inside one they are that transaction's, as a case on
 * a rolled-back transaction needs (substrate.ts Substrate.rolledBack).
 */
export const standUpJudge = (session: Pick<CaseSession, "query">, installation: Installation) =>
	Effect.forEach(
		standUpCallsOf(installation, installation.names.schema),
		(sql) => session.query(sql, []),
		{
			discard: true
		}
	)

/**
 * The stand-ups of `relations` alone, each a table the rule judge holds, by its declared name, sent on `session`: what a
 * served write's session calls before its first write of them (adapter apply/stand-up.ts), the session tables a capture
 * of each requires and no other, where `standUpJudge` stands up every table's.
 */
export const standUpRelations = (
	session: Pick<CaseSession, "query">,
	installation: Installation,
	relations: ReadonlyArray<string>
) =>
	Effect.forEach(
		relations,
		(relation) =>
			session.query(
				`SELECT ${quoteIdent(installation.names.schema)}.${quoteIdent(identifierOf(identity.ruleStandUp(relation)))}()`,
				[]
			),
		{ discard: true }
	)

/**
 * A delta a table's capture writes (physical/ddl/rules.ts addCapture): its name, and the columns its INSERT names, a
 * side of news's count among them.
 */
export interface CapturedDelta {
	readonly name: string
	readonly columns: ReadonlyArray<string>
}

/** Every INSERT of `body` into a table of pg_temp, at any depth of the conditions it stands under, as a delta's write. */
const sessionInserts = (body: ReadonlyArray<PlStatement>): ReadonlyArray<CapturedDelta> =>
	Arr.flatMap(body, (s): ReadonlyArray<CapturedDelta> => {
		switch (s.kind) {
			case "if":
				return [
					...Arr.flatMap(s.branches, (b) => sessionInserts(b.body)),
					...sessionInserts(s.else)
				]
			case "modify":
				return s.statement.kind === "insert" &&
					typeof s.statement.table !== "string" &&
					s.statement.table.schema === temporarySchema
					? [{ name: s.statement.table.name, columns: s.statement.columns }]
					: []
			case "assign":
			case "case":
			case "createSessionTable":
			case "createSessionIndex":
			case "createSessionTrigger":
			case "forQuery":
			case "perform":
			case "raise":
			case "return":
			case "returnQuery":
			case "truncateSessionTable":
			case "whenFound":
				return []
			case "wholeReads":
				return sessionInserts(s.body)
		}
	})

/**
 * The deltas `relation`'s capture writes (physical/ddl/rules.ts addCapture), each once, in the order its body writes
 * them: every INSERT of its body into a table of pg_temp but the sentinel's, whose one column is the written set.
 */
export const capturedDeltasOf = (
	installation: Installation,
	relation: string
): ReadonlyArray<CapturedDelta> => {
	const capture = identifierOf(identity.ruleCapture(relation))
	return Arr.dedupeWith(
		Arr.filter(
			Arr.flatMap(installation.statements, (s) =>
				s.kind === "createFunction" && s.language === "plpgsql" && s.name.name === capture
					? sessionInserts(s.body.body)
					: []
			),
			(d) => !Arr.contains(d.columns, "__written")
		),
		(a, b) => a.name === b.name
	)
}

/**
 * The stand-ups of the installation `snapshot` records (deploy/diff/diff.ts standUpsOf) sent on `session`, as
 * `standUpJudge` sends an installation's: a writer outside grizzle's first statements over a migrated installation.
 */
export const standUpSnapshot = (session: Pick<CaseSession, "query">, snapshot: DeploySnapshot) =>
	Effect.forEach(
		standUpsOf(snapshot),
		(fn) => session.query(`SELECT ${quoteIdent(fn.schema)}.${quoteIdent(fn.name)}()`, []),
		{ discard: true }
	)

/** A RAISE of PL/pgSQL. */
type Raise = Extract<PlStatement, { readonly kind: "raise" }>

/**
 * A statement the judge tests a rule by: a whenFound (sql/build.ts) of the judge or a part, `query` the rule's query it
 * reads whole, and `raise`, what it runs where the query returns a row.
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

/** Every statement the judge and its parts test a rule by (`JudgedStatement`), in their bodies' order. */
export const judgedStatementsOf = (installation: Installation): ReadonlyArray<JudgedStatement> =>
	judgedStatementsIn(judgeBodiesOf(installation))

/** A statement a PL/pgSQL body runs for its effect (sql/ast.ts PlStatement `modify`). */
type Modified = Extract<PlStatement, { readonly kind: "modify" }>["statement"]

/** The statements a PL/pgSQL body runs for their effect, in its order. */
const modifiedIn = (body: ReadonlyArray<PlStatement>): ReadonlyArray<Modified> =>
	Arr.flatMap(body, (b): ReadonlyArray<Modified> => (b.kind === "modify" ? [b.statement] : []))

/**
 * The bodies of stored relation `relation`'s upkeep blocks (physical/ddl/rules.ts upkeepBlock, identity.storedUpkeep),
 * each block's in its function's order, the blocks in their parts' (upkeepParts): a unit form's one, or a delta form's
 * removal of the facts a write withdraws, then its insert of the facts it gains.
 */
export const upkeepBodyOf = (
	installation: Installation,
	relation: string
): ReadonlyArray<PlStatement> =>
	Arr.flatMap(upkeepBlocksOf(installation, relation), (block) => block.body)

/** The blocks of stored relation `relation`'s upkeep (`upkeepBodyOf`), in their parts' order. */
const upkeepBlocksOf = (installation: Installation, relation: string): ReadonlyArray<PlBlock> =>
	Arr.map(upkeepFunctionsOf(installation, relation), (f) => f.block)

/** The functions of stored relation `relation`'s upkeep (`upkeepBlocksOf`), each by its name and its block. */
const upkeepFunctionsOf = (
	installation: Installation,
	relation: string
): ReadonlyArray<{ readonly fn: ObjectName; readonly block: PlBlock }> =>
	Arr.flatMap(upkeepParts, (part) => {
		const named = identifierOf(identity.storedUpkeep(relation, part))
		return Arr.flatMap(installation.statements, (s) =>
			s.kind === "createFunction" && s.language === "plpgsql" && s.name.name === named
				? [{ fn: s.name, block: s.body }]
				: []
		)
	})

/**
 * A statement an upkeep's block runs (physical/ddl/rules.ts upkeepBlock): a write it runs once, its INSERT, or the loop
 * of its removal, which runs its body's writes, each DELETE of one row by its tuple id, once for each row its query
 * returns, `variable`, declared in the block, holding the row's value.
 */
export type UpkeepRun =
	| Modified
	| {
			readonly kind: "loop"
			readonly query: Select
			readonly variable: PlDeclaration
			readonly body: ReadonlyArray<Modified>
	  }

/**
 * The statements of the upkeep of stored relation `relation` (`upkeepBlocksOf`), in its blocks' order: each removal of
 * its rows its definition no longer holds, before the INSERT of its block, a unit form's of those it derives at the
 * written units, a delta form's of those it gained.
 */
const upkeepStatementsOf = (
	installation: Installation,
	relation: string
): ReadonlyArray<UpkeepRun> => Arr.map(upkeepRunsOf(installation, relation), (r) => r.run)

/** The statements of the upkeep of stored relation `relation` (`upkeepStatementsOf`), each with its block's routine. */
const upkeepRunsOf = (
	installation: Installation,
	relation: string
): ReadonlyArray<{ readonly routine: ObjectName; readonly run: UpkeepRun }> =>
	Arr.flatMap(upkeepFunctionsOf(installation, relation), ({ fn, block }) =>
		Arr.flatMap(
			block.body,
			(s): ReadonlyArray<{ readonly routine: ObjectName; readonly run: UpkeepRun }> => {
				if (s.kind === "modify") {
					return [{ routine: fn, run: s.statement }]
				}
				if (s.kind !== "forQuery") {
					return []
				}
				const variable = Arr.findFirst(block.declare, (d) => d.name === s.variable)
				assert.ok(
					Option.isSome(variable),
					`an upkeep's loop variable ${s.variable}, declared in its block`
				)
				return [
					{
						routine: fn,
						run: {
							kind: "loop",
							query: s.query,
							variable: variable.value,
							body: modifiedIn(s.body)
						}
					}
				]
			}
		)
	)

/**
 * The reads of each statement of the upkeep of stored relation `relation` (`upkeepStatementsOf`), each as the query of
 * the rows it reads: a loop's, its query, whose rows its DELETEs read the table at by their ids alone; an INSERT's, the
 * query its rows come from.
 */
export const upkeepReadsOf = (
	installation: Installation,
	relation: string
): ReadonlyArray<OperandSelect> =>
	Arr.flatMap(upkeepStatementsOf(installation, relation), (m): ReadonlyArray<OperandSelect> => {
		if (m.kind === "loop") {
			return [m.query]
		}
		return m.kind === "insert" && m.source.kind === "query" ? [m.source.query] : []
	})

/** One EXPLAIN ANALYZE of `sql`, its plan. */
const explained = <E>(
	values: (sql: string) => Effect.Effect<ReadonlyArray<ReadonlyArray<unknown>>, E>,
	sql: string
): Effect.Effect<PlanNode, E> =>
	Effect.map(
		values(`EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, SETTINGS, FORMAT JSON) ${sql}`),
		(rows) => succeeded(parsePlan(rows[0]?.[0]), "one EXPLAIN plan").plan
	)

/**
 * Each plan PostgreSQL runs `run` by, explained with ANALYZE in its order, as the judge's PL/pgSQL runs it: a write's
 * one; a loop's query's, then each write of its body once for each row its query returns, the loop's variable read as
 * the row's value cast to its declared type. The query's rows are the ones the loop reads, its snapshot taken before any
 * DELETE of its body runs, as PL/pgSQL's FOR over a query reads them.
 */
export const explainedRun = <E>(
	values: (sql: string) => Effect.Effect<ReadonlyArray<ReadonlyArray<unknown>>, E>,
	run: UpkeepRun
): Effect.Effect<ReadonlyArray<PlanNode>, E> =>
	Effect.gen(function* () {
		if (run.kind !== "loop") {
			return [yield* explained(values, printStatement(run))]
		}
		const text = printStatement(run.query)
		const read = yield* explained(values, text)
		const rows = yield* values(text)
		const each = yield* Effect.forEach(rows, (row) => {
			const at = new Transform({
				...identityHooks,
				expr: (e) =>
					e.kind === "plVar" && e.name === run.variable.name
						? lit.text(String(row[0]), run.variable.type)
						: e
			})
			return Effect.forEach(run.body, (m) => explained(values, printStatement(modified(at, m))))
		})
		return [read, ...Arr.flatten(each)]
	})

/**
 * Each statement of the upkeep of stored relation `relation` (`upkeepStatementsOf`) explained (EXPLAIN ANALYZE) over
 * the transaction's deltas as the judge would run it (`explainedRun`), in its body's order, the removal's effect before
 * the INSERT, its writes standing after: what a case whose transaction rolls back whole explains itself, before
 * anything runs the judge, SET CONSTRAINTS ALL IMMEDIATE or COMMIT, which empties the deltas.
 */
export const upkeepRuns = <E>(
	values: (sql: string) => Effect.Effect<ReadonlyArray<ReadonlyArray<unknown>>, E>,
	installation: Installation,
	relation: string
): Effect.Effect<ReadonlyArray<PlanNode>, E> =>
	Effect.map(
		Effect.forEach(upkeepStatementsOf(installation, relation), (m) => explainedRun(values, m)),
		Arr.flatten
	)

/**
 * The upkeep's statements explained (`upkeepRuns`) under a savepoint the explanation rolls back to, so the upkeep's
 * table and the deltas stand as the captures left them.
 */
export const upkeepPlans = <E>(
	query: (sql: string) => Effect.Effect<unknown, E>,
	values: (sql: string) => Effect.Effect<ReadonlyArray<ReadonlyArray<unknown>>, E>,
	installation: Installation,
	relation: string
): Effect.Effect<ReadonlyArray<PlanNode>, E> =>
	Effect.gen(function* () {
		yield* query("SAVEPOINT upkeep_explained")
		const plans = yield* upkeepRuns(values, installation, relation)
		yield* query("ROLLBACK TO SAVEPOINT upkeep_explained")
		return plans
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

/** The tables a statement reads: its deltas, by name, and its stored tables, printed (`tablesReadBy`). */
interface TablesRead {
	readonly deltas: ReadonlyArray<string>
	readonly stored: ReadonlyArray<string>
}

/**
 * The tables the statement `walk` visits reads, in the order its FROM items name them, at any depth, its subqueries'
 * among them, each the table of its source (`tableOfSource`): its deltas, each a table of pg_temp a FROM names or a delta a FROM reads through its reader (`readers`,
 * `readersOf`), and its stored tables, every other table a FROM names, printed as pg_locks' regclass reads them. A
 * write's target is no FROM of it: an upkeep's DELETE or INSERT reads its stored relation's table only where a FROM of
 * it names the table.
 */
const tablesReadBy = (
	walk: (transform: Transform) => unknown,
	readers: ReadonlyMap<string, string>
): TablesRead => {
	const deltas: Array<string> = []
	const stored: Array<string> = []
	walk(
		new Transform({
			...identityHooks,
			fromSource: (source) => {
				const table = tableOfSource(source)
				if (table !== undefined) {
					if (table.schema === temporarySchema) {
						deltas.push(table.name)
					} else {
						stored.push(printObjectName(table))
					}
				}
				if (source.kind === "function" && source.call.fn.kind === "qualified") {
					const delta = readers.get(source.call.fn.name)
					if (delta !== undefined) {
						deltas.push(delta)
					}
				}
				return source
			}
		})
	)
	return { deltas, stored }
}

/** The deltas a query reads (`tablesReadBy`). */
const sessionTablesOf = (
	query: OperandSelect,
	readers: ReadonlyMap<string, string>
): ReadonlyArray<string> => tablesReadBy((t) => t.select(query), readers).deltas

/**
 * Each delta's reader in `installation` by its function's name, the delta it reads (physical/ddl/rules.ts readers): a
 * PL/pgSQL function whose one statement returns the rows of a table of pg_temp, the delta, which the judge's statements
 * read the delta through.
 */
export const readersOf = (installation: Installation): ReadonlyMap<string, string> =>
	new Map(
		Arr.flatMap(installation.statements, (s) => {
			if (s.kind !== "createFunction" || s.language !== "plpgsql") {
				return []
			}
			const [only, ...rest] = s.body.body
			if (only.kind !== "returnQuery" || rest.length > 0) {
				return []
			}
			const [delta, ...others] = sessionTablesOf(only.query, new Map())
			return delta === undefined || others.length > 0 ? [] : [[s.name.name, delta] as const]
		})
	)

/** A statement of the judge that tests a rule (`JudgedStatement`), with the tables it reads. */
export interface RuleStatement {
	readonly kind: "rule"
	readonly routine: ObjectName
	readonly statement: JudgedStatement
	readonly deltas: ReadonlySet<string>
	readonly stored: ReadonlySet<string>
}

/**
 * A statement of a stored relation's upkeep (physical/ddl/rules.ts upkeepBlock, `UpkeepRun`), `relation` the stored
 * relation whose table it writes: its loop deleting the rows the relation's definition no longer derives at the units
 * the transaction wrote, or its INSERT of those it newly derives there, with the tables it reads, and `writes`, the
 * deltas its stored table's capture writes where a rule or an upkeep reads the relation (`capturedDeltasOf`), which the
 * upkeep's writes fill inside the judge, before every statement over them runs.
 */
export interface UpkeepStatement {
	readonly kind: "upkeep"
	readonly routine: ObjectName
	readonly relation: string
	readonly statement: UpkeepRun
	readonly deltas: ReadonlySet<string>
	readonly stored: ReadonlySet<string>
	readonly writes: ReadonlySet<string>
}

/**
 * A statement the judge runs over the session's deltas, where a delta it reads holds a row: a rule's test
 * (`RuleStatement`), or a stored relation's upkeep's write (`UpkeepStatement`), each beside the deltas it reads, by name,
 * through their readers (`readersOf`), its text naming no delta, and the stored tables it reads, printed.
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

/** A statement the judge tests a rule by in its routine `routine`, with the tables it reads (`RuleStatement`). */
const ruleStatementOf = (
	routine: ObjectName,
	statement: JudgedStatement,
	readers: ReadonlyMap<string, string>
): RuleStatement => {
	const read = tablesReadBy((t) => t.select(statement.query), readers)
	return {
		kind: "rule",
		routine,
		statement,
		deltas: new Set(read.deltas),
		stored: new Set(read.stored)
	}
}

/** Every statement the judge and its parts test a rule by (`judgedStatementsOf`), each in its routine, with the tables
 * it reads. */
const ruleStatementsOf = (
	installation: Installation,
	readers: ReadonlyMap<string, string>
): ReadonlyArray<RuleStatement> =>
	Arr.flatMap(judgeFunctionsOf(installation), (f) =>
		Arr.map(judgedStatementsIn(f.body), (statement) => ruleStatementOf(f.fn, statement, readers))
	)

/**
 * Every statement of every stored relation's upkeep (analysis/theory/unit.ts StoredUpkeep), each relation's in its
 * function's body's order (`upkeepStatementsOf`), its DELETE before its INSERT, the relations in the theory's order,
 * each after every stored relation it reads, as phase A runs them stratum by stratum (physical/ddl/rules.ts addRules),
 * each with the deltas and stored tables it reads and the deltas its stored table's capture writes.
 */
const upkeepJudgeStatementsOf = (
	installation: Installation,
	readers: ReadonlyMap<string, string>
): ReadonlyArray<UpkeepStatement> =>
	Arr.flatMap(installation.laws.theory.upkeeps, (upkeep) => {
		const statements = upkeepRunsOf(installation, upkeep.relation)
		assert.ok(
			Arr.isReadonlyArrayNonEmpty(statements),
			`the upkeep of stored relation ${upkeep.relation}, its DELETE and its INSERT`
		)
		const writes = new Set(Arr.map(capturedDeltasOf(installation, upkeep.relation), (d) => d.name))
		return Arr.map(statements, ({ routine, run: statement }): UpkeepStatement => {
			const read = tablesReadBy(
				(t) =>
					statement.kind === "loop"
						? [t.setQuery(statement.query), ...Arr.map(statement.body, (m) => modified(t, m))]
						: modified(t, statement),
				readers
			)
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
 * Every statement the judge runs over the session's deltas (`JudgeStatement`), in the order it runs them: phase A's,
 * every stored relation's upkeep (`upkeepJudgeStatementsOf`), then phase B's, every rule's (`judgedStatementsOf`). The one
 * way a property picks the statements over a delta, a rule's and an upkeep's alike, as every statement reads each delta
 * through its reader (`readersOf`).
 */
export const judgeStatementsOf = (installation: Installation): ReadonlyArray<JudgeStatement> => {
	const readers = readersOf(installation)
	return [
		...upkeepJudgeStatementsOf(installation, readers),
		...ruleStatementsOf(installation, readers)
	]
}

/**
 * The statements of `judgeStatementsOf` that test a rule, for a property of a rule's statements, its raise or its
 * query: those of phase B alone.
 */
export const judgedDeltaReadsOf = (installation: Installation): ReadonlyArray<RuleStatement> =>
	ruleStatementsOf(installation, readersOf(installation))

/**
 * Each plan PostgreSQL runs a statement of the judge by, explained with ANALYZE under the advice its routine's own SET
 * clause holds, as every call of it plans it (test/support/advice.ts routineAdviceHeld): a rule's test as its PERFORM's
 * SELECT (`plannedQueryOf`), an upkeep's statement as the judge runs it (`explainedRun`).
 */
const plansOf = <E>(
	values: (sql: string) => Effect.Effect<ReadonlyArray<ReadonlyArray<unknown>>, E>,
	statement: JudgeStatement
): Effect.Effect<ReadonlyArray<PlanNode>, E> =>
	Effect.andThen(values(routineAdviceHeld(statement.routine)), () => {
		switch (statement.kind) {
			case "rule":
				return Effect.map(explained(values, plannedQueryOf(statement.statement)), (plan) => [plan])
			case "upkeep":
				return explainedRun(values, statement.statement)
		}
	})

/** The deltas a statement of the judge fills as it runs: an upkeep's `writes`; a rule's test writes nothing. */
export const filledBy = (statement: JudgeStatement): ReadonlySet<string> => {
	switch (statement.kind) {
		case "rule":
			return new Set()
		case "upkeep":
			return statement.writes
	}
}

/** A judged statement explained over the deltas the transaction's captures filled: the statement and its plan. */
export interface JudgedPlan {
	readonly statement: JudgedStatement
	readonly plan: PlanNode
}

/**
 * A statement of the judge explained as the judge runs it (`judgeRun`): the statement and a plan PostgreSQL ran it by,
 * one of a write or a rule's test, and of an upkeep's loop one of its query and one of each run of its body
 * (`explainedRun`).
 */
export interface JudgePlan<S extends JudgeStatement> {
	readonly statement: S
	readonly plan: PlanNode
}

/**
 * Whether `plan` reads a row of one of `deltas`: a node over one, or over its reader, the function the judge's statements
 * read a delta through (`readersOf`), returned or filtered out a row in some loop.
 */
const readsDeltaRow = (
	plan: PlanNode,
	deltas: ReadonlySet<string>,
	readers: ReadonlyMap<string, string>
): boolean =>
	Iterator.from(planNodes(plan)).some(
		(n) =>
			(Option.exists(n.relation, (r) => deltas.has(r)) ||
				Option.exists(n.functionName, (f) => {
					const delta = readers.get(f)
					return delta !== undefined && deltas.has(delta)
				})) &&
			n.actualLoops * scannedRowsOf(n) > 0
	)

/**
 * Each of `statements` the judge runs over the transaction's deltas, in their order, explained (EXPLAIN ANALYZE) as it
 * runs it: each statement that reads a delta holding a row at its turn, one a capture of the transaction wrote into
 * (physical/ddl/rules.ts addCapture), as the judge runs an upkeep, a probe of a side and a whole rule's violation only
 * where a delta it reads holds one (rules.ts partBody), every other delta it reads standing empty, as the session's
 * stand-up made it (`standUpJudge`, rules.ts addStandUps). An upkeep's write runs, as EXPLAIN ANALYZE runs a write, so
 * its stored table's captures fill the deltas it `writes`, which the statements after it read, as phase A's writes fill
 * them for phase B (rules.ts addRules); its writes stand after the measurement, as the judge's would, so a case that
 * measures again first ends the transaction or runs the judge, and measures over a write of its own (no savepoint
 * serves: a case's connection runs each statement under one it releases, which releases every savepoint the statement
 * set, test/support/substrate/substrate.ts undoneAlone). Explained before anything
 * runs the judge, SET CONSTRAINTS ALL IMMEDIATE or COMMIT, which truncates each delta it reads (rules.ts emptied), so a
 * statement explained after it reads no row. A statement reads a delta through its reader (`readersOf`), and so does
 * each count of the rows it read. A case writes through the captures of `installation`, explains, and only then runs the
 * judge, or defers it to a COMMIT it never reaches. The one measurement of the judge's statements every property makes:
 * one where no statement reads a standing delta, or no explained statement reads a row of one, is refused, so no bound
 * over the judge's work holds over deltas the judge emptied.
 */
export const judgeRun = <S extends JudgeStatement, E>(
	values: (sql: string) => Effect.Effect<ReadonlyArray<ReadonlyArray<unknown>>, E>,
	installation: Installation,
	statements: ReadonlyArray<S>
): Effect.Effect<ReadonlyArray<JudgePlan<S>>, E> =>
	Effect.gen(function* () {
		const temporary = yield* values(
			"SELECT relname::text FROM pg_catalog.pg_class WHERE relnamespace = pg_catalog.pg_my_temp_schema()"
		)
		const standing = new Set(Arr.map(temporary, (row) => String(row[0])))
		const readers = readersOf(installation)
		/** Those of `deltas` that stand and hold a row. */
		const holdingOf = (deltas: Iterable<string>) => {
			const candidates = Arr.filter(Arr.dedupe([...deltas]), (d) => standing.has(d))
			return Arr.isReadonlyArrayNonEmpty(candidates)
				? Effect.map(
						values(
							Arr.join(
								Arr.map(
									candidates,
									(d) =>
										`SELECT ${quoteString(d)} WHERE EXISTS (SELECT FROM pg_temp.${quoteIdent(d)})`
								),
								" UNION ALL "
							)
						),
						(held) => Arr.map(held, (row) => String(row[0]))
					)
				: Effect.succeed([])
		}
		const written = yield* holdingOf(Arr.flatMap(statements, (s) => [...s.deltas]))
		/** The standing deltas that hold a row: those the transaction's captures wrote, which the judge reads, and those
		 * the upkeeps explained so far filled. */
		const holding = new Set(written)
		const plans: Array<JudgePlan<S>> = []
		for (const statement of statements) {
			if (!Arr.some([...statement.deltas], (d) => holding.has(d))) {
				continue
			}
			for (const plan of yield* plansOf(values, statement)) {
				plans.push({ statement, plan })
			}
			const filled = yield* holdingOf(filledBy(statement))
			for (const d of filled) {
				holding.add(d)
			}
		}
		assert.ok(
			Arr.isReadonlyArrayNonEmpty(plans),
			"a judged statement reads a delta the transaction's captures wrote a row into"
		)
		const deltas = new Set(
			Arr.filter(
				Arr.flatMap(plans, (p) => [...p.statement.deltas]),
				(d) => holding.has(d)
			)
		)
		assert.ok(
			Arr.some(plans, (p) => readsDeltaRow(p.plan, deltas, readers)),
			`a judged statement reads a row of the deltas ${Arr.join(Arr.map([...deltas], quoteIdent), ", ")}: none does, so the judge emptied them before the measurement (explain before SET CONSTRAINTS ALL IMMEDIATE or COMMIT runs it)`
		)
		return plans
	})

/**
 * Each of `statements`, rules' tests, the judge runs over the transaction's deltas, explained (`judgeRun`): the
 * measurement of a property of a rule's statements, which reads each plan beside its raise or its query.
 */
export const judgedPlans = <E>(
	values: (sql: string) => Effect.Effect<ReadonlyArray<ReadonlyArray<unknown>>, E>,
	installation: Installation,
	statements: ReadonlyArray<JudgedStatement>
): Effect.Effect<ReadonlyArray<JudgedPlan>, E> => {
	const readers = readersOf(installation)
	const functions = judgeFunctionsOf(installation)
	/** The routine whose body tests a rule by `statement`. */
	const routineOf = (statement: JudgedStatement): ObjectName =>
		defined(
			Arr.findFirst(functions, (f) =>
				Arr.some(judgedStatementsIn(f.body), (s) => s.query === statement.query)
			).pipe(
				Option.map((f) => f.fn),
				Option.getOrUndefined
			),
			"the judge's routine holding a judged statement"
		)
	return Effect.map(
		judgeRun(
			values,
			installation,
			Arr.map(statements, (statement) => ruleStatementOf(routineOf(statement), statement, readers))
		),
		(plans) =>
			Arr.map(plans, (p): JudgedPlan => ({ statement: p.statement.statement, plan: p.plan }))
	)
}

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
 * A statement's plan as every session grizzle opens runs it, the plan a bound over it reads: PREPAREd, then run by
 * EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, SETTINGS, FORMAT JSON) EXECUTE at `params`, each a parameter's text, under the
 * generic plans every session plans under (physical/ddl/roles.ts genericPlans, bench/harness/explain.ts
 * explainServerStatement), one plan for every value of them. EXPLAIN of the statement with its parameters bound plans
 * it at their values, a plan no session of grizzle runs: page-keys' window at a position most of its rows in read its
 * driver's table whole so, where the generic plan reads the driver's index in order.
 */
export const planAsRun = (
	values: BenchSession["values"],
	sql: string,
	params: ReadonlyArray<string>
): Effect.Effect<PlanNode, SqlError | MalformedPlan> =>
	Effect.map(
		explainServerStatement({ values }, sql, params, "generic", {
			serialize: { kind: "off" },
			wal: false,
			verbose: false
		}),
		(explained) => explained.plan
	)

/**
 * What an index probe of one row costs PostgreSQL at least, the index's leaf page and the table's page, each a random
 * page (costsize.c cost_index over genericcostestimate): twice random_page_cost, as the session reads it. A table
 * PostgreSQL reads whole for no more than that is a page or two, a read that costs what one probe of it would.
 */
export const probeCostOf = <E>(
	values: (sql: string) => Effect.Effect<ReadonlyArray<ReadonlyArray<unknown>>, E>
): Effect.Effect<number, E> =>
	Effect.map(
		values("SELECT pg_catalog.current_setting('random_page_cost')::pg_catalog.float8"),
		(rows) => 2 * Number(rows[0]?.[0])
	)

/** Whether `n` reads a table whole for no more than one probe costs (`probeCostOf`): a sequential scan of a page or two. */
const probeSized = (n: PlanNode, probeCost: number): boolean =>
	n.nodeType === "Seq Scan" && n.totalCost <= probeCost

/**
 * A plan's keyed work: its work as its scans read it (`scannedWork`), but the rows of each sequential scan of a table
 * no larger than one probe (`probeSized`), which PostgreSQL reads whole where a lookup of a key in it would cost as
 * much, a page or two whatever the key. With no planner setting, PostgreSQL scans a table of a few rows and looks a key
 * up in a larger one, so a bound over a write's keyed work holds at every size, small tables among them, and a read of
 * a table larger than a probe by anything but its key shows as the rows it reads (`wideScans`).
 */
export const keyedWork = (plan: PlanNode, probeCost: number): number =>
	scannedWork(plan) -
	Arr.reduce(Arr.fromIterable(planNodes(plan)), 0, (sum, n) =>
		probeSized(n, probeCost) ? sum + scannedRows(n) : sum
	)

/** The tables `plan` reads whole by a sequential scan that costs more than one probe (`probeCostOf`): each a read of a
 * table where a lookup of its key would serve, by its relation's name, once a scan. */
export const wideScans = (plan: PlanNode, probeCost: number): ReadonlyArray<string> =>
	Arr.flatMap(Arr.fromIterable(planNodes(plan)), (n) =>
		n.nodeType === "Seq Scan" && n.totalCost > probeCost ? Option.toArray(n.relation) : []
	)

/**
 * A read's keyed work: its keyed work (`keyedWork`) and every row each scan of a CTE reads over all of its loops, its
 * output and what its filter removed, where a CTE read at a correlated row's value is scanned whole for each such row.
 * The one measure of a read's work a lowering's bound holds with no planner setting, beside tables larger than a probe.
 */
export const keyedReadWork = (plan: PlanNode, probeCost: number): number =>
	keyedWork(plan, probeCost) +
	Arr.reduce(
		Arr.filter(Arr.fromIterable(planNodes(plan)), (n) => n.nodeType === "CTE Scan"),
		0,
		(sum, n) => sum + scannedRows(n)
	)

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
 * session's delta through its reader function yields (rowsGenerated), over all of their loops. A row is counted where a
 * scan reads it, never again at a node it passes through: PostgreSQL sorted a touched group's two attempts read by
 * (child, n) beside a few hundred groups, and read them in order by the primary key beside a thousand, the same two rows
 * read either way (rule-aggregate.test.ts's locality).
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
