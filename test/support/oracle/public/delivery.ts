import { Array as Arr, Option } from "effect"
import type { Nested, Shape } from "#test/support/oracle/public/answer.ts"
import {
	type Binding,
	type Column,
	type ProgramField,
	type HeadItem,
	hasFilter,
	isAggregate,
	type Match,
	type ParentColumn,
	type Query,
	type Rule,
	type Source,
	type StatedDelivery,
	type Stored
} from "#test/support/oracle/public/program.ts"
import { equal, type Value } from "#test/support/oracle/reference/values.ts"

/** The query an attachment attaches to, as the proof reads it. */
export type Parent<P extends ParentColumn> = Pick<Query<P>, "heading" | "arms">

/** What the language proves of one attachment's children per parent. */
export interface DeliveryProof {
	readonly atMostOne: boolean
	readonly exactlyOne: boolean
	readonly arms: ReadonlyArray<Extract<StatedDelivery, { readonly kind: "arm" }>>
}

/**
 * The keys of a source: a stored relation's primary key and key(...) statements, a roster's id; no key is proved of a
 * derived source.
 */
export const keysOf = (source: Source): ReadonlyArray<Arr.NonEmptyReadonlyArray<ProgramField>> => {
	switch (source.kind) {
		case "stored":
			return [source.primaryKey, ...source.candidates]
		case "roster":
			return [[source.id]]
		case "import":
		case "interior":
		case "relation param":
		case "closure":
			return []
	}
}

/** The operand a match binds `field` to, or none where it leaves the field out. */
const boundTo = <P extends ParentColumn>(
	m: Match<P>,
	field: ProgramField
): Option.Option<Binding<P>["operand"]> =>
	Option.map(
		Arr.findFirst(m.bindings, (b) => b.field === field),
		(b) => b.operand
	)

/** Whether a match fixes a key of its source per parent. */
const fixesKey = (m: Match<ParentColumn>): boolean =>
	Arr.some(keysOf(m.source), (key) =>
		Arr.every(key, (field) => Option.exists(boundTo(m, field), (operand) => operand.kind !== "var"))
	)

/**
 * Whether a head item folds the rule (an aggregate) rather than keying its groups (a variable, a computed term or a
 * literal).
 */
const folds = (h: HeadItem): boolean => {
	switch (h.kind) {
		case "count":
		case "fold":
			return true
		case "var":
		case "computed":
		case "literal":
			return false
	}
}

const groupsByNoVariable = <P extends ParentColumn>(rule: Rule<P>): boolean =>
	isAggregate(rule) && Arr.every(rule.head, folds)

/** How many times a rule binds a variable, over every match. */
const bindingsOf = <P extends ParentColumn>(rule: Rule<P>, id: number): number =>
	Arr.reduce(
		rule.matches,
		0,
		(n, m) =>
			n + Arr.filter(m.bindings, (b) => b.operand.kind === "var" && b.operand.var.id === id).length
	)

/**
 * The child's one match when it is a single match of a stored relation with no filter and no negation, every field
 * but `except` bound to a parent column or to a variable bound nowhere else, or left out.
 */
const soleMatch = (
	rule: Rule<ParentColumn>,
	except: ProgramField | undefined
): (Match<ParentColumn> & { readonly source: Stored }) | undefined => {
	const [m, ...rest] = rule.matches
	if (rest.length > 0 || hasFilter(rule) || rule.negations.length > 0) {
		return undefined
	}
	const source = m.source
	if (source.kind !== "stored") {
		return undefined
	}
	const own = Arr.every(
		m.bindings,
		(b) =>
			b.field === except ||
			b.operand.kind === "parent" ||
			(b.operand.kind === "var" && bindingsOf(rule, b.operand.var.id) === 1)
	)
	return own ? { source, bindings: m.bindings } : undefined
}

/** The fields a match binds to parent columns, with the column each takes. */
const parentBound = (
	m: Match<ParentColumn>
): ReadonlyArray<{ readonly field: ProgramField; readonly column: Column }> =>
	Arr.flatMap(m.bindings, (b) =>
		b.operand.kind === "parent" ? [{ field: b.field, column: b.operand.column }] : []
	)

/**
 * The variable of a rule's head column, or undefined where the column is an aggregate, a computed term, a literal or
 * no head key.
 */
const headVar = <P extends ParentColumn>(rule: Rule<P>, column: string): number | undefined => {
	const h = Arr.findFirst(rule.head, (item) => item.name === column)
	if (Option.isNone(h)) {
		return undefined
	}
	switch (h.value.kind) {
		case "var":
			return h.value.var.id
		case "count":
		case "fold":
		case "computed":
		case "literal":
			return undefined
	}
}

/** The fields at which a match binds variable `id`. */
const fieldsOf = <P extends ParentColumn>(m: Match<P>, id: number): ReadonlyArray<ProgramField> =>
	Arr.flatMap(m.bindings, (b) =>
		b.operand.kind === "var" && b.operand.var.id === id ? [b.field] : []
	)

/**
 * Whether a parent rule's match of `relation` binds `field` to the head variable of `column`, and, where `once`, binds
 * that variable at no other field of the match.
 */
const readsAt = <P extends ParentColumn>(
	rule: Rule<P>,
	pm: Match<P>,
	relation: Stored,
	field: ProgramField,
	column: Column,
	once: boolean
) => {
	const id = headVar(rule, column.name)
	if (id === undefined || pm.source.kind !== "stored" || pm.source.name !== relation.name) {
		return false
	}
	const at = fieldsOf(pm, id)
	return Arr.some(at, (f) => f.name === field.name) && (!once || at.length === 1)
}

/** The reflexive self-match (see the header). */
const reflexive = <P extends ParentColumn>(
	parent: Parent<P>,
	rule: Rule<ParentColumn>
): boolean => {
	const m = soleMatch(rule, undefined)
	const [only, ...more] = parent.arms
	if (!groupsByNoVariable(rule) || m === undefined || more.length > 0) {
		return false
	}
	const bound = parentBound(m)
	return (
		bound.length > 0 &&
		Arr.some(only.matches, (pm) =>
			Arr.every(bound, ({ field, column }) => readsAt(only, pm, m.source, field, column, true))
		)
	)
}

/** The arms the child is (see the header): one per literal handle at a handle field and parent column d that hold. */
const arms = <P extends ParentColumn>(
	parent: Parent<P>,
	rule: Rule<ParentColumn>
): DeliveryProof["arms"] =>
	Arr.flatMap(rule.matches[0].bindings, (h) => {
		const operand = h.operand
		const m = soleMatch(rule, h.field)
		if (m === undefined || operand.kind !== "literal" || operand.literal.kind !== "enum") {
			return []
		}
		const handle = operand.literal.handle
		const bound = parentBound(m)
		const fixed = new Set(Arr.map(bound, (b) => b.field))
		if (
			!Arr.some(
				keysOf(m.source),
				(k) => k.length === fixed.size && Arr.every(k, (f) => fixed.has(f))
			)
		) {
			return []
		}
		return Arr.flatMap(parent.heading, (d) =>
			d.type.carrier === "enum" &&
			Arr.every(parent.arms, (pr) =>
				Arr.some(
					pr.matches,
					(pm) =>
						readsAt(pr, pm, m.source, h.field, d, false) &&
						Arr.every(bound, ({ field, column }) => readsAt(pr, pm, m.source, field, column, false))
				)
			)
				? [{ kind: "arm" as const, field: d, handle }]
				: []
		)
	})

/**
 * What the program language proves of an attachment's children per parent, by its own rules, and the deliveries an
 * attachment may therefore state.
 *
 * Rule: an attachment states only a delivery these rules prove. grizzle's analysis must prove it too, or the decoder's
 * binding refuses it at bind (core/decoder.ts licenses), and the reference's children per parent must keep it
 * (`keeps`), or the rules are wrong. Each rule is one logical/attach.ts documents, read off the program:
 *
 * - at most one child per parent (option): the child is one rule, and either it is no aggregate and every match fixes
 *   a key of its source per parent, each field of the key bound to a parent column, a literal or a parameter; or it is
 *   an aggregate of no grouping variable and no computed key, whose one group per parent is keyed by its correlation
 *   alone;
 * - exactly one (one), the reflexive self-match: the child is an aggregate of no grouping variable over one match of a
 *   stored relation R, with no filter and no negation, every field bound to a parent column or to a variable bound
 *   nowhere else, or left out. The parent is one rule in which one match of R binds, at each field the child binds to
 *   a parent column, the head variable of that column, once in that match. The parent's own fact is then one of the
 *   child's, so the child's group is never empty;
 * - the arm of handle H over the parent column d: the child is one match of a stored relation R, with no filter and
 *   no negation, binding exactly the fields of a key K of R to parent columns, a handle field h of R outside K to
 *   the literal H, and every other field to a variable bound nowhere else, or leaving it out. In every rule of the
 *   parent one match of R binds each field of K to the head variable of the parent column the child binds it to, and h
 *   to the head variable of d. A parent row's key and d are then one fact's, so its child exists exactly when d holds
 *   H, and at most once.
 *
 * What the language proves of `child`'s children per row of `parent`.
 */
export const deliveryProof = <P extends ParentColumn>(
	parent: Parent<P>,
	child: Query<ParentColumn>
): DeliveryProof => {
	const [rule, ...more] = child.arms
	if (more.length > 0 || child.bound.kind !== "set") {
		return { atMostOne: false, exactlyOne: false, arms: [] }
	}
	const exactlyOne = reflexive(parent, rule)
	const atMostOne =
		exactlyOne ||
		groupsByNoVariable(rule) ||
		(!isAggregate(rule) && Arr.every(rule.matches, fixesKey))
	return { atMostOne, exactlyOne, arms: atMostOne ? arms(parent, rule) : [] }
}

/** The deliveries an attachment may state, the array first: every one its proof licenses. */
export const licensed = (proof: DeliveryProof): Arr.NonEmptyReadonlyArray<StatedDelivery> => [
	{ kind: "array" },
	...(proof.atMostOne ? [{ kind: "option" } as const] : []),
	...(proof.exactlyOne ? [{ kind: "one" } as const] : []),
	...proof.arms
]

/**
 * How many children a stated delivery promises a parent row of `shape` holding `values`: any number, at most one,
 * exactly one, or for an arm one exactly where the row's field holds the handle and none elsewhere.
 */
const promised = (
	delivery: StatedDelivery,
	shape: Shape,
	values: ReadonlyArray<Value>
): ((count: number) => boolean) => {
	switch (delivery.kind) {
		case "array":
			return () => true
		case "option":
			return (count) => count <= 1
		case "one":
			return (count) => count === 1
		case "arm": {
			const at = Arr.findFirstIndex(shape.columns, (c) => c.name === delivery.field.name)
			const selected = Option.exists(at, (i) => {
				const value = values[i]
				return value !== undefined && equal(value, delivery.handle, delivery.field.type)
			})
			return (count) => count === (selected ? 1 : 0)
		}
	}
}

/**
 * The first parent row, at any depth, whose children break its attachment's stated delivery, printed; none when every
 * row keeps every stated delivery. The reference's delivery must keep what the program states, or the language's
 * proof is wrong.
 */
export const brokenDelivery = (shape: Shape, rows: ReadonlyArray<Nested>): Option.Option<string> =>
	Arr.findFirst(rows, (row) =>
		Arr.findFirst(shape.attachments, (a, i): Option.Option<string> => {
			const children = row.attachments[i] ?? []
			if (!promised(a.delivery, shape, row.values)(children.length)) {
				return Option.some(
					`${a.name} states ${a.delivery.kind} and the reference delivers ${children.length} children to a parent`
				)
			}
			return Option.map(brokenDelivery(a.shape, children), (nested) => `${a.name}: ${nested}`)
		})
	)
