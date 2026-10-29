import { Array as Arr, Option, Result, Schema } from "effect"
import { BudgetMeter } from "#compiler/core/budget.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import { compileBudgets } from "#compiler/core/policy.ts"
import * as Engine from "#compiler/core/result.ts"
import type { CertificateRule } from "#compiler/ir/certificate.ts"
import { makePassContext, type Pass } from "#compiler/ir/pass.ts"
import type { LogicalQuery } from "#compiler/ir/products.ts"
import { genCatalog } from "#test/support/evidence.ts"
import { validateDag } from "#test/support/oracle/dag-validate.ts"
import type { QueryCase } from "#test/support/oracle/gen/case.ts"
import { genParamDecls } from "#test/support/oracle/gen/query.ts"
import { Reference, unobserved } from "#test/support/oracle/reference/evaluate.ts"
import { forcedFailure, possibleFailures } from "#test/support/oracle/reference/frontier.ts"
import { ReferenceUnsupported } from "#test/support/oracle/reference/values.ts"

/**
 * What a query's answer is, by the frontier reference: an expression it needs must fail, one it may meet can fail, or
 * it delivers rows.
 */
type Verdict =
	| {
			readonly kind: "must fail"
			readonly codes: ReadonlySet<string>
			readonly possible: ReadonlySet<string>
	  }
	| { readonly kind: "may fail"; readonly possible: ReadonlySet<string> }
	| { readonly kind: "rows" }

export type VerdictKind = Verdict["kind"]

const verdictOf = (q: QueryCase, query: LogicalQuery): Verdict => {
	const ref = Reference.of(query.dag, {
		schema: q.schema,
		facts: q.facts,
		params: q.query.params,
		observer: unobserved
	})
	const possible = possibleFailures(ref, q.query.params).codes
	const forced = forcedFailure(ref, query.dag.roots[0], q.query.params)
	if (Option.isSome(forced)) {
		return { kind: "must fail", codes: forced.value.codes, possible }
	}
	return possible.size > 0 ? { kind: "may fail", possible } : { kind: "rows" }
}

/** The verdicts on a query before and after a rewrite, or the reference's refusal of one of them. */
const verdictsOf = (
	q: QueryCase,
	before: LogicalQuery,
	after: LogicalQuery
): Result.Result<{ readonly before: Verdict; readonly after: Verdict }, ReferenceUnsupported> =>
	Result.mapError(
		Result.try(() => ({ before: verdictOf(q, before), after: verdictOf(q, after) })),
		(e) => {
			if (Schema.is(ReferenceUnsupported)(e)) {
				return e
			}
			throw e
		}
	)

/** The SQLSTATEs a verdict lets an answer raise. */
const allowed = (v: Verdict): ReadonlySet<string> => {
	switch (v.kind) {
		case "must fail":
			return new Set([...v.codes, ...v.possible])
		case "may fail":
			return v.possible
		case "rows":
			return new Set()
	}
}

/**
 * What judging one rewrite of one case found: the original's verdict, or that the reference does not evaluate the
 * case; the rules the rewrite fired; and each broken promise, none when it kept them all.
 */
export interface RewriteFailures {
	readonly verdict: VerdictKind | "unsupported"
	readonly rules: ReadonlyArray<CertificateRule>
	readonly problems: ReadonlyArray<string>
}

const rewritten = (
	query: LogicalQuery,
	passes: ReadonlyArray<Pass<LogicalQuery, LogicalQuery>>,
	q: QueryCase
): {
	readonly result: Engine.Result<LogicalQuery, CompileError>
	readonly rules: ReadonlyArray<CertificateRule>
} => {
	const ctx = makePassContext({
		budgets: new BudgetMeter(compileBudgets),
		evidenceContext: "snapshot",
		catalog: genCatalog(q.schema)
	})
	let current: Engine.Result<LogicalQuery, CompileError> = Engine.ok(query)
	for (const pass of passes) {
		current = Engine.flatMap(current, (input) => pass.run(input, ctx))
	}
	return { result: current, rules: Arr.map(ctx.certificates.all(), (c) => c.rule) }
}

/**
 * The kernel's judgment of a rewrite's failures: whether rewriting a generated query keeps every failure its answer
 * needs and invents none, by the frontier reference (test/support/oracle/reference/frontier.ts).
 *
 * The frontier reference states which failures a query's answer needs on a case's facts (must fail: an expression on
 * the delivery's fully consumed spine fails in every evaluation order) and which it may meet (possible failures). A
 * rewrite keeps the answer's failures when a must-fail of the original stays a must-fail of the rewritten query, with
 * SQLSTATEs the original can raise, and invents none when every must-fail of the rewritten query is one the original
 * could already meet. A rewrite that refuses a small generated query under the real compiler budgets is a broken
 * promise too: a false ResourceBound.
 *
 * Rewrites a generated case's query by `passes` (named `name` in a broken promise) and judges its failures.
 */
export const rewriteFailures = (
	q: QueryCase,
	name: string,
	passes: ReadonlyArray<Pass<LogicalQuery, LogicalQuery>>
): RewriteFailures => {
	/** A generated DAG that breaks a rule is the generator's defect, which validateDag raises. */
	const query: LogicalQuery = { dag: validateDag(q.query.dag), params: genParamDecls(q.query) }
	const { result, rules } = rewritten(query, passes, q)
	if (!result.ok) {
		return {
			verdict: "unsupported",
			rules,
			problems: [`${name} refused the query: ${result.error.message}`]
		}
	}
	const verdicts = verdictsOf(q, query, result.value)
	if (Result.isFailure(verdicts)) {
		return { verdict: "unsupported", rules, problems: [] }
	}
	const { before, after } = verdicts.success
	const problems: Array<string> = []
	if (before.kind === "must fail" && after.kind !== "must fail") {
		problems.push(
			`${name} hid a failure the answer needs (${Arr.join([...before.codes], ", ")}): it now ${after.kind}`
		)
	}
	if (after.kind === "must fail") {
		const own = allowed(before)
		const invented = Arr.filter([...after.codes], (code) => !own.has(code))
		if (invented.length > 0) {
			problems.push(
				`${name} made the answer fail with ${Arr.join(invented, ", ")}, which the original cannot raise`
			)
		}
	}
	return { verdict: before.kind, rules, problems }
}
