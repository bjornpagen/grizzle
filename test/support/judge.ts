/** The rule judge's PL/pgSQL, as an installation creates it (physical/ddl/rules.ts addRules). */

import { Array as Arr, Option, String as Str } from "effect"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"
import type { OperandSelect, PlStatement } from "#compiler/sql/ast.ts"
import { printExpr } from "#compiler/sql/print.ts"

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
