import {
	array,
	element,
	type Gen,
	int,
	map,
	oneOf,
	shuffled,
	subarray,
	weighted
} from "@bjornpagen/testing/gen"
import { Array as Arr, Equivalence, Option, Order } from "effect"
import type { CompileReasonTag } from "#compiler/core/errors.ts"
import { type Direction, directions } from "#compiler/core/order.ts"
import type {
	AuthoredExprDesc,
	QueryDesc,
	RuleDesc,
	VarDesc
} from "#test/support/fixtures/ir/desc.ts"
import { argumentsOf } from "#test/support/list.ts"
import {
	type DrawnSchema,
	drawnSchemaGen,
	type ColumnKind,
	type Handle,
	handles,
	kindOf,
	relationAt,
	rosterName
} from "#test/unit/check/drawn.ts"
import {
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
	varsAt
} from "#test/unit/check/dsl.ts"

/**
 * Unions of rules over a drawn schema, and the checker's rules for them restated as a model: heading groups, column
 * types, attachments on arms, the discriminant, the order a take or a delivered order completes, and the arms a match
 * of the union selects.
 */

/** The bare text literals a `k` column holds. */
const texts = ["x", "y", "z"] as const
export type Text = (typeof texts)[number]

/**
 * An arm: one match of its relation binding `fields`, each delivered under its own name, and the literal columns it
 * states: `tag`, a typed Kind handle; `k`, a bare text; `marks`, a set over Kind. `attached` attaches a child that
 * binds the arm's first field to the parent's column of that name.
 */
export interface Arm {
	readonly relation: number
	readonly fields: Arr.NonEmptyReadonlyArray<string>
	readonly tag: Handle | "none"
	readonly k: Text | "none"
	readonly marks: ReadonlyArray<Handle> | "none"
	readonly attached: boolean
}

export interface OrderColumn {
	readonly column: string
	readonly dir: Direction
}

/** A binding of the importing match: a column to a fresh variable, or a literal column to a constant. */
export type Binding =
	| { readonly column: string; readonly to: "var" }
	| { readonly column: "tag"; readonly to: Handle }
	| { readonly column: "k"; readonly to: Text }

/**
 * What reads the union: the union delivered as a set, ordered by some of its common columns and delivered or bounded by
 * a take, or matched by an importing rule.
 */
export type Consumer =
	| { readonly kind: "delivered" }
	| { readonly kind: "ordered"; readonly order: Arr.NonEmptyReadonlyArray<OrderColumn> }
	| {
			readonly kind: "taken"
			readonly order: Arr.NonEmptyReadonlyArray<OrderColumn>
			readonly k: number
	  }
	| { readonly kind: "matched"; readonly bindings: Arr.NonEmptyReadonlyArray<Binding> }

export interface UnionCase {
	readonly schema: DrawnSchema
	readonly arms: Arr.NonEmptyReadonlyArray<Arm>
	readonly consumer: Consumer
}

/**
 * A column's type: a field's kind; a `tag`'s, Kind's closed id; a bare `k`'s, the wildcard text; a `marks`', a set
 * over Kind; or numeric of no typmod, which two numeric typmods meet as.
 */
type ColumnType = ColumnKind | "bits" | "hull"

type ColumnFamily = "int4" | "int8" | "uuid" | "numeric" | "text" | "kind" | "qty" | "bits"

const familyOf = (t: ColumnType): ColumnFamily => {
	switch (t) {
		case "num10":
		case "num12":
		case "hull":
			return "numeric"
		case "lower":
		case "code":
		case "prose":
			return "text"
		case "int4":
		case "int8":
		case "uuid":
		case "kind":
		case "qty":
		case "bits":
			return t
	}
}

/**
 * The type arms delivering a column at `types` take: the type they share, else, within one family, their common
 * guarantees (numeric of no typmod for two typmods, the wildcard for texts of different languages), else none: they
 * are incompatible.
 */
const commonOf = (types: Arr.NonEmptyReadonlyArray<ColumnType>): ColumnType | undefined => {
	const [first] = types
	if (Arr.every(types, (t) => t === first)) {
		return first
	}
	if (!Arr.every(types, (t) => familyOf(t) === familyOf(first))) {
		return undefined
	}
	switch (familyOf(first)) {
		case "numeric":
			return "hull"
		case "text":
			return "prose"
		case "int4":
		case "int8":
		case "uuid":
		case "kind":
		case "qty":
		case "bits":
			return undefined
	}
}

/** One column of an arm's heading: its name, its type and, for a literal column, its literal's canonical text. */
interface Column {
	readonly name: string
	readonly type: ColumnType
	readonly literal: string | undefined
}

const byName: Order.Order<Column> = Order.mapInput(Order.String, (c: Column) => c.name)

/** An arm's heading, in the checker's heading order: its columns by name. */
const headingOf = (s: DrawnSchema, arm: Arm): ReadonlyArray<Column> => {
	const r = relationAt(s, arm.relation)
	const fields = Arr.map(arm.fields, (field): Column => ({
		name: field,
		type: kindOf(r, field),
		literal: undefined
	}))
	const literals: ReadonlyArray<Column> = [
		...(arm.tag === "none" ? [] : [{ name: "tag", type: "kind" as const, literal: arm.tag }]),
		...(arm.k === "none" ? [] : [{ name: "k", type: "prose" as const, literal: arm.k }]),
		...(arm.marks === "none"
			? []
			: [{ name: "marks", type: "bits" as const, literal: Arr.join(arm.marks, ",") }])
	]
	const columns: ReadonlyArray<Column> = [...fields, ...literals]
	return Arr.sort(columns, byName)
}

const namesOf = (heading: ReadonlyArray<Column>): ReadonlyArray<string> =>
	Arr.map(heading, (h) => h.name)

/** The rule a refusal enforces, by the model's own names. */
export type UnionRule =
	| "an attachment on a shared heading"
	| "incompatible column types"
	| "an attached arm widened"
	| "no discriminant"
	| "a keyless order"
	| "constants no arm delivers"
	| "a column the selected arms lack"

/** How the discriminant of arms of several headings was chosen: Kind's columns alone, or every literal column. */
export type DiscriminantKind = "none" | "of Kind" | "of every literal column"

/** What the model makes of a case: refused for a reason under a rule, or admitted. */
export type UnionVerdict =
	| { readonly kind: "refused"; readonly reason: CompileReasonTag; readonly rule: UnionRule }
	| {
			readonly kind: "admitted"
			readonly groups: number
			readonly heading: ReadonlyArray<string>
			readonly discriminant: ReadonlyArray<string>
			readonly chosen: DiscriminantKind
			readonly widened: boolean
			/** Whether a match of the union narrowed it to some of its arms. */
			readonly narrowed: boolean
	  }

const refused = (reason: CompileReasonTag, rule: UnionRule): UnionVerdict => ({
	kind: "refused",
	reason,
	rule
})

/** The arm at `index` of the case. */
const armAt = (c: UnionCase, index: number): Arm =>
	Option.getOrThrowWith(Arr.get(c.arms, index), () => new Error(`no arm ${index}`))

/** Every arm of the case by its index. */
const everyArm = (c: UnionCase): Arr.NonEmptyReadonlyArray<number> => Arr.map(c.arms, (_, i) => i)

/**
 * The union of the arms at `indices` as the checker builds it: arms grouped by the names of their headings; an
 * attached arm shares its heading with no other arm (UnsupportedOperation); each column of a group takes the type its
 * arms agree on, and a column several groups deliver is of one family (MalformedDescription); a column every group
 * delivers is widened to their common type, which an attached arm's column cannot be (UnsupportedOperation); and arms
 * of several headings are told apart by a discriminant, the common columns bound to a literal in every head, Kind's
 * alone where they tell the groups apart, whose literal tuples differ between groups (MissingDiscriminant).
 */
const unionVerdict = (c: UnionCase, indices: Arr.NonEmptyReadonlyArray<number>): UnionVerdict => {
	const heading = (i: number): ReadonlyArray<Column> => headingOf(c.schema, armAt(c, i))
	const groups: Array<{ readonly key: string; readonly arms: Array<number> }> = []
	for (const i of indices) {
		const key = Arr.join(namesOf(heading(i)), "\u0000")
		const group = Arr.findFirst(groups, (g) => g.key === key)
		if (Option.isNone(group)) {
			groups.push({ key, arms: [i] })
		} else {
			group.value.arms.push(i)
		}
	}
	if (Arr.some(groups, (g) => g.arms.length > 1 && Arr.some(g.arms, (i) => armAt(c, i).attached))) {
		return refused("UnsupportedOperation", "an attachment on a shared heading")
	}
	const targets: Array<Map<string, ColumnType>> = []
	for (const g of groups) {
		const target = new Map<string, ColumnType>()
		for (const column of heading(g.arms[0] ?? indices[0])) {
			const types = Arr.map(g.arms, (i) =>
				Option.getOrElse(
					Option.map(
						Arr.findFirst(heading(i), (h) => h.name === column.name),
						(h) => h.type
					),
					() => column.type
				)
			)
			const agreed = commonOf([column.type, ...types])
			if (agreed === undefined) {
				return refused("MalformedDescription", "incompatible column types")
			}
			target.set(column.name, agreed)
		}
		targets.push(target)
	}
	for (const [gi, target] of targets.entries()) {
		for (const earlier of targets.slice(0, gi)) {
			for (const [name, t] of target) {
				const known = earlier.get(name)
				if (known !== undefined && familyOf(known) !== familyOf(t)) {
					return refused("MalformedDescription", "incompatible column types")
				}
			}
		}
	}
	const first = indices[0]
	const common =
		groups.length > 1
			? Arr.filter(namesOf(heading(first)), (name) => Arr.every(targets, (t) => t.has(name)))
			: []
	for (const name of common) {
		const [t, ...ts] = Arr.flatMap(targets, (target) => {
			const x = target.get(name)
			return x === undefined ? [] : [x]
		})
		const wider = t === undefined ? undefined : commonOf([t, ...ts])
		if (wider !== undefined) {
			for (const target of targets) {
				target.set(name, wider)
			}
		}
	}
	let widened = false
	for (const [gi, g] of groups.entries()) {
		for (const i of g.arms) {
			const target = targets[gi]
			if (Arr.some(heading(i), (h) => target?.get(h.name) !== h.type)) {
				widened = true
				if (armAt(c, i).attached) {
					return refused("UnsupportedOperation", "an attached arm widened")
				}
			}
		}
	}
	if (groups.length === 1) {
		return {
			kind: "admitted",
			groups: 1,
			heading: namesOf(heading(first)),
			discriminant: [],
			chosen: "none",
			widened,
			narrowed: false
		}
	}
	const literal = Arr.filter(common, (name) =>
		Arr.every(indices, (i) =>
			Arr.some(heading(i), (h) => h.name === name && h.literal !== undefined)
		)
	)
	const tuple = (i: number, columns: ReadonlyArray<string>): string =>
		Arr.join(
			Arr.map(columns, (name) =>
				Option.getOrElse(
					Option.flatMap(
						Arr.findFirst(heading(i), (h) => h.name === name),
						(h) => Option.fromNullishOr(h.literal)
					),
					() => ""
				)
			),
			"\u0000"
		)
	const clashes = (columns: ReadonlyArray<string>): boolean =>
		Arr.some(groups, (g, gi) =>
			Arr.some(groups.slice(0, gi), (other) =>
				Arr.some(g.arms, (i) =>
					Arr.some(other.arms, (j) => tuple(i, columns) === tuple(j, columns))
				)
			)
		)
	const rostered = Arr.filter(literal, (name) => name === "tag")
	const ofKind = rostered.length > 0 && !clashes(rostered)
	const discriminant = ofKind ? rostered : literal
	if (discriminant.length === 0 || clashes(discriminant)) {
		return refused("MissingDiscriminant", "no discriminant")
	}
	return {
		kind: "admitted",
		groups: groups.length,
		heading: common,
		discriminant,
		chosen: ofKind ? "of Kind" : "of every literal column",
		widened,
		narrowed: false
	}
}

/**
 * Whether an arm's rows have a key within `columns`: its relation's key fields, or every column it delivers by a
 * term, its literal columns being constant within it.
 */
const keyedWithin = (s: DrawnSchema, arm: Arm, columns: ReadonlyArray<string>): boolean => {
	const r = relationAt(s, arm.relation)
	const within = (field: string) => Arr.contains(arm.fields, field) && Arr.contains(columns, field)
	return Arr.every(r.key, within) || Arr.every(arm.fields, within)
}

/** The literal an arm states at a column, by its canonical text, or none. */
const literalAt = (s: DrawnSchema, arm: Arm, column: string): string | undefined =>
	Option.getOrUndefined(
		Option.flatMap(
			Arr.findFirst(headingOf(s, arm), (h) => h.name === column),
			(h) => Option.fromNullishOr(h.literal)
		)
	)

/**
 * A match of the union: each constant the match binds a column of the union's heading selects the arms that deliver
 * it, refused when none does (MalformedDescription); a union of several headings whose bindings name a column only some
 * arms deliver narrows to the arms its constants select, which select again over their own heading; and every column
 * the match binds is a column of what it narrowed to (MalformedDescription).
 */
const matchVerdict = (c: UnionCase, bindings: Arr.NonEmptyReadonlyArray<Binding>): UnionVerdict => {
	const whole = unionVerdict(c, everyArm(c))
	if (whole.kind === "refused") {
		return whole
	}
	const narrow = (indices: Arr.NonEmptyReadonlyArray<number>): UnionVerdict => {
		const union = unionVerdict(c, indices)
		if (union.kind === "refused") {
			return union
		}
		const constants = Arr.filter(
			bindings,
			(b) => b.to !== "var" && Arr.contains(union.heading, b.column)
		)
		const [chosen, ...more] = Arr.filter(indices, (i) =>
			Arr.every(constants, (b) => literalAt(c.schema, armAt(c, i), b.column) === b.to)
		)
		if (chosen === undefined) {
			return refused("MalformedDescription", "constants no arm delivers")
		}
		if (
			indices.length === 1 ||
			union.groups < 2 ||
			more.length + 1 === indices.length ||
			Arr.every(bindings, (b) => Arr.contains(union.heading, b.column))
		) {
			return union
		}
		const next = narrow([chosen, ...more])
		return next.kind === "admitted" ? { ...next, narrowed: true } : next
	}
	const narrowed = narrow(everyArm(c))
	if (narrowed.kind === "refused") {
		return narrowed
	}
	return Arr.every(bindings, (b) => Arr.contains(narrowed.heading, b.column))
		? narrowed
		: refused("MalformedDescription", "a column the selected arms lack")
}

/**
 * The checker's answer for a case: its union's, then its consumer's. An order over arms of several headings, delivered
 * or bounded by a take, is completed over their common columns, refused unless those hold a key of every arm
 * (UnsupportedOperation).
 */
export const verdictOf = (c: UnionCase): UnionVerdict => {
	switch (c.consumer.kind) {
		case "delivered":
			return unionVerdict(c, everyArm(c))
		case "ordered":
		case "taken": {
			const union = unionVerdict(c, everyArm(c))
			if (union.kind === "refused" || union.groups === 1) {
				return union
			}
			return Arr.every(c.arms, (arm) => keyedWithin(c.schema, arm, union.heading))
				? union
				: refused("UnsupportedOperation", "a keyless order")
		}
		case "matched":
			return matchVerdict(c, c.consumer.bindings)
	}
}

/** Kind's closed id, which a `tag` literal is typed by. */
const kindId = { kind: "closedId", roster: rosterName } as const

/** An arm's rule: its match, its head, and its attachment. */
const armRule = (s: DrawnSchema, arm: Arm): RuleDesc => {
	const r = relationAt(s, arm.relation)
	const bound: Record<string, AuthoredExprDesc> = {}
	const head: Record<string, AuthoredExprDesc> = {}
	for (const field of arm.fields) {
		bound[field] = ref(r.name, field)
		head[field] = ref(r.name, field)
	}
	if (arm.tag !== "none") {
		head["tag"] = typedLit(arm.tag, kindId)
	}
	if (arm.k !== "none") {
		head["k"] = lit(arm.k)
	}
	if (arm.marks !== "none") {
		head["marks"] = typedLit({ handles: arm.marks }, { kind: "bits", roster: rosterName })
	}
	const [first] = arm.fields
	const child = queryDesc(
		rule({
			vars: [],
			matches: [match(relationSource(r.name), { [first]: parent(first) })],
			where: [],
			head: {},
			interiors: [],
			attach: []
		})
	)
	return rule({
		vars: varsAt(r.name, arm.fields),
		matches: [match(relationSource(r.name), bound)],
		where: [],
		head,
		interiors: [],
		attach: arm.attached ? [{ name: "attached", child }] : []
	})
}

const unionDesc = (c: UnionCase): QueryDesc => ({
	stage: { kind: "rules", arms: Arr.map(c.arms, (a) => armRule(c.schema, a)) }
})

const orderOf = (order: ReadonlyArray<OrderColumn>): ReadonlyArray<readonly [string, Direction]> =>
	Arr.map(order, (o) => [o.column, o.dir] as const)

/** The case's query: the union read by its consumer. */
export const caseDesc = (c: UnionCase): QueryDesc => {
	const union = unionDesc(c)
	switch (c.consumer.kind) {
		case "delivered":
			return union
		case "ordered":
			return orderBy(union, ...argumentsOf(orderOf(c.consumer.order)))
		case "taken":
			return take(orderBy(union, ...argumentsOf(orderOf(c.consumer.order))), c.consumer.k)
		case "matched": {
			const bound: Record<string, AuthoredExprDesc> = {}
			const head: Record<string, AuthoredExprDesc> = {}
			const declared: Array<VarDesc> = []
			for (const b of c.consumer.bindings) {
				if (b.to === "var") {
					const id = `v.${b.column}`
					declared.push(plainVar(id))
					bound[b.column] = varRef(id)
					head[b.column] = varRef(id)
				} else {
					bound[b.column] = lit(b.to)
				}
			}
			return queryDesc(
				rule({
					vars: declared,
					matches: [match(imported(union, {}), bound)],
					where: [],
					head,
					interiors: [],
					attach: []
				})
			)
		}
	}
}

const none = element(["none"] as const)

/**
 * An arm over a relation of the schema: its `id` alone, which every relation has, a third of the time, else some of its
 * fields; and literal columns from small dictionaries, a set over Kind where the union's arms all state one.
 */
const armGen =
	(s: DrawnSchema, marks: boolean): Gen<Arm> =>
	(source) => {
		const relation = source.draw(element(Arr.map(s.relations, (_, i) => i)))
		const names = Arr.map(relationAt(s, relation).fields, (x) => x.name)
		const [first, ...rest] = source.draw(
			weighted<ReadonlyArray<string>>([
				[1, element([["id"]])],
				[2, shuffled(names, { min: 1, max: names.length })]
			])
		)
		return {
			relation,
			fields: [first ?? names[0], ...rest],
			tag: source.draw(
				weighted<Handle | "none">([
					[4, element(handles)],
					[1, none]
				])
			),
			k: source.draw(
				weighted<Text | "none">([
					[1, element(texts)],
					[2, none]
				])
			),
			marks: marks ? source.draw(subarray(handles)) : "none",
			attached: source.draw(
				weighted([
					[1, element([true])],
					[5, element([false])]
				])
			)
		}
	}

/** The columns every arm delivers, by name. */
const sharedOf = (s: DrawnSchema, arms: Arr.NonEmptyReadonlyArray<Arm>): ReadonlyArray<string> => {
	const [first, ...rest] = Arr.map(arms, (a) => namesOf(headingOf(s, a)))
	return Arr.filter(first, (name) => Arr.every(rest, (h) => Arr.contains(h, name)))
}

/** A nonempty order over some of `columns`, each once, in a drawn direction. */
const orderGen =
	(columns: Arr.NonEmptyReadonlyArray<string>): Gen<Arr.NonEmptyReadonlyArray<OrderColumn>> =>
	(source) => {
		const column = (name: string): OrderColumn => ({
			column: name,
			dir: source.draw(element(directions))
		})
		const [first, ...rest] = source.draw(shuffled(columns, { min: 1, max: columns.length }))
		return [column(first ?? columns[0]), ...Arr.map(rest, column)]
	}

/** A binding of a column any arm delivers to a variable, or of `tag` or `k` to a constant. */
const bindingGen = (columns: Arr.NonEmptyReadonlyArray<string>): Gen<Binding> =>
	oneOf<Binding>([
		(source) => ({ column: source.draw(element(columns)), to: "var" }),
		(source) => ({ column: "tag", to: source.draw(element(handles)) }),
		(source) => ({ column: "k", to: source.draw(element(texts)) })
	])

/**
 * Bindings aimed at one arm: its `tag` constant where it states one, and one of its columns to a variable, a column
 * the other arms may lack.
 */
const aimedGen =
	(s: DrawnSchema, arms: Arr.NonEmptyReadonlyArray<Arm>): Gen<ReadonlyArray<Binding>> =>
	(source) => {
		const arm = source.draw(element(arms))
		const columns = Arr.filter(namesOf(headingOf(s, arm)), (n) => n !== "tag")
		const [column, ...more] = columns
		return [
			...(arm.tag === "none" ? [] : [{ column: "tag" as const, to: arm.tag }]),
			...(column === undefined
				? []
				: [{ column: source.draw(element([column, ...more])), to: "var" as const }])
		]
	}

/**
 * Two arms delivering `id`, over two relations where the schema has two, each with a `tag` of its own drawing: arms of
 * one heading, or two told apart by Kind, whose `id` columns are often of one family and two types, which the union
 * widens.
 */
const twinsGen =
	(s: DrawnSchema): Gen<Arr.NonEmptyReadonlyArray<Arm>> =>
	(source) => {
		const first = source.draw(element(Arr.map(s.relations, (_, i) => i)))
		const twin = (relation: number): Arm => ({
			relation,
			fields: ["id"],
			tag: source.draw(
				weighted<Handle | "none">([
					[4, element(handles)],
					[1, none]
				])
			),
			k: "none",
			marks: "none",
			attached: source.draw(
				weighted([
					[1, element([true])],
					[5, element([false])]
				])
			)
		})
		return [twin(first), twin((first + 1) % s.relations.length)]
	}

/** One to three arms drawn freely, or two twins. */
const freeArmsGen =
	(s: DrawnSchema, marks: boolean): Gen<Arr.NonEmptyReadonlyArray<Arm>> =>
	(source) => [
		source.draw(armGen(s, marks)),
		...source.draw(array(armGen(s, marks), { min: 0, max: 2 }))
	]

const armsGen = (s: DrawnSchema, marks: boolean): Gen<Arr.NonEmptyReadonlyArray<Arm>> =>
	weighted([
		[3, freeArmsGen(s, marks)],
		[2, twinsGen(s)]
	])

/** Whether two arms deliver one heading, column for column. */
const sameHeading =
	(s: DrawnSchema) =>
	(a: Arm, b: Arm): boolean =>
		Arr.makeEquivalence(Equivalence.String)(namesOf(headingOf(s, a)), namesOf(headingOf(s, b)))

/**
 * Arms whose headings are all their own or all one, the unions whose order the model's key rule decides, since the
 * key of several arms of one heading among others rests on what tells those arms apart: free arms, each after the
 * first of its heading left out, so every heading is its own; or two twins, whose two headings are one or two.
 */
const orderableArmsGen = (s: DrawnSchema): Gen<Arr.NonEmptyReadonlyArray<Arm>> =>
	weighted([
		[3, map(freeArmsGen(s, false), (arms) => Arr.dedupeWith(arms, sameHeading(s)))],
		[2, twinsGen(s)]
	])

/**
 * A union case: a schema, one to three arms over it, and what reads them. An order is drawn only over arms whose
 * headings are all one or all distinct, and never beside a set column, whose type has no admitted order.
 */
export const unionCaseGen: Gen<UnionCase> = (source) => {
	const schema = source.draw(drawnSchemaGen(3, false))
	const reader = source.draw(element(["delivered", "ordered", "taken", "matched"] as const))
	const ordering = reader === "ordered" || reader === "taken"
	const arms = ordering
		? source.draw(orderableArmsGen(schema))
		: source.draw(
				armsGen(
					schema,
					source.draw(
						weighted([
							[1, element([true])],
							[2, element([false])]
						])
					)
				)
			)
	const [shared, ...moreShared] = sharedOf(schema, arms)
	switch (reader) {
		case "delivered":
			return { schema, arms, consumer: { kind: "delivered" } }
		case "ordered":
		case "taken": {
			if (shared === undefined) {
				return { schema, arms, consumer: { kind: "delivered" } }
			}
			const order = source.draw(orderGen([shared, ...moreShared]))
			return reader === "ordered"
				? { schema, arms, consumer: { kind: "ordered", order } }
				: { schema, arms, consumer: { kind: "taken", order, k: source.draw(int(1, 5)) } }
		}
		case "matched": {
			const [name, ...names] = Arr.dedupe(Arr.flatMap(arms, (a) => namesOf(headingOf(schema, a))))
			const drawn = source.draw(
				weighted([
					[1, array(bindingGen([name ?? "id", ...names]), { min: 1, max: 3 })],
					[2, aimedGen(schema, arms)]
				])
			)
			const [b, ...bs] = Arr.dedupeWith(drawn, (x, y) => x.column === y.column)
			return {
				schema,
				arms,
				consumer: { kind: "matched", bindings: [b ?? { column: "id", to: "var" }, ...bs] }
			}
		}
	}
}
