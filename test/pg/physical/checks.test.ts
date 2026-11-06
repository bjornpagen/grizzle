import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, element, type Gen, int } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Record as Rec } from "effect"
import { appendAll } from "#compiler/core/array.ts"
import { identity } from "#compiler/core/identity.ts"
import type { ConstraintName } from "#compiler/core/ids.ts"
import type { ConstraintOwner } from "#compiler/ir/products.ts"
import {
	compileInstallation,
	type Installation,
	installOptions
} from "#compiler/physical/install/compile.ts"
import { closedId, contract, pg, span } from "#compiler/public/fields.ts"
import { check, closed, contained, on, relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import type { ObjectName, SqlStatement } from "#compiler/sql/ast.ts"
import { printStatement } from "#compiler/sql/print.ts"
import { judged, probe, textProbes } from "#test/pg/physical/checks.ts"
import { assert } from "#test/support/assert.ts"
import { installationSql } from "#test/support/compile.ts"
import {
	installationNamesOf,
	type NamedRelation,
	parsedSchemaName
} from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import type { PgConnection, SqlError } from "#test/support/pg.ts"
import { owning } from "#test/support/policy.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

import { regex } from "arkregex"
/**
 * The predicate CHECKs of the real installer admit exactly what their declarations mean (checks.ts).
 *
 * Each case declares one CHECK of every predicate class over a small schema, its thresholds and the closed facts drawn:
 * - a row check, `check("AtLeast", Gauge, level >= k)` (a law model TableCheck);
 * - a closed check, the containment of Mark's (grade, score) in GradeScore's (grade, score) rows, a closed relation
 *   over the roster Grade (a ClosedCheck);
 * - a contract's predicate, `Level` between lo and hi, as the domain's CHECK on a plain column, and as the endpoint
 *   CHECK of a span over Level, the predicate over the lower and then the upper endpoint (physical/span/storage.ts);
 * - a text refinement, `^[ab]{1,2}$`, as its text domain's CHECK on a plain column, probed with checks.ts textProbes
 *   and judged by the declared pattern as the JavaScript engine reads it.
 *
 * The real installation runs in a transaction on a pinned session, and every probe row is inserted under a savepoint:
 * the server must admit a row exactly when the host meaning holds and refuse every other with 23514 naming that
 * declaration's CHECK. Beside the drawn probes, each case adds rows on both sides of every predicate, the span's upper
 * endpoint failing alone among them, so a run judges each class both ways. A second test drops each class's CHECK from
 * the installation in turn, that CHECK alone under its own table or domain, and requires the same judge to find the
 * defect: the property discriminates every class.
 */
interface Planted {
	readonly k: number
	readonly scores: readonly [number, number, number]
	readonly lo: number
	readonly width: number
	readonly gauge: ReadonlyArray<number>
	readonly mark: ReadonlyArray<{ readonly grade: 0 | 1 | 2; readonly score: number }>
	readonly stay: ReadonlyArray<{ readonly lower: number; readonly width: number }>
	readonly amount: ReadonlyArray<number>
}

/**
 * Thresholds and probe values within a few steps of each other, so the drawn probes fall on both sides of every
 * predicate; every array is short, since each element is one savepoint and one INSERT.
 */
const probes = <A>(item: Gen<A>) => array(item, { min: 0, max: 4 })
const plantedGen: Gen<Planted> = (source) => ({
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
	amount: source.draw(probes(int(-6, 6)))
})

const handles = ["G0", "G1", "G2"] as const

/** The declared text refinement of Tagged's code, and the pattern the host judges its probes by. */
const codeSource = "^[ab]{1,2}$"
const codeFlags = "u"

/** The case's schema: its relations and the two statements whose CHECKs the probes name. */
const plantedSchema = (p: Planted) => {
	const hi = p.lo + p.width
	const Level = contract("Level", pg.integer, (x) => x.between(p.lo, hi))
	const Grade = closed("Grade", handles)
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
	const atLeast = check("AtLeast", Gauge, (x) => x.level.ge(p.k))
	const graded = contained(on(Mark, "grade", "score"), on(GradeScore, "grade", "score"))
	const value = schema("Checks", { Grade, GradeScore, Gauge, Mark, Stay, Amount, Tagged }, [
		atLeast,
		graded
	])
	return { value, Gauge, Mark, Stay, Amount, Tagged, atLeast, graded, hi }
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
interface Checks {
	readonly row: InstalledCheck
	readonly closed: InstalledCheck
	readonly endpoint: InstalledCheck
	readonly domain: InstalledCheck
	readonly text: InstalledCheck
}

const checksOf = (installation: Installation, s: Planting): Checks => {
	const names = installationNamesOf(installation)
	const level = names.contract("Level")
	if (level.kind !== "checked") {
		throw new Error("the Level contract installs no CHECK")
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
		text: { owner: { kind: "domain", name: text.domain }, name: text.constraint }
	}
}

/** What a case reached: each class admitting and refusing, and the span refused by its upper endpoint alone. */
type CheckFeature =
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

const situations = [
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
	"text check refuses"
] as const satisfies ReadonlyArray<CheckFeature>

/**
 * The probes of a case: the drawn ones, then one on each side of every predicate (the span's upper endpoint past hi
 * while its lower one holds).
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
	amount: [...p.amount, p.lo - 1, p.lo]
})

/**
 * Every probe row inserted under a savepoint into the installation the pinned session's transaction holds: the problems
 * the judge finds, and the features reached.
 */
const judgeCase = (
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
		return { problems, reached }
	})

/**
 * The installation's script without `dropped` and every statement that names it: its declaration under its owner, inline
 * in a CREATE TABLE or DOMAIN or added by an ALTER TABLE or ALTER DOMAIN, and its COMMENT, which a hashed name has
 * (physical/install/comments.ts). Every other owner's CHECK of the same name stays.
 */
const withoutCheck = (
	statements: ReadonlyArray<SqlStatement>,
	dropped: InstalledCheck
): ReadonlyArray<string> => {
	const owns = (kind: ConstraintOwner["kind"], owner: ObjectName): boolean =>
		dropped.owner.kind === kind && dropped.owner.name === owner.name
	return Arr.flatMap(statements, (st): ReadonlyArray<string> => {
		if (st.kind === "createTable") {
			return owns("table", st.table)
				? [
						printStatement({
							...st,
							secondary: Arr.filter(
								st.secondary,
								(c) => !(c.kind === "check" && c.name === dropped.name)
							)
						})
					]
				: [printStatement(st)]
		}
		if (st.kind === "createDomain") {
			return owns("domain", st.name)
				? [
						printStatement({
							...st,
							constraints: Arr.filter(st.constraints, (c) => c.name !== dropped.name)
						})
					]
				: [printStatement(st)]
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
			return Arr.isReadonlyArrayNonEmpty(actions) ? [printStatement({ ...st, actions })] : []
		}
		if (st.kind === "alterDomain") {
			return owns("domain", st.name) &&
				st.action.kind === "addConstraint" &&
				st.action.constraint.name === dropped.name
				? []
				: [printStatement(st)]
		}
		if (st.kind === "comment") {
			return (st.on.kind === "CONSTRAINT" &&
				owns("table", st.on.on) &&
				st.on.name === dropped.name) ||
				(st.on.kind === "DOMAIN CONSTRAINT" &&
					owns("domain", st.on.domain) &&
					st.on.name === dropped.name)
				? []
				: [printStatement(st)]
		}
		return [printStatement(st)]
	})
}

/** Installs `sql` under `schema` on the pinned session in a transaction, runs `body` in it, and rolls back. */
const inInstallation = <A>(
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
const installationOf = (s: Planting) =>
	Effect.gen(function* () {
		const substrate = yield* Substrate
		const schemaName = yield* substrate.schema({ create: false, label: "checks" })
		const owned = owning(s.value)
		const real = compileInstallation(owned, {
			...installOptions(owned, substrate.owner.role),
			installation: identity.schema(parsedSchemaName(schemaName))
		})
		if (!real.ok) {
			return yield* Effect.die(new Error(`real compile ${real.error.message}`))
		}
		return real.value
	})

layer(Substrate.layer)("the predicate CHECKs of the real installer", (it) => {
	it.effect("admit exactly what each declaration means", (ctx) =>
		searched(
			ctx,
			Effect.gen(function* () {
				const substrate = yield* Substrate
				return yield* explore(
					{
						suite: "physical/checks",
						draw: drawn(plantedGen),
						literal: Formatter.format,
						coverage: required<CheckFeature>(situations, { cases: 40, sense: notesOnly }),
						kept: [],
						/**
						 * The floor stream runs 10 and the rotating stream 40 cases; each class is judged both ways in
						 * every case by construction (probesOf), so the drawn probes only widen the values.
						 */
						runs: 40,
						shrink: { kind: "complete" },
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(p, c) =>
						Effect.scoped(
							Effect.gen(function* () {
								const s = plantedSchema(p)
								const installation = yield* installationOf(s)
								const pinned = yield* substrate.admin.pin
								const { problems, reached } = yield* inInstallation(
									pinned,
									installationSql(installation),
									judgeCase(pinned, installation, s, p)
								)
								c.noteAll(reached)
								assert.deepEqual(problems, [])
							})
						)
				)
			})
		)
	)

	it.effect("finds the CHECK of every class dropped from the installation", () =>
		Effect.scoped(
			Effect.gen(function* () {
				const substrate = yield* Substrate
				/**
				 * One case whose every class is judged both ways (probesOf adds the rows): the thresholds 0, the scores
				 * distinct, and Level 0..2, wide enough for an admitted span.
				 */
				const p: Planted = {
					k: 0,
					scores: [0, 1, 2],
					lo: 0,
					width: 2,
					gauge: [],
					mark: [],
					stay: [],
					amount: []
				}
				const s = plantedSchema(p)
				const installation = yield* installationOf(s)
				const pinned = yield* substrate.admin.pin
				const checks = checksOf(installation, s)
				const intact = yield* inInstallation(
					pinned,
					installationSql(installation),
					judgeCase(pinned, installation, s, p)
				)
				assert.deepEqual(intact.problems, [])
				for (const [label, dropped] of Rec.toEntries(checks)) {
					const mutant = yield* inInstallation(
						pinned,
						withoutCheck(installation.statements, dropped),
						judgeCase(pinned, installation, s, p)
					)
					assert.ok(
						mutant.problems.length > 0,
						`the ${label} CHECK ${dropped.name} of ${dropped.owner.kind} ${dropped.owner.name} dropped went unnoticed`
					)
				}
			})
		)
	)
})
