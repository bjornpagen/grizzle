/** What the properties of checks.test.ts read: its spaces, models and helpers. */

import { array, element, type Gen, int } from "@bjornpagen/testing/gen"
import { regex } from "arkregex"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import { appendAll } from "#compiler/core/array.ts"
import { identity } from "#compiler/core/identity.ts"
import type { ConstraintName } from "#compiler/core/ids.ts"
import type { ConstraintOwner } from "#compiler/ir/products.ts"
import {
	compileInstallation,
	type Installation,
	installOptions
} from "#compiler/physical/install/compile.ts"
import { Compute } from "#compiler/public/compute.ts"
import { closedId, contract, pg, span } from "#compiler/public/fields.ts"
import {
	check,
	closed,
	contained,
	key,
	on,
	relation,
	schema,
	select
} from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { Money } from "#compiler/scalar/values/money.ts"
import type { ObjectName, SqlStatement } from "#compiler/sql/ast.ts"
import { judged, probe, textProbes, type Verdict } from "#test/pg/physical/checks.ts"
import {
	installationNamesOf,
	type NamedRelation,
	parsedSchemaName
} from "#test/support/kernel/naming.ts"
import type { PgConnection, SqlError } from "#test/support/pg.ts"
import { owning } from "#test/support/policy.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

interface Planted {
	readonly k: number
	readonly scores: readonly [number, number, number]
	readonly lo: number
	readonly width: number
	readonly gauge: ReadonlyArray<number>
	readonly mark: ReadonlyArray<{ readonly grade: 0 | 1 | 2; readonly score: number }>
	readonly stay: ReadonlyArray<{ readonly lower: number; readonly width: number }>
	readonly amount: ReadonlyArray<number>
	/** Fee's least amount and the tip at most one charge per account holds, in minor units. */
	readonly fee: number
	readonly tip: number
	readonly charge: ReadonlyArray<Charged>
	/** The class whose CHECK a second installation drops, which the judge must then find. */
	readonly dropped: CheckClass
}

/** A charge probe: its account, its fee and its tip, in minor units. */
interface Charged {
	readonly account: 0 | 1
	readonly fee: number
	readonly tip: number
}

/** The classes of CHECK a case installs, each dropped in turn by some case. */
const checkClasses = ["row", "closed", "endpoint", "domain", "text", "fee"] as const

type CheckClass = (typeof checkClasses)[number]

/**
 * Thresholds and probe values within a few steps of each other, so the drawn probes fall on both sides of every
 * predicate; every array is short, since each element is one savepoint and one INSERT.
 */
const probes = <A>(item: Gen<A>) => array(item, { min: 0, max: 4 })

export const plantedGen: Gen<Planted> = (source) => ({
	k: source.draw(int(-3, 3)),
	scores: [source.draw(int(-3, 3)), source.draw(int(-3, 3)), source.draw(int(-3, 3))],
	lo: source.draw(int(-4, 2)),
	width: source.draw(int(0, 4)),
	gauge: source.draw(probes(int(-5, 5))),
	mark: source.draw(
		probes((mark) => ({
			grade: mark.draw(element([0, 1, 2] as const)),
			score: mark.draw(int(-4, 4))
		}))
	),
	stay: source.draw(
		probes((stay) => ({ lower: stay.draw(int(-6, 6)), width: stay.draw(int(1, 3)) }))
	),
	amount: source.draw(probes(int(-6, 6))),
	fee: source.draw(int(98, 102)),
	tip: source.draw(int(98, 102)),
	charge: source.draw(
		probes((charge) => ({
			account: charge.draw(element([0, 1] as const)),
			fee: charge.draw(int(96, 104)),
			tip: charge.draw(int(98, 102))
		}))
	),
	dropped: source.draw(element(checkClasses))
})

const handles = ["G0", "G1", "G2"] as const

/** The declared text refinement of Tagged's code, and the pattern the host judges its probes by. */
const codeSource = "^[ab]{1,2}$"

const codeFlags = "u"

/** The case's schema: its relations and the two statements whose CHECKs the probes name. */
export const plantedSchema = (p: Planted) => {
	const hi = p.lo + p.width
	const Level = contract("Level", pg.integer, (x) => Compute.between(x, p.lo, hi))
	const Grade = closed.ordered("Grade", handles)
	const GradeScore = closed.relation(
		"GradeScore",
		{ grade: closedId(Grade), score: pg.integer },
		["grade"],
		[
			{ grade: "G0", score: p.scores[0] },
			{ grade: "G1", score: p.scores[1] },
			{ grade: "G2", score: p.scores[2] }
		]
	)
	const Gauge = relation("Gauge", { id: pg.integer, level: pg.integer }, ["id"])
	const Mark = relation("Mark", { id: pg.integer, grade: closedId(Grade), score: pg.integer }, [
		"id"
	])
	const Stay = relation("Stay", { id: pg.integer, during: span(Level) }, ["id"])
	const Amount = relation("Amount", { id: pg.integer, amount: Level }, ["id"])
	const Tagged = relation("Tagged", { id: pg.integer, code: str.regex(codeSource, codeFlags) }, [
		"id"
	])
	const Fee = contract("Fee", pg.money, (x) => Compute.ge(x, Money.of(BigInt(p.fee))))
	const Charge = relation(
		"Charge",
		{ id: pg.integer, account: pg.integer, fee: Fee, tip: pg.money },
		["id"]
	)
	const atLeast = check("AtLeast", Gauge, (x) => x.ge(x.level, p.k))
	const graded = contained(on(Mark, "grade", "score"), on(GradeScore, "grade", "score"))
	const tipOnce = key(
		on(
			select(Charge, (x) => x.eq(x.tip, Money.of(BigInt(p.tip)))),
			"account"
		)
	)
	const value = schema(
		"Checks",
		[Grade, GradeScore, Gauge, Mark, Stay, Amount, Tagged, Charge],
		[atLeast, graded, tipOnce]
	)
	return { value, Gauge, Mark, Stay, Amount, Tagged, Charge, atLeast, graded, tipOnce, hi }
}

type Planting = ReturnType<typeof plantedSchema>

/**
 * A CHECK of the installation: its name under its owner, the table or domain PostgreSQL scopes the name to. A readable
 * name repeats across owners (every domain's CHECK is `check`), so a name alone is no one CHECK.
 */
interface InstalledCheck {
	readonly owner: ConstraintOwner
	readonly name: ConstraintName
}

/** The CHECK each class installs, as the naming door names it. */
type Checks = Readonly<Record<CheckClass, InstalledCheck>>

export const checksOf = (installation: Installation, s: Planting): Checks => {
	const names = installationNamesOf(installation)
	const level = names.contract("Level")
	if (level.kind !== "checked") {
		throw new Error("the Level contract installs no CHECK")
	}
	const fee = names.contract("Fee")
	if (fee.kind !== "checked") {
		throw new Error("the Fee contract installs no CHECK")
	}
	const text = names.textDomain(s.Tagged, "code")
	const onTable = (of: NamedRelation, name: ConstraintName): InstalledCheck => ({
		owner: { kind: "table", name: names.tableIdent(of) },
		name
	})
	return {
		row: onTable(s.Gauge, names.constraintOf(names.lawOf(s.atLeast), "TableCheck")),
		closed: onTable(s.Mark, names.constraintOf(names.lawOf(s.graded), "ClosedCheck")),
		endpoint: onTable(
			s.Stay,
			names.spanCheck(s.Stay, "during", { kind: "endpoint", contract: "Level" })
		),
		domain: { owner: { kind: "domain", name: level.domain }, name: level.constraint },
		text: { owner: { kind: "domain", name: text.domain }, name: text.constraint },
		fee: { owner: { kind: "domain", name: fee.domain }, name: fee.constraint }
	}
}

/** What a case reached: each class admitting and refusing, and the span refused by its upper endpoint alone. */
export type CheckFeature =
	| "row check admits"
	| "row check refuses"
	| "closed check admits"
	| "closed check refuses"
	| "endpoint check admits"
	| "endpoint check refuses"
	| "endpoint check refuses by its upper endpoint alone"
	| "contract check admits"
	| "contract check refuses"
	| "text check admits"
	| "text check refuses"
	| "money check admits"
	| "money check refuses"
	| "money key admits"
	| "money key refuses"
	| `dropped ${CheckClass} found`

export const situations = [
	"row check admits",
	"row check refuses",
	"closed check admits",
	"closed check refuses",
	"endpoint check admits",
	"endpoint check refuses",
	"endpoint check refuses by its upper endpoint alone",
	"contract check admits",
	"contract check refuses",
	"text check admits",
	"text check refuses",
	"money check admits",
	"money check refuses",
	"money key admits",
	"money key refuses",
	"dropped row found",
	"dropped closed found",
	"dropped endpoint found",
	"dropped domain found",
	"dropped text found",
	"dropped fee found"
] as const satisfies ReadonlyArray<CheckFeature>

/**
 * The probes of a case: the drawn ones, then one on each side of every predicate (the span's upper endpoint past hi
 * while its lower one holds), and two charges of one account at the tip at most one of its charges holds.
 */
const probesOf = (p: Planted, hi: number): Planted => ({
	...p,
	gauge: [...p.gauge, p.k - 1, p.k],
	mark: [...p.mark, { grade: 0, score: p.scores[0] }, { grade: 0, score: p.scores[0] + 1 }],
	stay: [
		...p.stay,
		{ lower: p.lo - 1, width: 1 },
		{ lower: hi, width: 1 },
		{ lower: p.lo, width: 1 }
	],
	amount: [...p.amount, p.lo - 1, p.lo],
	charge: [
		...p.charge,
		{ account: 0, fee: p.fee - 1, tip: p.tip },
		{ account: 1, fee: p.fee, tip: p.tip },
		{ account: 1, fee: p.fee, tip: p.tip }
	]
})

/**
 * Every probe row inserted under a savepoint into the installation the pinned session's transaction holds: the problems
 * the judge finds, and the features reached.
 */
export const judgeCase = (
	pinned: PgConnection,
	installation: Installation,
	s: Planting,
	p: Planted
): Effect.Effect<
	{ readonly problems: ReadonlyArray<string>; readonly reached: ReadonlySet<CheckFeature> },
	SqlError
> =>
	Effect.gen(function* () {
		const names = installationNamesOf(installation)
		const checks = checksOf(installation, s)
		const problems: Array<string> = []
		const reached = new Set<CheckFeature>()
		let id = 0
		const run = (sql: string, params: ReadonlyArray<unknown>) =>
			probe(pinned, sql, [++id, ...params])
		const between = (v: number) => p.lo <= v && v <= s.hi
		const all = probesOf(p, s.hi)
		for (const level of all.gauge) {
			const holds = level >= p.k
			const verdict = yield* run(
				`INSERT INTO ${names.table(s.Gauge)} (${names.column(s.Gauge, "id")}, ${names.column(s.Gauge, "level")}) VALUES ($1, $2)`,
				[level]
			)
			appendAll(
				problems,
				judged(`Gauge level ${level} against level >= ${p.k}`, holds, verdict, checks.row.name)
			)
			reached.add(holds ? "row check admits" : "row check refuses")
		}
		for (const m of all.mark) {
			const grade = handles[m.grade]
			const holds = p.scores[m.grade] === m.score
			/** A closed id is stored as its code, the handle's position in the roster's declared order. */
			const verdict = yield* run(
				`INSERT INTO ${names.table(s.Mark)} (${names.column(s.Mark, "id")}, ${names.column(s.Mark, "grade")}, ${names.column(s.Mark, "score")}) VALUES ($1, $2, $3)`,
				[m.grade, m.score]
			)
			appendAll(
				problems,
				judged(`Mark (${grade}, ${m.score}) in Grade's facts`, holds, verdict, checks.closed.name)
			)
			reached.add(holds ? "closed check admits" : "closed check refuses")
		}
		for (const st of all.stay) {
			const upper = st.lower + st.width
			const holds = between(st.lower) && between(upper)
			const verdict = yield* run(
				`INSERT INTO ${names.table(s.Stay)} (${names.column(s.Stay, "id")}, ${names.column(s.Stay, "during")}) VALUES ($1, int4range($2::integer, $3::integer))`,
				[st.lower, upper]
			)
			appendAll(
				problems,
				judged(
					`Stay [${st.lower}, ${upper}) in Level ${p.lo}..${s.hi}`,
					holds,
					verdict,
					checks.endpoint.name
				)
			)
			reached.add(holds ? "endpoint check admits" : "endpoint check refuses")
			if (between(st.lower) && !between(upper)) {
				reached.add("endpoint check refuses by its upper endpoint alone")
			}
		}
		for (const amount of all.amount) {
			const holds = between(amount)
			const verdict = yield* run(
				`INSERT INTO ${names.table(s.Amount)} (${names.column(s.Amount, "id")}, ${names.column(s.Amount, "amount")}) VALUES ($1, $2)`,
				[amount]
			)
			appendAll(
				problems,
				judged(`Amount ${amount} in Level ${p.lo}..${s.hi}`, holds, verdict, checks.domain.name)
			)
			reached.add(holds ? "contract check admits" : "contract check refuses")
		}
		/** Every probe text, judged by the declared pattern: "a" and "ab" hold, "c" and "abc" do not. */
		const code = regex.as(codeSource, codeFlags)
		for (const text of textProbes) {
			const holds = code.test(text)
			const verdict = yield* run(
				`INSERT INTO ${names.table(s.Tagged)} (${names.column(s.Tagged, "id")}, ${names.column(s.Tagged, "code")}) VALUES ($1, $2)`,
				[text]
			)
			appendAll(
				problems,
				judged(`Tagged code ${Formatter.format(text)}`, holds, verdict, checks.text.name)
			)
			reached.add(holds ? "text check admits" : "text check refuses")
		}
		/**
		 * A charge's amount, parameter `at`, sent as its minor units: a numeric of hundredths, the two fraction digits of
		 * money under the harness session's lc_monetary, C.UTF-8 (test/support/pg.ts). A fee below Fee's least is
		 * refused by its domain's CHECK; a tip at the selected amount is refused by the key's UNIQUE when its account
		 * already holds a charge at it; every other charge is stored.
		 */
		const money = (at: number) => `($${at}::numeric / 100)::money`
		const tipKey = names.constraintOf(names.lawOf(s.tipOnce), "Unique")
		const tipped = new Set<number>()
		for (const charge of all.charge) {
			const verdict = yield* run(
				`INSERT INTO ${names.table(s.Charge)} (${names.column(s.Charge, "id")}, ${names.column(s.Charge, "account")}, ${names.column(s.Charge, "fee")}, ${names.column(s.Charge, "tip")}) VALUES ($1, $2, ${money(3)}, ${money(4)})`,
				[charge.account, charge.fee, charge.tip]
			)
			const what = `Charge of account ${charge.account}, fee ${charge.fee} and tip ${charge.tip}`
			if (charge.fee < p.fee) {
				appendAll(problems, judged(what, false, verdict, checks.fee.name))
				reached.add("money check refuses")
				continue
			}
			reached.add("money check admits")
			if (charge.tip !== p.tip) {
				appendAll(problems, judged(what, true, verdict, checks.fee.name))
				continue
			}
			if (tipped.has(charge.account)) {
				appendAll(problems, refusedBy(what, verdict, "23505", tipKey))
				reached.add("money key refuses")
				continue
			}
			appendAll(problems, judged(what, true, verdict, checks.fee.name))
			tipped.add(charge.account)
			reached.add("money key admits")
		}
		return { problems, reached }
	})

/** The problem a verdict poses against a refusal the host model expects with `code`, naming `constraint`. */
const refusedBy = (
	what: string,
	verdict: Verdict,
	code: string,
	constraint: ConstraintName
): ReadonlyArray<string> =>
	verdict.kind === "refused" &&
	verdict.code === code &&
	Option.contains(verdict.constraint, constraint)
		? []
		: [`${what}: ${Formatter.format(verdict)}, where ${code} ${constraint} refuses it`]

/**
 * The installation's script without `dropped` and every statement that names it: its declaration under its owner, inline
 * in a CREATE TABLE or DOMAIN or added by an ALTER TABLE or ALTER DOMAIN, and its COMMENT, which a hashed name has
 * (physical/install/comments.ts). Every other owner's CHECK of the same name stays.
 */
export const withoutCheck = (
	statements: ReadonlyArray<SqlStatement>,
	dropped: InstalledCheck
): ReadonlyArray<SqlStatement> => {
	const owns = (kind: ConstraintOwner["kind"], owner: ObjectName): boolean =>
		dropped.owner.kind === kind && dropped.owner.name === owner.name
	return Arr.flatMap(statements, (st): ReadonlyArray<SqlStatement> => {
		if (st.kind === "createTable") {
			return owns("table", st.table)
				? [
						{
							...st,
							secondary: Arr.filter(
								st.secondary,
								(c) => !(c.kind === "check" && c.name === dropped.name)
							)
						}
					]
				: [st]
		}
		if (st.kind === "createDomain") {
			return owns("domain", st.name)
				? [
						{
							...st,
							constraints: Arr.filter(st.constraints, (c) => c.name !== dropped.name)
						}
					]
				: [st]
		}
		if (st.kind === "alterTable") {
			const actions = Arr.filter(
				st.actions,
				(a) =>
					!(
						owns("table", st.table) &&
						a.kind === "addConstraint" &&
						a.constraint.kind === "check" &&
						a.constraint.name === dropped.name
					)
			)
			return Arr.isReadonlyArrayNonEmpty(actions) ? [{ ...st, actions }] : []
		}
		if (st.kind === "alterDomain") {
			return owns("domain", st.name) &&
				st.action.kind === "addConstraint" &&
				st.action.constraint.name === dropped.name
				? []
				: [st]
		}
		if (st.kind === "comment") {
			return (st.on.kind === "CONSTRAINT" &&
				owns("table", st.on.on) &&
				st.on.name === dropped.name) ||
				(st.on.kind === "DOMAIN CONSTRAINT" &&
					owns("domain", st.on.domain) &&
					st.on.name === dropped.name)
				? []
				: [st]
		}
		return [st]
	})
}

/** Installs `sql` under `schema` on the pinned session in a transaction, runs `body` in it, and rolls back. */
export const inInstallation = <A>(
	pinned: PgConnection,
	sql: ReadonlyArray<string>,
	body: Effect.Effect<A, SqlError>
): Effect.Effect<A, SqlError> =>
	Effect.ensuring(
		Effect.gen(function* () {
			yield* pinned.query("BEGIN", [])
			for (const statement of sql) {
				yield* pinned.query(statement, [])
			}
			return yield* body
		}),
		Effect.orDie(pinned.query("ROLLBACK", []))
	)

/** The case's real installation under a fresh schema name of the substrate's. */
export const checksInstallation = (s: Planting) =>
	Effect.gen(function* () {
		const substrate = yield* Substrate
		const schemaName = yield* substrate.schema({ create: false, label: "checks" })
		const owned = owning(s.value)
		const real = compileInstallation(owned, {
			...installOptions(owned),
			levels: [identity.schema(parsedSchemaName(schemaName))]
		})
		if (!real.ok) {
			return yield* Effect.die(new Error(`real compile ${real.error.message}`))
		}
		return real.value
	})
