import { constant, element, type Gen, int, proportional, weighted } from "@bjornpagen/testing/gen"
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
} from "#test/support/unit/check/dsl.ts"
import {
	descriptorOf,
	type DrawnField,
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
	valueOf
} from "#test/unit/check/drawn.ts"

/**
 * ChangeSet members described by queries over a drawn schema, and the member rule restated as a model: an insert's and
 * a put's and a delete's head delivers the relation's whole heading; each column of its field's own type, a text's pattern the field's domain's
 * alone; one heading; and no attachment, which adds a field (DescribedHeadingMismatch, at the member, or at the
 * attachment).
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

/** The fields a member of the relation writes: each of its fields. */
const writtenOf = (r: DrawnRelation): ReadonlyArray<DrawnField> => r.fields

/** The kind a source relation's field is, or none where it declares no such field. */
const sourceKind = (r: DrawnRelation, field: string): ColumnKind | undefined =>
	Arr.some(r.fields, (x) => x.name === field) ? kindOf(r, field) : undefined

/** The type a head term delivers a field at: a kind a field declares, or a computed numeric, which none declares. */
type Delivered = ColumnKind | "computed"

/** The kinds a head sums: the integers and the numerics. */
type Summed = "int4" | "int8" | "num10" | "num12"
const summed: ReadonlyArray<Summed> = ["int4", "int8", "num10", "num12"]
const isSummed = (kind: ColumnKind): kind is Summed => Arr.some(summed, (k) => k === kind)

/**
 * What a sum of any summed kind is (README's table, scalar/aggregate.ts sumOverloads): exact, a computed numeric of its
 * argument's digits widened by the rows, an integer's as a numeric's.
 */
const sumDelivered: Delivered = "computed"

/**
 * The type a head term delivers a field at: the source variable's kind, the field's own for a literal or a parameter,
 * and a sum's sumDelivered.
 */
const deliveredType = (r: DrawnRelation, w: DrawnField, term: Term): Delivered => {
	const own = sourceKind(r, w.name) ?? w.kind
	switch (term) {
		case "var":
			return own
		case "literal":
		case "param":
			return w.kind
		case "sum":
			return sumDelivered
	}
}

/** The family a delivered type meets others in: a computed numeric a numeric's. */
const familyOfDelivered = (d: Delivered): Family => (d === "computed" ? "numeric" : familyOf(d))

/**
 * The type a column of arms of one family delivers at, as a union types it (check/refinement combine): their one type
 * where they agree; else the guarantees common to them, of numerics the computed numeric of both bounds' hull, and of
 * texts the text of every value, the wildcard, the numeric and text families being the two of several kinds.
 */
const unionType = (types: Arr.NonEmptyReadonlyArray<Delivered>): Delivered => {
	const [first, ...rest] = types
	return Arr.every(rest, (t) => t === first)
		? first
		: familyOfDelivered(first) === "numeric"
			? "computed"
			: "prose"
}

/**
 * The type a value enters a stored column at (ir/scalar.ts enteredType): a text's pattern is the column's domain's, so
 * every text kind enters as one; every other kind, a computed numeric among them, as itself.
 */
const enteredAt = (d: Delivered): Delivered | "text" =>
	d !== "computed" && familyOf(d) === "text" ? "text" : d

/** The type each arm of the case that writes the target's field `w` delivers it at, in arm order. */
const typesAt = (c: MemberCase, w: DrawnField): ReadonlyArray<Delivered> =>
	Arr.flatMap(c.arms, (arm) =>
		Arr.map(
			Arr.filter(arm.writes, (x) => x.field === w.name),
			(x) => deliveredType(relationAt(c.schema, arm.source), w, x.term)
		)
	)

/**
 * The target's fields some arm delivers at another kind of the field's own family, a numeric of another typmod or a
 * text of another pattern, by that family.
 */
const otherKindsOf = (c: MemberCase): ReadonlyArray<Family> => {
	const target = relationAt(c.schema, c.target)
	return Arr.flatMap(writtenOf(target), (w) =>
		Arr.some(
			typesAt(c, w),
			(t) => t !== "computed" && t !== w.kind && familyOf(t) === familyOf(w.kind)
		)
			? [familyOf(w.kind)]
			: []
	)
}

const headKeys = (arm: MemberArm): ReadonlyArray<string> => [
	...Arr.map(arm.writes, (w) => w.field),
	...(arm.extra ? ["extra"] : []),
	...(arm.tag === "none" ? [] : ["tag"])
]

/**
 * The model: attachments are refused where the checker meets them, an arm's before the stage's; arms of two headings
 * need their tags to differ (MissingDiscriminant) and are then two headings; and the head is held to the relation's
 * heading for the op, every column, as the arms' union types it, entering its field at the field's own type.
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
	for (const w of written) {
		if (new Set(Arr.map(typesAt(c, w), familyOfDelivered)).size > 1) {
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
	if (Arr.some(written, (w) => !Arr.contains(delivered, w.name))) {
		return refused("DescribedHeadingMismatch", "a missing field", "member")
	}
	if (Arr.some(delivered, (d) => !Arr.some(written, (w) => w.name === d))) {
		return refused("DescribedHeadingMismatch", "an extra column", "member")
	}
	const enters = (w: DrawnField): boolean =>
		Arr.match(typesAt(c, w), {
			onEmpty: () => {
				throw new Error(`the arms of one heading each write ${w.name}, which it expects`)
			},
			onNonEmpty: (types) => enteredAt(unionType(types)) === enteredAt(w.kind)
		})
	if (Arr.some(written, (w) => !enters(w))) {
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
		head["tag"] = typedLit(arm.tag, { kind: "closedId", roster: rosterName, only: undefined })
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

/**
 * How a head writes a field of the target from a source: mostly the source's variable of the field's name where it
 * declares one, else a literal or a parameter, sometimes a sum, and sometimes nothing.
 */
const writesGen =
	(s: DrawnSchema, target: number, source: number): Gen<MemberArm["writes"]> =>
	(inner) => {
		const t = relationAt(s, target)
		const r = relationAt(s, source)
		return Arr.flatMap(writtenOf(t), (w) => {
			const own = sourceKind(r, w.name)
			const summable = own !== undefined && isSummed(own)
			const term = inner.draw(
				weighted<Term | "none">([
					[own === undefined ? 1 : 6, element([own === undefined ? "literal" : "var"] as const)],
					[2, element(["literal", "param"] as const)],
					[1, element([summable ? "sum" : "param"] as const)],
					[1, element(["none"] as const)]
				])
			)
			return term === "none" ? [] : [{ field: w.name, term }]
		})
	}

/**
 * An arm over the target two draws in three, and over any relation of the schema, the target among them, otherwise: one
 * decision, the target first.
 */
const armGen =
	(s: DrawnSchema, target: number): Gen<MemberArm> =>
	(source) => {
		const others = Arr.filter(
			Arr.map(s.relations, (_, i) => i),
			(i) => i !== target
		)
		const from = source.draw(
			proportional<number>([
				[2 * s.relations.length + 1, constant(target)],
				...Arr.map(others, (i) => [1, constant(i)] as const)
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
 * A member case: a schema, a target, an op, one arm or two of one heading or
 * of two, told apart by their tags or not, and an attach stage or none.
 */
export const memberCaseGen: Gen<MemberCase> = (source) => {
	const schema = source.draw(drawnSchemaGen(2))
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

/**
 * A member whose one arm writes the target's key `id` and its field `a` from another relation's of those names, each by
 * its variable, the two `a`s of two kinds among `kinds`, one family's: a numeric of another typmod, which the target
 * refuses, or a text of another pattern, which enters as the target's own.
 */
export const otherKindCaseGen =
	(kinds: Arr.NonEmptyReadonlyArray<ColumnKind>): Gen<MemberCase> =>
	(source) => {
		const at = source.draw(int(0, kinds.length - 1))
		const step = source.draw(int(1, kinds.length - 1))
		const relationOf = (name: string, kind: ColumnKind): DrawnRelation => ({
			name,
			fields: [
				{ name: "id", kind: "int4" },
				{ name: "a", kind }
			],
			key: ["id"]
		})
		return {
			schema: {
				relations: [
					relationOf("R0", Arr.getUnsafe(kinds, at)),
					relationOf("R1", Arr.getUnsafe(kinds, (at + step) % kinds.length))
				]
			},
			target: 0,
			op: source.draw(element(["insert", "put", "delete"] as const)),
			arms: [
				{
					source: 1,
					writes: [
						{ field: "id", term: "var" },
						{ field: "a", term: "var" }
					],
					extra: false,
					tag: "none",
					attached: false
				}
			],
			attached: false
		}
	}

/** What a member case reached: the rule a refusal enforced, or the shape of what was admitted, and its op. */
export type MemberFeature =
	| MemberRule
	| Op
	| "admitted"
	| "a parameter written as its field"
	| "a sum written into a field"
	| "two arms of one heading"
	| "a numeric of another typmod"
	| "a text of another pattern"

export const memberFeatures = (c: MemberCase, v: MemberVerdict): ReadonlyArray<MemberFeature> => {
	const sums = Arr.some(c.arms, (a) => Arr.some(a.writes, (w) => w.term === "sum"))
	const others = otherKindsOf(c)
	switch (v.kind) {
		case "refused":
			return [
				v.rule,
				c.op,
				...(sums && v.rule === "a column of another type"
					? ["a sum written into a field" as const]
					: []),
				...(Arr.contains(others, "numeric") && v.rule === "a column of another type"
					? ["a numeric of another typmod" as const]
					: [])
			]
		case "admitted":
			return [
				"admitted",
				c.op,
				...(v.params.size > 0 ? ["a parameter written as its field" as const] : []),
				...(sums ? ["a sum written into a field" as const] : []),
				...(c.arms.length > 1 ? ["two arms of one heading" as const] : []),
				...(Arr.contains(others, "text") ? ["a text of another pattern" as const] : [])
			]
	}
}
