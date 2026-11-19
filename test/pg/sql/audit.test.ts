import { assert, defined } from "@bjornpagen/testing/assert"
/**
 * PostgreSQL as the second oracle of the SQL generator and of the structural audit (test/support/oracle/verify/sql.ts).
 *
 * Every statement the kernel's generator draws (sqlgen.ts statementGen) passes both audits by construction; here
 * PostgreSQL 19 plans it too, with EXPLAIN (GENERIC_PLAN), over the generator's catalog installed from the same AST
 * (a table's first column its key). A statement the audit admits and PostgreSQL refuses is a bug in the generator, the
 * printer or the audit.
 *
 * The audit rules that mirror PostgreSQL's own (scope, the visibility of ON, LATERAL, a write's target and a MERGE
 * WHEN, a data-modifying CTE's placement, clauses merged across a parenthesized body, a set operation's widths) are
 * checked from the other side: each Wild operator of such a rule (test/unit/sql/audit/operators.ts), at a drawn site,
 * is refused by PostgreSQL as well, with a SQLSTATE of the expected class; and the faithful rewrite that makes a
 * derived table LATERAL is planned. The lists SQL requires to be nonempty are NonEmpty by type (sql/ast.ts), and the
 * zero-width forms PostgreSQL spells by absence, which the generator draws, are each required to plan here.
 *
 * Oracle: PostgreSQL itself, EXPLAIN (GENERIC_PLAN) of each statement.
 *
 * Features: each statement kind it plans, each Wild operator of a mirrored rule PostgreSQL refuses, the LATERAL
 * rewrite planned, each zero-width form planned, and the shape of every statement it plans.
 */
import { aimed } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect, Formatter, String as Str } from "effect"
import type { SqlStatement } from "#compiler/sql/ast.ts"
import { printStatement } from "#compiler/sql/print.ts"
import {
	type AuditFeature,
	auditCaseGen,
	auditCatalog,
	auditTemplate,
	cases,
	explainText,
	lateralCountAims,
	nulls,
	situations
} from "#test/pg/sql/audit.fixtures.ts"
import { shapeFeatures, shapeOf } from "#test/support/kernel/shape.ts"
import { breaks, oneHole } from "#test/support/kernel/sqlgen.ts"
import { pickFrom } from "#test/support/pick.ts"
import { pgErrorFields } from "#test/support/substrate/errors.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { lateralRewrite, mirroredBreaks } from "#test/unit/sql/audit/operators.ts"

/**
 * PostgreSQL plans every generated statement, and refuses every break of a rule that mirrors its own, each case on the
 * worker's seat of the catalog.
 *
 * Its pre-conversion budget: runs 150, coverage cases 150 (test/pg/sql/audit.test.ts at f6a7126a8).
 */
export const plansEveryGeneratedStatementAndRefusesEveryBreakOfARuleThatMirrorsItsOwn =
	property.explore(aimed(auditCaseGen(auditCatalog), lateralCountAims), {
		needs: { catalog: Substrate.seat(auditTemplate) },
		situations,
		check:
			({ catalog }, c: Case<AuditFeature>) =>
			({ statement, sites }) =>
				Effect.scoped(
					Effect.flatMap(catalog, (seat) =>
						Effect.provideService(
							Effect.gen(function* () {
								const s = yield* Substrate
								const plan = (statement: SqlStatement) => {
									const text = explainText(statement)
									return Effect.matchEffect(s.admin.query(text, nulls(text)), {
										onSuccess: () => Effect.void,
										onFailure: (error) => {
											const fields = pgErrorFields(error)
											return fields === undefined ? Effect.fail(error) : Effect.succeed(fields)
										}
									})
								}
								const refused = yield* plan(statement)
								if (refused !== undefined) {
									assert.fail(
										`PostgreSQL refused a generated statement with ${refused.code}: ${refused.message}\n${printStatement(statement)}`
									)
								}
								const shape = shapeOf(statement)
								c.note(`statement ${shape.statement}`)
								c.noteAll(shapeFeatures(shape))
								for (const [i, { operator, sqlstateClass }] of mirroredBreaks.entries()) {
									const [first, ...rest] = breaks(statement, operator)
									if (first === undefined) {
										continue
									}
									const broken = pickFrom(
										[first, ...rest],
										defined(sites[i], "a drawn site")
									).statement
									const fields = yield* plan(broken)
									if (fields === undefined || !Str.startsWith(sqlstateClass)(fields.code)) {
										assert.fail(
											`${operator.name}: PostgreSQL ${fields === undefined ? "planned it" : `refused it with ${fields.code}: ${fields.message}`}, not with class ${sqlstateClass}\n${printStatement(broken)}`
										)
									}
									c.note(`refused ${operator.name}`)
								}
								const [first, ...rest] = oneHole(statement, lateralRewrite.holes)
								if (first !== undefined) {
									const site = defined(
										sites[mirroredBreaks.length],
										"the LATERAL rewrite's drawn site"
									)
									const admitted = pickFrom([first, ...rest], site).statement
									const fields = yield* plan(admitted)
									if (fields !== undefined) {
										assert.fail(
											`PostgreSQL refused a LATERAL rewrite with ${fields.code}: ${fields.message}\n${printStatement(admitted)}`
										)
									}
									c.note("lateral planned")
								}
							}),
							Substrate,
							seat.substrate
						)
					)
				),
		oracle: { kind: "postgresql", name: "EXPLAIN (GENERIC_PLAN) of each statement" },
		show: Formatter.format,
		budget: { runs: cases, steered: cases },
		kept: [],
		kills: []
	})
