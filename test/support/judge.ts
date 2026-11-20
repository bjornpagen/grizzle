/** The rule judge's PL/pgSQL, as an installation creates it (physical/ddl/rules.ts addRules). */

import { assert, defined } from "@bjornpagen/testing/assert"
import { Array as Arr, Effect, Option, String as Str } from "effect"
import { type PlanNode, parsePlan, planNodes } from "#bench/harness/explain.ts"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { quoteIdent, quoteString } from "#compiler/core/text.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"
import type { OperandSelect, PlStatement } from "#compiler/sql/ast.ts"
import { printExpr, sessionTableCreate } from "#compiler/sql/print.ts"
import { identityHooks, Transform } from "#compiler/sql/transform.ts"
import { succeeded } from "#test/support/assert.ts"

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

/** The statements `body` tests a rule by (`JudgedStatement`), at any depth of the guards they stand under. */
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
		return first.kind === "raise" ? [{ query: s.query, raise: first }] : []
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
const sessionTablesOf = (query: OperandSelect): ReadonlyArray<string> => {
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
			return source
		}
	}).select(query)
	return named
}

/** A judged statement explained over the deltas the transaction's captures filled: the statement and its plan. */
export interface JudgedPlan {
	readonly statement: JudgedStatement
	readonly plan: PlanNode
}

/** Whether `plan` reads a row of one of `deltas`: a node over one returned or filtered out a row in some loop. */
const readsDeltaRow = (plan: PlanNode, deltas: ReadonlySet<string>): boolean =>
	Iterator.from(planNodes(plan)).some(
		(n) =>
			Option.exists(n.relation, (r) => deltas.has(r)) &&
			n.actualLoops * (n.actualRows + n.rowsRemovedByFilter + n.rowsRemovedByIndexRecheck) > 0
	)

/** Each delta the judge's parts stand up, by name: its CREATE, as the part runs it where the session holds none. */
const standUpsOf = (body: ReadonlyArray<PlStatement>): ReadonlyArray<readonly [string, string]> =>
	Arr.flatMap(body, (s): ReadonlyArray<readonly [string, string]> => {
		switch (s.kind) {
			case "createSessionTable":
				return Arr.isReadonlyArrayNonEmpty(s.columns)
					? [[s.name, sessionTableCreate(s.name, s.columns)]]
					: []
			case "if":
				return [...Arr.flatMap(s.branches, (b) => standUpsOf(b.body)), ...standUpsOf(s.else)]
			case "forQuery":
			case "whenFound":
				return standUpsOf(s.body)
			case "case":
				return Arr.flatMap(s.whens, (w) => standUpsOf(w.body))
			case "assign":
			case "perform":
			case "lockRows":
			case "modify":
			case "returnQuery":
			case "createSessionTrigger":
			case "raise":
			case "return":
				return []
		}
	})

/**
 * Each of `statements` the judge runs over the transaction's deltas, explained (EXPLAIN ANALYZE) as it would run it:
 * each statement that reads a delta holding a row (`sessionTablesOf`), one a capture of the transaction wrote into
 * (physical/ddl/rules.ts addCapture), as the judge runs a probe of a side and a whole rule's violation only where a
 * delta it reads holds one (rules.ts partBody), every other delta it reads stood up empty first, as the judge's
 * part stands up the deltas a whole rule's region reads beside the written ones (`standUpsOf`), explained before
 * anything runs the judge, SET CONSTRAINTS ALL IMMEDIATE or COMMIT, which deletes every row of each delta it reads
 * (rules.ts emptied), so a statement explained after it reads no row. A case writes through the captures of
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
		const standUps = new Map(standUpsOf(judgeBodiesOf(installation)))
		/** The standing deltas that hold a row: those the transaction's captures wrote, which the judge reads. */
		const candidates = Arr.filter(
			Arr.dedupe(Arr.flatMap(statements, (s) => sessionTablesOf(s.query))),
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
			Arr.some(sessionTablesOf(s.query), (t) => holding.has(t))
		)
		assert.ok(
			Arr.isReadonlyArrayNonEmpty(judged),
			"a judged statement reads a delta the transaction's captures wrote a row into"
		)
		for (const delta of new Set(Arr.flatMap(judged, (s) => sessionTablesOf(s.query)))) {
			if (!standing.has(delta)) {
				yield* values(
					defined(standUps.get(delta), `the judge stands up the delta ${delta} a statement reads`)
				)
			}
		}
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
				Arr.flatMap(judged, (s) => sessionTablesOf(s.query)),
				(d) => holding.has(d)
			)
		)
		assert.ok(
			Arr.some(plans, (p) => readsDeltaRow(p.plan, deltas)),
			`a judged statement reads a row of the deltas ${Arr.join(Arr.map([...deltas], quoteIdent), ", ")}: none does, so the judge emptied them before the measurement (explain before SET CONSTRAINTS ALL IMMEDIATE or COMMIT runs it)`
		)
		return plans
	})
