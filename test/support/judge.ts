/** The rule judge's PL/pgSQL, as an installation creates it (physical/ddl/rules.ts addRules). */

import { assert } from "@bjornpagen/testing/assert"
import { Array as Arr, Effect, Option, String as Str } from "effect"
import { type PlanNode, parsePlan, planNodes } from "#bench/harness/explain.ts"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { temporarySchema } from "#compiler/core/temporary.ts"
import { quoteIdent, quoteString } from "#compiler/core/text.ts"
import { standUpsOf } from "#compiler/deploy/diff/diff.ts"
import type { DeploySnapshot } from "#compiler/deploy/snapshot/types.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"
import type { OperandSelect, PlStatement } from "#compiler/sql/ast.ts"
import { printExpr } from "#compiler/sql/print.ts"
import { identityHooks, Transform } from "#compiler/sql/transform.ts"
import { succeeded } from "#test/support/assert.ts"
import { standUpCallsOf } from "#test/support/kernel/naming.ts"
import type { CaseSession } from "#test/support/substrate/session.ts"

/**
 * The bodies of the judge and of each of its parts, each a function of its own: the judge runs a part where the session
 * holds one of its deltas, and every statement that tests a rule stands in a part. A part is named by its identity's
 * stem, the judge's own followed by its first delta's relation (core/identity.ts ruleJudgePart).
 */
export const judgeBodiesOf = (installation: Installation): ReadonlyArray<PlStatement> => {
	const judge = identifierOf(identity.ruleJudge())
	return Arr.flatMap(installation.statements, (s) =>
		s.kind === "createFunction" &&
		s.language === "plpgsql" &&
		(s.name.name === judge || Str.startsWith(`${judge}_`)(s.name.name))
			? s.body.body
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
			case "createSessionTrigger":
			case "forQuery":
			case "perform":
			case "raise":
			case "return":
			case "returnQuery":
			case "truncateSessionTable":
			case "whenFound":
				return []
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

/**
 * A judged statement as the SQL PostgreSQL plans for it: the SELECT whose keyword its PERFORM replaces, `SELECT 1 FROM
 * (<query>) AS "found"`, for all its rows (pl_exec.c exec_stmt_perform).
 */
export const plannedQueryOf = (statement: JudgedStatement): string =>
	`SELECT 1 FROM ${printExpr({ kind: "subquery", query: statement.query })} AS "found"`

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

/** The session's tables a query reads, its deltas: every table of pg_temp a FROM of it names. */
const sessionTablesOf = (
	query: OperandSelect,
	readers: ReadonlyMap<string, string>
): ReadonlyArray<string> => {
	const named: Array<string> = []
	new Transform({
		...identityHooks,
		fromSource: (source) => {
			if (
				source.kind === "table" &&
				typeof source.table !== "string" &&
				source.table.schema === "pg_temp"
			) {
				named.push(source.table.name)
			}
			if (source.kind === "function" && source.call.fn.kind === "qualified") {
				const delta = readers.get(source.call.fn.name)
				if (delta !== undefined) {
					named.push(delta)
				}
			}
			return source
		}
	}).select(query)
	return named
}

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

/** A statement the judge tests a rule by, and the deltas it reads, by name (`sessionTablesOf`). */
export interface DeltaReads {
	readonly statement: JudgedStatement
	readonly deltas: ReadonlySet<string>
}

/**
 * Every statement the judge and its parts test a rule by (`judgedStatementsOf`), each beside the deltas it reads, by
 * name: the one way a property picks the statements over a delta, as a statement reads each delta through its reader
 * (`readersOf`) and its text names no delta.
 */
export const judgedDeltaReadsOf = (installation: Installation): ReadonlyArray<DeltaReads> => {
	const readers = readersOf(installation)
	return Arr.map(judgedStatementsOf(installation), (statement) => ({
		statement,
		deltas: new Set(sessionTablesOf(statement.query, readers))
	}))
}

/** A judged statement explained over the deltas the transaction's captures filled: the statement and its plan. */
export interface JudgedPlan {
	readonly statement: JudgedStatement
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
 * Each of `statements` the judge runs over the transaction's deltas, explained (EXPLAIN ANALYZE) as it would run it:
 * each statement that reads a delta holding a row (`sessionTablesOf`), one a capture of the transaction wrote into
 * (physical/ddl/rules.ts addCapture), as the judge runs a probe of a side and a whole rule's violation only where a
 * delta it reads holds one (rules.ts partBody), every other delta it reads standing empty, as the session's stand-up
 * made it (`standUpJudge`, rules.ts addStandUps), explained before anything runs the judge, SET CONSTRAINTS ALL IMMEDIATE or COMMIT, which truncates each delta it reads
 * (rules.ts emptied), so a statement explained after it reads no row. A statement reads a delta through its reader
 * (`readersOf`), and so does each count of the rows it read. A case writes through the captures of
 * `installation`, explains, and only then runs the judge, or defers it to a COMMIT it never reaches. The one measurement
 * of the judge's statements every property makes: one where no statement reads a standing delta, or no explained
 * statement reads a row of one, is refused, so no bound over the judge's work holds over deltas the judge emptied.
 */
export const judgedPlans = <E>(
	values: (sql: string) => Effect.Effect<ReadonlyArray<ReadonlyArray<unknown>>, E>,
	installation: Installation,
	statements: ReadonlyArray<JudgedStatement>
): Effect.Effect<ReadonlyArray<JudgedPlan>, E> =>
	Effect.gen(function* () {
		const temporary = yield* values(
			"SELECT relname::text FROM pg_catalog.pg_class WHERE relnamespace = pg_catalog.pg_my_temp_schema()"
		)
		const standing = new Set(Arr.map(temporary, (row) => String(row[0])))
		const readers = readersOf(installation)
		/** The standing deltas that hold a row: those the transaction's captures wrote, which the judge reads. */
		const candidates = Arr.filter(
			Arr.dedupe(Arr.flatMap(statements, (s) => sessionTablesOf(s.query, readers))),
			(d) => standing.has(d)
		)
		const held = Arr.isReadonlyArrayNonEmpty(candidates)
			? yield* values(
					Arr.join(
						Arr.map(
							candidates,
							(d) => `SELECT ${quoteString(d)} WHERE EXISTS (SELECT FROM pg_temp.${quoteIdent(d)})`
						),
						" UNION ALL "
					)
				)
			: []
		const holding = new Set(Arr.map(held, (row) => String(row[0])))
		const judged = Arr.filter(statements, (s) =>
			Arr.some(sessionTablesOf(s.query, readers), (t) => holding.has(t))
		)
		assert.ok(
			Arr.isReadonlyArrayNonEmpty(judged),
			"a judged statement reads a delta the transaction's captures wrote a row into"
		)
		const plans = yield* Effect.forEach(judged, (statement) =>
			Effect.map(
				values(
					`EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, SETTINGS, FORMAT JSON) ${plannedQueryOf(statement)}`
				),
				(explained): JudgedPlan => ({
					statement,
					plan: succeeded(parsePlan(explained[0]?.[0]), "one EXPLAIN plan").plan
				})
			)
		)
		const deltas = new Set(
			Arr.filter(
				Arr.flatMap(judged, (s) => sessionTablesOf(s.query, readers)),
				(d) => holding.has(d)
			)
		)
		assert.ok(
			Arr.some(plans, (p) => readsDeltaRow(p.plan, deltas, readers)),
			`a judged statement reads a row of the deltas ${Arr.join(Arr.map([...deltas], quoteIdent), ", ")}: none does, so the judge emptied them before the measurement (explain before SET CONSTRAINTS ALL IMMEDIATE or COMMIT runs it)`
		)
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
 * The planner settings a case explains a judged statement's probes under: the hash and merge joins and the
 * materialization of a nested loop's inner side off, so PostgreSQL reads every join by a nested loop that runs its inner
 * side again for each outer row, which it plans as a lookup at that row's values where an index serves one
 * (test/support/oracle/perturb.ts plannerSettings). At a case's few hundred rows PostgreSQL would read a negation's
 * inner side whole, every row once, hashed or materialized, which says nothing of a lookup; at edullm's scale, analyzed,
 * it plans the lookup itself: on PostgreSQL 19rc2 over 100,000 identifiers of 50 packages, analyzed, the ledger's probe
 * is a nested loop anti join reading one row a loop through the image's index, with every setting at its default. So a
 * property of the lookups is over analyzed tables, as autovacuum leaves a stored one.
 */
export const lookupSettings = [
	"SET LOCAL enable_hashjoin = off",
	"SET LOCAL enable_mergejoin = off",
	"SET LOCAL enable_material = off"
] as const
