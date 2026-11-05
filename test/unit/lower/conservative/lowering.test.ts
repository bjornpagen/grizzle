import { describe, it } from "@effect/vitest"
import { drawn, exhaust, explore } from "@grizzle/testing/explore"
import { noCoverage, requiredInSpace } from "@grizzle/testing/features"
import { element, filter, map, oneOf } from "@grizzle/testing/gen"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Record as Rec } from "effect"
import type { CompileError } from "#compiler/core/errors.ts"
import { makeIdSupply, type ParamId } from "#compiler/core/ids.ts"
import type * as Result from "#compiler/core/result.ts"
import { topoOrder } from "#compiler/ir/dag.ts"
import type { LogicalQuery, ParamDecl } from "#compiler/ir/products.ts"
import {
	type CompletedOrder,
	conservativeMeta,
	exprsOf,
	inputsOf,
	type RelNode
} from "#compiler/ir/rel.ts"
import { type ScalarType, sameScalarType } from "#compiler/ir/scalar.ts"
import { lowerConservative } from "#compiler/lower/conservative/index.ts"
import {
	conservativeInput,
	type ConservativeOptions,
	type ConservativeProgram,
	flight
} from "#compiler/lower/conservative/types.ts"
import { nativeOp } from "#compiler/scalar/compute/registry.ts"
import type { Select } from "#compiler/sql/ast.ts"
import { printStatement } from "#compiler/sql/print.ts"
import { identityHooks, transformStatement } from "#compiler/sql/transform.ts"
import { breachGuard } from "#compiler/write/refusal.ts"
import { assert, nonEmpty, refused, succeeded, throwsDefect } from "#test/support/assert.ts"
import {
	localVectorSchema,
	productionNames,
	standInNames,
	unitCarrier
} from "#test/support/kernel/naming.ts"
import { featureCount, has, shapeOf } from "#test/support/kernel/shape.ts"
import { caseHang } from "#test/support/limits.ts"
import { validateDag } from "#test/support/oracle/dag-validate.ts"
import { defaultGenConfig, type QueryCase, queryCaseGen } from "#test/support/oracle/gen/case.ts"
import { genParamDecls } from "#test/support/oracle/gen/query.ts"
import { auditStatementViolations, auditTextViolations } from "#test/support/oracle/verify/sql.ts"
import { everyKind } from "#test/unit/ir/fixture.ts"
import {
	Account,
	asc,
	Posting,
	plainRegion,
	Q,
	T,
	Task
} from "#test/unit/lower/conservative/fixtures.ts"
import * as Cases from "#test/unit/lower/conservative/queries.ts"
import { present } from "#test/unit/lower/support.ts"

/**
 * The conservative lowering: the dispatch over every kind, the delivery of heading groups and its refusals.
 * What a lowered statement computes is checked on PostgreSQL against the reference evaluator
 * (test/pg/oracle/conservative), and its SQL by the structural audit over every lowered case
 * (test/unit/sql/audit.test.ts); a statement's text is asserted nowhere. The rules here, each an exhaustive property
 * over a planted space no generator draws:
 *
 * - every kind lowers, statements passing both audits, unless the node reads what the lowering refuses: a feedback
 *   reference outside its recursion (MalformedDescription), a rewrite's internal node or an approximate search the
 *   catalogue cannot resolve (UnsupportedOperation, both subjects), or a delta in a query, which has no carrier;
 * - a heterogeneous union delivered to the host is one statement per heading group, its take's order apart from the
 *   delivery order in the merge, a filter applied per group; matched inside a statement it is a UNION over the common
 *   columns; any other node over it, and an attachment on an arm of a group of several, is refused;
 * - an outer reference resolves only to a node in scope that one occurrence reads.
 */

const names = productionNames("Ledger", { kind: "declared" }, localVectorSchema)

type Subject = "query" | "readBack"

/**
 * What production passes to lower a query: its declared parameters and the subject; a write program's read back
 * supplies the deltas it reads as a carrier.
 */
const optionsFor = (params: ReadonlyArray<ParamDecl>, subject: Subject): ConservativeOptions => ({
	names,
	params,
	subject:
		subject === "query"
			? { kind: "query" }
			: {
					kind: "readBack",
					deltas: () => ({ carrier: unitCarrier(1), columns: ["c1", "c2", "c3", "c4"] }),
					breach: breachGuard("Ledger")
				}
})

const lowered = (query: LogicalQuery): Result.Result<ConservativeProgram, CompileError> =>
	lowerConservative(conservativeInput(query), optionsFor(query.params, "query"))

/**
 * What a node reads that the conservative lowering refuses, by the rule it breaks: read by walking its inputs, the
 * feedback reference counted only outside the recursion whose step reads it.
 */
interface Reads {
	readonly feedbackOutside: boolean
	readonly rewrite: boolean
	/** An operator of no native overload, which the lowering cannot spell; a search's exact top-k it lowers. */
	readonly unresolvedSearch: boolean
	readonly delta: boolean
}

const readsOf = (root: RelNode): Reads => {
	/** Each node with whether it was visited inside a recursion: the walk's seen-set. */
	const seen = new Map<RelNode, Set<boolean>>()
	const reads = { feedbackOutside: false, rewrite: false, unresolvedSearch: false, delta: false }
	const visit = (node: RelNode, inRecursion: boolean): void => {
		const known = seen.get(node)
		if (known?.has(inRecursion) === true) {
			return
		}
		seen.set(node, new Set([...(known ?? []), inRecursion]))
		if (node.kind === "SelfRef" && !inRecursion) {
			reads.feedbackOutside = true
		}
		if (node.kind === "Window" || node.kind === "OrderedSetAggregate") {
			reads.rewrite = true
		}
		if (node.kind === "Delta") {
			reads.delta = true
		}
		for (const expr of exprsOf(node)) {
			if (expr.kind === "op" && nativeOp(expr.op) === undefined) {
				reads.unresolvedSearch = true
			}
		}
		for (const input of inputsOf(node)) {
			visit(input, inRecursion || node.kind === "Recursive")
		}
	}
	visit(root, false)
	return reads
}

type KindOutcome = "lowered" | "MalformedDescription" | "UnsupportedOperation"

const kindOutcome = (reads: Reads, subject: Subject): KindOutcome =>
	reads.feedbackOutside
		? "MalformedDescription"
		: reads.rewrite || reads.unresolvedSearch || (reads.delta && subject === "query")
			? "UnsupportedOperation"
			: "lowered"

describe("the kind table", () => {
	it.effect(
		"lowers every node of the every-kind fixture, audited, unless it reads what the lowering refuses",
		(ctx) => {
			const { dag, nodes } = everyKind(makeIdSupply())
			return searched(
				ctx,
				exhaust(
					{
						suite: "unit/lower/conservative/kinds",
						literal: Formatter.format,
						generator: (source) =>
							[
								source.draw(
									element(nonEmpty(Rec.toEntries(nodes), "the every-kind fixture's nodes"))
								),
								source.draw(element<Subject>(["query", "readBack"]))
							] as const,
						limit: 128,
						coverage: requiredInSpace<`${KindOutcome} ${Subject}`>([
							"lowered query",
							"lowered readBack",
							"MalformedDescription query",
							"UnsupportedOperation query",
							"UnsupportedOperation readBack"
						]),
						caseHang
					},
					([[key, root], subject], c) =>
						Effect.sync(() => {
							const expected = kindOutcome(readsOf(root), subject)
							const r = lowerConservative({ dag, root }, optionsFor([], subject))
							c.note(`${expected} ${subject}`)
							if (expected !== "lowered") {
								refused(r, expected, key)
								return
							}
							for (const statement of flight(succeeded(r, key).roots)) {
								assert.deepEqual(auditStatementViolations(statement.ast), [], key)
								assert.deepEqual(auditTextViolations(statement.sql.text), [], key)
								assert.equal(printStatement(statement.ast), statement.sql.text, key)
							}
						})
				)
			)
		}
	)
})

type Direction = "asc" | "desc"

/** What reads the union of automatic tasks (kind, account, amount) and manual ones (kind, account), told apart by kind. */
type Consumer =
	| { readonly kind: "delivered" }
	| { readonly kind: "filtered" }
	| { readonly kind: "bounded"; readonly take: Direction; readonly k: bigint }
	| {
			readonly kind: "bounded and reordered"
			readonly take: Direction
			readonly delivery: Direction
	  }
	| { readonly kind: "matched in a region" }
	| { readonly kind: "semi-joined" }
	| { readonly kind: "filtered above a bound" }
	| { readonly kind: "attached" }

const orderBy = (direction: Direction): CompletedOrder => ({
	keys: [
		{ column: "account", dir: direction },
		{ column: "kind", dir: "asc" }
	]
})

const heterogeneousRead = (consumer: Consumer): LogicalQuery => {
	const q = new Q()
	const kind = (handle: "Automatic" | "Manual") => q.lit({ kind: "enum", handle }, T.kind)
	const auto = q.region([
		{
			source: q.base(Task, conservativeMeta),
			bind: { account: "account", amount: "amount" },
			constants: {}
		}
	])
	const manual = q.region([
		{ source: q.base(Task, conservativeMeta), bind: { account: "account" }, constants: {} }
	])
	const u = q.union(
		[
			q.project(
				auto,
				[
					["kind", [kind("Automatic"), T.kind]],
					["account", "account"],
					["amount", "amount"]
				],
				conservativeMeta
			),
			q.project(
				manual,
				[
					["kind", [kind("Manual"), T.kind]],
					["account", "account"]
				],
				conservativeMeta
			)
		],
		["kind"]
	)
	const accounts = () =>
		q.project(
			q.region([{ source: q.base(Account, conservativeMeta), bind: { id: "id" }, constants: {} }]),
			[["id", "id"]],
			conservativeMeta
		)
	const notA = (input: RelNode) =>
		q.filter(
			input,
			q.op(
				"uuid_ne",
				[q.col(input, "account"), q.lit({ kind: "uuid", value: Cases.A }, T.uuid)],
				T.bool
			)
		)
	switch (consumer.kind) {
		case "delivered":
			return q.build(u)
		case "filtered":
			return q.build(notA(u))
		case "bounded":
			return q.build(
				q.take(u, orderBy(consumer.take), { kind: "literal", k: consumer.k }, [], conservativeMeta)
			)
		case "bounded and reordered":
			return q.build(
				q.ordered(
					q.take(u, orderBy(consumer.take), { kind: "literal", k: 1n }, [], conservativeMeta),
					orderBy(consumer.delivery)
				)
			)
		case "matched in a region":
			return q.build(
				q.region([{ source: u, bind: { kind: "kind", account: "account" }, constants: {} }])
			)
		case "semi-joined":
			return q.build(q.semi(u, accounts(), [["account", "id"]]))
		case "filtered above a bound":
			return q.build(
				notA(q.take(u, orderBy("asc"), { kind: "literal", k: 1n }, [], conservativeMeta))
			)
		case "attached":
			return q.build(q.attach(accounts(), u, "tasks", [["id", "account"]], "array", undefined))
	}
}

const directions = element<Direction>(["asc", "desc"])
const consumers = oneOf<Consumer>([
	element<Consumer>([
		{ kind: "delivered" },
		{ kind: "filtered" },
		{ kind: "matched in a region" },
		{ kind: "semi-joined" },
		{ kind: "filtered above a bound" },
		{ kind: "attached" }
	]),
	map(
		(source) => [source.draw(directions), source.draw(element([1n, 2n]))] as const,
		([take, k]): Consumer => ({ kind: "bounded", take, k })
	),
	map(
		(source) => [source.draw(directions), source.draw(directions)] as const,
		([take, delivery]): Consumer => ({
			kind: "bounded and reordered",
			take,
			delivery
		})
	)
])

/** The queries nested in a statement that carry a LIMIT: the bounds below its delivery. */
const boundedQueries = (statement: Select): ReadonlyArray<Select> => {
	const out: Array<Select> = []
	transformStatement(statement, {
		...identityHooks,
		select: (s) => {
			if (s !== statement && s.limit !== undefined) {
				out.push(s)
			}
			return s
		}
	})
	return out
}

describe("heterogeneous unions", () => {
	it.effect(
		"are delivered per heading group, merged under the take's order and then the delivery's, or read as a UNION inside a statement, and refused under any other node",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/lower/conservative/heterogeneous",
						literal: Formatter.format,
						generator: consumers,
						limit: 16,
						coverage: requiredInSpace<Consumer["kind"]>([
							"delivered",
							"filtered",
							"bounded",
							"bounded and reordered",
							"matched in a region",
							"semi-joined",
							"filtered above a bound",
							"attached"
						]),
						caseHang
					},
					(consumer, c) =>
						Effect.sync(() => {
							const r = lowered(heterogeneousRead(consumer))
							c.note(consumer.kind)
							switch (consumer.kind) {
								case "semi-joined":
								case "filtered above a bound":
								case "attached":
									refused(r, "UnsupportedOperation", consumer.kind)
									return
								case "matched in a region": {
									const p = succeeded(r)
									assert.equal(p.delivery.kind, "rows")
									assert.equal(flight(p.roots).length, 1)
									const shape = shapeOf(flight(p.roots)[0].ast)
									assert.ok(has(shape, "union"))
									assert.equal(featureCount(shape, "union all"), 0)
									return
								}
								case "delivered":
								case "filtered":
								case "bounded":
								case "bounded and reordered": {
									const p = succeeded(r)
									const delivery = p.delivery
									assert.ok(delivery.kind === "headingGroups", consumer.kind)
									assert.deepEqual(delivery.discriminant, ["kind"])
									assert.equal(flight(p.roots).length, 2, "one statement per heading group")
									assert.deepEqual(
										delivery.merge,
										consumer.kind === "bounded"
											? {
													kind: "take",
													bound: { kind: "literal" as const, k: consumer.k },
													take: orderBy(consumer.take)
												}
											: consumer.kind === "bounded and reordered"
												? consumer.delivery === consumer.take
													? {
															kind: "take",
															bound: { kind: "literal" as const, k: 1n },
															take: orderBy(consumer.take)
														}
													: {
															kind: "takeThenOrder",
															bound: { kind: "literal" as const, k: 1n },
															take: orderBy(consumer.take),
															order: orderBy(consumer.delivery)
														}
												: { kind: "concat" }
									)
									if (consumer.kind === "bounded" || consumer.kind === "bounded and reordered") {
										for (const s of flight(p.roots)) {
											/** Each group keeps its first k under the take's order. */
											const bounded = boundedQueries(s.ast)
											assert.ok(bounded.length > 0)
											for (const b of bounded) {
												assert.equal(b.orderBy[0]?.direction === "DESC", consumer.take === "desc")
											}
										}
									}
								}
							}
						})
				)
			)
	)

	it.effect(
		"refuse an attachment on an arm of a group of several arms, and deliver one on a lone arm",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/lower/conservative/union-attachments",
						literal: Formatter.format,
						generator: element<"a lone arm" | "an arm of several">([
							"a lone arm",
							"an arm of several"
						]),
						limit: 2,
						coverage: requiredInSpace<"a lone arm" | "an arm of several">([
							"a lone arm",
							"an arm of several"
						]),
						caseHang
					},
					(arm, c) =>
						Effect.sync(() => {
							const q = new Q()
							const accounts = q.project(
								q.region([
									{ source: q.base(Account, conservativeMeta), bind: { id: "id" }, constants: {} }
								]),
								[["id", "id"]],
								conservativeMeta
							)
							const posted = q.project(
								q.region([
									{
										source: q.base(Posting, conservativeMeta),
										bind: { account: "id" },
										constants: {}
									}
								]),
								[["id", "id"]],
								conservativeMeta
							)
							const child = q.project(
								q.region([
									{
										source: q.base(Task, conservativeMeta),
										bind: { account: "account" },
										constants: {}
									}
								]),
								[["account", "account"]],
								conservativeMeta
							)
							const attached = q.attach(
								accounts,
								child,
								"tasks",
								[["id", "account"]],
								"array",
								undefined
							)
							const r = lowered(
								q.build(
									arm === "a lone arm" ? q.union([attached], []) : q.union([attached, posted], [])
								)
							)
							if (arm === "a lone arm") {
								assert.equal(
									Arr.filter(flight(succeeded(r).roots), (s) => s.role.kind === "attachment")
										.length,
									1
								)
							} else {
								refused(r, "UnsupportedOperation")
							}
							c.note(arm)
						})
				)
			)
	)
})

/**
 * Outer references: an expression reading a column of another node, resolved to the occurrence or the region in scope
 * that reads it. Planted: the checker states every reference in scope and to one occurrence. A reference no scope binds
 * on its way to the root, a correlated take read outside its region, is a defect of the code that built the DAG: the
 * checker never builds one, and the strict re-reader (test/support/oracle/dag-validate.ts checkRootScopes) refuses it,
 * so it is never lowered; one to a source two occurrences share is refused by the lowering.
 */
type Reference =
	| "a constant reading a source one occurrence reads"
	| "a constant reading a source two occurrences share"
	| "a correlated take read inside its region"
	| "a correlated take read outside its region"

const referenceQuery = (reference: Reference): LogicalQuery => {
	const q = new Q()
	if (
		reference === "a constant reading a source one occurrence reads" ||
		reference === "a constant reading a source two occurrences share"
	) {
		const projected = (relation: typeof Posting) =>
			q.project(
				q.region([
					{
						source: q.base(relation, conservativeMeta),
						bind: { account: "account", amount: "amount" },
						constants: {}
					}
				]),
				[
					["account", "account"],
					["amount", "amount"]
				],
				conservativeMeta
			)
		const postings = projected(Posting)
		const other =
			reference === "a constant reading a source two occurrences share" ? postings : projected(Task)
		return q.build(
			q.region([
				{ source: postings, bind: { account: "x", amount: "a" }, constants: {} },
				{ source: other, bind: { account: "y" }, constants: { amount: q.col(postings, "amount") } }
			])
		)
	}
	const tasks = q.region([
		{
			source: q.base(Task, conservativeMeta),
			bind: { id: "id", account: "account", amount: "amount" },
			constants: {}
		}
	])
	const outer = q.b.reserve()
	const acct = q.b.expr({
		kind: "column",
		column: { node: outer, name: "acct" },
		args: [],
		type: T.uuid,
		nonNull: "storage"
	})
	const top = q.take(
		tasks,
		asc("amount", "id"),
		{ kind: "literal", k: 1n },
		[{ column: "account", expr: acct }],
		conservativeMeta
	)
	const region = q.regionWith(
		[
			{ source: q.base(Account, conservativeMeta), bind: { id: "acct" }, constants: {} },
			{ source: top, bind: { id: "task", account: "acct" }, constants: {} }
		],
		{ ...plainRegion, id: { kind: "reserved", id: outer } }
	)
	return q.build(reference === "a correlated take read inside its region" ? region : top)
}

describe("regions", () => {
	it.effect("resolve an outer reference only to a node in scope that one occurrence reads", (ctx) =>
		searched(
			ctx,
			exhaust(
				{
					suite: "unit/lower/conservative/outer-references",
					literal: Formatter.format,
					generator: element<Reference>([
						"a constant reading a source one occurrence reads",
						"a constant reading a source two occurrences share",
						"a correlated take read inside its region",
						"a correlated take read outside its region"
					]),
					limit: 4,
					coverage: requiredInSpace<"resolved" | "refused" | "a defect">([
						"resolved",
						"refused",
						"a defect"
					]),
					caseHang
				},
				(reference, c) =>
					Effect.sync(() => {
						if (reference === "a correlated take read outside its region") {
							throwsDefect(() => validateDag(referenceQuery(reference).dag), reference)
							c.note("a defect")
							return
						}
						const r = lowered(referenceQuery(reference))
						if (reference === "a constant reading a source two occurrences share") {
							refused(r, "MalformedDescription", reference)
							c.note("refused")
						} else {
							succeeded(r, reference)
							c.note("resolved")
						}
					})
			)
		)
	)
})

const boundParams = (c: QueryCase): ReadonlyArray<ParamId> =>
	Arr.flatMap(topoOrder(c.query.dag), (n) =>
		n.kind === "Take" && n.bound.kind === "param" ? [n.bound.param] : []
	)

describe("take bound parameters", () => {
	/**
	 * Generated queries whose takes are frequent and draw parameter bounds, which the generator types bigint: wider than
	 * the integer a bound parameter no other use widens.
	 */
	const bounded = queryCaseGen({
		...defaultGenConfig,
		query: {
			...defaultGenConfig.query,
			weights: {
				...defaultGenConfig.query.weights,
				take: 6
			}
		},
		swarm: false
	})
	const generatedNames = standInNames("Ledger")
	const lowered = (c: QueryCase, params: ReadonlyArray<ParamDecl>) =>
		lowerConservative(conservativeInput(c.query), {
			names: generatedNames,
			params,
			subject: { kind: "query" }
		})

	it.effect(
		"binds a bound parameter at its declared type, and refuses one the query does not declare",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/lower/conservative/bound-param-type",
						literal: Formatter.format,
						kept: [],
						draw: drawn(filter(bounded, (c) => boundParams(c).length > 0, 32)),
						runs: 60,
						shrink: completeShrink,
						coverage: noCoverage,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(c) =>
						Effect.sync(() => {
							const params = genParamDecls(c.query)
							const r = lowered(c, params)
							if (!r.ok) {
								return
							}
							for (const p of boundParams(c)) {
								const declared = present(
									Arr.flatMap(params, (d) =>
										d.id === p && d.kind === "scalar" ? [d.type] : []
									)[0],
									`the declaration of ${p}`
								)
								const bound: ReadonlyArray<ScalarType> = Arr.flatMap(flight(r.value.roots), (s) =>
									Arr.flatMap(s.params, (slot) =>
										slot.kind === "scalar" && slot.param === p ? [slot.type] : []
									)
								)
								assert.ok(bound.length > 0, `a placeholder of ${p}`)
								for (const type of bound) {
									assert.ok(sameScalarType(type, declared), p)
								}
								const undeclared = lowered(
									c,
									Arr.filter(params, (d) => d.id !== p)
								)
								assert.equal(
									!undeclared.ok && undeclared.error.reason._tag,
									"MalformedDescription",
									p
								)
							}
						})
				)
			)
	)
})
