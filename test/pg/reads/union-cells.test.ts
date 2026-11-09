import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import {
	array,
	boolean,
	constant,
	element,
	filter,
	type Gen,
	map,
	oneOf,
	shuffled,
	weighted
} from "@grizzle/testing/gen"
import { type Equivalence, set, structuralHash } from "@grizzle/testing/oracle"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Order, Record as Rec, Result } from "effect"
import type { CompiledOps } from "#adapter/db/ops.ts"
import { OpenError } from "#adapter/errors/execution.ts"
import { isCompileError } from "#compiler/core/errors.ts"
import { isRecord } from "#compiler/core/record.ts"
import { codeOf } from "#compiler/ir/codes.ts"
import { closedId, pg } from "#compiler/public/fields.ts"
import { closed, relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { type QueryValue, queryOver, varsOver } from "#compiler/query/build/query.ts"
import type { FinishedValue, RuleValue } from "#compiler/query/build/rule.ts"
import { installed } from "#test/pg/reads/support.ts"
import { assert, defined } from "#test/support/assert.ts"
import { namesOf, parsedName } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { member, withServedDb } from "#test/support/served-db.ts"
import { installationGroup, replaceRows } from "#test/support/substrate/replace.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * Union cells on PostgreSQL 19: a union's rows decode to exactly the records its arms decode to, each read alone.
 *
 * Property: for a drawn union of plain arms over one relation, in one heading group or two (told apart by a tag
 * literal), every arm delivering each key of its heading as a head literal or as the relation's field, the records
 * its member's execute delivers for the union are the set union of the records it delivers for each arm run as a query
 * of its own: the union holds each record once, however many arms deliver it, and each arm alone holds each of its records
 * once, so a delivery that repeats a record fails. The oracle is that decoding: an arm alone is one heading group of one
 * arm, whose cells no other arm shares, so it reads each literal as itself and each field by its type; the union must
 * read every cell as the arm that wrote it would. Records compare by their keys, and each value by its host kind and
 * value (an int4 has no -0: the literal -0 is PostgreSQL's 0, and equal to it).
 *
 * A column's cells are drawn from one dictionary per kind (int4, int8,
 * bool, a refined text, a closed handle), shared by literals and facts, so a field's cell spells some arm's literal or
 * none: the extremes, 0 and -0, "t" and "true", "1.00" and "-0" as texts, composed and decomposed é. Arms are drawn in
 * any order, so two literal arms of a column meet before a field arm, after it and between, and two heading groups
 * meet.
 *
 * Two planted shapes, drawn one case in ten: a head literal 1 against a numeric field
 * and against a float field in one heading group. The checker gives a group's column one type in every arm, and a bare
 * head literal takes the type the group's field arm delivers its column at when it is a value of it (check/checker.ts
 * #positionedTypes): 1 is a float, so against the float field the union decodes to the records its arms decode to
 * alone, the literal's cell read as a float beside the field's -0 and 1.5; a JavaScript number is never a numeric, so
 * against the numeric field the literal keeps its integer type and the union is refused where its workload member is
 * compiled (MalformedDescription), before any SQL: a numeric "1.00" never meets a literal's cell. Every union and arm is
 * a member of the login's workload, served for its case.
 */
const handles = ["A", "B", "C"] as const
type Handle = (typeof handles)[number]
const Kind = closed("Kind", handles)
const Text = str.regex("^.{0,4}$", "su")
const Cell = relation(
	"Cell",
	{
		id: pg.integer,
		n: pg.integer,
		b: pg.bigint,
		t: pg.boolean,
		s: Text,
		h: closedId(Kind),
		x: pg.numeric(10, 2),
		f: pg.float8
	},
	["id"]
)
const Cells = schema("Cells", { Kind, Cell }, [])

/** The kinds a head literal can be, each with the field of Cell that holds it. */
const kinds = ["int4", "int8", "bool", "text", "handle"] as const
type CellKind = (typeof kinds)[number]
const fieldOf = { int4: "n", int8: "b", bool: "t", text: "s", handle: "h" } as const satisfies {
	readonly [K in CellKind]: string
}

interface Values {
	readonly int4: number
	readonly int8: bigint
	readonly bool: boolean
	readonly text: string
	readonly handle: Handle
}

/**
 * Each kind's values, shared by literals and facts. Some texts spell a handle: a text literal is text whatever its rule
 * matches, so one beside a handle its arm binds to the same spelling never takes the closed relation's type.
 */
const dictionary: { readonly [K in CellKind]: readonly [Values[K], ...Array<Values[K]>] } = {
	int4: [0, -0, 1, -1, 2, 7, 2147483647, -2147483648],
	int8: [0n, 1n, -1n, 2n, 7n, 9007199254740993n, 9223372036854775807n, -9223372036854775808n],
	bool: [true, false],
	text: ["", "1", "1.00", "-0", "0", "t", "f", "true", "é", "é", "a", "A", "B"],
	handle: handles
}

/** The numeric and float fields only planted cases read: their spellings are the ones a literal must never meet. */
const numerics = ["1", "1.00", "-0", "0.0"] as const
const floats = [0, -0, 1, 1.5] as const

interface Fact extends Values {
	readonly x: string
	readonly f: number
}

/** One key of an arm's head: the relation's field, or a literal of the key's kind. */
type Item =
	| { readonly key: CellKind; readonly source: "field" }
	| {
			readonly [K in CellKind]: {
				readonly key: K
				readonly source: "literal"
				readonly value: Values[K]
			}
	  }[CellKind]
type Arm = readonly [Item, ...Array<Item>]

/** A heading group: its keys, and its arms, each delivering exactly those keys in that order. */
interface Group {
	readonly keys: readonly [CellKind, ...Array<CellKind>]
	readonly arms: readonly [Arm, ...Array<Arm>]
}

type Case =
	| {
			readonly kind: "union"
			readonly facts: readonly [Fact, ...Array<Fact>]
			readonly groups: Groups
	  }
	| {
			readonly kind: "planted"
			readonly facts: readonly [Fact, ...Array<Fact>]
			readonly against: "numeric" | "float8"
			readonly literalFirst: boolean
	  }
/** One group of at least two arms, or two groups told apart by a tag. */
type Groups = readonly [Group] | readonly [Group, Group]

const factGen: Gen<Fact> = (source) => ({
	int4: source.draw(element(dictionary.int4)),
	int8: source.draw(element(dictionary.int8)),
	bool: source.draw(element(dictionary.bool)),
	text: source.draw(element(dictionary.text)),
	handle: source.draw(element(dictionary.handle)),
	x: source.draw(element(numerics)),
	f: source.draw(element(floats))
})

const factsGen: Gen<readonly [Fact, ...Array<Fact>]> = (source) => [
	source.draw(factGen),
	...source.draw(array(factGen, { min: 0, max: 4 }))
]

/** An item of `key`: its field, or one of its literals, a literal as often as a field. */
const itemGen = (key: CellKind): Gen<Item> => {
	const field = constant<Item>({ key, source: "field" })
	switch (key) {
		case "int4":
			return oneOf([
				field,
				map(element(dictionary.int4), (value): Item => ({ key, source: "literal", value }))
			])
		case "int8":
			return oneOf([
				field,
				map(element(dictionary.int8), (value): Item => ({ key, source: "literal", value }))
			])
		case "bool":
			return oneOf([
				field,
				map(element(dictionary.bool), (value): Item => ({ key, source: "literal", value }))
			])
		case "text":
			return oneOf([
				field,
				map(element(dictionary.text), (value): Item => ({ key, source: "literal", value }))
			])
		case "handle":
			return oneOf([
				field,
				map(element(dictionary.handle), (value): Item => ({ key, source: "literal", value }))
			])
	}
}

const armGen =
	(keys: readonly [CellKind, ...Array<CellKind>]): Gen<Arm> =>
	(source) => {
		const [first, ...rest] = keys
		return [source.draw(itemGen(first)), ...Arr.map(rest, (key) => source.draw(itemGen(key)))]
	}

/** A heading's keys: one to three kinds, in any order. */
const keysGen: Gen<readonly [CellKind, ...Array<CellKind>]> = (source) => {
	const first = source.draw(element(kinds))
	return [
		first,
		...source.draw(
			shuffled(
				Arr.filter(kinds, (k) => k !== first),
				{ min: 0, max: 2 }
			)
		)
	]
}

/** A heading group of `minArms` to four arms. */
const groupGen =
	(minArms: number, keys: Gen<readonly [CellKind, ...Array<CellKind>]>): Gen<Group> =>
	(source) => {
		const k = source.draw(keys)
		return {
			keys: k,
			arms: [source.draw(armGen(k)), ...source.draw(array(armGen(k), { min: minArms - 1, max: 3 }))]
		}
	}

const sameKeys = (a: ReadonlyArray<CellKind>, b: ReadonlyArray<CellKind>): boolean =>
	a.length === b.length && Arr.every(a, (key) => b.includes(key))

const groupsGen: Gen<Groups> = oneOf<Groups>([
	map(groupGen(2, keysGen), (g): Groups => [g]),
	(source) => {
		const first = source.draw(groupGen(1, keysGen))
		const second = source.draw(
			groupGen(
				1,
				filter(keysGen, (keys) => !sameKeys(keys, first.keys), 10)
			)
		)
		return [first, second]
	}
])

const caseGen: Gen<Case> = weighted<Case>([
	[
		9,
		(source) => ({ kind: "union", facts: source.draw(factsGen), groups: source.draw(groupsGen) })
	],
	[
		1,
		(source) => ({
			kind: "planted",
			facts: source.draw(factsGen),
			against: source.draw(element<"numeric" | "float8">(["numeric", "float8"])),
			literalFirst: source.draw(boolean)
		})
	]
])

/**
 * An arm as an application writes it: the relation matched, every field item bound to its variable and a handle item
 * bound as a match constant, and the head delivering each item, a handle as its typed constant Kind.handle, any other
 * literal as its JavaScript value, the group's tag beside them in a two-group union.
 */
const armRule =
	(arm: Arm, tag: Option.Option<string>) =>
	(r: RuleValue): FinishedValue => {
		const vars = varsOver(Cell, "cell")
		const bindings: Record<string, unknown> = { id: vars["id"] }
		const head: Record<string, unknown> = {}
		for (const item of arm) {
			const field = fieldOf[item.key]
			if (item.source === "field") {
				bindings[field] = vars[field]
				head[field] = vars[field]
				continue
			}
			if (item.key === "handle") {
				bindings[field] = item.value
				head[field] = Kind.handle(item.value)
				continue
			}
			head[field] = item.value
		}
		if (Option.isSome(tag)) {
			head["tag"] = tag.value
		}
		return r.match(Cell, bindings).find(head)
	}

/** An arm with its group's tag: none in a one-group union, the group's own literal in a two-group union. */
type Tagged = readonly [Arm, Option.Option<string>]

const tagged = (group: Group, tag: Option.Option<string>): Arr.NonEmptyReadonlyArray<Tagged> =>
	Arr.map(group.arms, (arm): Tagged => [arm, tag])

/** The arms of a case, each with its group's tag. */
const armsOf = (groups: Groups): Arr.NonEmptyReadonlyArray<Tagged> =>
	groups.length === 1
		? tagged(groups[0], Option.none())
		: Arr.appendAll(tagged(groups[0], Option.some("g1")), tagged(groups[1], Option.some("g2")))

const unionOf = (arms: Arr.NonEmptyReadonlyArray<Tagged>): QueryValue => {
	const [[firstArm, firstTag], ...rest] = arms
	let q = queryOver(Cells).rule(armRule(firstArm, firstTag))
	for (const [arm, tag] of rest) {
		q = q.rule(armRule(arm, tag))
	}
	return q
}

/** The planted union's arms, in the case's order: a head literal 1 and the numeric or float field, in one heading group. */
const plantedArms = (
	against: "numeric" | "float8",
	literalFirst: boolean
): readonly [(r: RuleValue) => FinishedValue, (r: RuleValue) => FinishedValue] => {
	const field = against === "numeric" ? "x" : "f"
	const literal = (r: RuleValue): FinishedValue => {
		const { id } = varsOver(Cell, "cell")
		return r.match(Cell, { id }).find({ [field]: 1 })
	}
	const read = (r: RuleValue): FinishedValue => {
		const vars = varsOver(Cell, "cell")
		return r.match(Cell, { id: vars["id"], [field]: vars[field] }).find({ [field]: vars[field] })
	}
	return literalFirst ? [literal, read] : [read, literal]
}

const show = (value: unknown): string =>
	typeof value === "bigint"
		? `${value}n`
		: typeof value === "string"
			? Formatter.format(value)
			: String(value)

/** A delivered value: its host kind and its value. */
const sameValue: Equivalence<unknown> = (a, b) =>
	typeof a === typeof b && a === b
		? Option.none()
		: Option.some(`${show(a)} (${typeof a}) is not ${show(b)} (${typeof b})`)

/** A delivered record: the same keys, each the same value. */
const sameRecord: Equivalence<unknown> = (a, b) => {
	if (!isRecord(a) || !isRecord(b)) {
		return Option.some("a delivered row is a record")
	}
	const keys = Arr.sort(Rec.keys(a), Order.String)
	const others = Arr.sort(Rec.keys(b), Order.String)
	if (Arr.join(keys, ",") !== Arr.join(others, ",")) {
		return Option.some(`keys ${Arr.join(keys, ",")} are not ${Arr.join(others, ",")}`)
	}
	for (const key of keys) {
		const difference = sameValue(a[key], b[key])
		if (Option.isSome(difference)) {
			return Option.some(`${key}: ${difference.value}`)
		}
	}
	return Option.none()
}

/** Records as the set they denote: each record once, by sameRecord, in the order it first appears. */
const distinctRecords = (records: ReadonlyArray<unknown>): ReadonlyArray<unknown> =>
	Arr.dedupeWith(records, (a, b) => Option.isNone(sameRecord(a, b)))

/**
 * The records a union's arms deliver alone, as the set union they denote, each record once however many arms deliver
 * it. Each arm's own delivery is a set: one that repeats a record is named.
 */
const armsAlone = (arms: ReadonlyArray<ReadonlyArray<unknown>>): ReadonlyArray<unknown> => {
	for (const delivered of arms) {
		assert.deepEqual(
			set(structuralHash, sameRecord)(delivered, distinctRecords(delivered)),
			Option.none(),
			`an arm alone delivered ${printRecords(delivered)}`
		)
	}
	return distinctRecords(Arr.flatten(arms))
}

const printRecords = (records: ReadonlyArray<unknown>): string =>
	Arr.join(
		Arr.map(records, (r) =>
			isRecord(r)
				? `{${Arr.join(
						Arr.map(Rec.toEntries(r), ([k, v]) => `${k}: ${show(v)}`),
						", "
					)}}`
				: show(r)
		),
		" "
	)

type Feature =
	| "two heading groups"
	| `${CellKind} literals alone`
	| `${CellKind} field after two literals`
	| `${CellKind} field before a literal`
	| "a field cell spelling a literal"
	| "a field cell no literal spells"
	| "text literal 1.00"
	| "text literal -0"
	| "int4 literal -0"
	| "planted literal against numeric"
	| "planted literal against float8"

const allFeatures: Arr.NonEmptyReadonlyArray<Feature> = [
	"two heading groups",
	...Arr.flatMap(kinds, (k): ReadonlyArray<Feature> => [
		`${k} literals alone`,
		`${k} field after two literals`,
		`${k} field before a literal`
	]),
	"a field cell spelling a literal",
	"a field cell no literal spells",
	"text literal 1.00",
	"text literal -0",
	"int4 literal -0",
	"planted literal against numeric",
	"planted literal against float8"
]

/** The value a fact holds for a kind. */
const factValue = (fact: Fact, key: CellKind): Values[CellKind] => fact[key]

/**
 * What a union case reaches: per group column, the order its literal and field arms meet in, and whether a field's
 * cells spell one of the column's literals.
 */
const reached = (c: {
	readonly facts: ReadonlyArray<Fact>
	readonly groups: Groups
}): ReadonlyArray<Feature> => {
	const out: Array<Feature> = []
	if (c.groups.length === 2) {
		out.push("two heading groups")
	}
	for (const g of c.groups) {
		for (const [position, key] of g.keys.entries()) {
			const items = Arr.map(g.arms, (arm) => arm[position])
			const literals = Arr.flatMap(items, (item) =>
				item?.source === "literal" ? [item.value] : []
			)
			const fieldAt = Arr.findFirstIndex(items, (item) => item?.source === "field")
			if (Option.isNone(fieldAt)) {
				out.push(`${key} literals alone`)
			} else {
				const before = Arr.filter(
					items.slice(0, fieldAt.value),
					(item) => item?.source === "literal"
				)
				if (before.length >= 2) {
					out.push(`${key} field after two literals`)
				}
				if (literals.length > before.length) {
					out.push(`${key} field before a literal`)
				}
				const spelled = Arr.some(c.facts, (fact) =>
					Arr.some(literals, (l) => l === factValue(fact, key))
				)
				const unspelled = Arr.some(
					c.facts,
					(fact) => !Arr.some(literals, (l) => l === factValue(fact, key))
				)
				if (literals.length > 0 && spelled) {
					out.push("a field cell spelling a literal")
				}
				if (literals.length > 0 && unspelled) {
					out.push("a field cell no literal spells")
				}
			}
			for (const l of literals) {
				if (key === "text" && l === "1.00") {
					out.push("text literal 1.00")
				}
				if (key === "text" && l === "-0") {
					out.push("text literal -0")
				}
				if (key === "int4" && Object.is(l, -0)) {
					out.push("int4 literal -0")
				}
			}
		}
	}
	return out
}

/** The rows a served member delivers, run without parameters. */
const records = (ops: CompiledOps<unknown>) =>
	Effect.flatMap(ops.execute({}), (result) => result.collect)

layer(Substrate.layer)("union cells", (it) => {
	it.effect(
		"decodes a union's rows to exactly the records its arms decode to, each read alone, and refuses a literal against a numeric field",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const s = yield* Substrate
					const opened = yield* installed(
						Cells,
						{},
						{ label: "real", extensions: [], programs: {} }
					)
					const names = namesOf(opened.installed)
					const kinds = defined(
						opened.installed.names.codes.rosters.get(parsedName("Kind")),
						"the codes of Kind"
					)
					const table = names.table(Cell)
					const columns = ["id", "n", "b", "t", "s", "h", "x", "f"] as const
					const insert = `INSERT INTO ${table} (${Arr.join(
						Arr.map(columns, (c) => names.column(Cell, c)),
						", "
					)}) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`
					return yield* withServedDb(opened.installed, opened.server.roles.app, {}, ({ serve }) =>
						explore(
							{
								oracle: { kind: "unstated" },
								suite: "pg/reads/union-cells",
								draw: drawn(caseGen),
								literal: Formatter.format,
								coverage: required<Feature>(allFeatures, { cases: 240, sense: notesOnly }),
								kept: [],
								runs: 60,
								shrink: completeShrink,
								concurrency: 1,
								steerEvery: 16,
								caseHang
							},
							(c, notes) =>
								Effect.gen(function* () {
									yield* replaceRows(
										s.admin,
										installationGroup(names),
										Arr.map(c.facts, (fact, id) => ({
											sql: insert,
											params: [
												String(id),
												String(fact.int4),
												String(fact.int8),
												String(fact.bool),
												fact.text,
												String(codeOf(kinds, fact.handle)),
												fact.x,
												Object.is(fact.f, -0) ? "-0" : String(fact.f)
											]
										}))
									)
									if (c.kind === "planted") {
										notes.note(`planted literal against ${c.against}`)
										const [a, b] = plantedArms(c.against, c.literalFirst)
										const planted = queryOver(Cells).rule(a).rule(b)
										if (c.against === "numeric") {
											const refused = yield* Effect.result(serve({ planted }))
											assert.ok(
												Result.isFailure(refused),
												"a literal against the numeric field is compiled"
											)
											assert.ok(
												!(refused.failure instanceof OpenError),
												Formatter.format(refused.failure)
											)
											const error = refused.failure.error
											assert.ok(isCompileError(error), Formatter.format(error))
											assert.deepEqual(
												[refused.failure.place, error.reason._tag],
												[
													{ kind: "program", role: "app", program: "planted" },
													"MalformedDescription"
												],
												"a literal against the numeric field is refused where the member is compiled"
											)
											return
										}
										const served = yield* serve({
											planted,
											first: queryOver(Cells).rule(a),
											second: queryOver(Cells).rule(b)
										})
										const delivered = yield* records(member(served, "planted"))
										const first = yield* records(member(served, "first"))
										const second = yield* records(member(served, "second"))
										const alone = armsAlone([first, second])
										assert.deepEqual(
											set(structuralHash, sameRecord)(delivered, alone),
											Option.none(),
											`the union delivered ${printRecords(delivered)}; its arms alone ${printRecords(alone)}`
										)
										return
									}
									const arms = armsOf(c.groups)
									const served = yield* serve({
										union: unionOf(arms),
										...Rec.fromEntries(Arr.map(arms, (arm, j) => [`arm${j}`, unionOf([arm])]))
									})
									const union = yield* records(member(served, "union"))
									const armRecords = yield* Effect.forEach(arms, (_arm, j) =>
										records(member(served, `arm${j}`))
									)
									const alone = armsAlone(armRecords)
									assert.deepEqual(
										set(structuralHash, sameRecord)(union, alone),
										Option.none(),
										`the union delivered ${printRecords(union)}; its arms alone ${printRecords(alone)}`
									)
									notes.noteAll(reached(c))
								})
						)
					)
				}).pipe(Effect.scoped)
			)
	)
})
