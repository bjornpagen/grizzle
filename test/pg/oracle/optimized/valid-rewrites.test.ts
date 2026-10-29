/**
 * The mutant suite's six valid transformations are performed by the optimized lowering, which its certificates
 * assert.
 *
 * Each runs on the generated population rooted at the construct its rule is about (test/support/oracle/mutants
 * cases.ts, the valid-mutant populations, dense facts) through the optimized differential, so every case also agrees
 * with the conservative lowering in raw multisets with no repeated row. On some cases, which the suite's feature
 * registry requires, the optimized artifact performs the transformation, and wherever its certificate is recorded the
 * emitted SQL shows it, read from the statements' ASTs, never from the text:
 *
 * | V  | Certificate       | What the optimized statements show against the conservative ones     |
 * | V1 | R17.elide.retainedPrimaryKey    | fewer DISTINCT cores                                                  |
 * | V2 | R17.elide.combinedJoinKeys      | fewer DISTINCT cores                                                  |
 * | V3 | R02.existence                   | an EXISTS whose query has no DISTINCT core, which the conservative lowering never emits |
 * | V4 | R17.contribution                | a grouped core reading its contributions without DISTINCT             |
 * | V5 | R17.unionAll                    | a UNION ALL, which the conservative lowering never emits              |
 * | V6 | R17.recursiveTerms              | a WITH RECURSIVE whose seed and step cores, and the derived tables they read directly, carry no DISTINCT, which the conservative lowering never emits |
 */

import { layer } from "@effect/vitest"
import { sketched } from "@grizzle/testing/explore"
import { features } from "@grizzle/testing/features"
import { constant, type Gen } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Duration, Effect, Formatter, String as Str } from "effect"
import type { TestContext } from "vitest"
import { flight } from "#compiler/lower/conservative/types.ts"
import type { Expr, Select, SelectBody, SelectCore, SetOperation } from "#compiler/sql/ast.ts"
import { identityHooks, transformStatement } from "#compiler/sql/transform.ts"
import { optimizedShrink, validRewriteRules } from "#test/pg/oracle/optimized/suite.ts"
import {
	agrees,
	baselineIsSet,
	type DifferentialOutcome,
	differentialCase,
	plainDifferential,
	printDifferential
} from "#test/pg/oracle/optimized/support.ts"
import type { QueryCase } from "#test/support/oracle/gen/case.ts"
import { defaultGenConfig } from "#test/support/oracle/gen/case.ts"
import {
	closureRoot,
	groupRoot,
	keyedJoinRoot,
	projectRoot,
	rootedCaseGen,
	taggedUnionRoot,
	witnessRoot
} from "#test/support/oracle/mutants/cases.ts"
import { mutants } from "#test/support/oracle/mutants/mutants.ts"
import { oracleCheck, PropertyFailed } from "#test/support/oracle/runner.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

const cases = 300

/** A valid transformation's certificate rule, and the mutant it is. */
type ValidRule = (typeof validRewriteRules)[number]
type ValidId = "V1" | "V2" | "V3" | "V4" | "V5" | "V6"

/**
 * The parts of some statements' ASTs, read through the transform's typed hooks, each returning what it was given:
 * every SELECT core, every query (CTE bodies, derived tables and subqueries included), and every expression.
 */
interface Parts {
	readonly cores: ReadonlyArray<SelectCore>
	readonly selects: ReadonlyArray<Select>
	readonly exprs: ReadonlyArray<Expr>
}

const partsOf = (statements: ReadonlyArray<{ readonly ast: Select }>): Parts => {
	const cores: Array<SelectCore> = []
	const selects: Array<Select> = []
	const exprs: Array<Expr> = []
	for (const s of statements) {
		transformStatement(s.ast, {
			...identityHooks,
			core: (core) => {
				cores.push(core)
				return core
			},
			select: (select) => {
				selects.push(select)
				return select
			},
			expr: (e) => {
				exprs.push(e)
				return e
			}
		})
	}
	return { cores, selects, exprs }
}

const distinctCores = (statements: ReadonlyArray<{ readonly ast: Select }>): number =>
	Arr.filter(partsOf(statements).cores, (core) => core.distinct !== false).length

/**
 * Whether a core reads only plain inputs: it carries no DISTINCT, and neither does the top core of any derived table
 * it reads directly.
 */
const plainCore = (core: SelectCore): boolean =>
	core.distinct === false &&
	Arr.every(
		core.from,
		(f) => f.kind !== "derived" || f.query.body.kind !== "core" || f.query.body.distinct === false
	)

/** Whether a query's top core is a plain core. */
const plainQuery = (query: Select): boolean => query.body.kind === "core" && plainCore(query.body)

/** Whether some statement has an EXISTS over a plain witness. */
const plainExists = (statements: ReadonlyArray<{ readonly ast: Select }>): boolean =>
	Arr.some(partsOf(statements).exprs, (e) => e.kind === "exists" && plainQuery(e.query))

/** The set operations of a query body, nested ones included; a parenthesized query arm is a query of its own. */
const setOperations = (body: SelectBody): ReadonlyArray<SetOperation> =>
	body.kind === "setOp" ? [body, ...setOperations(body.left), ...setOperations(body.right)] : []

const unionAll = (statements: ReadonlyArray<{ readonly ast: Select }>): boolean =>
	Arr.some(partsOf(statements).selects, (q) =>
		Arr.some(setOperations(q.body), (op) => op.op === "UNION ALL")
	)

/** The top-level cores of a set operation's arms. */
const armCores = (body: SelectBody): ReadonlyArray<SelectCore> => {
	switch (body.kind) {
		case "setOp":
			return [...armCores(body.left), ...armCores(body.right)]
		case "select":
			return armCores(body.body)
		case "core":
			return [body]
	}
}

/**
 * Whether some statement has a WITH RECURSIVE whose UNION terms are plain cores: no term deduplicates itself or reads a
 * deduplicated derived table directly, so the recursive UNION's own deduplication is the only one (V6). The
 * conservative terms read their input through a SELECT DISTINCT derived table, which this rejects.
 */
const plainRecursiveTerms = (statements: ReadonlyArray<{ readonly ast: Select }>): boolean =>
	Arr.some(
		partsOf(statements).selects,
		(q) =>
			q.with?.recursive === true &&
			Arr.some(q.with.ctes, (cte) => {
				if (cte.query.kind !== "select") {
					return false
				}
				const body = cte.query.body
				if (body.kind !== "setOp" || body.op !== "UNION") {
					return false
				}
				const arms = armCores(body)
				return arms.length >= 2 && Arr.every(arms, plainCore)
			})
	)

/** What the emitted SQL shows when a rule's certificate is recorded. */
const shows: Readonly<Record<ValidId, (o: DifferentialOutcome) => string | undefined>> = {
	V1: (o) =>
		distinctCores(flight(o.optimizedProgram.roots)) <
		distinctCores(flight(o.conservativeProgram.roots))
			? undefined
			: "no fewer DISTINCT cores than the conservative statements",
	V2: (o) =>
		distinctCores(flight(o.optimizedProgram.roots)) <
		distinctCores(flight(o.conservativeProgram.roots))
			? undefined
			: "no fewer DISTINCT cores than the conservative statements",
	V3: (o) => {
		if (plainExists(flight(o.conservativeProgram.roots))) {
			return "the conservative lowering emitted an EXISTS over a plain witness"
		}
		return plainExists(flight(o.optimizedProgram.roots))
			? undefined
			: "no EXISTS over a plain witness"
	},
	V4: (o) =>
		Arr.some(
			partsOf(flight(o.optimizedProgram.roots)).selects,
			(q) => q.body.kind === "core" && q.body.groupBy.length > 0 && plainQuery(q)
		)
			? undefined
			: "no grouped core over plain contributions",
	V5: (o) => {
		if (unionAll(flight(o.conservativeProgram.roots))) {
			return "the conservative lowering emitted UNION ALL"
		}
		return unionAll(flight(o.optimizedProgram.roots)) ? undefined : "no UNION ALL"
	},
	V6: (o) => {
		if (plainRecursiveTerms(flight(o.conservativeProgram.roots))) {
			return "the conservative lowering emitted a WITH RECURSIVE whose UNION terms are plain cores"
		}
		return plainRecursiveTerms(flight(o.optimizedProgram.roots))
			? undefined
			: "no WITH RECURSIVE whose UNION terms are plain cores"
	}
}

/**
 * Every case of a valid mutant's population agrees, and wherever the optimized artifact records the mutant's
 * certificate the emitted SQL shows it; some case records it.
 */
const performed = (ctx: TestContext, id: ValidId, gen: Gen<QueryCase>, rule: ValidRule) =>
	searched(
		ctx,
		Effect.gen(function* () {
			const s = yield* Substrate
			const schema = yield* s.schema({ create: false, label: "valid" })
			return yield* oracleCheck(
				sketched(gen, constant),
				{
					suite: `optimized/valid-${Str.toLowerCase(id)}`,
					literal: Formatter.format,
					features: features<ValidRule>([rule]),
					kept: [],
					runs: cases,
					shrink: optimizedShrink,
					steering: { kind: "none" },
					caseHang: Duration.minutes(2),
					perturb: "all"
				},
				(resolved, k) =>
					Effect.gen(function* () {
						const o = yield* differentialCase(k.draw(resolved), { ...plainDifferential, schema })
						if (!baselineIsSet(o) || !agrees(o)) {
							return yield* PropertyFailed.make({ report: printDifferential(o) })
						}
						if (!Arr.some(o.certificates, (cert) => cert.rule === rule)) {
							return
						}
						k.note(rule)
						const problem = shows[id](o)
						if (problem !== undefined) {
							return yield* PropertyFailed.make({
								report: `${id}: ${rule} is recorded but the SQL has ${problem}\n${printDifferential(o)}`
							})
						}
					})
			)
		})
	)

/** The title of a valid mutant's test. */
const titleOf = (id: ValidId, rule: ValidRule): string =>
	`${id} (${mutants[id].check}): ${rule} is recorded and the SQL shows it, on ${cases} agreeing cases`

layer(Substrate.layer)("the six valid transformations, performed and certified", (it) => {
	it.effect(
		titleOf("V1", validRewriteRules[0]),
		(ctx) =>
			performed(ctx, "V1", rootedCaseGen(projectRoot, defaultGenConfig), validRewriteRules[0]),
		900_000
	)
	it.effect(
		titleOf("V2", validRewriteRules[1]),
		(ctx) =>
			performed(ctx, "V2", rootedCaseGen(keyedJoinRoot, defaultGenConfig), validRewriteRules[1]),
		900_000
	)
	it.effect(
		titleOf("V3", validRewriteRules[2]),
		(ctx) =>
			performed(ctx, "V3", rootedCaseGen(witnessRoot, defaultGenConfig), validRewriteRules[2]),
		900_000
	)
	it.effect(
		titleOf("V4", validRewriteRules[3]),
		(ctx) => performed(ctx, "V4", rootedCaseGen(groupRoot, defaultGenConfig), validRewriteRules[3]),
		900_000
	)
	it.effect(
		titleOf("V5", validRewriteRules[4]),
		(ctx) =>
			performed(ctx, "V5", rootedCaseGen(taggedUnionRoot, defaultGenConfig), validRewriteRules[4]),
		900_000
	)
	it.effect(
		titleOf("V6", validRewriteRules[5]),
		(ctx) =>
			performed(
				ctx,
				"V6",
				rootedCaseGen(closureRoot(false), defaultGenConfig),
				validRewriteRules[5]
			),
		900_000
	)
})
