/** What the property of strict-calls.test.ts reads: its functions, its schema, its programs, its box and its oracles. */

import { element, type Gen } from "@bjornpagen/testing/gen"
import {
	Array as Arr,
	Data,
	Effect,
	Option,
	Order,
	Record as Rec,
	Result,
	String as Str
} from "effect"
import { checkQuery } from "#compiler/check/index.ts"
import {
	type DeclaredLanguage,
	declaredLanguages,
	type FunctionNullInput,
	functionNullInputs
} from "#compiler/core/function.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import { topoOrder } from "#compiler/ir/dag.ts"
import type { ScalarExpr } from "#compiler/ir/expr.ts"
import { predicateTable } from "#compiler/ir/expr.ts"
import { exprsOf } from "#compiler/ir/rel.ts"
import { Fn } from "#compiler/public/compute.ts"
import { closedId, sha256, int4 } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import {
	type AnyFunction,
	closed,
	type FunctionBody,
	fn,
	relation,
	rows,
	schema
} from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { queryValueDesc } from "#compiler/query/build/query.ts"
import { compiledExpr, sqlNull, noParamLeaf } from "#compiler/scalar/compute/evaluate.ts"
import { ProgramPatterns, tablePatterns } from "#compiler/scalar/regex/patterns.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { succeeded } from "#test/support/assert.ts"
import { installedName } from "#test/support/declared-functions.ts"
import { type Generated, generatedTemplate } from "#test/support/install-migrate.ts"
import {
	declaredModel,
	type ModelArg,
	modelledCall,
	type ModelResult
} from "#test/support/oracle/reference/functions.ts"
import type { PgConnection, SqlError } from "#test/support/pg.ts"
import { checking, checkOptions } from "#test/support/policy.ts"
import type { SubstrateTemplate } from "#test/support/substrate/substrate.ts"
import { fullWorld } from "#test/support/worlds.ts"

/**
 * Declared functions strict and called on NULL input (schema/function.ts fn `nullInput`), called with NULL arguments.
 *
 * The box: each function's signature, `plain` (a: integer, b: any text) or `coded` (d: a digest, m: a closed id of
 * Mood), so a strict function's NULL is met by a digest's bytea and a closed id's code as by base values; what it
 * returns, a value or rows of a heading (a set-returning function); its language; its null input; and what its body
 * does at a NULL argument: `marks` answers 7, `nulls` answers NULL (a row holding NULL, for rows), `raises` fails, a
 * division by zero in SQL and a RAISE in PL/pgSQL. At values every body answers its arguments' measure, a + the length
 * of b, or m's code + the octets of d (32), one row of it for rows.
 */

/** Any text. */
const Text = str.regex("^.*$", "su")

/** The keys of Pick: it holds k0 and k1, and no row at k2, where each of its reads is NULL. */
const keys = ["k0", "k1", "k2"] as const
type KeyHandle = (typeof keys)[number]

const Key = closed.ordered("Key", keys)

const moods = ["calm", "keen"] as const

/** The roster of a coded function's closed id, passed as its code. */
const Mood = closed.ordered("Mood", moods)

/** The values a plain call's arguments read: Pick's at k0 and k1, NULL at k2. */
const Pick = closed.relation(
	"Pick",
	{ key: closedId(Key), n: int4, t: Text },
	["key"],
	[
		{ key: "k0", n: 1, t: "x" },
		{ key: "k1", n: 2, t: "yz" }
	]
)

/** The probes a served program reads, each pair of keys, the first a's and the second b's. */
const Probe = relation("Probe", { key: closedId(Key), other: closedId(Key) }, ["key", "other"])

/** A set-returning function's heading. */
const Measured = rows({ v: int4 })

const signatures = ["plain", "coded"] as const
type Signature = (typeof signatures)[number]

const returnKinds = ["value", "rows"] as const
type ReturnKind = (typeof returnKinds)[number]

/** What a body does at a NULL argument. */
const behaviours = ["marks", "nulls", "raises"] as const
type Behaviour = (typeof behaviours)[number]

/** A function of the box. */
export interface StrictCase {
	readonly signature: Signature
	readonly returns: ReturnKind
	readonly language: DeclaredLanguage
	readonly nullInput: FunctionNullInput
	readonly behaviour: Behaviour
}

/** The box, exhausted: every function of it. */
export const caseGen: Gen<StrictCase> = (s) => ({
	signature: s.draw(element(signatures)),
	returns: s.draw(element(returnKinds)),
	language: s.draw(element(declaredLanguages)),
	nullInput: s.draw(element(functionNullInputs)),
	behaviour: s.draw(element(behaviours))
})

/** Every function of the box, each once, in the box's order. */
const allCases: ReadonlyArray<StrictCase> = Arr.flatMap(signatures, (signature) =>
	Arr.flatMap(returnKinds, (returns) =>
		Arr.flatMap(declaredLanguages, (language) =>
			Arr.flatMap(functionNullInputs, (nullInput) =>
				Arr.map(behaviours, (behaviour) => ({ signature, returns, language, nullInput, behaviour }))
			)
		)
	)
)

/** A case's function's declared name, its axes in order. */
export const nameOf = (c: StrictCase): FunctionName =>
	`${c.signature}${Str.capitalize(c.returns)}${Str.capitalize(c.language)}${Str.capitalize(c.nullInput)}${Str.capitalize(c.behaviour)}`

/** A function's declared name: its axes in order, each but the first capitalized. */
type FunctionName =
	`${Signature}${Capitalize<ReturnKind>}${Capitalize<DeclaredLanguage>}${Capitalize<FunctionNullInput>}${Capitalize<Behaviour>}`

/** Each signature's arguments, in their parameters' order, code point order of their names. */
const argumentsOf: { readonly [S in Signature]: readonly [string, string] } = {
	plain: ["a", "b"],
	coded: ["d", "m"]
}

/** A signature's test of a NULL argument, its measure at values, and its failure's dividend, in SQL. */
const sqlOf: {
	readonly [S in Signature]: {
		readonly anyNull: string
		readonly measure: string
		readonly zero: string
	}
} = {
	plain: {
		anyNull: "a IS NULL OR b IS NULL",
		measure: "a + char_length(b)",
		zero: "coalesce(a, 0) / (coalesce(a, 0) * 0)"
	},
	coded: {
		anyNull: "d IS NULL OR m IS NULL",
		measure: "m + octet_length(d)",
		zero: "coalesce(m, 0) / (coalesce(m, 0) * 0)"
	}
}

/** A case's body text. */
const bodyText = (c: StrictCase): string => {
	const { anyNull, measure, zero } = sqlOf[c.signature]
	if (c.language === "sql") {
		switch (c.behaviour) {
			case "marks":
				return `SELECT CASE WHEN ${anyNull} THEN 7 ELSE ${measure} END`
			case "nulls":
				return `SELECT ${measure}`
			case "raises":
				return `SELECT CASE WHEN ${anyNull} THEN ${zero} ELSE ${measure} END`
		}
	}
	const answer = (value: string) =>
		c.returns === "value" ? `RETURN ${value};` : `RETURN QUERY SELECT ${value}; RETURN;`
	switch (c.behaviour) {
		case "marks":
			return `\nBEGIN\n  IF ${anyNull} THEN ${answer("7")} END IF;\n  ${answer(measure)}\nEND\n`
		case "nulls":
			return `\nBEGIN\n  ${answer(measure)}\nEND\n`
		case "raises":
			return `\nBEGIN\n  IF ${anyNull} THEN RAISE EXCEPTION 'a NULL argument'; END IF;\n  ${answer(measure)}\nEND\n`
	}
}

/** A body's text as fn.body reads a template of no placeholder. */
const bodyOf = (text: string): FunctionBody => fn.body(Object.assign([text], { raw: [text] }))

/** A case's function. */
const functionOf = (c: StrictCase): AnyFunction =>
	fn(nameOf(c), {
		calls: [],
		args: c.signature === "plain" ? { a: int4, b: Text } : { d: sha256, m: closedId(Mood) },
		returns: c.returns === "value" ? int4 : Measured,
		volatility: "immutable",
		nullInput: c.nullInput,
		language: c.language,
		body: bodyOf(bodyText(c))
	})

/** The plain value function of a case, which a served program calls: none for any other. */
const servedFunctionOf = (c: StrictCase) =>
	c.signature === "plain" && c.returns === "value"
		? Option.some(
				fn(nameOf(c), {
					calls: [],
					args: { a: int4, b: Text },
					returns: int4,
					volatility: "immutable",
					nullInput: c.nullInput,
					language: c.language,
					body: bodyOf(bodyText(c))
				})
			)
		: Option.none()

/** The schema of the box under `name`: every function of it beside Pick and Probe. */
const strictSchema = (name: string) =>
	schema(name, [Key, Mood, Pick, Probe, ...Arr.map(allCases, functionOf)], [])

/**
 * Each plain value function's program, by the function's name: the probes whose call of the function, at Pick's n at
 * the probe's key and Pick's t at its other key, is at least 0, which holds of every value the box's functions answer,
 * so a probe is kept exactly where the call answers a value.
 */
const programsOver = (s: ReturnType<typeof strictSchema>) =>
	Rec.fromEntries(
		Arr.flatMap(allCases, (c) =>
			Option.match(servedFunctionOf(c), {
				onNone: () => [],
				onSome: (f) => [
					[
						nameOf(c),
						query(s).rule((r) => {
							const { key, other } = v(Probe, "probe")
							return r
								.match(Probe, { key, other })
								.where(r.ge(Fn.call(f, { a: Pick.at("n", key), b: Pick.at("t", other) }), 0))
								.find({ key, other })
						})
					] as const
				]
			})
		)
	)

/** The served world of the box's schema under its installation's declared name. */
export const worldOf = (declared: string) => {
	const s = strictSchema(declared)
	return fullWorld(s, programsOver(s), [])
}

/** The box's installation as a template, which every case clones. */
export const strictTemplate: SubstrateTemplate<Generated> = generatedTemplate({
	declaredIn: import.meta,
	name: "strict_calls",
	content: { cases: Arr.map(allCases, nameOf) },
	build: (name) => {
		const s = strictSchema(name)
		return { schema: s, logins: [fullWorld(s, programsOver(s), []).server] }
	},
	ambient: ordinarySession
})

/** A served case's program over the installation declared `declared`, by its function's name. */
export const programOf = (c: StrictCase, declared: string) =>
	Rec.filter(programsOver(strictSchema(declared)), (_program, name) => name === nameOf(c))

/** Whether a case has a served program: a plain function of a value. */
export const isServed = (c: StrictCase): boolean => Option.isSome(servedFunctionOf(c))

/** Every probe, each pair of keys: the facts every case loads. */
export const probeFacts = Object.freeze({
	Probe: Arr.flatMap(keys, (key) => Arr.map(keys, (other) => ({ key, other })))
})

/** An argument's slot: its first value, its second, or NULL. */
const slots = [0, 1, 2] as const
type Slot = (typeof slots)[number]

/** A call's slots, one per argument in parameter order. */
type Pattern = readonly [Slot, Slot]

/** Every pattern of a call's two arguments. */
export const patterns: ReadonlyArray<Pattern> = Arr.flatMap(slots, (x) =>
	Arr.map(slots, (y): Pattern => [x, y])
)

/** A pattern's NULL arguments: whether one is. */
export const anyNull = (p: Pattern): boolean => p[0] === 2 || p[1] === 2

/** The slot a probe's key reads: Pick's row at k0 and k1, NULL at k2. */
const slotOfKey = (key: KeyHandle): Slot => (key === "k0" ? 0 : key === "k1" ? 1 : 2)

/** Each argument value of a signature at its slots, as SQL: an unknown literal PostgreSQL types as the parameter. */
const argumentSql: {
	readonly [S in Signature]: readonly [readonly [string, string], readonly [string, string]]
} = {
	plain: [
		["'1'", "'2'"],
		["'x'", "'yz'"]
	],
	coded: [
		[
			"pg_catalog.sha256(pg_catalog.convert_to('x', 'UTF8'))",
			"pg_catalog.sha256(pg_catalog.convert_to('yz', 'UTF8'))"
		],
		["'0'", "'1'"]
	]
}

/** An argument at its slot as SQL, NULL at slot 2. */
const slotSql = (values: readonly [string, string], slot: Slot): string =>
	slot === 2 ? "NULL" : values[slot]

/** A call's direct SQL, as the owner calls the installed function by its arguments' names. */
const directSql = (schemaName: string, c: StrictCase, p: Pattern): string => {
	const [first, second] = argumentsOf[c.signature]
	const [firstValues, secondValues] = argumentSql[c.signature]
	const called = `${quoteIdent(schemaName)}.${quoteIdent(installedName(nameOf(c)))}(${first} => ${slotSql(firstValues, p[0])}, ${second} => ${slotSql(secondValues, p[1])})`
	return c.returns === "value"
		? `SELECT ${called} AS "v"`
		: `SELECT r."v" AS "v" FROM ${called} AS r`
}

/** What a call answered: its value, NULL among them, the rows' values, each NULL or a value, or the failure's SQLSTATE. */
export type Answer =
	| { readonly kind: "value"; readonly value: number | null }
	| { readonly kind: "rows"; readonly values: ReadonlyArray<number | null> }
	| { readonly kind: "raised"; readonly code: string }

/** A cell of an answer: a number, or NULL. */
const cellOf = (cell: unknown): number | null =>
	cell === null ? null : typeof cell === "number" ? cell : Number(cell)

/** NULL first, then values ascending: the order two answers' rows compare in. */
const byCell = Order.make<number | null>((x, y) =>
	x === y ? 0 : x === null ? -1 : y === null ? 1 : x < y ? -1 : 1
)

/** PostgreSQL's direct call of a case's function at a pattern, as the owner: the oracle. */
export const directAnswer = (
	admin: PgConnection,
	schemaName: string,
	c: StrictCase,
	p: Pattern
): Effect.Effect<Answer> =>
	admin.query(directSql(schemaName, c, p), []).pipe(
		Effect.map((answered): Answer => {
			const values = Arr.map(answered.rows, (row) => cellOf(row["v"]))
			return c.returns === "value"
				? { kind: "value", value: values[0] ?? null }
				: { kind: "rows", values: Arr.sort(values, byCell) }
		}),
		Effect.catchTag("SqlError", (e: SqlError) =>
			e.reason._tag === "ServerError"
				? Effect.succeed<Answer>({ kind: "raised", code: e.reason.fields.code })
				: Effect.die(e)
		)
	)

/** The measure a body answers at values: a + the length of b, or m's code + the 32 octets of a digest. */
const measureAt = (c: StrictCase, p: Pattern): number => {
	const [x, y] = p
	return c.signature === "plain" ? x + 1 + (y === 0 ? 1 : 2) : y + 32
}

/** The body's own answer at a pattern, as its text reads: a failure's SQLSTATE where it raises. */
const bodyAnswer = (c: StrictCase, p: Pattern): Answer => {
	const one = (value: number | null): Answer =>
		c.returns === "value" ? { kind: "value", value } : { kind: "rows", values: [value] }
	if (!anyNull(p)) {
		return one(measureAt(c, p))
	}
	switch (c.behaviour) {
		case "marks":
			return one(7)
		case "nulls":
			return one(null)
		case "raises":
			return { kind: "raised", code: c.language === "sql" ? "22012" : "P0001" }
	}
}

/**
 * What PostgreSQL answers a case's call at a pattern, the declaration's meaning: a strict function's call at a NULL
 * argument NULL, or no row for rows, its body never run; every other call its body's answer.
 */
export const expectedAnswer = (c: StrictCase, p: Pattern): Answer =>
	c.nullInput === "strict" && anyNull(p)
		? c.returns === "value"
			? { kind: "value", value: null }
			: { kind: "rows", values: [] }
		: bodyAnswer(c, p)

/** A body's failure, as its model raises it where the body fails. */
class BodyRaised extends Data.TaggedError("BodyRaised")<{ readonly code: string }> {}

/** A model's cell: a value of the call's result, or NULL. */
const modelCell = (value: number | null): ModelResult => ({
	kind: "value",
	value: value === null ? null : BigInt(value)
})

/** A model argument's value at its slot: the slot's own name, which is all a body's model reads of it. */
const slotValues = ["slot0", "slot1"] as const

/** The pattern a model's arguments are: each argument's slot, NULL at slot 2. */
const patternOfArgs = (c: StrictCase, args: ReadonlyMap<string, ModelArg>): Pattern => {
	const slotOf = (name: string): Slot => {
		const arg = args.get(name)
		if (arg?.kind !== "value") {
			throw new Error(`a value argument ${name}`)
		}
		return arg.value === null ? 2 : arg.value === slotValues[0] ? 0 : 1
	}
	const [first, second] = argumentsOf[c.signature]
	return [slotOf(first), slotOf(second)]
}

/**
 * A case's body as the reference models it (reference/functions.ts BodyModel): its answer at its arguments' pattern,
 * a value or one row of it, raising where the body raises.
 */
const bodyModelOf =
	(c: StrictCase) =>
	(args: ReadonlyMap<string, ModelArg>): ModelResult => {
		const answer = bodyAnswer(c, patternOfArgs(c, args))
		switch (answer.kind) {
			case "value":
				return modelCell(answer.value)
			case "rows":
				return {
					kind: "rows",
					rows: Arr.map(answer.values, (value) => new Map([["v", modelCell(value)]]))
				}
			case "raised":
				throw new BodyRaised({ code: answer.code })
		}
	}

/** A call's model arguments at a pattern, each by its name: its slot's value (slotValues), NULL at slot 2. */
const modelArgsOf = (c: StrictCase, p: Pattern): ReadonlyMap<string, ModelArg> => {
	const at = (slot: Slot): ModelArg => ({
		kind: "value",
		value: slot === 2 ? null : slotValues[slot]
	})
	const [first, second] = argumentsOf[c.signature]
	return new Map([
		[first, at(p[0])],
		[second, at(p[1])]
	])
}

/** A model's result as an answer: a value's cell, or the rows' cells. */
const answerOfModel = (result: ModelResult): Answer => {
	const cell = (r: ModelResult): number | null => {
		if (r.kind !== "value") {
			throw new Error("a cell of a value")
		}
		return r.value === null ? null : Number(r.value)
	}
	switch (result.kind) {
		case "value":
			return { kind: "value", value: cell(result) }
		case "rows":
			return {
				kind: "rows",
				values: Arr.sort(
					Arr.map(result.rows ?? [], (row) => {
						const v = row?.get("v")
						return v === undefined ? null : cell(v)
					}),
					byCell
				)
			}
		case "row":
			throw new Error("a box function returns a value or rows")
	}
}

/**
 * The reference's call of a case's function at a pattern (reference/functions.ts modelledCall), its model the function's
 * own null input beside its body's model: the answer, or the body's failure.
 */
export const referenceAnswer = (c: StrictCase, p: Pattern): Answer =>
	Result.match(
		Result.try({
			try: () =>
				modelledCall(declaredModel(functionOf(c), bodyModelOf(c)), c.returns, modelArgsOf(c, p)),
			catch: (thrown) => thrown
		}),
		{
			onSuccess: answerOfModel,
			onFailure: (thrown): Answer => {
				if (thrown instanceof BodyRaised) {
					return { kind: "raised", code: thrown.code }
				}
				throw thrown
			}
		}
	)

/** The call term of a served case's program as the engine checks it: its filter's one call. */
const servedCall = (c: StrictCase): ScalarExpr => {
	const s = strictSchema("strict_calls_host")
	const program = programsOver(s)[nameOf(c)]
	const desc = program === undefined ? undefined : queryValueDesc(program)
	if (desc === undefined) {
		throw new Error(`the served program of ${nameOf(c)}`)
	}
	const checked = succeeded(
		checkQuery(checking(s), desc, checkOptions(nameOf(c))),
		`${nameOf(c)} checks`
	)
	const calls = (e: ScalarExpr): ReadonlyArray<ScalarExpr> =>
		e.kind === "call" ? [e] : Arr.flatMap(e.args, calls)
	const found = Arr.flatMap(topoOrder(checked.dag), (node) => Arr.flatMap(exprsOf(node), calls))
	const [call, ...more] = found
	if (call === undefined || more.length > 0) {
		throw new Error(`one call in the program of ${nameOf(c)}, not ${found.length}`)
	}
	return call
}

/** Pick's payload at k0 and k1, by field, as the host holds it. */
const pickPayload = { n: [1, 2], t: ["x", "yz"] } as const

/**
 * The host's evaluation of a served case's call (scalar/compute/evaluate.ts) at a probe: its closed reads Pick's, its
 * payload at k0 and k1 and NULL at k2, its columns the probe's keys. NULL, or none where the host has no value.
 */
export const hostAnswers = (
	c: StrictCase
): ReadonlyArray<{
	readonly pattern: Pattern
	readonly answer: "null" | "declined"
}> => {
	const table = predicateTable(servedCall(c))
	const evaluate = compiledExpr(table)
	return Arr.flatMap(keys, (key) =>
		Arr.map(keys, (other) => {
			const handles = { key, other }
			const value = evaluate(
				{
					value: undefined,
					column: (ref) =>
						ref.name === "key" || ref.name === "other" ? handles[ref.name] : undefined,
					closed: (read, args) => {
						const at = args[0] === "k0" ? 0 : args[0] === "k1" ? 1 : 2
						if (read.kind !== "closedAt" || (read.field !== "n" && read.field !== "t")) {
							return undefined
						}
						return at === 2 ? sqlNull : pickPayload[read.field][at]
					},
					param: noParamLeaf
				},
				ProgramPatterns.of(tablePatterns(table))
			)
			return {
				pattern: [slotOfKey(key), slotOfKey(other)] as const,
				answer: value.ok && value.value === sqlNull ? ("null" as const) : ("declined" as const)
			}
		})
	)
}

/** What a served program answers over every probe: the probes it keeps, or its statement's failure. */
export type Served =
	| { readonly kind: "kept"; readonly probes: ReadonlyArray<Pattern> }
	| { readonly kind: "refused"; readonly code: string }

/** A probe as its pattern, the slots its keys read. */
export const probePattern = (key: unknown, other: unknown): Pattern => {
	const slot = (k: unknown): Slot => (k === "k0" ? 0 : k === "k1" ? 1 : 2)
	return [slot(key), slot(other)]
}

/** The order patterns compare in. */
export const byPattern: Order.Order<Pattern> = Order.Tuple([Order.Number, Order.Number])

/**
 * What a served case's program answers, by PostgreSQL's direct calls at each probe's pattern: refused 22004 where a
 * call answers NULL the function was run for, grizzle holding no NULL; refused as PostgreSQL refuses a call; otherwise
 * the probes whose call answers a value, a strict call's NULL at a NULL argument leaving its probe unknown.
 */
export const expectedServed = (
	c: StrictCase,
	direct: ReadonlyArray<{ readonly pattern: Pattern; readonly answer: Answer }>
): Served => {
	const raised = Arr.findFirst(direct, ({ answer }) => answer.kind === "raised")
	if (Option.isSome(raised) && raised.value.answer.kind === "raised") {
		return { kind: "refused", code: raised.value.answer.code }
	}
	const refusedNull = Arr.some(
		direct,
		({ pattern, answer }) =>
			answer.kind === "value" &&
			answer.value === null &&
			!(c.nullInput === "strict" && anyNull(pattern))
	)
	if (refusedNull) {
		return { kind: "refused", code: "22004" }
	}
	return {
		kind: "kept",
		probes: Arr.sort(
			Arr.flatMap(direct, ({ pattern, answer }) =>
				answer.kind === "value" && answer.value !== null ? [pattern] : []
			),
			byPattern
		)
	}
}

export type StrictFeature =
	| `a ${Signature} signature`
	| `a ${ReturnKind} result`
	| `a ${DeclaredLanguage} body`
	| `a ${FunctionNullInput} function`
	| `a body that ${Behaviour} at NULL`
	| "a strict call at a NULL argument, its body never run"
	| "a called call at a NULL argument, its body run"
	| "a strict set-returning call at a NULL argument, no row"
	| "the host's NULL of a strict call at a NULL argument"
	| "a strict filter leaving a probe unknown"
	| "a served call refused"

/** What a case reaches by its axes. */
export const drawnFeatures = (c: StrictCase): ReadonlyArray<StrictFeature> => [
	`a ${c.signature} signature`,
	`a ${c.returns} result`,
	`a ${c.language} body`,
	`a ${c.nullInput} function`,
	`a body that ${c.behaviour} at NULL`
]

/** Every feature of the box. */
export const features: ReadonlyArray<StrictFeature> = [
	...Arr.map(signatures, (s): StrictFeature => `a ${s} signature`),
	...Arr.map(returnKinds, (r): StrictFeature => `a ${r} result`),
	...Arr.map(declaredLanguages, (l): StrictFeature => `a ${l} body`),
	...Arr.map(functionNullInputs, (n): StrictFeature => `a ${n} function`),
	...Arr.map(behaviours, (b): StrictFeature => `a body that ${b} at NULL`),
	"a strict call at a NULL argument, its body never run",
	"a called call at a NULL argument, its body run",
	"a strict set-returning call at a NULL argument, no row",
	"the host's NULL of a strict call at a NULL argument",
	"a strict filter leaving a probe unknown",
	"a served call refused"
]
