import { indices } from "@bjornpagen/grizzle-text/base/array"
import { Array as Arr } from "effect"
import { jsonText } from "#compiler/core/trusted.ts"
import { type PreludeAt, preludeProgram } from "#test/support/prelude.ts"
import { type EqualSteps, equalSteps } from "#test/types/batch/measured.ts"

/**
 * The programs of a write whose guarded inserts negate bound queries over relation parameters that generic helpers
 * declare, as edullm's answer write negates the admission in force (GRADING-SQL P4-ITEM-2), each checked by
 * guards.test.ts:
 *
 * - the natural form: a call of `admission`, a function of one row, whose two rows arguments are queries bound to
 *   the rule's key and to the posted lists, relation parameters a generic helper `postedIn` declares, as qti-pie's
 *   answerAdmissionOf binds admission_of's. `reasonsInForce` reads the call's reasons in two rules, which choose the
 *   evaluation by the stage's validateResponses, and `hiddenByAdmission` reads its hidden responses. Each of `inserts`
 *   inserts writes a posted list's rows into its sidecar, round the four sidecars, where neither query bound to the
 *   rule's own parameters (`refusedIn`, `hiddenIn`, generic helpers too) names them. A workload serves the write and
 *   the write clocked, and a function applies each through its handle's once. The schema extends a base of `base`
 *   relations no rule reads, so every level the write's types reach is that much larger;
 * - differing rows: two inserts that read one relation parameter `x` under two headings whose `value` fields hold a
 *   bigint and a number, one of them declared by a generic helper, applied with a bigint value, which one heading
 *   refuses.
 */
export type GuardShape = Readonly<{ inserts: number; base: number }>

/** The posted lists, and the sidecars the inserts go round: the period of the inserts' dimension. */
const sidecars = 4

/** The rows arguments of `admission`, each binding the posted lists j with j % args = its index. */
const args = 2

/** The relations of the base each program's schema extends: a small level and a large one. */
export const bases = [10, 40] as const

/** The inserts' dimension, two periods of the sidecars a step: 8, 16 and 24 guarded inserts. */
export const insertSteps: EqualSteps = equalSteps(2 * sidecars)

/** The posted lists argument a reads. */
const postedOf = (a: number): ReadonlyArray<number> =>
	Arr.filter(indices(sidecars), (j) => j % args === a)

/** Relation parameter j's heading, as each rule and helper writes it. */
const headingOf = (j: number): string =>
	`{ variable: Snap${j}.fields.variable, value: Snap${j}.fields.value }`

/** Rows argument a: one rule per posted list it reads, each list's rows of a declared response of the sitting. */
const argumentQuery = (a: number): string => `const doc${a} = query(S)
${Arr.join(
	Arr.map(
		postedOf(a),
		(j) => `	.rule((r) => {
		const given = r.relation("posted${j}", ${headingOf(j)})
		const { variable, value } = v(given, "given")
		return r
			.match(given, { variable, value })
			.match(Var, { child: r.param("child", natural), stage: r.param("stage", natural), variable })
			.find({ variable, value })
	})`
	),
	"\n"
)}`

/** Insert m: sidecar m's posted rows, round the sidecars, that no reason in force and no hidden response names. */
const guardedInsert = (m: number): string => {
	const j = m % sidecars
	return `	.insert(
		Snap${j},
		query(S).rule((r) => {
			const given = r.relation("posted${j}", ${headingOf(j)})
			const { variable, value } = v(given, "given")
			return r
				.match(given, { variable, value })
				.where(r.not(refusedIn(r), {}), r.not(hiddenIn(r), { variable }))
				.find({ child: r.param("child", natural), stage: r.param("stage", natural), variable, value })
		})
	)`
}

/** The posted lists of a call's params, list 0 holding one row. */
const postedParams = Arr.join(
	Arr.map(
		indices(sidecars),
		(j) => `posted${j}: ${j === 0 ? `[{ variable: "a", value: 1n }]` : "[]"}`
	),
	", "
)

/** The natural form at `shape`. */
const naturalForm = (shape: GuardShape): string => `export const Word = str.regex("^[a-z]*$")
${Arr.join(
	Arr.map(
		indices(shape.base),
		(i) => `export const B${i} = relation("B${i}", { k: natural, v: natural }, ["k"])`
	),
	"\n"
)}
export const Stage = relation("Stage", { child: natural, key: natural, validateResponses: pg.boolean }, ["child", "key"])
export const Var = relation("Var", { child: natural, stage: natural, variable: Word }, ["child", "stage", "variable"])
${Arr.join(
	Arr.map(
		indices(sidecars),
		(j) =>
			`export const Snap${j} = relation("Snap${j}", { child: natural, stage: natural, variable: Word, value: natural }, ["child", "stage", "variable"])`
	),
	"\n"
)}
const Doc = rows({ variable: Word, value: natural })
export const admission = fn("admission", {
	calls: [],
	args: { ${Arr.join(
		Arr.map(indices(args), (a) => `doc${a}: Doc`),
		", "
	)}, validate: pg.boolean },
	returns: row(rows({ reasons: rows({ code: Word, variable: Word }), hidden: rows({ response: Word }) })),
	volatility: "immutable",
	nullInput: "called",
	language: "sql",
	body: fn.body\`SELECT NULL\`
})
export const Base = schema("Base", [${Arr.join(
	Arr.map(indices(shape.base), (i) => `B${i}`),
	", "
)}], [])
export const S = schema.extend([Base], "S", [Stage, Var, ${Arr.join(
	Arr.map(indices(sidecars), (j) => `Snap${j}`),
	", "
)}, admission], [])
const keyIn = <L>(r: Rule<L>) => ({ child: r.param("child", natural), stage: r.param("stage", natural) })
const postedIn = <L>(r: Rule<L>) => ({
${Arr.join(
	Arr.map(indices(sidecars), (j) => `	posted${j}: r.relation("posted${j}", ${headingOf(j)})`),
	",\n"
)}
})
${Arr.join(Arr.map(indices(args), argumentQuery), "\n")}
const runIn = <L>(r: Rule<L>, validate: boolean) => {
	const sitting = keyIn(r)
	const posted = postedIn(r)
	return Fn.row(admission, {
${Arr.join(
	Arr.map(
		indices(args),
		(a) =>
			`		doc${a}: doc${a}.bind({ ...sitting, ${Arr.join(
				Arr.map(postedOf(a), (j) => `posted${j}: posted.posted${j}`),
				", "
			)} }),`
	),
	"\n"
)}
		validate
	})
}
const reasonsInForce = query(S)
${Arr.join(
	Arr.map(
		[true, false],
		(validate) => `	.rule((r) => {
		const { reasons } = runIn(r, ${validate})
		const { code, variable } = v(reasons, "reason")
		return r
			.match(Stage, { child: r.param("child", natural), key: r.param("stage", natural), validateResponses: ${validate} })
			.match(reasons, { code, variable })
			.find({ code, variable })
	})`
	),
	"\n"
)}
const hiddenByAdmission = query(S).rule((r) => {
	const { hidden } = runIn(r, false)
	const { response } = v(hidden, "hidden")
	return r.match(hidden, { response }).find({ variable: response })
})
const refusedIn = <L>(r: Rule<L>) => reasonsInForce.bind({ ...keyIn(r), ...postedIn(r) })
const hiddenIn = <L>(r: Rule<L>) => hiddenByAdmission.bind({ ...keyIn(r), ...postedIn(r) })
export const answer = ChangeSet.empty(S)
${Arr.join(Arr.map(indices(shape.inserts), guardedInsert), "\n")}
export const Writer = role(S, "writer", wholeEntriesOf(S), wholeWritesOf(S))
export const w = workload(Writer, { answer, answerAt: clocked(answer, { stage: "micros" }) })
export const apply = (db: DbOf<typeof Writer, typeof w.programs>) =>
	[
		db.workload.answer.once({ params: { child: 1n, stage: 1n, ${postedParams} }, facts: {} }),
		db.workload.answerAt.once({ params: { child: 1n, ${postedParams} }, facts: {} })
	] as const
`

/** Two inserts reading one relation parameter under headings that differ at `value`, applied with a bigint value. */
const differingRows = `export const Word = str.regex("^[a-z]*$")
export const Out = relation("Out", { variable: Word, value: natural }, ["variable"])
export const Other = relation("Other", { variable: Word, count: pg.integer }, ["variable"])
export const S = schema("S", [Out, Other], [])
const countsIn = <L>(r: Rule<L>) => r.relation("x", { variable: Word, value: pg.integer })
export const both = ChangeSet.empty(S)
	.insert(
		Out,
		query(S).rule((r) => {
			const { variable, value } = v(r.relation("x", { variable: Word, value: natural }), "x")
			return r.match(r.relation("x", { variable: Word, value: natural }), { variable, value }).find({ variable, value })
		})
	)
	.insert(
		Other,
		query(S).rule((r) => {
			const { variable, value } = v(countsIn(r), "x")
			return r.match(countsIn(r), { variable, value }).find({ variable, count: value })
		})
	)
export const Writer = role(S, "writer", wholeEntriesOf(S), wholeWritesOf(S))
export const w = workload(Writer, { both })
export const apply = (db: DbOf<typeof Writer, typeof w.programs>) =>
	db.workload.both.once({ params: { x: [{ variable: "a", value: 1n }] }, facts: {} })
`

/** The natural form's program at `shape`, its imports read through the gates' prelude as `entries` reaches it. */
export const naturalSource = (shape: GuardShape, entries: PreludeAt): string =>
	preludeProgram(
		`// Generated by test/types/query/budget/guards.ts at ${jsonText(shape)}.`,
		entries,
		naturalForm(shape)
	)

/** The differing-rows program, its imports read through the gates' prelude as `entries` reaches it. */
export const differingSource = (entries: PreludeAt): string =>
	preludeProgram(
		"// Generated by test/types/query/budget/guards.ts: one relation parameter under two headings.",
		entries,
		differingRows
	)

/** A case of the guards gate: the natural form's inserts over both bases, or the differing rows. */
export type GuardCase = Readonly<{ kind: "inserts" }> | Readonly<{ kind: "differing rows" }>

/** The cells of guardCases, minted as a dictionary in its door (test/types/query/budget/guards.dictionary.ts). */
export const guardCasesItems: readonly [GuardCase, ...ReadonlyArray<GuardCase>] = [
	{ kind: "inserts" },
	{ kind: "differing rows" }
]
