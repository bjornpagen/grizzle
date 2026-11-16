import type { Gen } from "@bjornpagen/testing/gen"
import type { Case as PropertyCase, Kill } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter } from "effect"
import { flight } from "#compiler/lower/conservative/types.ts"
import type {
	Expr,
	OperandBody,
	OperandSelect,
	Select,
	SelectCore,
	SetOperation
} from "#compiler/sql/ast.ts"
import { identityHooks, transformStatement } from "#compiler/sql/transform.ts"
import { validRewriteRules } from "#test/pg/oracle/optimized/suite.ts"
import {
	agrees,
	baselineIsSet,
	type DifferentialOutcome,
	differentialCase,
	plainDifferential,
	printDifferential
} from "#test/pg/oracle/optimized/support.ts"
import { programAsts } from "#test/support/compile.ts"
import type { QueryCase } from "#test/support/oracle/gen/case.ts"
import { namedPlacement, oracleProperty, PropertyFailed } from "#test/support/oracle/runner.ts"

/** A valid transformation's certificate rule, and the mutant it is. */
export type ValidRule = (typeof validRewriteRules)[number]
export type ValidId = "V1" | "V2" | "V3" | "V5" | "V6"

/**
 * The parts of some statements' ASTs, read through the transform's typed hooks, each returning what it was given:
 * every SELECT core, every query (CTE bodies, derived tables and subqueries included), and every expression.
 */
interface Parts {
	readonly cores: ReadonlyArray<SelectCore>
	readonly selects: ReadonlyArray<OperandSelect>
	readonly exprs: ReadonlyArray<Expr>
}

const partsOf = (statements: ReadonlyArray<{ readonly ast: Select }>): Parts => {
	const cores: Array<SelectCore> = []
	const selects: Array<OperandSelect> = []
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
const plainQuery = (query: OperandSelect): boolean =>
	query.body.kind === "core" && plainCore(query.body)

/** Whether some statement has an EXISTS over a plain witness. */
const plainExists = (statements: ReadonlyArray<{ readonly ast: Select }>): boolean =>
	Arr.some(partsOf(statements).exprs, (e) => e.kind === "exists" && plainQuery(e.query))

/** The set operation a query body is, if any; a parenthesized query arm is a query of its own. */
const setOperations = (body: OperandBody): ReadonlyArray<SetOperation> =>
	body.kind === "setOp" ? [body] : []

/** Whether some statement has a UNION ALL, besides the body `tagged`, the UNION ALL that tags a statement's parts. */
const unionAll = (
	statements: ReadonlyArray<{ readonly ast: Select }>,
	tagged: OperandBody | undefined
): boolean =>
	Arr.some(
		partsOf(statements).selects,
		(q) => q.body !== tagged && Arr.some(setOperations(q.body), (op) => op.op === "UNION ALL")
	)

/** The top-level cores of a set operation's arms. */
const armCores = (body: OperandBody): ReadonlyArray<SelectCore> => {
	switch (body.kind) {
		case "setOp":
			return Arr.flatMap(body.arms, armCores)
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

/** The optimized program's statement ASTs (test/support/compile.ts programAsts). */
const optimizedAsts = (o: DifferentialOutcome): ReadonlyArray<{ readonly ast: Select }> =>
	Arr.map(programAsts(o.optimizedProgram), (ast) => ({ ast }))

/**
 * The body of the optimized program's statement when its parts are tagged: the UNION ALL that tags their rows
 * (lower/parts.ts taggedParts), which no rewrite emits.
 */
const tagging = (o: DifferentialOutcome): OperandBody | undefined =>
	o.optimizedProgram.parts.kind === "tagged" ? o.optimizedProgram.statement.ast.body : undefined

/** What the emitted SQL shows when a rule's certificate is recorded. */
const shows: Readonly<Record<ValidId, (o: DifferentialOutcome) => string | undefined>> = {
	V1: (o) =>
		distinctCores(optimizedAsts(o)) < distinctCores(flight(o.conservativeProgram.roots))
			? undefined
			: "no fewer DISTINCT cores than the conservative statements",
	V2: (o) =>
		distinctCores(optimizedAsts(o)) < distinctCores(flight(o.conservativeProgram.roots))
			? undefined
			: "no fewer DISTINCT cores than the conservative statements",
	V3: (o) => {
		if (plainExists(flight(o.conservativeProgram.roots))) {
			return "the conservative lowering emitted an EXISTS over a plain witness"
		}
		return plainExists(optimizedAsts(o)) ? undefined : "no EXISTS over a plain witness"
	},
	V5: (o) => {
		if (unionAll(flight(o.conservativeProgram.roots), undefined)) {
			return "the conservative lowering emitted UNION ALL"
		}
		return unionAll(optimizedAsts(o), tagging(o)) ? undefined : "no UNION ALL"
	},
	V6: (o) => {
		if (plainRecursiveTerms(flight(o.conservativeProgram.roots))) {
			return "the conservative lowering emitted a WITH RECURSIVE whose UNION terms are plain cores"
		}
		return plainRecursiveTerms(optimizedAsts(o))
			? undefined
			: "no WITH RECURSIVE whose UNION terms are plain cores"
	}
}

/**
 * Every case of a valid mutant's population agrees, and wherever the optimized artifact records the mutant's
 * certificate the emitted SQL shows it; some case records it (its one required situation, the rule).
 */
export const performed = (
	id: ValidId,
	gen: Gen<QueryCase>,
	rule: ValidRule,
	kills: ReadonlyArray<Kill>
) =>
	oracleProperty(gen, {
		situations: [rule],
		perturb: "all",
		oracle: {
			kind: "second-implementation",
			name: "the conservative lowering's raw text sets, and each rule's certificate read from the statements' ASTs"
		},
		kept: [],
		kills,
		show: Formatter.format,
		check: (k: PropertyCase<ValidRule>) => (c) =>
			Effect.gen(function* () {
				const placement = yield* namedPlacement("valid")
				const o = yield* differentialCase(c, { ...plainDifferential, placement })
				if (!baselineIsSet(o) || !agrees(o)) {
					return yield* new PropertyFailed({ report: printDifferential(o) })
				}
				if (!Arr.some(o.certificates, (cert) => cert.rule === rule)) {
					return
				}
				k.note(rule)
				const problem = shows[id](o)
				if (problem !== undefined) {
					return yield* new PropertyFailed({
						report: `${id}: ${rule} is recorded but the SQL has ${problem}\n${printDifferential(o)}`
					})
				}
			})
	})
