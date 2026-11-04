/**
 * Row checks, generated: the CHECK constraint grizzle installs for a row check accepts exactly the rows its predicate
 * holds on.
 *
 * Each case is a predicate over a row of two integers and a short text, drawn from the forms a row check may use:
 * a field compared with a literal or with the other field, BETWEEN (its bounds sometimes reversed, which holds on
 * nothing), an IN list, char_length over the text, the text's equality, inequality and IN, and AND, OR and NOT over
 * them, each leaf written both as a field term's method and as the row's helper. A run installs one relation per case,
 * each with its check, through its first migration (the migrated catalog checked against the fresh install's), and
 * inserts rows of small integers and short texts as the migration identity, a direct SQL writer. A row is stored
 * exactly when the predicate, evaluated here in two-valued logic over the NOT NULL row, holds; otherwise the insert is
 * refused with SQLSTATE 23514 naming the relation's one check constraint. A case of the exploration is one batch of
 * predicates, installed as one schema; every form is a required feature of the exploration.
 */
import { layer } from "@effect/vitest"
import { type Case as SearchCase, drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import {
	array,
	boolean,
	characterOf,
	element,
	type Gen,
	int,
	oneOf,
	string,
	weighted
} from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Duration, Effect, Formatter, Record, String as Str } from "effect"
import { pg } from "#compiler/public/fields.ts"
import { check, relation, type Statement, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { quoteIdent } from "#compiler/sql/print.ts"
import type { Predicate } from "#compiler/types/core/phantom.ts"
import type { RowScalars } from "#compiler/types/schema/statements.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { assert, defined } from "#test/support/assert.ts"
import { installMigrated as install } from "#test/support/install-migrate.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { argumentsOf } from "#test/support/list.ts"
import { indices } from "#test/support/oracle/pick.ts"
import { pgErrorFields } from "#test/support/substrate/errors.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"

type Field = "a" | "b"
type Op = "eq" | "ne" | "lt" | "le" | "gt" | "ge"
type Pred =
	| {
			readonly kind: "compare"
			readonly op: Op
			readonly field: Field
			readonly right: number | Field
			readonly helper: boolean
	  }
	| {
			readonly kind: "between"
			readonly field: Field
			readonly low: number
			readonly high: number
			readonly helper: boolean
	  }
	| {
			readonly kind: "in"
			readonly field: Field
			readonly values: ReadonlyArray<number>
			readonly helper: boolean
	  }
	| { readonly kind: "length"; readonly op: Op; readonly n: number }
	| {
			readonly kind: "text"
			readonly op: "eq" | "ne"
			readonly value: string
			readonly helper: boolean
	  }
	| { readonly kind: "textIn"; readonly values: ReadonlyArray<string>; readonly helper: boolean }
	| { readonly kind: "and" | "or"; readonly args: readonly [Pred, ...Array<Pred>] }
	| { readonly kind: "not"; readonly arg: Pred }

interface Row {
	readonly a: number
	readonly b: number
	readonly t: string
}

/** A case: a predicate and the rows inserted against it. */
interface Case {
	readonly pred: Pred
	readonly rows: ReadonlyArray<Row>
}

const small = int(-3, 3)
const text = string(characterOf(["a", "b", "c"]), { min: 0, max: 3 })
const field = element<Field>(["a", "b"])
const op = element<Op>(["eq", "ne", "lt", "le", "gt", "ge"])

const leaf: Gen<Pred> = oneOf<Pred>([
	(source) => ({
		kind: "compare",
		op: source.draw(op),
		field: source.draw(field),
		right: source.draw(oneOf<number | Field>([small, field])),
		helper: source.draw(boolean)
	}),
	(source) => ({
		kind: "between",
		field: source.draw(field),
		low: source.draw(small),
		high: source.draw(small),
		helper: source.draw(boolean)
	}),
	(source) => ({
		kind: "in",
		field: source.draw(field),
		values: source.draw(array(small, { min: 1, max: 3 })),
		helper: source.draw(boolean)
	}),
	(source) => ({ kind: "length", op: source.draw(op), n: source.draw(int(0, 3)) }),
	(source) => ({
		kind: "text",
		op: source.draw(element<"eq" | "ne">(["eq", "ne"])),
		value: source.draw(text),
		helper: source.draw(boolean)
	}),
	(source) => ({
		kind: "textIn",
		values: source.draw(array(text, { min: 1, max: 3 })),
		helper: source.draw(boolean)
	})
])

/** How deep AND, OR and NOT nest: a leaf three times in five at every level, and only a leaf at the deepest. */
const predDepth = 4

/** A predicate nested at most `depth` levels: a leaf, or AND or OR over one to three predicates, or NOT of one. */
const predGen = (depth: number): Gen<Pred> => {
	if (depth === 0) {
		return leaf
	}
	const inner = predGen(depth - 1)
	return weighted<Pred>([
		[3, leaf],
		[
			1,
			(source) => ({
				kind: source.draw(element<"and" | "or">(["and", "or"])),
				args: [source.draw(inner), ...source.draw(array(inner, { min: 0, max: 2 }))]
			})
		],
		[1, (source) => ({ kind: "not", arg: source.draw(inner) })]
	])
}

const caseGen: Gen<Case> = (source) => ({
	pred: source.draw(predGen(predDepth)),
	rows: source.draw(
		array((row) => ({ a: row.draw(small), b: row.draw(small), t: row.draw(text) }), {
			min: 4,
			max: 8
		})
	)
})

const compare = (o: Op, x: number, y: number): boolean =>
	o === "eq"
		? x === y
		: o === "ne"
			? x !== y
			: o === "lt"
				? x < y
				: o === "le"
					? x <= y
					: o === "gt"
						? x > y
						: x >= y

/** The predicate on a row, in two-valued logic: every field is NOT NULL. */
const holds = (p: Pred, r: Row): boolean => {
	switch (p.kind) {
		case "compare":
			return compare(p.op, r[p.field], typeof p.right === "number" ? p.right : r[p.right])
		case "between":
			return p.low <= r[p.field] && r[p.field] <= p.high
		case "in":
			return p.values.includes(r[p.field])
		case "length":
			return compare(p.op, Array.from(r.t).length, p.n)
		case "text":
			return p.op === "eq" ? r.t === p.value : r.t !== p.value
		case "textIn":
			return p.values.includes(r.t)
		case "and":
			return Arr.every(p.args, (x) => holds(x, r))
		case "or":
			return Arr.some(p.args, (x) => holds(x, r))
		case "not":
			return !holds(p.arg, r)
	}
}

/** The forms a predicate may use: each leaf's kind, operator and writing (a method or a helper). */
type CheckForm =
	| "compare literal"
	| "compare field"
	| `op ${Op}`
	| "method"
	| "helper"
	| "between"
	| "between reversed"
	| "in"
	| "textIn"
	| "in method"
	| "in helper"
	| "length"
	| "text eq"
	| "text ne"
	| "and"
	| "or"
	| "not"

const writing = (helper: boolean): CheckForm => (helper ? "helper" : "method")

/** The forms a predicate uses, the exploration's features. */
const forms = (p: Pred): ReadonlyArray<CheckForm> => {
	switch (p.kind) {
		case "compare":
			return [
				typeof p.right === "number" ? "compare literal" : "compare field",
				`op ${p.op}`,
				writing(p.helper)
			]
		case "between":
			return p.low > p.high
				? ["between", "between reversed", writing(p.helper)]
				: ["between", writing(p.helper)]
		case "in":
		case "textIn":
			return [p.kind, p.helper ? "in helper" : "in method"]
		case "length":
			return ["length", `op ${p.op}`]
		case "text":
			return [p.op === "eq" ? "text eq" : "text ne", writing(p.helper)]
		case "and":
		case "or":
			return [p.kind, ...Arr.flatMap(p.args, forms)]
		case "not":
			return ["not", ...forms(p.arg)]
	}
}

const requiredForms: Arr.NonEmptyReadonlyArray<CheckForm> = [
	"compare literal",
	"compare field",
	"op eq",
	"op ne",
	"op lt",
	"op le",
	"op gt",
	"op ge",
	"method",
	"helper",
	"between",
	"between reversed",
	"in",
	"textIn",
	"in method",
	"in helper",
	"length",
	"text eq",
	"text ne",
	"and",
	"or",
	"not"
]

const Txt = str.regex("^[a-c]{0,3}$")
const itemOf = (name: string) =>
	relation(name, { id: pg.integer, a: pg.integer, b: pg.integer, t: Txt }, ["id"])
type Item = ReturnType<typeof itemOf>
type ItemRow = RowScalars<Item>

/** The predicate as the row check's callback writes it, each leaf as a method or as the row's helper. */
const build = (p: Pred, r: ItemRow) => {
	const go = (q: Pred): Predicate => {
		switch (q.kind) {
			case "compare": {
				const right = typeof q.right === "number" ? q.right : r[q.right]
				if (q.helper) {
					return r[q.op](r[q.field], right)
				}
				return r[q.field][q.op](right)
			}
			case "between":
				return q.helper ? r.between(r[q.field], q.low, q.high) : r[q.field].between(q.low, q.high)
			case "in":
				return q.helper ? r.in(r[q.field], q.values) : r[q.field].in(q.values)
			case "length":
				return r.charLength(r.t)[q.op](q.n)
			case "text":
				return q.helper ? r[q.op](r.t, q.value) : r.t[q.op](q.value)
			case "textIn":
				return q.helper ? r.in(r.t, q.values) : r.t.in(q.values)
			case "and":
			case "or": {
				const [first, ...rest] = q.args
				return r[q.kind](go(first), ...argumentsOf(Arr.map(rest, go)))
			}
			case "not":
				return r.not(go(q.arg))
		}
	}
	return go(p)
}

const literal = (s: string): string => `'${Str.replaceAll("'", "''")(s)}'`

/** Predicates per batch, each its own relation of the batch's one schema. */
const cases = 48

const batch = array(caseGen, { min: cases, max: cases })

/**
 * One run: the floor and the rotating stream draw one batch each. A shrink candidate is one migration of its own, so a
 * failing batch's shrink is bounded to 60 candidates.
 */
const rowChecks = explore(
	{
		suite: "laws/row-checks",
		draw: drawn(batch),
		literal: Formatter.format,
		coverage: required<CheckForm>(requiredForms, { cases: 1, sense: notesOnly }),
		kept: [],
		runs: 1,
		shrink: { kind: "bounded", candidates: 60 },
		concurrency: 1,
		steerEvery: 16,
		caseHang: Duration.minutes(2)
	},
	(b, c) => checkBatch(b, c.noteAll)
)

/** Installs a batch's predicates as one schema, and inserts each predicate's rows as a direct writer. */
const checkBatch = (b: ReadonlyArray<Case>, note: SearchCase<CheckForm>["noteAll"]) =>
	Effect.gen(function* () {
		const items = Arr.map(indices(b.length), (i) => itemOf(`Item${i}`))
		const statements: Array<Statement> = Arr.flatMap(b, (s, i) => {
			const item = items[i]
			return item === undefined ? [] : [check(`Holds${i}`, item, (r) => build(s.pred, r))]
		})
		const installed = yield* install(
			schema(
				"Checks",
				Record.fromEntries(Arr.map(items, (item, i) => [`Item${i}`, item])),
				statements
			),
			{ ambient: ordinarySession, label: "checks", logins: [], extensions: [] }
		)
		const substrate = yield* Substrate
		const session = yield* substrate.session({ ...ownerSession(), label: "checks writer" })
		const names = namesOf(installed)
		for (const [i, s] of b.entries()) {
			note(forms(s.pred))
			const name = installed.names.relation(`Item${i}`)
			const columns = Arr.join(
				Arr.map(["id", "a", "b", "t"], (c) => quoteIdent(installed.names.column(`Item${i}`, c))),
				", "
			)
			const table = `${quoteIdent(name.schema)}.${quoteIdent(name.name)}`
			/** The relation's one check constraint is its row check's, which names a refusal. */
			const constraint = names.constraintOf(
				names.lawOf(defined(statements[i], `the row check of Item${i}`)),
				"TableCheck"
			)
			const constraints = yield* session.values(
				`SELECT conname::text FROM pg_catalog.pg_constraint WHERE conrelid = '${table}'::regclass AND contype = 'c'`,
				[]
			)
			assert.deepEqual(
				constraints,
				[[constraint]],
				`${table} has one check constraint, its row check's`
			)
			for (const [j, row] of s.rows.entries()) {
				const where = `predicate ${i}, ${Formatter.format(s.pred)}, on ${Formatter.format(row)}`
				const inserted = yield* Effect.result(
					session.query(
						`INSERT INTO ${table} (${columns}) VALUES (${j}, ${row.a}, ${row.b}, ${literal(row.t)})`,
						[]
					)
				)
				const lawful = holds(s.pred, row)
				assert.equal(
					inserted._tag,
					lawful ? "Success" : "Failure",
					`${where} is ${lawful ? "refused" : "stored"}`
				)
				const fields = inserted._tag === "Failure" ? pgErrorFields(inserted.failure) : undefined
				assert.equal(fields?.code, lawful ? undefined : "23514", where)
				assert.equal(fields?.constraint, lawful ? undefined : constraint, where)
			}
		}
	})

layer(Substrate.layer)("row checks, generated", (it) => {
	it.effect("the installed CHECK stores exactly the rows the predicate holds on", (ctx) =>
		searched(ctx, rowChecks)
	)
})
