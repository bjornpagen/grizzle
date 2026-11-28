/** What the properties of reasons.test.ts read: its spaces, models and helpers. */

import type * as Result from "@bjornpagen/grizzle-text/base/result"
import { assert, defined } from "@bjornpagen/testing/assert"
import { codePoint, element, type Gen, int, oneOf, string } from "@bjornpagen/testing/gen"
import type { CorruptedFeature } from "@bjornpagen/testing/lsw"
import { bigint as bigintGen, double } from "@bjornpagen/testing/values"
import { regex } from "arkregex"
import { checkQuery } from "#compiler/check/index.ts"
import type { CompileError, CompileReasonTag } from "#compiler/core/errors.ts"
import { childLoc, type SourceLoc } from "#compiler/core/loc.ts"
import type { QueryDesc as LocatedQuery } from "#compiler/ir/desc.ts"
import { placeOf, refusalLoc, refused, succeeded } from "#test/support/assert.ts"
import type { FixtureSchema } from "#test/support/compile.ts"
import {
	type AuthoredExprDesc,
	decodedQuery,
	type QueryDesc
} from "#test/support/fixtures/ir/desc.ts"
import { checking, checkOptions, checkReadBackOf } from "#test/support/policy.ts"
import {
	eq,
	imported,
	lit,
	match,
	param,
	queryDesc,
	ref,
	relationSource,
	rule,
	vars
} from "#test/support/unit/check/dsl.ts"
import type { Boundary, FaultRule } from "#test/unit/check/faults.ts"
import { Qty } from "#test/unit/check/schemas.ts"

/**
 * What a check must answer: a refusal for a reason at exactly the decoded location of the offending declaration, a
 * refusal for a reason below every declaration, located, or the checked result.
 */
type Expected =
	| { readonly kind: "refused at"; readonly reason: CompileReasonTag; readonly at: SourceLoc }
	| { readonly kind: "refused"; readonly reason: CompileReasonTag }
	| { readonly kind: "admitted" }

const admitted: Expected = { kind: "admitted" }

const refusedFor = (reason: CompileReasonTag): Expected => ({ kind: "refused", reason })

const refusedAt = (reason: CompileReasonTag, at: SourceLoc): Expected => ({
	kind: "refused at",
	reason,
	at
})

export const answers = (
	result: Result.Result<unknown, CompileError>,
	expected: Expected,
	why: string
): void => {
	switch (expected.kind) {
		case "admitted":
			succeeded(result, why)
			return
		case "refused":
			refusalLoc(refused(result, expected.reason, why), `${why}: located`)
			return
		case "refused at":
			assert.deepEqual(
				placeOf(refusalLoc(refused(result, expected.reason, why))),
				placeOf(expected.at),
				why
			)
			return
	}
}

/** The decoded location of match `m` of arm `arm` of a decoded rules stage. */
const matchLoc = (
	stage: ReturnType<typeof decodedQuery>["stage"],
	arm: number,
	m: number
): SourceLoc => {
	assert.ok(stage.kind === "rules", "the planted stage is a rules stage")
	return defined(defined(stage.arms[arm]).matches[m]).loc
}

/** Item ids whose qty is the parameter q: Qty is a contract over integer (test/unit/check/schemas.ts). */
const itemsOfQty = queryDesc(
	rule({
		vars: vars("Item", "id"),
		matches: [match(relationSource("Item"), { id: ref("Item", "id"), qty: param("q", Qty) })],
		head: { id: ref("Item", "id") },
		where: [],
		interiors: [],
		attach: []
	})
)

/** An import of itemsOfQty, its parameter bound to `q`. */
const qtyImport = (q: AuthoredExprDesc): QueryDesc =>
	queryDesc(
		rule({
			vars: vars("X", "id"),
			matches: [match(imported(itemsOfQty, { q }), { id: ref("X", "id") })],
			head: { id: ref("X", "id") },
			where: [],
			interiors: [],
			attach: []
		})
	)

const budgetIs = (budget: Parameters<typeof lit>[0]): QueryDesc =>
	queryDesc(
		rule({
			vars: vars("AutomaticTask", "task"),
			matches: [
				match(relationSource("AutomaticTask"), {
					task: ref("AutomaticTask", "task"),
					budget: lit(budget)
				})
			],
			head: { task: ref("AutomaticTask", "task") },
			where: [],
			interiors: [],
			attach: []
		})
	)

const qtyBound = (qty: Parameters<typeof lit>[0]): QueryDesc =>
	queryDesc(
		rule({
			vars: vars("Item", "id"),
			matches: [match(relationSource("Item"), { id: ref("Item", "id"), qty: lit(qty) })],
			head: { id: ref("Item", "id") },
			where: [],
			interiors: [],
			attach: []
		})
	)

const qtyIs = (qty: Parameters<typeof lit>[0]): QueryDesc =>
	queryDesc(
		rule({
			vars: vars("Item", "id", "qty"),
			matches: [match(relationSource("Item"), { id: ref("Item", "id"), qty: ref("Item", "qty") })],
			where: [eq(ref("Item", "qty"), lit(qty))],
			head: { id: ref("Item", "id") },
			interiors: [],
			attach: []
		})
	)

const labelIs = (label: Parameters<typeof lit>[0]): QueryDesc =>
	queryDesc(
		rule({
			vars: vars("Item", "id", "label"),
			matches: [
				match(relationSource("Item"), { id: ref("Item", "id"), label: ref("Item", "label") })
			],
			where: [eq(ref("Item", "label"), lit(label))],
			head: { id: ref("Item", "id") },
			interiors: [],
			attach: []
		})
	)

const labelBound = (label: Parameters<typeof lit>[0]): QueryDesc =>
	queryDesc(
		rule({
			vars: vars("Item", "id"),
			matches: [match(relationSource("Item"), { id: ref("Item", "id"), label: lit(label) })],
			head: { id: ref("Item", "id") },
			where: [],
			interiors: [],
			attach: []
		})
	)

const int4 = Object.freeze({ min: -(2 ** 31), max: 2 ** 31 - 1 })

/**
 * A literal at a typed slot: AutomaticTask.budget, Cents over bigint, at least 0 (Work); Item.qty, Qty over integer, at
 * least 0, bound by a match, compared by a where, or bound by an import's bind map (Lab); and Item.label, the lower-case
 * language (Lab).
 */
type Slot =
	| "Cents bound"
	| "Qty bound"
	| "Qty compared"
	| "Qty an import binds"
	| "lower-case label compared"
	| "lower-case label bound"

interface SlotLiteral {
	readonly slot: Slot
	readonly value: Parameters<typeof lit>[0]
}

export const slotGen: Gen<SlotLiteral> = oneOf<SlotLiteral>([
	(source) => ({
		slot: "Cents bound",
		value: source.draw(
			oneOf<bigint | number | string>([
				bigintGen(-(2n ** 40n), 2n ** 40n),
				int(int4.min, int4.max),
				string(codePoint(0x20, 0x7e), { min: 0, max: 3 })
			])
		)
	}),
	(source) => ({
		slot: source.draw(element<Slot>(["Qty bound", "Qty compared", "Qty an import binds"])),
		value: source.draw(
			oneOf([
				int(int4.min, int4.max),
				int(2 ** 31, 2 ** 40),
				double(-Number.MAX_VALUE, Number.MAX_VALUE)
			])
		)
	}),
	(source) => ({
		slot: source.draw(element<Slot>(["lower-case label compared", "lower-case label bound"])),
		value: source.draw(string(codePoint(0x20, 0x7e), { min: 0, max: 6 }))
	})
])

/**
 * The answer the literal's type gives it: a value of another host kind or outside the base's range is no literal of
 * the base (MalformedDescription), one outside the contract or the language is ContractLiteral, else admitted. The
 * language is judged here by RegExp; the checker decides it by its own NFA.
 */
export const expectedOf = (
	slot: Slot,
	value: Parameters<typeof lit>[0],
	located: (reason: CompileReasonTag) => Expected
): Expected => {
	switch (slot) {
		case "Cents bound":
			return typeof value !== "bigint"
				? located("MalformedDescription")
				: value < 0n
					? located("ContractLiteral")
					: admitted
		case "lower-case label compared":
		case "lower-case label bound":
			return typeof value === "string" && regex("^[a-z]+$", "u").test(value)
				? admitted
				: located("ContractLiteral")
		case "Qty an import binds":
		case "Qty bound":
		case "Qty compared":
			return typeof value !== "number" ||
				!Number.isInteger(value) ||
				value < int4.min ||
				value > int4.max
				? located("MalformedDescription")
				: value < 0
					? located("ContractLiteral")
					: admitted
	}
}

/**
 * The query holding the literal at its slot, and where it is refused: at the import's bind entry, a declaration, or
 * below every declaration.
 */
export const literalAt = (
	slot: Slot,
	value: Parameters<typeof lit>[0]
): { readonly query: QueryDesc; readonly located: (reason: CompileReasonTag) => Expected } => {
	switch (slot) {
		case "Cents bound":
			return { query: budgetIs(value), located: refusedFor }
		case "Qty bound":
			return { query: qtyBound(value), located: refusedFor }
		case "Qty compared":
			return { query: qtyIs(value), located: refusedFor }
		case "Qty an import binds": {
			const q = qtyImport(lit(value))
			const at = childLoc(childLoc(matchLoc(decodedQuery(q.stage).stage, 0, 0), "bind"), "q")
			return { query: q, located: (reason) => refusedAt(reason, at) }
		}
		case "lower-case label compared":
			return { query: labelIs(value), located: refusedFor }
		case "lower-case label bound":
			return { query: labelBound(value), located: refusedFor }
	}
}

export type LiteralFeature = Slot | "admitted" | "ContractLiteral" | "MalformedDescription"

/** What a planted fault's case reached: the live Description, a fault by its rule, and the reasons refused. */
export type FaultFeature = CorruptedFeature<FaultRule> | "admitted as a read-back"

/** A planted Description read at a boundary, against the case's schema. */
export const readAt = (
	schema: FixtureSchema,
	desc: LocatedQuery,
	boundary: Boundary
): Result.Result<unknown, CompileError> => {
	const checked = checking(schema)
	switch (boundary) {
		case "query":
			return checkQuery(checked, desc, checkOptions("faults"))
		case "read-back":
			return checkReadBackOf(checked, { name: "planted", query: desc }, {})
	}
}
