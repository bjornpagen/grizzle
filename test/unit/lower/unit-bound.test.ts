/**
 * A whole read of a stored derived relation is no unit-bound fault exactly where its rows are an open frontier
 * (analysis/theory/unit.ts frontierOf, lower/unit-bound.ts readTables, sql/unit-bound.ts UnitReach `frontier`): one
 * relation's rows no fact of another settles yet, each removed by the upkeep of the COMMIT that settles it, so the read
 * costs the open rows and never the settled history, as den's stored Pending, its spawned steps with no Result.
 *
 * The box: Step(root, step, kind) and Result(root, step, outcome), each keyed by (root, step), under the unit root,
 * sealed, so the one write that founds a root writes its every row and a derived relation over them is stored whatever
 * its negation binds (analysis/derived/storage.ts); and a stored derived relation Open of Step's rows, drawn from three choices: a negation of Result or none, binding Result's
 * root, its step, both, or its root and its outcome to Step's kind, or all three; Step's rows filtered by kind or not;
 * and Step joined with Result at its key or not.
 *
 * Oracle: the definition, a specification: a frontier reads one relation's rows, joined with none, less those a negation
 * settles at every field of one of its keys; Step's one key is (root, step).
 *
 * Features: a settlement at the key, one at part of the key, one beside a field outside the key, no negation, a filter,
 * a join, a live derivation (a negation of Result at its step alone, at no root: never a frontier, its read its
 * definition's).
 */
import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { boolean, type Gen, int } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { readTables } from "#compiler/lower/unit-bound.ts"
import type { SchemaArtifacts } from "#compiler/program/schema.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { derived, relation, schema, sealed, unit } from "#compiler/public/schema.ts"
import type { Select } from "#compiler/sql/ast.ts"
import { col, core, proved, table, target } from "#compiler/sql/build.ts"
import { readFaults } from "#compiler/sql/unit-bound.ts"
import { succeeded } from "#test/support/assert.ts"
import { testArtifacts, testCompile } from "#test/support/compile.ts"

/** The features the space reaches. */
type FrontierFeature =
	| "a settlement at the key"
	| "a settlement at part of the key"
	| "a settlement beside a field outside the key"
	| "no negation"
	| "a filter"
	| "a join"
	| "a live derivation"

/**
 * What Open's negation of Result binds, by Result's fields, each at Step's field of its name but outcome, which it binds
 * at Step's kind; none where Open negates nothing.
 */
const negations = [
	[],
	["root"],
	["step"],
	["root", "step"],
	["root", "outcome"],
	["root", "step", "outcome"]
] as const

/** A drawn Open: its negation (by its place in `negations`, 0 none), its filter, its join. */
interface Definition {
	readonly negation: number
	readonly filtered: boolean
	readonly joined: boolean
}

const definitionGen: Gen<Definition> = (source) => ({
	negation: int(0, negations.length - 1)(source),
	filtered: boolean(source),
	joined: boolean(source)
})

/** Whether Open's rows are an open frontier (the oracle): no join, and a negation binding Step's whole key. */
const isFrontier = (d: Definition): boolean => {
	const bound: ReadonlyArray<string> = negations[d.negation] ?? []
	return !d.joined && bound.includes("root") && bound.includes("step")
}

const i = pg.integer
const Step = relation("Step", { root: i, step: i, kind: i }, ["root", "step"])
const Result = relation("Result", { root: i, step: i, outcome: i }, ["root", "step"])
const Base = schema("Frontier", [Step, Result], [sealed(unit("root", { root: i }))])

/** Open as `d` draws it. */
const openOf = (d: Definition) =>
	derived(
		"Open",
		query(Base).rule((r) => {
			const { root, step, kind } = v(Step, "s")
			const { outcome } = v(Result, "r")
			const matched = d.joined
				? r.match(Step, { root, step, kind }).match(Result, { root, step, outcome })
				: r.match(Step, { root, step, kind })
			const filtered = d.filtered ? matched.where(r.eq(kind, 3)) : matched
			switch (d.negation) {
				case 1:
					return filtered.where(r.not(Result, { root })).find({ root, step, kind })
				case 2:
					return filtered.where(r.not(Result, { step })).find({ root, step, kind })
				case 3:
					return filtered.where(r.not(Result, { root, step })).find({ root, step, kind })
				case 4:
					return filtered.where(r.not(Result, { root, outcome: kind })).find({ root, step, kind })
				case 5:
					return filtered
						.where(r.not(Result, { root, step, outcome: kind }))
						.find({ root, step, kind })
				default:
					return filtered.find({ root, step, kind })
			}
		})
	)

/** A drawn Open's key among the compiled ones. */
const keyOf = (d: Definition): string => `${d.negation} ${d.filtered} ${d.joined}`

/** Every drawn Open's artifacts, compiled once for the box. */
const compiled: ReadonlyMap<string, SchemaArtifacts> = new Map(
	Arr.flatMap(
		Array.from({ length: negations.length }, (_, negation) => negation),
		(negation) =>
			Arr.flatMap([false, true], (filtered) =>
				Arr.map([false, true], (joined) => {
					const d = { negation, filtered, joined }
					const top = schema.extend([Base], "FrontierOpen", [openOf(d)], [])
					return [
						keyOf(d),
						succeeded(testArtifacts(top, testCompile), `Open ${keyOf(d)} compiles`)
					] as const
				})
			)
	)
)

/** Every row of Open's table, read whole under `artifacts`' names. */
const wholeRead = (artifacts: SchemaArtifacts): Select => {
	const t = artifacts.names.relation("Open")
	return {
		kind: "select",
		with: undefined,
		body: proved(
			"certified",
			core(
				[target(col("o", artifacts.names.column("Open", "step")))],
				[table(t.schema, t.name, "o")],
				undefined
			)
		),
		orderBy: [],
		limit: undefined,
		offset: undefined
	}
}

/** A stored derived relation's whole read is accepted exactly where its rows are an open frontier. */
export const aStoredRelationsWholeReadIsAcceptedExactlyWhereItsRowsAreAnOpenFrontier =
	property.explore(definitionGen, {
		needs: {},
		situations: [
			"a settlement at the key",
			"a settlement at part of the key",
			"a settlement beside a field outside the key",
			"no negation",
			"a filter",
			"a join",
			"a live derivation"
		] satisfies ReadonlyArray<Reached<FrontierFeature>>,
		check: (_, c: Case<FrontierFeature>) => (d) =>
			Effect.sync(() => {
				const bound: ReadonlyArray<string> = negations[d.negation] ?? []
				if (bound.length === 0) {
					c.note("no negation")
				} else if (bound.includes("root") && bound.includes("step")) {
					c.note("a settlement at the key")
				} else {
					c.note("a settlement at part of the key")
				}
				if (bound.includes("outcome")) {
					c.note("a settlement beside a field outside the key")
				}
				if (d.filtered) {
					c.note("a filter")
				}
				if (d.joined) {
					c.note("a join")
				}
				const artifacts = compiled.get(keyOf(d))
				if (artifacts === undefined) {
					return assert.fail(`no artifacts for Open ${keyOf(d)}`)
				}
				const facts = artifacts.laws.theory.regionFacts
				if (!facts.members.has("Open")) {
					c.note("a live derivation")
					assert.ok(
						!facts.frontiers.has("Open"),
						`Open ${keyOf(d)} is live, a read of it its definition's, and no frontier`
					)
					return
				}
				const faults = readFaults(
					{ kind: "statement", statement: wholeRead(artifacts) },
					readTables(facts, artifacts.derived, artifacts.names, artifacts.names, () => false),
					"held"
				)
				assert.equal(
					faults.length === 0,
					isFrontier(d),
					`Open ${keyOf(d)}: its whole read ${faults.length === 0 ? "accepted" : "refused"}, its rows ${isFrontier(d) ? "an open frontier" : "no open frontier"}`
				)
			}),
		oracle: {
			kind: "specification",
			name: "the definition: a frontier reads one relation's rows, joined with none, less those a negation settles at every field of one of its keys"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/theory/theory.ts",
				original: "\t\t\t\t\treturn settledBy === undefined ? [] : [[name, settledBy] as const]\n",
				replacement: "\t\t\t\t\treturn [[name, settledBy ?? name] as const]\n",
				why: "Every stored relation's whole read accepted: a stored derivation that keeps every row it ever derived, or a row per value of part of a key, is read whole at every unit's rows."
			},
			{
				file: "packages/engine/src/analysis/theory/unit.ts",
				original: "\t\t\tk.every((field) => {\n",
				replacement: "\t\t\tk.some((field) => {\n",
				why: "A settlement at part of a key taken for one at the key: a root's steps stay until its first Result, every step of a busy root read whole."
			},
			{
				file: "packages/engine/src/analysis/theory/unit.ts",
				original: "\t\tothers.length > 0 ||\n",
				replacement: "",
				why: "A join's rows taken for its first relation's: the negation settles the first relation's rows, never the join's, whose rows no settlement bounds."
			}
		]
	})
