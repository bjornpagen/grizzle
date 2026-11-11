import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, constant, element, type Gen, int, shuffled, weighted } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import type { Source } from "@grizzle/testing/source"
import { searched } from "@grizzle/testing/vitest"
import {
	Array as Arr,
	Effect,
	Exit,
	Formatter,
	Option,
	Order,
	Record as Rec,
	Result,
	Stream,
	String as Str
} from "effect"
import { ReadFailure } from "#adapter/errors/execution.ts"
import { hostParams } from "#adapter/reader/params.ts"
import { executionInputs, paramCodecs } from "#adapter/reader/relations.ts"
import type { EncodingFailure } from "#compiler/core/errors.ts"
import { ParamId } from "#compiler/core/ids.ts"
import { emptyCodebook } from "#compiler/ir/codes.ts"
import type { RelationParamDecl } from "#compiler/ir/products.ts"
import type { RelationColumn } from "#compiler/lower/conservative/types.ts"
import { closedId, pg, uuid as uuidField } from "#compiler/public/fields.ts"
import { closed, relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { queryOver, varsOver } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { CompilePatterns } from "#compiler/scalar/regex/patterns.ts"
import { columnDefinition, types } from "#compiler/sql/build.ts"
import type { ParamValue } from "#compiler/types/core/phantom.ts"
import { readArrayLiteral } from "#test/support/arrays.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import {
	codebookFor,
	compileTemplate,
	firstCodes,
	schemaInputOf,
	testCompile
} from "#test/support/compile.ts"
import { f } from "#test/support/fixtures/ir/desc.ts"
import { scalarOf } from "#test/support/fixtures/ir/scalar.ts"
import { caseHang } from "#test/support/limits.ts"
import { sentForms } from "#test/support/oracle/forms.ts"
import { upTo } from "#test/support/up-to.ts"
import { textOfParam } from "#test/support/wire.ts"

/**
 * The pure parts of the reader: a relation input from the caller's value to the arrays its statements bind, every
 * declared parameter admitted at the read boundary whatever the optimizer eliminated, and the capability check of a
 * compiled template against the installed extensions. Which head keys an attachment delivers is the public
 * differential's (test/pg/oracle/public), whose programs nest attachments and correlate them on parent columns no head
 * key delivers, and whose answers the reference evaluator judges column by column.
 *
 * A read's refusal as the contract states it: a codec's refusal at encode with the slot its EncodingFailure names, the
 * parameter or `parameter.field` (README "Errors and outcomes": as a write's names it), or any other refusal by its stage.
 *
 * Oracles: the read boundary's contract, every declared parameter admitted whether or not a statement binds it; the
 * relation input's arrays restated from the caller's value; and each refusal's documented stage and slot.
 *
 * Plants (~/.cache/grizzle-release/BR04/plants): reader-scalar-refusal-dropped.patch (a scalar parameter its codec
 * refuses is left out rather than refused).
 *
 * Features: a parameter only an eliminated rule reads, one a statement binds; each relation input's shape and refusal.
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
/** The codes a fresh installation of Pinned holds, which its parameters' codecs encode under. */
const pinnedCodes = succeeded(codebookFor(schemaInputOf(Pinned), firstCodes))

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
						oracle: {
							kind: "specification",
							name: "every declared parameter is admitted at the read boundary, whatever the optimizer eliminated"
						},
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
						caseHang
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
							 * The optimized artifact's statement, its large form included: a rule that is not empty binds p.
							 */
							const bound = Arr.some(sentForms(template.programs.optimized.statement), (s) =>
								Arr.some(s.params, (slot) => slot.kind === "scalar" && slot.param === p.id)
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
								paramCodecs(template.params, pinnedCodes, new CompilePatterns()),
								{
									...valid,
									p: wrong
								}
							)
							assert.ok(
								Result.isFailure(refused),
								`p declared ${kind.field}, given a value of another host type, is admitted`
							)
							assert.deepEqual(refusalOf(new ReadFailure({ reason: refused.failure })), {
								kind: "codec",
								slot: "p"
							})
							/**
							 * A valid value is admitted, and every declared scalar parameter is encoded, the eliminated one too.
							 */
							const admitted = Result.getOrThrow(
								executionInputs(
									paramCodecs(template.params, pinnedCodes, new CompilePatterns()),
									valid
								)
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

/**
 * A read's relation input, from the caller's value to the arrays its statements bind (reader/params.ts hostParams, then
 * reader/relations.ts executionInputs): an array, a Stream collected whole on the host, or an iterable that can be read
 * only once, of any number of facts, more than the 65,535 parameters a statement binds among them, with no row bound; deduplicated; and written as one array per
 * column in any column order a statement's slot reads, each placeholder's array by itself. An array or an
 * iterable passes the host step as it is. A codec's refusal is the EncodingFailure naming the parameter, or
 * `parameter.field` for a fact's field, and a Stream that fails is the parameter's.
 *
 * The oracle is the input's set of facts: the arrays of each column order, read as PostgreSQL's array_in reads them and
 * zipped into rows, are exactly the distinct facts projected onto those columns, no row twice; the arrays of another
 * order are the declared order's, permuted, so every order aligns its rows alike; and the scalar parameter beside the
 * input is admitted. A planted fault names its slot.
 */
const columnNames = ["a", "b", "c"] as const
type ColumnName = (typeof columnNames)[number]

/** The `n`th uuid of the inputs: n in hexadecimal, its last group. */
const uuidAt = (n: number): string =>
	`00000000-0000-4000-8000-${Str.padStart(12, "0")(n.toString(16))}`

/** A fact as the caller writes it: each column's value, a uuid, a text no uuid or a null. */
type Fact = Readonly<Partial<Record<ColumnName, string | null>>>

/** How the caller hands the facts over. */
type Delivery = "an array" | "a Stream" | "an iterable read once" | "a Stream that fails"

/** What stands in for the facts when no iterable does. */
type NotFacts = "a text" | "a number" | "undefined" | "null" | "an object"

/** A fault planted in the input, refused at encode naming its slot. */
type Fault =
	| { readonly kind: "none" }
	| { readonly kind: "a field no uuid"; readonly at: number; readonly field: number }
	| { readonly kind: "a null field"; readonly at: number; readonly field: number }
	| { readonly kind: "a null fact"; readonly at: number }
	| { readonly kind: "no iterable"; readonly value: NotFacts }

/**
 * The facts: a few, each field one of three uuids, so facts repeat; or many, the nth fact's every field the nth uuid,
 * and the first written again at the end, now and then more than the 65,535 parameters a statement binds.
 */
type Facts =
	| { readonly kind: "few"; readonly facts: ReadonlyArray<ReadonlyArray<number>> }
	| { readonly kind: "many"; readonly count: number }

interface InputCase {
	readonly width: number
	readonly facts: Facts
	readonly delivery: Delivery
	readonly fault: Fault
	/** Another column order a statement's slot reads: the declared columns' positions, shuffled. */
	readonly order: ReadonlyArray<number>
	readonly account: number
}

const inputCaseGen: Gen<InputCase> = (source) => {
	const width = source.draw(int(1, columnNames.length))
	const positions = upTo(width, (i) => i)
	return {
		width,
		facts: source.draw(
			weighted<Facts>([
				[
					40,
					(inner) => ({
						kind: "few",
						facts: inner.draw(
							array(array(int(0, 2), { min: width, max: width }), { min: 0, max: 8 })
						)
					})
				],
				[4, (inner) => ({ kind: "many", count: inner.draw(int(9, 400)) })],
				[1, (inner) => ({ kind: "many", count: inner.draw(int(65_536, 80_000)) })]
			])
		),
		delivery: source.draw(
			element<Delivery>(["an array", "a Stream", "an iterable read once", "a Stream that fails"])
		),
		fault: source.draw(
			weighted<Fault>([
				[4, constant({ kind: "none" })],
				[
					1,
					(inner) => ({
						kind: "a field no uuid",
						at: inner.draw(int(0, 0xffff)),
						field: inner.draw(int(0, width - 1))
					})
				],
				[
					1,
					(inner) => ({
						kind: "a null field",
						at: inner.draw(int(0, 0xffff)),
						field: inner.draw(int(0, width - 1))
					})
				],
				[1, (inner) => ({ kind: "a null fact", at: inner.draw(int(0, 0xffff)) })],
				[
					1,
					(inner) => ({
						kind: "no iterable",
						value: inner.draw(
							element<NotFacts>(["a text", "a number", "undefined", "null", "an object"])
						)
					})
				]
			])
		),
		order: source.draw(shuffled(positions, { min: width, max: width })),
		account: source.draw(int(0, 0xffff))
	}
}

/** The declared heading's columns, the first `width` of a, b and c. */
const headingOf = (width: number): ReadonlyArray<ColumnName> => columnNames.slice(0, width)

/** The facts a case draws, before any fault. */
const factsOf = (c: InputCase): ReadonlyArray<Fact> => {
	const heading = headingOf(c.width)
	const fact = (values: (column: number) => number): Fact =>
		Rec.fromEntries(Arr.map(heading, (name, i) => [name, uuidAt(values(i))] as const))
	switch (c.facts.kind) {
		case "few":
			return Arr.map(c.facts.facts, (values) => fact((i) => defined(values[i], "a fact's value")))
		case "many": {
			const many = upTo(c.facts.count, (n) => fact(() => n))
			return [...many, fact(() => 0)]
		}
	}
}

/** The facts with the case's fault planted at its place, a new fact's field or a new fact of its own. */
const plantedFacts = (c: InputCase, facts: ReadonlyArray<Fact>): ReadonlyArray<Fact | null> => {
	const fault = c.fault
	const heading = headingOf(c.width)
	const planted = (pick: number, fact: Fact | null): ReadonlyArray<Fact | null> => {
		const at = pick % (facts.length + 1)
		return [...Arr.take(facts, at), fact, ...Arr.drop(facts, at)]
	}
	const valid: Fact = Rec.fromEntries(Arr.map(heading, (name) => [name, uuidAt(0)] as const))
	const field = (pick: number): ColumnName => defined(heading[pick % heading.length], "a column")
	switch (fault.kind) {
		case "none":
		case "no iterable":
			return facts
		case "a field no uuid":
			return planted(fault.at, { ...valid, [field(fault.field)]: "not-a-uuid" })
		case "a null field":
			return planted(fault.at, { ...valid, [field(fault.field)]: null })
		case "a null fact":
			return planted(fault.at, null)
	}
}

/**
 * The value the caller passes for the input: one the typed boundary admits (ParamValue), which the host step reads, or
 * one only a JavaScript caller passes, which reaches the relation codec as it is.
 */
type Passed =
	| { readonly kind: "typed"; readonly value: ParamValue }
	| { readonly kind: "untyped"; readonly value: unknown }

const notFacts = (value: NotFacts): Passed => {
	switch (value) {
		case "a text":
			return { kind: "typed", value: "not facts" }
		case "a number":
			return { kind: "typed", value: 7 }
		case "undefined":
			return { kind: "untyped", value: undefined }
		case "null":
			return { kind: "untyped", value: null }
		case "an object":
			return { kind: "untyped", value: { a: uuidAt(0) } }
	}
}

const delivered = (c: InputCase, facts: ReadonlyArray<Fact | null>): Passed => {
	if (c.fault.kind === "no iterable") {
		return notFacts(c.fault.value)
	}
	switch (c.delivery) {
		case "an array":
			return { kind: "typed", value: facts }
		case "a Stream":
			return { kind: "typed", value: Stream.fromIterable(facts) }
		case "an iterable read once":
			return { kind: "untyped", value: facts.values() }
		case "a Stream that fails":
			return {
				kind: "typed",
				value: Stream.concat(Stream.fromIterable(facts), Stream.fail("the caller's failure"))
			}
	}
}

/** The slot the case's refusal names, or undefined for an input admitted. */
const refusedSlot = (c: InputCase): string | undefined => {
	const fault = c.fault
	const heading = headingOf(c.width)
	if (fault.kind === "no iterable") {
		return "ids"
	}
	if (c.delivery === "a Stream that fails") {
		return "ids"
	}
	switch (fault.kind) {
		case "none":
			return undefined
		case "a null fact":
			return "ids"
		case "a field no uuid":
		case "a null field":
			return `ids.${defined(heading[fault.field % heading.length], "a column")}`
	}
}

/** A statement slot's column `name`, of type uuid, under the generated name `column`. */
const slotColumn = (name: string, column: string): RelationColumn => ({
	name,
	type: uuid,
	definition: columnDefinition(column, types.uuid)
})

type InputFeature =
	| Delivery
	| "no fact"
	| "a repeated fact"
	| "more facts than a statement binds parameters"
	| "columns read in another order"
	| `refused: ${Exclude<Fault["kind"], "none">}`
	| "refused: a failing Stream"

describe("a read's relation input", () => {
	it.effect(
		"is its distinct facts, in arrays of every column order a slot reads, from any delivery and any number of facts; a codec's refusal names its slot",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/adapter/reader-inputs",
						draw: drawn(inputCaseGen),
						literal: Formatter.format,
						oracle: {
							kind: "specification",
							name: "the input's distinct facts, projected onto each column order a slot reads"
						},
						coverage: required<InputFeature>(
							[
								"an array",
								"a Stream",
								"an iterable read once",
								"a Stream that fails",
								"no fact",
								"a repeated fact",
								"more facts than a statement binds parameters",
								"columns read in another order",
								"refused: a field no uuid",
								"refused: a null field",
								"refused: a null fact",
								"refused: no iterable",
								"refused: a failing Stream"
							],
							{ cases: 300, sense: notesOnly }
						),
						kept: [],
						runs: 120,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(c, k) =>
						Effect.gen(function* () {
							const heading = headingOf(c.width)
							const ids: RelationParamDecl = {
								id: ParamId("p1"),
								name: "ids",
								kind: "relation",
								heading: Arr.map(heading, (name) => ({ name, type: uuid }))
							}
							const account = uuidAt(c.account)
							const declared = [
								ids,
								{ id: ParamId("p2"), name: "account", kind: "scalar", type: uuid } as const
							]
							const facts = factsOf(c)
							const value = delivered(c, plantedFacts(c, facts))
							const slot = refusedSlot(c)
							const host = yield* Effect.exit(
								value.kind === "typed"
									? hostParams(declared, { ids: value.value, account })
									: Effect.succeed({ ids: value.value, account })
							)
							const prepared = Exit.isSuccess(host)
								? executionInputs(
										paramCodecs(declared, emptyCodebook, new CompilePatterns()),
										host.value
									)
								: undefined
							if (c.fault.kind !== "no iterable") {
								k.note(c.delivery)
							}
							if (slot !== undefined) {
								const refusal: EncodingFailure | ReadFailure | undefined = Exit.isFailure(host)
									? Option.getOrUndefined(Exit.findErrorOption(host))
									: prepared !== undefined && Result.isFailure(prepared)
										? prepared.failure
										: undefined
								const reason = refusal instanceof ReadFailure ? refusal.reason : refusal
								assert.deepEqual(
									reason?._tag === "EncodingFailure" ? reason.place : undefined,
									{ _tag: "Slot", name: slot },
									"the refusal names its slot"
								)
								k.note(
									c.fault.kind === "none"
										? "refused: a failing Stream"
										: c.delivery === "a Stream that fails" && c.fault.kind !== "no iterable"
											? "refused: a failing Stream"
											: `refused: ${c.fault.kind}`
								)
								return
							}
							assert.ok(Exit.isSuccess(host), "the host step admits the input")
							const passed = host.value["ids"]
							assert.ok(
								passed === value.value || c.delivery !== "an array",
								"an array passes the host step as it is"
							)
							const inputs = succeeded(defined(prepared, "the inputs"))
							assert.ok(inputs.scalars.has(ParamId("p2")), "the scalar parameter is admitted")
							const input = defined(inputs.relations.get(ids.id), "the read admits ids")
							/** The input's arrays over `columns`, each placeholder's written by itself at its part. */
							const arraysOver = (columns: ReadonlyArray<RelationColumn>) =>
								Arr.map(columns, (_, part) => succeeded(input.array(columns, part)))
							const otherNames = Arr.map(c.order, (i) => defined(heading[i], "a column"))
							const declaredColumns = Arr.map(heading, (name, i) => slotColumn(name, `c${i}`))
							const otherColumns = Arr.map(otherNames, (name, i) => slotColumn(name, `d${i}`))
							/** A row as one text: its values, uuids which hold no space, joined by spaces. */
							const keyOf = (row: ReadonlyArray<unknown>): string =>
								Arr.join(
									Arr.map(row, (value) => String(value)),
									" "
								)
							const projectedKeys = (names: ReadonlyArray<ColumnName>) =>
								Arr.sort(
									new Set(Arr.map(facts, (fact) => keyOf(Arr.map(names, (name) => fact[name])))),
									Order.String
								)
							for (const [names, columns] of [
								[heading, declaredColumns],
								[otherNames, otherColumns]
							] as const) {
								const literals = Arr.map(arraysOver(columns), (array) =>
									readArrayLiteral(textOfParam(array))
								)
								const rows = Arr.map(defined(literals[0], "a column's array"), (_, row) =>
									keyOf(Arr.map(literals, (column) => column[row]))
								)
								assert.equal(new Set(rows).size, rows.length, "no row twice")
								assert.deepEqual(
									Arr.sort(rows, Order.String),
									projectedKeys(names),
									"the distinct facts over the slot's columns"
								)
							}
							const distinct = projectedKeys(heading)
							const declaredArrays = arraysOver(declaredColumns)
							assert.deepEqual(
								arraysOver(otherColumns),
								Arr.map(c.order, (i) => defined(declaredArrays[i], "a column's array")),
								"another order's arrays are the declared order's, permuted"
							)
							if (distinct.length === 0) {
								k.note("no fact")
							}
							if (distinct.length < facts.length) {
								k.note("a repeated fact")
							}
							if (facts.length > 65_535) {
								k.note("more facts than a statement binds parameters")
							}
							if (Arr.some(c.order, (position, i) => position !== i)) {
								k.note("columns read in another order")
							}
						})
				)
			)
	)
})
