import type { Draw, Explored, Run as SearchRun, SearchFailure } from "@grizzle/testing/explore"
import type { Gen } from "@grizzle/testing/gen"
import { Array as Arr, Effect, Option, Order, Record, Result, Schema, type Scope } from "effect"
import { BudgetMeter } from "#compiler/core/budget.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import { identity } from "#compiler/core/identity.ts"
import { compileBudgets } from "#compiler/core/policy.ts"
import * as Engine from "#compiler/core/result.ts"
import type { Certificate } from "#compiler/ir/certificate.ts"
import type { RelDag } from "#compiler/ir/rel.ts"
import { checkerEvidence } from "#compiler/logical/annotate.ts"
import { lowerConservative } from "#compiler/lower/conservative/index.ts"
import {
	conservativeInput,
	flight,
	statementOutput,
	type StatementRole,
	type StatementRoots
} from "#compiler/lower/conservative/types.ts"
import { lowerOptimized, optimizedInput } from "#compiler/lower/optimize/pipeline.ts"
import { deliveredAsOptimized, type OptimizedStatement } from "#compiler/lower/shapes/index.ts"
import { printObjectName } from "#compiler/sql/print.ts"
import { delivered, logicalQuery, normalizedCase } from "#test/pg/oracle/optimized/support.ts"
import { installedCatalog } from "#test/support/evidence.ts"
import { parsedSchemaName } from "#test/support/kernel/naming.ts"
import { messageOf } from "#test/support/message.ts"
import {
	compareRuns,
	holdsUnstated,
	printComparison,
	printRun,
	type Run,
	labeledStatements
} from "#test/support/oracle/compare.ts"
import { largeFormPrograms } from "#test/support/oracle/forms.ts"
import type { QueryCase } from "#test/support/oracle/gen/case.ts"
import { schemaDesc } from "#test/support/oracle/gen/schema.ts"
import { captureRows, type RawRow } from "#test/support/oracle/install/capture.ts"
import { factStatements } from "#test/support/oracle/install/load.ts"
import { oraclePlan } from "#test/support/oracle/install/real.ts"
import {
	CurrentPerturbation,
	multiplyFacts,
	plannerStatements
} from "#test/support/oracle/perturb.ts"

import {
	type ExpectedStatement,
	expectedStatements
} from "#test/support/oracle/reference/deliver.ts"
import { Reference, statingReference, unobserved } from "#test/support/oracle/reference/evaluate.ts"
import {
	type ForcedFailure,
	forcedFailure,
	possibleFailures
} from "#test/support/oracle/reference/frontier.ts"
import { renderExpected } from "#test/support/oracle/reference/render.ts"
import { ReferenceUnsupported } from "#test/support/oracle/reference/values.ts"
import {
	type CheckOptions,
	factSet,
	oracleCheck,
	printOracleCase,
	PropertyFailed,
	slotValue
} from "#test/support/oracle/runner.ts"
import { loweringViolations } from "#test/support/oracle/verify/index.ts"
import type { PgConnection, SqlError } from "#test/support/pg.ts"
import { pgErrorFields } from "#test/support/substrate/errors.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** The items joined by `separator`, or `none` when there is no item. */
const listed = (items: ReadonlyArray<string>, separator: string, none: string): string =>
	items.length === 0 ? none : Arr.join(items, separator)

/**
 * What one side answered: rows, or an execution error with its SQLSTATE and the label and role of the statement that
 * raised it.
 */
export type Answer =
	| { readonly kind: "rows"; readonly run: Run }
	| {
			readonly kind: "error"
			readonly code: string
			readonly message: string
			readonly statement: string
			readonly role: StatementRole["kind"]
	  }

/**
 * One form a case runs: the conservative lowering, the optimized artifact, or a per-execution variant of it, which
 * names the statement it replaces.
 */
type SideForm =
	| { readonly kind: "conservative" }
	| { readonly kind: "optimized" }
	| { readonly kind: "optimized variant"; readonly statement: number }

/** The kinds of form a case runs. */
export type FrontierForm = SideForm["kind"]

/** A forced failure as reports name it: its codes, its node and, in an attachment, the attachment. */
const printForced = (f: ForcedFailure): string =>
	`${Arr.join([...f.codes], ", ")} at ${f.node}${f.where.kind === "attachment" ? ` in the attachment ${f.where.attach}` : ""}`

/** A form as the name its reports carry. */
const formLabel = (form: SideForm): string =>
	form.kind === "optimized variant" ? `optimized variant ${form.statement}` : form.kind

/** What the reference states: the rows the definition delivers, the failure it meets, or nothing it can state. */
type Expected =
	| { readonly kind: "rows"; readonly statements: ReadonlyArray<ExpectedStatement> }
	| { readonly kind: "error"; readonly code: string }
	| { readonly kind: "unstated"; readonly what: string }

export interface FrontierOutcome {
	readonly case: QueryCase
	/** The failure every side must meet, when there is one: its SQLSTATE codes and where. */
	readonly forced: Option.Option<ForcedFailure>
	readonly possible: ReadonlySet<string>
	readonly expected: Expected
	readonly reference: Run | undefined
	readonly sides: ReadonlyArray<{
		readonly form: SideForm
		readonly answer: Answer
		readonly sql: ReadonlyArray<string>
		/**
		 * How many attachments its statements deliver as statements of their own, and how many fused into a parent's.
		 */
		readonly pipelined: number
		readonly fused: number
	}>
	readonly problems: ReadonlyArray<string>
	/** The optimized artifact's certificates: the rewrites it rests on. */
	readonly certificates: ReadonlyArray<Certificate>
}

/**
 * What one side's answer gets wrong `codes` naming the possible SQLSTATEs: a forced failure it does not meet, a code
 * the query cannot raise, or rows other than the reference's or, where the reference states none, other than the
 * conservative lowering's.
 */
const sideProblems = (
	side: FrontierOutcome["sides"][number],
	reference: Run | undefined,
	sides: FrontierOutcome["sides"],
	forced: Option.Option<ForcedFailure>,
	possible: ReadonlySet<string>,
	codes: string,
	expected: Expected
): ReadonlyArray<string> => {
	const a = side.answer
	const name = formLabel(side.form)
	if (Option.isSome(forced)) {
		if (a.kind === "rows") {
			return [
				`${name} delivered rows where a needed expression fails (${printForced(forced.value)})`
			]
		}
		return possible.has(a.code)
			? []
			: [`${name} raised ${a.code} (${a.message}); the query can raise only ${codes}`]
	}
	if (a.kind === "error") {
		return possible.has(a.code)
			? []
			: [`${name} raised ${a.code} (${a.message}) where the query can raise only ${codes}`]
	}
	if (reference === undefined) {
		/**
		 * Where the reference cannot state the rows (an operation it does not evaluate exactly, such as
		 * pgvector's distances), every lowering that delivers rows must deliver the conservative lowering's.
		 */
		const baseline = sides[0]
		if (
			expected.kind !== "unstated" ||
			baseline === undefined ||
			baseline === side ||
			baseline.answer.kind !== "rows"
		) {
			return []
		}
		const versus = compareRuns(baseline.answer.run, a.run)
		return !versus.equal || versus.rightDuplicates > 0
			? [
					`${name} disagrees with ${formLabel(baseline.form)}, which the reference cannot judge (${expected.what}):\n${printComparison(versus, formLabel(baseline.form), name)}\n${printRun(a.run)}`
				]
			: []
	}
	const comparison = compareRuns(reference, a.run)
	return !comparison.equal || comparison.rightDuplicates > 0
		? [
				`${name} disagrees with the reference:\n${printComparison(comparison, "reference", name)}\n${printRun(a.run)}`
			]
		: []
}

const compileMessage = (e: CompileError): string => e.message

const lowered = <A>(side: string, c: QueryCase, f: () => Engine.Result<A, CompileError>) =>
	Effect.try({
		try: f,
		catch: (e) =>
			PropertyFailed.make({
				report: `${side} lowering threw: ${messageOf(e)}\n${printOracleCase(c)}`
			})
	}).pipe(
		Effect.flatMap((r) =>
			r.ok
				? Effect.succeed(r.value)
				: Effect.fail(
						PropertyFailed.make({
							report: `${side} lowering refused: ${compileMessage(r.error)}\n${printOracleCase(c)}`
						})
					)
		)
	)

/** One form of a lowering: its statements, and the DAG its fused attachments name. */
interface Form {
	readonly form: SideForm
	readonly roots: StatementRoots<OptimizedStatement>
	readonly dag: RelDag
}

/**
 * Runs a form's statements inside a savepoint, each placeholder filled from the case or from the rows the statements
 * before it delivered: its rows with every fused attachment unfused, or the SQLSTATE that ended it.
 */
const answer = (
	session: PgConnection,
	c: QueryCase,
	form: Form
): Effect.Effect<Answer, PropertyFailed> =>
	Effect.gen(function* () {
		const name = formLabel(form.form)
		const exec = (sql: string) =>
			session
				.query(sql, [])
				.pipe(
					Effect.mapError((e) => PropertyFailed.make({ report: `${name}: ${sql}: ${String(e)}` }))
				)
		yield* exec("SAVEPOINT frontier")
		const statements = labeledStatements(form.roots)
		const ran: Array<ReadonlyArray<RawRow>> = []
		for (const { statement, label } of statements) {
			const params = Result.all(
				Arr.map(statement.params, (slot) => Result.fromNullishOr(slotValue(c, slot), () => slot))
			)
			if (Result.isFailure(params)) {
				return yield* PropertyFailed.make({
					report: `${name}: no value for a ${params.failure.kind} placeholder`
				})
			}
			const rows = yield* Effect.result(
				captureRows(session, statement.sql.text, params.success, {
					columns: statementOutput(statement.role, statement.heading, statement.fused).names.length
				})
			)
			if (Result.isFailure(rows)) {
				const fields = pgErrorFields(rows.failure)
				yield* exec("ROLLBACK TO SAVEPOINT frontier")
				return fields === undefined
					? yield* PropertyFailed.make({
							report: `${name}: ${String(rows.failure)}\n${statement.sql.text}`
						})
					: ({
							kind: "error",
							code: fields.code,
							message: fields.message,
							statement: label,
							role: statement.role.kind
						} satisfies Answer)
			}
			ran.push(rows.success)
		}
		yield* exec("RELEASE SAVEPOINT frontier")
		const d = yield* delivered(session, form.dag, { statements, rows: ran }, name, false).pipe(
			Effect.mapError((e) =>
				PropertyFailed.make({ report: `${e.stage} failed on ${e.side}: ${e.message}` })
			)
		)
		return { kind: "rows", run: d.run } satisfies Answer
	})

/**
 * The reference's statement of the case, from the IR alone, over its facts repeated `multiplier` times: past the
 * scaled reference's rows (evaluate.ts ScaledReference), what it cannot state.
 */
const expectedOf = (c: QueryCase, multiplier: number): Expected => {
	const stated = Result.try(() =>
		expectedStatements(
			statingReference(
				c.query.dag,
				{ schema: c.schema, facts: c.facts, params: c.query.params, observer: unobserved },
				multiplier
			),
			c.query.dag.roots[0]
		)
	)
	if (Result.isSuccess(stated)) {
		return { kind: "rows", statements: stated.success }
	}
	const e = stated.failure
	if (Schema.is(ReferenceUnsupported)(e)) {
		return e.refusal.kind === "fails"
			? { kind: "error", code: e.refusal.code }
			: { kind: "unstated", what: e.refusal.what }
	}
	throw e
}

/** Runs one case under both lowerings and judges every answer against the reference's frontier. */
const runFrontier = (
	input: QueryCase,
	options: { readonly schema: string }
): Effect.Effect<FrontierOutcome, PropertyFailed, Substrate> =>
	Effect.gen(function* () {
		const substrate = yield* Substrate
		const perturbation = yield* CurrentPerturbation
		const multiplied = normalizedCase({
			...input,
			facts: multiplyFacts(input.schema, input.facts, perturbation.multiplier)
		})
		/**
		 * The reference's statement over the repeated facts, before any SQL; one it cannot state there, such as a cross
		 * product the copies raise past the scaled reference's rows, runs with its facts as generated, every side alike,
		 * as the oracle runner runs it (runner.ts runNamed).
		 */
		const first = expectedOf(multiplied, perturbation.multiplier)
		const scaledPast = first.kind === "unstated" && perturbation.multiplier > 1
		const c = scaledPast ? normalizedCase(input) : multiplied
		const expected = scaledPast ? expectedOf(c, 1) : first
		const desc = schemaDesc(c.schema)
		const planned = oraclePlan(
			desc,
			identity.schema(parsedSchemaName(options.schema)),
			substrate.owner.role
		)
		if (!planned.ok) {
			return yield* PropertyFailed.make({ report: `install: ${compileMessage(planned.error)}` })
		}
		const plan = planned.value
		const facts = factStatements(plan, factSet(c))
		if (!facts.ok) {
			return yield* PropertyFailed.make({ report: `facts: ${facts.error.message}` })
		}
		const names = plan.installation.names
		const query = logicalQuery(c)
		const conservativeProgram = yield* lowered("conservative", c, () =>
			lowerConservative(conservativeInput(query), {
				names,
				params: query.params,
				subject: { kind: "query" },
				meter: new BudgetMeter(compileBudgets)
			})
		)
		const catalog = installedCatalog(plan.installation)
		/**
		 * The optimized lowering takes the query as a compilation hands it over (optimizedInput): its logical metadata
		 * derived, never stated.
		 */
		const optimizedProgram = yield* lowered("optimized", c, () =>
			Engine.flatMap(optimizedInput(query, checkerEvidence), (caseInput) =>
				lowerOptimized(caseInput, {
					names,
					catalog,
					subject: { kind: "query" },
					meter: new BudgetMeter(compileBudgets),
					context: "snapshot"
				})
			)
		)
		const violations = loweringViolations({
			optimized: optimizedProgram,
			alignment: { kind: "aligned", conservative: conservativeProgram },
			context: "snapshot",
			catalog
		})
		if (violations.length > 0) {
			return yield* PropertyFailed.make({
				report: `${Arr.join(violations, "\n")}\n${printOracleCase(c)}`
			})
		}
		const optimizedDag = optimizedProgram.query.dag
		const forms: Array<Form> = [
			{
				form: { kind: "conservative" },
				roots: deliveredAsOptimized(conservativeProgram).roots,
				dag: query.dag
			},
			{ form: { kind: "optimized" }, roots: optimizedProgram.roots, dag: optimizedDag }
		]
		for (const v of largeFormPrograms(optimizedProgram.roots, (l) => l)) {
			forms.push({
				form: { kind: "optimized variant", statement: v.statement },
				roots: v.roots,
				dag: optimizedDag
			})
		}
		const analysis = Reference.of(c.query.dag, {
			schema: c.schema,
			facts: c.facts,
			params: c.query.params,
			observer: unobserved
		})
		/** A failure the reference does not evaluate forces none. */
		const forced = Result.match(
			Result.mapError(
				Result.try(() => forcedFailure(analysis, c.query.dag.roots[0], c.query.params)),
				(e) => {
					if (Schema.is(ReferenceUnsupported)(e)) {
						return e
					}
					throw e
				}
			),
			{ onFailure: () => Option.none<ForcedFailure>(), onSuccess: (found) => found }
		)
		const possible = new Set([
			...possibleFailures(analysis, c.query.params).codes,
			...Option.match(forced, { onNone: () => [], onSome: (f) => [...f.codes] })
		])
		if (expected.kind === "error") {
			possible.add(expected.code)
		}
		const ran = yield* Effect.scoped(
			Effect.gen(function* () {
				const session = yield* substrate.admin.pin
				const exec = (sql: string) =>
					session.query(sql, []).pipe(
						Effect.mapError((e) =>
							PropertyFailed.make({
								report: `setup: ${sql}: ${String(e)}\n${printOracleCase(c)}`
							})
						)
					)
				yield* exec("BEGIN")
				return yield* Effect.gen(function* () {
					yield* exec("SET LOCAL statement_timeout = '30s'")
					for (const sql of plan.sql) {
						yield* exec(sql)
					}
					for (const sql of facts.value) {
						yield* exec(sql)
					}
					const tables = Arr.map(Record.values(plan.tables), (t) => printObjectName(t.name))
					if (tables.length > 0) {
						yield* exec(`ANALYZE ${Arr.join(tables, ", ")}`)
					}
					for (const sql of plannerStatements(perturbation)) {
						yield* exec(sql)
					}
					const sides: Array<FrontierOutcome["sides"][number]> = []
					for (const f of forms) {
						sides.push({
							form: f.form,
							answer: yield* answer(session, c, f),
							sql: Arr.map(flight(f.roots), (s) => s.sql.text),
							pipelined: Arr.filter(flight(f.roots), (s) => s.role.kind === "attachment").length,
							fused: Arr.reduce(flight(f.roots), 0, (n, s) => n + s.fused.length)
						})
					}
					const reference =
						expected.kind === "rows"
							? yield* renderExpected(session, plan, expected.statements).pipe(
									Effect.mapError((e) =>
										PropertyFailed.make({ report: `rendering the reference: ${String(e)}` })
									)
								)
							: undefined
					return { sides, reference }
				}).pipe(Effect.ensuring(Effect.ignore(session.query("ROLLBACK", []))))
			})
		)
		const codes = listed(Arr.sort([...possible], Order.String), ", ", "none")
		const problems = Arr.flatMap(ran.sides, (side) =>
			sideProblems(side, ran.reference, ran.sides, forced, possible, codes, expected)
		)
		return {
			case: c,
			forced,
			possible,
			expected,
			reference: ran.reference,
			sides: ran.sides,
			problems,
			certificates: optimizedProgram.certificates
		} satisfies FrontierOutcome
	})

/**
 * What a frontier case reaches: what the reference states, a column it leaves unstated (a term the host declines),
 * the failures it forces or allows, what each form answered, where an error was raised, how each form delivered its
 * attachments.
 */
export type FrontierFeature =
	| `reference ${Expected["kind"]}`
	| "reference attachment rows"
	| "an unstated declined column"
	| "forced failure"
	| "forced attachment failure"
	| "may fail"
	| `${FrontierForm} ${Answer["kind"]}`
	| `${FrontierForm} attachment statement error`
	| `${FrontierForm} fused`
	| `${FrontierForm} pipelined`

/**
 * The features of one outcome: what the reference states, the failures it forces or allows, what
 * each lowering answered, and how each delivered its attachments.
 */
const frontierFeatures = (o: FrontierOutcome): ReadonlyArray<FrontierFeature> => {
	const features = new Set<FrontierFeature>([`reference ${o.expected.kind}`])
	if (
		o.expected.kind === "rows" &&
		Arr.some(o.expected.statements, (st) => st.role === "attachment" && st.rows.length > 0)
	) {
		features.add("reference attachment rows")
	}
	if (o.reference !== undefined && holdsUnstated(o.reference)) {
		features.add("an unstated declined column")
	}
	if (Option.isSome(o.forced)) {
		features.add("forced failure")
	}
	if (Option.exists(o.forced, (f) => f.where.kind === "attachment")) {
		features.add("forced attachment failure")
	}
	if (o.possible.size > 0) {
		features.add("may fail")
	}
	for (const side of o.sides) {
		const form = side.form.kind
		features.add(`${form} ${side.answer.kind}`)
		if (side.answer.kind === "error" && side.answer.role === "attachment") {
			features.add(`${form} attachment statement error`)
		}
		if (side.fused > 0) {
			features.add(`${form} fused`)
		}
		if (side.pipelined > 0) {
			features.add(`${form} pipelined`)
		}
	}
	return [...features]
}

/**
 * The error-frontier differential runner: computed terms whose evaluation can fail, judged as "error or rows". An
 * execution failure of a query expression is an admitted typed outcome, never a NULL or a silently dropped row.
 *
 * One generated case with computed terms runs on PostgreSQL 19 under the conservative lowering and the optimized
 * artifact (every per-execution form it has), each statement program inside its own savepoint, so a lowering that
 * raises is recorded with its SQLSTATE and the statement that raised it instead of ending the case. An attachment's
 * statement reads its parent keys from the rows its parent statement delivered, and a fused attachment is unfused into
 * the rows its statement would deliver (optimized/support.ts), so failing terms inside an attachment's child are judged
 * like any other. The reference evaluator then decides what each side may answer
 * (test/support/oracle/reference/frontier.ts):
 *
 * - an expression on the delivery's fully consumed spine fails on a row the definition computes, or an attachment
 *   child's top expression fails on a row correlated with a delivered parent key: every side must raise, with a
 *   SQLSTATE some expression of the query can raise;
 * - otherwise, where the definition delivers rows, every side must deliver exactly those rows, as raw text multisets,
 *   or raise one of the SQLSTATEs some expression could raise on some value PostgreSQL could feed it (a pushed-down
 *   predicate, a constant folded at plan time, an aggregate overflowing in some input order);
 * - where the definition itself fails off the spine, a side may raise such a SQLSTATE or deliver rows, which the
 *   reference cannot state.
 *
 * A rewrite that drops a failing expression the answer needs (a column the answer reads pruned, a join removed),
 * moves one past a LIMIT that stops early, or raises where nothing can fail, is a disagreement. The case runs in
 * one rolled-back transaction under the case's plan perturbation, like every oracle case.
 *
 * Explores the draw's cases against the reference's frontier: each case is the one its sketch resolves to, drawn in the
 * property; its features, and those `note` adds, are noted through its case.
 */
export const exploreFrontier = <K, S extends string>(
	draw: Draw<K, Gen<QueryCase>>,
	label: string,
	check: CheckOptions<K, FrontierFeature | S>,
	note: (c: QueryCase, o: FrontierOutcome) => Iterable<S>
): Effect.Effect<Explored, SearchFailure | SqlError, SearchRun | Substrate | Scope.Scope> =>
	Effect.gen(function* () {
		const s = yield* Substrate
		const schema = yield* s.schema({ create: false, label })
		return yield* oracleCheck(draw, check, (resolved, k) =>
			Effect.gen(function* () {
				const c = k.draw(resolved)
				const o = yield* runFrontier(c, { schema })
				k.noteAll(frontierFeatures(o))
				k.noteAll(note(c, o))
				if (o.problems.length > 0) {
					return yield* PropertyFailed.make({ report: printFrontier(o) })
				}
			})
		)
	})

/** The printable report of an outcome whose answers broke the frontier. */
const printFrontier = (o: FrontierOutcome): string => {
	const lines = [printOracleCase(o.case)]
	lines.push(
		`reference: ${o.expected.kind === "rows" ? "rows" : o.expected.kind === "error" ? `fails with ${o.expected.code}` : `unstated (${o.expected.what})`}`
	)
	lines.push(
		`forced failure: ${Option.match(o.forced, { onNone: () => "none", onSome: printForced })}`
	)
	lines.push(`possible SQLSTATEs: ${listed([...o.possible], ", ", "none")}`)
	if (o.reference !== undefined) {
		lines.push(printRun(o.reference))
	}
	for (const p of o.problems) {
		lines.push(`PROBLEM: ${p}`)
	}
	for (const s of o.sides) {
		const name = formLabel(s.form)
		lines.push(
			`${name}: ${s.answer.kind === "rows" ? "rows" : `error ${s.answer.code} ${s.answer.message} in ${s.answer.statement}`}`
		)
		for (const [i, sql] of s.sql.entries()) {
			lines.push(`${name} statement ${i}:\n${sql}`)
		}
	}
	return Arr.join(lines, "\n")
}
