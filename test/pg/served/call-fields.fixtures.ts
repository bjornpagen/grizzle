/** What the properties of call-fields.test.ts read: its schema, its programs, its space, its model and its oracle. */

import { aimed, array, element, type Gen, int, weighted } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Order, Record as Rec, Result } from "effect"
import type { Plan } from "#adapter/types/db.ts"
import { checkQuery } from "#compiler/check/index.ts"
import { isRecord } from "#compiler/core/record.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import { topoOrder } from "#compiler/ir/dag.ts"
import type { TypedLiteral } from "#compiler/ir/expr.ts"
import type { LogicalQuery } from "#compiler/ir/products.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { Fn } from "#compiler/public/compute.ts"
import { float8, int4, int8 } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { fn, relation, row, rows, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { queryValueDesc } from "#compiler/query/build/query.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { succeeded } from "#test/support/assert.ts"
import { type Generated, generatedTemplate } from "#test/support/install-migrate.ts"
import { canonicalFacts } from "#test/support/oracle/gen/facts.ts"
import type { GenParam } from "#test/support/oracle/gen/query.ts"
import { noBindings, Reference, unobserved } from "#test/support/oracle/reference/evaluate.ts"
import {
	CallRefused,
	declaredModel,
	type ModelArg,
	type ModelResult,
	type ModelRow
} from "#test/support/oracle/reference/functions.ts"
import type { Value } from "#test/support/oracle/reference/values.ts"
import type { PgConnection } from "#test/support/pg.ts"
import { checking, checkOptions } from "#test/support/policy.ts"
import type { SubstrateTemplate } from "#test/support/substrate/substrate.ts"
import { fullWorld } from "#test/support/worlds.ts"

/**
 * Reads of the fields of a declared function's one row (Fn.row), the shape of GRADING-SQL's machine: `machine`,
 * an SQL function of rows argument `items`, a heading of (k, mark, slot, v), and value argument `seed`, returns one row
 * of Out, whose fields `a` and `c` hold rows of A (k, v) and `b` rows of B (f, k), each the items of its slot, 0, 1 and
 * 2, f half of k, and `flow`, a text of the seed. An item's mark is what the row holds where PostgreSQL's would hold a
 * NULL or a repeat: 1 a NULL element of its field's array, 2 an element holding NULL at its v or f, 3 the field itself
 * NULL, 4 the whole row NULL, 5 its element twice; 0 its element as it is. The programs pass a session's items, the
 * rows of Item(session, slot, k, v, mark) at it, as the call's rows argument, a query bound to the session, as
 * GRADING-SQL's machine reads its bound queries: `alone` reads a's rows at the session and the seed its parameters bind;
 * `pair` a's and b's in one rule; `either` a's and c's, a union of two rules; `each` a's and b's in one rule per
 * Session(session, seed), the call over its region's variables; and `land`, a ChangeSet of one stratum, writes a's rows
 * into OutA, b's into OutB and c's into OutC at its parameters, three members of one statement. No program reads a
 * relation parameter, so the Function Scans a statement plans are its calls of machine and one unnest of each field it
 * reads.
 */

/** A text of a field, short: an item's v and the row's flow. */
const Text = str.regex("^[a-z]{0,2}$", "u")

const A = rows({ k: int8, v: Text })

const B = rows({ f: float8, k: int8 })

const Out = rows({ a: A, b: B, c: A, flow: Text })

const Input = rows({ k: int8, mark: int4, slot: int4, v: Text })

const machine = fn("machine", {
	calls: [],
	args: { items: Input, seed: int8 },
	returns: row(Out),
	volatility: "immutable",
	nullInput: "called",
	language: "sql",
	body: fn.body`SELECT CASE WHEN EXISTS (SELECT FROM unnest(items) AS i WHERE i.mark = 4) THEN NULL ELSE ROW(
CASE WHEN EXISTS (SELECT FROM unnest(items) AS i WHERE i.slot = 0 AND i.mark = 3) THEN NULL ELSE ARRAY(SELECT CASE WHEN i.mark = 1 THEN NULL ELSE ROW(i.k, CASE WHEN i.mark = 2 THEN NULL ELSE i.v END)::${A} END FROM unnest(items) AS i, generate_series(1, CASE WHEN i.mark = 5 THEN 2 ELSE 1 END) AS n WHERE i.slot = 0) END,
CASE WHEN EXISTS (SELECT FROM unnest(items) AS i WHERE i.slot = 1 AND i.mark = 3) THEN NULL ELSE ARRAY(SELECT CASE WHEN i.mark = 1 THEN NULL ELSE ROW(CASE WHEN i.mark = 2 THEN NULL ELSE i.k::float8 / 2 END, i.k)::${B} END FROM unnest(items) AS i, generate_series(1, CASE WHEN i.mark = 5 THEN 2 ELSE 1 END) AS n WHERE i.slot = 1) END,
CASE WHEN EXISTS (SELECT FROM unnest(items) AS i WHERE i.slot = 2 AND i.mark = 3) THEN NULL ELSE ARRAY(SELECT CASE WHEN i.mark = 1 THEN NULL ELSE ROW(i.k, CASE WHEN i.mark = 2 THEN NULL ELSE i.v END)::${A} END FROM unnest(items) AS i, generate_series(1, CASE WHEN i.mark = 5 THEN 2 ELSE 1 END) AS n WHERE i.slot = 2) END,
'f' || seed::text)::${Out} END`
})

const OutA = relation("OutA", { k: int8, v: Text }, ["k", "v"])

const OutB = relation("OutB", { k: int8, f: float8 }, ["k"])

const OutC = relation("OutC", { k: int8, v: Text }, ["k", "v"])

/** Each session's items, machine's rows argument. */
const Item = relation("Item", { session: int4, slot: int4, k: int8, v: Text, mark: int4 }, [
	"session",
	"k"
])

/** The sessions `each` reads, each with its seed. */
const Session = relation("Session", { session: int4, seed: int8 }, ["session"])

/** The schema of a case under `name`: the items and sessions, the relations `land` writes, and machine. */
const fieldsSchema = (name: string) => schema(name, [Item, Session, OutA, OutB, OutC, machine], [])

/** The programs over a schema of `name`. */
export const programsOf = (name: string) => {
	const level = fieldsSchema(name)
	/** The items of the session `session` binds, the call's rows argument. */
	const itemsOf = query(level).rule((r) => {
		const { slot, k, v: x, mark } = v(Item, "item")
		return r
			.match(Item, { session: r.param("session", int4), slot, k, v: x, mark })
			.find({ slot, k, v: x, mark })
	})
	const alone = query(level).rule((r) => {
		const read = Fn.row(machine, {
			items: itemsOf.bind({ session: r.param("session", int4) }),
			seed: r.param("seed", int8)
		}).a
		const { k, v: x } = v(read, "a")
		return r.match(read, { k, v: x }).find({ k, v: x })
	})
	const pair = query(level).rule((r) => {
		const fields = Fn.row(machine, {
			items: itemsOf.bind({ session: r.param("session", int4) }),
			seed: r.param("seed", int8)
		})
		const { k, v: x } = v(fields.a, "a")
		const { k: j, f } = v(fields.b, "b")
		return r.match(fields.a, { k, v: x }).match(fields.b, { k: j, f }).find({ k, v: x, j, f })
	})
	const either = query(level)
		.rule((r) => {
			const read = Fn.row(machine, {
				items: itemsOf.bind({ session: r.param("session", int4) }),
				seed: r.param("seed", int8)
			}).a
			const { k, v: x } = v(read, "a")
			return r.match(read, { k, v: x }).find({ k, v: x })
		})
		.rule((r) => {
			const read = Fn.row(machine, {
				items: itemsOf.bind({ session: r.param("session", int4) }),
				seed: r.param("seed", int8)
			}).c
			const { k, v: x } = v(read, "c")
			return r.match(read, { k, v: x }).find({ k, v: x })
		})
	const each = query(level).rule((r) => {
		const { session, seed } = v(Session, "session")
		const fields = Fn.row(machine, { items: itemsOf.bind({ session }), seed })
		const { k, v: x } = v(fields.a, "a")
		const { k: j, f } = v(fields.b, "b")
		return r
			.match(Session, { session, seed })
			.match(fields.a, { k, v: x })
			.match(fields.b, { k: j, f })
			.find({ session, k, v: x, j, f })
	})
	const land = ChangeSet.empty(level)
		.insert(
			OutA,
			query(level).rule((r) => {
				const read = Fn.row(machine, {
					items: itemsOf.bind({ session: r.param("session", int4) }),
					seed: r.param("seed", int8)
				}).a
				const { k, v: x } = v(read, "a")
				return r.match(read, { k, v: x }).find({ k, v: x })
			})
		)
		.insert(
			OutB,
			query(level).rule((r) => {
				const read = Fn.row(machine, {
					items: itemsOf.bind({ session: r.param("session", int4) }),
					seed: r.param("seed", int8)
				}).b
				const { k, f } = v(read, "b")
				return r.match(read, { k, f }).find({ k, f })
			})
		)
		.insert(
			OutC,
			query(level).rule((r) => {
				const read = Fn.row(machine, {
					items: itemsOf.bind({ session: r.param("session", int4) }),
					seed: r.param("seed", int8)
				}).c
				const { k, v: x } = v(read, "c")
				return r.match(read, { k, v: x }).find({ k, v: x })
			})
		)
	/**
	 * Each session, its attachments `a` and `c` each reading machine's run at the session's key, the session's items
	 * and its seed, one field each: one call of machine for every session, which the statement holds for the sessions'
	 * rows and both attachments read (lower/conservative/call/index.ts parentEvaluations).
	 */
	const attached = query(level)
		.rule((r) => {
			const { session, seed } = v(Session, "session")
			return r.match(Session, { session, seed }).find({ session, seed })
		})
		.attach(
			"a",
			(s) =>
				query(level).rule((r) => {
					const read = Fn.row(machine, {
						items: itemsOf.bind({ session: s.session }),
						seed: s.seed
					}).a
					const { k, v: x } = v(read, "a")
					return r.match(read, { k, v: x }).find({ k, v: x })
				}),
			"array"
		)
		.attach(
			"c",
			(s) =>
				query(level).rule((r) => {
					const read = Fn.row(machine, {
						items: itemsOf.bind({ session: s.session }),
						seed: s.seed
					}).c
					const { k, v: x } = v(read, "c")
					return r.match(read, { k, v: x }).find({ k, v: x })
				}),
			"array"
		)
	/** Each session's rows of one field of machine's run at its key, as `attached`'s attachment of the field reads them. */
	const eachOf = (field: "a" | "c") =>
		query(level).rule((r) => {
			const { session, seed } = v(Session, "session")
			const read = Fn.row(machine, { items: itemsOf.bind({ session }), seed })[field]
			const { k, v: x } = v(read, "field")
			return r.match(Session, { session, seed }).match(read, { k, v: x }).find({ session, k, v: x })
		})
	return {
		level,
		programs: { alone, pair, either, each, land, attached, eachA: eachOf("a"), eachC: eachOf("c") }
	}
}

/** The installation of the case's schema as a template, which every case clones. */
export const fieldsTemplate: SubstrateTemplate<Generated> = generatedTemplate({
	declaredIn: import.meta,
	name: "call_fields",
	content: { programs: ["alone", "pair", "either", "each", "land", "attached", "eachA", "eachC"] },
	build: (name) => {
		const { level, programs } = programsOf(name)
		return { schema: level, logins: [fullWorld(level, programs, []).server] }
	},
	ambient: ordinarySession
})

/** The served world of a case over its installation's declared name. */
export const worldOf = (declared: string) => {
	const { level, programs } = programsOf(declared)
	return fullWorld(level, programs, [])
}

/** The programs that read, each a query (programsOf). */
const readPrograms = ["alone", "pair", "either", "each"] as const

/** The statements that read several fields of one call: the reads of two, and `land`'s three members. */
const sharingPrograms = ["pair", "either", "each", "land"] as const

export type ReadProgram = (typeof readPrograms)[number]

export type SharingProgram = (typeof sharingPrograms)[number]

export type Program = ReadProgram | SharingProgram

/** What an item's mark makes of its element (see the header). */
const marks = {
	plain: 0,
	nullElement: 1,
	holdingNull: 2,
	nullField: 3,
	nullRow: 4,
	twice: 5
} as const

/** The fields of machine's row each program reads, each by its slot: a's 0, b's 1, c's 2. */
const readSlots: { readonly [P in Program]: ReadonlyArray<number> } = {
	alone: [0],
	pair: [0, 1],
	either: [0, 2],
	each: [0, 1],
	land: [0, 1, 2]
}

export interface ItemFact {
	readonly session: number
	readonly slot: number
	readonly k: number
	readonly v: string
	readonly mark: number
}

export interface FieldsCase<P extends Program> {
	readonly program: P
	/** The sessions `each` reads, each with its seed. */
	readonly sessions: ReadonlyArray<{ readonly session: number; readonly seed: number }>
	readonly items: ReadonlyArray<ItemFact>
	/** The session and the seed every other program binds, the session maybe of no item. */
	readonly session: number
	readonly seed: number
}

const sessionIds = [1, 2, 3] as const

/**
 * An item's mark: mostly plain, sometimes twice, a NULL field or a NULL row, and, where every read the program makes is
 * evaluated whatever the other reads hold (`alone`, `either`), a NULL element or one holding NULL: a rule that matches
 * two fields stops at the first one empty, so whether PostgreSQL unnests the second is the planner's.
 */
const markGen = (program: Program): Gen<number> =>
	weighted<number>([
		[12, () => marks.plain],
		[2, () => marks.twice],
		[1, () => marks.nullField],
		[1, () => marks.nullRow],
		...(program === "alone" || program === "either"
			? ([
					[1, () => marks.nullElement],
					[1, () => marks.holdingNull]
				] as const)
			: [])
	])

/** A case of one of `programs`: its sessions and their seeds, its items, and the session and the seed it binds. */
const caseOf =
	<P extends Program>(programs: Arr.NonEmptyReadonlyArray<P>): Gen<FieldsCase<P>> =>
	(source) => {
		const program = source.draw(element(programs))
		const held = Arr.filter(sessionIds, () => source.draw(element([true, false] as const)))
		const items = Arr.flatMap(held, (session) =>
			Arr.map(source.draw(array(int(0, 2), { min: 0, max: 4 })), (slot, at) => ({
				session,
				slot,
				k: at,
				v: source.draw(element(["", "a", "b", "ab"] as const)),
				mark: source.draw(markGen(program))
			}))
		)
		return {
			program,
			sessions: Arr.map(held, (session) => ({ session, seed: source.draw(int(0, 2)) })),
			items,
			session: source.draw(element(sessionIds)),
			seed: source.draw(int(0, 2))
		}
	}

/**
 * A case of one of `programs` whose program reads an item marked `mark`: a case of them, and beside its items one of
 * that mark in the first field the program reads, of the session it binds, the first of its sessions for `each`, made
 * where it has none.
 */
const markedOf =
	<P extends Program>(programs: Arr.NonEmptyReadonlyArray<P>, mark: number): Gen<FieldsCase<P>> =>
	(source) => {
		const c = source.draw(caseOf(programs))
		const [first] = c.sessions
		const sessions =
			c.program === "each" && first === undefined ? [{ session: 1, seed: 0 }] : c.sessions
		const session = c.program === "each" ? (sessions[0]?.session ?? c.session) : c.session
		const [slot] = readSlots[c.program]
		const k = Arr.reduce(
			Arr.filter(c.items, (i) => i.session === session),
			0,
			(next: number, i) => Math.max(next, i.k + 1)
		)
		return {
			...c,
			sessions,
			items: [
				...c.items,
				{ session, slot: slot ?? 0, k, v: source.draw(element(["", "a"] as const)), mark }
			]
		}
	}

/** The programs that evaluate every read they make, whatever another read holds: one field, and a union of rules. */
const everyReadPrograms = ["alone", "either"] as const

/** A case of a program that reads (readPrograms), aimed at each refusal and at a repeated row. */
export const readCaseGen = aimed(caseOf(readPrograms), [
	["a NULL row, refused", markedOf(readPrograms, marks.nullRow)],
	["a NULL field, refused", markedOf(readPrograms, marks.nullField)],
	["a NULL element, refused", markedOf(everyReadPrograms, marks.nullElement)],
	["a row holding NULL, refused", markedOf(everyReadPrograms, marks.holdingNull)],
	["a repeated row, read once", markedOf(readPrograms, marks.twice)]
])

/** A case of a statement that reads several fields of one call (sharingPrograms), aimed at each refusal. */
export const sharingCaseGen = aimed(caseOf(sharingPrograms), [
	["a NULL row, refused", markedOf(sharingPrograms, marks.nullRow)],
	["a NULL field, refused", markedOf(sharingPrograms, marks.nullField)]
])

/** The parameters a case's program binds, by name, as a served call takes them: none for `each`. */
export const paramsOf = (c: FieldsCase<Program>): Readonly<Record<string, number | bigint>> =>
	c.program === "each" ? {} : { session: c.session, seed: BigInt(c.seed) }

/** A case's facts, as the installation loads them: its items, and its sessions with their seeds. */
export const factsOf = (c: FieldsCase<Program>) => ({
	Item: Arr.map(c.items, (i) => ({
		session: i.session,
		slot: i.slot,
		k: BigInt(i.k),
		v: i.v,
		mark: i.mark
	})),
	Session: Arr.map(c.sessions, (s) => ({ session: s.session, seed: BigInt(s.seed) }))
})

/** A value of a model's row. */
const valueOf = (value: Value | null): ModelResult => ({ kind: "value", value })

/** An integer of a model's argument row, its field `field`, as the reference holds it. */
const integerAt = (row: ReadonlyMap<string, Value>, field: string): bigint => {
	const value = row.get(field)
	if (typeof value !== "bigint") {
		throw new Error(`machine's model reads an integer at ${field}`)
	}
	return value
}

/** A text of a model's argument row, its field `field`, as the reference holds it. */
const textAt = (row: ReadonlyMap<string, Value>, field: string): string => {
	const value = row.get(field)
	if (typeof value !== "string") {
		throw new Error(`machine's model reads a text at ${field}`)
	}
	return value
}

/**
 * machine's model, its body read in TypeScript: the row of its items' fields, NULL where an item is marked 4; each
 * field NULL where an item of its slot is marked 3, otherwise each item of its slot an element, NULL where it is marked
 * 1, holding NULL at v or f where marked 2, twice where marked 5; f half of k; and flow `f` then the seed.
 */
const machineModel = (args: ReadonlyMap<string, ModelArg>): ModelResult => {
	const items = args.get("items")
	const seed = args.get("seed")
	if (items?.kind !== "rows" || seed?.kind !== "value" || typeof seed.value !== "bigint") {
		throw new Error("machine's model of its rows argument `items` and its value `seed`")
	}
	if (Arr.some(items.rows, (i) => integerAt(i, "mark") === BigInt(marks.nullRow))) {
		return { kind: "row", row: null }
	}
	const field = (
		slot: number,
		element: (i: ReadonlyMap<string, Value>) => ModelRow
	): ModelResult => {
		const of = Arr.filter(items.rows, (i) => integerAt(i, "slot") === BigInt(slot))
		if (Arr.some(of, (i) => integerAt(i, "mark") === BigInt(marks.nullField))) {
			return { kind: "rows", rows: null }
		}
		return {
			kind: "rows",
			rows: Arr.flatMap(of, (i): ReadonlyArray<ModelRow | null> => {
				const mark = integerAt(i, "mark")
				const one = mark === BigInt(marks.nullElement) ? null : element(i)
				return mark === BigInt(marks.twice) ? [one, one] : [one]
			})
		}
	}
	const held = (i: ReadonlyMap<string, Value>) => integerAt(i, "mark") === BigInt(marks.holdingNull)
	const ofA = (i: ReadonlyMap<string, Value>): ModelRow =>
		new Map([
			["k", valueOf(integerAt(i, "k"))],
			["v", valueOf(held(i) ? null : textAt(i, "v"))]
		])
	const ofB = (i: ReadonlyMap<string, Value>): ModelRow =>
		new Map([
			["k", valueOf(integerAt(i, "k"))],
			["f", valueOf(held(i) ? null : Number(integerAt(i, "k")) / 2)]
		])
	return {
		kind: "row",
		row: new Map([
			["a", field(0, ofA)],
			["b", field(1, ofB)],
			["c", field(2, ofA)],
			["flow", valueOf(`f${seed.value}`)]
		])
	}
}

/** A program's query of a schema named for the reference, checked into its logical query. */
const checkedOf = (program: ReadProgram): LogicalQuery => {
	const { level, programs } = programsOf("call_fields_reference")
	const desc = queryValueDesc(programs[program])
	if (desc === undefined) {
		throw new Error(`${program}, a query value`)
	}
	return succeeded(checkQuery(checking(level), desc, checkOptions(program)), `${program} checks`)
}

/** A value of a case's parameters or facts as the reference's literal: an integer's or a text's. */
const literalOf = (value: unknown): TypedLiteral =>
	typeof value === "bigint" || typeof value === "number"
		? { kind: "int", value: BigInt(value) }
		: { kind: "text", value: String(value) }

/**
 * What the reference gives a program over a case: its rows, each a text of its columns by name, sorted, or the
 * refusal of a call whose result holds NULL where the program reads it (CallRefused).
 */
export const referenceOf = (
	c: FieldsCase<ReadProgram>
): Result.Result<ReadonlyArray<string>, CallRefused> => {
	const checked = checkedOf(c.program)
	const bound = paramsOf(c)
	const params: Record<string, GenParam> = {}
	for (const decl of checked.params) {
		if (decl.kind === "scalar") {
			params[decl.id] = { kind: "scalar", type: decl.type, value: literalOf(bound[decl.name]) }
		}
	}
	const facts: Readonly<Record<string, ReadonlyArray<Readonly<Record<string, unknown>>>>> =
		factsOf(c)
	const stored = new Map(
		Arr.flatMap(topoOrder(checked.dag), (n) =>
			n.kind === "Base" ? [[n.relation, n.heading] as const] : []
		)
	)
	const root = checked.dag.roots[0]
	return Result.try({
		try: () =>
			Reference.of(checked.dag, {
				schema: {
					name: "call_fields_reference",
					relations: Arr.map([...stored], ([name, heading]) => ({
						name,
						columns: Arr.map(heading, (col) => ({ name: col.name, type: col.type })),
						primaryKey: [],
						keys: [],
						mutable: false
					})),
					closed: [],
					containments: []
				},
				facts: canonicalFacts(
					Rec.fromEntries(
						Arr.map(
							[...stored],
							([name, heading]) =>
								[
									name,
									Arr.map(facts[name] ?? [], (fact) =>
										Arr.map(heading, (col) => literalOf(fact[col.name]))
									)
								] as const
						)
					)
				),
				params,
				functions: new Map([["machine", declaredModel(machine, machineModel)]]),
				observer: unobserved
			}).eval(root, noBindings),
		catch: (thrown) => thrown
	}).pipe(
		Result.flatMap((relation) =>
			Result.succeed(
				Arr.sort(
					Arr.map(relation.rows, (r) =>
						rowText(
							Rec.fromEntries(Arr.map(relation.heading, (col, i) => [col.name, r[i]] as const))
						)
					),
					Order.String
				)
			)
		),
		Result.mapError((thrown) => {
			if (thrown instanceof CallRefused) {
				return thrown
			}
			throw thrown
		})
	)
}

/** A row as a text of its columns by name, in name order, each its value's text. */
const rowText = (row: Readonly<Record<string, unknown>>): string =>
	Arr.join(
		Arr.map(Arr.sort(Rec.keys(row), Order.String), (name) => `${name}=${String(row[name])}`),
		"|"
	)

/** The texts of rows a served call answered, sorted, repeats kept. */
export const answeredTexts = (rows: ReadonlyArray<unknown>): ReadonlyArray<string> =>
	Arr.sort(
		Arr.map(rows, (r) => (isRecord(r) ? rowText(r) : "not a row")),
		Order.String
	)

/** The fields of machine's row a program reads (readSlots), and so the unnests its statement plans. */
const fieldReads = (program: Program): number => readSlots[program].length

/**
 * The calls of machine a statement plans: its Function Scans beyond the one unnest each field it reads plans
 * (fieldReads), every other Function Scan of its plan a call of machine (functionScans).
 */
export const machineScans = (
	plans: ReadonlyArray<{ readonly plan: Plan }>,
	program: Program,
	scans: (plan: Plan) => number
): number => Arr.reduce(plans, 0, (n: number, p) => n + scans(p.plan)) - fieldReads(program)

/** What a case reaches beside its program, by its draw and its outcome. */
export type OutcomeFeature =
	| "an empty field, the empty source"
	| "a repeated row, read once"
	| "a NULL row, refused"
	| "a NULL field, refused"
	| "a NULL element, refused"
	| "a row holding NULL, refused"
	| "rows answered"

/** The features of a case of a program of P: the program, and what it reaches (OutcomeFeature). */
export type FieldsFeature<P extends Program> = P | OutcomeFeature

/** The items whose fields a case's program reads: the bound session's, or every session's for `each`. */
const readItems = (c: FieldsCase<Program>): ReadonlyArray<ItemFact> =>
	c.program === "each"
		? Arr.filter(c.items, (i) => Arr.some(c.sessions, (s) => s.session === i.session))
		: Arr.filter(c.items, (i) => i.session === c.session)

/** The features a case reaches by its draw, beside the outcomes its check notes. */
export const drawnFeatures = <P extends Program>(
	c: FieldsCase<P>
): ReadonlyArray<FieldsFeature<P>> => {
	const read = readItems(c)
	const inRead = (i: ItemFact) => Arr.contains(readSlots[c.program], i.slot)
	const marked = (mark: number, inSlot: boolean) =>
		Arr.some(read, (i) => i.mark === mark && (!inSlot || inRead(i)))
	const refused = marked(marks.nullRow, false) || marked(marks.nullField, false)
	return [
		c.program,
		...(marked(marks.nullRow, false) ? (["a NULL row, refused"] as const) : []),
		...(!marked(marks.nullRow, false) && marked(marks.nullField, false)
			? (["a NULL field, refused"] as const)
			: []),
		...(!refused && marked(marks.nullElement, true) ? (["a NULL element, refused"] as const) : []),
		...(!refused && marked(marks.holdingNull, true)
			? (["a row holding NULL, refused"] as const)
			: []),
		...(!refused && marked(marks.twice, true) ? (["a repeated row, read once"] as const) : []),
		...(!refused &&
		Arr.some(readSlots[c.program], (slot) => !Arr.some(read, (i) => i.slot === slot))
			? (["an empty field, the empty source"] as const)
			: [])
	]
}

/** The rows `land` leaves in OutA, OutB and OutC, as texts of their columns, sorted. */
export const landedOf = (admin: PgConnection, schemaName: string) => {
	const texts = (table: string, columns: ReadonlyArray<string>) =>
		Effect.map(
			admin.query(
				`SELECT ${Arr.join(
					Arr.map(columns, (c) => `${quoteIdent(c)}::text AS ${quoteIdent(c)}`),
					", "
				)} FROM ${quoteIdent(schemaName)}.${quoteIdent(table)}`,
				[]
			),
			(result) => answeredTexts(result.rows)
		)
	return Effect.all({
		a: texts("out_a", ["k", "v"]),
		b: texts("out_b", ["k", "f"]),
		c: texts("out_c", ["k", "v"])
	})
}

/**
 * What `land` writes by machine's model, a set of each field's rows, or the refusal of a row or a field that is NULL:
 * the reference's rows of each field read alone at the case's session and seed.
 */
export const landingOf = (
	c: FieldsCase<Program>
): Result.Result<
	{
		readonly a: ReadonlyArray<string>
		readonly b: ReadonlyArray<string>
		readonly c: ReadonlyArray<string>
	},
	CallRefused
> => {
	const result = machineModel(
		new Map<string, ModelArg>([
			[
				"items",
				{
					kind: "rows",
					rows: Arr.map(
						Arr.filter(c.items, (i) => i.session === c.session),
						(i) =>
							new Map<string, Value>([
								["slot", BigInt(i.slot)],
								["k", BigInt(i.k)],
								["v", i.v],
								["mark", BigInt(i.mark)]
							])
					)
				}
			],
			["seed", { kind: "value", value: BigInt(c.seed) }]
		])
	)
	const rowsAt = (name: string): ReadonlyArray<string> | undefined => {
		if (result.kind !== "row" || result.row === null) {
			return undefined
		}
		const field = result.row.get(name)
		if (field?.kind !== "rows" || field.rows === null) {
			return undefined
		}
		return Arr.sort(
			Arr.dedupe(
				Arr.map(field.rows, (r) =>
					rowText(
						Rec.fromEntries(
							Arr.map([...(r ?? new Map<string, ModelResult>()).entries()], ([key, cell]) => [
								key,
								cell.kind === "value" ? cell.value : null
							])
						)
					)
				)
			),
			Order.String
		)
	}
	const a = rowsAt("a")
	const b = rowsAt("b")
	const cc = rowsAt("c")
	return a === undefined || b === undefined || cc === undefined
		? Result.fail(new CallRefused({ function: "machine", held: "a row holding NULL" }))
		: Result.succeed({ a, b, c: cc })
}

/**
 * A case of `attached` (programsOf): sessions with their seeds and their items, each item's mark drawn as every other
 * program's, so machine refuses a session's row or field where a mark says.
 */
export const attachedCaseGen: Gen<FieldsCase<"each">> = caseOf(["each"] as const)

/** Each session's rows of one field, as texts, sorted, by its session: an `each` program's answer grouped. */
export const fieldBySession = (
	rows: ReadonlyArray<unknown>
): ReadonlyMap<string, ReadonlyArray<string>> => {
	const out = new Map<string, Array<string>>()
	for (const r of rows) {
		if (isRecord(r)) {
			const { session, ...field } = r
			out.getOrInsertComputed(String(session), () => []).push(rowText(field))
		}
	}
	return new Map(
		Arr.map([...out], ([session, texts]) => [session, Arr.sort(texts, Order.String)] as const)
	)
}

/** Each session's array of one attachment, as texts, sorted, by its session: `attached`'s answer, one field's. */
export const attachedBySession = (
	rows: ReadonlyArray<unknown>,
	field: "a" | "c"
): ReadonlyMap<string, ReadonlyArray<string>> =>
	new Map(
		Arr.flatMap(rows, (r) => {
			if (!isRecord(r)) {
				return []
			}
			const children = r[field]
			const texts = Arr.isArray(children)
				? Arr.flatMap(children, (child: unknown) =>
						isRecord(child) ? [rowText(child)] : ["not a row"]
					)
				: ["not an array"]
			return [[String(r["session"]), Arr.sort(texts, Order.String)] as const]
		})
	)
