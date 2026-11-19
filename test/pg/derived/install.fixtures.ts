/** What the properties of install.test.ts read: its spaces, models and helpers. */

import { indices } from "@bjornpagen/grizzle-text/base/array"
import * as Result from "@bjornpagen/grizzle-text/base/result"
import { array, element, type Gen, int, subset, weighted } from "@bjornpagen/testing/gen"
import { matching } from "@bjornpagen/testing/pattern"
import type { Source } from "@bjornpagen/testing/source"
import { Array as Arr, Effect, Order, pipe, Record as Rec, String as Str } from "effect"
import { derivedAnalysis } from "#compiler/analysis/schema.ts"
import { trusted } from "#compiler/core/trusted.ts"
import type { InferredFieldDesc } from "#compiler/ir/desc.ts"
import { lowerConservative } from "#compiler/lower/conservative/index.ts"
import { conservativeInput, flight } from "#compiler/lower/conservative/types.ts"

import { query, v } from "#compiler/public/query.ts"
import { derived, relation, schema } from "#compiler/public/schema.ts"
import { queryOver, varsOver } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { closedBuilder, materializedDerived as runtimeDerived } from "#compiler/schema/relation.ts"
import { printObjectName } from "#compiler/sql/print.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { assert, nonEmpty } from "#test/support/assert.ts"
import * as W from "#test/support/fixtures/api/work.ts"
import { Id, type IdValue } from "#test/support/ids.ts"
import {
	type Installed,
	loadMigrated as load,
	seededTemplate
} from "#test/support/install-migrate.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { checkedIn } from "#test/support/policy.ts"
import { compiledPattern } from "#test/support/regex.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"
import { upTo } from "#test/support/up-to.ts"
import {
	fieldOf,
	fieldSketchGen,
	patternOf,
	type PatternSketch,
	patternSketchGen,
	pgField,
	type SketchedField
} from "#test/unit/schema/field-sketch.ts"

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
 * oracle's; the installed catalog is the catalog spec checker's.
 */

export const id = (n: number): IdValue =>
	Id(`00000000-0000-4000-8000-${pipe(n.toString(16), Str.padStart(12, "0"))}`)

/** The view of a derived relation and its columns, in heading order. */
export const viewOf = (installed: Installed, relation: string) => {
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
export const conservativeSql = (installed: Installed, relation: string): string => {
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
export const viewAndDefinition = (installed: Installed, relation: string) =>
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

const workFacts = Object.freeze({
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
})

/**
 * The atttypmod of an inferred descriptor's column, as PostgreSQL encodes it: numeric(p, s)'s, its scale in eleven bits
 * of two's complement (numeric.c make_numeric_typmod), a vector's its dimensions, and -1 for every other, a domain's
 * column and a computed numeric's numeric of no typmod among them.
 */
export const typmodOf = (desc: InferredFieldDesc): number => {
	switch (desc.kind) {
		case "numeric":
			return ((desc.precision << 16) | (desc.scale & 0x7ff)) + 4
		case "vector":
			return desc.dimensions
		case "pg":
		case "bytes":
		case "uuid":
		case "text":
		case "pattern":
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

export const deferredCaseGen: Gen<DeferredCase> = (source) => ({
	added: source.draw(array(element(everyAccount), { min: 0, max: 2 })),
	removed: source.draw(subset(heldAccounts, { min: 0, max: 2 }))
})

/** The tasks the definition holds in the transaction: every task, fact or added, whose account it still holds. */
export const ownedOf = (c: DeferredCase): ReadonlyArray<string> => {
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

export type DeferredFeature =
	| "a task of an absent account added"
	| "a task of a held account added"
	| "an account of tasks removed"

export const deferredFeatures = (c: DeferredCase): ReadonlyArray<DeferredFeature> => [
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
export interface LiteralCase {
	readonly declared: PatternSketch
	readonly codes: ReadonlyArray<string>
	readonly first: { readonly pattern: LiteralPattern; readonly member: string }
	readonly second: { readonly pattern: LiteralPattern; readonly member: string }
}

/** The pattern sketch a literal's pattern stands for. */
export const sketchOf = (c: LiteralCase, p: LiteralPattern): PatternSketch =>
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

export const literalCaseGen: Gen<LiteralCase> = (source) => {
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

export type LiteralFeature =
	| "a literal of a pattern a field declares"
	| "a literal of a pattern no field declares"
	| "a literal of the wildcard"
	| "rows refreshed"
	| "no row refreshed"

export const literalFeatures = (c: LiteralCase): ReadonlyArray<LiteralFeature> => [
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

export const descriptorCaseGen: Gen<DescriptorCase> = (source) => {
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
export const descriptorSchemaOf = (c: DescriptorCase) => {
	const rosters = Arr.map(c.rosters, (count, i) =>
		closedBuilder(
			`K${i}`,
			Arr.prepend(
				Arr.map(
					upTo(count - 1, (i) => i + 1),
					(h) => `h${h}`
				),
				"h0"
			),
			"ordered",
			[]
		)
	)
	const fieldName = (i: number) => `f${i}`
	const R = relation(
		"R",
		{
			id: Id,
			...Rec.fromEntries(Arr.map(c.fields, (f, i) => [fieldName(i), fieldOf(f, rosters)] as const))
		},
		["id"]
	)
	const Base = schema(
		"Base",
		[...Rec.values(Rec.fromEntries(Arr.map(rosters, (r, i) => [`K${i}`, r] as const))), R],
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
	return schema.extend(Base, "Derived", [runtimeDerived("D", definition, [])], [])
}

/** What a descriptor case reached: each aggregate and column kind, or a schema the compiler refuses, which installs
 * nothing and so holds no descriptor to judge: the compiler's refusals are its own suites'. */
export type DescriptorFeature =
	| `aggregate ${DescriptorAggregate["fn"]}`
	| `column ${InferredFieldDesc["kind"]}`
	| "a schema the compiler refuses"

const ownedTasks = query(W.Work).rule((r) => {
	const { id: t, account } = v(W.Task, "task")
	return r.match(W.Task, { id: t, account }).match(W.Account, { id: account }).find({ id: t })
})

const OwnedTasks = derived.materialized("OwnedTasks", ownedTasks)

/** Account's name lies outside the referenced key, which makes Task.account -> Account.id deferred. */
const Written = schema.extend(W.Work, "Written", [OwnedTasks], [])

/**
 * Written installed once per member with the worked example's facts and OwnedTasks refreshed over them, where the
 * search did all three once before its cases (install-migrate.ts seededTemplate): the build checks the reference from
 * Task to Account is deferrable, as every case requires, and each case writes only inside the owner's transaction it
 * rolls back.
 */
export const writtenTemplate = seededTemplate({
	declaredIn: import.meta,
	name: "derived",
	schema: Written,
	options: { ambient: ordinarySession, extensions: [], label: "derived", logins: [] },
	seed: (installed) =>
		Effect.gen(function* () {
			const substrate = yield* Substrate
			const names = namesOf(installed)
			const constraint = yield* substrate.admin.queryValues(
				`SELECT condeferrable::text FROM pg_catalog.pg_constraint WHERE conrelid = '${names.table(W.Task)}'::regclass AND confrelid = '${names.table(W.Account)}'::regclass AND contype = 'f'`,
				[]
			)
			const [[deferrable]] = trusted<Arr.NonEmptyReadonlyArray<readonly [string]>>(constraint)
			assert.equal(deferrable, "true")
			yield* load(installed, workFacts)
			yield* substrate.admin.query(
				`REFRESH MATERIALIZED VIEW ${viewOf(installed, "OwnedTasks").view}`,
				[]
			)
		})
})

export const sorted = (rows: ReadonlyArray<ReadonlyArray<unknown>>) =>
	Arr.sort(
		Arr.map(rows, (r) => String(r[0])),
		Order.String
	)
