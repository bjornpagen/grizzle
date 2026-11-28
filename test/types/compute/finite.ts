import { assert, defined } from "@bjornpagen/testing/assert"
import { Array as Arr, Effect, Result, String as Str } from "effect"
import { CompileError } from "#compiler/core/errors.ts"
import type { Refused } from "#compiler/core/refusals.ts"
import { pg } from "#compiler/public/fields.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { queryOver, varsOver } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { computeCore } from "#compiler/scalar/compute/builders.ts"
import { compileTemplate, testCompile } from "#test/support/compile.ts"
import { preludeAt, preludeFrom, preludeModule } from "#test/support/prelude.ts"
import { batchOwned, caseOwned, type Entry, type Program } from "#test/support/types/batch/batch.ts"

/**
 * The finite-guard program: every subject a finiteness guard or a finite precondition meets, each under every operation
 * that reads its finiteness, exhausted and printed as one program the type batch checks.
 *
 * The oracle is what PostgreSQL 19 lets each subject's type hold beyond its finite values (Holds), and whether its
 * type's digits fit bigint: a float and a numeric of no typmod hold NaN and both infinities, a float's numeric keeping
 * them (float8_numeric); numeric(p, s) holds NaN and no infinity, which its typmod refuses (numeric.c
 * apply_typmod_special: "A field with precision %d, scale %d cannot hold an infinite value"); numeric(p, 0) holds
 * neither, an integer type grizzle refuses NaN in at every door. A guard tests exactly what its subject may hold, so it
 * is no guard of a type that holds nothing but finite values, which is finite by its type and casts into bigint
 * unguarded where its digits fit. The types are held to the table by the program's directives, and compilation by the
 * engine's verdict on each case, built and compiled beside it (engineOutcome), its guard's SQL comparing the subject
 * with exactly the values its type holds that are not finite.
 */

/** The subjects: a field of each numeric and float type the guard reads, and the numeric a double is cast into. */
const subjects = [
	"numeric",
	"numeric(10, 2)",
	"numeric(18, 0)",
	"numeric(19, 0)",
	"double precision",
	"a double's numeric"
] as const

type Subject = (typeof subjects)[number]

/** The operations that read a subject's finiteness. */
const operations = ["guard", "guarded cast", "cast", "within cast", "minScale"] as const

type Operation = (typeof operations)[number]

/** What a subject's type holds beyond its finite values, as PostgreSQL 19 stores it. */
type Holds = "NaN and the infinities" | "NaN" | "nothing"

/** A case's verdict: admitted, refused for its magnitude alone, which compilation decides and no type reads, refused
 * for a finiteness its type does not prove, or refused by its subject's type. */
type Outcome = "admitted" | "decided: fits" | "refused: finite" | "refused: type"

type Vars = ReturnType<typeof varsOver>

/** Nums, a field of each subject's type, and its schema, as the program's header declares them. */
const Nums = relation(
	"Nums",
	{
		id: pg.bigint,
		nu: pg.numeric,
		n2: pg.numeric(10, 2),
		n18: pg.numeric(18, 0),
		n19: pg.numeric(19, 0),
		d: pg["double precision"]
	},
	["id"]
)
const Root = schema("Root", [Nums], [])

const header = `export const Nums = relation("Nums", { id: pg.bigint, nu: pg.numeric, n2: pg.numeric(10, 2), n18: pg.numeric(18, 0), n19: pg.numeric(19, 0), d: pg["double precision"] }, ["id"])
export const Root = schema("Root", [Nums], [])
`

/**
 * Each subject: the field it reads, its term in the program and in the engine, what its type holds beyond its finite
 * values, whether every finite value of its type fits bigint by its digits, and whether it is a numeric or a float.
 */
const subjectOf: {
	readonly [S in Subject]: {
		readonly field: "nu" | "n2" | "n18" | "n19" | "d"
		readonly text: string
		readonly term: (n: Vars) => unknown
		readonly holds: Holds
		readonly fits: boolean
		readonly family: "numeric" | "float"
	}
} = {
	numeric: {
		field: "nu",
		text: "n.nu",
		term: (n) => n["nu"],
		holds: "NaN and the infinities",
		fits: false,
		family: "numeric"
	},
	"numeric(10, 2)": {
		field: "n2",
		text: "n.n2",
		term: (n) => n["n2"],
		holds: "NaN",
		fits: true,
		family: "numeric"
	},
	"numeric(18, 0)": {
		field: "n18",
		text: "n.n18",
		term: (n) => n["n18"],
		holds: "nothing",
		fits: true,
		family: "numeric"
	},
	"numeric(19, 0)": {
		field: "n19",
		text: "n.n19",
		term: (n) => n["n19"],
		holds: "nothing",
		fits: false,
		family: "numeric"
	},
	"double precision": {
		field: "d",
		text: "n.d",
		term: (n) => n["d"],
		holds: "NaN and the infinities",
		fits: false,
		family: "float"
	},
	"a double's numeric": {
		field: "d",
		text: "Type.cast(n.d, pg.numeric)",
		term: (n) => computeCore.cast(n["d"], pg.numeric),
		holds: "NaN and the infinities",
		fits: false,
		family: "numeric"
	}
}

/** Within's bounds over a subject of each family: values of its language, within which a bigint cast fits. */
const boundsOf = {
	numeric: { text: ["-1000n", "1000n"], values: [-1000n, 1000n] },
	float: { text: ["-1000", "1000"], values: [-1000, 1000] }
} as const

/** Each operation: the rule's tail after its match, in the program and in the engine, over the subject `x`. */
const operationOf: {
	readonly [O in Operation]: {
		readonly text: (x: string, family: "numeric" | "float") => string
		readonly build: (
			matched: RuleValue,
			n: Vars,
			x: unknown,
			family: "numeric" | "float"
		) => ReturnType<RuleValue["find"]>
	}
} = {
	guard: {
		text: (x) => `.where(Num.isFinite(${x})).find({ id: n.id })`,
		build: (matched, n, x) => matched.where(computeCore.isFinite(x)).find({ id: n["id"] })
	},
	"guarded cast": {
		text: (x) =>
			`.find({ k: Logic.when(Num.isFinite(${x}), (k) => Type.cast(k, pg.bigint), Type.literal(pg.bigint, 0n)) })`,
		build: (matched, _, x) =>
			matched.find({
				k: computeCore.when(
					computeCore.isFinite(x),
					(k: unknown) => computeCore.cast(k, pg.bigint),
					computeCore.literal(pg.bigint, 0n)
				)
			})
	},
	cast: {
		text: (x) => `.find({ k: Type.cast(${x}, pg.bigint) })`,
		build: (matched, _, x) => matched.find({ k: computeCore.cast(x, pg.bigint) })
	},
	"within cast": {
		text: (x, family) =>
			`.find({ k: Logic.when(Num.within(${x}, ${boundsOf[family].text[0]}, ${boundsOf[family].text[1]}), (k) => Type.cast(k, pg.bigint), Type.literal(pg.bigint, 0n)) })`,
		build: (matched, _, x, family) =>
			matched.find({
				k: computeCore.when(
					computeCore.within(x, boundsOf[family].values[0], boundsOf[family].values[1]),
					(k: unknown) => computeCore.cast(k, pg.bigint),
					computeCore.literal(pg.bigint, 0n)
				)
			})
	},
	minScale: {
		text: (x) => `.find({ k: Num.minScale(${x}) })`,
		build: (matched, _, x) => matched.find({ k: computeCore.minScale(x) })
	}
}

/** One case: a subject, and the operation over it. */
interface FiniteCase {
	readonly subject: Subject
	readonly operation: Operation
}

const boxCases: ReadonlyArray<FiniteCase> = Arr.flatMap(subjects, (subject) =>
	Arr.map(operations, (operation): FiniteCase => ({ subject, operation }))
)

/** The cells of finiteBox, minted as a dictionary in its door (test/types/compute/finite.dictionary.ts). */
export const finiteBoxItems: Arr.NonEmptyReadonlyArray<FiniteCase> = [
	defined(boxCases[0], "a case of the finite box"),
	...Arr.drop(boxCases, 1)
]

/**
 * The table's verdict on a case. A guard is admitted exactly where its subject's type holds something not finite, and
 * refused by its subject's type where it holds nothing; a bigint cast needs its operand finite, by its type or a
 * guard, then fitting bigint, by its type's digits or a within guard's bounds; minScale takes a numeric proved finite.
 */
const expected = (c: FiniteCase): Outcome => {
	const s = subjectOf[c.subject]
	const finiteByType = s.holds === "nothing"
	switch (c.operation) {
		case "guard":
			return finiteByType ? "refused: type" : "admitted"
		case "guarded cast":
			return finiteByType ? "refused: type" : s.fits ? "admitted" : "decided: fits"
		case "cast":
			return finiteByType ? (s.fits ? "admitted" : "decided: fits") : "refused: finite"
		case "within cast":
			return "admitted"
		case "minScale":
			return s.family === "float" ? "refused: type" : finiteByType ? "admitted" : "refused: finite"
	}
}

/** The case built in the engine: its query over Root. */
const engineQuery = (c: FiniteCase) => {
	const s = subjectOf[c.subject]
	return queryOver(Root).rule((r: RuleValue) => {
		const n = varsOver(Nums, "n")
		const matched = r.match(Nums, { id: n["id"], [s.field]: n[s.field] })
		return operationOf[c.operation].build(matched, n, s.term(n), s.family)
	})
}

/** The engine's refusal of a case, as an outcome; undefined for any refusal no outcome names. */
const refusalOutcome = (error: unknown): Outcome | undefined => {
	if (!(error instanceof CompileError)) {
		return undefined
	}
	const reason = error.reason
	if (reason._tag === "MalformedDescription") {
		return "refused: type"
	}
	if (reason._tag === "PartialOperation") {
		return reason.precondition === "fits"
			? "decided: fits"
			: reason.precondition === "finite"
				? "refused: finite"
				: undefined
	}
	return undefined
}

/** The SQL a guard compares its subject with: exactly the values its type holds that are not finite. */
const guardComparisons: { readonly [H in Holds]: ReadonlyArray<readonly [string, boolean]> } = {
	"NaN and the infinities": [
		["'-Infinity'", true],
		["'Infinity'", true],
		["<> 'NaN'", false]
	],
	NaN: [
		["<> 'NaN'", true],
		["Infinity", false]
	],
	nothing: []
}

/**
 * The engine's verdict on a case, held to the table: built, then compiled; a guard admitted states the comparisons of
 * exactly the values its subject's type holds that are not finite (guardComparisons).
 */
const engineOutcome = (c: FiniteCase): Outcome => {
	const built = Result.try(() => engineQuery(c))
	if (Result.isFailure(built)) {
		return defined(
			refusalOutcome(built.failure),
			`${c.operation} over ${c.subject}: a refusal the table names`
		)
	}
	const template = compileTemplate(built.success, undefined, testCompile)
	if (!template.ok) {
		return defined(
			refusalOutcome(template.error),
			`${c.operation} over ${c.subject}: a refusal the table names`
		)
	}
	if (c.operation === "guard") {
		const sql = template.value.run.statement.sql.text
		for (const [fragment, present] of guardComparisons[subjectOf[c.subject].holds]) {
			assert.equal(
				Str.includes(fragment)(sql),
				present,
				`the guard over ${c.subject} ${present ? "compares" : "never compares"} it by ${fragment}: ${sql}`
			)
		}
	}
	return "admitted"
}

const finiteRefusal: Refused =
	"a value proved finite: guard it with Logic.when(Num.isFinite(x), (x) => …, otherwise)"

/** A case's directive: the table's refusal of it, by the types' Refusal or by its subject's type; none where admitted. */
const directiveOf = (outcome: Outcome): ReadonlyArray<string> => {
	switch (outcome) {
		case "admitted":
		case "decided: fits":
			return []
		case "refused: finite":
			return [`// @ts-expect-error -- refusal: ${finiteRefusal}`]
		case "refused: type":
			return [
				"// @ts-expect-error -- refused: the subject's type takes no such operation: a finite type no guard, a float no minScale"
			]
	}
}

const caseBlock = (c: FiniteCase, index: number): ReadonlyArray<string> => {
	const outcome = expected(c)
	assert.equal(
		engineOutcome(c),
		outcome,
		`compilation's verdict on ${c.operation} over ${c.subject}`
	)
	const s = subjectOf[c.subject]
	return [
		`// ${c.operation} over ${c.subject}`,
		...directiveOf(outcome),
		`export const c${index} = query(Root).rule((r) => { const n = v(Nums, "n"); return r.match(Nums, { id: n.id, ${s.field}: n.${s.field} })${operationOf[c.operation].text(s.text, s.family)} })`,
		""
	]
}

/** The program's prelude (test/support/programs/finite.ts). */
const prelude = await Effect.runPromise(preludeAt("test/support/programs/finite.ts"))

/** The program over a batch's cases, its imports read through its prelude as `entry` reaches it. */
export const finiteProgram = (
	cases: Arr.NonEmptyReadonlyArray<FiniteCase>,
	entry: Entry
): Program => [
	preludeModule(
		"index.ts",
		"// Generated by test/types/compute/finite.ts: each finiteness operation over each numeric and float subject.",
		preludeFrom(prelude, entry),
		[
			{ owner: batchOwned, lines: Str.split(header, "\n") },
			...Arr.map(cases, (c, at) => ({ owner: caseOwned(at), lines: caseBlock(c, at) }))
		]
	)
]
