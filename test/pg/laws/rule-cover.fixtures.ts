/** What the property of rule-cover.test.ts reads: the schema and its template, the space, and each case's run. */

import { assert, defined } from "@bjornpagen/testing/assert"
import { aimed, array, boolean, element, type Gen, weighted } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Data, Effect, Formatter, Option, String as Str } from "effect"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import type { LawId } from "#compiler/core/ids.ts"
import { baselineRuleChecks } from "#compiler/deploy/snapshot/violation.ts"
import { lawsOfConstraint } from "#compiler/ir/products.ts"
import { countColumn } from "#compiler/physical/ddl/deltas.ts"
import { compileInstallation, type Installation } from "#compiler/physical/install/compile.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import {
	check,
	contained,
	derived,
	mutable,
	on,
	relation,
	schema,
	unit
} from "#compiler/public/schema.ts"
import type { PlStatement } from "#compiler/sql/ast.ts"
import { printStatement } from "#compiler/sql/print.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { type Installed, migratedTemplate, noPlaceholders } from "#test/support/install-migrate.ts"
import { judgedDeltaReadsOf, raisedRule } from "#test/support/judge.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"
import type { PgConnection } from "#test/support/pg.ts"
import { refusalOf } from "#test/support/substrate.ts"
import type { RawSession } from "#test/support/substrate/session.ts"

/**
 * A learner's rows beside what they may be judged against, keyed by one integer each, every relation mutable: R and X
 * in a unit of their own, keyed by c, every other relation in the unit of k or of a group, so every rule over them
 * reads the rows of two units, two borrows, and is probed (analysis/theory/query.ts probe), never judged whole over
 * units:
 *
 * - R, the covered relation, keyed by c, beside a cap; S, keyed by k, in a group with a score; S(k) ⊆ R(c), as the
 *   ledger's HumanOperatorValue is contained in Attempt at its attempt's key;
 * - T(k) ⊆ S(k), so T(k) ⊆ R(c) by composition alone (analysis/theory/unit.ts regionFactsOf);
 * - U(k) ⊆ V(k) and V(k) ⊆ U(k), a cycle;
 * - Lim, a group's maximum; X, a value at c; A and B, keys a definition reads; W, a key's dependence on another key x.
 *
 * Each containment's target holds a field it does not reference, so each is a foreign key checked at COMMIT, which a
 * transaction may break and repair before it ends.
 */
const R = relation("R", { c: pg.integer, cap: pg.integer }, ["c"])
const S = relation("S", { k: pg.integer, grp: pg.integer, score: pg.integer }, ["k"])
const T = relation("T", { k: pg.integer, tag: pg.integer }, ["k"])
const U = relation("U", { k: pg.integer, score: pg.integer }, ["k"])
const V = relation("V", { k: pg.integer, flag: pg.integer }, ["k"])
const Lim = relation("Lim", { grp: pg.integer, max: pg.integer }, ["grp"])
const X = relation("X", { c: pg.integer, v: pg.integer }, ["c"])
const A = relation("A", { k: pg.integer }, ["k"])
const B = relation("B", { k: pg.integer }, ["k"])
const W = relation("W", { k: pg.integer, x: pg.integer }, ["k", "x"])

const stored = [R, S, T, U, V, Lim, X, A, B, W] as const

const Base = schema("Cover", stored, [
	...Arr.map(stored, (t) => mutable(t)),
	contained(on(S, "k"), on(R, "c")),
	contained(on(T, "k"), on(S, "k")),
	contained(on(U, "k"), on(V, "k")),
	contained(on(V, "k"), on(U, "k")),
	unit("Keyed", { k: pg.integer }),
	unit("Group", { grp: pg.integer }),
	unit("Covered", { c: pg.integer })
])

/** S's score beside its group's maximum, at each k R holds: R read at its key alone, which S's row pins. */
const Direct = derived(
	"Direct",
	query(Base).rule((r) => {
		const { k, grp, score } = v(S, "s")
		const { max } = v(Lim, "lim")
		return r
			.match(S, { k, grp, score })
			.match(R, { c: k })
			.match(Lim, { grp, max })
			.find({ k, score, max })
	})
)

/** S's score beside R's cap at its k: R's cap is a field no containment pins. */
const Capped = derived(
	"Capped",
	query(Base).rule((r) => {
		const { k, score } = v(S, "s")
		const { cap } = v(R, "r")
		return r.match(S, { k, score }).match(R, { c: k, cap }).find({ k, score, cap })
	})
)

/** X's value at each k T and R hold: R pinned by T through T ⊆ S ⊆ R alone. */
const Chained = derived(
	"Chained",
	query(Base).rule((r) => {
		const { k } = v(T, "t")
		const { v: value } = v(X, "x")
		return r.match(T, { k }).match(R, { c: k }).match(X, { c: k, v: value }).find({ k, value })
	})
)

/** X's value at each k U and V hold: U and V each contained in the other, each read at its key alone. */
const Cycled = derived(
	"Cycled",
	query(Base).rule((r) => {
		const { k } = v(U, "u")
		const { v: value } = v(X, "x")
		return r.match(U, { k }).match(V, { k }).match(X, { c: k, v: value }).find({ k, value })
	})
)

/** The keys R holds beside A's or B's: a definition of two rules, each reading R at its key. */
const Either = derived(
	"Either",
	query(Base)
		.rule((r) => {
			const { c: k } = v(R, "r")
			return r.match(R, { c: k }).match(A, { k }).find({ k })
		})
		.rule((r) => {
			const { c: k } = v(R, "r")
			return r.match(R, { c: k }).match(B, { k }).find({ k })
		})
)

/** The keys W makes depend on a key x R does not hold. */
const Blocked = derived(
	"Blocked",
	query(Base).rule((r) => {
		const { k, x } = v(W, "w")
		return r
			.match(W, { k, x })
			.where(r.not(R, { c: x }))
			.find({ k })
	})
)

/** The bound every check holds its facts to. */
const bound = 5

/** The first level: the checks over the base's joins, and the definitions the levels above read. */
const Cover1 = schema.extend(
	[Base],
	"Cover_1",
	[Direct, Capped, Chained, Cycled, Either, Blocked],
	[
		check("Direct_within", Direct, (d) => d.le(d.score, d.max)),
		check("Capped_within", Capped, (d) => d.le(d.score, d.cap)),
		check("Chained_within", Chained, (d) => d.le(d.value, bound)),
		check("Cycled_within", Cycled, (d) => d.le(d.value, bound))
	]
)

/** A's and B's keys no dependence blocks: a definition of two rules, R read in each under two negations, at x. */
const Unblocked = derived(
	"Unblocked",
	query(Cover1)
		.rule((r) => {
			const { k } = v(A, "a")
			return r.match(A, { k }).where(r.not(Blocked, { k })).find({ k })
		})
		.rule((r) => {
			const { k } = v(B, "b")
			return r.match(B, { k }).where(r.not(Blocked, { k })).find({ k })
		})
)

/** S's score at each k of Either. */
const Defined = derived(
	"Defined",
	query(Cover1).rule((r) => {
		const { k, score } = v(S, "s")
		return r.match(S, { k, score }).match(Either, { k }).find({ k, score })
	})
)

/** The second level: Defined's check, and Unblocked, which the level above reads. */
const Cover2 = schema.extend(
	[Cover1],
	"Cover_2",
	[Defined, Unblocked],
	[check("Defined_within", Defined, (d) => d.le(d.score, bound))]
)

/** S's score at each k of Unblocked. */
const Negated = derived(
	"Negated",
	query(Cover2).rule((r) => {
		const { k, score } = v(S, "s")
		return r.match(S, { k, score }).match(Unblocked, { k }).find({ k, score })
	})
)

/** Each rule, its check over a derived relation (a rule over a query the judge holds by its probes). */
const Cover = schema.extend(
	[Cover2],
	"Cover_3",
	[Negated],
	[check("Negated_within", Negated, (d) => d.le(d.score, bound))]
)

/** Cover installed through its first migration, with no login: the template every case clones. */
export const coverTemplate = migratedTemplate({
	declaredIn: import.meta,
	name: "cover",
	content: { schema: "Cover", logins: [] },
	versions: [{ schema: Cover, logins: [], declarations: noDeclarations }],
	options: {
		label: "cover",
		extensions: [],
		compile: compileInstallation,
		ambient: ordinarySession,
		review: noPlaceholders
	}
})

/** The relations a write names, by name. */
const relations = { R, S, T, U, V, X, A, B, W } as const
type Written = keyof typeof relations

/** The two keys, values below and above the bound, and two caps on either side of a score above it. */
const keys = [1, 2] as const
type Key = (typeof keys)[number]
const scores = [3, 9] as const
const caps = [5, 10] as const

/** One write of a transaction, as drawn. */
export type Op =
	| { readonly kind: "put"; readonly relation: Written; readonly k: Key; readonly value: number }
	| {
			readonly kind: "set"
			readonly relation: "R" | "S" | "U" | "X"
			readonly k: Key
			readonly value: number
	  }
	| { readonly kind: "remove"; readonly relation: Written; readonly k: Key }
	| { readonly kind: "depend"; readonly k: Key; readonly x: Key }
	| { readonly kind: "undepend"; readonly k: Key; readonly x: Key }

/** A case: its transactions, each its writes in order, each judged against every law's whole check. */
export interface Schedule {
	readonly transactions: ReadonlyArray<ReadonlyArray<Op>>
}

const keyGen = element(keys)
const writtenGen = element(["R", "S", "T", "U", "V", "X", "A", "B"] as const)

/** A value a put or a set of `relation` writes: R's cap, a score or X's value, or a tag or flag of no rule. */
const valueOf = (relation: Written, s: Parameters<Gen<Op>>[0]): number =>
	relation === "R" ? s.draw(element(caps)) : s.draw(element(scores))

const opGen: Gen<Op> = weighted<Op>([
	[
		6,
		(s) => {
			const relation = s.draw(writtenGen)
			return { kind: "put", relation, k: s.draw(keyGen), value: valueOf(relation, s) }
		}
	],
	[
		3,
		(s) => {
			const relation = s.draw(element(["R", "S", "U", "X"] as const))
			return { kind: "set", relation, k: s.draw(keyGen), value: valueOf(relation, s) }
		}
	],
	[3, (s) => ({ kind: "remove", relation: s.draw(writtenGen), k: s.draw(keyGen) })],
	[1, (s) => ({ kind: "depend", k: s.draw(keyGen), x: s.draw(keyGen) })],
	[1, (s) => ({ kind: "undepend", k: s.draw(keyGen), x: s.draw(keyGen) })]
])

const scheduleGen: Gen<Schedule> = (s) => ({
	transactions: s.draw(array(array(opGen, { min: 1, max: 5 }), { min: 1, max: 4 }))
})

/** The situations a search must reach. */
export type CoverFeature =
	| "committed"
	| "refused by a rule"
	| "refused by a containment"
	| "S's and R's rows added in one transaction"
	| "a containment broken in its own transaction"
	| "R's row replaced at its key under another cap"
	| "a row of R unblocking a negated definition"
	| "a cycle's two rows added in one transaction"
	| "a chain's first row added beside R's"

export const coverFeatures: Arr.NonEmptyReadonlyArray<CoverFeature> = [
	"committed",
	"refused by a rule",
	"refused by a containment",
	"S's and R's rows added in one transaction",
	"a containment broken in its own transaction",
	"R's row replaced at its key under another cap",
	"a row of R unblocking a negated definition",
	"a cycle's two rows added in one transaction",
	"a chain's first row added beside R's"
]

const put = (relation: Written, k: Key, value: number): Op => ({ kind: "put", relation, k, value })

/** For each situation, a case constructed to reach it, its values drawn, so it commits or is refused as they make it. */
const coverAims: ReadonlyArray<readonly [CoverFeature, Gen<Schedule>]> = [
	[
		"S's and R's rows added in one transaction",
		(s) => {
			const k = s.draw(keyGen)
			return {
				transactions: [
					[
						put("R", k, s.draw(element(caps))),
						put("S", k, s.draw(element(scores))),
						...(s.draw(boolean) ? [put("A", k, 0)] : [])
					]
				]
			}
		}
	],
	[
		"a containment broken in its own transaction",
		(s) => {
			const k = s.draw(keyGen)
			return {
				transactions: [
					s.draw(boolean)
						? [put("S", k, s.draw(element(scores)))]
						: [
								put("R", k, 10),
								put("S", k, 3),
								put("T", k, 0),
								{ kind: "remove", relation: "S", k }
							]
				]
			}
		}
	],
	[
		"R's row replaced at its key under another cap",
		(s) => {
			const k = s.draw(keyGen)
			const score = s.draw(element(scores))
			return {
				transactions: [
					[put("R", k, 10), put("S", k, score)],
					s.draw(boolean)
						? [{ kind: "set", relation: "R", k, value: s.draw(element(caps)) }]
						: [{ kind: "remove", relation: "R", k }, put("R", k, s.draw(element(caps)))]
				]
			}
		}
	],
	[
		"a row of R unblocking a negated definition",
		(s) => {
			const k = s.draw(keyGen)
			const x: Key = k === 1 ? 2 : 1
			return {
				transactions: [
					[
						put("R", k, 10),
						put("S", k, s.draw(element(scores))),
						put(s.draw(element(["A", "B"] as const)), k, 0),
						{ kind: "depend", k, x }
					],
					[put("R", x, 10)]
				]
			}
		}
	],
	[
		"a cycle's two rows added in one transaction",
		(s) => {
			const k = s.draw(keyGen)
			return {
				transactions: [[put("X", k, s.draw(element(scores)))], [put("U", k, 0), put("V", k, 0)]]
			}
		}
	],
	[
		"a chain's first row added beside R's",
		(s) => {
			const k = s.draw(keyGen)
			return {
				transactions: [
					[put("R", k, 10), put("S", k, 3), put("X", k, s.draw(element(scores)))],
					[put("T", k, 0)]
				]
			}
		}
	]
]

export const coverSpace = aimed(scheduleGen, coverAims)

/** The column a written relation's key is in: R's and X's c, every other's k. */
const keyColumn = (relation: Written): "c" | "k" =>
	relation === "R" || relation === "X" ? "c" : "k"

/** The statement of one write, on the installation's names. */
const statementOf = (installed: Installed, op: Op): string => {
	const names = namesOf(installed)
	switch (op.kind) {
		case "put": {
			const t = names.table(relations[op.relation])
			switch (op.relation) {
				case "R":
					return `INSERT INTO ${t} (c, cap) VALUES (${op.k}, ${op.value}) ON CONFLICT DO NOTHING`
				case "S":
					return `INSERT INTO ${t} (k, grp, score) VALUES (${op.k}, 1, ${op.value}) ON CONFLICT DO NOTHING`
				case "T":
					return `INSERT INTO ${t} (k, tag) VALUES (${op.k}, 0) ON CONFLICT DO NOTHING`
				case "U":
					return `INSERT INTO ${t} (k, score) VALUES (${op.k}, ${op.value}) ON CONFLICT DO NOTHING`
				case "V":
					return `INSERT INTO ${t} (k, flag) VALUES (${op.k}, 0) ON CONFLICT DO NOTHING`
				case "X":
					return `INSERT INTO ${t} (c, v) VALUES (${op.k}, ${op.value}) ON CONFLICT DO NOTHING`
				case "A":
				case "B":
					return `INSERT INTO ${t} (k) VALUES (${op.k}) ON CONFLICT DO NOTHING`
				case "W":
					return `INSERT INTO ${t} (k, x) VALUES (${op.k}, ${op.k}) ON CONFLICT DO NOTHING`
			}
		}
		case "set": {
			const column = { R: "cap", S: "score", U: "score", X: "v" }[op.relation]
			return `UPDATE ${names.table(relations[op.relation])} SET ${column} = ${op.value} WHERE ${keyColumn(op.relation)} = ${op.k}`
		}
		case "remove":
			return `DELETE FROM ${names.table(relations[op.relation])} WHERE ${keyColumn(op.relation)} = ${op.k}`
		case "depend":
			return `INSERT INTO ${names.table(W)} (k, x) VALUES (${op.k}, ${op.x}) ON CONFLICT DO NOTHING`
		case "undepend":
			return `DELETE FROM ${names.table(W)} WHERE k = ${op.k} AND x = ${op.x}`
	}
}

/** Each containment the schema states, as its source's name and target's: a foreign key checked at COMMIT. */
const containments = [
	["S", "R"],
	["T", "S"],
	["U", "V"],
	["V", "U"]
] as const satisfies ReadonlyArray<readonly [Written, Written]>

class Disagreed extends Data.TaggedError("Disagreed")<{ readonly message: string }> {}

/** Every law a refusal's constraint serves, through the installation's constraint map. */
const refusedLaws = (
	installation: Installation,
	fields: { readonly table: Option.Option<string>; readonly constraint: string | undefined }
): ReadonlyArray<LawId> => {
	if (Option.isNone(fields.table) || fields.constraint === undefined) {
		return []
	}
	const table = fields.table.value
	const owner = Arr.findFirst(stored, (r) => installation.names.relation(r.name).name === table)
	return Option.isNone(owner)
		? []
		: (lawsOfConstraint(
				installation.constraintToLaw,
				{ kind: "table", name: installation.names.relation(owner.value.name).name },
				fields.constraint
			) ?? [])
}

/**
 * Judges the state `session`'s transaction leaves against every law: each rule's whole check (its violation query over
 * every fact, lowered by the oracle baseline, deploy/snapshot/violation.ts baselineRuleChecks), which reads no probe,
 * and each containment's rows of its source no row of its target holds at its key. Then runs the judge and the
 * deferred foreign keys (SET CONSTRAINTS ALL IMMEDIATE): they must refuse exactly when a law is broken, naming one that
 * is. Answers which kind of law refused, none where they accepted.
 */
const judged = (installed: Installed, session: RawSession, where: string) =>
	Effect.gen(function* () {
		const installation = installed.installation
		const names = namesOf(installed)
		const broken = new Set<LawId>()
		for (const c of baselineRuleChecks(installation)) {
			const found = yield* session.values(`SELECT EXISTS (${printStatement(c.query)})`, [])
			if (found[0]?.[0] === true) {
				broken.add(c.law)
			}
		}
		const brokenContainments: Array<string> = []
		for (const [from, to] of containments) {
			const found = yield* session.values(
				`SELECT EXISTS (SELECT FROM ${names.table(relations[from])} AS f WHERE NOT EXISTS (SELECT FROM ${names.table(relations[to])} AS t WHERE t.${keyColumn(to)} = f.${keyColumn(from)}))`,
				[]
			)
			if (found[0]?.[0] === true) {
				brokenContainments.push(`${from} in ${to}`)
			}
		}
		const refused = yield* refusalOf(session.query("SET CONSTRAINTS ALL IMMEDIATE", []))
		if (Option.isNone(refused)) {
			if (broken.size > 0 || brokenContainments.length > 0) {
				return yield* new Disagreed({
					message: `the judge accepted a state that breaks ${Formatter.format([...broken, ...brokenContainments])}, ${where}`
				})
			}
			return Option.none<"rule" | "containment">()
		}
		const laws = refusedLaws(installation, refused.value)
		if (refused.value.code === "23514" && Arr.some(laws, (law) => broken.has(law))) {
			return Option.some("rule" as const)
		}
		if (refused.value.code === "23503" && brokenContainments.length > 0) {
			return Option.some("containment" as const)
		}
		return yield* new Disagreed({
			message: `refused under ${refused.value.code} ${refused.value.constraint ?? "naming no constraint"} where the laws broken are ${Formatter.format([...broken, ...brokenContainments])}, ${where}`
		})
	})

/** The PL/pgSQL body of the installation's function named `name`. */
const bodyOf = (installation: Installation, name: string): ReadonlyArray<PlStatement> =>
	Arr.flatMap(installation.statements, (s) =>
		s.kind === "createFunction" && s.language === "plpgsql" && s.name.name === name
			? s.body.body
			: []
	)

/** The session tables a capture's body creates, at any depth, by name and columns: its deltas. */
const deltasIn = (
	body: ReadonlyArray<PlStatement>
): ReadonlyArray<{ readonly name: string; readonly columns: ReadonlyArray<string> }> =>
	Arr.flatMap(body, (s): ReturnType<typeof deltasIn> =>
		s.kind === "createSessionTable" && s.columns.length > 0
			? [{ name: s.name, columns: Arr.map(s.columns, (c) => c.name) }]
			: s.kind === "if"
				? [...Arr.flatMap(s.branches, (b) => deltasIn(b.body)), ...deltasIn(s.else)]
				: []
	)

/** The side of news of `relation`: the delta its capture creates with a count of each image (rules.ts addRules). */
const newsOf = (installation: Installation, relation: Written): string =>
	defined(
		Arr.findFirst(
			deltasIn(bodyOf(installation, identifierOf(identity.ruleCapture(relation)))),
			(d) => Arr.contains(d.columns, countColumn)
		).pipe(Option.getOrUndefined),
		`${relation}'s side of news`
	).name

/**
 * Which relations' added rows each rule's probes read, as the coverage of analysis/theory/query.ts `covered` decides:
 * R's at its key is covered by S in Direct and Defined (S ⊆ R, through Either's two rules in Defined), and by T in
 * Chained through T ⊆ S ⊆ R, a composition alone; R's cap in Capped is a field no containment pins; R's rows in
 * Negated, read under two negations inside Unblocked, add facts no row of S pins; U and V, each read at its key alone
 * and each contained in the other, cover each other, so neither is pruned.
 */
const probed: ReadonlyArray<readonly [string, ReadonlyArray<Written>, ReadonlyArray<Written>]> = [
	["Direct_within", ["S"], ["R"]],
	["Capped_within", ["S", "R"], []],
	["Chained_within", ["T", "X"], ["R"]],
	["Cycled_within", ["U", "V", "X"], []],
	["Defined_within", ["S", "A", "B"], ["R"]],
	["Negated_within", ["S", "A", "B", "R"], []]
]

/** Holds the probes of the installation's judge to `probed`: those it reads, and those coverage prunes. */
export const coverage = (installed: Installed) => {
	const installation = installed.installation
	const reads = judgedDeltaReadsOf(installation)
	for (const [name, read, pruned] of probed) {
		const rule = defined(
			Arr.findFirst(installation.laws.rules, (r) => Str.includes(name)(r.law.named.display)).pipe(
				Option.getOrUndefined
			),
			`the rule ${name}`
		)
		const id = identifierOf(rule.named)
		const its = Arr.filter(reads, (r) => Option.contains(raisedRule(r.statement), id))
		for (const relation of read) {
			const news = newsOf(installation, relation)
			assert.ok(
				Arr.some(its, (r) => r.deltas.has(news)),
				`${name}'s probes read ${relation}'s added rows`
			)
		}
		for (const relation of pruned) {
			const news = newsOf(installation, relation)
			assert.ok(
				!Arr.some(its, (r) => r.deltas.has(news)),
				`${name}'s probes read no added row of ${relation}, which a contained relation's rows pin`
			)
		}
	}
}

/** The situations one transaction reaches, from its writes and the state before it. */
const reachedBy = (
	ops: ReadonlyArray<Op>,
	before: ReadonlySet<string>
): ReadonlyArray<CoverFeature> => {
	const reached: Array<CoverFeature> = []
	const puts = (relation: Written) =>
		Arr.filter(ops, (o) => o.kind === "put" && o.relation === relation)
	const putAt = (relation: Written, k: number) =>
		Arr.some(ops, (o) => o.kind === "put" && o.relation === relation && o.k === k)
	if (Arr.some(puts("S"), (o) => o.kind === "put" && putAt("R", o.k))) {
		reached.push("S's and R's rows added in one transaction")
	}
	if (Arr.some(puts("U"), (o) => o.kind === "put" && putAt("V", o.k))) {
		reached.push("a cycle's two rows added in one transaction")
	}
	if (Arr.some(puts("T"), (o) => o.kind === "put" && before.has(`R ${o.k}`))) {
		reached.push("a chain's first row added beside R's")
	}
	if (
		Arr.some(
			ops,
			(o) =>
				o.kind === "set" && o.relation === "R" && before.has(`R ${o.k}`) && before.has(`S ${o.k}`)
		) ||
		Arr.some(
			ops,
			(o, i) =>
				o.kind === "remove" &&
				o.relation === "R" &&
				before.has(`S ${o.k}`) &&
				Arr.some(ops.slice(i + 1), (p) => p.kind === "put" && p.relation === "R" && p.k === o.k)
		)
	) {
		reached.push("R's row replaced at its key under another cap")
	}
	if (
		Arr.some(
			puts("R"),
			(o) =>
				o.kind === "put" &&
				Arr.some([...before], (row) => Str.startsWith("W ")(row) && Str.endsWith(` ${o.k}`)(row))
		)
	) {
		reached.push("a row of R unblocking a negated definition")
	}
	return reached
}

/** The rows that stand of the relations a situation reads, as `relation key` (W's as `W k x`). */
const standingOf = (installed: Installed, session: RawSession) =>
	Effect.gen(function* () {
		const names = namesOf(installed)
		const rows: Array<string> = []
		for (const relation of ["R", "S"] as const) {
			for (const row of yield* session.values(
				`SELECT ${keyColumn(relation)} FROM ${names.table(relations[relation])}`,
				[]
			)) {
				rows.push(`${relation} ${String(row[0])}`)
			}
		}
		for (const row of yield* session.values(`SELECT k, x FROM ${names.table(W)}`, [])) {
			rows.push(`W ${String(row[0])} ${String(row[1])}`)
		}
		return new Set(rows)
	})

/**
 * One case on its own clone: Lim's one group at the bound, then each transaction's writes in order on an owner session
 * at SERIALIZABLE, its end judged as `judged` judges it: refused, the transaction rolls back; accepted, it commits.
 */
export const runSchedule = (
	installed: Installed,
	admin: PgConnection,
	session: RawSession,
	schedule: Schedule,
	c: Case<CoverFeature>
) =>
	Effect.gen(function* () {
		const names = namesOf(installed)
		yield* admin.query(`INSERT INTO ${names.table(Lim)} (grp, max) VALUES (1, ${bound})`, [])
		for (const [at, ops] of schedule.transactions.entries()) {
			const where = `transaction ${at} of ${Formatter.format(schedule)}`
			yield* session.begin
			const before = yield* standingOf(installed, session)
			for (const op of ops) {
				yield* session.query(statementOf(installed, op), [])
			}
			c.noteAll(reachedBy(ops, before))
			const verdict = yield* judged(installed, session, where)
			if (Option.isNone(verdict)) {
				yield* session.commit
				c.note("committed")
			} else {
				c.note(verdict.value === "rule" ? "refused by a rule" : "refused by a containment")
				if (verdict.value === "containment" && Arr.some(ops, (o) => o.kind === "put")) {
					c.note("a containment broken in its own transaction")
				}
				yield* session.rollback
			}
		}
	})
