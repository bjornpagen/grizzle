import { type Gen, int, subarray } from "@grizzle/testing/gen"
import { Array as Arr, Context, Effect, Option, Order, pipe, String as Str } from "effect"
import type { DbContext } from "#adapter/db/context.ts"
import type { Session } from "#adapter/wire/session.ts"
import { appendAll } from "#compiler/core/array.ts"
import type { TypedLiteral } from "#compiler/ir/expr.ts"
import { contractOf, type ScalarType } from "#compiler/ir/scalar.ts"
import type { Uuid } from "#compiler/public/fields.ts"
import type { EmittedText } from "#compiler/sql/ast.ts"
import { lit, provedSelect, qualifiedCall, target, types } from "#compiler/sql/build.ts"
import { emit } from "#compiler/sql/emit.ts"
import { emptyNameMap } from "#compiler/sql/naming.ts"
import { canonicallySpelled, type SpelledValue } from "#test/support/oracle/gen/domain.ts"
import type { GenFacts, StoredRow } from "#test/support/oracle/gen/facts.ts"
import type { GenRelation, GenSchema } from "#test/support/oracle/gen/schema.ts"

/**
 * The planner settings a perturbation draws from. The nested loop is never turned off: it is the one join method that
 * can run every join, and PostgreSQL 19 gates the nested loop's materialize and memoize on enable_nestloop (planner.c
 * default_pgs_mask). With it off, a join no enabled method can run (a cross product, a join filter, an equality no hash
 * or merge join can run, as vector's, or every join once hash and merge joins are off too) falls back to a plain nested
 * loop that runs its inner side again for every outer row, and such joins nested in each other's inner sides multiply
 * their rows. Turning hash and merge joins off forces the nested loop, materialized.
 */
const plannerSettings = [
	"enable_hashjoin = off",
	"enable_mergejoin = off",
	"enable_sort = off",
	"debug_parallel_query = regress",
	"plan_cache_mode = force_generic_plan",
	"parallel_setup_cost = 0",
	"parallel_tuple_cost = 0",
	"min_parallel_table_scan_size = 0"
] as const

export type PlannerSetting = (typeof plannerSettings)[number]

/**
 * Plan perturbation of the differential oracles. Generated inputs stay small and tricky; the diversity of plans comes
 * from perturbing the planner and scaling the row counts, not from large data.
 *
 * Each explored case also draws a perturbation, chosen per case from the stream's seed and shrunk with the case:
 *
 * - a random subset of planner settings, each set with SET LOCAL in the case's transaction after its facts are loaded
 *   and analyzed: the hash and merge joins and the explicit sort turned off one by one, debug_parallel_query =
 *   regress, which plans every eligible query in parallel, the parallel setup and tuple costs and the smallest
 *   parallel scan at zero, so a parallel plan scans even a small table in workers and aggregates partially, and
 *   plan_cache_mode = force_generic_plan, which plans every parameterized statement without its parameter values;
 * - a fact multiplier: the stored facts repeated under fresh keys, so row counts scale while every value stays small.
 *
 * A correct lowering returns the same values under every plan and every scale, which grizzle delivers in one form, so
 * every form of a case must still agree exactly with the reference and the conservative lowering. The perturbation reaches the runners through the Effect reference
 * CurrentPerturbation, which oracleCheck and the write oracle provide for each explored case and which is unperturbed
 * everywhere else. A runner that goes through an opened Db (the write oracle, the derived refresh oracle) sets the
 * planner settings in each of its transactions through perturbedContext.
 *
 * A copy of a relation's facts relabels the values of its key columns that are neither part of a containment's source
 * fields nor of a type with a refinement: integers to 1000·j + r, uuids to f0000000-…-j·4096 + r, where j numbers the
 * copy and r ranks the value among every relabeled value of its type in the case. Relabeling by rank across the whole
 * case keeps every copy isomorphic to the original on the relabeled columns (a graph's copy is the same graph), keeps
 * copies disjoint from each other and from every generated value, and keeps every containment intact: a copied source
 * fact points at the original target fact, and a copied target fact has no source facts. A relation with a key that
 * has no column to relabel is not copied.
 */
export interface Perturbation {
	readonly settings: ReadonlyArray<PlannerSetting>
	/** How many copies of the stored facts a case loads: 1 is the facts as generated. */
	readonly multiplier: number
}

export const unperturbed: Perturbation = { settings: [], multiplier: 1 }

/** The settings under which every eligible plan runs in parallel workers, its aggregates partial and then combined. */
export const forcedParallel: Perturbation = {
	settings: [
		"debug_parallel_query = regress",
		"parallel_setup_cost = 0",
		"parallel_tuple_cost = 0",
		"min_parallel_table_scan_size = 0"
	],
	multiplier: 1
}

/** Whether a perturbation forces parallel plans: every setting of forcedParallel among its own. */
export const forcesParallel = (p: Perturbation): boolean =>
	Arr.every(forcedParallel.settings, (s) => p.settings.includes(s))

const maxMultiplier = 3

/** A perturbation per case: each setting in or out, and one to three copies of the facts. It shrinks to none. */
export const perturbationGen: Gen<Perturbation> = (source) => ({
	settings: source.draw(subarray(plannerSettings)),
	multiplier: source.draw(int(1, maxMultiplier))
})

/** A perturbation of the planner settings alone, for a runner whose facts are not query-case facts. */
export const plannerPerturbationGen: Gen<Perturbation> = (source) => ({
	settings: source.draw(subarray(plannerSettings)),
	multiplier: 1
})

/** The perturbation of the case running now: provided per explored case, unperturbed by default. */
export const CurrentPerturbation = Context.Reference<Perturbation>(
	"grizzle/test/oracle/CurrentPerturbation",
	{
		defaultValue: () => unperturbed
	}
)

export const isPerturbed = (p: Perturbation): boolean => p.settings.length > 0 || p.multiplier > 1

/**
 * The planner settings a perturbation leaves off, at its multiplier: the plan a case's answer is read under a second
 * time (the plan invariance relation), so every setting is on in exactly one of the two readings.
 */
export const complementOf = (p: Perturbation): Perturbation => ({
	settings: Arr.filter(plannerSettings, (s) => !p.settings.includes(s)),
	multiplier: p.multiplier
})

/** The statements that set a perturbation's planner settings in the running transaction. */
export const plannerStatements = (p: Perturbation): ReadonlyArray<string> =>
	Arr.map(p.settings, (s) => `SET LOCAL ${s}`)

export const printPerturbation = (p: Perturbation): string =>
	`perturbation: facts x${p.multiplier}${p.settings.length === 0 ? "" : `, SET LOCAL ${Arr.join(p.settings, ", ")}`}`

/** How a copy relabels a value of a relabeled column, or undefined for a type it does not relabel. */
type Relabeling = "int" | "uuid"

const relabelingOf = (type: ScalarType): Relabeling | undefined => {
	switch (type.carrier) {
		case "int2":
		case "int4":
		case "int8":
			return !("serial" in type) && contractOf(type) === undefined ? "int" : undefined
		case "uuid":
			return contractOf(type) === undefined ? "uuid" : undefined
		case "numeric":
		case "float4":
		case "float8":
		case "money":
		case "bool":
		case "text":
		case "code":
		case "bits":
		case "range4":
		case "range8":
		case "vector":
		case "exactInteger":
		case "exactMoney":
			return undefined
	}
}

/** How a copy of `relation` relabels each of its columns, or undefined when some key of it has no column to relabel. */
const relabeledColumns = (
	schema: GenSchema,
	relation: GenRelation
): ReadonlyArray<Relabeling | undefined> | undefined => {
	const fromRelation = Arr.filter(schema.containments, (c) => c.from.relation === relation.name)
	const contained = new Set(Arr.flatMap(fromRelation, (c) => c.from.fields))
	const keys = [relation.primaryKey, ...relation.keys]
	const keyed = new Set(keys.flat())
	const columns = Arr.map(relation.columns, (col) =>
		keyed.has(col.name) && !contained.has(col.name) ? relabelingOf(col.type) : undefined
	)
	const relabeled = (name: string) =>
		Option.exists(
			Arr.findFirstIndex(relation.columns, (col) => col.name === name),
			(i) => columns[i] !== undefined
		)
	const covered = Arr.every(keys, (key) => Arr.some(key, relabeled))
	return covered && Arr.some(columns, (how) => how !== undefined) ? columns : undefined
}

const valueText = (literal: TypedLiteral): string | undefined =>
	literal.kind === "int"
		? literal.value.toString()
		: literal.kind === "uuid"
			? literal.value
			: undefined

const uuidOf = (n: number): Uuid =>
	`f0000000-0000-0000-0000-${pipe(n.toString(16), Str.padStart(12, "0"))}`

/**
 * The stored facts of a case repeated `multiplier` times, every copy past the first under fresh keys (see the header).
 */
export const multiplyFacts = (schema: GenSchema, facts: GenFacts, multiplier: number): GenFacts => {
	if (multiplier <= 1) {
		return facts
	}
	const plans = Arr.map(schema.relations, (relation) => ({
		relation,
		columns: relabeledColumns(schema, relation)
	}))
	/** Every relabeled value of the case, by its relabeling, ranked in a fixed order. */
	const ranks = new Map<string, number>()
	const seen: Record<Relabeling, Array<string>> = { int: [], uuid: [] }
	for (const { relation, columns } of plans) {
		if (columns === undefined) {
			continue
		}
		for (const row of facts[relation.name] ?? []) {
			for (const [i, stored] of row.entries()) {
				const how = columns[i]
				const text = valueText(stored.literal)
				if (how !== undefined && text !== undefined) {
					seen[how].push(text)
				}
			}
		}
	}
	for (const how of ["int", "uuid"] as const) {
		for (const [rank, text] of Arr.sort([...new Set(seen[how])], Order.String).entries()) {
			ranks.set(`${how}:${text}`, rank)
		}
	}
	/** An integer or uuid key value relabeled for a copy, which is canonical: integers and uuids have one spelling. */
	const relabel = (stored: SpelledValue, how: Relabeling, copy: number): SpelledValue => {
		const text = valueText(stored.literal)
		const rank = text === undefined ? undefined : ranks.get(`${how}:${text}`)
		if (rank === undefined) {
			return stored
		}
		return canonicallySpelled(
			how === "int"
				? { kind: "int", value: BigInt(1000 * copy + rank) }
				: { kind: "uuid", value: uuidOf(4096 * copy + rank) }
		)
	}
	const out: Record<string, ReadonlyArray<StoredRow>> = { ...facts }
	for (const { relation, columns } of plans) {
		if (columns === undefined) {
			continue
		}
		const rows = facts[relation.name] ?? []
		const copies: Array<StoredRow> = [...rows]
		for (let copy = 1; copy < multiplier; copy++) {
			appendAll(
				copies,
				Arr.map(rows, (row) =>
					Arr.map(row, (stored, i) => {
						const how = columns[i]
						return how === undefined ? stored : relabel(stored, how, copy)
					})
				)
			)
		}
		out[relation.name] = copies
	}
	return out
}

/**
 * The one statement that sets a perturbation's planner settings in the running transaction, as SET LOCAL does:
 * set_config with is_local true, all of them in one SELECT.
 */
const plannerSelect = (p: Perturbation): EmittedText => {
	const emitted = emit(
		provedSelect(
			"oneRow",
			Arr.map(p.settings, (setting) => {
				const [name, ...value] = Str.split(setting, " = ")
				return target(
					qualifiedCall("pg_catalog", "set_config", [
						lit.text(name, types.text),
						lit.text(Arr.join(value, " = "), types.text),
						lit.bool(true)
					])
				)
			}),
			[],
			undefined
		),
		emptyNameMap
	)
	if (!emitted.ok) {
		throw emitted.error
	}
	return emitted.value.text
}

/**
 * A session whose every transaction sets `statement`'s planner settings first: the statement rides right behind the
 * BEGIN of every flight that opens a transaction, unnamed, and its answer is the caller's to ignore. Every write and
 * refresh opens its transaction so (packages/grizzle/src/adapter/wire/batch.ts writeFrame).
 */
const plannedSession = (session: Session, statement: EmittedText): Session => ({
	...session,
	send: (closes, pipeline, onAnswer, onEnd) => {
		const [begin, ...rest] = pipeline
		if (begin?._tag !== "control" || begin.control.kind !== "begin") {
			session.send(closes, pipeline, onAnswer, onEnd)
			return
		}
		session.send(
			closes,
			[
				begin,
				{ _tag: "statement", sql: statement, params: [], name: { _tag: "unnamed" } },
				...rest
			],
			(index, answer) => {
				if (index !== 1) {
					onAnswer(index === 0 ? 0 : index - 1, answer)
				}
			},
			onEnd
		)
	}
})

/**
 * An opened Db's context whose every transaction sets a perturbation's planner settings: its pool's sessions send
 * plannerSelect as the first statement of every transaction, after BEGIN. The Db's operations on this context
 * (apply, runApplication, refresh) run under the settings; the opened Db's own context is untouched, so admission and
 * every other caller see the role exactly as installed.
 */
export const perturbedContext = (ctx: DbContext, p: Perturbation): DbContext =>
	p.settings.length === 0
		? ctx
		: {
				...ctx,
				pool: {
					...ctx.pool,
					lease: Effect.map(ctx.pool.lease, (session) => plannedSession(session, plannerSelect(p)))
				}
			}
