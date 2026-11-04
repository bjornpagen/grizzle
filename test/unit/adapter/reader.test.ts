import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { element } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import type { Source } from "@grizzle/testing/source"
import { searched } from "@grizzle/testing/vitest"
import {
	Array as Arr,
	Duration,
	Effect,
	Formatter,
	Option,
	Order,
	Result,
	Stream,
	String as Str
} from "effect"
import { missingExtension } from "#adapter/admission/expectation.ts"
import { ReadFailure } from "#adapter/errors/execution.ts"
import { attachmentHeads } from "#adapter/reader/analysis.ts"
import { hostParams } from "#adapter/reader/params.ts"
import { executionInputs, paramCodecs, type RelationInputs } from "#adapter/reader/relations.ts"
import { ParamId } from "#compiler/core/ids.ts"
import { recordsetMaxRows, valuesMaxRows } from "#compiler/core/policy.ts"
import type { ParamDecl, RelationParamDecl } from "#compiler/ir/products.ts"
import { flight } from "#compiler/lower/conservative/types.ts"
import { relationTransport } from "#compiler/lower/shapes/relparam/index.ts"
import { closedId, pg, uuid as uuidField } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { closed, relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { queryOver, queryValueDesc, varsOver } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { assert, succeeded } from "#test/support/assert.ts"
import { compileTemplate, testCompile } from "#test/support/compile.ts"
import * as W from "#test/support/fixtures/api/work.ts"
import { f } from "#test/support/fixtures/ir/desc.ts"
import { scalarOf } from "#test/support/fixtures/ir/scalar.ts"
import { largeStatements } from "#test/support/oracle/forms.ts"

/**
 * The pure parts of the reader: Stream relation parameters collected under the cap, the size rule's transport per
 * relation input, every declared parameter admitted at the read boundary whatever the optimizer eliminated, the
 * capability check of a compiled template against the installed extensions, the key positions get reads through, and
 * the head keys an attachment delivers.
 *
 * A read's refusal as the contract states it: a codec's refusal at encode with the slot its EncodingFailure names, the
 * parameter or `parameter.field` (README "Errors and outcomes": as a write's names it), or any other refusal by its stage.
 */
type Refusal =
	| { readonly kind: "codec"; readonly slot: string | undefined }
	| { readonly kind: "stage"; readonly stage: string }

const refusalOf = (failure: ReadFailure): Refusal =>
	failure.reason._tag === "EncodingFailure"
		? {
				kind: "codec",
				slot: failure.reason.place._tag === "Slot" ? failure.reason.place.name : undefined
			}
		: { kind: "stage", stage: failure.stage }

/** A uuid column's type, as the registry builds it. */
const uuid = scalarOf(f.uuid, {})

describe("Stream relation parameters collected on the host under the cap", () => {
	const ids: RelationParamDecl = {
		id: ParamId("p1"),
		name: "ids",
		kind: "relation",
		heading: [{ name: "id", type: uuid }]
	}
	const account: ParamDecl = { id: ParamId("p2"), name: "account", kind: "scalar", type: uuid }

	it.effect("passes arrays and scalars through and collects a Stream on the host", () =>
		Effect.gen(function* () {
			const given = { ids: [{ id: "a" }], account: "x" }
			assert.deepEqual(yield* hostParams([ids, account], given, recordsetMaxRows), given)
			const streamed = yield* hostParams(
				[ids, account],
				{ ids: Stream.fromIterable([{ id: "a" }, { id: "b" }]), account: "x" },
				recordsetMaxRows
			)
			assert.deepEqual(streamed, { ids: [{ id: "a" }, { id: "b" }], account: "x" })
		})
	)

	it.effect(
		"refuses a Stream above the row bound as a resource failure, and a failing Stream as an encoding failure",
		() =>
			Effect.gen(function* () {
				const maxRows = 2
				const atCap = yield* hostParams([ids], { ids: Stream.fromIterable([1, 2]) }, maxRows)
				assert.deepEqual(atCap, { ids: [1, 2] })
				const over = yield* Effect.flip(
					hostParams([ids], { ids: Stream.fromIterable([1, 2, 3]) }, maxRows)
				)
				assert.equal(over.stage, "resource")
				const failing = yield* Effect.flip(hostParams([ids], { ids: Stream.fail("boom") }, maxRows))
				assert.deepEqual(refusalOf(failing), { kind: "codec", slot: "ids" })
			})
	)
})

/**
 * A read with a rule the optimizer proves empty: an interior pinned to one roster handle, matched at another. That rule
 * alone reads the scalar parameter p, so the optimized artifact binds no slot for it; the read's other rule reads q.
 * With both pins at one handle the rule is not empty and its statement binds p.
 */
const handles = ["Red", "Green", "Blue"] as const
const Color = closed("Color", handles)
const Sample = relation(
	"Sample",
	{
		id: uuidField,
		color: closedId(Color),
		whole: pg.integer,
		big: pg.bigint,
		flag: pg.boolean,
		ref: uuidField,
		label: str.regex("^.*$", "su")
	},
	["id"]
)
const Pinned = schema("Pinned", { Color, Sample }, [])

/**
 * What p is declared as: the field of Sample it is compared with, its descriptor, a value of its host type, and values
 * of other host types.
 */
const parameterKinds = [
	{ field: "whole", type: pg.integer, valid: 7, wrong: ["7", 7n, true, { wild: true }, [7]] },
	{ field: "big", type: pg.bigint, valid: 7n, wrong: [7, "7", { wild: true }] },
	{ field: "flag", type: pg.boolean, valid: true, wrong: ["true", 1, { wild: true }] },
	{
		field: "ref",
		type: uuidField,
		valid: "00000000-0000-4000-8000-000000000001",
		wrong: [7, true, { wild: true }]
	},
	{ field: "label", type: str.regex("^.*$", "su"), valid: "a", wrong: [1, true, { wild: true }] }
] as const

/**
 * A drawn read: the interior's pin and the outer pin, what p is declared as, and the value of another host type given
 * for it.
 */
const pinnedReadGen = (source: Source) => {
	const read = {
		inner: source.draw(element(handles)),
		outer: source.draw(element(handles)),
		kind: source.draw(element<(typeof parameterKinds)[number]>(parameterKinds))
	}
	return { read, wrong: source.draw(element<unknown>(read.kind.wrong)) }
}

type PinnedFeature = "a parameter only an eliminated rule reads" | "a parameter a statement binds"

describe("every declared parameter admitted at the read boundary", () => {
	it.effect(
		"refuses a scalar parameter of another host type whether or not the optimized artifact binds it, and admits a valid one",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/adapter/reader-eliminated-parameter",
						draw: drawn(pinnedReadGen),
						literal: Formatter.format,
						coverage: required<PinnedFeature>(
							["a parameter only an eliminated rule reads", "a parameter a statement binds"],
							{ cases: 100, sense: notesOnly }
						),
						kept: [],
						runs: 100,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang: Duration.minutes(2)
					},
					({ read: { inner, outer, kind }, wrong }, c) =>
						Effect.sync(() => {
							const q = queryOver(Pinned)
								.rule((r: RuleValue) => {
									const { id, [kind.field]: x } = varsOver(Sample, "sample")
									const pinned = r.interior((r2: RuleValue) => {
										const { id: handle } = varsOver(Color, "color")
										return r2
											.match(Color, { id: handle })
											.where(r2.eq(handle, inner))
											.find({ handle })
									})
									return r
										.match(Sample, { id, color: outer, [kind.field]: x })
										.match(pinned, { handle: outer })
										.where(r.eq(x, r.param("p", kind.type)))
										.find({ id })
								})
								.rule((r: RuleValue) => {
									const { id, whole } = varsOver(Sample, "sample")
									return r
										.match(Sample, { id, whole })
										.where(r.eq(whole, r.param("q", pg.integer)))
										.find({ id })
								})
							const template = succeeded(compileTemplate(q, Pinned, testCompile))
							const p = Option.getOrThrowWith(
								Arr.findFirst(template.params, (d) => d.name === "p"),
								() => new Error("the read declares p")
							)
							/**
							 * The optimized artifact's statements, its large variants included: a rule that is not empty binds p.
							 */
							const optimized = template.programs.optimized
							const bound = Arr.some(
								[
									...flight(optimized.roots),
									...largeStatements(flight(optimized.roots), (l) => l.statement)
								],
								(s) => Arr.some(s.params, (slot) => slot.kind === "scalar" && slot.param === p.id)
							)
							if (inner === outer) {
								assert.ok(bound, `pinned and matched at ${inner}: its statement binds p`)
							}
							c.note(
								bound
									? "a parameter a statement binds"
									: "a parameter only an eliminated rule reads"
							)
							const valid = { p: kind.valid, q: 3 }
							const refused = executionInputs(
								paramCodecs(template.params),
								{ ...valid, p: wrong },
								{ valuesMaxRows, recordsetMaxRows }
							)
							assert.ok(
								Result.isFailure(refused),
								`p declared ${kind.field}, given a value of another host type, is admitted`
							)
							assert.deepEqual(refusalOf(ReadFailure.make({ reason: refused.failure })), {
								kind: "codec",
								slot: "p"
							})
							/**
							 * A valid value is admitted, and every declared scalar parameter is encoded, the eliminated one too.
							 */
							const admitted = Result.getOrThrow(
								executionInputs(paramCodecs(template.params), valid, {
									valuesMaxRows,
									recordsetMaxRows
								})
							)
							assert.deepEqual(
								new Set(admitted.scalars.keys()),
								new Set(Arr.flatMap(template.params, (d) => (d.kind === "relation" ? [] : [d.id])))
							)
						})
				)
			)
	)
})

const u = (n: number) => ({ id: `00000000-0000-4000-8000-00000000000${n}` })

describe("relation transport by the size rule", () => {
	const ids: RelationParamDecl = {
		id: ParamId("p1"),
		name: "ids",
		kind: "relation",
		heading: [{ name: "id", type: uuid }]
	}
	const account: ParamDecl = { id: ParamId("p2"), name: "account", kind: "scalar", type: uuid }
	const limits = { valuesMaxRows: 2, recordsetMaxRows: 4 }
	const transport = (facts: unknown) => {
		const prepared = executionInputs(
			paramCodecs([ids, account]),
			{ ids: facts, account: u(9).id },
			limits
		)
		if (Result.isFailure(prepared)) {
			return refusalOf(ReadFailure.make({ reason: prepared.failure }))
		}
		const normalized = prepared.success.relations.get(ids.id)?.normalized
		return [
			normalized === undefined ? undefined : relationTransport(normalized.facts, limits).kind,
			normalized?.count
		]
	}

	/** The text rows of a prepared input over `columns`, in their column order. */
	const rowsOver = (
		input: ReturnType<RelationInputs["get"]>,
		columns: RelationParamDecl["heading"]
	) => (input === undefined ? undefined : Result.map(input.over(columns), (n) => n.rows))

	/** Whether a refusal is at encode and names the parameter `ids`, alone or with one of its fields. */
	const namesIds = (refusal: Refusal): boolean =>
		refusal.kind === "codec" &&
		(refusal.slot === "ids" || (refusal.slot !== undefined && Str.startsWith("ids.")(refusal.slot)))

	it("counts distinct facts: VALUES up to valuesMaxRows, a recordset above and for the empty input", () => {
		assert.deepEqual(transport([u(1), u(2), u(1)]), ["values", 2])
		assert.deepEqual(transport([u(1)]), ["values", 1])
		assert.deepEqual(transport([]), ["recordset", 0])
		assert.deepEqual(transport([u(1), u(2), u(3)]), ["recordset", 3])
		assert.deepEqual(transport([u(1), u(2), u(3), u(4), u(4)]), ["recordset", 4])
	})

	it("refuses an input above recordsetMaxRows as a resource failure, and one the codec refuses as encode, naming it", () => {
		assert.deepEqual(transport([u(1), u(2), u(3), u(4), u(5)]), {
			kind: "stage",
			stage: "resource"
		})
		assert.deepEqual(transport([{ id: "not-a-uuid" }]), { kind: "codec", slot: "ids.id" })
		const refused = transport([u(1), null])
		assert.ok(!Arr.isArray(refused) && namesIds(refused))
		assert.deepEqual(transport("not facts"), { kind: "codec", slot: "ids" })
		assert.deepEqual(transport(undefined), { kind: "codec", slot: "ids" })
	})

	it("gives the text rows in each slot's column order", () => {
		const pair: RelationParamDecl = {
			...ids,
			heading: [
				{ name: "a", type: uuid },
				{ name: "b", type: uuid }
			]
		}
		const prepared = succeeded(
			executionInputs(paramCodecs([pair]), { ids: [{ a: u(1).id, b: u(2).id }] }, limits)
		)
		const input = prepared.relations.get(pair.id)
		assert.deepEqual(rowsOver(input, pair.heading), Result.succeed([[u(1).id, u(2).id]]))
		assert.deepEqual(
			rowsOver(input, Arr.reverse(pair.heading)),
			Result.succeed([[u(2).id, u(1).id]])
		)
	})

	it("gives another column order's rows for an input that can be iterated only once", () => {
		const pair: RelationParamDecl = {
			...ids,
			heading: [
				{ name: "a", type: uuid },
				{ name: "b", type: uuid }
			]
		}
		const once = (function* () {
			yield { a: u(1).id, b: u(2).id }
			yield { a: u(3).id, b: u(4).id }
		})()
		const prepared = succeeded(executionInputs(paramCodecs([pair]), { ids: once }, limits))
		const input = prepared.relations.get(pair.id)
		assert.deepEqual(
			rowsOver(input, Arr.reverse(pair.heading)),
			Result.succeed([
				[u(2).id, u(1).id],
				[u(4).id, u(3).id]
			])
		)
	})
})

describe("capabilities found after admission", () => {
	it("names the first extension a template needs that is not installed in its compiled schema", () => {
		const needs = { extensions: ["vector"], extensionSchemas: { vector: "vector_ext" } }
		assert.equal(missingExtension(needs, new Map([["vector", "vector_ext"]])), undefined)
		assert.equal(missingExtension(needs, new Map()), "extension vector in schema vector_ext")
		assert.equal(
			missingExtension(needs, new Map([["vector", "public"]])),
			"extension vector in schema vector_ext"
		)
		assert.equal(missingExtension({ extensions: [], extensionSchemas: {} }, new Map()), undefined)
	})
})

describe("attachment heads", () => {
	const nested = query(W.Work)
		.rule((r) => {
			const { id, name } = v(W.Account, "account")
			return r.match(W.Account, { id, name }).find({ id, name })
		})
		.attach(
			"tasks",
			(a) =>
				query(W.Work)
					.rule((r) => {
						const { id, kind } = v(W.Task, "task")
						return r.match(W.Task, { id, account: a.id, kind }).find({ id, kind })
					})
					.attach(
						"note",
						(t) =>
							query(W.Work).rule((r) => {
								const { note } = v(W.TaskNote, "taskNote")
								return r.match(W.TaskNote, { task: t.id, note }).find({ note })
							}),
						"option"
					)
					.orderBy(["id", "asc"]),
			"array"
		)

	it("reads each delivered attachment's head keys by its path, nested ones included", () => {
		const desc = queryValueDesc(nested)
		if (desc === undefined) {
			throw new Error("a query value")
		}
		const tasks = attachmentHeads(desc).under.get("tasks")
		assert.deepEqual(Arr.sort([...(tasks?.heads ?? [])], Order.String), ["id", "kind"])
		assert.deepEqual([...(tasks?.under.get("note")?.heads ?? [])], ["note"])
		const cards = queryValueDesc(W.taskCards)
		if (cards === undefined) {
			throw new Error("a query value")
		}
		const cardHeads = attachmentHeads(cards).under
		assert.deepEqual([...(cardHeads.get("note")?.heads ?? [])], ["note"])
		assert.deepEqual([...(cardHeads.get("automatic")?.heads ?? [])], ["budget"])
	})
})
