/**
 * What one served program takes and answers on the wire, as data over its scalars (live/wire.ts), and the walks of it:
 * a program's input (its parameters, its facts and a page's window), its rows, its keys, its write's outcome and its
 * errors' witnesses, each read off the served member (live/member.ts memberShape) once. The shapes are generic over
 * their leaf, so one walk of the served member gives both the codecs' leaves (WireScalar) and the document's (a scalar
 * with its refinements), and the JSON Schema, the server's encode and parse and the client's decode and encode are
 * interpreters of the one shape.
 *
 * Runtime-free and browser-safe, as live/wire.ts is: an Option is built and read through the caller's vocabulary
 * (WireOptions), so the engine loads no Effect.
 */
import type { Option } from "effect"
import type { Json, Path } from "#compiler/core/canonical.ts"
import type { Delivery } from "#compiler/core/decoder.ts"
import { defect } from "#compiler/core/invariant.ts"
import { int8Max } from "#compiler/core/limits.ts"
import { mapNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import { callErrors, type Shape, type Slot } from "#compiler/live/events.ts"
import type { KeyFields } from "#compiler/live/key.ts"
import { anchored, naturals } from "#compiler/live/pattern.ts"
import type { Anchor } from "#compiler/live/program.ts"
import {
	type WireFaultKind,
	type WireScalar,
	type WireSchema,
	withGaps
} from "#compiler/live/wire.ts"

/**
 * A field of a delivered record: a scalar column; head literals' column, whose values its schema enumerates, each in
 * its scalar's spelling; an attachment, its child records delivered as an array, an Option or the one child; an
 * alternatives arm, Some of its child on a row whose `field` holds `handle` and None elsewhere; or an alternatives arm
 * of a union's arm that always selects it (`some`) or never does (`none`).
 */
export type WireField<L> =
	| { readonly kind: "scalar"; readonly scalar: L }
	| {
			readonly kind: "constant"
			readonly scalar: L
			readonly values: NonEmptyReadonlyArray<Json>
	  }
	| { readonly kind: "attachment"; readonly delivery: Delivery; readonly child: WireRecord<L> }
	| {
			readonly kind: "arm"
			readonly field: string
			readonly handle: string
			readonly child: WireRecord<L>
	  }
	| { readonly kind: "some" | "none"; readonly child: WireRecord<L> }

/** A field under its name. */
export type WireNamed<L> = {
	readonly name: string
	readonly field: WireField<L>
}

/** The fields of one heading, in the order its decoder states them: a record holding exactly these keys. */
export type WireHeading<L> = ReadonlyArray<WireNamed<L>>

/**
 * The records a row may be: one per heading it may deliver, a heterogeneous union's heading groups each its own, no two
 * of one key set, so a record's keys name its heading.
 */
export type WireRecord<L> = NonEmptyReadonlyArray<WireHeading<L>>

/** A program's parameter: a scalar's, or a relation's, whose facts are records of its heading. */
export type WireParam<L> = {
	readonly name: string
	readonly param:
		| { readonly kind: "scalar"; readonly scalar: L }
		| { readonly kind: "relation"; readonly heading: WireHeading<L> }
}

/**
 * One level of a fact a ChangeSet's call gives: the headings a fact of it may hold (a classed insert's complete and
 * generated facts, one heading elsewhere), and the families its relation owns, each a count field holding an array of
 * the member relation's facts, of the level at `level` among its fact's levels.
 */
export type WireLevel<L> = {
	readonly headings: WireRecord<L>
	readonly families: ReadonlyArray<{ readonly count: string; readonly level: number }>
}

/**
 * The facts a ChangeSet's call gives one array member, under its op and then its relation: each fact of its levels'
 * first, a nested insert's members of the levels its families name, to any depth.
 */
export type WireFacts<L> = {
	readonly op: "insert" | "delete" | "put"
	readonly relation: string
	readonly levels: NonEmptyReadonlyArray<WireLevel<L>>
}

/**
 * A program's input: a call's parameters and facts, both always present, `{}` where none; or a paged program's
 * parameters and window, its anchor's key read by `key`, the program's key columns in key order.
 */
export type WireInput<L> =
	| {
			readonly kind: "call"
			readonly params: ReadonlyArray<WireParam<L>>
			readonly facts: ReadonlyArray<WireFacts<L>>
	  }
	| {
			readonly kind: "window"
			readonly params: ReadonlyArray<WireParam<L>>
			readonly key: ReadonlyArray<WireField<L>>
	  }

/**
 * A relation a refusal's witness may name, in the words the role states its facts in (the relation's own, or the query
 * entry it writes the relation through), with the fields its key values are typed by.
 */
export type WireWitness<L> = {
	readonly relation: string
	readonly fields: WireHeading<L>
}

/**
 * A write's outcome: a ChangeSet's, accepted with the counts of `relations`, the relations it writes, or unchanged,
 * each with its read-backs' record; or a refresh's.
 */
export type WireOutcome<L> =
	| {
			readonly kind: "change"
			readonly relations: ReadonlyArray<string>
			readonly reads: WireRecord<L>
	  }
	| { readonly kind: "refresh" }

/**
 * A served program on the wire, over its leaf L: a read's shape (a set or a list), its key fields, its input, its
 * record and its key columns; or a write's input and outcome. Each holds the witnesses its role's refusals may name.
 */
export type MemberShape<L> =
	| {
			readonly shape: Exclude<Shape, "write">
			readonly fields: KeyFields
			readonly input: WireInput<L>
			readonly record: WireRecord<L>
			readonly key: ReadonlyArray<WireField<L>>
			readonly witness: ReadonlyArray<WireWitness<L>>
	  }
	| {
			readonly shape: "write"
			readonly input: WireInput<L>
			readonly outcome: WireOutcome<L>
			readonly witness: ReadonlyArray<WireWitness<L>>
	  }

/** A served program on the wire over its codecs' leaves: what a document carries for its client and a server loads. */
export type MemberWire = MemberShape<WireScalar>

/** A shape's leaves mapped by `f`. */
export const mapField = <L, M>(field: WireField<L>, f: (leaf: L) => M): WireField<M> => {
	switch (field.kind) {
		case "scalar":
			return { kind: "scalar", scalar: f(field.scalar) }
		case "constant":
			return { kind: "constant", scalar: f(field.scalar), values: field.values }
		case "attachment":
			return { kind: "attachment", delivery: field.delivery, child: mapRecord(field.child, f) }
		case "arm":
			return {
				kind: "arm",
				field: field.field,
				handle: field.handle,
				child: mapRecord(field.child, f)
			}
		case "some":
		case "none":
			return { kind: field.kind, child: mapRecord(field.child, f) }
	}
}

const mapHeading = <L, M>(heading: WireHeading<L>, f: (leaf: L) => M): WireHeading<M> =>
	heading.map((named) => ({ name: named.name, field: mapField(named.field, f) }))

const mapRecord = <L, M>(record: WireRecord<L>, f: (leaf: L) => M): WireRecord<M> => {
	const [first, ...rest] = record
	return [mapHeading(first, f), ...rest.map((heading) => mapHeading(heading, f))]
}

const mapParams = <L, M>(
	params: ReadonlyArray<WireParam<L>>,
	f: (leaf: L) => M
): ReadonlyArray<WireParam<M>> =>
	params.map((p) => ({
		name: p.name,
		param:
			p.param.kind === "scalar"
				? { kind: "scalar", scalar: f(p.param.scalar) }
				: { kind: "relation", heading: mapHeading(p.param.heading, f) }
	}))

const mapInput = <L, M>(input: WireInput<L>, f: (leaf: L) => M): WireInput<M> =>
	input.kind === "call"
		? {
				kind: "call",
				params: mapParams(input.params, f),
				facts: input.facts.map((facts) => ({
					op: facts.op,
					relation: facts.relation,
					levels: mapNonEmpty(facts.levels, (level) => ({
						headings: mapRecord(level.headings, f),
						families: level.families
					}))
				}))
			}
		: {
				kind: "window",
				params: mapParams(input.params, f),
				key: input.key.map((field) => mapField(field, f))
			}

const mapWitness = <L, M>(
	witness: ReadonlyArray<WireWitness<L>>,
	f: (leaf: L) => M
): ReadonlyArray<WireWitness<M>> =>
	witness.map((w) => ({ relation: w.relation, fields: mapHeading(w.fields, f) }))

/** A member shape's leaves mapped by `f`: the document's leaves to the codecs' (live/member.ts memberWire). */
export const mapShape = <L, M>(member: MemberShape<L>, f: (leaf: L) => M): MemberShape<M> =>
	member.shape === "write"
		? {
				shape: "write",
				input: mapInput(member.input, f),
				outcome:
					member.outcome.kind === "change"
						? {
								kind: "change",
								relations: member.outcome.relations,
								reads: mapRecord(member.outcome.reads, f)
							}
						: member.outcome,
				witness: mapWitness(member.witness, f)
			}
		: {
				shape: member.shape,
				fields: member.fields,
				input: mapInput(member.input, f),
				record: mapRecord(member.record, f),
				key: member.key.map((field) => mapField(field, f)),
				witness: mapWitness(member.witness, f)
			}

/**
 * How the caller spells an Option, which the engine loads no Effect to build or read: Effect's `Option.some`,
 * `Option.none()`, `Option.isOption` and `Option.match`, passed where a codec of a member is made.
 */
export interface WireOptions {
	readonly some: <A>(value: A) => Option.Option<A>
	readonly none: Option.Option<never>
	readonly is: (value: unknown) => value is Option.Option<unknown>
	readonly match: <A, B>(
		option: Option.Option<A>,
		cases: { readonly onNone: () => B; readonly onSome: (value: A) => B }
	) => B
}

/** Why a caller's input was refused: the parse's fault (live/wire.ts WireFaultKind), at its path in the body. */
export interface WireFault {
	readonly kind: WireFaultKind
	readonly at: Path
}

/** The JSON Schema of an object holding exactly `properties`, each required. */
const closedObject = (properties: ReadonlyArray<readonly [string, WireSchema]>): WireSchema => ({
	type: "object",
	properties: Object.fromEntries(properties),
	required: properties.map(([name]) => name),
	additionalProperties: false
})

/** The JSON Schema of the null an absent Option is spelled by. */
const nullSchema: WireSchema = { type: "null" }

/** A schema of one of `schemas`: the schema itself for one. */
const oneOfSchemas = (schemas: NonEmptyReadonlyArray<WireSchema>): WireSchema => {
	const [first, ...rest] = schemas
	return rest.length === 0 ? first : { oneOf: [...schemas] }
}

/** The JSON Schema of a field's values. */
const fieldSchema = <L>(field: WireField<L>, leaf: (l: L) => WireSchema): WireSchema => {
	switch (field.kind) {
		case "scalar":
			return leaf(field.scalar)
		case "constant":
			return { enum: [...field.values] }
		case "attachment": {
			const child = recordSchema(field.child, leaf)
			switch (field.delivery) {
				case "array":
					return { type: "array", items: child }
				case "option":
					return { anyOf: [child, nullSchema] }
				case "one":
					return child
			}
		}
		case "arm":
			return { anyOf: [recordSchema(field.child, leaf), nullSchema] }
		case "some":
			return recordSchema(field.child, leaf)
		case "none":
			return nullSchema
	}
}

/**
 * The JSON Schema of a heading's records: an object of exactly its fields, and each alternatives arm's correlation, its
 * child where the row's field holds the arm's handle and null elsewhere, one of the two.
 */
const headingSchema = <L>(heading: WireHeading<L>, leaf: (l: L) => WireSchema): WireSchema => {
	const object = closedObject(heading.map((named) => [named.name, fieldSchema(named.field, leaf)]))
	const arms = heading.flatMap((named): ReadonlyArray<WireSchema> => {
		const field = named.field
		return field.kind === "arm"
			? [
					{
						oneOf: [
							{
								properties: {
									[field.field]: { const: field.handle },
									[named.name]: recordSchema(field.child, leaf)
								}
							},
							{
								properties: {
									[field.field]: { not: { const: field.handle } },
									[named.name]: nullSchema
								}
							}
						]
					}
				]
			: []
	})
	return arms.length === 0 ? object : { ...object, allOf: [...arms] }
}

/** The JSON Schema of a record's values: its one heading's, or one of its headings'. */
export const recordSchema = <L>(record: WireRecord<L>, leaf: (l: L) => WireSchema): WireSchema => {
	const [first, ...rest] = record
	return oneOfSchemas([headingSchema(first, leaf), ...rest.map((h) => headingSchema(h, leaf))])
}

/** The JSON Schema of a key: its columns' values, in key order; the empty array, a read's of at most one row. */
const keySchema = <L>(key: ReadonlyArray<WireField<L>>, leaf: (l: L) => WireSchema): WireSchema =>
	key.length === 0
		? { type: "array", maxItems: 0 }
		: {
				type: "array",
				prefixItems: key.map((field) => fieldSchema(field, leaf)),
				minItems: key.length,
				maxItems: key.length
			}

/** The JSON Schema of a program's parameters: an object of exactly its parameters. */
const paramsSchema = <L>(
	params: ReadonlyArray<WireParam<L>>,
	leaf: (l: L) => WireSchema
): WireSchema =>
	closedObject(
		params.map((p) => [
			p.name,
			p.param.kind === "scalar"
				? leaf(p.param.scalar)
				: { type: "array", items: headingSchema(p.param.heading, leaf) }
		])
	)

/** Each op of `facts` with its members, in their order. */
const factsByOp = <L>(
	facts: ReadonlyArray<WireFacts<L>>
): ReadonlyArray<readonly [string, ReadonlyArray<WireFacts<L>>]> => {
	const out = new Map<string, Array<WireFacts<L>>>()
	for (const member of facts) {
		const members = out.get(member.op) ?? []
		members.push(member)
		out.set(member.op, members)
	}
	return [...out]
}

/**
 * The JSON Schema of a fact's level: one of its headings' objects, each holding too, under each family's count field,
 * an array of the member level's facts, which `member` gives the schema of.
 */
const levelSchema = <L>(
	level: WireLevel<L>,
	member: (level: number) => WireSchema,
	leaf: (l: L) => WireSchema
): WireSchema =>
	oneOfSchemas(
		mapNonEmpty(level.headings, (heading) =>
			closedObject([
				...heading.map((named): readonly [string, WireSchema] => [
					named.name,
					fieldSchema(named.field, leaf)
				]),
				...level.families.map((family): readonly [string, WireSchema] => [
					family.count,
					{ type: "array", items: member(family.level) }
				])
			])
		)
	)

/** The name of a fact's level among its schema's definitions. */
const levelName = (level: number): string => `level${level}`

/**
 * The JSON Schema of one fact of an array member: its one level's, inline; or, where it nests, a schema resource of its
 * own (`id`), each level a definition of it, a family's members a reference to theirs, so a tree's facts nest to any
 * depth.
 */
const factSchema = <L>(facts: WireFacts<L>, id: string, leaf: (l: L) => WireSchema): WireSchema => {
	const [own, ...rest] = facts.levels
	const reference = (level: number): WireSchema => ({ $ref: `#/$defs/${levelName(level)}` })
	if (rest.length === 0 && own.families.length === 0) {
		return levelSchema(own, reference, leaf)
	}
	return {
		$id: id,
		$defs: Object.fromEntries(
			facts.levels.map((level, at) => [levelName(at), levelSchema(level, reference, leaf)])
		),
		$ref: `#/$defs/${levelName(0)}`
	}
}

/**
 * The JSON Schema of a ChangeSet's facts: under each op, under each relation, an array of its facts, a nesting fact's
 * schema resource identified under `id`.
 */
const factsSchema = <L>(
	facts: ReadonlyArray<WireFacts<L>>,
	id: string,
	leaf: (l: L) => WireSchema
): WireSchema =>
	closedObject(
		factsByOp(facts).map(([op, members]) => [
			op,
			closedObject(
				members.map((member) => [
					member.relation,
					{ type: "array", items: factSchema(member, `${id}:${op}:${member.relation}`, leaf) }
				])
			)
		])
	)

/** The JSON Schema of a page's window: its anchor, tagged by kind, and its size, a positive JSON integer. */
const windowSchema = <L>(
	key: ReadonlyArray<WireField<L>>,
	leaf: (l: L) => WireSchema
): WireSchema => {
	const tagged = (kind: Anchor["kind"]): WireSchema => closedObject([["kind", { const: kind }]])
	const keyed = (kind: Anchor["kind"]): WireSchema =>
		closedObject([
			["kind", { const: kind }],
			["key", keySchema(key, leaf)]
		])
	return closedObject([
		["anchor", { oneOf: [tagged("start"), keyed("after"), tagged("end"), keyed("before")] }],
		["size", { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER }]
	])
}

/**
 * The JSON Schema of a program's input: `{ params, facts }`, or a page's `{ params, facts: {}, window }`; `id` is the
 * document's own URI of the program, under which a nesting fact's schema is identified.
 */
export const inputSchema = <L>(
	input: WireInput<L>,
	id: string,
	leaf: (l: L) => WireSchema
): WireSchema =>
	input.kind === "call"
		? closedObject([
				["params", paramsSchema(input.params, leaf)],
				["facts", factsSchema(input.facts, id, leaf)]
			])
		: closedObject([
				["params", paramsSchema(input.params, leaf)],
				["facts", closedObject([])],
				["window", windowSchema(input.key, leaf)]
			])

/** The spelling of a count a write's outcome states: a natural bigint, in the wire's integer grammar. */
const countSchema: WireSchema = { type: "string", pattern: anchored(naturals(0n, int8Max.value)) }

/** The JSON Schema of a write's outcome. */
const outcomeSchema = <L>(outcome: WireOutcome<L>, leaf: (l: L) => WireSchema): WireSchema => {
	if (outcome.kind === "refresh") {
		return closedObject([["kind", { const: "refreshed" }]])
	}
	const reads = recordSchema(outcome.reads, leaf)
	const counts: WireSchema = {
		type: "array",
		items: closedObject([
			["relation", { type: "string", enum: [...outcome.relations] }],
			["added", countSchema],
			["deleted", countSchema],
			["put", countSchema]
		])
	}
	return {
		oneOf: [
			closedObject([
				["kind", { const: "accepted" }],
				["counts", counts],
				["reads", reads]
			]),
			closedObject([
				["kind", { const: "unchanged" }],
				["reads", reads]
			])
		]
	}
}

/** The JSON Schema of a refusal's witness: a key of one of the role's relations, or none reported. */
const witnessSchema = <L>(
	witness: ReadonlyArray<WireWitness<L>>,
	leaf: (l: L) => WireSchema
): WireSchema =>
	oneOfSchemas([
		closedObject([["kind", { const: "unreported" }]]),
		...witness.map((w) =>
			closedObject([
				["kind", { const: "key" }],
				["relation", { const: w.relation }],
				[
					"values",
					withGaps(
						{
							type: "object",
							properties: Object.fromEntries(
								w.fields.map((named) => [named.name, fieldSchema(named.field, leaf)])
							),
							additionalProperties: false
						},
						["witnessKey"]
					)
				]
			])
		)
	])

/**
 * The JSON Schema of a refusal's laws (types/changeset Refused): how grizzle decided them, and each law with its
 * identity and the object that refused it, the law's own members a gap (`lawShape`).
 */
const refusedSchema: WireSchema = withGaps(
	{
		type: "object",
		properties: {
			kind: { enum: ["every", "first", "some", "above"] },
			own: { enum: ["every", "none", "unjudged"] },
			laws: {
				type: "array",
				minItems: 1,
				items: {
					type: "object",
					properties: { law: { type: "object" }, id: { type: "string" }, by: { type: "object" } },
					required: ["law", "id", "by"],
					additionalProperties: false
				}
			}
		},
		required: ["kind", "laws"],
		additionalProperties: false
	},
	["lawShape"]
)

/** The schemas of every slot but a CallError's, which a CallError's payload is spelled by. */
type PayloadSchemas = { readonly [S in Exclude<Slot, "error">]: WireSchema }

/** The schema of a payload member's slot: none is a CallError, which no CallError's payload holds. */
const payloadSlot = (slot: Slot, schemas: PayloadSchemas): WireSchema => {
	if (slot === "error") {
		throw defect("a CallError's payload holds no CallError")
	}
	return schemas[slot]
}

/** The JSON Schema of a CallError: one object per kind (live/events.ts callErrors), its retry the classification's. */
const errorSchema = (schemas: PayloadSchemas): WireSchema => ({
	oneOf: Object.entries(callErrors).map(([kind, error]) =>
		closedObject([
			["kind", { const: kind }],
			["retry", { const: error.retry }],
			...Object.entries(error.payload).map(([member, slot]): readonly [string, WireSchema] => [
				member,
				payloadSlot(slot, schemas)
			])
		])
	)
})

/** The JSON Schema no value meets: a slot's of a shape whose events never carry it. */
const noValue: WireSchema = { not: {} }

/**
 * The JSON Schema of each slot's values for one member (live/events.ts SlotValues): a read's rows, keys and key fields,
 * or a write's outcome, and the slots every answer may carry, its texts, its refusal's laws and witness and its errors.
 * A slot no event of the member's shape carries admits no value.
 */
export const slotSchemas = <L>(
	member: MemberShape<L>,
	leaf: (l: L) => WireSchema
): { readonly [S in Slot]: WireSchema } => {
	const common = {
		text: { type: "string" },
		refused: refusedSchema,
		witness: witnessSchema(member.witness, leaf)
	}
	if (member.shape === "write") {
		const schemas: PayloadSchemas = {
			...common,
			fields: noValue,
			row: noValue,
			key: noValue,
			after: noValue,
			outcome: outcomeSchema(member.outcome, leaf)
		}
		return { ...schemas, error: errorSchema(schemas) }
	}
	const key = keySchema(member.key, leaf)
	const schemas: PayloadSchemas = {
		...common,
		fields: { const: [...member.fields] },
		row: recordSchema(member.record, leaf),
		key,
		after: { anyOf: [key, nullSchema] },
		outcome: noValue
	}
	return { ...schemas, error: errorSchema(schemas) }
}
