/** What the properties of lowering.test.ts read: its spaces, models and helpers. */

import type * as Result from "@bjornpagen/grizzle-text/base/result"
import { element, finite, int, map, oneOf } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import type { CompileError } from "#compiler/core/errors.ts"
import { makeIdSupply, type ParamId } from "#compiler/core/ids.ts"
import { type Direction, directions } from "#compiler/core/order.ts"
import { DagTemplates } from "#compiler/ir/dag-digest.ts"
import { topoOrder } from "#compiler/ir/dag.ts"
import type { PhysicalNames } from "#compiler/ir/physical.ts"
import type { LogicalQuery, ParamDecl } from "#compiler/ir/products.ts"
import {
	type CompletedOrder,
	conservativeMeta,
	exprsOf,
	inputsOf,
	type RelNode
} from "#compiler/ir/rel.ts"
import { lowerConservative } from "#compiler/lower/conservative/index.ts"
import {
	conservativeInput,
	type ConservativeOptions,
	type ConservativeProgram
} from "#compiler/lower/conservative/types.ts"
import { nativeOp } from "#compiler/scalar/compute/registry.ts"
import type { OperandSelect, Select } from "#compiler/sql/ast.ts"
import { types } from "#compiler/sql/build.ts"
import { freshNames } from "#compiler/sql/naming.ts"
import { identityHooks, transformStatement } from "#compiler/sql/transform.ts"
import { carrierColumnDef } from "#compiler/write/carriers/carriers.ts"
import { breachGuard } from "#compiler/write/refusal.ts"
import { closed, decodedSchema, f, relation } from "#test/support/fixtures/ir/desc.ts"
import {
	installationOf,
	localVectorSchema,
	productionNames,
	standInNames
} from "#test/support/kernel/naming.ts"
import { defaultGenConfig, type QueryCase, queryCaseGen } from "#test/support/oracle/gen/case.ts"
import { schemaCodes } from "#test/support/oracle/gen/schema.ts"
import { unitCarrierName } from "#test/support/sql.ts"
import { everyKind, fixtureCodes } from "#test/support/unit/ir/fixture.ts"
import { Account, Q, T, Task } from "#test/support/unit/lower/conservative/fixtures.ts"
import * as Cases from "#test/support/unit/lower/conservative/queries.ts"
import { upTo } from "#test/support/up-to.ts"

/**
 * The names a hand-built DAG lowers under: production's stand-ins for its relations, under Kind's codes, and the domain
 * of the fixtures' Cents contract as an installation declaring it names it, by its definition's digest, which only an
 * installation holds.
 */
const centsDomain = installationOf(
	decodedSchema({
		name: "Ledger",
		relations: [
			closed.ordered("Kind", ["Automatic", "Manual"]),
			relation("Ledger", { id: f.uuid, cents: f.contract("Cents", f.bigint, undefined) }, ["id"])
		],
		statements: [],
		bases: []
	}),
	{ kind: "declared" }
).names.contractDomain

const names: PhysicalNames = {
	...productionNames("Ledger", { kind: "declared" }, localVectorSchema, fixtureCodes),
	contractDomain: centsDomain
}

export type Subject = "query" | "readBack"

/**
 * What production passes to lower a query: its declared parameters and the subject; a write program's read back
 * supplies the deltas it reads as a carrier.
 */
export const optionsFor = (
	params: ReadonlyArray<ParamDecl>,
	subject: Subject
): ConservativeOptions => ({
	names,
	params,
	subject:
		subject === "query"
			? { kind: "query" }
			: {
					kind: "readBack",
					deltas: () => ({
						kind: "carrier",
						carrier: unitCarrierName(1),
						table: [
							carrierColumnDef("c1", types.uuid),
							carrierColumnDef("c2", types.uuid),
							carrierColumnDef("c3", types.smallint),
							carrierColumnDef("c4", types.bigint)
						],
						columns: [
							{ field: "id", column: "c1" },
							{ field: "account", column: "c2" },
							{ field: "kind", column: "c3" },
							{ field: "amount", column: "c4" }
						]
					}),
					breach: breachGuard("Ledger"),
					start: freshNames,
					templates: new DagTemplates("derivation"),
					bound: () => undefined,
					admission: "write"
				}
})

export const lowered = (query: LogicalQuery): Result.Result<ConservativeProgram, CompileError> =>
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

export const readsOf = (root: RelNode): Reads => {
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

export type KindOutcome = "lowered" | "MalformedDescription" | "UnsupportedOperation"

export const kindOutcome = (reads: Reads, subject: Subject): KindOutcome =>
	reads.feedbackOutside
		? "MalformedDescription"
		: reads.rewrite || reads.unresolvedSearch || (reads.delta && subject === "query")
			? "UnsupportedOperation"
			: "lowered"

/** What reads the union of automatic tasks (kind, account, amount) and manual ones (kind, account), told apart by kind. */
export type Consumer =
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

export const orderBy = (direction: Direction): CompletedOrder => ({
	keys: [
		{ column: "account", dir: direction },
		{ column: "kind", dir: "asc" }
	]
})

export const heterogeneousRead = (consumer: Consumer): LogicalQuery => {
	const q = new Q()
	const kind = (handle: "Automatic" | "Manual") => q.lit({ kind: "handle", handle }, T.kind)
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

const directionGen = element(directions)

export const consumers = oneOf<Consumer>([
	element<Consumer>([
		{ kind: "delivered" },
		{ kind: "filtered" },
		{ kind: "matched in a region" },
		{ kind: "semi-joined" },
		{ kind: "filtered above a bound" },
		{ kind: "attached" }
	]),
	map(
		(source) => [source.draw(directionGen), source.draw(element([1n, 2n]))] as const,
		([take, k]): Consumer => ({ kind: "bounded", take, k })
	),
	map(
		(source) => [source.draw(directionGen), source.draw(directionGen)] as const,
		([take, delivery]): Consumer => ({
			kind: "bounded and reordered",
			take,
			delivery
		})
	)
])

/** The queries nested in a statement that carry a LIMIT: the bounds below its delivery. */
export const boundedQueries = (statement: Select): ReadonlyArray<OperandSelect> => {
	const out: Array<OperandSelect> = []
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

/**
 * Outer references: a constant of a region's occurrence reading a column of another occurrence's source, resolved to the
 * occurrence that reads it. The checker states every reference to a source one occurrence reads; one to a source two
 * occurrences share names no occurrence alone, and the lowering refuses it. A correlated take's reference to its
 * region's variable is the generated soundness population's, which the conservative oracle lowers on PostgreSQL.
 */
export type Resolution = "resolved" | "refused"

export const boundParams = (c: QueryCase): ReadonlyArray<ParamId> =>
	Arr.flatMap(topoOrder(c.query.dag), (n) =>
		n.kind === "Take" && n.bound.kind === "param" ? [n.bound.param] : []
	)

/**
 * Generated queries whose takes are frequent and draw parameter bounds, which the generator types bigint: wider than
 * the integer a bound parameter no other use widens.
 */
export const bounded = queryCaseGen({
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

export const lowerGenerated = (c: QueryCase, params: ReadonlyArray<ParamDecl>) =>
	lowerConservative(conservativeInput(c.query), {
		names: standInNames(c.schema.name, schemaCodes(c.schema)),
		params,
		subject: { kind: "query" }
	})

export const { dag, nodes, params } = everyKind(makeIdSupply())

export type ArmFeature = "a lone arm attached" | "an arm of several attached" | "no arm attached"

/** One to three arms of one heading group, `attached` holding a bit per arm whose parent carries tasks. */
export const attachedArms = finite((source) => {
	const arms = source.draw(int(1, 3))
	return { arms, attached: source.draw(int(0, 2 ** arms - 1)) }
})

/**
 * Two or three occurrences, each over the postings' or the tasks' projection of (account, amount), one
 * node each however many occurrences read it; the last fixes its amount to the amount of the source the
 * `read`th earlier occurrence reads.
 */
export const regionReads = finite((source) => {
	const count = source.draw(int(2, 3))
	return {
		sources: upTo(count, () => source.draw(int(0, 1))),
		read: source.draw(int(0, count - 2))
	}
})
