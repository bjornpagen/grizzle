import { Array as Arr, Effect, Result } from "effect"
import { summarize } from "#bench/cold/stats.ts"
import {
	type CaseRecord,
	defineGate,
	equivalence,
	mechanism,
	type VerdictInput
} from "#bench/harness/gate.ts"
import { patternDictionary } from "#bench/harness/limits.ts"
import { GateSetupError, settle } from "#bench/query/support/kit.ts"
import {
	attemptLabel,
	familyWritesOf,
	installWrites,
	loadedByOwner,
	observedChange,
	openFull,
	timed,
	writePhases
} from "#bench/write/support/writes.ts"
import { indices } from "#compiler/core/array.ts"
import { trusted } from "#compiler/core/trusted.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { Compute } from "#compiler/public/compute.ts"
import { closedId, drawn, natural, pg } from "#compiler/public/fields.ts"
import { check, closed, fin, on, ordered, relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * family-patterns: a family write whose members are each matched against a pattern their kind reads, from a
 * dictionary of more patterns than PostgreSQL's cache of compiled regular expressions holds.
 *
 * The gate's text is the family-patterns entry of bench/harness/rules.ts. The mechanism measured: a family statement's
 * rows go ordered by their pattern input (write/family/pattern-order.ts), so in the member table's physical order
 * (ctid) each kind's rows of one statement are consecutive, and PostgreSQL compiles each pattern once per statement;
 * rows cycling through the dictionary in the order written would miss the cache at every row, since it holds fewer
 * patterns than the cycle (bench/harness/limits.ts patternDictionary).
 *
 * Every figure is recorded beside its check; times gate nothing until a full run of the gate on the build it runs on
 * has measured a ceiling for them.
 */
const kinds: Arr.NonEmptyReadonlyArray<string> = Arr.makeBy(patternDictionary.value, (k) => `K${k}`)

/** The pattern of kind k: its own prefix, then any lowercase letters, so no word matches another kind's pattern. */
const patternOf = (k: number): string => `^k${k}x[a-z]*$`

const build = (name: string) => {
	const Kind = closed("Kind", kinds)
	const Shape = closed.relation(
		"Shape",
		{ kind: closedId(Kind), pattern: str.regex("^.*$", "su") },
		["kind"],
		Arr.map(kinds, (kind, k) => ({ kind, pattern: patternOf(k) }))
	)
	const Owner = relation("Owner", { id: pg.integer, members: drawn(natural) }, ["id"])
	const Item = relation(
		"Item",
		{ owner: pg.integer, at: drawn(natural), kind: closedId(Kind), word: str.regex("^.*$", "su") },
		["owner", "at"]
	)
	const shaped = check("Shaped", Item, (x) => Compute.matches(x.word, Shape.at("pattern", x.kind)))
	return {
		value: schema(name, { Kind, Shape, Owner, Item }, [
			ordered(on(Item, "owner", "at"), fin(Owner, "members")),
			shaped
		]),
		Owner
	}
}

interface Options extends Readonly<Record<string, unknown>> {
	/** The lengths of the families written, one owner each per variant. */
	readonly lengths: ReadonlyArray<number>
}

/** How a family's members take their kinds: cycling through every kind in turn, or all of the first kind. */
type Variant = "cycling" | "uniform"

const kindOf = (variant: Variant, member: number): number =>
	variant === "cycling" ? member % kinds.length : 0

/** The ChangeSet inserting owner `id` with a family of `length` members, each of its variant's kind. */
const family = (s: ReturnType<typeof build>, id: number, length: number, variant: Variant) =>
	ChangeSet.empty(s.value).insert(s.Owner, [
		{
			id,
			members: Arr.map(indices(length), (m) => ({
				kind: `K${kindOf(variant, m)}`,
				word: `k${kindOf(variant, m)}x`
			}))
		}
	])

export default defineGate({
	name: "write-family-patterns",
	gates: ["family-patterns"],
	title:
		"A family write matched against more patterns than PostgreSQL caches: each pattern compiled once per statement",
	scope:
		"one owner per length and variant with a family whose members' CHECK matches each against its kind's pattern, " +
		"written through a Db: members cycling through the dictionary's kinds, and all of one kind; then the member " +
		"table's kinds in physical order.",
	phases: writePhases,
	options: {
		full: { lengths: [640, 64000] },
		quick: { lengths: [128] }
	} satisfies { readonly full: Options; readonly quick: Options },
	run: ({ options }) =>
		Effect.gen(function* () {
			const s = yield* Substrate
			const fx = yield* installWrites(build("FamilyPatterns").value, "benchpatterns", {
				programs: {},
				logins: []
			})
			const S = build(fx.installed.declared)
			const I = fx.table("Item")
			const c = (f: string) => fx.column("Item", f)
			const written: Array<{
				readonly variant: Variant
				readonly length: number
				readonly owner: number
				readonly statements: number
				readonly applied: string
				readonly ms: number
			}> = []
			for (const [i, length] of options.lengths.entries()) {
				for (const [j, variant] of (["cycling", "uniform"] as const).entries()) {
					const owner = 2 * i + j + 1
					const run = yield* Effect.scoped(
						Effect.gen(function* () {
							const db = yield* openFull(fx, S.value)
							const change = observedChange(db, family(S, owner, length, variant), attemptLabel, {
								kind: "none"
							})
							if (Result.isFailure(change)) {
								return yield* Effect.die(change.failure)
							}
							const applied = yield* timed(change.success.apply({}))
							return {
								statements: change.success.statements,
								applied: applied.value,
								ms: applied.ms
							}
						})
					)
					written.push({
						variant,
						length,
						owner,
						statements: familyWritesOf(run.statements, "Item").length,
						applied: run.applied.value.kind,
						ms: run.ms
					})
				}
			}
			yield* settle(fx)
			/** The kinds of one owner's members in the member table's physical order, and the words stored. */
			const stored = (owner: number) =>
				Effect.gen(function* () {
					const rows = yield* s.admin.queryValues(
						`SELECT ${c("kind")}::text, ${c("word")} FROM ${I} WHERE ${c("owner")} = $1::int4 ORDER BY ctid`,
						[String(owner)]
					)
					return Arr.map(rows, (row) => trusted<readonly [string, string]>(row))
				})
			const readings: Array<{
				readonly variant: Variant
				readonly length: number
				readonly statements: number
				readonly runs: number
				readonly words: number
				readonly applied: string
				readonly ms: number
			}> = []
			for (const w of written) {
				const rows = yield* stored(w.owner)
				const runs = Arr.dedupeAdjacent(Arr.map(rows, ([kind]) => kind)).length
				readings.push({ ...w, runs, words: rows.length })
			}
			if (readings.length !== 2 * options.lengths.length) {
				throw new GateSetupError({ what: "a family length was not measured" })
			}
			const cases: Array<CaseRecord<"family-patterns">> = Arr.map(readings, (r) => ({
				name: `a family of ${r.length} members, ${r.variant}`,
				gates: ["family-patterns"],
				conditions: {
					workload: `one owner with ${r.length} nested members, ${r.variant === "cycling" ? `cycling through ${kinds.length} kinds` : "all of one kind"}, written through a Db`,
					schemaState: loadedByOwner,
					dataDistribution: `${2 * options.lengths.length} owners, one family each`,
					parameters: { length: r.length, variant: r.variant, patterns: kinds.length },
					resultSemantics: "every member matches its kind's pattern, so the family commits",
					cacheState: "a fresh Db per family"
				},
				phases: { operationMs: summarize([r.ms]) },
				variants: [],
				comparisons: [],
				transactions: {},
				loads: {},
				measures: {
					statements: r.statements,
					kindRuns: r.runs,
					microsecondsPerMember: Math.round((r.ms * 1000) / r.length)
				}
			}))
			const cycling = Arr.filter(readings, (r) => r.variant === "cycling")
			const verdict: VerdictInput = {
				checks: [
					mechanism(
						"a cycling family's rows run through each kind at most once per statement, in the member table's physical order",
						Arr.every(cycling, (r) => r.runs <= kinds.length * r.statements),
						Arr.join(
							Arr.map(
								cycling,
								(r) =>
									`${r.length}: ${r.runs} runs over ${r.statements} statements of ${kinds.length} kinds`
							),
							", "
						)
					),
					equivalence(
						"every family was accepted, and stores exactly its members",
						Arr.every(readings, (r) => r.applied === "accepted" && r.words === r.length),
						Arr.join(
							Arr.map(readings, (r) => `${r.length} ${r.variant}: ${r.applied}, ${r.words} stored`),
							", "
						)
					)
				]
			}
			return { cases, verdicts: { "family-patterns": verdict } }
		})
})
