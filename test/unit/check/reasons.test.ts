import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { codePoint, element, type Gen, int, oneOf, string } from "@grizzle/testing/gen"
import { corrupted, corruptedFeature, type CorruptedFeature } from "@grizzle/testing/lsw"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { bigint as bigintGen, double } from "@grizzle/testing/values"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter } from "effect"
import { checkQuery } from "#compiler/check/index.ts"
import type { CompileError, CompileReasonTag } from "#compiler/core/errors.ts"
import { childLoc, formatLoc, type SourceLoc } from "#compiler/core/loc.ts"
import type * as Result from "#compiler/core/result.ts"
import type { QueryDesc as LocatedQuery } from "#compiler/ir/desc.ts"
import { queryInput } from "#compiler/program/compile.ts"
import { assert, defined, refusalLoc, refused, succeeded } from "#test/support/assert.ts"
import {
	type AuthoredExprDesc,
	decodedQuery,
	type QueryDesc
} from "#test/support/fixtures/ir/desc.ts"
import { WorkDesc } from "#test/support/fixtures/ir/work.ts"
import { caseHang } from "#test/support/limits.ts"
import { buildRoot, buildSchema } from "#test/support/oracle/public/build.ts"
import { caseSketchGen, resolveCase } from "#test/support/oracle/public/generate.ts"
import { checking, checkOptions, checkReadBackOf } from "#test/support/policy.ts"
import {
	type ContractFeature,
	contractCaseGen,
	contractFeatures,
	contractQuery,
	contractSchema,
	conflicting
} from "#test/unit/check/contracts.ts"
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
} from "#test/unit/check/dsl.ts"
import {
	type Boundary,
	type FaultRule,
	faults,
	liveOf,
	type Planted
} from "#test/unit/check/faults.ts"
import { Lab, Qty } from "#test/unit/check/schemas.ts"

import { regex } from "arkregex"
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

const answers = (
	result: Result.Result<unknown, CompileError>,
	expected: Expected,
	why: string
): void => {
	switch (expected.kind) {
		case "admitted":
			succeeded(result, why)
			return
		case "refused": {
			const e = refused(result, expected.reason, why)
			assert.ok(formatLoc(refusalLoc(e)).length > 0, `${why}: located`)
			return
		}
		case "refused at":
			assert.equal(
				formatLoc(refusalLoc(refused(result, expected.reason, why))),
				formatLoc(expected.at),
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

const int4 = { min: -(2 ** 31), max: 2 ** 31 - 1 }

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

const slotGen: Gen<SlotLiteral> = oneOf<SlotLiteral>([
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
const expectedOf = (
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
const literalAt = (
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

type LiteralFeature = Slot | "admitted" | "ContractLiteral" | "MalformedDescription"

describe("a literal at a typed slot", () => {
	it.effect(
		"is no literal of another host kind or range, refused outside its contract or language, and admitted within",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: { kind: "unstated" },
						suite: "unit/check/reasons-literal",
						draw: drawn(slotGen),
						literal: Formatter.format,
						coverage: required<LiteralFeature>(
							[
								"Cents bound",
								"Qty bound",
								"Qty compared",
								"Qty an import binds",
								"lower-case label compared",
								"lower-case label bound",
								"admitted",
								"ContractLiteral",
								"MalformedDescription"
							],
							{ cases: 300, sense: notesOnly }
						),
						kept: [],
						runs: 300,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					({ slot, value }, c) =>
						Effect.sync(() => {
							const { query: q, located } = literalAt(slot, value)
							const expected = expectedOf(slot, value, located)
							answers(
								checkQuery(
									checking(slot === "Cents bound" ? WorkDesc : Lab),
									q,
									checkOptions("query")
								),
								expected,
								`${slot} ${Formatter.format(value)}`
							)
							c.note(slot)
							c.note(
								expected.kind === "admitted"
									? "admitted"
									: expected.reason === "ContractLiteral"
										? "ContractLiteral"
										: "MalformedDescription"
							)
						})
				)
			)
	)
})

describe("a query's contracts", () => {
	it.effect(
		"are one descriptor per name across the query and its schema, a name declared with two refused with that name",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/check/reasons-contracts",
						draw: drawn(contractCaseGen),
						literal: Formatter.format,
						oracle: {
							kind: "specification",
							name: "one name, one descriptor, restated over the drawn declarations (test/unit/check/contracts.ts)"
						},
						coverage: required<ContractFeature>(
							[
								"one name declared with two descriptors",
								"the schema's contract declared otherwise",
								"the schema's own descriptor declared again",
								"one descriptor declared twice",
								"admitted"
							],
							{ cases: 200, sense: notesOnly }
						),
						kept: [],
						runs: 100,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(c, k) =>
						Effect.sync(() => {
							k.noteAll(contractFeatures(c))
							const result = checkQuery(
								checking(contractSchema(c)),
								contractQuery(c),
								checkOptions("contracts")
							)
							const clash = conflicting(c)
							if (clash.length === 0) {
								succeeded(result, "one descriptor per name")
								return
							}
							const reason = refused(result, "DuplicateIdentity").reason
							const duplicate = reason._tag === "DuplicateIdentity" ? reason.duplicate : undefined
							const named = duplicate?.kind === "contract" ? duplicate.name : undefined
							assert.ok(
								named !== undefined && Arr.some(clash, (name) => name === named),
								`a contract of the names ${Arr.join(clash, ", ")}, not ${Formatter.format(duplicate)}`
							)
						})
				)
			)
	)
})

/** What a planted fault's case reached: the live Description, a fault by its rule, and the reasons refused. */
type FaultFeature = CorruptedFeature<FaultRule> | "admitted as a read-back"

/** A planted Description read at a boundary, against the case's schema. */
const readAt = (
	schema: unknown,
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

describe("a fault planted in a generated query", () => {
	it.effect(
		"is refused with its reason at the location it determines, and the query without it is admitted",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/check/reasons-faults",
						draw: drawn(caseSketchGen),
						literal: Formatter.format,
						oracle: {
							kind: "specification",
							name: "the reason and location each planted fault determines (test/unit/check/faults.ts)"
						},
						coverage: required<FaultFeature>(
							[
								"live",
								"wild an attachment binding no parent column",
								"stale an undeclared variable in a binding",
								"stale an undeclared variable in a bind map",
								"stale a delta outside a read-back",
								"wild a delta of the roster",
								"admitted as a read-back"
							],
							{ cases: 400, sense: notesOnly }
						),
						kept: [],
						runs: 200,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(sketch, k) =>
						Effect.sync(() => {
							const c = k.draw(resolveCase(sketch))
							const built = buildSchema(c.schema)
							for (const read of c.reads) {
								if (read.kind !== "query") {
									continue
								}
								const desc = succeeded(
									queryInput(buildRoot(built, built.schema, read.query)),
									"the builder admits a generated read"
								).desc
								succeeded(readAt(built.schema, desc, "query"), "the live read is admitted")
								const drawnFault = k.draw(corrupted(liveOf(c, desc), faults))
								k.note(corruptedFeature(drawnFault))
								if (drawnFault.kind === "live") {
									continue
								}
								const planted: Planted = drawnFault.refusal
								const label = `${drawnFault.rule} at ${drawnFault.at}`
								const e = refused(
									readAt(built.schema, planted.desc, planted.boundary),
									planted.reason,
									label
								)
								assert.equal(formatLoc(refusalLoc(e)), formatLoc(planted.at), `${label}: located`)
								if (planted.admittedAs !== "none") {
									succeeded(
										readAt(built.schema, planted.desc, planted.admittedAs),
										`${label}, read as a ${planted.admittedAs}`
									)
									k.note("admitted as a read-back")
								}
							}
						})
				)
			)
	)
})
