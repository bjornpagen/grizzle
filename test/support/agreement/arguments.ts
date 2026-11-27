import { Array as Arr, Record as Rec, Result } from "effect"
import { readParams } from "#adapter/reader/params.ts"
import { executionInputs, paramCodecs } from "#adapter/reader/relations.ts"
import { jsonText } from "#compiler/core/trusted.ts"
import { emptyCodebook } from "#compiler/ir/codes.ts"

import { nonEmpty } from "@bjornpagen/testing/assert"
import { queryOver, varsOver } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { Agree, Cell } from "#test/support/agreement/schema.ts"
import { compileTemplate, testCompile } from "#test/support/compile.ts"
import { Id } from "#test/support/ids.ts"
import { type PreludeAt, preludeModule } from "#test/support/prelude.ts"
import { batchOwned, caseOwned, type Program } from "#test/types/batch/batch.ts"

/**
 * The argument agreement: every shape of a query's parameters against every form of argument a caller may pass as the
 * params of the query's workload member's once, the program admitting exactly what the runtime admits. The oracle is the
 * runtime's own reading of an argument (adapter/reader/params.ts readParams, then adapter/reader/relations.ts
 * executionInputs over the compiled query's declared parameters): a record whose keys are the query's parameters, each
 * value admitted by its parameter's codec. The types are ParamArg over the query's ParamsOf, which a workload handle's
 * reads take, the handle as a Db of Reader serving the query holds it (WorkloadHandles).
 *
 * Shapes and forms are closed unions read by exhaustive switches, so a new one is a compile error until it has its
 * cells. Each statement is one line, under a directive where the runtime refuses it (directiveOf): a key no parameter
 * is named under its named refusal, whether or not the query declares a parameter (types/core/phantom.ts OnlyParams),
 * an array's included, whose indices are such keys; and a property's value of another type, any other value that is
 * no record, and a record missing a declared parameter, each a structural refusal.
 */

/** The parameters of a query: none, one scalar parameter of a carrier, or a relation parameter. */
const shapes = ["none", "integer", "boolean", "uuid", "text", "relation"] as const
type Shape = (typeof shapes)[number]

/**
 * What a caller passes: each parameter a value of its type, a record of none, an undeclared key beside them, one of
 * another type, or a number, a boolean or an array in place of a record.
 */
const forms = ["exact", "empty", "extra", "wrongValue", "number", "boolean", "array"] as const
type Form = (typeof forms)[number]

/** A JavaScript value: its source in the program, and its value. */
interface Value {
	readonly text: string
	readonly value: unknown
}

/** A value of a shape's parameter, and one of another type, which its codec refuses. */
const valuesOf = (
	shape: Exclude<Shape, "none">
): { readonly valid: Value; readonly wrong: Value } => {
	switch (shape) {
		case "integer":
			return { valid: { text: "1", value: 1 }, wrong: { text: '"1"', value: "1" } }
		case "boolean":
			return { valid: { text: "true", value: true }, wrong: { text: "1", value: 1 } }
		case "uuid":
			return {
				valid: {
					text: 'toId("00000000-0000-4000-8000-000000000001")',
					value: "00000000-0000-4000-8000-000000000001"
				},
				wrong: { text: '"x"', value: "x" }
			}
		case "text":
			return { valid: { text: '"x"', value: "x" }, wrong: { text: "1", value: 1 } }
		case "relation":
			return {
				valid: {
					text: '[{ id: toId("00000000-0000-4000-8000-000000000001") }]',
					value: [{ id: "00000000-0000-4000-8000-000000000001" }]
				},
				wrong: { text: "[{ id: 1 }]", value: [{ id: 1 }] }
			}
	}
}

/** A shape's query over Cell: its source in the program, and its value through the builder's JavaScript view. */
const queryOf = (shape: Shape): { readonly source: string; readonly value: () => unknown } => {
	const plain = (field: "integer" | "boolean" | "uuid" | "text") => ({
		source: `query(Agree).rule((r) => { const { id, ${field} } = v(Cell, "cell"); return r.match(Cell, { id, ${field} }).where(r.eq(${field}, r.param("p", Cell.fields.${field}))).find({ id }) })`,
		value: () =>
			queryOver(Agree).rule((r: RuleValue) => {
				const cell = varsOver(Cell, "cell")
				return r
					.match(Cell, { id: cell["id"], [field]: cell[field] })
					.where(r.eq(cell[field], r.param("p", Cell.fields[field])))
					.find({ id: cell["id"] })
			})
	})
	switch (shape) {
		case "none":
			return {
				source:
					'query(Agree).rule((r) => { const { id } = v(Cell, "cell"); return r.match(Cell, { id }).find({ id }) })',
				value: () =>
					queryOver(Agree).rule((r: RuleValue) => {
						const cell = varsOver(Cell, "cell")
						return r.match(Cell, { id: cell["id"] }).find({ id: cell["id"] })
					})
			}
		case "integer":
		case "boolean":
		case "uuid":
		case "text":
			return plain(shape)
		case "relation":
			return {
				source:
					'query(Agree).rule((r) => { const p = r.relation("p", { id: Id }); const { id } = v(Cell, "cell"); return r.match(p, { id }).match(Cell, { id }).find({ id }) })',
				value: () =>
					queryOver(Agree).rule((r: RuleValue) => {
						const p = r.relation("p", { id: Id })
						const cell = varsOver(Cell, "cell")
						return r
							.match(p, { id: cell["id"] })
							.match(Cell, { id: cell["id"] })
							.find({ id: cell["id"] })
					})
			}
	}
}

/** An argument of a form for a shape, as a property list or another value; none where the form needs a parameter. */
const argumentOf = (shape: Shape, form: Form): Value | undefined => {
	const record = (entries: ReadonlyArray<readonly [string, Value]>): Value => ({
		text: Arr.isReadonlyArrayNonEmpty(entries)
			? `{ ${Arr.join(
					Arr.map(entries, ([k, v]) => `${k}: ${v.text}`),
					", "
				)} }`
			: "{}",
		value: Rec.fromEntries(Arr.map(entries, ([k, v]) => [k, v.value] as const))
	})
	const extra: readonly [string, Value] = ["extra", { text: "1", value: 1 }]
	switch (form) {
		case "number":
			return { text: "42", value: 42 }
		case "boolean":
			return { text: "true", value: true }
		case "array":
			return { text: "[1, 2]", value: [1, 2] }
		case "empty":
			return record([])
		case "exact":
			return shape === "none" ? undefined : record([["p", valuesOf(shape).valid]])
		case "extra":
			return record(shape === "none" ? [extra] : [["p", valuesOf(shape).valid], extra])
		case "wrongValue":
			return shape === "none" ? undefined : record([["p", valuesOf(shape).wrong]])
	}
}

/** The directive over an argument the runtime refuses: its form's named refusal, else a structural refusal and why. */
const directiveOf = (shape: Shape, form: Form): string => {
	switch (form) {
		case "extra":
		case "array":
			return "// @ts-expect-error -- refusal: a parameter map names only its program's parameters"
		case "wrongValue":
		case "number":
		case "boolean":
		case "empty":
		case "exact":
			return `// @ts-expect-error -- refused: the runtime refuses ${jsonText(form)} for ${jsonText(shape)}`
	}
}

/**
 * The runtime's reading of an argument as a JavaScript caller reaches it, with whatever value it passes: its own answer
 * to a value ParamArg refuses is the oracle the types are held to.
 */
const hostArguments: {
	read(
		program: string,
		names: ReadonlyArray<string>,
		params: unknown
	): ReturnType<typeof readParams>
} = { read: readParams }

/** Whether the runtime admits an argument for a query: its one reading of an argument, against the declared parameters. */
const admits = (query: () => unknown, argument: unknown): boolean => {
	const template = compileTemplate(query(), undefined, testCompile)
	if (!template.ok) {
		throw new Error(`the engine refuses an argument cell's query: ${template.error.message}`)
	}
	const declared = template.value.params
	const given = hostArguments.read(
		"the argument cell's query",
		Arr.map(declared, (d) => d.name),
		argument
	)
	return (
		Result.isSuccess(given) &&
		Result.isSuccess(executionInputs(paramCodecs(declared, emptyCodebook), given.success))
	)
}

/** One cell of the box: a shape of a query's parameters, a form of argument, and the argument that form passes. */
export interface ArgumentCell {
	readonly shape: Shape
	readonly form: Form
	readonly argument: Value
}

/** The cells of argumentBox, minted as a dictionary in its door (test/types/evidence/agreement.dictionary.ts). */
export const argumentBoxItems: Arr.NonEmptyReadonlyArray<ArgumentCell> = nonEmpty(
	Arr.flatMap(shapes, (shape) =>
		Arr.flatMap(forms, (form): ReadonlyArray<ArgumentCell> => {
			const argument = argumentOf(shape, form)
			return argument === undefined ? [] : [{ shape, form, argument }]
		})
	),
	"every shape has an argument of a form"
)

/** A cell's lines: its argument through its query's workload handle, under a directive where the runtime refuses it. */
const cellLines = ({ shape, form, argument }: ArgumentCell): ReadonlyArray<string> => {
	const s = shapes.indexOf(shape)
	const admitted = admits(queryOf(shape).value, argument.value)
	const line = `export const a${s}_${forms.indexOf(form)} = (h: WorkloadHandles<typeof Reader, { readonly m: typeof q${s} }>["m"]) => h.once({ params: ${argument.text}, facts: {} })`
	return [
		`/** ${form} for ${shape}: the runtime ${admitted ? "admits" : "refuses"} it. */`,
		...(admitted ? [line] : [directiveOf(shape, form), line])
	]
}

/**
 * The program of a batch of the box's cells, each owning its lines, after each shape's query, the batch's own and
 * exported, so a batch whose cells read only some of them leaves none unused.
 */
export const argumentProgram = (
	cells: Arr.NonEmptyReadonlyArray<ArgumentCell>,
	at: PreludeAt
): Program => [
	preludeModule(
		"index.ts",
		"// Generated by test/support/agreement/arguments.ts: the argument agreement over every parameter shape and form.",
		at,
		[
			{
				owner: batchOwned,
				lines: [
					...Arr.map(shapes, (shape, s) => `export const q${s} = ${queryOf(shape).source}`),
					""
				]
			},
			...Arr.map(cells, (cell, i) => ({ owner: caseOwned(i), lines: [...cellLines(cell), ""] }))
		]
	)
]
