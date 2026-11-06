import { element, type Gen, weighted } from "@grizzle/testing/gen"
import { Array as Arr, Option, Record as Rec } from "effect"
import type { CompileReasonTag } from "#compiler/core/errors.ts"
import type {
	AuthoredExprDesc,
	HeadTermDesc,
	MemberDesc,
	QueryDesc,
	RuleDesc
} from "#test/support/fixtures/ir/desc.ts"
import {
	descriptorOf,
	type DrawnRelation,
	type DrawnSchema,
	drawnSchemaGen,
	type ColumnKind,
	type Family,
	familyOf,
	type Handle,
	handles,
	kindOf,
	relationAt,
	rosterName,
	serialField,
	valueOf
} from "#test/unit/check/drawn.ts"
import {
	attach,
	lit,
	match,
	param,
	parent,
	queryDesc,
	ref,
	relationSource,
	rule,
	sum,
	typedLit,
	varsAt
} from "#test/unit/check/dsl.ts"

/**
 * ChangeSet members described by queries over a drawn schema, and the member rule restated as a model: an insert's and
 * a put's head delivers the fields a member writes, an insert's without the serial field it leaves to its sequence,
 * a delete's the relation's whole heading; each column compatible with its field; one heading; and no attachment,
 * which adds a field (DescribedHeadingMismatch, at the member, or at the attachment).
 */

export type Op = "insert" | "put" | "delete"

/** How a head writes one field: the source's variable of the field's name, a literal, a parameter, or a sum. */
export type Term = "var" | "literal" | "param" | "sum"

/** One arm of the member: its source relation and how it writes each field it writes. */
export interface MemberArm {
	readonly source: number
	readonly writes: ReadonlyArray<{ readonly field: string; readonly term: Term }>
	/** A literal column no field of the relation names, or none. */
	readonly extra: boolean
	/** A Kind handle under `tag`, which tells the arm's heading from another's, or none. */
	readonly tag: Handle | "none"
	readonly attached: boolean
}

export interface MemberCase {
	readonly schema: DrawnSchema
	readonly target: number
	readonly op: Op
	readonly arms: Arr.NonEmptyReadonlyArray<MemberArm>
	/** An attach stage over the member's query. */
	readonly attached: boolean
}

/** Where a member refusal is located: at the member, at an arm's attachment, at the attach stage, or not asserted. */
export type At = "member" | "arm attachment" | "stage attachment" | "the union"

/** The rule a member refusal enforces, by the model's own names. */
export type MemberRule =
	| "an attachment on an arm"
	| "an attach stage"
	| "no discriminant"
	| "several headings"
	| "a missing field"
	| "an extra column"
	| "a column of another type"
	| "incompatible arms"

export type MemberVerdict =
	| {
			readonly kind: "admitted"
			/** The member's parameters, each of its field's kind. */
			readonly params: ReadonlyMap<string, ColumnKind>
	  }
	| {
			readonly kind: "refused"
			readonly reason: CompileReasonTag
			readonly rule: MemberRule
			readonly at: At
	  }

/** A field of the target relation: its name and kind, the serial field a bigint. */
interface Written {
	readonly name: string
	readonly kind: ColumnKind
	readonly serial: boolean
}

/** The fields a member of the relation writes: each of its fields, and its serial field. */
const writtenOf = (r: DrawnRelation): ReadonlyArray<Written> => [
	...Arr.map(r.fields, (x) => ({ name: x.name, kind: x.kind, serial: false })),
	...(r.serial ? [{ name: serialField, kind: "int8" as const, serial: true }] : [])
]

/** The kind a source relation's field is, its serial field a bigint, or none where it declares no such field. */
const sourceKind = (r: DrawnRelation, field: string): ColumnKind | undefined =>
	field === serialField
		? r.serial
			? "int8"
			: undefined
		: Arr.some(r.fields, (x) => x.name === field)
			? kindOf(r, field)
			: undefined

/**
 * The family a head term delivers a field at: the source variable's, the field's own for a literal or a parameter,
 * and for a sum of an integer an exact integer, which no field stores, and of a numeric a numeric.
 */
const deliveredFamily = (r: DrawnRelation, w: Written, term: Term): Family | "exact" => {
	switch (term) {
		case "var":
			return familyOf(sourceKind(r, w.name) ?? w.kind)
		case "literal":
		case "param":
			return familyOf(w.kind)
		case "sum":
			return familyOf(sourceKind(r, w.name) ?? w.kind) === "numeric" ? "numeric" : "exact"
	}
}

const headKeys = (arm: MemberArm): ReadonlyArray<string> => [
	...Arr.map(arm.writes, (w) => w.field),
	...(arm.extra ? ["extra"] : []),
	...(arm.tag === "none" ? [] : ["tag"])
]

/**
 * The model: attachments are refused where the checker meets them, an arm's before the stage's; arms of two headings
 * need their tags to differ (MissingDiscriminant) and are then two headings; and the head is held to the relation's
 * heading for the op, every column of its field's family.
 */
export const memberVerdict = (c: MemberCase): MemberVerdict => {
	const target = relationAt(c.schema, c.target)
	const refused = (reason: CompileReasonTag, rule: MemberRule, at: At): MemberVerdict => ({
		kind: "refused",
		reason,
		rule,
		at
	})
	if (Option.isSome(Arr.findFirst(c.arms, (a) => a.attached))) {
		return refused("DescribedHeadingMismatch", "an attachment on an arm", "arm attachment")
	}
	const written = writtenOf(target)
	const familyAt = (arm: MemberArm, field: string): Family | "exact" | undefined => {
		const w = Arr.findFirst(arm.writes, (x) => x.field === field)
		const f = Arr.findFirst(written, (x) => x.name === field)
		return w._tag === "Some" && f._tag === "Some"
			? deliveredFamily(relationAt(c.schema, arm.source), f.value, w.value.term)
			: undefined
	}
	for (const w of written) {
		const families = new Set(
			Arr.flatMap(c.arms, (arm) => {
				const family = familyAt(arm, w.name)
				return family === undefined ? [] : [family]
			})
		)
		if (families.size > 1) {
			return refused("MalformedDescription", "incompatible arms", "the union")
		}
	}
	const keyOf = (arm: MemberArm) =>
		Arr.join(
			Arr.sort(headKeys(arm), (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)),
			"\u0000"
		)
	const [first] = c.arms
	if (new Set(Arr.map(c.arms, keyOf)).size > 1) {
		const tags = Arr.map(c.arms, (a) => a.tag)
		const told = Arr.every(tags, (t) => t !== "none") && new Set(tags).size === tags.length
		if (!told) {
			return refused("MissingDiscriminant", "no discriminant", "the union")
		}
		return c.attached
			? refused("DescribedHeadingMismatch", "an attach stage", "stage attachment")
			: refused("DescribedHeadingMismatch", "several headings", "member")
	}
	if (c.attached) {
		return refused("DescribedHeadingMismatch", "an attach stage", "stage attachment")
	}
	const delivered = headKeys(first)
	const serial = Arr.filter(written, (w) => w.serial)
	const supplied = Arr.some(serial, (w) => Arr.contains(delivered, w.name))
	const expected =
		c.op === "insert" && serial.length > 0 && !supplied
			? Arr.filter(written, (w) => !w.serial)
			: written
	if (Arr.some(expected, (w) => !Arr.contains(delivered, w.name))) {
		return refused("DescribedHeadingMismatch", "a missing field", "member")
	}
	if (Arr.some(delivered, (d) => !Arr.some(expected, (w) => w.name === d))) {
		return refused("DescribedHeadingMismatch", "an extra column", "member")
	}
	if (Arr.some(expected, (w) => familyAt(first, w.name) !== familyOf(w.kind))) {
		return refused("DescribedHeadingMismatch", "a column of another type", "member")
	}
	return {
		kind: "admitted",
		params: new Map(
			Arr.flatMap(c.arms, (arm) =>
				Arr.flatMap(arm.writes, (w) => {
					const field = Arr.findFirst(written, (x) => x.name === w.field)
					return w.term === "param" && field._tag === "Some"
						? [[paramName(w.field), field.value.kind] as const]
						: []
				})
			)
		)
	}
}

/** The parameter a head writes a field by. */
const paramName = (field: string): string => `w_${field}`

/**
 * An arm's rule: its source matched on its key fields, which a sum reads each fact by, and the fields its variables and
 * sums read, and its head.
 */
const armRule = (c: MemberCase, arm: MemberArm): RuleDesc => {
	const target = relationAt(c.schema, c.target)
	const r = relationAt(c.schema, arm.source)
	const read = Arr.dedupe([
		...r.key,
		...Arr.flatMap(arm.writes, (w) => (w.term === "var" || w.term === "sum" ? [w.field] : []))
	])
	const head: Record<string, HeadTermDesc> = {}
	for (const w of arm.writes) {
		const kind = sourceKind(target, w.field) ?? "int4"
		head[w.field] =
			w.term === "var"
				? ref(r.name, w.field)
				: w.term === "sum"
					? sum(ref(r.name, w.field))
					: w.term === "param"
						? param(paramName(w.field), descriptorOf(kind))
						: lit(valueOf(kind))
	}
	if (arm.extra) {
		head["extra"] = lit(1)
	}
	if (arm.tag !== "none") {
		head["tag"] = typedLit(arm.tag, { kind: "closedId", roster: rosterName })
	}
	return rule({
		vars: varsAt(r.name, read),
		matches: [
			match(
				relationSource(r.name),
				Rec.fromEntries(
					Arr.map(read, (field): readonly [string, AuthoredExprDesc] => [field, ref(r.name, field)])
				)
			)
		],
		where: [],
		head,
		interiors: [],
		attach: arm.attached ? [{ name: "attached", child: childOf(r) }] : []
	})
}

/** An attachment's child over the relation, binding its `id` to the parent's column of that name. */
const childOf = (r: DrawnRelation): QueryDesc =>
	queryDesc(
		rule({
			vars: [],
			matches: [match(relationSource(r.name), { id: parent("id") })],
			where: [],
			head: {},
			interiors: [],
			attach: []
		})
	)

/** The member's query: its arms, under an attach stage where the case attaches one. */
const memberQuery = (c: MemberCase): QueryDesc => {
	const [first] = c.arms
	const arms: QueryDesc = {
		stage: { kind: "rules", arms: Arr.map(c.arms, (a) => armRule(c, a)) }
	}
	return c.attached ? attach(arms, "attached", childOf(relationAt(c.schema, first.source))) : arms
}

export const memberDesc = (c: MemberCase): MemberDesc => ({
	op: c.op,
	relation: relationAt(c.schema, c.target).name,
	member: { kind: "query", query: memberQuery(c) }
})

/** The kinds a head sums: the integers and the numerics. */
const summed: ReadonlyArray<ColumnKind> = ["int4", "int8", "num10", "num12"]

/**
 * How a head writes a field of the target from a source: mostly the source's variable of the field's name where it
 * declares one, else a literal or a parameter, sometimes a sum, and sometimes nothing, the serial field often.
 */
const writesGen =
	(s: DrawnSchema, target: number, source: number): Gen<MemberArm["writes"]> =>
	(inner) => {
		const t = relationAt(s, target)
		const r = relationAt(s, source)
		return Arr.flatMap(writtenOf(t), (w) => {
			const own = sourceKind(r, w.name)
			const summable = own !== undefined && Arr.contains(summed, own)
			const term = inner.draw(
				weighted<Term | "none">([
					[own === undefined ? 1 : 6, element([own === undefined ? "literal" : "var"] as const)],
					[2, element(["literal", "param"] as const)],
					[1, element([summable ? "sum" : "param"] as const)],
					[w.serial ? 6 : 1, element(["none"] as const)]
				])
			)
			return term === "none" ? [] : [{ field: w.name, term }]
		})
	}

const armGen =
	(s: DrawnSchema, target: number): Gen<MemberArm> =>
	(source) => {
		const from = source.draw(
			weighted([
				[2, element([target])],
				[1, element(Arr.map(s.relations, (_, i) => i))]
			])
		)
		return {
			source: from,
			writes: source.draw(writesGen(s, target, from)),
			extra: source.draw(
				weighted([
					[1, element([true])],
					[6, element([false])]
				])
			),
			tag: "none",
			attached: source.draw(
				weighted([
					[1, element([true])],
					[8, element([false])]
				])
			)
		}
	}

/**
 * A member case: a schema whose relations may have a serial field, a target, an op, one arm or two of one heading or
 * of two, told apart by their tags or not, and an attach stage or none.
 */
export const memberCaseGen: Gen<MemberCase> = (source) => {
	const schema = source.draw(drawnSchemaGen(2, true))
	const target = source.draw(element(Arr.map(schema.relations, (_, i) => i)))
	const first = source.draw(armGen(schema, target))
	const shape = source.draw(
		weighted([
			[3, element(["one arm"] as const)],
			[2, element(["one heading"] as const)],
			[1, element(["two headings"] as const)]
		])
	)
	/** An arm writing the fields the first writes, each as its own draw writes it, or by a literal where it writes none. */
	const second = (): MemberArm => {
		const again = source.draw(armGen(schema, target))
		return {
			...again,
			writes: Arr.map(first.writes, (w) =>
				Option.getOrElse(
					Arr.findFirst(again.writes, (x) => x.field === w.field),
					() => ({ field: w.field, term: "literal" as const })
				)
			),
			extra: first.extra
		}
	}
	const twoHeadings = (): Arr.NonEmptyReadonlyArray<MemberArm> => {
		const other = second()
		return [
			{ ...first, tag: source.draw(element(handles)) },
			{
				...other,
				writes: other.writes.slice(1),
				tag: source.draw(
					weighted<Handle | "none">([
						[4, element(handles)],
						[1, element(["none"] as const)]
					])
				)
			}
		]
	}
	const arms: Arr.NonEmptyReadonlyArray<MemberArm> =
		shape === "one arm" ? [first] : shape === "one heading" ? [first, second()] : twoHeadings()
	return {
		schema,
		target,
		op: source.draw(element(["insert", "put", "delete"] as const)),
		arms,
		attached: source.draw(
			weighted([
				[1, element([true])],
				[8, element([false])]
			])
		)
	}
}

/** What a member case reached: the rule a refusal enforced, or the shape of what was admitted, and its op. */
export type MemberFeature =
	| MemberRule
	| Op
	| "admitted"
	| "an insert leaving its serial field to its sequence"
	| "an insert writing its serial field"
	| "a put or delete without its serial field"
	| "a parameter written as its field"
	| "a sum written into a field"
	| "two arms of one heading"

export const memberFeatures = (c: MemberCase, v: MemberVerdict): ReadonlyArray<MemberFeature> => {
	const target = relationAt(c.schema, c.target)
	const [first] = c.arms
	const writesSerial = Arr.some(first.writes, (w) => w.field === serialField)
	const sums = Arr.some(c.arms, (a) => Arr.some(a.writes, (w) => w.term === "sum"))
	switch (v.kind) {
		case "refused":
			return [
				v.rule,
				c.op,
				...(target.serial && c.op !== "insert" && !writesSerial && v.rule === "a missing field"
					? ["a put or delete without its serial field" as const]
					: []),
				...(sums && v.rule === "a column of another type"
					? ["a sum written into a field" as const]
					: [])
			]
		case "admitted":
			return [
				"admitted",
				c.op,
				...(target.serial && c.op === "insert"
					? [
							writesSerial
								? ("an insert writing its serial field" as const)
								: ("an insert leaving its serial field to its sequence" as const)
						]
					: []),
				...(v.params.size > 0 ? ["a parameter written as its field" as const] : []),
				...(sums ? ["a sum written into a field" as const] : []),
				...(c.arms.length > 1 ? ["two arms of one heading" as const] : [])
			]
	}
}
