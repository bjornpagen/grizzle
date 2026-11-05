import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { noCoverage } from "@grizzle/testing/features"
import { element } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { type Array as Arr, Effect, Formatter } from "effect"
import { checkQuery } from "#compiler/check/index.ts"
import type { CompileReasonTag } from "#compiler/core/errors.ts"
import { formatLoc } from "#compiler/core/loc.ts"
import type { LiteralDesc } from "#compiler/ir/desc.ts"
import { assert, refusalLoc, refused } from "#test/support/assert.ts"
import type {
	AuthoredExprDesc as ExprDesc,
	QueryDesc,
	RuleDesc
} from "#test/support/fixtures/ir/desc.ts"
import { WorkDesc } from "#test/support/fixtures/ir/work.ts"
import { caseHang } from "#test/support/limits.ts"
import { checking, checkOptions } from "#test/support/policy.ts"
import {
	attach,
	imported,
	lit,
	match,
	orderBy,
	parent,
	plainVar,
	queryDesc,
	ref,
	relationSource,
	rule,
	take,
	typedLit,
	varRef,
	vars
} from "#test/unit/check/dsl.ts"

/** Kind's typed handle, Kind.handle(h), as the query builder records it: a literal typed by closedId(Kind). */
const kindHandle = (value: LiteralDesc) => typedLit(value, { kind: "closedId", roster: "Kind" })

/**
 * The automatic and manual arms of Work's tasks, each delivering `common` from Task and its own arm field; the task's
 * account is `account`: Task's own, or a parent variable.
 */
const arms = (common: "id" | "account", account: ExprDesc): readonly [RuleDesc, RuleDesc] => [
	rule({
		vars: [...vars("Task", "id", "account"), ...vars("AutomaticTask", "budget")],
		matches: [
			match(relationSource("Task"), { id: ref("Task", "id"), account, kind: lit("Automatic") }),
			match(relationSource("AutomaticTask"), {
				task: ref("Task", "id"),
				budget: ref("AutomaticTask", "budget")
			})
		],
		head: {
			[common]: common === "id" ? ref("Task", "id") : account,
			kind: kindHandle("Automatic"),
			budget: ref("AutomaticTask", "budget")
		},
		where: [],
		interiors: [],
		attach: []
	}),
	rule({
		vars: [...vars("Task", "id", "account"), ...vars("ManualTask", "operator")],
		matches: [
			match(relationSource("Task"), { id: ref("Task", "id"), account, kind: lit("Manual") }),
			match(relationSource("ManualTask"), {
				task: ref("Task", "id"),
				operator: ref("ManualTask", "operator")
			})
		],
		head: {
			[common]: common === "id" ? ref("Task", "id") : account,
			kind: kindHandle("Manual"),
			operator: ref("ManualTask", "operator")
		},
		where: [],
		interiors: [],
		attach: []
	})
]

/** The union of the automatic and manual arms (arms). */
const armsUnion = (common: "id" | "account", account: ExprDesc): QueryDesc => {
	const [automatic, manual] = arms(common, account)
	return queryDesc(automatic, manual)
}

/** Keyed: id is a key of each arm, so (id, kind) keys the union. */
const keyed = armsUnion("id", ref("Task", "account"))
/** Keyless: an account has many tasks of one kind, so (account, kind) keys no arm. */
const keyless = armsUnion("account", ref("Task", "account"))

const accounts = queryDesc(
	rule({
		vars: vars("Account", "id"),
		matches: [match(relationSource("Account"), { id: ref("Account", "id") })],
		head: { id: ref("Account", "id") },
		where: [],
		interiors: [],
		attach: []
	})
)

const bounded = take(orderBy(keyed, ["id", "asc"]), 3)

/** A union order or narrowing the checker refuses, with its reason and why. */
interface Refused {
	readonly what: string
	readonly query: QueryDesc
	readonly reason: CompileReasonTag
}

const refusals: Arr.NonEmptyReadonlyArray<Refused> = [
	{
		what: "a take over a keyless union",
		query: take(orderBy(keyless, ["account", "asc"]), 10),
		reason: "UnsupportedOperation"
	},
	{
		what: "a take on the discriminant alone",
		query: take(orderBy(keyless, ["kind", "desc"]), 1),
		reason: "UnsupportedOperation"
	},
	{
		what: "a delivered order over a keyless union, which a page reads",
		query: orderBy(keyless, ["account", "asc"]),
		reason: "UnsupportedOperation"
	},
	{
		/** The child's tasks are the parent account's; account, fixed per parent, breaks no tie. */
		what: "an ordered attachment over a keyless union",
		query: attach(
			accounts,
			"tasks",
			take(orderBy(armsUnion("account", parent("id")), ["kind", "asc"]), 2)
		),
		reason: "UnsupportedOperation"
	},
	{
		what: "a match of the bounded union binding an arm's field without the discriminant",
		query: queryDesc(
			rule({
				vars: [plainVar("i"), plainVar("b")],
				matches: [match(imported(bounded, {}), { id: varRef("i"), budget: varRef("b") })],
				head: { id: varRef("i") },
				where: [],
				interiors: [],
				attach: []
			})
		),
		reason: "MalformedDescription"
	}
]

describe("a union of different headings", () => {
	it.effect(
		"refuses an order whose common fields hold no key, and a match that binds a field without the discriminant",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/check/union-order",
						generator: element(refusals),
						literal: Formatter.format,
						limit: refusals.length,
						coverage: noCoverage,
						caseHang
					},
					(r) =>
						Effect.sync(() => {
							const e = refused(
								checkQuery(checking(WorkDesc), r.query, checkOptions("query")),
								r.reason,
								r.what
							)
							assert.ok(formatLoc(refusalLoc(e)).length > 0, `${r.what}: located`)
						})
				)
			)
	)
})
