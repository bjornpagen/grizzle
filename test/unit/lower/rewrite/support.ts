import { type Equivalence, multiset, ordered } from "@grizzle/testing/oracle"
import { Array as Arr, Option, Record as Rec, Result } from "effect"
import { BudgetMeter } from "#compiler/core/budget.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import type { NodeId } from "#compiler/core/ids.ts"
import { compileBudgets } from "#compiler/core/policy.ts"
import * as Engine from "#compiler/core/result.ts"
import type { Certificate, CertificateRule } from "#compiler/ir/certificate.ts"
import { rooted, topoOrder } from "#compiler/ir/dag.ts"
import type { EvidenceCatalog, TemplateContext } from "#compiler/ir/evidence.ts"
import type { ScalarExpr, TypedLiteral } from "#compiler/ir/expr.ts"
import { makePassContext, type Pass, type PassContext } from "#compiler/ir/pass.ts"
import type { LogicalQuery } from "#compiler/ir/products.ts"
import type { Heading, RelDag, RelNode } from "#compiler/ir/rel.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import { lowerConservative } from "#compiler/lower/conservative/index.ts"
import { conservativeInput, type ConservativeProgram } from "#compiler/lower/conservative/types.ts"
import { succeeded } from "#test/support/assert.ts"
import { ownedFixture } from "#test/support/evidence.ts"
import { standInNames } from "#test/support/kernel/naming.ts"
import { validateDag } from "#test/support/oracle/dag-validate.ts"
import type { QueryCase } from "#test/support/oracle/gen/case.ts"
import { canonicalFacts } from "#test/support/oracle/gen/facts.ts"
import { type GenParam, genParamDecls } from "#test/support/oracle/gen/query.ts"
import type { GenSchema } from "#test/support/oracle/gen/schema.ts"
import { nonEmptyList } from "#test/support/oracle/pick.ts"
import {
	type ExpectedStatement,
	expectedStatements
} from "#test/support/oracle/reference/deliver.ts"
import {
	Reference,
	type ReferenceInput,
	unobserved
} from "#test/support/oracle/reference/evaluate.ts"
import {
	distinctRows,
	equal,
	ReferenceUnsupported,
	type Row
} from "#test/support/oracle/reference/values.ts"
import { ledgerSchema, type Q, type RelationSpec } from "#test/unit/lower/conservative/fixtures.ts"

/**
 * Shared helpers for the rewrite tests: pass contexts, running passes, and the reference comparison every rewrite is
 * held to.
 *
 * A rewrite is correct when the rewritten query delivers what the original delivers: the same statements, under the
 * same headings, with the same sets of rows. The PostgreSQL suites run the optimized lowering against the conservative
 * one; here, without a database, the brute-force reference evaluator (test/support/oracle/reference) computes both
 * deliveries on the host, by definition, sharing nothing with any lowering.
 */

/**
 * The catalog of the ledger schema the hand-built queries read (conservative/fixtures.ts), every key named as
 * ownership installs it.
 */
export const ledgerCatalog: EvidenceCatalog = ownedFixture(ledgerSchema).catalog

/** A fresh pass context over a catalog, in an evidence context, under grizzle's compiler budgets. */
export const passContext = (options: {
	readonly catalog: EvidenceCatalog
	readonly evidence: TemplateContext
}): PassContext =>
	makePassContext({
		budgets: new BudgetMeter(compileBudgets),
		evidenceContext: options.evidence,
		catalog: options.catalog
	})

export interface Ran {
	readonly query: LogicalQuery
	readonly certificates: ReadonlyArray<Certificate>
}

/** Runs passes in order over one context. */
export const runPasses = (
	query: LogicalQuery,
	passes: ReadonlyArray<Pass<LogicalQuery, LogicalQuery>>,
	ctx: PassContext
): Engine.Result<Ran, CompileError> => {
	let current: Engine.Result<LogicalQuery, CompileError> = Engine.ok(query)
	for (const pass of passes) {
		current = Engine.flatMap(current, (q) => pass.run(q, ctx))
	}
	return Engine.map(current, (q) => ({ query: q, certificates: ctx.certificates.all() }))
}

/** A built DAG as a query, its first root the query's. */
export const queryOf = (dag: RelDag, params: LogicalQuery["params"]): LogicalQuery => {
	const valid = validateDag(dag)
	return { dag: rooted(nonEmptyList(valid.roots, "the query's roots")), params }
}

/** What a query delivers by the reference: its statements in delivery order, each a set of rows. */
const delivery = (
	dag: RelDag,
	root: RelNode,
	input: ReferenceInput
): ReadonlyArray<ExpectedStatement> => expectedStatements(Reference.of(dag, input), root)

const headingNames = (s: ExpectedStatement): string =>
	Arr.join(
		Arr.map(s.heading, (c) => c.name),
		", "
	)

/** One row against another under the reference's native equality, column by column at `heading`'s types. */
const rowEquivalence =
	(heading: Heading): Equivalence<Row> =>
	(left, right) =>
		left.length === right.length &&
		Arr.every(heading, (c, i) => {
			const a = left[i]
			const b = right[i]
			return a !== undefined && b !== undefined && equal(a, b, c.type)
		})
			? Option.none()
			: Option.some("a row has no natively equal row")

/**
 * One statement against another: the same label, the same heading names in order, and the same set of rows under the
 * reference's native equality per column (reference/values.ts equal), each side deduplicated by distinctRows.
 */
const statementEquivalence: Equivalence<ExpectedStatement> = (left, right) => {
	if (left.label !== right.label) {
		return Option.some(`the statement ${left.label} is not ${right.label}`)
	}
	if (headingNames(left) !== headingNames(right)) {
		return Option.some(
			`${left.label}: the heading (${headingNames(left)}) is not (${headingNames(right)})`
		)
	}
	const difference = multiset(rowEquivalence(left.heading))(
		distinctRows(left.rows, left.heading, `the left statement ${left.label}`),
		distinctRows(right.rows, right.heading, `the right statement ${right.label}`)
	)
	return Option.map(difference, (found) => `${left.label}: ${found}`)
}

const deliveryEquivalence: Equivalence<ReadonlyArray<ExpectedStatement>> =
	ordered(statementEquivalence)

/** A delivery in a report: each statement's label, heading names and row count. */
const printDelivery = (statements: ReadonlyArray<ExpectedStatement>): string =>
	Arr.join(
		Arr.map(statements, (s) => `${s.label} (${headingNames(s)}): ${s.rows.length} rows`),
		"; "
	)

/** Throws the difference and both deliveries unless both queries deliver alike from `input`. */
export const sameDelivery = (
	input: ReferenceInput,
	expected: LogicalQuery,
	actual: LogicalQuery
): void => {
	const want = delivery(expected.dag, expected.dag.roots[0], input)
	const got = delivery(actual.dag, actual.dag.roots[0], input)
	const difference = deliveryEquivalence(want, got)
	if (Option.isSome(difference)) {
		throw new Error(
			`expected and actual disagree: ${difference.value}\nexpected: ${printDelivery(want)}\nactual: ${printDelivery(got)}`
		)
	}
}

export type RewriteAgreement = "agree" | "unsupported"

/**
 * Whether the rewritten query delivers what the original delivers, by the reference; "unsupported" when the
 * reference cannot evaluate the original (a form outside its fragment).
 */
export const agrees = (c: QueryCase, rewritten: LogicalQuery): RewriteAgreement => {
	const input: ReferenceInput = {
		schema: c.schema,
		facts: c.facts,
		params: c.query.params,
		observer: unobserved
	}
	const evaluated = Result.try({
		try: (): ReadonlyArray<ExpectedStatement> => delivery(c.query.dag, c.query.dag.roots[0], input),
		catch: (thrown): unknown => thrown
	})
	if (Result.isFailure(evaluated)) {
		if (evaluated.failure instanceof ReferenceUnsupported) {
			return "unsupported"
		}
		throw evaluated.failure
	}
	const expected = evaluated.success
	const rewrittenDelivery = delivery(rewritten.dag, rewritten.dag.roots[0], input)
	const difference = deliveryEquivalence(expected, rewrittenDelivery)
	if (Option.isSome(difference)) {
		throw new Error(
			`the rewritten query delivers another result: ${difference.value}\noriginal: ${printDelivery(expected)}\nrewritten: ${printDelivery(rewrittenDelivery)}`
		)
	}
	return "agree"
}

/**
 * The conservative lowering of a rewritten query: the rewrites produce IR every lowering accepts, and every statement
 * passes the structural audit (sql/emit.ts).
 * Physical names with a text domain stand-in per pattern, as an installation names every pattern a case reads: a
 * delivered refined value the lowering cannot prove is cast to its domain, which must have a name.
 */
const rewriteNames = standInNames("rewrite")

/** The conservative lowering of a query, under grizzle's compiler budgets. */
export const lowerConservatively = (
	query: LogicalQuery
): Engine.Result<ConservativeProgram, CompileError> =>
	lowerConservative(conservativeInput(query), {
		names: rewriteNames,
		params: query.params,
		subject: { kind: "query" },
		meter: new BudgetMeter(compileBudgets)
	})

export const lowersConservatively = (query: LogicalQuery): void => {
	succeeded(lowerConservatively(query))
}

export const caseQuery = (c: QueryCase): LogicalQuery => ({
	dag: validateDag(c.query.dag),
	params: genParamDecls(c.query)
})

export const rulesOf = (certs: ReadonlyArray<Certificate>): ReadonlyArray<CertificateRule> =>
	Arr.map(certs, (c) => c.rule)

/**
 * A hand-built case's reference input: its relations, keyed by their primary keys alone, their facts, the parameter
 * values and the containments.
 */
const handInput = (
	relations: ReadonlyArray<RelationSpec>,
	facts: Readonly<Record<string, ReadonlyArray<ReadonlyArray<TypedLiteral>>>>,
	params: Readonly<Record<string, GenParam>>,
	containments: GenSchema["containments"]
): ReferenceInput => ({
	schema: {
		name: "Rewrite",
		relations: Arr.map(relations, (r) => ({
			name: r.name,
			columns: Arr.map(r.heading, (c) => ({ name: c.name, type: c.type })),
			primaryKey: r.primaryKey,
			keys: [],
			mutable: false
		})),
		closed: [],
		containments
	},
	facts: canonicalFacts(facts),
	params,
	observer: unobserved
})

/** The facts of a hand-built case, by relation. */
export type HandFacts = Readonly<Record<string, ReadonlyArray<ReadonlyArray<TypedLiteral>>>>

/** Every subset of `items`, each in their order, the empty one first. */
const subsetsOf = <A>(items: ReadonlyArray<A>): ReadonlyArray<ReadonlyArray<A>> => {
	const empty: ReadonlyArray<ReadonlyArray<A>> = [[]]
	return Arr.reduce(items, empty, (subsets, item) => [
		...subsets,
		...Arr.map(subsets, (subset) => [...subset, item])
	])
}

/**
 * Every database whose relations each hold a subset of their candidate facts: the small scope a hand-built rewrite is
 * judged over. A case's candidates are the facts its rule is about (two rows agreeing on a non-key column, a fact on
 * each side of a join, a reference with no target), so every combination of them, the empty one included, is checked
 * rather than one chosen database.
 */
export const factSubsets = (candidates: HandFacts): ReadonlyArray<HandFacts> => {
	const empty: ReadonlyArray<HandFacts> = [{}]
	return Arr.reduce(Rec.toEntries(candidates), empty, (databases, [relation, facts]) =>
		Arr.flatMap(databases, (db) =>
			Arr.map(subsetsOf(facts), (chosen): HandFacts => ({ ...db, [relation]: chosen }))
		)
	)
}

/**
 * Throws sameDelivery's report unless the rewritten query delivers what the original delivers on every database of
 * `databases`, read as `relations` under `containments`.
 */
export const deliversAlikeOn = (
	databases: ReadonlyArray<HandFacts>,
	relations: ReadonlyArray<RelationSpec>,
	containments: GenSchema["containments"],
	original: LogicalQuery,
	rewritten: LogicalQuery
): void => {
	for (const facts of databases) {
		sameDelivery(handInput(relations, facts, {}, containments), original, rewritten)
	}
}

/** The nodes of a DAG of one kind. */
export const nodesOf = <K extends RelNode["kind"]>(
	dag: RelDag,
	kind: K
): ReadonlyArray<Extract<RelNode, { kind: K }>> =>
	Arr.filter(topoOrder(dag), (n): n is Extract<RelNode, { kind: K }> => n.kind === kind)

/**
 * A column reference to a node outside the reading node's inputs: an enclosing region (often a reserved id defined
 * later) or an earlier occurrence's source, read by a correlated source.
 */
export const outerCol = (q: Q, node: NodeId, name: string, type: ScalarType): ScalarExpr =>
	q.b.expr({
		kind: "column",
		column: { node, name },
		args: [],
		type,
		nonNull: "storage"
	})
