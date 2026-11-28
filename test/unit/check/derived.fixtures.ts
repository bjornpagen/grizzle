/** What the properties of derived.test.ts read: its spaces, models and helpers. */

import type * as Result from "@bjornpagen/grizzle-text/base/result"
import { assert, defined } from "@bjornpagen/testing/assert"
import { array, boolean, element, type Gen, int, subset } from "@bjornpagen/testing/gen"
import { Array as Arr, Option, Order, Record as Rec } from "effect"
import type { GeneratedRule } from "#compiler/core/causes.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import type { FieldDesc } from "#compiler/ir/desc.ts"
import { typeLabel } from "#compiler/ir/scalar.ts"
import { refused, succeeded } from "#test/support/assert.ts"
import {
	type AuthoredExprDesc,
	closed,
	closedRelation,
	decodedSchema,
	f,
	type FixtureField,
	type HeadTermDesc,
	relation,
	type SchemaDesc
} from "#test/support/fixtures/ir/desc.ts"
import { scalarOf } from "#test/support/fixtures/ir/scalar.ts"
import { checkedIn } from "#test/support/policy.ts"
import {
	eq,
	match,
	queryDesc,
	ref,
	relationSource,
	rule,
	sum,
	typedLit,
	vars
} from "#test/support/unit/check/dsl.ts"

/** The fields a case declares besides its key, in declaration order. */
const slotNames = ["b", "Z", "a"] as const

type SlotName = (typeof slotNames)[number]

/** Code-unit order: Effect's string order, JavaScript's `<`, stated apart from the checker's comparator. */
const byName = Order.mapInput(Order.String, (x: { readonly name: string }) => x.name)

/** The least of `names` in code-unit order, if any. */
const least = (names: ReadonlyArray<string>): string | undefined =>
	Option.getOrUndefined(Arr.head(Arr.sort(names, Order.String)))

/** The relation every case of the field boxes declares, keyed by its caller's uuid `id`. */
const relationName = "R"

/** A schema of `relations` at the root level alone. */
const rootSchema = (relations: SchemaDesc["relations"]): SchemaDesc => ({
	name: "Generated",
	relations,
	statements: [],
	bases: []
})

/** R with its key `id`, then `fields` in their order. */
const relationOf = (fields: ReadonlyArray<readonly [string, FixtureField]>) =>
	relation(relationName, { id: f.uuid, ...Rec.fromEntries(fields) }, ["id"])

/** A generated field of `type` whose value is `expr`. */
const generatedField = (type: FieldDesc, expr: AuthoredExprDesc): FixtureField => ({
	type,
	writing: { kind: "generated", expr }
})

/** A field read, as a generation expression's description states it. */
const fieldRead = (name: string): AuthoredExprDesc => ({ kind: "field", field: name })

/** The conjunction of `terms` as a builder states it: the boolean true for none, a lone term for one. */
const conjunction = (terms: ReadonlyArray<AuthoredExprDesc>): AuthoredExprDesc => {
	if (!Arr.isReadonlyArrayNonEmpty(terms)) {
		return typedLit(true, f.boolean)
	}
	return terms.length === 1 ? Arr.headNonEmpty(terms) : { kind: "and", args: terms }
}

/**
 * A generated field's rule as the specification states it: an input beyond the row among those a description can state
 * (`foreignInputs`), which the author's builders write; an existence is grizzle's own, which no description holds.
 */
type ExpectedRule =
	| Exclude<GeneratedRule, { readonly kind: "notRowLocal" }>
	| { readonly kind: "notRowLocal"; readonly input: ForeignInput }

/** What the specification says of a case: admitted, with its generated fields, or refused at a field of R. */
type Expected =
	| { readonly kind: "admitted"; readonly generated: ReadonlyArray<string> }
	| { readonly kind: "generated"; readonly field: string; readonly rule: ExpectedRule }
	| { readonly kind: "malformed"; readonly field: string }

/** The path of R's description in `desc`, through the levels it extends. */
const relationPath = (desc: SchemaDesc): ReadonlyArray<string | number> => {
	let level = decodedSchema(desc)
	for (;;) {
		const found = Arr.findFirst(level.relations, (x) => x.name === relationName)
		if (Option.isSome(found)) {
			return found.value.loc.path
		}
		level = defined(level.bases[0], `${relationName} is declared at some level`)
	}
}

/** The checked schema of `desc` against what the specification expects of it. */
export const judged = (desc: SchemaDesc, expected: Expected, why: string): void => {
	const result: Result.Result<unknown, CompileError> = checkedIn(desc)
	switch (expected.kind) {
		case "admitted": {
			const checked = succeeded(checkedIn(desc), why)
			const info = defined(checked.relations.get(relationName), `${why}: R is checked`)
			assert.deepEqual(
				Arr.sort(
					Arr.flatMap(info.fields, (x) => (x.writing.kind === "generated" ? [x.name] : [])),
					Order.String
				),
				Arr.sort(expected.generated, Order.String),
				`${why}: exactly the generated fields are written as generated`
			)
			return
		}
		case "generated": {
			const reason = refused(result, "GeneratedRefused", why).reason
			if (reason._tag !== "GeneratedRefused") {
				return assert.fail(`${why}: a GeneratedRefused`)
			}
			assert.deepEqual(
				{ relation: reason.relation, field: reason.field, rule: reason.rule, at: reason.at.path },
				{
					relation: relationName,
					field: expected.field,
					rule: expected.rule,
					at: [...relationPath(desc), expected.field]
				},
				why
			)
			return
		}
		case "malformed": {
			const reason = refused(result, "MalformedDescription", why).reason
			if (reason._tag !== "MalformedDescription") {
				return assert.fail(`${why}: a MalformedDescription`)
			}
			assert.deepEqual(reason.at.path, [...relationPath(desc), expected.field], why)
			return
		}
	}
}

/** The two declared types a generated field of the graph box takes: its expression's, and another. */
const declaredKinds = ["boolean", "integer"] as const

type Declared = (typeof declaredKinds)[number]

const declaredType: Readonly<Record<Declared, FieldDesc>> = {
	boolean: f.boolean,
	integer: f.integer
}

/** How a field of a graph is written: by its caller, a boolean, or generated from the fields it reads. */
type GraphSlot =
	| { readonly kind: "written" }
	| {
			readonly kind: "generated"
			readonly reads: ReadonlyArray<SlotName>
			readonly declared: Declared
	  }

interface GraphField {
	readonly name: SlotName
	readonly slot: GraphSlot
}

interface GeneratedGraphField {
	readonly name: SlotName
	readonly slot: Extract<GraphSlot, { readonly kind: "generated" }>
}

/** A field of `names`: written, or generated from a subset of them in declaration order, of either declared type. */
const graphSlotGen =
	(names: ReadonlyArray<SlotName>): Gen<GraphSlot> =>
	(source) =>
		source.draw(boolean)
			? {
					kind: "generated",
					reads: source.draw(subset(names, { min: 0, max: names.length })),
					declared: source.draw(element(declaredKinds))
				}
			: { kind: "written" }

/** Every read graph over a key and up to three fields. */
export const graphGen: Gen<ReadonlyArray<GraphField>> = (source) => {
	const names = Arr.take(slotNames, source.draw(int(0, slotNames.length)))
	return Arr.map(names, (name) => ({ name, slot: source.draw(graphSlotGen(names)) }))
}

/** A graph's schema: each generated field the conjunction of the fields it reads. */
export const graphSchema = (graph: ReadonlyArray<GraphField>): SchemaDesc =>
	rootSchema([
		relationOf(
			Arr.map(graph, ({ name, slot }) => [
				name,
				slot.kind === "written"
					? f.boolean
					: generatedField(declaredType[slot.declared], conjunction(Arr.map(slot.reads, fieldRead)))
			])
		)
	])

/** A graph's generated fields in code-unit order. */
const generatedOf = (graph: ReadonlyArray<GraphField>): ReadonlyArray<GeneratedGraphField> =>
	Arr.sort(
		Arr.flatMap(graph, ({ name, slot }) => (slot.kind === "generated" ? [{ name, slot }] : [])),
		byName
	)

const booleanLabel = typeLabel(scalarOf(f.boolean, {}))

const integerLabel = typeLabel(scalarOf(f.integer, {}))

/**
 * The rule over a graph: the least generated field that reads a generated field, naming the least one it reads; else
 * the least generated field declared of another type than its expression's boolean; else admitted.
 */
export const expectedOfGraph = (graph: ReadonlyArray<GraphField>): Expected => {
	const generated = generatedOf(graph)
	const names = new Set<string>(Arr.map(generated, (g) => g.name))
	for (const g of generated) {
		const read = least(Arr.filter(g.slot.reads, (r) => names.has(r)))
		if (read !== undefined) {
			return { kind: "generated", field: g.name, rule: { kind: "readsGenerated", read } }
		}
	}
	for (const g of generated) {
		if (g.slot.declared !== "boolean") {
			return {
				kind: "generated",
				field: g.name,
				rule: { kind: "type", declared: integerLabel, expression: booleanLabel }
			}
		}
	}
	return { kind: "admitted", generated: Arr.map(generated, (g) => g.name) }
}

export type GraphFeature =
	| "a self-read"
	| "a 2-cycle"
	| "a 3-cycle"
	| "an acyclic chain"
	| "a type refused"
	| "admitted"

/** A graph's shape among its generated fields: the shortest cycle it holds, an acyclic chain, or no read of one. */
export const graphFeature = (graph: ReadonlyArray<GraphField>): GraphFeature => {
	const generated = generatedOf(graph)
	const names = Arr.map(generated, (g) => g.name)
	const edge = (from: SlotName, to: SlotName): boolean =>
		names.includes(to) && Arr.some(generated, (g) => g.name === from && g.slot.reads.includes(to))
	const any = (p: (x: SlotName) => boolean): boolean => Arr.some(names, p)
	if (any((x) => edge(x, x))) {
		return "a self-read"
	}
	if (any((x) => any((y) => x !== y && edge(x, y) && edge(y, x)))) {
		return "a 2-cycle"
	}
	if (
		any((x) =>
			any((y) =>
				any((z) => new Set([x, y, z]).size === 3 && edge(x, y) && edge(y, z) && edge(z, x))
			)
		)
	) {
		return "a 3-cycle"
	}
	if (any((x) => any((y) => edge(x, y)))) {
		return "an acyclic chain"
	}
	return expectedOfGraph(graph).kind === "admitted" ? "admitted" : "a type refused"
}

/** The inputs beyond a row a generation expression may state (core/causes.ts GeneratedRule notRowLocal). */
const foreignInputs = ["var", "param", "parent", "value", "absent", "call"] as const

type ForeignInput = (typeof foreignInputs)[number]

/** One operand of a generated field's conjunction: a field read, an input beyond the row, or a parameter one level down. */
type Item =
	| { readonly kind: "read"; readonly field: SlotName }
	| { readonly kind: "foreign"; readonly input: ForeignInput }
	| { readonly kind: "nested" }

/** The two fields of the inputs box, declared b then Z. */
const inputFields = ["b", "Z"] as const

const items = [
	{ kind: "read", field: "b" },
	{ kind: "read", field: "Z" },
	{ kind: "foreign", input: "var" },
	{ kind: "foreign", input: "param" },
	{ kind: "foreign", input: "parent" },
	{ kind: "foreign", input: "value" },
	{ kind: "foreign", input: "absent" },
	{ kind: "foreign", input: "call" },
	{ kind: "nested" }
] as const satisfies ReadonlyArray<Item>

/** An item's description: a relational negation holds a variable among its bindings, beneath its own node. */
const itemExpr = (item: Item): AuthoredExprDesc => {
	switch (item.kind) {
		case "read":
			return fieldRead(item.field)
		case "nested":
			return { kind: "not", arg: { kind: "param", name: "q", type: f.boolean } }
		case "foreign":
			switch (item.input) {
				case "var":
					return { kind: "var", var: "x" }
				case "param":
					return { kind: "param", name: "p", type: f.boolean }
				case "parent":
					return { kind: "parent", column: "c" }
				case "value":
					return { kind: "value" }
				case "absent":
					return {
						kind: "absent",
						source: { kind: "relation", name: relationName },
						bindings: { id: { kind: "var", var: "y" } }
					}
				case "call":
					return { kind: "call", function: "f", args: {} }
			}
	}
}

/** The input beyond the row an item states first, in pre-order: its own node's, or the nested parameter. */
const itemInput = (item: Item): ForeignInput | undefined => {
	switch (item.kind) {
		case "read":
			return undefined
		case "foreign":
			return item.input
		case "nested":
			return "param"
	}
}

type InputSlot =
	| { readonly kind: "written" }
	| { readonly kind: "generated"; readonly items: ReadonlyArray<Item> }

interface InputField {
	readonly name: SlotName
	readonly slot: InputSlot
}

interface GeneratedInputField {
	readonly name: SlotName
	readonly items: ReadonlyArray<Item>
}

const inputSlotGen: Gen<InputSlot> = (source) =>
	source.draw(boolean)
		? { kind: "generated", items: source.draw(array(element(items), { min: 0, max: 2 })) }
		: { kind: "written" }

export const inputsGen: Gen<ReadonlyArray<InputField>> = (source) =>
	Arr.map(inputFields, (name) => ({ name, slot: source.draw(inputSlotGen) }))

export const inputsSchema = (fields: ReadonlyArray<InputField>): SchemaDesc =>
	rootSchema([
		relationOf(
			Arr.map(fields, ({ name, slot }) => [
				name,
				slot.kind === "written"
					? f.boolean
					: generatedField(f.boolean, conjunction(Arr.map(slot.items, itemExpr)))
			])
		)
	])

/** The generated fields of the inputs box in code-unit order. */
const generatedItems = (fields: ReadonlyArray<InputField>): ReadonlyArray<GeneratedInputField> =>
	Arr.sort(
		Arr.flatMap(fields, ({ name, slot }) =>
			slot.kind === "generated" ? [{ name, items: slot.items }] : []
		),
		byName
	)

/** The first input beyond the row a generated field's items state. */
const firstInput = (g: GeneratedInputField): ForeignInput | undefined =>
	Option.getOrUndefined(Arr.findFirst(g.items, (item) => Option.fromUndefinedOr(itemInput(item))))

/**
 * The rule over inputs: per generated field in code-unit order, the first item's input beyond the row, else the least
 * generated field it reads; else admitted, every expression a boolean of its declared boolean.
 */
export const expectedOfInputs = (fields: ReadonlyArray<InputField>): Expected => {
	const generated = generatedItems(fields)
	const names = new Set<string>(Arr.map(generated, (g) => g.name))
	for (const g of generated) {
		const input = firstInput(g)
		if (input !== undefined) {
			return { kind: "generated", field: g.name, rule: { kind: "notRowLocal", input } }
		}
		const read = least(
			Arr.flatMap(g.items, (item) =>
				item.kind === "read" && names.has(item.field) ? [item.field] : []
			)
		)
		if (read !== undefined) {
			return { kind: "generated", field: g.name, rule: { kind: "readsGenerated", read } }
		}
	}
	return { kind: "admitted", generated: Arr.map(generated, (g) => g.name) }
}

export type InputFeature =
	| `beyond the row: ${ForeignInput}`
	| "a nested input before a shallow one"
	| "a read refused before a greater field's input"
	| "admitted"

/** The situations a case of the inputs box reaches. */
export const inputFeatures = (fields: ReadonlyArray<InputField>): ReadonlyArray<InputFeature> => {
	const expected = expectedOfInputs(fields)
	const generated = generatedItems(fields)
	if (expected.kind !== "generated") {
		return ["admitted"]
	}
	const rule = expected.rule
	const refusedField = Arr.findFirst(generated, (g) => g.name === expected.field)
	switch (rule.kind) {
		case "notRowLocal": {
			const inputs = Arr.filter(
				Option.match(refusedField, { onNone: () => [], onSome: (g) => g.items }),
				(item) => itemInput(item) !== undefined
			)
			const [first, second] = inputs
			const nestedFirst =
				first?.kind === "nested" && second?.kind === "foreign" && second.input !== "param"
			return nestedFirst
				? [`beyond the row: ${rule.input}`, "a nested input before a shallow one"]
				: [`beyond the row: ${rule.input}`]
		}
		case "readsGenerated":
			return Arr.some(
				generated,
				(g) =>
					Order.isGreaterThan(Order.String)(g.name, expected.field) && firstInput(g) !== undefined
			)
				? ["a read refused before a greater field's input"]
				: []
		case "type":
		case "disjoint":
		case "stable":
		case "keyReadsUnwritten":
			return []
	}
}

/** A level case: the reader's and the closed relations' levels, and the read, C.at or C.row, bare or under an operation. */
interface LevelCase {
	readonly reader: 0 | 1
	readonly closed: 0 | 1
	readonly read: "at" | "row"
	readonly nested: boolean
}

const levels = [0, 1] as const

const reads = ["at", "row"] as const

export const levelGen: Gen<LevelCase> = (source) => ({
	reader: source.draw(element(levels)),
	closed: source.draw(element(levels)),
	read: source.draw(element(reads)),
	nested: source.draw(boolean)
})

const setOfQ: FieldDesc = { kind: "bits", roster: "Q" }

/** C.at(K, w, q), K's payload at q, or C.row(K2, q), the set of q's completions in K2. */
const closedReadOf = (read: LevelCase["read"], q: AuthoredExprDesc): AuthoredExprDesc =>
	read === "at"
		? { kind: "closedAt", relation: "K", field: "w", args: [q] }
		: { kind: "closedRow", relation: "K2", args: [q] }

/** Q, a roster; K, keyed by a Q with an integer payload w; K2, keyed by two Qs. */
const rosterQ = closed.ordered("Q", ["x", "y"])

const closedK = closedRelation(
	"K",
	{ q: f.closedId("Q"), w: f.integer },
	["q"],
	[
		{ q: "x", w: 1 },
		{ q: "y", w: 2 }
	]
)

const closedK2 = closedRelation(
	"K2",
	{ p: f.closedId("Q"), q: f.closedId("Q") },
	["p", "q"],
	[
		{ p: "x", q: "y" },
		{ p: "y", q: "y" }
	]
)

/** Q at the root; K and K2 at their level; R, whose generated g states the read, at its level. */
export const levelSchema = (c: LevelCase): SchemaDesc => {
	const read = closedReadOf(c.read, fieldRead("q"))
	const expr: AuthoredExprDesc = !c.nested
		? read
		: c.read === "at"
			? { kind: "compute", fn: "greatest", args: [read, typedLit(0, f.integer)] }
			: { kind: "compute", fn: "union", args: [read, read] }
	const reader = relation(
		relationName,
		{
			id: f.uuid,
			q: f.closedId("Q"),
			g: generatedField(c.read === "at" ? f.integer : setOfQ, expr)
		},
		["id"]
	)
	const at = (level: 0 | 1): SchemaDesc["relations"] => [
		...(c.closed === level ? [closedK, closedK2] : []),
		...(c.reader === level ? [reader] : [])
	]
	const base = rootSchema([rosterQ, ...at(0)])
	return c.reader === 0 && c.closed === 0
		? base
		: { ...base, name: "Upper", relations: at(1), bases: [base] }
}

/** A closed read of a closed relation declared above the reading field's level is refused at that field. */
export const expectedOfLevels = (c: LevelCase): Expected =>
	c.closed > c.reader ? { kind: "malformed", field: "g" } : { kind: "admitted", generated: ["g"] }

export const positions = ["filter", "head", "binding", "aggregate", "producer"] as const

export type Position = (typeof positions)[number]

interface PositionCase {
	readonly position: Position
	readonly read: "at" | "row"
}

export const positionGen: Gen<PositionCase> = (source) => ({
	position: source.draw(element(positions)),
	read: source.draw(element(reads))
})

/** Q, K and K2, and R: its key, a Q, an integer and a set over Q, every field its caller's. */
export const positionsSchema = rootSchema([
	rosterQ,
	closedK,
	closedK2,
	relation(relationName, { id: f.uuid, q: f.closedId("Q"), n: f.integer, s: setOfQ }, ["id"])
])

/**
 * A query over R stating the closed read at `position`: compared in the filter with R's field of its type, delivered
 * by the head, bound to that field, aggregated, or packed.
 */
export const positionQuery = (c: PositionCase) => {
	const read = closedReadOf(c.read, ref(relationName, "q"))
	const own = c.read === "at" ? "n" : "s"
	const bound = {
		id: ref(relationName, "id"),
		q: ref(relationName, "q"),
		n: ref(relationName, "n"),
		s: ref(relationName, "s")
	}
	const extra = (): Readonly<Record<string, HeadTermDesc>> => {
		switch (c.position) {
			case "head":
				return { v: read }
			case "aggregate":
				return { v: sum(read) }
			case "producer":
				return { v: { kind: "producer", fn: "pack", args: [read] } }
			case "filter":
			case "binding":
				return {}
		}
	}
	return queryDesc(
		rule({
			vars: vars(relationName, "id", "q", "n", "s"),
			matches: [
				match(
					relationSource(relationName),
					c.position === "binding" ? { ...bound, [own]: read } : bound
				)
			],
			where: c.position === "filter" ? [eq(read, ref(relationName, own))] : [],
			head: { id: ref(relationName, "id"), ...extra() },
			interiors: [],
			attach: []
		})
	)
}
