/** What the property of call-writes.test.ts reads: its schema, its ChangeSet, its space and its oracle. */

import { array, element, type Gen, int, map, oneOf, type Steered } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Option, Order, String as Str } from "effect"
import { isRecord } from "#compiler/core/record.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { Fn } from "#compiler/public/compute.ts"
import { int4 } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { derived, fn, relation, rows, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { type Generated, generatedTemplate } from "#test/support/install-migrate.ts"
import type { PgConnection } from "#test/support/pg.ts"
import type { SubstrateTemplate } from "#test/support/substrate/substrate.ts"
import { fullWorld } from "#test/support/worlds.ts"

/**
 * Writes from a query that calls a declared function, in one stratum, guarded by a derived relation: the shape of
 * GRADING-SQL's answerItem, which inserts an Attempt and its rows from one call of qti.process only where the item's
 * session is open.
 *
 * The base holds Session(session, shift), each session's program Line(session, pos, txt), and what a grading writes,
 * Attempt(session) and Value(session, pos, out). Over it, Open is the derived relation of the sessions no Attempt
 * holds, Program the derived relation of the lines, which the query that builds a call's program reads, as
 * GRADING-SQL's QtiViews are read, and `grade` the function of a session's lines and its shift, each line's pos plus
 * the shift and its text upper-cased. The ChangeSet `answer` of a session inserts, in one stratum, its Attempt and its Values from `graded`,
 * the rows of grade's call at the session's lines and shift, read only where Open holds the session: both members read
 * the one call, which the statement holds once.
 */

/** Any text. */
const Text = str.regex("^.*$", "su")

const Session = relation("Session", { session: int4, shift: int4 }, ["session"])

const Line = relation("Line", { session: int4, pos: int4, txt: Text }, ["session", "pos"])

const Attempt = relation("Attempt", { session: int4 }, ["session"])

const Value = relation("Value", { session: int4, pos: int4, out: Text }, ["session", "pos"])

const Lines = rows({ pos: int4, txt: Text })

const Graded = rows({ out: Text, pos: int4 })

const grade = fn("grade", {
	calls: [],
	args: { program: Lines, shift: int4 },
	returns: Graded,
	volatility: "immutable",
	nullInput: "called",
	language: "plpgsql",
	body: fn.body`\nBEGIN\n  RETURN QUERY SELECT upper(p.txt), p.pos + shift FROM unnest(program) AS p;\nEND\n`
})

/** The schema of a case under `name`: the base, and the level of Open and grade over it. */
const gradingSchema = (name: string) => {
	const base = schema(name, [Session, Line, Attempt, Value], [])
	const Open = derived(
		"Open",
		query(base).rule((r) => {
			const { session, shift } = v(Session, "session")
			return r
				.match(Session, { session, shift })
				.where(r.not(Attempt, { session }))
				.find({ session, shift })
		})
	)
	const Program = derived(
		"Program",
		query(base).rule((r) => {
			const { session, pos, txt } = v(Line, "line")
			return r.match(Line, { session, pos, txt }).find({ session, pos, txt })
		})
	)
	const level = schema.extend([base], `${name}_g`, [Open, Program, grade], [])
	return { level, Open, Program }
}

/** The programs of a schema of `name`: `answer`, the guarded writes of one call, beside reads of what they wrote. */
export const programsOf = (name: string) => {
	const { level, Open, Program } = gradingSchema(name)
	const linesOf = query(level).rule((r) => {
		const { pos, txt } = v(Program, "line")
		return r.match(Program, { session: r.param("session", int4), pos, txt }).find({ pos, txt })
	})
	const graded = query(level).rule((r) => {
		const { session, shift } = v(Open, "open")
		const run = Fn.rows(grade, { program: linesOf.bind({ session }), shift })
		const { pos, out } = v(run, "run")
		return r
			.match(Open, { session, shift })
			.where(r.eq(session, r.param("session", int4)))
			.match(run, { pos, out })
			.find({ session, pos, out })
	})
	return {
		answer: ChangeSet.empty(level)
			.insert(
				Attempt,
				query(level).rule((r) => {
					const one = graded.bind({ session: r.param("session", int4) })
					const { session } = v(one, "graded")
					return r.match(one, { session }).find({ session })
				})
			)
			.insert(
				Value,
				query(level).rule((r) => {
					const one = graded.bind({ session: r.param("session", int4) })
					const { session, pos, out } = v(one, "graded")
					return r.match(one, { session, pos, out }).find({ session, pos, out })
				})
			)
	}
}

/** The installation of the case's schema as a template, which every case clones. */
export const gradingTemplate: SubstrateTemplate<Generated> = generatedTemplate({
	declaredIn: import.meta,
	name: "call_writes",
	content: { programs: ["answer"] },
	build: (name) => {
		const { level } = gradingSchema(name)
		return { schema: level, logins: [fullWorld(level, programsOf(name), []).server] }
	},
	ambient: ordinarySession
})

/** The served world of a case over its installation's declared name. */
export const worldOf = (declared: string) =>
	fullWorld(gradingSchema(declared).level, programsOf(declared), [])

interface LineFact {
	readonly session: number
	readonly pos: number
	readonly txt: string
}

export interface GradingCase {
	readonly sessions: ReadonlyArray<{ readonly session: number; readonly shift: number }>
	readonly lines: ReadonlyArray<LineFact>
	/** The sessions an earlier attempt closed. */
	readonly closed: ReadonlyArray<number>
	/** The session the case answers, which may be none of its sessions. */
	readonly answered: number
}

const sessions = [1, 2, 3] as const

const caseGen: Gen<GradingCase> = (source) => {
	const held = Arr.filter(sessions, () => source.draw(element([true, false] as const)))
	return {
		sessions: Arr.map(held, (session) => ({ session, shift: source.draw(int(-2, 2)) })),
		lines: Arr.flatMap(held, (session) =>
			Arr.map(Arr.dedupe(source.draw(array(int(0, 5), { min: 0, max: 4 }))), (pos) => ({
				session,
				pos,
				txt: source.draw(element(["a", "b", "ab"] as const))
			}))
		),
		closed: Arr.filter(held, () => source.draw(element([true, false] as const))),
		answered: source.draw(element([1, 2, 3, 4] as const))
	}
}

export type GradingFeature =
	| "an open session graded"
	| "a closed session left unwritten"
	| "no such session"
	| "an open session of no line"
	| "values of several lines"

/** The session a steered case answers: the drawn one where it is a session, session 1 where it answers none. */
const answeredOf = (c: GradingCase): number =>
	Arr.contains(sessions, c.answered) ? c.answered : Arr.headNonEmpty(sessions)

/** The case answering the session `answered`, held (at shift 0 where it holds no row of it) and closed by no Attempt. */
const openAt = (c: GradingCase, answered: number): GradingCase => ({
	...c,
	sessions: Arr.some(c.sessions, (s) => s.session === answered)
		? c.sessions
		: Arr.append(c.sessions, { session: answered, shift: 0 }),
	closed: Arr.filter(c.closed, (s) => s !== answered),
	answered
})

/**
 * A case answering an open session of several lines (openAt): its lines, with lines at positions 0 and 1 beside them
 * where it holds none there. A drawn case meets this too rarely: it must hold the answered session, leave it open and
 * draw two lines of it, each by a draw of its own.
 */
const openOfSeveralLines = (c: GradingCase): GradingCase => {
	const answered = answeredOf(c)
	const own = Arr.filter(c.lines, (l) => l.session === answered)
	const added = Arr.map(
		Arr.filter([0, 1], (pos) => !Arr.some(own, (l) => l.pos === pos)),
		(pos): LineFact => ({ session: answered, pos, txt: "ab" })
	)
	return { ...openAt(c, answered), lines: Arr.appendAll(c.lines, added) }
}

/** A case answering an open session of no line (openAt): every line of the answered session left out. */
const openOfNoLine = (c: GradingCase): GradingCase => {
	const answered = answeredOf(c)
	return { ...openAt(c, answered), lines: Arr.filter(c.lines, (l) => l.session !== answered) }
}

/** The rare situations a steered case is aimed at, each with the case it makes of a drawn one. */
const aims: ReadonlyArray<readonly [GradingFeature, (c: GradingCase) => GradingCase]> = [
	["values of several lines", openOfSeveralLines],
	["an open session of no line", openOfNoLine]
]

/**
 * The cases a witness checks: drawn ones (caseGen), or, while a rare situation is pending (Pending `names`: values of
 * several lines, an open session of no line), as many again of the drawn one aimed at each pending one (aims), so
 * each witness the steered phase draws may reach it. Unsteered (the rotating stream), a plain draw.
 */
export const steeredGrading: Steered<GradingCase, GradingFeature>["under"] = (steering) => {
	const arms = Arr.flatMap(aims, ([feature, aimed]) =>
		Option.exists(steering, (pending) => pending.names(feature)) ? [map(caseGen, aimed)] : []
	)
	return Arr.isReadonlyArrayNonEmpty(arms) ? oneOf([caseGen, ...arms]) : caseGen
}

/** The features a case reaches by its draw. */
export const drawnFeatures = (c: GradingCase): ReadonlyArray<GradingFeature> => {
	const held = Arr.some(c.sessions, (s) => s.session === c.answered)
	const closed = Arr.contains(c.closed, c.answered)
	const lines = Arr.filter(c.lines, (l) => l.session === c.answered).length
	return [
		...(!held ? (["no such session"] as const) : []),
		...(held && closed ? (["a closed session left unwritten"] as const) : []),
		...(held && !closed && lines > 0 ? (["an open session graded"] as const) : []),
		...(held && !closed && lines === 0 ? (["an open session of no line"] as const) : []),
		...(held && !closed && lines > 1 ? (["values of several lines"] as const) : [])
	]
}

/** A case's facts, as the installation loads them: its sessions, their lines, and the closed sessions' Attempts. */
export const factsOf = (c: GradingCase) => ({
	Session: Arr.map(c.sessions, (s) => ({ session: s.session, shift: s.shift })),
	Line: Arr.map(c.lines, (l) => ({ session: l.session, pos: l.pos, txt: l.txt })),
	Attempt: Arr.map(c.closed, (session) => ({ session })),
	Value: []
})

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

/** The rows of a table of the installation, as texts in code-unit order. */
const tableTexts = (
	admin: PgConnection,
	schemaName: string,
	table: string,
	columns: ReadonlyArray<string>
) =>
	Effect.map(
		admin.query(
			`SELECT ${Arr.join(
				Arr.map(columns, (c) => quoteIdent(c)),
				", "
			)} FROM ${quoteIdent(schemaName)}.${quoteIdent(table)}`,
			[]
		),
		(result) => Arr.sort(Arr.map(result.rows, rowTextOf(columns)), Order.String)
	)

/** What a grading's writes leave in Attempt and Value. */
export const writtenOf = (admin: PgConnection, schemaName: string) =>
	Effect.all({
		attempts: tableTexts(admin, schemaName, "attempt", ["session"]),
		values: tableTexts(admin, schemaName, "value", ["session", "pos", "out"])
	})

/**
 * What PostgreSQL's own call gives the answered session, the oracle: where the session is open, its Attempt where grade
 * returns a row, and grade's rows at the session's lines and shift, called by the owner directly, beside the Attempts
 * the case loaded; where it is closed or no session, those Attempts alone and no Value.
 */
export const expectedOf = (admin: PgConnection, schemaName: string, c: GradingCase) =>
	Effect.gen(function* () {
		const s = quoteIdent(schemaName)
		const typed = yield* admin.query(
			"SELECT pg_catalog.format_type(p.proargtypes[0], NULL) AS t FROM pg_catalog.pg_proc AS p JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace WHERE p.proname = 'grade' AND n.nspname LIKE $1",
			[`${schemaName}%`]
		)
		const arrayType = String(typed.rows[0]?.["t"])
		const rowType = Str.slice(0, -2)(arrayType)
		const fnSchema = yield* admin.query(
			"SELECT n.nspname::text AS s FROM pg_catalog.pg_proc AS p JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace WHERE p.proname = 'grade' AND n.nspname LIKE $1",
			[`${schemaName}%`]
		)
		const g = quoteIdent(String(fnSchema.rows[0]?.["s"]))
		const open =
			Arr.some(c.sessions, (x) => x.session === c.answered) && !Arr.contains(c.closed, c.answered)
		const graded = open
			? (yield* admin.query(
					`SELECT ${c.answered}::integer AS "session", r."pos", r."out" FROM ${s}."session" AS x CROSS JOIN LATERAL ${g}."grade"(ARRAY(SELECT ROW(l."pos", l."txt")::${rowType} FROM ${s}."line" AS l WHERE l."session" = x."session"), x."shift") AS r WHERE x."session" = $1`,
					[c.answered]
				)).rows
			: []
		const values = Arr.sort(Arr.map(graded, rowTextOf(["session", "pos", "out"])), Order.String)
		const attempts = Arr.sort(
			Arr.map([...c.closed, ...(graded.length > 0 ? [c.answered] : [])], (session) =>
				String(session)
			),
			Order.String
		)
		return { attempts, values }
	})
