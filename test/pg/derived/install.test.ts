import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, element, type Gen, int, subset, weighted } from "@grizzle/testing/gen"
import { matching } from "@grizzle/testing/pattern"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import type { Source } from "@grizzle/testing/source"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Order, pipe, Record as Rec, String as Str } from "effect"
import { derivedAnalysis } from "#compiler/analysis/schema.ts"
import { indices } from "#compiler/core/array.ts"
import { catchCompileError } from "#compiler/core/canonical.ts"
import * as Result from "#compiler/core/result.ts"
import { trusted } from "#compiler/core/trusted.ts"
import { codeOf } from "#compiler/ir/codes.ts"
import type { InferredFieldDesc } from "#compiler/ir/desc.ts"
import { baseOf, textInfoOf } from "#compiler/ir/scalar.ts"
import { lowerConservative } from "#compiler/lower/conservative/index.ts"
import { conservativeInput, flight } from "#compiler/lower/conservative/types.ts"
import { columnType } from "#compiler/physical/ddl/names.ts"
import { uuid, type Uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { closed, derived, login, relation, role, schema } from "#compiler/public/schema.ts"
import { queryOver, varsOver } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { computeCore } from "#compiler/scalar/compute/builders.ts"
import { derived as runtimeDerived } from "#compiler/schema/relation.ts"
import { printObjectName, printType, quoteIdent } from "#compiler/sql/print.ts"
import { textLookup } from "#compiler/text/refinement.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { assert, nonEmpty, defined as present, succeeded } from "#test/support/assert.ts"
import * as W from "#test/support/fixtures/api/work.ts"
import {
	type Installed,
	installMigrated as install,
	loadMigrated as load
} from "#test/support/install-migrate.ts"
import { namesOf, parsedName } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { checkedIn } from "#test/support/policy.ts"
import { compiledPattern } from "#test/support/regex.ts"
import { ownerSession, Substrate, worldSession } from "#test/support/substrate/substrate.ts"
import {
	type SketchedField,
	fieldOf,
	fieldSketchGen,
	type PatternSketch,
	pgField,
	patternOf,
	patternSketchGen
} from "#test/unit/schema/field-sketch.ts"
import { regex } from "#test/unit/schema/support.ts"

/** Derived relations installed on PostgreSQL 19 (gate).
 *
 * - the inferred descriptors hold: over a derived relation of one relation of drawn field types (field-sketch.ts:
 *   every pg descriptor, the numeric typmod box, refined and wildcard text, contracts, spans, closed ids and sets over
 *   drawn rosters, vectors), grouped by drawn fields with drawn counts, sums, means, minima and maxima, every view
 *   column's catalog type, typmod and collation is the one its inferred field descriptor names; a definition the
 *   compiler refuses gives its case up;
 * - over drawn patterns and drawn members of them, a view column of a refined-text literal has its pattern's domain,
 *   whether a stored field declares the pattern or not, and plain text for the wildcard; a role refreshing the relation refreshes the
 *   materialized view, plainly and concurrently, to the definition's rows, and a role reading it reads the literals
 *   through its world's view;
 * - a refresh inside an owner's transaction whose drawn writes leave a deferred containment false (tasks of absent
 *   accounts added, accounts of tasks removed: transaction evidence) equals the definition evaluated by the conservative
 *   lowering on the same snapshot, and the tasks whose account the transaction holds.
 *
 * That every refreshed view equals its definition, over drawn levels, take forms and aggregates, is the derived
 * oracle's; the installed catalog is the catalog spec checker's. */

const id = (n: number): Uuid =>
	`00000000-0000-4000-8000-${pipe(n.toString(16), Str.padStart(12, "0"))}`

/** The view of a derived relation and its columns, in heading order. */
const viewOf = (installed: Installed, relation: string) => {
	const a = Result.map(checkedIn(installed.installation.owned), derivedAnalysis)
	if (!a.ok) {
		throw a.error
	}
	const r = a.value.relations[relation]
	if (r === undefined) {
		throw new Error(`no derived relation ${relation}`)
	}
	const view = installed.names.relation(relation)
	const columns = Arr.map(r.heading, (c) => installed.names.column(relation, c.name))
	return { analysis: r, view: printObjectName(view), columns }
}

/** The definition's conservative lowering, the oracle baseline that relies on no evidence. */
const conservativeSql = (installed: Installed, relation: string): string => {
	const { analysis } = viewOf(installed, relation)
	const program = lowerConservative(conservativeInput(analysis.query), {
		names: installed.names,
		params: [],
		subject: { kind: "query" }
	})
	if (!program.ok) {
		throw program.error
	}
	return flight(program.value.roots)[0].sql.text
}

/** The view's rows and its definition's rows, each as record text, read in one snapshot. */
const viewAndDefinition = (installed: Installed, relation: string) =>
	Effect.gen(function* () {
		const substrate = yield* Substrate
		const owner = yield* substrate.session({ ...ownerSession(), label: "oracle" })
		const { view, columns, analysis } = viewOf(installed, relation)
		const names = Arr.map(analysis.heading, (c) => `"${c.name}"`)
		yield* owner.begin
		const stored = yield* owner.values(
			`SELECT ROW(${Arr.join(
				Arr.map(columns, (c) => `"r1"."${c}"`),
				", "
			)})::text FROM ${view} AS "r1"`,
			[]
		)
		const defined = yield* owner.values(
			`SELECT ROW(${Arr.join(
				Arr.map(names, (n) => `"r1".${n}`),
				", "
			)})::text FROM (${conservativeSql(installed, relation)}) AS "r1"`,
			[]
		)
		yield* owner.commit
		const sorted = (rows: ReadonlyArray<ReadonlyArray<unknown>>) =>
			Arr.sort(
				Arr.map(rows, (r) => String(r[0])),
				Order.String
			)
		return { stored: sorted(stored), defined: sorted(defined) }
	})

const workFacts = {
	Account: [
		{ id: id(1), name: "alpha" },
		{ id: id(2), name: "beta" },
		{ id: id(3), name: "gamma" }
	],
	Task: [
		{ id: id(11), account: id(1), kind: "Automatic" },
		{ id: id(12), account: id(1), kind: "Automatic" },
		{ id: id(13), account: id(1), kind: "Manual" },
		{ id: id(14), account: id(2), kind: "Automatic" }
	],
	AutomaticTask: [
		{ task: id(11), budget: 100n },
		{ task: id(12), budget: 100n },
		{ task: id(14), budget: 250n }
	],
	ManualTask: [{ task: id(13), operator: "ops" }]
}

/**
 * The atttypmod of an inferred descriptor's column, as PostgreSQL encodes it: numeric(p, s)'s, its scale in eleven bits
 * of two's complement (numeric.c make_numeric_typmod), a vector's its dimensions, and -1 for every other, a domain's
 * column and a computed numeric's numeric of no typmod among them.
 */
const typmodOf = (desc: InferredFieldDesc): number => {
	switch (desc.kind) {
		case "numeric":
			return ((desc.precision << 16) | (desc.scale & 0x7ff)) + 4
		case "vector":
			return desc.dimensions
		case "pg":
		case "bytes":
		case "uuid":
		case "text":
		case "contract":
		case "span":
		case "closedId":
		case "bits":
		case "computedNumeric":
			return -1
	}
}

/** The accounts the work facts hold, and those and two accounts no fact holds. */
const heldAccounts: ReadonlyArray<string> = [id(1), id(2), id(3)]
const everyAccount: Arr.NonEmptyReadonlyArray<string> = [id(1), id(2), id(3), id(7), id(8)]

/**
 * A transaction's writes before its refresh, under every constraint deferred: tasks added, each of a held account or
 * of an absent one, and held accounts removed whatever tasks they own.
 */
interface DeferredCase {
	readonly added: ReadonlyArray<string>
	readonly removed: ReadonlyArray<string>
}

const deferredCaseGen: Gen<DeferredCase> = (source) => ({
	added: source.draw(array(element(everyAccount), { min: 0, max: 2 })),
	removed: source.draw(subset(heldAccounts, { min: 0, max: 2 }))
})

/** The tasks the definition holds in the transaction: every task, fact or added, whose account it still holds. */
const ownedOf = (c: DeferredCase): ReadonlyArray<string> => {
	const accounts = new Set<string>(Arr.filter(heldAccounts, (a) => !c.removed.includes(a)))
	const tasks = [
		...Arr.map(workFacts.Task, (t) => [t.id, t.account] as const),
		...Arr.map(c.added, (account, i) => [id(16 + i), account] as const)
	]
	return Arr.sort(
		Arr.flatMap(tasks, ([task, account]) => (accounts.has(account) ? [task] : [])),
		Order.String
	)
}

type DeferredFeature =
	| "a task of an absent account added"
	| "a task of a held account added"
	| "an account of tasks removed"

const deferredFeatures = (c: DeferredCase): ReadonlyArray<DeferredFeature> => [
	...(Arr.some(c.added, (a) => !Arr.contains(heldAccounts, a) || c.removed.includes(a))
		? ["a task of an absent account added" as const]
		: []),
	...(Arr.some(c.added, (a) => Arr.contains(heldAccounts, a) && !c.removed.includes(a))
		? ["a task of a held account added" as const]
		: []),
	...(Arr.some(c.removed, (a) => Arr.some(workFacts.Task, (t) => t.account === a))
		? ["an account of tasks removed" as const]
		: [])
]

/** A literal's pattern: the one Coded's field declares, a drawn class pattern, or the wildcard. */
type LiteralPattern =
	| { readonly kind: "declared" }
	| { readonly kind: "drawn"; readonly pattern: PatternSketch }

/** A case: Coded's field's pattern, its rows' codes, and the derived relation's two literals, each with its member. */
interface LiteralCase {
	readonly declared: PatternSketch
	readonly codes: ReadonlyArray<string>
	readonly first: { readonly pattern: LiteralPattern; readonly member: string }
	readonly second: { readonly pattern: LiteralPattern; readonly member: string }
}

/** The pattern sketch a literal's pattern stands for. */
const sketchOf = (c: LiteralCase, p: LiteralPattern): PatternSketch =>
	p.kind === "declared" ? c.declared : p.pattern

/** A member of a pattern: a text it matches, of printable ASCII for the wildcard, which PostgreSQL's text holds. */
const memberGen = (p: PatternSketch): Gen<string> => {
	const { source, flags } =
		p.kind === "wildcard" ? { source: "^[ -~]{0,4}$", flags: "u" } : patternOf(p)
	return matching(compiledPattern(source, flags))
}

/** Whether two pattern sketches are one pattern. */
const samePattern = (a: PatternSketch, b: PatternSketch): boolean => {
	const [x, y] = [patternOf(a), patternOf(b)]
	return x.source === y.source && x.flags === y.flags
}

const literalCaseGen: Gen<LiteralCase> = (source) => {
	const declared = source.draw(patternSketchGen)
	const literal = (s: Source) => {
		const pattern = s.draw(
			weighted<LiteralPattern>([
				[1, (): LiteralPattern => ({ kind: "declared" })],
				[2, (d) => ({ kind: "drawn", pattern: d.draw(patternSketchGen) })]
			])
		)
		return {
			pattern,
			member: s.draw(memberGen(pattern.kind === "declared" ? declared : pattern.pattern))
		}
	}
	return {
		declared,
		codes: source.draw(array(memberGen(declared), { min: 0, max: 3 })),
		first: literal(source),
		second: literal(source)
	}
}

type LiteralFeature =
	| "a literal of a pattern a field declares"
	| "a literal of a pattern no field declares"
	| "a literal of the wildcard"
	| "rows refreshed"
	| "no row refreshed"

const literalFeatures = (c: LiteralCase): ReadonlyArray<LiteralFeature> => [
	...Arr.map([c.first, c.second], (l): LiteralFeature => {
		const sketch = sketchOf(c, l.pattern)
		return sketch.kind === "wildcard"
			? "a literal of the wildcard"
			: samePattern(sketch, c.declared)
				? "a literal of a pattern a field declares"
				: "a literal of a pattern no field declares"
	}),
	c.codes.length > 0 ? "rows refreshed" : "no row refreshed"
]

/** An aggregate of a derived head: a count, or sum, mean, min or max over a drawn field. */
type DescriptorAggregate =
	| { readonly fn: "count" }
	| { readonly fn: "sum" | "mean" | "min" | "max"; readonly field: number }

/**
 * A derived relation over one relation of drawn field types: grouped by a drawn subset of its fields, with drawn
 * aggregates, or projecting the group alone; a definition the compiler refuses (an aggregate a type does not take, a
 * key no B-tree holds) gives the case up, so every admitted one is installed.
 */
interface DescriptorCase {
	readonly rosters: Arr.NonEmptyReadonlyArray<number>
	readonly fields: Arr.NonEmptyReadonlyArray<SketchedField>
	readonly group: ReadonlyArray<number>
	readonly aggregates: ReadonlyArray<DescriptorAggregate>
}

/** The SQL types sum and mean take among pg's descriptors: the integers and the floats (money's sum is exact money). */
const summedSql: ReadonlySet<string> = new Set([
	"smallint",
	"integer",
	"bigint",
	"real",
	"double precision"
])

/** Whether sum and mean take a field: an integer, a float or a numeric, or a contract over one. */
const summed = (f: SketchedField): boolean => {
	switch (f.kind) {
		case "pg":
			return summedSql.has(pgField(f.member).sql)
		case "numeric":
			return true
		case "contract":
			return summed(f.base)
		case "uuid":
		case "text":
		case "closedId":
		case "vector":
		case "span":
		case "bits":
			return false
	}
}

/** Whether min and max take a field: one sum takes, or text. */
const extremal = (f: SketchedField): boolean =>
	summed(f) || f.kind === "text" || (f.kind === "contract" && f.base.kind === "text")

/** Whether a field may be a group key: none of unbounded text or of a vector, whose B-tree entry no bound holds. */
const keyable = (f: SketchedField): boolean => {
	const base = f.kind === "contract" ? f.base : f
	return !(base.kind === "vector" || (base.kind === "text" && base.pattern.kind === "wildcard"))
}

const descriptorCaseGen: Gen<DescriptorCase> = (source) => {
	const rosters = nonEmpty(source.draw(array(int(1, 3), { min: 1, max: 2 })), "the rosters")
	const drawnFields = nonEmpty(
		source.draw(
			array(
				fieldSketchGen(rosters.length, (s) => `C${s.draw(int(0, 9))}`),
				{ min: 1, max: 4 }
			)
		),
		"the fields"
	)
	const fields = Arr.map(drawnFields, (f, i): SketchedField =>
		f.kind === "contract" ? { ...f, name: `C${i}` } : f
	)
	const where = (keep: (f: SketchedField) => boolean) =>
		Arr.filter(indices(fields.length), (i) => keep(Arr.getUnsafe(fields, i)))
	const keys = where(keyable)
	const sums = where(summed)
	const extremes = where(extremal)
	const pick = (s: Source, among: ReadonlyArray<number>) =>
		Arr.getUnsafe(among, s.draw(int(0, among.length - 1)))
	return {
		rosters,
		fields,
		group: source.draw(subset(keys, { min: 0, max: Math.min(2, keys.length) })),
		aggregates: source.draw(
			array(
				(s): DescriptorAggregate => {
					switch (s.draw(int(0, 4))) {
						case 1:
							return sums.length > 0 ? { fn: "sum", field: pick(s, sums) } : { fn: "count" }
						case 2:
							return sums.length > 0 ? { fn: "mean", field: pick(s, sums) } : { fn: "count" }
						case 3:
							return extremes.length > 0 ? { fn: "min", field: pick(s, extremes) } : { fn: "count" }
						case 4:
							return extremes.length > 0 ? { fn: "max", field: pick(s, extremes) } : { fn: "count" }
						default:
							return { fn: "count" }
					}
				},
				{ min: 0, max: 3 }
			)
		)
	}
}

/** The schema of a case: Base's one relation R, and its derived relation D over it. */
const descriptorSchemaOf = (c: DescriptorCase) => {
	const rosters = Arr.map(c.rosters, (count, i) =>
		closed(
			`K${i}`,
			Arr.prepend(
				Arr.map(Arr.range(1, count - 1), (h) => `h${h}`),
				"h0"
			)
		)
	)
	const fieldName = (i: number) => `f${i}`
	const R = relation(
		"R",
		{
			id: uuid,
			...Rec.fromEntries(Arr.map(c.fields, (f, i) => [fieldName(i), fieldOf(f, rosters)] as const))
		},
		["id"]
	)
	const Base = schema(
		"Base",
		{ ...Rec.fromEntries(Arr.map(rosters, (r, i) => [`K${i}`, r] as const)), R },
		[]
	)
	const projected =
		c.group.length === 0 && c.aggregates.length === 0 ? indices(c.fields.length) : c.group
	const definition = queryOver(Base).rule((r: RuleValue) => {
		const vars = varsOver(R, "r")
		return r.match(R, vars).find({
			...Rec.fromEntries(Arr.map(projected, (i) => [fieldName(i), vars[fieldName(i)]] as const)),
			...Rec.fromEntries(
				Arr.map(c.aggregates, (a, i) => {
					switch (a.fn) {
						case "count":
							return [`a${i}`, r.count()] as const
						case "sum":
							return [`a${i}`, r.sum(vars[fieldName(a.field)])] as const
						case "mean":
							return [`a${i}`, r.mean(vars[fieldName(a.field)])] as const
						case "min":
							return [`a${i}`, r.min(vars[fieldName(a.field)])] as const
						case "max":
							return [`a${i}`, r.max(vars[fieldName(a.field)])] as const
					}
				})
			)
		})
	})
	return schema.extend(Base, { D: runtimeDerived("D", definition, []) }, [])
}

type DescriptorFeature =
	| `aggregate ${DescriptorAggregate["fn"]}`
	| `column ${InferredFieldDesc["kind"]}`

layer(Substrate.layer)("derived relations on PostgreSQL 19", (it) => {
	it.effect(
		"inferred descriptors hold: every view column's catalog type, typmod and collation is its descriptor's",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "pg/derived/install/descriptors",
						draw: drawn(descriptorCaseGen),
						literal: Formatter.format,
						oracle: {
							kind: "postgresql",
							name: "the installed view's pg_attribute: each column's type, typmod and collation"
						},
						coverage: required<DescriptorFeature>(
							[
								"aggregate count",
								"aggregate sum",
								"aggregate mean",
								"aggregate min",
								"aggregate max",
								"column pg",
								"column numeric",
								"column text",
								"column contract",
								"column closedId",
								"column span",
								"column computedNumeric"
							],
							{ cases: 80, sense: notesOnly }
						),
						kept: [],
						runs: 12,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 4,
						caseHang
					},
					(c, k) =>
						Effect.scoped(
							Effect.gen(function* () {
								const built = catchCompileError(() => descriptorSchemaOf(c))
								yield* k.assume(built.ok && Result.map(checkedIn(built.value), derivedAnalysis).ok)
								if (!built.ok) {
									return
								}
								const substrate = yield* Substrate
								const installed = yield* install(built.value, {
									ambient: ordinarySession,
									extensions: [],
									label: "derived",
									logins: []
								})
								const owner = yield* substrate.session({ ...ownerSession(), label: "owner" })
								const { analysis, view } = viewOf(installed, "D")
								for (const a of c.aggregates) {
									k.note(`aggregate ${a.fn}`)
								}
								for (const col of analysis.heading) {
									k.note(`column ${col.desc.kind}`)
									const column = installed.names.column("D", col.name)
									const expected = printType(columnType(installed.names, col.type).type)
									const attribute = yield* owner.values(
										`SELECT (a.atttypid = '${Str.replaceAll("'", "''")(expected)}'::regtype)::text, a.atttypmod::text, a.attcollation::regcollation::text FROM pg_catalog.pg_attribute AS a WHERE a.attrelid = '${view}'::regclass AND a.attname = '${column}'`,
										[]
									)
									const [[sameType, typmod, collation]] =
										trusted<Arr.NonEmptyReadonlyArray<readonly [string, string, string]>>(attribute)
									assert.equal(sameType, "true", `D.${col.name} is ${expected}`)
									assert.equal(Number(typmod), typmodOf(col.desc), `D.${col.name} typmod`)
									if (baseOf(col.type).carrier === "text") {
										assert.equal(collation, "pg_c_utf8", `D.${col.name} collation`)
									}
								}
							})
						)
				)
			)
	)

	it.effect(
		"a refined-text literal column has its pattern's domain, declared by a field or not, and its refresher and reader see it",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "pg/derived/install/literals",
						draw: drawn(literalCaseGen),
						literal: Formatter.format,
						oracle: {
							kind: "second-implementation",
							name: "each literal's pattern's installed domain, and the definition's rows by the conservative lowering"
						},
						coverage: required<LiteralFeature>(
							[
								"a literal of a pattern a field declares",
								"a literal of a pattern no field declares",
								"a literal of the wildcard",
								"rows refreshed",
								"no row refreshed"
							],
							{ cases: 12, sense: notesOnly }
						),
						kept: [],
						runs: 6,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 4,
						caseHang
					},
					(c, k) =>
						Effect.scoped(
							Effect.gen(function* () {
								const substrate = yield* Substrate
								const declared = patternOf(c.declared)
								const Coded = relation(
									"Coded",
									{ id: uuid, code: regex(declared.source, declared.flags) },
									["id"]
								)
								const C = schema("C", { Coded }, [])
								const literalOf = (l: LiteralCase["first"]) => {
									const { source, flags } = patternOf(sketchOf(c, l.pattern))
									return computeCore.literal(regex(source, flags), l.member)
								}
								const literals = queryOver(C).rule((r: RuleValue) => {
									const vars = varsOver(Coded, "coded")
									return r.match(Coded, { id: vars["id"] }).find({
										id: vars["id"],
										first: literalOf(c.first),
										second: literalOf(c.second)
									})
								})
								const Literals = runtimeDerived("Literals", literals, [])
								const Ext = schema.extend(C, { Literals }, [])
								const viewer = role(Ext, "viewer", { Literals })
								const refresher = role(
									Ext,
									"refresher",
									{ Coded, Literals },
									{ refresh: ["Literals"] }
								)
								const installed = yield* install(Ext, {
									ambient: ordinarySession,
									extensions: [],
									label: "derived",
									logins: [login(Ext, "server", [viewer, refresher])]
								})
								const owner = yield* substrate.session({ ...ownerSession(), label: "owner" })
								const { view } = viewOf(installed, "Literals")
								/**
								 * Each pattern's type as regtype prints it: the installation's domain of it, or text for the
								 * wildcard, which no domain refines.
								 */
								const typeOf = (l: LiteralCase["first"]): string => {
									const { source, flags } = patternOf(sketchOf(c, l.pattern))
									const info = textInfoOf(source, flags, succeeded(textLookup(source, flags)))
									if (info.regex === "wildcard") {
										return "text"
									}
									const domain = installed.names.textDomain(info.regex)
									if (domain === undefined) {
										return assert.fail(`the installation names no domain of ${source}`)
									}
									return `${domain.schema}.${domain.name}`
								}
								const rows = yield* owner.values(
									`SELECT a.attname::text, a.atttypid::regtype::text, a.attcollation::regcollation::text FROM pg_catalog.pg_attribute AS a WHERE a.attrelid = '${view}'::regclass AND a.attnum > 0 ORDER BY a.attnum`,
									[]
								)
								assert.deepEqual(rows, [
									["first", typeOf(c.first), "pg_c_utf8"],
									["id", "uuid", "-"],
									["second", typeOf(c.second), "pg_c_utf8"]
								])
								yield* load(installed, {
									Coded: Arr.map(c.codes, (code, i) => ({ id: id(i + 1), code }))
								})
								const refreshing = yield* substrate.session({
									...worldSession(installed.world(refresher)),
									label: "refresher"
								})
								yield* refreshing.query(`REFRESH MATERIALIZED VIEW ${view}`, [])
								yield* refreshing.query(`REFRESH MATERIALIZED VIEW CONCURRENTLY ${view}`, [])
								const { stored, defined } = yield* viewAndDefinition(installed, "Literals")
								assert.deepEqual(stored, defined)
								/** The viewer reads the domain-typed columns through its world's view of Literals. */
								const viewing = yield* substrate.session({
									...worldSession(installed.world(viewer)),
									label: "viewer"
								})
								const seen = `${quoteIdent(installed.role(viewer))}.${quoteIdent(installed.names.relation("Literals").name)}`
								const viewingRows = yield* viewing.values(
									`SELECT "id"::text, "first"::text, "second"::text FROM ${seen} ORDER BY 1`,
									[]
								)
								assert.deepEqual(
									viewingRows,
									Arr.map(c.codes, (_, i) => [id(i + 1), c.first.member, c.second.member])
								)
								k.noteAll(literalFeatures(c))
							})
						)
				)
			)
	)

	it.effect(
		"a refresh inside an owner's transaction whose writes leave a deferred containment false equals the definition there",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const substrate = yield* Substrate
					const ownedTasks = query(W.Work).rule((r) => {
						const { id: t, account } = v(W.Task, "task")
						return r
							.match(W.Task, { id: t, account })
							.match(W.Account, { id: account })
							.find({ id: t })
					})
					const OwnedTasks = derived("OwnedTasks", ownedTasks)
					/** Account's name lies outside the referenced key, which makes Task.account -> Account.id deferred. */
					const Written = schema.extend(W.Work, { OwnedTasks }, [])
					const installed = yield* install(Written, {
						ambient: ordinarySession,
						extensions: [],
						label: "derived",
						logins: []
					})
					const names = namesOf(installed)
					const { view, columns } = viewOf(installed, "OwnedTasks")
					const owner = yield* substrate.session({ ...ownerSession(), label: "owner" })
					const constraint = yield* owner.values(
						`SELECT condeferrable::text FROM pg_catalog.pg_constraint WHERE conrelid = '${names.table(W.Task)}'::regclass AND contype = 'f'`,
						[]
					)
					const [[deferrable]] = trusted<Arr.NonEmptyReadonlyArray<readonly [string]>>(constraint)
					assert.equal(deferrable, "true")
					yield* load(installed, workFacts)
					/** A handle of Kind as the code the installation's codebook gives it. */
					const manual = codeOf(
						present(
							installed.names.codes.rosters.get(parsedName(W.Kind.name)),
							"the installation's codes of Kind"
						),
						"Manual"
					)
					yield* owner.query(`REFRESH MATERIALIZED VIEW ${view}`, [])
					const sorted = (rows: ReadonlyArray<ReadonlyArray<unknown>>) =>
						Arr.sort(
							Arr.map(rows, (r) => String(r[0])),
							Order.String
						)
					return yield* explore(
						{
							suite: "pg/derived/install/deferred-refresh",
							draw: drawn(deferredCaseGen),
							literal: Formatter.format,
							oracle: {
								kind: "second-implementation",
								name: "the tasks whose account the transaction holds, on the host, and the definition's conservative lowering"
							},
							coverage: required<DeferredFeature>(
								[
									"a task of an absent account added",
									"a task of a held account added",
									"an account of tasks removed"
								],
								{ cases: 12, sense: notesOnly }
							),
							kept: [],
							runs: 8,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 4,
							caseHang
						},
						(c, k) =>
							Effect.ensuring(
								Effect.gen(function* () {
									yield* owner.begin
									yield* owner.query("SET CONSTRAINTS ALL DEFERRED", [])
									for (const [i, account] of c.added.entries()) {
										const task = id(16 + i)
										yield* owner.query(
											`INSERT INTO ${names.table(W.Task)} (${names.column(W.Task, "id")}, ${names.column(W.Task, "account")}, ${names.column(W.Task, "kind")}) VALUES ('${task}'::uuid, '${account}'::uuid, ${manual}::smallint)`,
											[]
										)
										yield* owner.query(
											`INSERT INTO ${names.table(W.ManualTask)} (${names.column(W.ManualTask, "task")}, ${names.column(W.ManualTask, "operator")}) VALUES ('${task}'::uuid, 'ops')`,
											[]
										)
									}
									for (const account of c.removed) {
										yield* owner.query(
											`DELETE FROM ${names.table(W.Account)} WHERE ${names.column(W.Account, "id")} = '${account}'::uuid`,
											[]
										)
									}
									yield* owner.query(`REFRESH MATERIALIZED VIEW CONCURRENTLY ${view}`, [])
									const stored = yield* owner.values(
										`SELECT "r1"."${columns[0]}"::text FROM ${view} AS "r1"`,
										[]
									)
									const defined = yield* owner.values(
										`SELECT "r1"."id"::text FROM (${conservativeSql(installed, "OwnedTasks")}) AS "r1"`,
										[]
									)
									assert.deepEqual(sorted(stored), sorted(defined))
									assert.deepEqual<ReadonlyArray<string>>(sorted(stored), ownedOf(c))
									k.noteAll(deferredFeatures(c))
								}),
								Effect.orDie(owner.rollback)
							)
					)
				})
			)
	)
})
