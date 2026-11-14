/**
 * Row checks, generated: the CHECK constraint grizzle installs for a row check accepts exactly the rows its predicate
 * holds on, under the name constraintNamesOf's lookup gives its law.
 *
 * Each case is a predicate over a row of two integers and a short text, drawn from the forms a row check may use:
 * a field compared with a literal or with the other field, BETWEEN (its bounds sometimes reversed, which holds on
 * nothing), an IN list, char_length over the text, the text's equality, inequality and IN, and AND, OR and NOT over
 * them, each leaf written both as a field term's method and as the row's helper. A run installs one relation per case,
 * each with its check, through its first migration (the migrated catalog checked against the fresh install's), and
 * inserts rows of small integers and short texts as the migration identity, a direct SQL writer. A row is stored
 * exactly when the predicate, evaluated here in two-valued logic over the NOT NULL row, holds; otherwise the insert is
 * refused with SQLSTATE 23514 naming the row check's constraint. A case of the exploration is one batch of
 * predicates, installed as one schema; every form is a required feature of the exploration.
 *
 * Each check's name is drawn from a pool of the batch's, so relations share names as an app's do: words, lowercase
 * words, acronyms and digit runs, joined directly, so that a case change, an acronym's last capital or a digit run's
 * edge splits them, or by one or two underscores, sometimes with an underscore last. The row check's constraint in
 * the catalog, and the constraint each refusal names, is the name constraintNamesOf's lookup gives the check's law as
 * lawsOf lists it: a caller that spells the name itself, or derives it otherwise, is never needed.
 *
 * Oracle: a second implementation, `holds`, the predicate evaluated on the host. Features: every predicate form and
 * every spelling of a check name, each a required situation. Plant: ~/.cache/grizzle-release/BR09/plants/
 * checks-between-reversed.patch, BETWEEN printed SYMMETRIC, stores a row inside reversed bounds the predicate refuses.
 */
import { type Case as SearchCase, drawn, explore } from "@bjornpagen/testing/explore"
import { required } from "@bjornpagen/testing/features"
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
} from "@bjornpagen/testing/gen"
import { notesOnly } from "@bjornpagen/testing/sense"
import { searched } from "@bjornpagen/testing/vitest"
import { layer } from "@effect/vitest"
import { Array as Arr, Effect, Formatter, Record, String as Str } from "effect"
import { indices } from "#compiler/core/array.ts"
import { pg } from "#compiler/public/fields.ts"
import {
	check,
	constraintNamesOf,
	lawsOf,
	relation,
	type Statement,
	schema
} from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { quoteIdent } from "#compiler/sql/print.ts"
import type { Predicate } from "#compiler/types/core/phantom.ts"
import type { RowScalars } from "#compiler/types/schema/statements.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { assert, defined, nonEmpty } from "#test/support/assert.ts"
import { installMigrated as install } from "#test/support/install-migrate.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { argumentsOf } from "#test/support/list.ts"
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

/** How a check name spells one of its segments: a capitalized word, a lowercase word, an acronym or a digit run. */
type Spelling = "word" | "lower" | "acronym" | "digits"

/** What joins a segment to the one before it: nothing, one underscore or two. */
type Join = "" | "_" | "__"

/** A drawn check name, a letter first, beside each of its segments' spellings and the joins before them. */
interface CheckName {
	readonly text: string
	readonly segments: ReadonlyArray<{ readonly spelling: Spelling; readonly join: Join }>
	readonly trailing: boolean
}

/** A case: a predicate, its check's name, and the rows inserted against it. */
interface Case {
	readonly pred: Pred
	readonly name: CheckName
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

const lowercase = nonEmpty(Arr.fromIterable("abcdefghijklmnopqrstuvwxyz"), "lowercase letters")
const uppercase = nonEmpty(Arr.fromIterable("ABCDEFGHIJKLMNOPQRSTUVWXYZ"), "capital letters")
const digits = nonEmpty(Arr.fromIterable("0123456789"), "digits")

/** One segment as `spelling` spells it, at most six characters. */
const segmentOf = (spelling: Spelling): Gen<string> => {
	switch (spelling) {
		case "word":
			return (source) =>
				`${source.draw(characterOf(uppercase))}${source.draw(string(characterOf(lowercase), { min: 1, max: 5 }))}`
		case "lower":
			return string(characterOf(lowercase), { min: 1, max: 6 })
		case "acronym":
			return string(characterOf(uppercase), { min: 2, max: 4 })
		case "digits":
			return string(characterOf(digits), { min: 1, max: 3 })
	}
}

const letterLed = element<Spelling>(["word", "lower", "acronym"])
const anySpelling = element<Spelling>(["word", "lower", "acronym", "digits"])
const join = element<Join>(["", "_", "__"])

/** A check name of one to four segments, the first led by a letter, its conversion far inside 63 bytes. */
const checkNameGen: Gen<CheckName> = (source) => {
	const first = source.draw(letterLed)
	const rest = source.draw(
		array((s) => ({ spelling: s.draw(anySpelling), join: s.draw(join) }), { min: 0, max: 3 })
	)
	const segments = [{ spelling: first, join: "" as const }, ...rest]
	const trailing = source.draw(boolean)
	const spelled = Arr.map(segments, (g) => `${g.join}${source.draw(segmentOf(g.spelling))}`)
	return { text: `${Arr.join(spelled, "")}${trailing ? "_" : ""}`, segments, trailing }
}

const caseGen =
	(names: Arr.NonEmptyReadonlyArray<CheckName>): Gen<Case> =>
	(source) => ({
		pred: source.draw(predGen(predDepth)),
		name: source.draw(element(names)),
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

/** How the batch's check names are spelled: each segment's spelling, each join, an underscore last, and one name on two
 * relations. */
type NameForm =
	| `name ${Spelling}`
	| "name joined directly"
	| "name joined by _"
	| "name joined by __"
	| "name ending in _"
	| "a name two relations share"

const joinForms = {
	"": "name joined directly",
	_: "name joined by _",
	__: "name joined by __"
} as const satisfies Readonly<Record<Join, NameForm>>

/** The spellings a check name uses. */
const nameForms = (n: CheckName): ReadonlyArray<NameForm> => [
	...Arr.map(n.segments, (g): NameForm => `name ${g.spelling}`),
	...Arr.map(Arr.drop(n.segments, 1), (g) => joinForms[g.join]),
	...(n.trailing ? ["name ending in _" as const] : [])
]

type Feature = CheckForm | NameForm

const requiredForms: Arr.NonEmptyReadonlyArray<Feature> = [
	"name word",
	"name lower",
	"name acronym",
	"name digits",
	"name joined directly",
	"name joined by _",
	"name joined by __",
	"name ending in _",
	"a name two relations share",
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

/** A batch: a pool of one to twelve check names, and its cases, each check named from the pool. */
const batch: Gen<ReadonlyArray<Case>> = (source) => {
	const names: Arr.NonEmptyReadonlyArray<CheckName> = [
		source.draw(checkNameGen),
		...source.draw(array(checkNameGen, { min: 0, max: 11 }))
	]
	return source.draw(array(caseGen(names), { min: cases, max: cases }))
}

/**
 * One run: the floor and the rotating stream draw one batch each. A shrink candidate is one migration of its own, so a
 * failing batch's shrink is bounded to 60 candidates.
 */
const rowChecks = explore(
	{
		oracle: {
			kind: "second-implementation",
			name: "the predicate evaluated on the host in two-valued logic over the NOT NULL row (holds)"
		},
		suite: "laws/row-checks",
		draw: drawn(batch),
		literal: Formatter.format,
		coverage: required<Feature>(requiredForms, { cases: 1, sense: notesOnly }),
		kept: [],
		runs: 1,
		shrink: { kind: "bounded", candidates: 60 },
		concurrency: 1,
		steerEvery: 16,
		caseHang
	},
	(b, c) => checkBatch(b, c.noteAll)
)

/**
 * Installs a batch's predicates as one schema, and inserts each predicate's rows as a direct writer: each relation's one
 * check constraint, and each refusal's, is the name constraintNamesOf's lookup gives the check's law.
 */
const checkBatch = (b: ReadonlyArray<Case>, note: SearchCase<Feature>["noteAll"]) =>
	Effect.gen(function* () {
		const items = Arr.map(indices(b.length), (i) => itemOf(`Item${i}`))
		const statements: Array<Statement> = Arr.flatMap(b, (s, i) => {
			const item = items[i]
			return item === undefined ? [] : [check(s.name.text, item, (r) => build(s.pred, r))]
		})
		const declared = schema(
			"Checks",
			Record.values(Record.fromEntries(Arr.map(items, (item, i) => [`Item${i}`, item]))),
			statements
		)
		const laws = lawsOf(declared)
		const constraintNameOf = constraintNamesOf(declared)
		const installed = yield* install(declared, {
			ambient: ordinarySession,
			label: "checks",
			logins: [],
			extensions: []
		})
		const substrate = yield* Substrate
		const session = yield* substrate.session({ ...ownerSession(), label: "checks writer" })
		const names = namesOf(installed)
		const spelled = Arr.map(b, (s) => s.name.text)
		if (new Set(spelled).size < spelled.length) {
			note(["a name two relations share"])
		}
		for (const [i, s] of b.entries()) {
			note(forms(s.pred))
			note(nameForms(s.name))
			const name = installed.names.relation(`Item${i}`)
			const columns = Arr.join(
				Arr.map(["id", "a", "b", "t"], (c) => quoteIdent(installed.names.column(`Item${i}`, c))),
				", "
			)
			const table = `${quoteIdent(name.schema)}.${quoteIdent(name.name)}`
			/** The row check's constraint, which names a refusal. */
			const constraint = names.constraintOf(
				names.lawOf(defined(statements[i], `the row check of Item${i}`)),
				"TableCheck"
			)
			const constraints = yield* session.values(
				`SELECT conname::text FROM pg_catalog.pg_constraint WHERE conrelid = '${table}'::regclass AND contype = 'c'`,
				[]
			)
			const [law, ...more] = Arr.flatMap(laws, (l) =>
				l.kind === "check" && l.relation === `Item${i}` ? [l] : []
			)
			assert.ok(
				law !== undefined && more.length === 0,
				`lawsOf lists one check law of Item${i}, its row check's`
			)
			const exported = constraintNameOf(law)
			assert.equal(
				exported,
				constraint,
				`constraintNamesOf names the row check of Item${i} as the installation's naming does`
			)
			assert.ok(
				Arr.some(constraints, (r) => r[0] === exported),
				`${table}'s row check ${Formatter.format(s.name.text)} is installed as constraintNamesOf names it`
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
				assert.equal<string | undefined>(fields?.constraint, lawful ? undefined : exported, where)
			}
		}
	})

layer(Substrate.layer)("row checks, generated", (it) => {
	it.effect("the installed CHECK stores exactly the rows the predicate holds on", (ctx) =>
		searched(ctx, rowChecks)
	)
})
