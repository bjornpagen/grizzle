/** What the properties of rule-aggregate.test.ts read: the shapes' box and schemas, the model, the spaces and each case's run. */

import { assert, defined } from "@bjornpagen/testing/assert"
import { boolean, element, type Gen, int, subset } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Data, Effect, Formatter, Option, Order, Record as Rec } from "effect"
import { natural, pg } from "#compiler/public/fields.ts"
import type { AnyDerived, AnySchema, Relation, Statement } from "#compiler/public/schema.ts"
import { type QueryValue, queryOver, varsOver } from "#compiler/query/build/query.ts"
import type { FinishedValue, RuleValue } from "#compiler/query/build/rule.ts"
import { Decimal } from "#compiler/scalar/values/decimal.ts"
import { derivedBuilder, relationBuilder } from "#compiler/schema/relation.ts"
import { schemaBuilder } from "#compiler/schema/schema.ts"
import {
	checkBuilder,
	containedBuilder,
	keyBuilder,
	onBuilder
} from "#compiler/schema/statements.ts"
import { rowHelpers } from "#compiler/schema/terms.ts"
import type { Law } from "#compiler/types/changeset/changeset.ts"
import type { FieldBase } from "#compiler/types/fields/field.ts"
import { changeSetOver } from "#compiler/write/changeset/value.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { writeAnswerOf, writeOnce } from "#test/support/calls.ts"
import { installMigrated, type Installed } from "#test/support/install-migrate.ts"
import {
	committedJudged,
	judgeRun,
	judgeStatementsOf,
	largeTables,
	scannedWork,
	standUpJudge
} from "#test/support/judge.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { argumentsOf } from "#test/support/list.ts"
import { opened } from "#test/support/open.ts"
import { refusedLaws } from "#test/support/refused.ts"
import { member, withServedDb } from "#test/support/served-db.ts"
import type { RawSession } from "#test/support/substrate/session.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"
import { fullWorld } from "#test/support/worlds.ts"

/**
 * A group column of the aggregate: one of an attempt's own fields, or the topic its item's Topic row joins in. A
 * learner's attempts are keyed by the child first, the unit every relation the trigger's rule reads would have to lead
 * its key with for the rule to be judged whole.
 */
const groupColumns = ["child", "item", "n", "topic"] as const
type GroupColumn = (typeof groupColumns)[number]

/** A column of the aggregate's heading, and of the derived relation the laws read: a group column, or the fold. */
type HeadColumn = GroupColumn | "folded"

const folds = ["count", "sum", "min", "max"] as const
/** The aggregate the definition folds each group's attempts by: their count, or their scores' sum, least or greatest. */
type Fold = (typeof folds)[number]

/**
 * Where ItemMode's adaptive items are negated, ItemMode keyed by the item alone, never by the child, so a rule that reads
 * it is judged by its probes: nowhere, inside the aggregate's body (an adaptive item's attempts fold into no group), or
 * in the rule that reads the aggregate (an adaptive item's groups are read as no fact), the trigger's place.
 */
type Negation = "none" | "body" | "reader"

/**
 * How the derived relation Read the laws hold over reads the aggregate: `direct`, Read is the aggregating definition
 * itself; `matched`, Read matches the aggregate, a query it imports or a derived relation a level below; `under`, Read
 * matches it joined to Cap at its first group column, under the condition that the fold is below the cap; `absent`,
 * Read is Extra's groups the aggregate holds no fact of, a negation of the aggregate (edullm's untried sessions, a
 * session no attempt counts), its heading the group columns alone.
 */
type Reading = "direct" | "matched" | "under" | "absent"

/**
 * A second rule of Read beside the one that reads the aggregate: none, Extra's facts as they stand, or Extra's facts of
 * the items ItemMode does not hold adaptive, a negation of a relation keyed by the item in a rule that reads no
 * aggregate (the trigger's cross-arm variant, edullm's untried session rule).
 */
type Union = "none" | "plain" | "negated"

/**
 * A law over Read: a key over some of its heading's columns; a check that its fold is at most a bound; a containment
 * into Read of Expect's rows at the group columns and, where `fact`, at the fold too; a containment of Read's groups in
 * Allowed.
 */
type LawSpec =
	| { readonly kind: "key"; readonly terms: Arr.NonEmptyReadonlyArray<HeadColumn> }
	| { readonly kind: "check"; readonly bound: number }
	| { readonly kind: "into"; readonly fact: boolean }
	| { readonly kind: "out" }

/**
 * One drawn schema: the aggregate's group columns (canonical order), its fold, whether its body joins Topic, where
 * ItemMode is negated, how Read reads it, whether the aggregate is a query Read imports or a derived relation a level
 * below, whether Read keeps the fold in its heading, Read's second rule, whether its stored relations are mutable, and
 * the laws. A mutable shape's writes insert, put and delete; an immutable one's insert alone.
 */
interface Shape {
	readonly groups: Arr.NonEmptyReadonlyArray<GroupColumn>
	readonly fold: Fold
	readonly join: boolean
	readonly negation: Negation
	readonly reading: Reading
	readonly aggregate: "query" | "derived"
	readonly keepsFold: boolean
	readonly union: Union
	readonly mutable: boolean
	readonly laws: Arr.NonEmptyReadonlyArray<LawSpec>
}

/** A stored value: an integer (a fold's value too, held as a number by the model) or a flag. */
type Value = number | boolean

/** A stored relation's field: an integer, a flag, or a value of the fold's type. */
type FieldKind = "int" | "bool" | "fold"

/** A stored relation of a shape, its key the first `keyed` of its fields. */
interface Stored {
	readonly name: StoredName
	readonly fields: Arr.NonEmptyReadonlyArray<{ readonly name: string; readonly kind: FieldKind }>
	readonly keyed: number
}

const storedNames = ["Attempt", "ItemMode", "Topic", "Cap", "Extra", "Expect", "Allowed"] as const
type StoredName = (typeof storedNames)[number]

const int4 = (name: string) => ({ name, kind: "int" }) as const

/** The group columns of a shape as fields of a stored relation: integers. */
const groupFields = (shape: Shape) => Arr.map(shape.groups, int4)

/** The stored relations a shape reads, each with its fields and key. */
const storedOf = (shape: Shape): Arr.NonEmptyReadonlyArray<Stored> => {
	const attempt: Stored = {
		name: "Attempt",
		fields: [int4("child"), int4("item"), int4("n"), int4("at"), int4("score")],
		keyed: 4
	}
	const lawKinds = Arr.map(shape.laws, (l) => l.kind)
	const fold = { name: "folded", kind: "fold" } as const
	const into = Arr.findFirst(shape.laws, (l) => l.kind === "into")
	const more: ReadonlyArray<Stored> = [
		...(shape.negation !== "none" || shape.union === "negated"
			? [
					{
						name: "ItemMode",
						fields: [int4("item"), { name: "adaptive", kind: "bool" }],
						keyed: 1
					} satisfies Stored
				]
			: []),
		...(shape.join
			? [{ name: "Topic", fields: [int4("item"), int4("topic")], keyed: 1 } satisfies Stored]
			: []),
		...(shape.reading === "under"
			? [
					{
						name: "Cap",
						fields: [int4(shape.groups[0]), { name: "cap", kind: "fold" }],
						keyed: 1
					} satisfies Stored
				]
			: []),
		...(shape.union === "none" && shape.reading !== "absent"
			? []
			: [
					{
						name: "Extra",
						fields: Arr.appendAll(groupFields(shape), shape.keepsFold ? [fold] : []),
						keyed: shape.groups.length
					} satisfies Stored
				]),
		...Option.match(into, {
			onNone: () => [],
			onSome: (l) => [
				{
					name: "Expect",
					fields: Arr.appendAll(groupFields(shape), l.fact ? [fold] : []),
					keyed: shape.groups.length
				} satisfies Stored
			]
		}),
		...(Arr.contains(lawKinds, "out")
			? [
					{
						name: "Allowed",
						fields: groupFields(shape),
						keyed: shape.groups.length
					} satisfies Stored
				]
			: [])
	]
	return [attempt, ...more]
}

/**
 * A fold's values as its column holds them: a count a natural (a bigint never below zero, as r.count() types it), a sum
 * of integers an exact numeric, a least or greatest score an integer.
 */
const foldDescriptor = (fold: Fold): FieldBase => {
	switch (fold) {
		case "count":
			return natural
		case "sum":
			return pg.numeric(12, 0)
		case "min":
		case "max":
			return pg.integer
	}
}

/**
 * A fold's value as a stored column of its type holds it (foldDescriptor): a count's natural and a sum's numeric of
 * scale 0 as an exact integer, a bigint, and a least or greatest score as a number.
 */
const foldHost = (fold: Fold, value: number): bigint | number => {
	switch (fold) {
		case "count":
		case "sum":
			return BigInt(value)
		case "min":
		case "max":
			return value
	}
}

/**
 * A fold's value as a literal beside Read's fold, of the aggregate's own type: a count a bigint, a sum of integers an
 * exact numeric of no typmod, a Decimal, and a least or greatest score a number.
 */
const foldLiteral = (fold: Fold, value: number): bigint | Decimal | number =>
	fold === "sum" ? Decimal.of(BigInt(value)) : foldHost(fold, value)

/** A stored relation value of a name known at run time: the widest type relation(...) gives. */
type RelationValue = Relation<
	string,
	Record<string, FieldBase>,
	readonly [string, ...Array<string>]
>

const descriptorOf = (kind: FieldKind, fold: Fold): FieldBase => {
	switch (kind) {
		case "int":
			return pg.integer
		case "bool":
			return pg.boolean
		case "fold":
			return foldDescriptor(fold)
	}
}

const relationOf = (shape: Shape, stored: Stored): RelationValue => {
	const [first, ...rest] = Arr.map(stored.fields.slice(0, stored.keyed), (f) => f.name)
	return relationBuilder(
		stored.name,
		Rec.fromEntries(
			Arr.map(stored.fields, (f) => [f.name, descriptorOf(f.kind, shape.fold)] as const)
		),
		[defined(first, "a key field"), ...rest],
		[]
	)
}

/** A variable minted by varsOver, by its field. */
const at = (vars: Readonly<Record<string, unknown>>, field: string): unknown =>
	defined(vars[field], `the variable ${field}`)

/** The schema of a shape, and its stored relations' values, under `name`: its base, the levels above, and the laws. */
interface Built {
	readonly schema: AnySchema
	readonly relations: ReadonlyMap<StoredName, RelationValue>
}

/**
 * A shape's schema under `name`: its stored relations at the root, every one open where drawn (support/open.ts
 * opened); the aggregate over
 * them, Attempt's facts (joined to Topic's at the item, the adaptive items' negated where drawn) grouped by the group
 * columns with the fold; Read reading it as drawn, beside Extra's rule; and the laws over Read on Read's level.
 */
const builtOf = (shape: Shape, name: string): Built => {
	const stored = storedOf(shape)
	const relations = new Map(Arr.map(stored, (s) => [s.name, relationOf(shape, s)] as const))
	const relation = (n: StoredName): RelationValue => defined(relations.get(n), `the relation ${n}`)
	const Attempt = relation("Attempt")
	const baseStatements: ReadonlyArray<Statement> = shape.mutable
		? opened([...relations.values()])
		: []
	const Base = schemaBuilder(name, [...relations.values()], baseStatements, [])
	/** The aggregate's one rule over `over`. */
	const folding = (r: RuleValue): FinishedValue => {
		const a = varsOver(Attempt, "attempt")
		let rule = r.match(Attempt, {
			child: at(a, "child"),
			item: at(a, "item"),
			n: at(a, "n"),
			at: at(a, "at"),
			score: at(a, "score")
		})
		const columns: Record<string, unknown> = {
			child: at(a, "child"),
			item: at(a, "item"),
			n: at(a, "n")
		}
		if (shape.join) {
			const t = varsOver(relation("Topic"), "topic")
			rule = rule.match(relation("Topic"), { item: at(a, "item"), topic: at(t, "topic") })
			columns["topic"] = at(t, "topic")
		}
		if (shape.negation === "body") {
			rule = rule.where(r.not(relation("ItemMode"), { item: at(a, "item"), adaptive: true }))
		}
		const folded = (() => {
			switch (shape.fold) {
				case "count":
					return r.count()
				case "sum":
					return r.sum(at(a, "score"))
				case "min":
					return r.min(at(a, "score"))
				case "max":
					return r.max(at(a, "score"))
			}
		})()
		return rule.find({
			...Rec.fromEntries(Arr.map(shape.groups, (g) => [g, at(columns, g)] as const)),
			folded
		})
	}
	const heading: ReadonlyArray<HeadColumn> = shape.keepsFold
		? [...shape.groups, "folded"]
		: shape.groups
	/** Read's second rule over `over`: Extra's facts, the adaptive items' negated where drawn. */
	const extraRule = (r: RuleValue): FinishedValue => {
		const Extra = relation("Extra")
		const e = varsOver(Extra, "extra")
		const bound = Rec.fromEntries(Arr.map(heading, (c) => [c, at(e, c)] as const))
		const matched = r.match(Extra, bound)
		return (
			shape.union === "negated"
				? matched.where(r.not(relation("ItemMode"), { item: at(e, "item"), adaptive: true }))
				: matched
		).find(bound)
	}
	/** Read's rule over `over` that reads the aggregate `source`. */
	const readingRule =
		(source: QueryValue | AnyDerived) =>
		(r: RuleValue): FinishedValue => {
			const g = varsOver(source, "agg")
			const folded = at(g, "folded")
			let rule = r.match(source, {
				...Rec.fromEntries(Arr.map(shape.groups, (c) => [c, at(g, c)] as const)),
				folded
			})
			const conditions: Array<unknown> = []
			if (shape.reading === "under") {
				const Cap = relation("Cap")
				const c = varsOver(Cap, "cap")
				rule = rule.match(Cap, { [shape.groups[0]]: at(g, shape.groups[0]), cap: at(c, "cap") })
				conditions.push(r.lt(folded, at(c, "cap")))
			}
			if (shape.negation === "reader") {
				conditions.push(r.not(relation("ItemMode"), { item: at(g, "item"), adaptive: true }))
			}
			return (conditions.length === 0 ? rule : rule.where(...argumentsOf(conditions))).find(
				Rec.fromEntries(Arr.map(heading, (c) => [c, at(g, c)] as const))
			)
		}
	/** Read's one rule over `over` that reads Extra's groups the aggregate `source` holds no fact of. */
	const absentRule =
		(source: QueryValue | AnyDerived) =>
		(r: RuleValue): FinishedValue => {
			const e = varsOver(relation("Extra"), "extra")
			const bound = Rec.fromEntries(Arr.map(shape.groups, (c) => [c, at(e, c)] as const))
			const absent = r.not(source, bound)
			return r
				.match(relation("Extra"), bound)
				.where(
					...argumentsOf(
						shape.negation === "reader"
							? [absent, r.not(relation("ItemMode"), { item: at(e, "item"), adaptive: true })]
							: [absent]
					)
				)
				.find(bound)
		}
	/** Read over `over`, reading the aggregate `source`, with Extra's rule beside it where drawn. */
	const readOver = (over: unknown, source: QueryValue | AnyDerived): QueryValue => {
		if (shape.reading === "absent") {
			return queryOver(over).rule(absentRule(source))
		}
		const one = queryOver(over).rule(readingRule(source))
		return shape.union === "none" ? one : one.rule(extraRule)
	}
	const lawsOver = (Read: AnyDerived): ReadonlyArray<Statement> =>
		Arr.map(shape.laws, (law): Statement => {
			switch (law.kind) {
				case "key":
					return keyBuilder(onBuilder(Read, law.terms))
				case "check":
					return checkBuilder("Bounded", Read, (row: Readonly<Record<string, unknown>>) =>
						rowHelpers.le(row["folded"], foldLiteral(shape.fold, law.bound))
					)
				case "into": {
					const terms: ReadonlyArray<HeadColumn> = law.fact
						? [...shape.groups, "folded"]
						: shape.groups
					return containedBuilder(onBuilder(relation("Expect"), terms), onBuilder(Read, terms))
				}
				case "out":
					return containedBuilder(
						onBuilder(Read, shape.groups),
						onBuilder(relation("Allowed"), shape.groups)
					)
			}
		})
	if (shape.reading === "direct") {
		const Read = derivedBuilder("Read", queryOver(Base).rule(folding), [])
		return {
			schema: schemaBuilder.extend([Base], `${name}_1`, [Read], lawsOver(Read), []),
			relations
		}
	}
	if (shape.aggregate === "query") {
		const Read = derivedBuilder("Read", readOver(Base, queryOver(Base).rule(folding)), [])
		return {
			schema: schemaBuilder.extend([Base], `${name}_1`, [Read], lawsOver(Read), []),
			relations
		}
	}
	const Agg = derivedBuilder("Agg", queryOver(Base).rule(folding), [])
	const Level = schemaBuilder.extend([Base], `${name}_1`, [Agg], [], [])
	const Read = derivedBuilder("Read", readOver(Level, Agg), [])
	return {
		schema: schemaBuilder.extend([Level], `${name}_2`, [Read], lawsOver(Read), []),
		relations
	}
}

/** A stored row, in its relation's field order. */
type Row = ReadonlyArray<Value>

/** The rows of every stored relation of a shape, each relation's by its key's text. */
type State = ReadonlyMap<StoredName, ReadonlyMap<string, Row>>

/** A row's key text: its first `keyed` values. */
const keyText = (stored: Stored, row: Row): string =>
	Arr.join(Arr.map(row.slice(0, stored.keyed), String), ",")

const storedNamed = (shape: Shape, name: StoredName): Stored =>
	defined(
		Arr.findFirst(storedOf(shape), (s) => s.name === name).pipe(Option.getOrUndefined),
		`the relation ${name}`
	)

const emptyState = (shape: Shape): State =>
	new Map(Arr.map(storedOf(shape), (s) => [s.name, new Map<string, Row>()] as const))

const rowsOf = (state: State, name: StoredName): ReadonlyArray<Row> => [
	...(state.get(name)?.values() ?? [])
]

/** One write of a ChangeSet: a row inserted at a key no row holds, a row put at its key, or a stored row deleted. */
interface Op {
	readonly kind: "insert" | "put" | "delete"
	readonly relation: StoredName
	readonly row: Row
}

/** A transaction: one ChangeSet, its ops at distinct keys. */
type Write = ReadonlyArray<Op>

/** The state a write leaves: each op's row deleted, inserted or put at its key. */
const appliedTo = (shape: Shape, state: State, write: Write): State => {
	const next = new Map(Arr.map([...state], ([n, rows]) => [n, new Map(rows)] as const))
	for (const op of write) {
		const stored = storedNamed(shape, op.relation)
		const rows = defined(next.get(op.relation), `the rows of ${op.relation}`)
		if (op.kind === "delete") {
			rows.delete(keyText(stored, op.row))
		} else {
			rows.set(keyText(stored, op.row), op.row)
		}
	}
	return next
}

/** A fact of Read: its group columns' values, in the shape's order, and its fold's. */
interface Fact {
	readonly groups: ReadonlyArray<number>
	readonly folded: number
}

const num = (v: Value | undefined): number =>
	typeof v === "number" ? v : assert.fail(`a number, not ${String(v)}`)

/** Whether ItemMode holds `item` adaptive. */
const adaptive = (state: State, item: number): boolean =>
	state.get("ItemMode")?.get(String(item))?.[1] === true

/**
 * The aggregate's facts: each attempt, its topic Topic's row of its item where it joins (an attempt of an item with no
 * Topic row in no group), an adaptive item's attempts dropped where the body negates, grouped by the group columns, its
 * group folded: counted, its scores summed, the least or the greatest.
 */
const aggregateOf = (shape: Shape, state: State): ReadonlyArray<Fact> => {
	const groups = new Map<string, { readonly groups: ReadonlyArray<number>; folded: number }>()
	for (const row of rowsOf(state, "Attempt")) {
		const [child, item, n, , score] = Arr.map(row, num)
		const topic = shape.join ? state.get("Topic")?.get(String(item))?.[1] : 0
		if (topic === undefined || (shape.negation === "body" && adaptive(state, num(item)))) {
			continue
		}
		const column = { child, item, n, topic: num(topic) }
		const values = Arr.map(shape.groups, (g) => num(column[g]))
		const text = Arr.join(Arr.map(values, String), ",")
		const s = num(score)
		const held = groups.get(text)
		if (held === undefined) {
			groups.set(text, { groups: values, folded: shape.fold === "count" ? 1 : s })
			continue
		}
		switch (shape.fold) {
			case "count":
				held.folded += 1
				break
			case "sum":
				held.folded += s
				break
			case "min":
				held.folded = Math.min(held.folded, s)
				break
			case "max":
				held.folded = Math.max(held.folded, s)
				break
		}
	}
	return [...groups.values()]
}

/** A fact's identity in Read, a set over its heading: its groups, and its fold where Read keeps it. */
const factText = (shape: Shape, f: Fact): string =>
	`${Arr.join(Arr.map(f.groups, String), ",")}${shape.keepsFold ? `|${f.folded}` : ""}`

/** A group column's value in a fact. */
const groupValue = (shape: Shape, f: Fact, g: GroupColumn): number =>
	num(f.groups[shape.groups.indexOf(g)])

/**
 * Read's facts, each once: the aggregate's facts, of the groups whose item ItemMode does not hold adaptive where Read
 * negates, each under Cap's cap of its first group column where Read reads it under one; and Extra's, of the items
 * ItemMode does not hold adaptive where its rule negates. Where Read negates the aggregate, Extra's groups it holds no
 * fact of, of the items ItemMode does not hold adaptive where Read negates them.
 */
const readOf = (shape: Shape, state: State): ReadonlyArray<Fact> => {
	if (shape.reading === "absent") {
		const held = new Set(
			Arr.map(aggregateOf(shape, state), (f) => Arr.join(Arr.map(f.groups, String), ","))
		)
		return Arr.flatMap(rowsOf(state, "Extra"), (row): ReadonlyArray<Fact> => {
			const f: Fact = { groups: Arr.map(row, num), folded: 0 }
			return held.has(Arr.join(Arr.map(f.groups, String), ",")) ||
				(shape.negation === "reader" && adaptive(state, groupValue(shape, f, "item")))
				? []
				: [f]
		})
	}
	const read = Arr.filter(aggregateOf(shape, state), (f) => {
		if (shape.negation === "reader" && adaptive(state, groupValue(shape, f, "item"))) {
			return false
		}
		if (shape.reading !== "under") {
			return true
		}
		const cap = state.get("Cap")?.get(String(f.groups[0]))?.[1]
		return cap !== undefined && f.folded < num(cap)
	})
	const extra = Arr.flatMap(rowsOf(state, "Extra"), (row): ReadonlyArray<Fact> => {
		const f: Fact = {
			groups: Arr.map(row.slice(0, shape.groups.length), num),
			folded: shape.keepsFold ? num(row[shape.groups.length]) : 0
		}
		return shape.union === "negated" && adaptive(state, groupValue(shape, f, "item")) ? [] : [f]
	})
	return Arr.dedupeWith([...read, ...extra], (a, b) => factText(shape, a) === factText(shape, b))
}

/** The values of a fact at a law's terms. */
const termsText = (shape: Shape, f: Fact, terms: ReadonlyArray<HeadColumn>): string =>
	Arr.join(
		Arr.map(terms, (t) => String(t === "folded" ? f.folded : groupValue(shape, f, t))),
		","
	)

/** Whether `law` holds over the state: each rule restated over Read's facts (readOf). */
const holds = (shape: Shape, state: State, law: LawSpec): boolean => {
	const read = readOf(shape, state)
	switch (law.kind) {
		case "key": {
			const seen = Arr.map(read, (f) => termsText(shape, f, law.terms))
			return new Set(seen).size === seen.length
		}
		case "check":
			return Arr.every(read, (f) => f.folded <= law.bound)
		case "into": {
			const terms: ReadonlyArray<HeadColumn> = law.fact ? [...shape.groups, "folded"] : shape.groups
			const held = new Set(Arr.map(read, (f) => termsText(shape, f, terms)))
			return Arr.every(rowsOf(state, "Expect"), (row) =>
				held.has(Arr.join(Arr.map(row, String), ","))
			)
		}
		case "out": {
			const allowed = state.get("Allowed")
			return Arr.every(read, (f) => allowed?.has(Arr.join(Arr.map(f.groups, String), ",")) === true)
		}
	}
}

/** The laws of a shape the state breaks, by their index among its laws. */
const brokenOf = (shape: Shape, state: State): ReadonlyArray<number> =>
	Arr.flatMap(shape.laws, (law, i) => (holds(shape, state, law) ? [] : [i]))

/** The index among a shape's laws of a law a refusal names, if it is one of them. */
const lawIndexOf = (shape: Shape, law: Law): number | undefined =>
	Arr.findFirstIndex(shape.laws, (l) => {
		switch (l.kind) {
			case "key":
				return (
					law.kind === "key" &&
					law.side.relation === "Read" &&
					Arr.join(
						Arr.map(law.side.terms, (t) => t.field),
						","
					) === Arr.join(l.terms, ",")
				)
			case "check":
				return law.kind === "check" && law.relation === "Read" && law.name === "Bounded"
			case "into":
				return (
					law.kind === "contained" && law.from.relation === "Expect" && law.to.relation === "Read"
				)
			case "out":
				return (
					law.kind === "contained" && law.from.relation === "Read" && law.to.relation === "Allowed"
				)
		}
	}).pipe(Option.getOrUndefined)

/** A stored value as a fact's field takes it, a fold's in its host type. */
const hostValue = (kind: FieldKind, fold: Fold, v: Value): unknown =>
	kind === "fold" ? foldHost(fold, num(v)) : v

/** An op's row as a fact of its relation. */
const factOf = (shape: Shape, op: Op): Readonly<Record<string, unknown>> => {
	const stored = storedNamed(shape, op.relation)
	return Rec.fromEntries(
		Arr.map(
			stored.fields,
			(f, i) => [f.name, hostValue(f.kind, shape.fold, defined(op.row[i], f.name))] as const
		)
	)
}

/**
 * A write's facts, as its ChangeSet's call takes them (changeSetOf): each operation's rows of each relation, the puts
 * and deletes a mutable shape's alone.
 */
const factsOf = (shape: Shape, write: Write) => {
	const of = (kind: Op["kind"]) =>
		Rec.fromEntries(
			Arr.map(storedOf(shape), (s) => [
				s.name,
				Arr.map(
					Arr.filter(write, (op) => op.kind === kind && op.relation === s.name),
					(op) => factOf(shape, op)
				)
			])
		)
	return shape.mutable
		? { insert: of("insert"), put: of("put"), delete: of("delete") }
		: { insert: of("insert") }
}

/**
 * The ChangeSet that inserts rows of every stored relation of the shape, and puts and deletes them where the shape is
 * mutable, from its call's facts.
 */
const changeSetOf = (shape: Shape, built: Built) =>
	Arr.reduce([...built.relations.values()], changeSetOver.empty(built.schema), (changes, r) =>
		shape.mutable ? changes.insert(r, []).put(r, []).delete(r, []) : changes.insert(r, [])
	)

/** The values a group column, an attempt's instant and its score range over. */
const small = [1, 2] as const
const scores = [0, 1, 2, 3] as const

/**
 * Whether nothing a shape reads keeps its rule off the whole judge: every relation immutable and led by the child, and
 * the groups held by it.
 */
const maybeWhole = (shape: Omit<Shape, "mutable">): boolean =>
	!shape.join &&
	shape.negation === "none" &&
	shape.union !== "negated" &&
	shape.groups[0] === "child"

/**
 * What a case aimed at a situation draws its shape with (shapeGen): ItemMode negated somewhere, a topic among the
 * groups, Read under Cap, a second rule over Extra, a fold of the scores held by a law, or a containment into the fold;
 * `free` for a plain draw.
 */
type ShapeAim = "free" | "negated" | "topic" | "under" | "extra" | "scored" | "intoFact" | "absent"

/**
 * A shape: the group columns, one to three of the attempt's (and the topic where the body joins), the fold, Read's
 * reading and second rule, the negation's place, and one or two laws of distinct kinds, `aim` forcing what an aimed
 * case needs. A shape whose rule could be unit-local is mutable, its relations open in the child's unit, so its writes
 * put and delete beside their inserts and its rule is judged whole over the children they touch (analysis/theory/
 * unit.ts wholeRule); every other shape's rule is judged by its probes, which is what the search is of. A locality
 * shape keys Read by group columns alone and bounds its fold above any group it stores, so every group it stores keeps
 * every law.
 */
const shapeGen =
	(options: { readonly locality: boolean; readonly aim: ShapeAim }): Gen<Shape> =>
	(s) => {
		const aim = options.aim
		const join = aim === "topic" || (aim !== "negated" && s.draw(boolean))
		const pool: ReadonlyArray<GroupColumn> = join ? groupColumns : ["child", "item", "n"]
		const drawn = s.draw(subset(pool, { min: 1, max: 3 }))
		const wanted: ReadonlyArray<GroupColumn> =
			aim === "topic" ? ["topic"] : aim === "negated" ? ["item"] : []
		const [first, ...rest] = Arr.filter(
			groupColumns,
			(g) => Arr.contains(drawn, g) || Arr.contains(wanted, g)
		)
		const groups: Arr.NonEmptyReadonlyArray<GroupColumn> = [first ?? "child", ...rest]
		const hasItem = Arr.contains(groups, "item")
		const reading =
			aim === "under" || aim === "absent"
				? aim
				: aim === "extra"
					? s.draw(element(["matched", "under"] as const))
					: aim === "negated"
						? s.draw(element(["direct", "matched"] as const))
						: aim === "scored" || aim === "intoFact"
							? s.draw(element(["direct", "matched", "under"] as const))
							: s.draw(element(["direct", "matched", "under", "absent"] as const))
		const direct = reading === "direct"
		const drawnNegation =
			aim === "negated"
				? s.draw(element(["body", "reader"] as const))
				: s.draw(element(["none", "body", "reader"] as const))
		const negation: Negation =
			drawnNegation === "reader" && (direct || !hasItem) ? "body" : drawnNegation
		const drawnUnion =
			direct || reading === "absent"
				? "none"
				: aim === "extra"
					? s.draw(element(["plain", "negated"] as const))
					: s.draw(element(["none", "plain", "negated"] as const))
		const union: Union = drawnUnion === "negated" && !hasItem ? "plain" : drawnUnion
		const keepsFold =
			reading !== "absent" && (direct || aim === "scored" || aim === "intoFact" || s.draw(boolean))
		const heading: Arr.NonEmptyReadonlyArray<HeadColumn> = keepsFold
			? [...groups, "folded"]
			: groups
		const lawGen = (kind: LawSpec["kind"]): LawSpec => {
			switch (kind) {
				case "key": {
					const terms = s.draw(subset(heading, { min: 1, max: Math.max(1, heading.length - 1) }))
					const [t, ...ts] = options.locality ? Arr.filter(terms, (c) => c !== "folded") : terms
					return { kind: "key", terms: [t ?? groups[0], ...ts] }
				}
				case "check":
					return { kind: "check", bound: options.locality ? 9 : s.draw(int(1, 3)) }
				case "into":
					return {
						kind: "into",
						fact: keepsFold && (aim === "intoFact" || aim === "scored" || s.draw(boolean))
					}
				case "out":
					return { kind: "out" }
			}
		}
		const kinds: ReadonlyArray<LawSpec["kind"]> = keepsFold
			? ["key", "check", "into", "out"]
			: ["key", "into", "out"]
		const [k, ...ks] = s.draw(subset(kinds, { min: 1, max: 2 }))
		const forced: ReadonlyArray<LawSpec["kind"]> =
			aim === "intoFact"
				? ["into"]
				: aim === "scored"
					? [s.draw(element(["check", "into"] as const))]
					: aim === "absent"
						? ["out"]
						: []
		const [l, ...ls] = Arr.dedupe([...forced, k ?? "key", ...ks]).slice(0, 2)
		const partial = {
			groups,
			fold:
				aim === "scored" ? s.draw(element(["sum", "min", "max"] as const)) : s.draw(element(folds)),
			join,
			negation,
			reading,
			aggregate: direct ? "query" : s.draw(element(["query", "derived"] as const)),
			keepsFold,
			union,
			laws: [lawGen(l ?? "key"), ...Arr.map(ls, lawGen)]
		} satisfies Omit<Shape, "mutable">
		return { ...partial, mutable: maybeWhole(partial) || s.draw(boolean) }
	}

/** A row of `stored` with each value drawn: an integer from its column's range, a flag, a fold's value from 0 to 4. */
const rowGen =
	(stored: Stored): Gen<Row> =>
	(s) =>
		Arr.map(stored.fields, (f): Value => {
			switch (f.kind) {
				case "bool":
					return s.draw(boolean)
				case "fold":
					return s.draw(int(0, 4))
				case "int":
					return f.name === "score" ? s.draw(element(scores)) : s.draw(element(small))
			}
		})

/**
 * What a write's ops are drawn over: any relation the shape reads, Attempt more often; one relation alone; deletes of
 * stored rows alone; or puts of stored attempts' scores alone.
 */
type Focus =
	| { readonly kind: "any" }
	| { readonly kind: "relation"; readonly relation: StoredName }
	| { readonly kind: "deletes" }
	| { readonly kind: "scores" }

/**
 * One op of a write over `state`, as `focus` allows: a relation, and on it an insert at a key no row holds, a put at
 * any key, or a delete of a stored row (a put of a stored attempt's score, under `scores`), an immutable shape's an
 * insert alone; none where its key is one the write already writes, or one an immutable shape's relation holds.
 */
const opGen =
	(shape: Shape, state: State, used: ReadonlySet<string>, focus: Focus): Gen<Option.Option<Op>> =>
	(s) => {
		const stored = storedOf(shape)
		const relation = (() => {
			switch (focus.kind) {
				case "any":
					return s.draw(element([stored[0], ...Arr.replicate(stored[0], 3), ...stored]))
				case "relation":
					return storedNamed(shape, focus.relation)
				case "deletes": {
					const holding = Arr.filter(stored, (r) => rowsOf(state, r.name).length > 0)
					return s.draw(element([holding[0] ?? stored[0], ...holding]))
				}
				case "scores":
					return stored[0]
			}
		})()
		const rows = rowsOf(state, relation.name)
		const kind = !shape.mutable
			? "insert"
			: focus.kind === "deletes"
				? "delete"
				: focus.kind === "scores"
					? "put"
					: s.draw(element(["insert", "put", "delete"] as const))
		const row: Row = (() => {
			const [held, ...more] = rows
			if (held === undefined || (kind !== "delete" && focus.kind !== "scores")) {
				return s.draw(rowGen(relation))
			}
			const picked = s.draw(element([held, ...more]))
			return focus.kind === "scores"
				? [...picked.slice(0, 4), (num(picked[4]) + s.draw(int(1, 3))) % scores.length]
				: picked
		})()
		const text = `${relation.name}:${keyText(relation, row)}`
		if (used.has(text)) {
			return Option.none()
		}
		const present = state.get(relation.name)?.has(keyText(relation, row)) === true
		if (present && !shape.mutable) {
			return Option.none()
		}
		return Option.some({
			kind:
				kind === "delete"
					? present
						? "delete"
						: "insert"
					: kind === "insert" && present
						? "put"
						: kind,
			relation: relation.name,
			row
		})
	}

/**
 * The ops that keep a write's state lawful where the write's other ops left it: Allowed rows for every group Read
 * holds that Allowed does not, and, in a mutable shape, each Expect row put at the fold Read holds for its groups, or
 * deleted where Read holds none, where the shape states those laws; each at a key the write does not already write.
 */
const coherentOps = (shape: Shape, after: State, used: ReadonlySet<string>): Write => {
	const read = readOf(shape, after)
	const allowed = after.get("Allowed")
	const expect = after.get("Expect")
	const out: Array<Op> = []
	for (const law of shape.laws) {
		if (law.kind === "out" && allowed !== undefined) {
			for (const f of read) {
				const key = Arr.join(Arr.map(f.groups, String), ",")
				if (!allowed.has(key) && !used.has(`Allowed:${key}`)) {
					out.push({ kind: "insert", relation: "Allowed", row: f.groups })
				}
			}
		}
		if (law.kind === "into" && expect !== undefined && shape.mutable) {
			for (const [key, row] of expect) {
				if (used.has(`Expect:${key}`)) {
					continue
				}
				const f = Arr.findFirst(read, (x) => Arr.join(Arr.map(x.groups, String), ",") === key)
				out.push(
					Option.isSome(f)
						? {
								kind: "put",
								relation: "Expect",
								row: law.fact ? [...f.value.groups, f.value.folded] : f.value.groups
							}
						: { kind: "delete", relation: "Expect", row }
				)
			}
		}
	}
	return Arr.dedupeWith(
		out,
		(a, b) =>
			a.relation === b.relation &&
			Arr.join(Arr.map(a.row, String), ",") === Arr.join(Arr.map(b.row, String), ",")
	)
}

/**
 * One to three ops at distinct keys as `focus` allows, and, where `coherent` draws so, the ops that keep the state
 * lawful (coherentOps).
 */
const writeGen =
	(shape: Shape, state: State, focus: Focus, coherent: "drawn" | "never" | "always"): Gen<Write> =>
	(s) => {
		const count = s.draw(int(1, 3))
		const ops: Array<Op> = []
		const used = new Set<string>()
		for (let i = 0; i < count; i += 1) {
			const op = s.draw(opGen(shape, state, used, focus))
			if (Option.isSome(op)) {
				ops.push(op.value)
				used.add(
					`${op.value.relation}:${keyText(storedNamed(shape, op.value.relation), op.value.row)}`
				)
			}
		}
		const kept = coherent === "always" || (coherent === "drawn" && s.draw(boolean))
		return [...ops, ...(kept ? coherentOps(shape, appliedTo(shape, state, ops), used) : [])]
	}

/** A case: a shape and its history of writes, each drawn over the state the model says the writes before it left. */
interface AggregateCase {
	readonly shape: Shape
	readonly writes: ReadonlyArray<Write>
}

/** The state a history leaves: each write's where the model accepts it. */
const committedBy = (shape: Shape, state: State, write: Write): State => {
	const after = appliedTo(shape, state, write)
	return brokenOf(shape, after).length === 0 ? after : state
}

/**
 * The rows a history opens on, where drawn: each item's Topic row, at a topic drawn for it, and a Cap row for each value
 * of Read's first group column, at a cap drawn for it, so the aggregate's attempts join and Read reads their groups. An
 * opening's row at the same key is written in its place.
 */
const scaffoldGen =
	(shape: Shape): Gen<Write> =>
	(s) =>
		s.draw(boolean)
			? Arr.flatMap(storedOf(shape), (stored): Write => {
					switch (stored.name) {
						case "Topic":
							return Arr.map(small, (item): Op => ({
								kind: "insert",
								relation: "Topic",
								row: [item, s.draw(element(small))]
							}))
						case "Cap":
							return Arr.map(small, (value): Op => ({
								kind: "insert",
								relation: "Cap",
								row: [value, s.draw(int(1, 4))]
							}))
						case "Attempt":
						case "ItemMode":
						case "Extra":
						case "Expect":
						case "Allowed":
							return []
					}
				})
			: []

/**
 * A history over a shape, each write drawn over the state the writes before it committed: the scaffold (scaffoldGen)
 * and `opening` as one write where either holds a row, `settle` writes of any ops, kept lawful as `coherent` says,
 * and then `focused` writes of `focus`'s ops, never kept lawful.
 */
const historyGen =
	(
		shape: Shape,
		opening: Write,
		settle: { readonly min: number; readonly max: number },
		coherent: "drawn" | "always",
		focus: Focus,
		focused: number
	): Gen<ReadonlyArray<Write>> =>
	(s) => {
		const opened = new Set(
			Arr.map(opening, (op) => `${op.relation}:${keyText(storedNamed(shape, op.relation), op.row)}`)
		)
		const first = [
			...Arr.filter(
				s.draw(scaffoldGen(shape)),
				(op) => !opened.has(`${op.relation}:${keyText(storedNamed(shape, op.relation), op.row)}`)
			),
			...opening
		]
		const writes: Array<Write> = first.length === 0 ? [] : [first]
		let state = committedBy(shape, emptyState(shape), first)
		const count = s.draw(int(settle.min, settle.max))
		for (let i = 0; i < count; i += 1) {
			const write = s.draw(writeGen(shape, state, { kind: "any" }, coherent))
			writes.push(write)
			state = committedBy(shape, state, write)
		}
		for (let i = 0; i < focused; i += 1) {
			const write = s.draw(writeGen(shape, state, focus, "never"))
			writes.push(write)
			state = committedBy(shape, state, write)
		}
		return writes
	}

/** A drawn case: a free shape, and one to ten writes of any ops, each kept lawful or not as drawn. */
export const caseGen: Gen<AggregateCase> = (s) => {
	const shape = s.draw(shapeGen({ locality: false, aim: "free" }))
	return {
		shape,
		writes: s.draw(historyGen(shape, [], { min: 1, max: 10 }, "drawn", { kind: "any" }, 0))
	}
}

/**
 * A case aimed at a situation: a mutable shape drawn with what it needs, so its writes put and delete, `opening`
 * written first, two to six writes kept lawful, so its relations hold rows a law reads, and then one to three writes
 * of the ops that reach it alone.
 */
const aimedCase =
	(aim: ShapeAim, focus: Focus, opening: (shape: Shape) => Write): Gen<AggregateCase> =>
	(s) => {
		const shape = { ...s.draw(shapeGen({ locality: false, aim })), mutable: true }
		return {
			shape,
			writes: s.draw(
				historyGen(shape, opening(shape), { min: 2, max: 6 }, "always", focus, s.draw(int(1, 3)))
			)
		}
	}

/** No opening write. */
const none = (): Write => []

/**
 * The group of every column 1 stated by Extra and counted by one attempt (its item's Topic row where the body joins),
 * so Read, which reads Extra's groups the aggregate holds no fact of, holds it again once the attempt goes.
 */
const countedExtra = (shape: Shape): Write => [
	{ kind: "insert", relation: "Extra", row: Arr.map(shape.groups, () => 1) },
	{ kind: "insert", relation: "Attempt", row: [1, 1, 1, 1, 0] },
	...(shape.join ? [{ kind: "insert", relation: "Topic", row: [1, 1] } satisfies Op] : [])
]

/**
 * The situations a drawn case reaches seldom, each with the space of cases constructed to reach it. A write of ItemMode
 * alone opens on item 1 made adaptive, so the writes kept lawful after it store attempts of an item ItemMode blocks,
 * which a later write of ItemMode alone brings back; one of Attempt alone under a negated aggregate opens on a group
 * Extra states and an attempt counts (countedExtra).
 */
export const aims: ReadonlyArray<readonly [Feature, Gen<AggregateCase>]> = [
	[
		"a containment into the aggregate refused by a fold its write changed",
		aimedCase("intoFact", { kind: "relation", relation: "Attempt" }, none)
	],
	["a write of deletes alone refused", aimedCase("free", { kind: "deletes" }, none)],
	["a put of a score alone refused", aimedCase("scored", { kind: "scores" }, none)],
	[
		"a write of ItemMode alone refused",
		aimedCase("negated", { kind: "relation", relation: "ItemMode" }, () => [
			{ kind: "insert", relation: "ItemMode", row: [1, true] }
		])
	],
	[
		"a write of Topic alone refused",
		aimedCase("topic", { kind: "relation", relation: "Topic" }, none)
	],
	["a write of Cap alone refused", aimedCase("under", { kind: "relation", relation: "Cap" }, none)],
	[
		"a write of Extra alone refused",
		aimedCase("extra", { kind: "relation", relation: "Extra" }, none)
	],
	[
		"a write of Attempt alone refused through the aggregate's negation",
		aimedCase("absent", { kind: "relation", relation: "Attempt" }, countedExtra)
	]
]

/**
 * edullm's minimal trigger (AGGRULE-BISECT, out/aggrule-bisect/minimal/grizzle.config.ts, 2026-11-21): Attempt(child,
 * item, n, at) keyed by all four, ItemMode(item, adaptive) keyed by the item alone, `counts` Attempt grouped by (child,
 * item, n) with its count, DirectOpen its groups whose item ItemMode does not hold adaptive, keyed by (child, item). Its
 * history: two sessions of one item tried, which DirectOpen holds both of, refused; the item made adaptive, then both
 * tried, accepted; and the item made direct again, which brings both sessions back through ItemMode alone, refused.
 * Mutable, as its put and delete of ItemMode need.
 */
const trigger: AggregateCase = {
	shape: {
		groups: ["child", "item", "n"],
		fold: "count",
		join: false,
		negation: "reader",
		reading: "matched",
		aggregate: "query",
		keepsFold: false,
		union: "none",
		mutable: true,
		laws: [{ kind: "key", terms: ["child", "item"] }]
	},
	writes: [
		[
			{ kind: "insert", relation: "Attempt", row: [1, 1, 1, 1, 0] },
			{ kind: "insert", relation: "Attempt", row: [1, 1, 2, 1, 0] }
		],
		[{ kind: "insert", relation: "ItemMode", row: [1, true] }],
		[
			{ kind: "insert", relation: "Attempt", row: [1, 1, 1, 1, 0] },
			{ kind: "insert", relation: "Attempt", row: [1, 1, 2, 1, 0] }
		],
		[{ kind: "put", relation: "ItemMode", row: [1, false] }],
		[{ kind: "delete", relation: "ItemMode", row: [1, true] }]
	]
}

/**
 * The trigger's cross-arm variant: ItemMode negated only in the rule of Read that reads no aggregate, Extra's sessions,
 * beside the rule that reads the counted sessions, keyed by (child, item). An untried session of an adaptive item and
 * a tried session of the item stand together; the item made direct again brings the untried one back through ItemMode
 * alone, refused.
 */
const crossArm: AggregateCase = {
	shape: { ...trigger.shape, negation: "none", union: "negated" },
	writes: [
		[
			{ kind: "insert", relation: "ItemMode", row: [1, true] },
			{ kind: "insert", relation: "Extra", row: [1, 1, 1] }
		],
		[{ kind: "insert", relation: "Attempt", row: [1, 1, 2, 1, 0] }],
		[{ kind: "delete", relation: "ItemMode", row: [1, true] }],
		[{ kind: "put", relation: "ItemMode", row: [1, false] }]
	]
}

/** The kept cases, replayed by value (gen.ts recorded): the trigger, and its cross-arm variant. */
export const keptCases: Arr.NonEmptyReadonlyArray<AggregateCase> = [trigger, crossArm]

export type Feature =
	| "accepted"
	| "refused by a key"
	| "refused by a check"
	| "refused by a containment into the aggregate"
	| "refused by a containment out of the aggregate"
	| "a containment into the aggregate refused by a fold its write changed"
	| "a write of deletes alone refused"
	| "a put of a score alone refused"
	| "a write of ItemMode alone refused"
	| "a write of Topic alone refused"
	| "a write of Cap alone refused"
	| "a write of Extra alone refused"
	| "a write of Attempt alone refused through the aggregate's negation"

const refusedFeature = {
	key: "refused by a key",
	check: "refused by a check",
	into: "refused by a containment into the aggregate",
	out: "refused by a containment out of the aggregate"
} as const satisfies Record<LawSpec["kind"], Feature>

/** What else a refused write reached: the situations a write of one kind of op, or of one relation, alone reaches. */
const refusedSituations = (
	shape: Shape,
	before: State,
	after: State,
	write: Write,
	broken: ReadonlyArray<number>
): ReadonlyArray<Feature> => {
	const only = (relation: StoredName) => Arr.every(write, (op) => op.relation === relation)
	const into = Arr.some(broken, (i) => shape.laws[i]?.kind === "into")
	const beforeFolds = new Map(
		Arr.map(
			readOf(shape, before),
			(f) => [Arr.join(Arr.map(f.groups, String), ","), f.folded] as const
		)
	)
	const changed =
		into &&
		Arr.some(aggregateOf(shape, after), (f) => {
			const was = beforeFolds.get(Arr.join(Arr.map(f.groups, String), ","))
			return was !== undefined && was !== f.folded
		})
	const scored =
		only("Attempt") &&
		Arr.every(write, (op) => {
			const stored = before.get("Attempt")?.get(keyText(storedNamed(shape, "Attempt"), op.row))
			return op.kind === "put" && stored !== undefined && stored[4] !== op.row[4]
		})
	return [
		...(changed
			? ["a containment into the aggregate refused by a fold its write changed" as const]
			: []),
		...(Arr.every(write, (op) => op.kind === "delete")
			? ["a write of deletes alone refused" as const]
			: []),
		...(scored ? ["a put of a score alone refused" as const] : []),
		...(only("ItemMode") ? ["a write of ItemMode alone refused" as const] : []),
		...(only("Topic") ? ["a write of Topic alone refused" as const] : []),
		...(only("Cap") ? ["a write of Cap alone refused" as const] : []),
		...(only("Extra") ? ["a write of Extra alone refused" as const] : []),
		...(only("Attempt") && shape.reading === "absent"
			? ["a write of Attempt alone refused through the aggregate's negation" as const]
			: [])
	]
}

class Disagreed extends Data.TaggedError("Disagreed")<{ readonly message: string }> {}

/** The name every case declares its schema under. */
const declaredName = "RuleAggregate"

/** The rows each stored relation of the shape holds, as their columns' texts, by key text: what a direct reader reads back. */
const storedRows = (shape: Shape, installed: Installed, session: RawSession, built: Built) =>
	Effect.forEach(storedOf(shape), (stored) =>
		Effect.gen(function* () {
			const names = namesOf(installed)
			const value = defined(built.relations.get(stored.name), stored.name)
			const columns = Arr.map(stored.fields, (f) => `${names.column(value, f.name)}::text`)
			const rows = yield* session.values(
				`SELECT ${Arr.join(columns, ", ")} FROM ${names.table(value)}`,
				[]
			)
			return [
				stored.name,
				Arr.sort(
					Arr.map(rows, (r) => Arr.join(Arr.map(r, String), ",")),
					Order.String
				)
			] as const
		})
	)

/** The model's rows of each stored relation, as storedRows reads them. */
const modelRows = (shape: Shape, state: State) =>
	Arr.map(
		storedOf(shape),
		(stored) =>
			[
				stored.name,
				Arr.sort(
					Arr.map(rowsOf(state, stored.name), (r) => Arr.join(Arr.map(r, String), ",")),
					Order.String
				)
			] as const
	)

/**
 * One case: the shape installed through its first migration, then each write applied through grizzle's served write as
 * the full world's login. A write is accepted exactly when the state it leaves keeps every law in the model, the
 * stored state then the model's; and refused `invariant-rejected` naming only laws the model finds broken, its witness
 * unreported, the stored state as before. After the history, every stored relation holds the model's rows.
 */
export const runHistory = (c: AggregateCase, note: Case<Feature>["note"]) =>
	Effect.gen(function* () {
		const shape = c.shape
		const declared = builtOf(shape, declaredName)
		const done = yield* installMigrated(declared.schema, {
			ambient: ordinarySession,
			extensions: [],
			label: "rule_aggregate",
			logins: [fullWorld(declared.schema, {}).server]
		})
		const built = builtOf(shape, done.schema)
		const world = fullWorld(built.schema, {})
		const state = yield* withServedDb(done, world.server.roles.app, {}, ({ serve }) =>
			Effect.gen(function* () {
				const calls = yield* serve({ write: changeSetOf(shape, built) })
				const apply = writeOnce(member(calls, "write"))
				let state = emptyState(shape)
				for (const [i, write] of c.writes.entries()) {
					const after = appliedTo(shape, state, write)
					const broken = brokenOf(shape, after)
					const outcome = yield* writeAnswerOf(apply({ params: {}, facts: factsOf(shape, write) }))
					const where = `write ${i} ${Formatter.format(write)} of ${Formatter.format(c)}`
					if (outcome.kind === "accepted" || outcome.kind === "unchanged") {
						if (broken.length > 0) {
							return yield* new Disagreed({
								message: `accepted a state breaking ${Formatter.format(Arr.map(broken, (b) => shape.laws[b]))}: ${where}`
							})
						}
						note("accepted")
						state = after
						continue
					}
					const named =
						outcome.kind === "refused"
							? Arr.map(refusedLaws(outcome.refused), (law) => lawIndexOf(shape, law))
							: []
					const broke = (n: number | undefined): n is number =>
						n !== undefined && broken.includes(n)
					if (
						outcome.kind !== "refused" ||
						outcome.witness.kind !== "unreported" ||
						!(outcome.refused.kind === "some"
							? Arr.some(named, broke)
							: Arr.isReadonlyArrayNonEmpty(named) && Arr.every(named, broke))
					) {
						return yield* new Disagreed({
							message: `answered ${Formatter.format(outcome)} where the state breaks ${Formatter.format(Arr.map(broken, (b) => shape.laws[b])) || "nothing"}: ${where}`
						})
					}
					for (const n of Arr.filter(named, broke)) {
						note(refusedFeature[defined(shape.laws[n], "a named law").kind])
					}
					for (const feature of refusedSituations(shape, state, after, write, broken)) {
						note(feature)
					}
				}
				return state
			})
		)
		const substrate = yield* Substrate
		const session = yield* substrate.session({ ...ownerSession(), label: "rule aggregate" })
		const stored = yield* storedRows(shape, done, session, built)
		assert.deepEqual(
			stored,
			modelRows(shape, state),
			`every stored relation holds the model's rows after ${Formatter.format(c)}`
		)
	})

/**
 * A locality case: a shape, the untouched groups stored when first measured, and the groups stored beside them before
 * the second measurement.
 */
interface LocalityCase {
	readonly shape: Shape
	readonly before: number
	readonly more: number
}

export const localityGen: Gen<LocalityCase> = (s) => ({
	shape: s.draw(shapeGen({ locality: true, aim: "free" })),
	before: s.draw(int(200, 400)),
	more: s.draw(int(600, 900))
})

/**
 * The kept locality case (gen.ts recorded): a count grouped by n and the topic Topic joins in, read directly under a
 * check, beside 200 groups and then 800, where PostgreSQL ordered the fold's join of Attempt and Topic one way at the
 * first count and the other at the second (14 rows, then 15: LOCALITY's and AGGRULE's runs at 95abc7176 with the
 * probes picked through their readers), while its body was read as written.
 */
export const keptLocality: Arr.NonEmptyReadonlyArray<LocalityCase> = [
	{
		shape: {
			groups: ["n", "topic"],
			fold: "count",
			join: true,
			negation: "none",
			reading: "direct",
			aggregate: "query",
			keepsFold: true,
			union: "none",
			laws: [{ kind: "check", bound: 9 }],
			mutable: false
		},
		before: 200,
		more: 600
	}
]

/** A cap no group reaches. */
const unreached = 1000

/**
 * The statements that store untouched groups `from` to `to`, each an attempt of its own whose every column is
 * 100 + its number, so it is a group of its own under any grouping, with its item's Topic row, its item's ItemMode row
 * (not adaptive), its Cap row and its Allowed row where the shape reads them.
 */
const untouchedSql = (
	shape: Shape,
	installed: Installed,
	built: Built,
	from: number,
	to: number
): ReadonlyArray<string> => {
	const names = namesOf(installed)
	const series = `FROM generate_series(${from}, ${to}) AS g(i)`
	const insert = (name: StoredName, values: (field: string) => string) => {
		const value = built.relations.get(name)
		const stored = Arr.findFirst(storedOf(shape), (s) => s.name === name)
		if (value === undefined || Option.isNone(stored)) {
			return []
		}
		const fields = stored.value.fields
		return [
			`INSERT INTO ${names.table(value)} (${Arr.join(
				Arr.map(fields, (f) => names.column(value, f.name)),
				", "
			)}) SELECT ${Arr.join(
				Arr.map(fields, (f) => values(f.name)),
				", "
			)} ${series}`
		]
	}
	return [
		...insert("Attempt", (f) => (f === "at" ? "1" : f === "score" ? "0" : "100 + i")),
		...insert("Topic", () => "100 + i"),
		...insert("ItemMode", (f) => (f === "adaptive" ? "false" : "100 + i")),
		...insert("Cap", (f) => (f === "cap" ? `${unreached}` : "100 + i")),
		...insert("Allowed", () => "100 + i")
	]
}

/** The touched group's rows: its first attempt, its item's Topic, ItemMode and Cap rows and its Allowed row where read. */
const touchedBase = (shape: Shape): Write =>
	Arr.flatMap(storedOf(shape), (s): Write => {
		switch (s.name) {
			case "Attempt":
				return [{ kind: "insert", relation: "Attempt", row: [1, 1, 1, 1, 0] }]
			case "Topic":
				return [{ kind: "insert", relation: "Topic", row: [1, 1] }]
			case "ItemMode":
				return [{ kind: "insert", relation: "ItemMode", row: [1, false] }]
			case "Cap":
				return [{ kind: "insert", relation: "Cap", row: [1, unreached] }]
			case "Allowed":
				return [{ kind: "insert", relation: "Allowed", row: Arr.map(shape.groups, () => 1) }]
			case "Extra":
			case "Expect":
				return []
		}
	})

/** An op's INSERT, by direct SQL as the owner. */
const insertSql = (shape: Shape, installed: Installed, built: Built, op: Op): string => {
	const names = namesOf(installed)
	const value = defined(built.relations.get(op.relation), op.relation)
	const stored = storedNamed(shape, op.relation)
	return `INSERT INTO ${names.table(value)} (${Arr.join(
		Arr.map(stored.fields, (f) => names.column(value, f.name)),
		", "
	)}) VALUES (${Arr.join(Arr.map(op.row, String), ", ")})`
}

/** The touch: a second attempt of the touched group, which changes its fold, the group's fact lost and another gained. */
const touch: Op = { kind: "insert", relation: "Attempt", row: [1, 1, 1, 2, 0] }

/**
 * The work of each statement the judge runs over the touch (`scannedWork`), explained on `session` while the deltas hold
 * the touch's rows, before the judge reads them, in a transaction rolled back (test/support/judge.ts judgeRun): each
 * statement of the judge, a stored relation's upkeep's or a rule's, over a delta holding a row, Attempt's side of news,
 * which the touch writes, or one an upkeep's write filled, a stored aggregate's, in the judge's order, each upkeep's
 * DELETE and INSERT run as phase A runs them, before the rules over what they wrote.
 */
const touchedWork = (shape: Shape, installed: Installed, built: Built, session: RawSession) =>
	Effect.gen(function* () {
		yield* session.begin
		const work = yield* Effect.onError(
			Effect.gen(function* () {
				for (const setting of largeTables) {
					yield* session.query(setting, [])
				}
				yield* session.query(insertSql(shape, installed, built, touch), [])
				const plans = yield* judgeRun(
					(sql) => session.values(sql, []),
					installed.installation,
					judgeStatementsOf(installed.installation)
				)
				return Arr.map(plans, (p) => scannedWork(p.plan))
			}),
			() => Effect.ignore(session.rollback)
		)
		yield* session.rollback
		return work
	})

/**
 * One locality case: the shape installed, the touched group's first attempt stored beside `before` untouched groups,
 * and the touch's work measured; `more` untouched groups stored beside them, and the touch's work measured again. Every
 * judged statement's work is the same both times: a stored relation's upkeep at the touched group's unit, and a probe
 * of the groups a write touched, read those groups alone, however many groups stand beside them, each in a learner's
 * unit of its own.
 */
export const runLocality = (d: LocalityCase, note: Case<"measured">["note"]) =>
	Effect.gen(function* () {
		const shape = d.shape
		const declared = builtOf(shape, declaredName)
		const done = yield* installMigrated(declared.schema, {
			ambient: ordinarySession,
			extensions: [],
			label: "rule_aggregate_locality",
			logins: []
		})
		const built = builtOf(shape, done.schema)
		const substrate = yield* Substrate
		const session = yield* substrate.session({
			...ownerSession(),
			label: "rule aggregate locality"
		})
		yield* standUpJudge(session, done.installation)
		yield* committedJudged(session, [
			...Arr.map(touchedBase(shape), (op) => insertSql(shape, done, built, op)),
			...untouchedSql(shape, done, built, 0, d.before - 1)
		])
		const few = yield* touchedWork(shape, done, built, session)
		yield* committedJudged(
			session,
			untouchedSql(shape, done, built, d.before, d.before + d.more - 1)
		)
		const many = yield* touchedWork(shape, done, built, session)
		assert.ok(
			Arr.some(few, (w) => w > 0),
			`${Formatter.format(d)}: some judged statement reads the touched group`
		)
		assert.deepEqual(
			many,
			few,
			`${Formatter.format(d)}: each judged statement reads the same rows beside ${d.before} untouched groups and beside ${d.before + d.more}`
		)
		note("measured")
	})
