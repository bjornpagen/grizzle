import { Array as Arr, Effect, Formatter, Option } from "effect"
import type { PlanNode } from "#bench/harness/explain.ts"
import {
	type CaseRecord,
	defineGate,
	equivalence,
	type GateCheck,
	mechanism,
	type VerdictInput
} from "#bench/harness/gate.ts"

import {
	compareVariants,
	measureVariant,
	rowsAgree,
	type VariantStatement
} from "#bench/harness/variant.ts"

import {
	agrees,
	autocommit,
	type Compiled,
	compile,
	conditions,
	type Fixture,
	fill,
	GateSetupError,
	handwritten,
	handwrittenRows,
	headingOf,
	installedIndexes,
	installFixture,
	type MeasureOptions,
	measureQuery,
	optimizedStatement,
	plainExplain,
	queryPhases,
	rawSession,
	textRowsOf,
	runtimeSession,
	settle
} from "#bench/query/support/kit.ts"

import {
	indexAccessOn,
	outline,
	planOf,
	serverStatementPlanOf,
	rowsReadFrom,
	scansOf
} from "#bench/query/support/plans.ts"
import { appendAll } from "#compiler/core/array.ts"
import { trusted } from "#compiler/core/trusted.ts"
import type { ConservativeParamSlot } from "#compiler/lower/conservative/types.ts"
import type { OptimizedStatement } from "#compiler/lower/shapes/index.ts"
import { executableQuery } from "#compiler/lower/template.ts"
import { closedId, contract, pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { closed, relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import type { BinaryOperator, Expr, FromSource, SqlStatement } from "#compiler/sql/ast.ts"
import { printType } from "#compiler/sql/print.ts"
import { identityHooks, transformStatement } from "#compiler/sql/transform.ts"
import type { SqlError } from "#test/support/pg.ts"
import { prefixBounds } from "#test/support/prefix.ts"
import type { RawSession } from "#test/support/substrate/session.ts"
import type { Substrate } from "#test/support/substrate/substrate.ts"

const Kind = closed("Kind", ["Open", "Done", "Held"])
const Cents = contract("Cents", pg.bigint, (x) => x.ge(0n))
const Entry = relation(
	"Entry",
	{
		id: pg.bigint,
		account: pg.bigint,
		kind: closedId(Kind),
		amount: Cents,
		code: str.regex("^.{1,40}$", "su")
	},
	["id"]
)
/**
 * R04, R18 and R39: index-recognizable predicates, typed single-assignment SQL and prefix search (R18, R39).
 *
 * One relation, Entry(id, account, kind, amount, code), whose amount is a contract over bigint (a domain column) and
 * whose code is bounded text holding Latin, CJK and supplementary-plane code points. Its workload asks for the access
 * paths the queries need, and nothing else installs an index. The same fixture serves R05's keyset pages
 * (page.bench.ts), a file of its own, so a page failure records only R05's verdict:
 *
 * - R04: a range over the domain column with a closed-roster literal is an Index Cond, planned generic and planned
 *   custom, each tested separately, and the scan of Entry reads exactly the rows the query selects, the open entries
 *   in the range: the index serves the literal equality and the range, and no row is fetched to be filtered out.
 * - R18: the range and prefix statements are single-assignment (each relation alias and each derived column defined
 *   once, read off the statement the runtime sends), and each one's server statement signature is exactly its
 *   parameter slots' types, the base type for a parameter compared with the domain column; the domain column keeps
 *   its index.
 * - R39: an equality prefix and a prefix's code-point interval (test/support/prefix.ts) are an Index Cond on both bounds, and agree
 *   with the pattern form, starts_with, on every prefix tried, supplementary-plane prefixes and a trailing U+10FFFF
 *   included.
 */
export const Access = schema("Access", { Kind, Entry }, [])

/** R04 and R18: open entries in an amount range. */
const openInRange = query(Access).rule((r) => {
	const { id, amount } = v(Entry, "entry")
	return r
		.match(Entry, { id, amount, kind: "Open" })
		.where(r.ge(amount, r.param("lo", Cents)), r.lt(amount, r.param("hi", Cents)))
		.find({ id, amount })
})

/** R05: an account's entries by amount, keyed by id; and its amounts alone, the key dropped. */
export const byAmount = query(Access)
	.rule((r) => {
		const { id, amount } = v(Entry, "entry")
		return r
			.match(Entry, { id, account: r.param("account", Entry.fields.account), amount })
			.find({ id, amount })
	})
	.orderBy(["amount", "asc"], ["id", "asc"])

export const amountsOf = query(Access)
	.rule((r) => {
		const { amount } = v(Entry, "entry")
		return r
			.match(Entry, { account: r.param("account", Entry.fields.account), amount })
			.find({ amount })
	})
	.orderBy(["amount", "asc"])

/** R39: an account's entries whose code lies in a code-point interval. */
const codesIn = query(Access).rule((r) => {
	const { id, code } = v(Entry, "entry")
	return r
		.match(Entry, { id, account: r.param("account", Entry.fields.account), code })
		.where(
			r.ge(code, r.param("lo", Entry.fields.code)),
			r.lt(code, r.param("hi", Entry.fields.code))
		)
		.find({ id, code })
})

export const accessPrograms = { openInRange, byAmount, amountsOf, codesIn } as const

/** The code points codes are drawn from: ASCII, Latin-1, CJK and two supplementary-plane scalars. */
const alphabet = [97, 98, 99, 65, 233, 223, 20013, 128512, 119070, 122] as const
/**
 * The prefixes R39 tries: one and two scalars, supplementary-plane ones, one no code starts with, and one with a
 * trailing U+10FFFF, whose interval drops it.
 */
const prefixes = [
	"a",
	"ab",
	"\u{1F600}",
	"\u{1F600}a",
	"é",
	"中\u{1F600}",
	"q",
	"a\u{10FFFF}",
	"\u{1D11E}c"
] as const

export interface EntriesSize {
	readonly entries: number
	readonly accounts: number
}

/**
 * The Entry facts: accounts in turn, kinds cycling, amounts (37 g) mod 100000, codes of 1-6 scalars of the alphabet.
 */
export const loadEntries = Effect.fn("loadEntries")(function* <S>(
	fx: Fixture<S>,
	size: EntriesSize
): Effect.fn.Return<void, SqlError, Substrate> {
	const codeExpr =
		`(SELECT pg_catalog.string_agg(pg_catalog.chr((ARRAY[${Arr.join(Arr.map(alphabet, String), ", ")}])[1 + ((pg_catalog.hashint8(g * 64 + k) & 2147483647) % ${alphabet.length})]), '' ORDER BY k) ` +
		"FROM pg_catalog.generate_series(1, 1 + (pg_catalog.hashint8(g) & 2147483647) % 6) AS k)"
	yield* fill(fx, "Entry", size.entries, {
		id: "g::int8",
		account: `(1 + g % ${size.accounts})::int8`,
		kind: `(ARRAY[${fx.handle("Kind", "Open")}, ${fx.handle("Kind", "Done")}, ${fx.handle("Kind", "Held")}])[1 + g % 3]`,
		amount: "((g * 37) % 100000)::int8",
		code: codeExpr
	})
	yield* settle(fx)
})

export const entriesData = (size: EntriesSize): string =>
	`${size.entries} entries over ${size.accounts} accounts, kinds cycling, amounts (37 g) mod 100000, codes of 1-6 scalars from ASCII, Latin-1, CJK and the supplementary plane`

interface Options extends Readonly<Record<string, unknown>> {
	readonly entries: number
	readonly accounts: number
	readonly samples: number
}

type Gates = "R04" | "R18" | "R39"

type TypeListRow = readonly [types: ReadonlyArray<string>]
type TextRow = readonly [text: string]

/**
 * The parameter types PostgreSQL infers for `sql` as a server statement without declared types, which only its casts can fix (typed
 * parameters fix the server statement's signature).
 */
const serverStatementTypes = Effect.fn("serverStatementTypes")(function* (
	raw: RawSession,
	sql: string,
	name: string
) {
	yield* raw.values(`PREPARE ${name} AS ${sql}`, [])
	const rows = yield* raw.values(
		"SELECT parameter_types::text[] FROM pg_catalog.pg_prepared_statements WHERE name = $1::text",
		[name]
	)
	yield* raw.values(`DEALLOCATE ${name}`, [])
	const [row] = trusted<ReadonlyArray<TypeListRow>>(rows)
	if (row === undefined) {
		throw new GateSetupError({ what: `no server statement ${name}` })
	}
	return row[0]
})

/** A type spelling as PostgreSQL prints the type it names: regtype's text, as parameter_types prints its elements. */
const canonicalType = Effect.fn("canonicalType")(function* (raw: RawSession, spelling: string) {
	const rows = yield* raw.values("SELECT ($1::text)::regtype::text", [spelling])
	const [row] = trusted<ReadonlyArray<TextRow>>(rows)
	if (row === undefined) {
		throw new GateSetupError({ what: `no type ${spelling}` })
	}
	return row[0]
})

/** The relation aliases and derived column names one FROM item defines. */
const definedBy = (
	item: FromSource
): { readonly aliases: ReadonlyArray<string>; readonly columns: ReadonlyArray<string> } => {
	switch (item.kind) {
		case "table":
		case "enclosing":
			return { aliases: [item.alias], columns: [] }
		case "cte":
			return { aliases: item.alias === undefined ? [] : [item.alias], columns: [] }
		case "derived":
		case "function":
		case "values":
			return { aliases: [item.alias], columns: item.columns }
		case "arrays":
			return {
				aliases: [item.alias],
				columns:
					item.source.kind === "count" ? [] : Arr.map(item.source.columns, (c) => c.definition.name)
			}
		case "context":
			return { aliases: [item.alias], columns: Arr.map(item.columns, (c) => c.column.name) }
	}
}

const repeatedIn = (names: ReadonlyArray<string>): ReadonlyArray<string> =>
	Arr.filter(names, (name, i) => names.indexOf(name) !== i)

/**
 * The single-assignment R18 checks of one compiled statement, as the runtime sends it (its executable text-cast form):
 * every relation alias and every column a derived table, a function or a VALUES list names is defined once.
 */
const singleAssignment = (
	label: string,
	statement: OptimizedStatement
): ReadonlyArray<GateCheck> => {
	const aliases: Array<string> = []
	const columns: Array<string> = []
	transformStatement(executableQuery(statement), {
		...identityHooks,
		fromSource: (item) => {
			const defined = definedBy(item)
			appendAll(aliases, defined.aliases)
			appendAll(columns, defined.columns)
			return item
		}
	})
	return [
		mechanism(
			`${label}: every relation alias is defined once`,
			repeatedIn(aliases).length === 0,
			`${aliases.length} aliases; repeated: ${Arr.join(repeatedIn(aliases), ", ")}`
		),
		mechanism(
			`${label}: every derived column is defined once`,
			repeatedIn(columns).length === 0,
			`${columns.length} columns; repeated: ${Arr.join(repeatedIn(columns), ", ")}`
		)
	]
}

/** The cast type of a statement's parameter slot: every slot of the statements R18 judges here is a declared scalar. */
const slotType = (label: string, slot: ConservativeParamSlot): string => {
	if (slot.kind !== "scalar") {
		throw new GateSetupError({
			what: `${label}: a ${slot.kind} slot, where R18 judges scalar parameters`
		})
	}
	return printType(slot.sqlType)
}

/** An expression with its casts and collations seen through. */
const bare = (e: Expr): Expr => (e.kind === "cast" || e.kind === "collate" ? bare(e.expr) : e)

/** A stored column: its table's installed name and the column's. */
interface StoredColumn {
	readonly table: string
	readonly column: string
}

/** What a reference resolves to: the stored column it names, or none. */
type Resolved =
	| { readonly kind: "stored"; readonly table: string; readonly column: string }
	| { readonly kind: "none" }

/**
 * The stored column a reference of `statement` names: through the alias of a table item to its column, or through the
 * alias of a derived item to what its query's core target at that position names, recursively. Aliases are defined once
 * per statement (the R18 check above), so one map resolves them; an unqualified reference, a set operation's column or
 * a computed target names no stored column.
 */
const storedColumnOf = (statement: SqlStatement): ((e: Expr) => Resolved) => {
	const items = new Map<string, Extract<FromSource, { readonly kind: "table" | "derived" }>>()
	transformStatement(statement, {
		...identityHooks,
		fromSource: (item) => {
			if (item.kind === "table" || item.kind === "derived") {
				items.set(item.alias, item)
			}
			return item
		}
	})
	const resolve = (e: Expr): Resolved => {
		const c = bare(e)
		if (c.kind !== "column" || c.table === undefined) {
			return { kind: "none" }
		}
		const item = items.get(c.table)
		if (item === undefined) {
			return { kind: "none" }
		}
		if (item.kind === "table") {
			return typeof item.table === "string"
				? { kind: "none" }
				: { kind: "stored", table: item.table.name, column: c.column }
		}
		const body = item.query.body
		const target = body.kind === "core" ? body.targets[item.columns.indexOf(c.column)] : undefined
		return target === undefined ? { kind: "none" } : resolve(target.expr)
	}
	return resolve
}

/** The operators of the statement's predicates comparing the stored column `stored` with a parameter. */
const parameterBounds = (
	statement: OptimizedStatement,
	stored: StoredColumn
): ReadonlyArray<BinaryOperator> => {
	const resolve = storedColumnOf(statement.ast)
	const ops: Array<BinaryOperator> = []
	transformStatement(statement.ast, {
		...identityHooks,
		expr: (e) => {
			if (e.kind === "binary" && bare(e.right).kind === "param") {
				const left = resolve(e.left)
				if (
					left.kind === "stored" &&
					left.table === stored.table &&
					left.column === stored.column
				) {
					ops.push(e.op)
				}
			}
			return e
		}
	})
	return ops
}

/** @internal */
export default defineGate({
	name: "query-access",
	gates: ["R04", "R18", "R39"],
	title: "Index-recognizable predicates, typed SQL and prefix search against handwritten SQL",
	scope:
		"A domain-typed range with a roster literal planned generic and custom (R04), the single-assignment and " +
		"server-statement signature shape of the range and prefix statements (R18), and code-point prefix intervals against " +
		"starts_with over supplementary-plane text (R39). R05's keyset pages over the same fixture are page.bench.ts.",
	phases: queryPhases,
	options: {
		full: { entries: 200000, accounts: 200, samples: 20 },
		quick: { entries: 30000, accounts: 30, samples: 2 }
	} satisfies { readonly full: Options; readonly quick: Options },
	run: ({ options }) =>
		Effect.gen(function* () {
			const fx = yield* installFixture(Access, accessPrograms, "benchaccess", [])
			const size = { entries: options.entries, accounts: options.accounts }
			yield* loadEntries(fx, size)
			const runtime = yield* runtimeSession(fx, fx.world.app)
			const raw = yield* rawSession(fx, fx.world.app, "m15b access raw")
			const entry = fx.relationName("Entry")
			const E = fx.table("Entry")
			const col = (f: string) => fx.column("Entry", f)
			const indexes = yield* installedIndexes(fx)
			const data = entriesData(size)
			const reading = { role: fx.world.app, context: "snapshot", warm: 3, read: "rows" } as const
			const installed =
				"fresh install of Access with its workload's access paths; facts loaded, then VACUUM (ANALYZE) of every table"
			const warm = "warm: each variant runs once before its timed samples"
			const cases: Array<CaseRecord<Gates>> = []
			const measure: MeasureOptions = {
				samples: options.samples,
				explainSamples: 1,
				serverPlans: [],
				explain: plainExplain,
				conservativeSamples: options.samples
			}
			const handOptions = {
				samples: options.samples,
				warmup: 0,
				explainSamples: 1,
				explain: plainExplain,
				serverPlans: []
			} as const

			/** R04. */
			const range = compile(fx, openInRange, reading)
			const rangeValues = { lo: 1000n, hi: 3000n }
			const rangeM = yield* measureQuery(runtime, raw, range, rangeValues, {
				...measure,
				serverPlans: ["generic", "custom"]
			})
			const rangeHand = yield* measureVariant(
				raw,
				handwritten(
					"handwritten",
					[
						{
							sql: handwrittenRows(
								headingOf(range),
								`SELECT e.${col("id")} AS id, e.${col("amount")} AS amount FROM ${E} AS e ` +
									`WHERE e.${col("kind")} = 'Open' AND e.${col("amount")} >= $1::int8 AND e.${col("amount")} < $2::int8`
							),
							params: ["1000", "3000"]
						}
					],
					autocommit
				),
				handOptions
			)
			const generic = serverStatementPlanOf(rangeM.generated, "generic", 0)
			const custom = serverStatementPlanOf(rangeM.generated, "custom", 0)
			/**
			 * The Entry rows the query selects, open and in the range, counted once on the raw session: what a scan whose
			 * index serves both predicates reads.
			 */
			const rows = yield* raw.values(
				`SELECT pg_catalog.count(*)::text FROM ${E} WHERE ${col("kind")} = 'Open' AND ${col("amount")} >= ${rangeValues.lo} AND ${col("amount")} < ${rangeValues.hi}`,
				[]
			)
			const [countRow] = trusted<ReadonlyArray<TextRow>>(rows)
			if (countRow === undefined) {
				throw new GateSetupError({ what: "the count of the selected rows returned no row" })
			}
			const selectedRows = Number(countRow[0])
			/**
			 * The rows the scans of Entry fetched, filtered out or not, over every loop; rechecks aside, so a lossy bitmap does
			 * not count.
			 */
			const rowsFetched = (plan: PlanNode): number =>
				Arr.reduce(
					scansOf(plan, entry),
					0,
					(sum, n) => sum + (n.actualRows + n.rowsRemovedByFilter) * n.actualLoops
				)
			/**
			 * EXPLAIN prints each per-loop count to two decimals, so the total over a node's loops is exact to half a hundredth
			 * per loop.
			 */
			const fetchedLoops = (plan: PlanNode): number =>
				Arr.reduce(scansOf(plan, entry), 0, (sum, n) => sum + n.actualLoops)
			const readsSelected = (plan: PlanNode): boolean =>
				Math.abs(rowsFetched(plan) - selectedRows) <= 0.005 * fetchedLoops(plan)
			const amountColumn = fx.columnName("Entry", "amount")
			const amountCond = (plan: PlanNode): boolean =>
				Arr.every(scansOf(plan, entry), (s) => s.nodeType !== "Seq Scan") &&
				Arr.some(
					indexAccessOn(plan, entry, indexes),
					(a) => a.columns.includes(amountColumn) && a.condition === "index cond"
				)
			cases.push({
				name: "open entries in an amount range",
				gates: ["R04", "R18"],
				conditions: conditions({
					workload:
						"Entry filtered by kind = Open and amount in [lo, hi), amount a contract over bigint",
					schemaState: installed,
					data,
					parameters: { lo: "1000", hi: "3000" },
					semantics: "the (id, amount) of open entries in the range",
					cache: warm
				}),
				phases: {},
				variants: [rangeM.generated, rangeM.conservative, rangeHand],
				comparisons: [compareVariants(rangeM.generated, rangeHand)],
				transactions: {},
				loads: {},
				measures: {
					indexes: Arr.join(
						Arr.map(indexes, (i) => `${i.name}(${Arr.join(i.columns, ", ")})`),
						"; "
					),
					rowsReadCustom: rowsReadFrom(custom, entry),
					rowsReadGeneric: rowsReadFrom(generic, entry)
				}
			})
			const r04: VerdictInput = {
				checks: [
					mechanism(
						"the custom plan's range is an Index Cond on amount",
						amountCond(custom),
						outline(custom, 0)
					),
					mechanism(
						"the generic plan's range is an Index Cond on amount",
						amountCond(generic),
						outline(generic, 0)
					),
					mechanism(
						"the entry scan reads exactly the open entries in the range",
						readsSelected(generic) && readsSelected(custom),
						`${selectedRows} open entries in range; generic fetched ${rowsFetched(generic)}, custom ${rowsFetched(custom)}`
					),
					agrees("generated and conservative agree", rangeM),
					equivalence(
						"generated and handwritten agree",
						compareVariants(rangeM.generated, rangeHand).sameResult,
						`${rangeM.generated.result.rows} generated rows, ${rangeHand.result.rows} handwritten`
					)
				]
			}

			/** R39. */
			const prefix = compile(fx, codesIn, reading)
			const prefixAccount = BigInt(1 + Math.floor(options.accounts / 2))
			const accountColumn = fx.columnName("Entry", "account")
			const codeColumn = fx.columnName("Entry", "code")
			const tried = Arr.flatMap(prefixes, (p) => {
				const bounds = prefixBounds(p)
				return bounds === undefined ? [] : [{ prefix: p, lo: bounds.lo, hi: bounds.hi }]
			})
			if (!Arr.isReadonlyArrayNonEmpty(tried)) {
				throw new GateSetupError({ what: "no prefix has a code-point interval" })
			}
			const startsWith = (p: string): VariantStatement => ({
				sql: handwrittenRows(
					headingOf(prefix),
					`SELECT e.${col("id")} AS id, e.${col("code")} AS code FROM ${E} AS e WHERE e.${col("account")} = $1::int8 AND pg_catalog.starts_with(e.${col("code")}, $2::text)`
				),
				params: [String(prefixAccount), p]
			})
			const measurePrefix = (t: (typeof tried)[number], samples: number) =>
				measureQuery(
					runtime,
					raw,
					prefix,
					{ account: prefixAccount, lo: t.lo, hi: t.hi },
					{ ...measure, samples, conservativeSamples: samples }
				)
			const [firstTried] = tried
			const firstPrefix = yield* measurePrefix(firstTried, options.samples)
			const firstStartsWith = yield* measureVariant(
				raw,
				handwritten("handwritten starts_with", [startsWith(firstTried.prefix)], autocommit),
				handOptions
			)
			const prefixChecks: Array<GateCheck> = []
			const prefixCases: Array<{
				readonly prefix: string
				readonly rows: number
				readonly rowsRead: number
			}> = []
			for (const [i, t] of tried.entries()) {
				const m = i === 0 ? firstPrefix : yield* measurePrefix(t, 1)
				const pattern = yield* textRowsOf(raw, [startsWith(t.prefix)])
				const generatedRows = yield* textRowsOf(raw, m.delivered.generated.statements)
				const versusPattern = rowsAgree(generatedRows, pattern)
				prefixChecks.push(
					equivalence(
						`prefix ${Formatter.format(t.prefix)}: the interval agrees with starts_with`,
						Option.isNone(versusPattern) && m.agreement.kind === "agree",
						`starts_with: ${Option.getOrElse(versusPattern, () => "agree")}; conservative: ${m.agreement.kind === "agree" ? "agree" : m.agreement.difference}`
					)
				)
				const plan = planOf(m.generated, 0)
				prefixChecks.push(
					mechanism(
						`prefix ${Formatter.format(t.prefix)}: the interval is an Index Cond on the (account, code) index`,
						Arr.some(
							indexAccessOn(plan, entry, indexes),
							(a) =>
								a.condition === "index cond" &&
								a.columns[0] === accountColumn &&
								a.columns[1] === codeColumn
						),
						outline(plan, 0)
					)
				)
				prefixCases.push({
					prefix: t.prefix,
					rows: generatedRows.length,
					rowsRead: rowsReadFrom(plan, entry)
				})
			}
			/** Agreement on prefixes that select nothing proves nothing: the fixture must give several prefixes rows. */
			const nonempty = Arr.filter(prefixCases, (c) => c.rows > 0).length
			if (nonempty < 3) {
				throw new GateSetupError({ what: `${nonempty} prefixes select rows, fewer than three` })
			}
			const prefixStatement = optimizedStatement(prefix, 0)
			const bounds = parameterBounds(prefixStatement, { table: entry, column: codeColumn })
			cases.push({
				name: "an account's codes in a prefix's code-point interval",
				gates: ["R39", "R18"],
				conditions: conditions({
					workload:
						"Entry by account with code >= lo and code < hi, a prefix's code-point interval",
					schemaState: installed,
					data,
					parameters: { account: String(prefixAccount), prefixes },
					semantics: "the (id, code) of the account's entries whose code starts with the prefix",
					cache: warm
				}),
				phases: {},
				variants: [firstPrefix.generated, firstPrefix.conservative, firstStartsWith],
				comparisons: [compareVariants(firstPrefix.generated, firstStartsWith)],
				transactions: {},
				loads: {},
				measures: {
					prefixesTried: prefixCases.length,
					prefixesWithRows: nonempty,
					prefixRows: Arr.map(prefixCases, (c) => c.rows),
					prefixRowsRead: Arr.map(prefixCases, (c) => c.rowsRead)
				}
			})
			const r39: VerdictInput = {
				checks: [
					mechanism(
						"the prefix statement bounds the code by two parameters, >= and <",
						bounds.length === 2 && bounds.includes(">=") && bounds.includes("<"),
						Arr.join(bounds, ", ")
					),
					...prefixChecks
				]
			}

			/** R18: the range and prefix statements. */
			const judgedStatements: ReadonlyArray<{
				readonly label: string
				readonly compiled: Compiled
				readonly sql: string
			}> = [
				{ label: "range", compiled: range, sql: rangeM.delivered.generated.statements[0].sql },
				{
					label: "prefix",
					compiled: prefix,
					sql: firstPrefix.delivered.generated.statements[0].sql
				}
			]
			const structural: Array<GateCheck> = []
			const signatures: Array<GateCheck> = []
			for (const [i, { label, compiled, sql }] of judgedStatements.entries()) {
				const statement = optimizedStatement(compiled, 0)
				appendAll(structural, singleAssignment(label, statement))
				const inferred = yield* serverStatementTypes(raw, sql, `gz_m15b_sig_${i}`)
				const cast: Array<string> = []
				for (const slot of statement.params) {
					const canonical = yield* canonicalType(raw, slotType(label, slot))
					cast.push(canonical)
				}
				signatures.push(
					mechanism(
						`${label}: the server statement signature is the parameter slots' types`,
						inferred.length === cast.length && Arr.every(inferred, (t, j) => t === cast[j]),
						`${Arr.join(inferred, ", ")} vs ${Arr.join(cast, ", ")}`
					)
				)
			}
			const r18: VerdictInput = {
				checks: [
					mechanism(
						"the domain column keeps its index under a base-typed parameter",
						amountCond(custom) && amountCond(generic),
						`custom:\n${outline(custom, 0)}\ngeneric:\n${outline(generic, 0)}`
					),
					...structural,
					...signatures
				]
			}
			return { cases, verdicts: { R04: r04, R18: r18, R39: r39 } }
		})
})
