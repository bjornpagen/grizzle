import { layer } from "@effect/vitest"
import { type Case, drawn } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, type Gen, int } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { searched } from "@grizzle/testing/vitest"
import {
	Array as Arr,
	Duration,
	Effect,
	Formatter,
	Option,
	Record as Rec,
	String as Str
} from "effect"
import { refreshReport } from "#adapter/refresh/index.ts"
import { appendAll } from "#compiler/core/array.ts"
import { login } from "#compiler/program/workload/login.ts"
import { pg } from "#compiler/public/fields.ts"
import type { AnyDerived, AnySchema } from "#compiler/public/schema.ts"
import { relation } from "#compiler/public/schema.ts"
import { type QueryValue, queryOver as query, varsOver as v } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { derived } from "#compiler/schema/relation.ts"
import { schema } from "#compiler/schema/schema.ts"
import { role } from "#compiler/schema/world.ts"
import { quoteIdent } from "#compiler/sql/print.ts"
import { pick } from "#test/pg/derived/oracle/gen.ts"
import { installDerived, type Opened, openCaseDb, reload } from "#test/pg/derived/oracle/harness.ts"
import { assert, defined } from "#test/support/assert.ts"
import { whereIndex } from "#test/support/oracle/pick.ts"
import { oracleCheck } from "#test/support/oracle/runner.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

import { regex } from "arkregex"
/** The menu's schemas differ per case, so their definitions drive the builder runtime as a JavaScript caller does,
 * over the typed Amount; the typed facade is the type tests' subject.
 *
 * The exceptions to "a refresh with no base change writes nothing": order-dependent float aggregates and
 * equal-not-identical numerics.
 *
 * The generated oracle keeps one spelling per value and exact doubles, so there no refresh without a
 * definition change writes anything. Here the facts are chosen to make the exceptions possible: an unconstrained
 * numeric whose equal values are spelled differently (1, 1.0, 1.00), which min and max return whichever of them they
 * meet last, and doubles that are not exact binary fractions, whose sum and mean depend on the order PostgreSQL adds
 * them in. Each case installs Amount with generated facts and derived relations drawn from a menu of such definitions,
 * refreshes them, and then:
 *
 * - checks every view against its definition evaluated by the conservative lowering on one snapshot, modulo native
 *   equality: numerics compared by value, the float aggregates within a relative 1e-12, every other column exactly
 *   (raw text cannot be compared);
 * - reloads the same facts in another physical order, refreshes again with no base change, and checks that every row
 *   the refresh wrote is one whose record image changed only in those ways: the same group, a numeric equal but not
 *   byte-identical, or a float aggregate rounded differently (a value that is equal but not byte-identical counts as
 *   changed and its row is deleted and reinserted, which is correct); every other row keeps its tuple. */
type Vars = ReturnType<typeof v>

/** How a column is compared: exactly, by numeric value, or as an order-dependent float aggregate. */
type Compare = "exact" | "numeric" | "float"

interface MenuItem {
	readonly name: string
	readonly level: 1 | 2
	readonly columns: Readonly<Record<string, Compare>>
	readonly build: (over: AnySchema, lower: Readonly<Record<string, AnyDerived>>) => QueryValue
}

const Amount = relation(
	"Amount",
	{ id: pg.integer, grp: pg.integer, amount: pg.numeric, ratio: pg.float8 },
	["id"]
)

const grouped =
	(head: (r: RuleValue, x: Vars) => Readonly<Record<string, unknown>>) =>
	(over: AnySchema): QueryValue =>
		query(over).rule((r: RuleValue) => {
			const x = v(Amount, "amount")
			return r
				.match(Amount, { id: x["id"], grp: x["grp"], amount: x["amount"], ratio: x["ratio"] })
				.find({ grp: x["grp"], ...head(r, x) })
		})

const menu: ReadonlyArray<MenuItem> = [
	{
		name: "Top",
		level: 1,
		columns: { grp: "exact", top: "numeric" },
		build: grouped((r, x) => ({ top: r.max(x["amount"]) }))
	},
	{
		name: "Low",
		level: 1,
		columns: { grp: "exact", low: "numeric" },
		build: grouped((r, x) => ({ low: r.min(x["amount"]) }))
	},
	{
		name: "Totals",
		level: 1,
		columns: { grp: "exact", total: "numeric", drift: "float" },
		build: grouped((r, x) => ({ total: r.sum(x["amount"]), drift: r.sum(x["ratio"]) }))
	},
	{
		name: "Means",
		level: 1,
		columns: { grp: "exact", amean: "numeric", rmean: "float", n: "exact" },
		build: grouped((r, x) => ({
			amean: r.mean(x["amount"]),
			rmean: r.mean(x["ratio"]),
			n: r.count()
		}))
	},
	{
		/** A level-2 sum over a level-1 float aggregate: one fact, keyed by its count. */
		name: "Overall",
		level: 2,
		columns: { groups: "exact", drift: "float" },
		build: (over, lower) =>
			query(over).rule((r: RuleValue) => {
				const t = v(lower["Totals"], "totals")
				return r
					.match(lower["Totals"], { grp: t["grp"], drift: t["drift"] })
					.find({ groups: r.count(), drift: r.sum(t["drift"]) })
			})
	}
]

const spellings = ["1", "1.0", "1.00", "2.5", "2.50", "0", "0.000", "-3.25", "-3.250"]
const ratios = [0.1, 0.2, 0.3, 0.7, 1.1, 2.675]

interface Sketch {
	readonly facts: ReadonlyArray<{
		readonly grp: number
		readonly amount: number
		readonly ratio: number
	}>
	/** Which menu items the schema declares, a bit each; Overall brings Totals. */
	readonly items: number
	readonly shuffle: number
}

const sketchGen: Gen<Sketch> = (source) => ({
	/** Up to fourteen facts over three groups: room for a group to hold several spellings of one value and several
	 * inexact ratios. */
	facts: source.draw(
		array(
			(fact) => ({
				grp: fact.draw(int(0, 2)),
				amount: fact.draw(int(0, spellings.length - 1)),
				ratio: fact.draw(int(0, ratios.length - 1))
			}),
			{ min: 1, max: 14 }
		)
	),
	items: source.draw(int(1, 31)),
	shuffle: source.draw(int(0, 1_000_000))
})

const chosen = (sketch: Sketch): ReadonlyArray<MenuItem> => {
	const picked = whereIndex(menu, (i) => (sketch.items >> i) % 2 === 1)
	const names = new Set(Arr.map(picked, (m) => m.name))
	return names.has("Overall") && !names.has("Totals")
		? Arr.filter(menu, (m) => picked.includes(m) || m.name === "Totals")
		: picked
}

const build = (name: string, items: ReadonlyArray<MenuItem>) => {
	const Base = schema(name, { Amount }, [], [])
	const level1: Record<string, AnyDerived> = {}
	for (const m of Arr.filter(items, (i) => i.level === 1)) {
		level1[m.name] = derived(m.name, m.build(Base, {}), [])
	}
	let top: AnySchema = schema.extend(Base, level1, [], [])
	const level2: Record<string, AnyDerived> = {}
	for (const m of Arr.filter(items, (i) => i.level === 2)) {
		level2[m.name] = derived(m.name, m.build(top, level1), [])
	}
	if (Rec.keys(level2).length > 0) {
		top = schema.extend(top, level2, [], [])
	}
	const values: Readonly<Record<string, AnyDerived>> = { ...level1, ...level2 }
	/** The role that refreshes every derived relation, holding them and Amount whole, in the login `server`. */
	const refresher = role(top, "refresher", { Amount, ...values }, { refresh: Rec.keys(values) })
	return { top, values, refresher, server: login(top, "server", [refresher]) }
}

const factsOf = (sketch: Sketch) => ({
	Amount: Arr.map(sketch.facts, (f, i) => ({
		id: i + 1,
		grp: f.grp,
		amount: pick(spellings, f.amount),
		ratio: pick(ratios, f.ratio)
	}))
})

/** A permutation of `xs` picked by `shuffle`, never the identity when there are two or more. */
const permuted = <A>(xs: ReadonlyArray<A>, shuffle: number): ReadonlyArray<A> => {
	const pool = [...xs]
	const out: Array<A> = []
	let s = shuffle
	while (pool.length > 0) {
		appendAll(out, pool.splice(s % pool.length, 1))
		s = Math.floor(s / Math.max(pool.length, 1)) + 13
	}
	return out.length > 1 && Arr.every(out, (x, i) => x === xs[i]) ? Arr.reverse([...xs]) : out
}

/** An exact decimal's value as a canonical text: no trailing fractional zeros, no negative zero. */
const decimalValue = (text: string): string => {
	const negative = Str.startsWith("-")(text)
	const [whole, fraction = ""] = Str.split(negative ? Str.slice(1)(text) : text, ".")
	const w = Str.replace(regex("^0+(?=.)"), "")(whole)
	const f = Str.replace(regex("0+$"), "")(fraction)
	const body = f.length > 0 ? `${w}.${f}` : w
	return negative && body !== "0" ? `-${body}` : body
}

const close = (a: string, b: string): boolean => {
	const x = Number(a)
	const y = Number(b)
	return x === y || Math.abs(x - y) <= 1e-12 * Math.max(Math.abs(x), Math.abs(y))
}

/** Whether two rows are equal modulo native equality and float-aggregate rounding. */
const equivalent = (columns: Readonly<Record<string, Compare>>, a: Row, b: Row): boolean =>
	Arr.every(Rec.toEntries(columns), ([c, how]) => {
		const x = columnText(a, c)
		const y = columnText(b, c)
		return how === "exact"
			? x === y
			: how === "numeric"
				? decimalValue(x) === decimalValue(y)
				: close(x, y)
	})

/** The columns compared exactly identify a row's group. */
const groupOf = (columns: Readonly<Record<string, Compare>>, row: Row): string =>
	Arr.join(
		Arr.map(
			Arr.filter(Rec.toEntries(columns), ([, how]) => how === "exact"),
			([c]) => columnText(row, c)
		),
		"|"
	)

interface Row {
	readonly values: Readonly<Record<string, string>>
	readonly text: string
	readonly tuple: string
}

/** A row's text of a column it was read with; any other column is a defect of the test. */
const columnText = (row: Row, column: string): string => {
	const value = row.values[column]
	if (value === undefined) {
		throw new Error(`no column ${column} in ${row.text}`)
	}
	return value
}

const rowsOf = (o: Opened, item: MenuItem, from: "view" | "definition") =>
	Effect.gen(function* () {
		const s = yield* Substrate
		const names = Rec.keys(item.columns)
		const source =
			from === "view" ? `${o.view(item.name)} AS "r1"` : `(${o.definition(item.name).sql}) AS "r1"`
		const column = (c: string) =>
			from === "view"
				? `"r1".${quoteIdent(o.installed.names.column(item.name, c))}`
				: `"r1".${quoteIdent(c)}`
		const tuple = from === "view" ? `"r1".ctid::text || '/' || "r1".xmin::text` : `''::text`
		const result = yield* s.admin.query(
			`SELECT ${Arr.join(
				Arr.map(names, (c, i) => `${column(c)}::text AS "v${i}"`),
				", "
			)}, ${tuple} AS "tuple" FROM ${source}`,
			[]
		)
		return Arr.map(result.rows, (r): Row => {
			const read = Arr.map(names, (c, i) => [c, String(r[`v${i}`])] as const)
			return {
				values: Rec.fromEntries(read),
				text: Arr.join(
					Arr.map(read, ([, text]) => text),
					"\u0000"
				),
				tuple: String(r["tuple"])
			}
		})
	})

const cases = 300

/** What a case's reordered reload reaches: a row kept, a row rewritten, and each exception among the rewrites, a numeric
 * min or max returned in another spelling and a float sum or mean rounded differently. */
type AllowanceFeature =
	| "row kept"
	| "row rewritten"
	| "numeric spelling rewritten"
	| "float aggregate rewritten"

const situations: Arr.NonEmptyReadonlyArray<AllowanceFeature> = [
	"row kept",
	"row rewritten",
	"numeric spelling rewritten",
	"float aggregate rewritten"
]

/** The same facts, every base row rewritten in another physical order: no base change. */
const property = (sketch: Sketch, c: Case<AllowanceFeature>) =>
	Effect.scoped(
		Effect.gen(function* () {
			const items = chosen(sketch)
			const declared = build("Alw", items)
			const facts = factsOf(sketch)
			const o = yield* installDerived(declared.top, facts, "dallow", [declared.server])
			const rebuilt = build(o.installed.declared, items)
			const { ctx } = yield* openCaseDb(o, rebuilt.server.roles.refresher)
			const named = Arr.map(items, (m) => rebuilt.values[m.name])
			const all = Arr.isReadonlyArrayNonEmpty(named)
				? named
				: yield* Effect.die(new Error("a sketch picks at least one derived relation"))
			yield* refreshReport(ctx, all)
			for (const item of items) {
				const stored = yield* rowsOf(o, item, "view")
				const definition = yield* rowsOf(o, item, "definition")
				assert.equal(stored.length, definition.length, `${item.name} has its definition's rows`)
				for (const row of stored) {
					const match = Arr.filter(
						definition,
						(d) => groupOf(item.columns, d) === groupOf(item.columns, row)
					)
					assert.equal(match.length, 1, `${item.name} group ${groupOf(item.columns, row)}`)
					const definedRow = defined(
						match[0],
						`${item.name}: the row of its group in the definition`
					)
					assert.ok(
						equivalent(item.columns, row, definedRow),
						`${item.name}: ${row.text} equals its definition's ${definedRow.text} modulo native equality`
					)
				}
			}
			const before = new Map<string, ReadonlyArray<Row>>()
			for (const item of items) {
				before.set(item.name, yield* rowsOf(o, item, "view"))
			}
			yield* reload(o, { Amount: permuted(facts.Amount, sketch.shuffle) })
			const report = yield* refreshReport(ctx, all)
			assert.ok(
				Arr.every(report.statements, (s) => s.concurrently),
				"a refresh of populated views runs every statement concurrently"
			)
			for (const item of items) {
				const then = before.get(item.name) ?? []
				const now = yield* rowsOf(o, item, "view")
				const kept = new Set(Arr.map(then, (r) => r.tuple))
				for (const row of now) {
					if (kept.has(row.tuple)) {
						c.note("row kept")
						continue
					}
					/** A row the refresh wrote: it replaced the row of its group, whose record image differs. */
					const group = Arr.findFirst(
						then,
						(r) => groupOf(item.columns, r) === groupOf(item.columns, row)
					)
					assert.ok(Option.isSome(group), `${item.name}: ${row.text} replaced a row of its group`)
					const old = group.value
					assert.notEqual(
						old.text,
						row.text,
						`${item.name}: a rewritten row's record image changed`
					)
					assert.ok(
						equivalent(item.columns, old, row),
						`${item.name}: ${old.text} became ${row.text}, which is more than a spelling or float rounding`
					)
					assert.ok(
						!Arr.some(now, (r) => r.tuple === old.tuple),
						`${item.name}: the old tuple is gone`
					)
					c.note("row rewritten")
					const changed = Arr.filter(
						Rec.toEntries(item.columns),
						([column]) => old.values[column] !== row.values[column]
					)
					if (Arr.some(changed, ([, how]) => how === "numeric")) {
						c.note("numeric spelling rewritten")
					}
					if (Arr.some(changed, ([, how]) => how === "float")) {
						c.note("float aggregate rewritten")
					}
				}
				assert.equal(now.length, then.length, `${item.name} keeps its groups`)
			}
		})
	)

layer(Substrate.layer, { excludeTestServices: true })(
	"a refresh with no base change writes only order-dependent float aggregates and equal-not-identical numerics",
	(it) => {
		it.effect(
			`${cases} generated cases: a reordered reload rewrites only rows equal modulo spelling and float rounding`,
			(ctx) =>
				searched(
					ctx,
					oracleCheck(
						drawn(sketchGen),
						{
							suite: "derived/allowance",
							literal: Formatter.format,
							coverage: required<AllowanceFeature>(situations, { cases: cases, sense: notesOnly }),
							kept: [],
							runs: cases,
							shrink: { kind: "complete" },
							caseHang: Duration.minutes(2),
							perturb: "planner"
						},
						property
					)
				),
			600_000
		)
	}
)
