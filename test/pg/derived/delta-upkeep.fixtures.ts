/**
 * What the properties of delta-upkeep.test.ts read: a sitting's four relations, closed or open, drawn definitions over
 * them in the shapes a stored relation's delta program reads, drawn writes, and each case's run against the definitions'
 * re-derivation.
 */

import { aimed, array, element, type Gen, int } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option, type Scope } from "effect"
import { isCanonicalName } from "#compiler/analysis/derived/canonical.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import type { PhysicalNames } from "#compiler/ir/physical.ts"
import { dataStepBracket } from "#compiler/physical/ddl/immutable.ts"
import { natural, bool, int4, int8 } from "#compiler/public/fields.ts"
import type { AnyRelation } from "#compiler/public/schema.ts"
import { type QueryValue, queryOver as query, varsOver as v } from "#compiler/query/build/query.ts"
import type { FinishedValue, RuleValue } from "#compiler/query/build/rule.ts"
import { computeCore } from "#compiler/scalar/compute/builders.ts"
import { derivedBuilder, relationBuilder as relation } from "#compiler/schema/relation.ts"
import { schemaBuilder as schema } from "#compiler/schema/schema.ts"
import { mutableBuilder, unitBuilder } from "#compiler/schema/statements.ts"
import { objectName } from "#compiler/sql/build.ts"
import { installDerived, OracleFixtureFailed, snapshotOf } from "#test/pg/derived/oracle/harness.ts"
import { standUpRelations } from "#test/support/judge.ts"
import { transaction } from "#test/support/oracle/install/transaction.ts"
import type { SqlError } from "#test/support/pg.ts"
import type { TransactionRolledBack } from "#test/support/substrate/errors.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** A sitting's fields, a learner's stage, which leads every key of a sitting's facts. */
const sitting = { child: int4, stage: int4 } as const

/** A sitting's fact at a candidate session k and an instant: the fields every holder has, under its own key. */
const fact = { ...sitting, k: natural, at: int8 } as const

/**
 * The four holders, in the learner's unit, by the name a drawn rule reads each by: a sitting's candidate sessions and
 * the suspensions that ended them, keyed by session; its presentations, keyed by instant; its end, keyed by the sitting
 * alone. Closed, or all four open where the case says (`DeltaCase` `open`).
 */
const holders = {
	Visit: relation("Visit", fact, ["child", "stage", "k"], []),
	Suspension: relation("Suspension", fact, ["child", "stage", "k"], []),
	Presented: relation("Presented", fact, ["child", "stage", "at"], []),
	End: relation("End", fact, ["child", "stage"], [])
} as const satisfies Readonly<Record<string, AnyRelation>>
type Holder = keyof typeof holders
const holderNames = [
	"Visit",
	"Suspension",
	"Presented",
	"End"
] as const satisfies ReadonlyArray<Holder>

/**
 * How a drawn rule joins its two occurrences, each read at the sitting (child, stage), their unit:
 *
 * - `key`: at the candidate session k too, each occurrence's own key or a prefix of it;
 * - `next`: the second's k the first's plus one, a computed key the delta program reaches by its inverse;
 * - `sitting`: at the sitting alone, each fact a pair of their instants, a product;
 * - `later`: at the sitting alone, the second's instant after the first's, a product cut by an order;
 * - `single`: the first occurrence alone, its instant both of the fact's;
 * - `unless`: the first occurrence where the second holds no row at its candidate session, a negation, which a write of
 *   the second withdraws facts of: a checked form keeps it where the first is read at its key from the fact, a
 *   presentation or an end, and the unit form otherwise.
 */
const joins = ["key", "next", "sitting", "later", "single", "unless"] as const
export type Join = (typeof joins)[number]

/** A drawn rule: its two occurrences' holders, how they join, and the literal of the fact's `strict`. */
export interface RuleSketch {
	readonly first: Holder
	readonly second: Holder
	readonly join: Join
	readonly strict: boolean
}

/**
 * A drawn rule of Standing, AssignmentStatus's shape in the box's terms: one occurrence of a holder, every field of it
 * the fact's, read at its key from the fact, beside negations of holders at the occurrence's candidate session or at its
 * sitting, its fact tagged by the rule's literal `tag`, so two rules of one tag derive one fact twice where their rows
 * agree.
 */
export interface StandingSketch {
	readonly holder: Holder
	readonly unless: ReadonlyArray<{ readonly holder: Holder; readonly at: "session" | "sitting" }>
	readonly tag: number
}

/**
 * Whether Later reads Pairs, each pair whose later instant is a visit's: `none`; `named`, Pairs a derived relation of its
 * name a level below; or `imported`, Pairs the query Later imports, which admission stores by its canonical form
 * (analysis/derived/canonical.ts) and Later's upkeep reads by its name, as it reads a named one.
 */
export type Above = "none" | "named" | "imported"

const aboves = ["none", "named", "imported"] as const satisfies ReadonlyArray<Above>

/**
 * A drawn case: the rules of Pairs, a stored relation of pairs of a sitting's instants, as SittingOrder's; whether and
 * how Later reads Pairs (Above); the rules of Standing, a stored relation of a sitting's facts that negations withdraw;
 * whether the holders are open, which a writer updates and deletes; and the transactions, each committed before the
 * next.
 */
export interface DeltaCase {
	readonly rules: Arr.NonEmptyReadonlyArray<RuleSketch>
	readonly above: Above
	readonly standing: Arr.NonEmptyReadonlyArray<StandingSketch>
	readonly open: boolean
	readonly transactions: ReadonlyArray<Transaction>
}

/**
 * A transaction of the case: a writer's, which inserts, and where the holders are open also deletes and updates; or a
 * migration's data step, run in the bracket a custom migration's step runs in (physical/ddl/immutable.ts
 * dataStepBracket: the judge's session tables stood up and each closed table's guard dropped, created again after),
 * which also deletes rows of closed holders, the one writer that can.
 */
export type Transaction =
	| { readonly kind: "writer"; readonly writes: ReadonlyArray<StepWrite> }
	| { readonly kind: "data step"; readonly writes: ReadonlyArray<StepWrite> }

/**
 * A write: an insert of a row; both an insert and a delete of one, in turn, in the one transaction, whose image the
 * transaction's captures hold though no row of it stands at COMMIT; a delete of a row an earlier write of the case
 * inserted, the `pick`-th of those standing, modulo how many stand, so a delete removes a row the stored relations
 * read; or an update of such a row's column outside its key (`moved`) to `to`, an open holder's alone. A writer of
 * closed holders inserts alone.
 */
export type StepWrite =
	| { readonly kind: "insert" | "churn"; readonly row: Row }
	| { readonly kind: "delete"; readonly pick: number }
	| { readonly kind: "update"; readonly pick: number; readonly to: number }

/** One row of a holder at a small coordinate, so drawn rows meet: one learner's two sittings, three sessions, four
 * instants. A delete removes the row of the holder's key the row holds. */
export interface Row {
	readonly into: Holder
	readonly child: number
	readonly stage: number
	readonly k: number
	readonly at: number
}

const ruleGen: Gen<RuleSketch> = (s) => ({
	first: s.draw(element(holderNames)),
	second: s.draw(element(holderNames)),
	join: s.draw(element(joins)),
	strict: s.draw(int(0, 1)) === 1
})

const rowGen: Gen<Row> = (s) => ({
	into: s.draw(element(holderNames)),
	child: 1,
	stage: s.draw(int(1, 2)),
	k: s.draw(int(0, 2)),
	at: s.draw(int(0, 3))
})

const standingGen: Gen<StandingSketch> = (s) => ({
	holder: s.draw(element(holderNames)),
	unless: s.draw(
		array(
			(t) => ({
				holder: t.draw(element(holderNames)),
				at: t.draw(element(["session", "sitting"] as const))
			}),
			{ min: 0, max: 2 }
		)
	),
	tag: s.draw(int(0, 1))
})

/** A write of a data step, or of a writer of open holders: any write. */
const anyWriteGen: Gen<StepWrite> = (t) => {
	const kind = t.draw(element(["insert", "delete", "churn", "update"] as const))
	switch (kind) {
		case "delete":
			return { kind, pick: t.draw(int(0, 7)) }
		case "update":
			return { kind, pick: t.draw(int(0, 7)), to: t.draw(int(0, 3)) }
		case "insert":
		case "churn":
			return { kind, row: t.draw(rowGen) }
	}
}

/** A transaction of a case whose holders are `open` or not: a data step one in four, a writer otherwise. */
const transactionGen =
	(open: boolean): Gen<Transaction> =>
	(s) =>
		s.draw(int(0, 3)) === 0
			? { kind: "data step", writes: s.draw(array(anyWriteGen, { min: 1, max: 4 })) }
			: {
					kind: "writer",
					writes: s.draw(
						array(
							open ? anyWriteGen : (t): StepWrite => ({ kind: "insert", row: t.draw(rowGen) }),
							{ min: 1, max: 4 }
						)
					)
				}

const caseGen: Gen<DeltaCase> = (s) => {
	const [first, ...rest] = s.draw(array(ruleGen, { min: 1, max: 4 }))
	const [standing, ...more] = s.draw(array(standingGen, { min: 1, max: 3 }))
	if (first === undefined || standing === undefined) {
		throw new Error("drawn definitions of at least one rule each")
	}
	const open = s.draw(int(0, 1)) === 1
	return {
		rules: [first, ...rest],
		above: s.draw(element(aboves)),
		standing: [standing, ...more],
		open,
		transactions: s.draw(array(transactionGen(open), { min: 1, max: 8 }))
	}
}

/** A row of `into` at sitting `stage`, session `k` and instant `at`, of the case's one learner. */
const rowAt = (into: Holder, stage: number, k: number, at: number): Row => ({
	into,
	child: 1,
	stage,
	k,
	at
})

/**
 * The aims of the case space: for each situation of a lost fact, a case constructed to reach it, the rest of it drawn,
 * so the stored relations around it are as any case's.
 */
const deltaAims: ReadonlyArray<readonly [DeltaFeature, Gen<DeltaCase>]> = [
	[
		"a Pairs fact its monotone form loses",
		(s) => {
			const c = caseGen(s)
			const stage = s.draw(int(1, 2))
			const first = s.draw(element(["Visit", "Suspension"] as const))
			const second = s.draw(element(["Presented", "End"] as const))
			return {
				...c,
				rules: [
					{
						first,
						second,
						join: s.draw(element(["sitting", "later"] as const)),
						strict: s.draw(int(0, 1)) === 1
					}
				],
				transactions: [
					{
						kind: "writer",
						writes: [
							{ kind: "insert", row: rowAt(first, stage, 0, 0) },
							{ kind: "insert", row: rowAt(second, stage, 1, 1) }
						]
					},
					{ kind: c.open ? "writer" : "data step", writes: [{ kind: "delete", pick: 0 }] }
				]
			}
		}
	],
	[
		"a fact two rules derive lost one derivation",
		(s) => {
			const c = caseGen(s)
			const [one, two] = [s.draw(element(["Visit", "Presented"] as const)), "Suspension" as const]
			const stage = s.draw(int(1, 2))
			const k = s.draw(int(0, 2))
			const at = s.draw(int(0, 3))
			return {
				...c,
				standing: [
					{ holder: one, unless: [], tag: 0 },
					{ holder: two, unless: [], tag: 0 }
				],
				transactions: [
					{
						kind: "writer",
						writes: [
							{ kind: "insert", row: rowAt(one, stage, k, at) },
							{ kind: "insert", row: rowAt(two, stage, k, at) }
						]
					},
					{ kind: c.open ? "writer" : "data step", writes: [{ kind: "delete", pick: 0 }] }
				]
			}
		}
	],
	[
		"a fact withdrawn by a negated row's insert",
		(s) => {
			const c = caseGen(s)
			const stage = s.draw(int(1, 2))
			const k = s.draw(int(0, 2))
			return {
				...c,
				standing: [{ holder: "Visit", unless: [{ holder: "End", at: "sitting" }], tag: 0 }],
				transactions: [
					{
						kind: "writer",
						writes: [{ kind: "insert", row: rowAt("Visit", stage, k, s.draw(int(0, 3))) }]
					},
					{
						kind: "writer",
						writes: [{ kind: "insert", row: rowAt("End", stage, k, s.draw(int(0, 3))) }]
					}
				]
			}
		}
	],
	[
		"a fact gained by a negated row's removal",
		(s) => {
			const c = caseGen(s)
			const stage = s.draw(int(1, 2))
			const k = s.draw(int(0, 2))
			return {
				...c,
				standing: [{ holder: "Visit", unless: [{ holder: "Suspension", at: "session" }], tag: 0 }],
				transactions: [
					{
						kind: "writer",
						writes: [
							{ kind: "insert", row: rowAt("Suspension", stage, k, s.draw(int(0, 3))) },
							{ kind: "insert", row: rowAt("Visit", stage, k, s.draw(int(0, 3))) }
						]
					},
					{ kind: c.open ? "writer" : "data step", writes: [{ kind: "delete", pick: 0 }] }
				]
			}
		}
	],
	[
		"a Pairs fact withdrawn by a negated row's insert",
		(s) => {
			const c = caseGen(s)
			const stage = s.draw(int(1, 2))
			const k = s.draw(int(0, 2))
			const first = s.draw(element(["Visit", "Suspension"] as const))
			const second = first === "Visit" ? ("Suspension" as const) : ("Visit" as const)
			return {
				...c,
				rules: [{ first, second, join: "unless", strict: s.draw(int(0, 1)) === 1 }],
				transactions: [
					{
						kind: "writer",
						writes: [{ kind: "insert", row: rowAt(first, stage, k, s.draw(int(0, 3))) }]
					},
					{
						kind: "writer",
						writes: [{ kind: "insert", row: rowAt(second, stage, k, s.draw(int(0, 3))) }]
					}
				]
			}
		}
	],
	[
		"a writer updated an open holder's row",
		(s) => {
			const c = caseGen(s)
			const row = rowAt(
				s.draw(element(holderNames)),
				s.draw(int(1, 2)),
				s.draw(int(0, 2)),
				s.draw(int(0, 3))
			)
			return {
				...c,
				open: true,
				transactions: [
					{ kind: "writer", writes: [{ kind: "insert", row }] },
					{ kind: "writer", writes: [{ kind: "update", pick: 0, to: s.draw(int(0, 3)) }] },
					...c.transactions
				]
			}
		}
	]
]

export const deltaCaseGen = aimed(caseGen, deltaAims)

/** What a case reached: each join of a stored definition's rule, a level above, two sittings in one transaction, a
 * data step's delete of a stored relation's holder's row, an open holder's update and delete by a writer, each way a
 * negation moves a fact, and the form each stored relation is kept by. */
export type DeltaFeature =
	| `rule ${Join} stored`
	| "a stored relation read above"
	| "a stored relation imported unnamed read above"
	| "two sittings in one transaction"
	| "a data step deleted a holder's row"
	| "a data step inserted a row and deleted it again"
	| "a writer deleted an open holder's row"
	| "a writer updated an open holder's row"
	| "a fact two rules derive lost one derivation"
	| "a fact withdrawn by a negated row's insert"
	| "a fact gained by a negated row's removal"
	| "a Pairs fact withdrawn by a negated row's insert"
	| "a Pairs fact its monotone form loses"
	| `${"Pairs" | "Later" | "Standing"} kept by its ${"checked" | "monotone"} form`

/**
 * Pairs over the sittings, one rule per sketch, each fact (child, stage, earlier, later, strict), SittingOrder's heading;
 * Standing beside it, one rule per sketch, each fact (child, stage, k, at, tag), a holder's row and its rule's tag; and,
 * where the case says, Later, a level above, each pair of Pairs whose later instant begins a visit of its sitting,
 * which reads Pairs' table. The holders are open where the case says (`DeltaCase` `open`).
 */
const schemaOf = (c: DeltaCase, name: string) => {
	const base = schema(
		name,
		Arr.map(holderNames, (h) => holders[h]),
		[
			unitBuilder("Learner", { child: int4 }, []),
			...(c.open ? Arr.map(holderNames, (h) => mutableBuilder(holders[h])) : [])
		],
		[]
	)
	const ruleOf =
		(sketch: RuleSketch) =>
		(r: RuleValue): FinishedValue => {
			const first = holders[sketch.first]
			const second = holders[sketch.second]
			const one = v(first, "one")
			const two = v(second, "two")
			const child = one["child"]
			const stage = one["stage"]
			const strict = computeCore.literal(bool, sketch.strict)
			const pair = (later: unknown) => ({ child, stage, earlier: one["at"], later, strict })
			switch (sketch.join) {
				case "single":
					return r.match(first, { child, stage, at: one["at"] }).find(pair(one["at"]))
				case "unless":
					return r
						.match(first, { child, stage, k: one["k"], at: one["at"] })
						.where(r.not(second, { child, stage, k: one["k"] }))
						.find(pair(one["at"]))
				case "key":
					return r
						.match(first, { child, stage, k: one["k"], at: one["at"] })
						.match(second, { child, stage, k: one["k"], at: two["at"] })
						.find(pair(two["at"]))
				case "next":
					return r
						.match(first, { child, stage, k: one["k"], at: one["at"] })
						.match(second, { child, stage, k: two["k"], at: two["at"] })
						.where(
							r.eq(computeCore.base(two["k"]), computeCore.add(computeCore.base(one["k"]), 1n))
						)
						.find(pair(two["at"]))
				case "sitting":
					return r
						.match(first, { child, stage, at: one["at"] })
						.match(second, { child, stage, at: two["at"] })
						.find(pair(two["at"]))
				case "later":
					return r
						.match(first, { child, stage, at: one["at"] })
						.match(second, { child, stage, at: two["at"] })
						.where(r.lt(one["at"], two["at"]))
						.find(pair(two["at"]))
			}
		}
	const [first, ...rest] = c.rules
	const pairs = Arr.reduce(rest, query(base).rule(ruleOf(first)), (q: QueryValue, sketch) =>
		q.rule(ruleOf(sketch))
	)
	const Pairs = derivedBuilder("Pairs", pairs, [])
	/** What Later reads Pairs as: the named relation, or the query it imports. */
	const read = c.above === "imported" ? pairs : Pairs
	const standingOf =
		(sketch: StandingSketch) =>
		(r: RuleValue): FinishedValue => {
			const held = holders[sketch.holder]
			const one = v(held, "one")
			const [child, stage, k, at] = [one["child"], one["stage"], one["k"], one["at"]]
			return Arr.reduce(sketch.unless, r.match(held, { child, stage, k, at }), (q: RuleValue, n) =>
				q.where(
					r.not(holders[n.holder], n.at === "session" ? { child, stage, k } : { child, stage })
				)
			).find({ child, stage, k, at, tag: computeCore.literal(int4, sketch.tag) })
		}
	const [standing, ...more] = c.standing
	const Standing = derivedBuilder(
		"Standing",
		Arr.reduce(more, query(base).rule(standingOf(standing)), (q: QueryValue, sketch) =>
			q.rule(standingOf(sketch))
		),
		[]
	)
	const level1 = schema.extend(
		[base],
		`${name}_1`,
		c.above === "imported" ? [Standing] : [Pairs, Standing],
		[],
		[]
	)
	if (c.above === "none") {
		return { top: level1, names: ["Pairs", "Standing"] }
	}
	const Later = derivedBuilder(
		"Later",
		query(level1).rule((r: RuleValue) => {
			const pair = v(read, "pair")
			const visit = v(holders.Visit, "visit")
			const [child, stage, earlier, later, strict] = [
				pair["child"],
				pair["stage"],
				pair["earlier"],
				pair["later"],
				pair["strict"]
			]
			return r
				.match(read, { child, stage, earlier, later, strict })
				.match(holders.Visit, { child, stage, k: visit["k"], at: later })
				.find({ child, stage, earlier, k: visit["k"], later })
		}),
		[]
	)
	return {
		top: schema.extend([level1], `${name}_2`, [Later], [], []),
		names: c.above === "imported" ? ["Standing", "Later"] : ["Pairs", "Standing", "Later"]
	}
}

/** The fields of each holder's key past the sitting, which a delete of the row a drawn row holds is at. */
const keyPast = {
	Visit: ["k"],
	Suspension: ["k"],
	Presented: ["at"],
	End: []
} as const satisfies { readonly [H in Holder]: ReadonlyArray<"k" | "at"> }

/** The column outside its key an update of a holder's row moves: a session's instant, a presentation's session. */
const moved = {
	Visit: "at",
	Suspension: "at",
	Presented: "k",
	End: "at"
} as const satisfies { readonly [H in Holder]: "k" | "at" }

/** One write as the owner's direct SQL, a writer outside grizzle's programs, which the captures see as any: an insert
 * of the row, a delete of the row its holder's key holds there, or an update of that row's moved column to `to`. */
const sqlOf = (
	names: PhysicalNames,
	write:
		| { readonly kind: "insert" | "delete"; readonly row: Row }
		| { readonly kind: "update"; readonly row: Row; readonly to: number }
): string => {
	const w = write.row
	const table = names.relation(w.into)
	const qualified = `${quoteIdent(table.schema)}.${quoteIdent(table.name)}`
	const column = (field: string) => quoteIdent(names.column(w.into, field))
	const atKey = Arr.join(
		Arr.map(["child", "stage", ...keyPast[w.into]] as const, (f) => `${column(f)} = ${w[f]}`),
		" AND "
	)
	switch (write.kind) {
		case "insert":
			return `INSERT INTO ${qualified} (${column("child")}, ${column("stage")}, ${column("k")}, ${column("at")}) VALUES (${w.child}, ${w.stage}, ${w.k}, ${w.at}) ON CONFLICT DO NOTHING`
		case "delete":
			return `DELETE FROM ${qualified} WHERE ${atKey}`
		case "update":
			return `UPDATE ${qualified} SET ${column(moved[w.into])} = ${write.to} WHERE ${atKey}`
	}
}

/**
 * The case on a fresh installation: each transaction committed in turn by the owner's direct SQL, and after each
 * COMMIT, in one read-only snapshot, every derived relation's rows equal to its definition's there, the definition
 * evaluated by the conservative lowering, which relies on no evidence (oracle/harness.ts snapshotOf).
 */
export const deltaRun = (
	c: DeltaCase,
	reached: Case<DeltaFeature>
): Effect.Effect<
	void,
	OracleFixtureFailed | CompileError | SqlError | TransactionRolledBack,
	Substrate | Scope.Scope
> =>
	Effect.gen(function* () {
		const s = yield* Substrate
		const built = schemaOf(c, "delta_upkeep")
		const opened = yield* installDerived(built.top, {}, "delta")
		/** The holders an upkeep reads, whose captures the judge stands up before a write: no other holder has any. */
		const read = new Set(
			Arr.flatMap(opened.installed.installation.laws.theory.upkeeps, (u) =>
				Arr.map(u.reads, (r) => r.relation)
			)
		)
		yield* standUpRelations(
			s.admin,
			opened.installed.installation,
			Arr.filter(holderNames, (h) => read.has(h))
		)
		const stored = (name: string) =>
			opened.analysis.schema.canonicalNamed(name)?.holding.kind === "stored"
		const upkeeps = opened.installed.installation.laws.theory.upkeeps
		/** The name Pairs' rows are read by: its own, or, imported, its canonical relation's, the one canonical relation of
		 * the case no derived relation names. */
		const pairs =
			c.above === "imported"
				? Option.getOrElse(
						Option.map(
							Arr.findFirst(upkeeps, (u) => isCanonicalName(u.relation)),
							(u) => u.relation
						),
						() => "Pairs"
					)
				: "Pairs"
		for (const u of upkeeps) {
			const relation = u.relation === pairs ? "Pairs" : u.relation
			if (
				u.form.kind === "delta" &&
				(relation === "Pairs" || relation === "Later" || relation === "Standing")
			) {
				reached.note(
					`${relation} kept by its ${u.form.lost.kind === "checked" ? "checked" : "monotone"} form`
				)
			}
		}
		if (stored(pairs)) {
			for (const sketch of c.rules) {
				reached.note(`rule ${sketch.join} stored`)
			}
			if (c.above === "named" && stored("Later")) {
				reached.note("a stored relation read above")
			}
			if (
				c.above === "imported" &&
				Arr.some(
					upkeeps,
					(u) => u.relation === "Later" && Arr.some(u.reads, (r) => r.relation === pairs)
				)
			) {
				reached.note("a stored relation imported unnamed read above")
			}
		}
		/** The stored ones of the case's derived relations, each held against its definition, Pairs imported among them by
		 * its canonical relation's name: a live one is its definition, read through its view. */
		const kept = Arr.filter(c.above === "imported" ? [pairs, ...built.names] : built.names, stored)
		const installation = opened.installed.installation
		/** A data step's bracket (dataStepBracket): the judge's stand-ups of the holders it holds, and, the holders
		 * closed, every guard of the installation's schema dropped before the step's statements and created again after,
		 * the installation's re-check run before (physical/ddl/recheck.ts), which makes each stored relation over a closed
		 * holder its definition's rows again. */
		const bracket = dataStepBracket(
			c.open ? [] : [installation.names.schema],
			Arr.map(
				Arr.filter(holderNames, (h) => read.has(h)),
				(h) => objectName(installation.names.schema, identifierOf(identity.ruleStandUp(h)))
			),
			installation.recheck === undefined
				? []
				: [objectName(installation.names.schema, identifierOf(identity.dataStepRecheck()))]
		)
		/** The rows the case's writes leave standing, in the order they were inserted, which a delete or an update picks
		 * from. */
		const standing: Array<Row> = []
		const key = (w: Row): string =>
			`${w.into}:${w.stage}:${Arr.join(
				Arr.map(keyPast[w.into], (f) => String(w[f])),
				":"
			)}`
		/**
		 * The situations a write of `row` that adds it (`gains`) or removes it reaches against the rows standing before it:
		 * a removal of one of two derivations of a fact of Standing, its rules' tags alike, their holders' rows agreeing; a
		 * fact of Standing a negation withdraws or gives back, a row of a rule's holder standing at the negation's key. A
		 * negation of the fact's other derivations is not read: the situation is the write's, which the upkeep reads.
		 */
		const standingNotes = (row: Row, gains: boolean): void => {
			if (
				gains &&
				stored("Pairs") &&
				Arr.some(
					c.rules,
					(rule) =>
						rule.join === "unless" &&
						rule.second === row.into &&
						Arr.some(
							standing,
							(r) => r.into === rule.first && r.stage === row.stage && r.k === row.k
						)
				)
			) {
				reached.note("a Pairs fact withdrawn by a negated row's insert")
			}
			for (const rule of c.standing) {
				for (const n of rule.unless) {
					const meets = Arr.some(
						standing,
						(r) =>
							r.into === rule.holder &&
							r.stage === row.stage &&
							(n.at === "sitting" || r.k === row.k) &&
							n.holder === row.into
					)
					if (meets) {
						reached.note(
							gains
								? "a fact withdrawn by a negated row's insert"
								: "a fact gained by a negated row's removal"
						)
					}
				}
				if (!gains && rule.holder === row.into) {
					const twice = Arr.some(
						c.standing,
						(other) =>
							other !== rule &&
							other.tag === rule.tag &&
							Arr.some(
								standing,
								(r) =>
									r !== row &&
									r.into === other.holder &&
									r.stage === row.stage &&
									r.k === row.k &&
									r.at === row.at
							)
					)
					if (twice) {
						reached.note("a fact two rules derive lost one derivation")
					}
				}
			}
		}
		/** A write's statements, each row it inserts, deletes or updates kept in `standing` as the write leaves it. */
		const statementsOf = (w: Row, kind: "insert" | "delete"): ReadonlyArray<string> => {
			const at = Arr.findFirstIndex(standing, (r) => key(r) === key(w))
			if (kind === "insert" && Option.isNone(at)) {
				standingNotes(w, true)
				standing.push(w)
			}
			if (kind === "delete" && Option.isSome(at)) {
				standingNotes(w, false)
				standing.splice(at.value, 1)
			}
			return [sqlOf(opened.installed.names, { kind, row: w })]
		}
		/** The statements of a delete or an update of the `pick`-th standing row, none where no row stands. */
		const pickedOf = (
			w: Extract<StepWrite, { readonly kind: "delete" | "update" }>,
			by: Transaction["kind"]
		): ReadonlyArray<string> => {
			const picked = standing[w.pick % Math.max(standing.length, 1)]
			if (picked === undefined) {
				return []
			}
			if (by === "writer") {
				reached.note(`a writer ${w.kind === "delete" ? "deleted" : "updated"} an open holder's row`)
			} else if (w.kind === "delete") {
				reached.note("a data step deleted a holder's row")
			}
			if (w.kind === "delete") {
				return statementsOf(picked, "delete")
			}
			const to: Row = { ...picked, [moved[picked.into]]: w.to }
			standingNotes(picked, false)
			standing.splice(standing.indexOf(picked), 1)
			standingNotes(to, true)
			standing.push(to)
			return [sqlOf(opened.installed.names, { kind: "update", row: picked, to: w.to })]
		}
		/** Whether Pairs is kept by its monotone form, whose loss re-derives the units its holders' removed rows touch. */
		const monotone = Arr.some(
			upkeeps,
			(u) => u.relation === pairs && u.form.kind === "delta" && u.form.lost.kind === "unit"
		)
		/** Pairs' rows as its definition gave them after the transaction before. */
		let pairsBefore: ReadonlyArray<string> = []
		for (const [step, t] of c.transactions.entries()) {
			const rows = Arr.flatMap(t.writes, (w) =>
				w.kind === "insert" || w.kind === "churn" ? [w.row] : []
			)
			if (new Set(Arr.map(rows, (w) => `${w.child}:${w.stage}`)).size > 1) {
				reached.note("two sittings in one transaction")
			}
			const writes = Arr.flatMap(t.writes, (w): ReadonlyArray<string> => {
				switch (w.kind) {
					case "insert":
						return statementsOf(w.row, "insert")
					case "churn":
						return [...statementsOf(w.row, "insert"), ...statementsOf(w.row, "delete")]
					case "delete":
					case "update":
						return pickedOf(w, t.kind)
				}
			})
			const statements =
				t.kind === "writer" ? writes : [...bracket.before, ...writes, ...bracket.after]
			if (t.kind === "data step" && Arr.some(t.writes, (w) => w.kind === "churn")) {
				reached.note("a data step inserted a row and deleted it again")
			}
			yield* transaction(s.admin, statements)
			const snapshot = yield* snapshotOf(opened, kept, kept)
			const pairsNow = snapshot.defined.get(pairs) ?? []
			if (monotone && Arr.some(pairsBefore, (row) => !Arr.some(pairsNow, (now) => now === row))) {
				reached.note("a Pairs fact its monotone form loses")
			}
			pairsBefore = pairsNow
			for (const name of kept) {
				const held = Arr.map(snapshot.stored.get(name) ?? [], (r) => r.value)
				const defined = snapshot.defined.get(name) ?? []
				if (Arr.join(held, "\n") !== Arr.join(defined, "\n")) {
					return yield* new OracleFixtureFailed({
						message: `after transaction ${step}, ${name} holds [${Arr.join(held, "; ")}] where its definition gives [${Arr.join(defined, "; ")}]`
					})
				}
			}
		}
	})
