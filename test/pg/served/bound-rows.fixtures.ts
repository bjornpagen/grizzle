/** What the property of bound-rows.test.ts reads: its levels, its programs, its space and its oracle. */

import { array, constant, type Gen, int, weighted } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Order } from "effect"
import { isRecord } from "#compiler/core/record.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { int4 } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { context, login, relation, role, schema } from "#compiler/public/schema.ts"
import { workload } from "#compiler/public/workload.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { type Generated, generatedTemplate } from "#test/support/install-migrate.ts"
import type { PgConnection } from "#test/support/pg.ts"
import type { SubstrateTemplate } from "#test/support/substrate/substrate.ts"

/**
 * A lower level's relation parameter bound to a query of a higher level, the shapes edullm and metis write
 * (handoff/BINDLEVEL/edullm-shapes.md):
 *
 * - The ledger, over Delivery: `openVisit`, the open visits of the sittings its relation parameter `sittings` names (a
 *   visit no suspension and no end of its sitting holds), and `suspendTest`, a ChangeSet of two inserts, each matching
 *   `openVisit` bound to the importing rule's own `sittings` (qti-pie's sitting-programs); `recordValue`, the sequence
 *   of `valued`, an insert of each awaiting item of a child scored by each scorer its relation parameter `scorers`
 *   names, which its rule matches directly, and `settled`, the scored items graded (GRADING-SQL's personValueOf).
 * - The app, over Installed, a level above Delivery: `appSittings`, the child's own stages, and `admittedScorer`, the
 *   operator its token names where Admin holds them (a context's read).
 * - Bound three ways: the ChangeSet-level bind (`suspendTest.bind({ sittings: appSittings })`, `child` the program's
 *   own parameter, and `recordValue.bind({ scorers: admittedScorer })` across its sequence); the import's bind in the
 *   app's own rules (`openVisit.bind({ sittings: appSittings.bind({ child }) })`); and today's form, the ledger's own
 *   programs fed the rows the app's guard returns.
 */

/** A child, a stage, a visit's ordinal, an item's ordinal, a person and a score: small integers. */
const visitFields = { child: int4, stage: int4, k: int4 } as const

const TestVisit = relation("TestVisit", visitFields, ["child", "stage", "k"])
const TestSuspension = relation("TestSuspension", visitFields, ["child", "stage", "k"])
const TestEnd = relation("TestEnd", { child: int4, stage: int4 }, ["child", "stage"])
const TestMoment = relation("TestMoment", { child: int4, stage: int4 }, ["child", "stage"])
const Awaiting = relation("Awaiting", { child: int4, n: int4 }, ["child", "n"])
const Scored = relation("Scored", { child: int4, n: int4, scorer: int4, score: int4 }, [
	"child",
	"n",
	"scorer"
])
const Graded = relation("Graded", { child: int4, n: int4 }, ["child", "n"])

/** The app's own relations: each child's stages, and the admins. */
const Stage = relation("Stage", { child: int4, key: int4 }, ["child", "key"])
const Admin = relation("Admin", { user: int4 }, ["user"])

/** The operator a token names. */
const OperatorToken = context("OperatorToken", { sub: int4 })

/** Delivery, and Installed over it, of a case under `name`. */
const levelsOf = (name: string) => {
	const delivery = schema(
		name,
		[TestVisit, TestSuspension, TestEnd, TestMoment, Awaiting, Scored, Graded],
		[]
	)
	const installed = schema.extend([delivery], `${name}_app`, [Stage, Admin], [])
	return { delivery, installed }
}

/** A sitting: a child's stage, as TestVisit holds it. */
const sittingHeading = { child: TestVisit.fields.child, stage: TestVisit.fields.stage } as const

/** The ledger's programs over Delivery, which state the sittings and scorers they act on as relation parameters. */
const ledgerOf = (delivery: ReturnType<typeof levelsOf>["delivery"]) => {
	const openVisit = query(delivery).rule((r) => {
		const sittings = r.relation("sittings", sittingHeading)
		const { child, stage } = v(sittings, "openSitting")
		const { k } = v(TestVisit, "openVisit")
		return r
			.match(sittings, { child, stage })
			.match(TestVisit, { child, k, stage })
			.where(r.not(TestSuspension, { child, k, stage }), r.not(TestEnd, { child, stage }))
			.find({ child, k, stage })
	})
	const suspendTest = ChangeSet.empty(delivery)
		.insert(
			TestMoment,
			query(delivery).rule((r) => {
				const open = openVisit.bind({ sittings: r.relation("sittings", sittingHeading) })
				const { child, stage } = v(open, "suspending")
				return r.match(open, { child, stage }).find({ child, stage })
			})
		)
		.insert(
			TestSuspension,
			query(delivery).rule((r) => {
				const open = openVisit.bind({ sittings: r.relation("sittings", sittingHeading) })
				const { child, stage, k } = v(open, "suspended")
				return r.match(open, { child, stage, k }).find({ child, stage, k })
			})
		)
	const valued = ChangeSet.empty(delivery).insert(
		Scored,
		query(delivery).rule((r) => {
			const scorers = r.relation("scorers", { scorer: Scored.fields.scorer })
			const { scorer } = v(scorers, "scorer")
			const { child, n } = v(Awaiting, "awaiting")
			return r
				.match(scorers, { scorer })
				.match(Awaiting, { child, n })
				.where(r.eq(child, r.param("child", int4)))
				.find({ child, n, scorer, score: r.param("score", int4) })
		})
	)
	const settled = ChangeSet.empty(delivery).insert(
		Graded,
		query(delivery).rule((r) => {
			const { child, n } = v(Scored, "scored")
			return r
				.match(Scored, { child, n })
				.where(r.eq(child, r.param("child", int4)))
				.find({ child, n })
		})
	)
	const takeTest = ChangeSet.empty(delivery).insert(
		TestVisit,
		query(delivery).rule((r) => {
			const taken = r.relation("taken", sittingHeading)
			const { child, stage } = v(taken, "taken")
			return r.match(taken, { child, stage }).find({ child, stage, k: 1 })
		})
	)
	return { openVisit, suspendTest, recordValue: ChangeSet.sequence(valued, settled), takeTest }
}

/** The app's guards over Installed: the child's own stages, and the admitted operator. */
const appOf = (installed: ReturnType<typeof levelsOf>["installed"]) => {
	const appSittings = query(installed).rule((r) => {
		const { child, key } = v(Stage, "own")
		return r
			.match(Stage, { child, key })
			.where(r.eq(child, r.param("child", int4)))
			.find({ child, stage: key })
	})
	const admittedScorer = query(installed).rule((r) => {
		const { sub } = v(OperatorToken, "token")
		return r.match(OperatorToken, { sub }).match(Admin, { user: sub }).find({ scorer: sub })
	})
	return { appSittings, admittedScorer }
}

/** The programs of a case of `name`: the bound forms, the fed form, and the reads that compare them. */
const programsOf = (name: string) => {
	const { delivery, installed } = levelsOf(name)
	const ledger = ledgerOf(delivery)
	const app = appOf(installed)
	return {
		/** The ChangeSet-level bind: one binding for the whole program, `child` its own parameter. */
		suspendBound: ledger.suspendTest.bind({ sittings: app.appSittings }),
		/** The import's bind, in the app's own rules. */
		suspendImported: ChangeSet.empty(installed)
			.insert(
				TestMoment,
				query(installed).rule((r) => {
					const open = ledger.openVisit.bind({
						sittings: app.appSittings.bind({ child: r.param("child", int4) })
					})
					const { child, stage } = v(open, "suspending")
					return r.match(open, { child, stage }).find({ child, stage })
				})
			)
			.insert(
				TestSuspension,
				query(installed).rule((r) => {
					const open = ledger.openVisit.bind({
						sittings: app.appSittings.bind({ child: r.param("child", int4) })
					})
					const { child, stage, k } = v(open, "suspended")
					return r.match(open, { child, stage, k }).find({ child, stage, k })
				})
			),
		/** Today's form: the ledger's own ChangeSet, fed the app's guard's rows. */
		suspendFed: ledger.suspendTest,
		/** The open visits of the child's own sittings, read through the import's bind. */
		openBound: query(installed).rule((r) => {
			const open = ledger.openVisit.bind({
				sittings: app.appSittings.bind({ child: r.param("child", int4) })
			})
			const { child, stage, k } = v(open, "open")
			return r.match(open, { child, stage, k }).find({ child, stage, k })
		}),
		/** The open visits of the sittings a caller feeds. */
		openFed: ledger.openVisit,
		/** The child's own sittings, the rows the fed forms are given. */
		sittingsOf: app.appSittings,
		/** The scorers' write across a sequence, its scorers the admitted operator. */
		evaluate: ledger.recordValue.bind({ scorers: app.admittedScorer }),
		/** The app decides a stage of the child, then the ledger's take opens a visit of each of the child's sittings, its
		 * `taken` the app's guard read after the decision, in the take's own statement. */
		decideTake: ChangeSet.sequence(
			ChangeSet.empty(installed).insert(
				Stage,
				query(installed).rule((r) =>
					r.find({ child: r.param("child", int4), key: r.param("decided", int4) })
				)
			),
			ledger.takeTest.bind({ taken: app.appSittings })
		)
	}
}

/** The served world of a case of `name`: a login whose one role reads the token's operator and holds the programs. */
export const worldOf = (name: string) => {
	const { installed } = levelsOf(name)
	const operator = query(installed).rule((r) => {
		const { sub } = v(OperatorToken, "token")
		return r.match(OperatorToken, { sub }).find({ sub })
	})
	const app = role(
		installed,
		"app",
		{
			TestVisit,
			TestSuspension,
			TestEnd,
			TestMoment,
			Awaiting,
			Scored,
			Graded,
			Stage,
			Admin,
			Operator: operator
		},
		{
			insert: [
				"TestVisit",
				"TestSuspension",
				"TestEnd",
				"TestMoment",
				"Awaiting",
				"Scored",
				"Graded",
				"Stage",
				"Admin"
			],
			contexts: [OperatorToken]
		}
	)
	const programs = programsOf(name)
	return {
		app,
		programs,
		server: login(installed, "server", [app], { workload: [workload(app, programs)] })
	}
}

/** The installation of a case's levels as a template, which every case clones. */
export const boundRowsTemplate: SubstrateTemplate<Generated> = generatedTemplate({
	declaredIn: import.meta,
	name: "bound_rows",
	content: {
		programs: ["suspendBound", "suspendImported", "suspendFed", "evaluate", "decideTake"]
	},
	build: (name) => ({ schema: levelsOf(name).installed, logins: [worldOf(name).server] }),
	ambient: ordinarySession
})

/** A case: what Delivery and the app hold, the child it acts for, the operator its token names, and the score. */
export interface BoundCase {
	readonly visits: ReadonlyArray<{
		readonly child: number
		readonly stage: number
		readonly k: number
	}>
	readonly suspended: ReadonlyArray<{
		readonly child: number
		readonly stage: number
		readonly k: number
	}>
	readonly ended: ReadonlyArray<{ readonly child: number; readonly stage: number }>
	readonly stages: ReadonlyArray<{ readonly child: number; readonly key: number }>
	readonly awaiting: ReadonlyArray<{ readonly child: number; readonly n: number }>
	readonly admins: ReadonlyArray<number>
	readonly child: number
	readonly operator: number
	readonly score: number
	/** The stage the app decides for the child before the take. */
	readonly decided: number
}

const small = int(1, 3)

/** Whether a drawn visit is suspended: a third of them, so most children keep an open visit. */
const suspendedGen = weighted([
	[1, constant(true)],
	[2, constant(false)]
])

const pairs = <A>(gen: Gen<A>): Gen<ReadonlyArray<A>> => array(gen, { min: 0, max: 6 })

/** A drawn case, its rows deduplicated by their keys. */
export const boundCaseGen: Gen<BoundCase> = (source) => {
	const visit = (s: typeof source) => ({
		child: s.draw(small),
		stage: s.draw(small),
		k: s.draw(int(1, 2))
	})
	const visits = Arr.dedupeWith(
		source.draw(pairs(visit)),
		(a, b) => a.child === b.child && a.stage === b.stage && a.k === b.k
	)
	return {
		visits,
		suspended: Arr.filter(visits, () => source.draw(suspendedGen)),
		ended: Arr.dedupeWith(
			source.draw(pairs((s) => ({ child: s.draw(small), stage: s.draw(small) }))),
			(a, b) => a.child === b.child && a.stage === b.stage
		),
		stages: Arr.dedupeWith(
			source.draw(pairs((s) => ({ child: s.draw(small), key: s.draw(small) }))),
			(a, b) => a.child === b.child && a.key === b.key
		),
		awaiting: Arr.dedupeWith(
			source.draw(pairs((s) => ({ child: s.draw(small), n: s.draw(small) }))),
			(a, b) => a.child === b.child && a.n === b.n
		),
		admins: Arr.dedupe(source.draw(array(small, { min: 0, max: 2 }))),
		child: source.draw(small),
		operator: source.draw(small),
		score: source.draw(int(0, 9)),
		decided: source.draw(small)
	}
}

/** A case's facts, as the installation loads them. */
export const factsOf = (c: BoundCase) => ({
	TestVisit: c.visits,
	TestSuspension: c.suspended,
	TestEnd: c.ended,
	TestMoment: [],
	Awaiting: c.awaiting,
	Scored: [],
	Graded: [],
	Stage: c.stages,
	Admin: Arr.map(c.admins, (user) => ({ user }))
})

/** The child's own sittings, the rows the app's guard returns. */
export const sittingsOfCase = (c: BoundCase) =>
	Arr.map(
		Arr.filter(c.stages, (s) => s.child === c.child),
		(s) => ({ child: s.child, stage: s.key })
	)

/** The text of a row of `columns`, as both sides read it. */
const rowTextOf =
	(columns: ReadonlyArray<string>) =>
	(row: unknown): string =>
		isRecord(row)
			? Arr.join(
					Arr.map(columns, (c) => String(row[c])),
					"|"
				)
			: "not a row"

/** The rows of `rows` as texts of `columns` in code-unit order. */
export const textsOf = (
	columns: ReadonlyArray<string>,
	rows: ReadonlyArray<unknown>
): ReadonlyArray<string> => Arr.sort(Arr.map(rows, rowTextOf(columns)), Order.String)

/**
 * The rows of a table of the installation, as texts in code-unit order: the table of its name in the schema of its
 * level, the one whose name extends the installation's (a level is a PostgreSQL schema of its own).
 */
const tableTexts = (
	admin: PgConnection,
	schemaName: string,
	table: string,
	columns: ReadonlyArray<string>
) =>
	Effect.gen(function* () {
		const found = yield* admin.query(
			"SELECT table_schema::text AS s FROM information_schema.tables WHERE table_name = $1 AND table_schema LIKE $2",
			[table, `${schemaName}%`]
		)
		const at = quoteIdent(String(found.rows[0]?.["s"]))
		const result = yield* admin.query(
			`SELECT ${Arr.join(
				Arr.map(columns, (c) => quoteIdent(c)),
				", "
			)} FROM ${at}.${quoteIdent(table)}`,
			[]
		)
		return textsOf(columns, result.rows)
	})

/** What the writes leave in the tables they write. */
export const writtenOf = (admin: PgConnection, schemaName: string) =>
	Effect.all({
		moments: tableTexts(admin, schemaName, "test_moment", ["child", "stage"]),
		suspensions: tableTexts(admin, schemaName, "test_suspension", ["child", "stage", "k"]),
		scored: tableTexts(admin, schemaName, "scored", ["child", "n", "scorer", "score"]),
		graded: tableTexts(admin, schemaName, "graded", ["child", "n"]),
		visits: tableTexts(admin, schemaName, "test_visit", ["child", "stage", "k"]),
		stages: tableTexts(admin, schemaName, "stage", ["child", "key"])
	})
