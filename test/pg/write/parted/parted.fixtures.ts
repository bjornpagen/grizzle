/** What the property of parted.test.ts reads: its schema and template, its box, and each run's call. */

import { defined } from "@bjornpagen/testing/assert"
import { element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Order, Record as Rec, String as Str } from "effect"
import type { LoadedChange } from "#adapter/served/load.ts"
import { conversionOf } from "#compiler/core/identity.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { contained, on, relation, schema, select } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { oneForm } from "#compiler/runtime/lower/forms.ts"
import type { FlightStatement, FlightWrite } from "#compiler/runtime/write/flight.ts"
import { fixtureTemplate } from "#test/pg/reads/support.ts"
import { Id } from "#test/support/ids.ts"
import type { PgConnection, SqlError } from "#test/support/pg.ts"

/** A sidecar's fields: a header's variable and its value, keyed by the header and the variable. */
const sidecarFields = Object.freeze({
	id: Id,
	variable: str.regex("^[a-z]{1,8}$"),
	value: pg.integer
})

/** The box's relations: a header H; three sidecars S1, S2, S3 from the relation parameters p1, p2, p3; and G, the
 * values p1 or p2 names, from a union of one rule over each. */
const H = relation("H", { id: Id }, ["id"])
export const S1 = relation("S1", sidecarFields, ["id", "variable"])
export const S2 = relation("S2", sidecarFields, ["id", "variable"])
export const S3 = relation("S3", sidecarFields, ["id", "variable"])
export const G = relation("G", sidecarFields, ["id", "variable"])

/**
 * The box's schema: each sidecar's and G's nonnegative values lie in a header, a whole rule the judge reads at COMMIT
 * over the sidecar's delta (README, Rules over queries), so each insert of one fires its capture, which stands up the
 * delta, and arms the judge.
 */
export const Lab = schema(
	"PartedLab",
	[H, S1, S2, S3, G],
	Arr.map([S1, S2, S3, G], (S) =>
		contained(
			on(
				select(S, (s) => s.ge(s.value, 0)),
				"id"
			),
			on(H, "id")
		)
	)
)

/** The box's relations, empty, as a case loads them. */
export const noFacts = Object.freeze({ H: [], S1: [], S2: [], S3: [], G: [] })

/** The relation parameters, each the sidecar it fills. */
const sidecars = { p1: S1, p2: S2, p3: S3 } as const

type Param = keyof typeof sidecars

/**
 * A case: how many facts each parameter holds, none to two; whether a read-back of S1's added facts rides the
 * statement; and whether p2's facts name a header the call does not write, which the judge refuses at COMMIT.
 */
export interface Box {
	readonly facts: Readonly<Record<Param, 0 | 1 | 2>>
	readonly rider: boolean
	readonly orphan: boolean
}

const counts = [0, 1, 2] as const

export const boxGen: Gen<Box> = (source) => ({
	facts: {
		p1: source.draw(element(counts)),
		p2: source.draw(element(counts)),
		p3: source.draw(element(counts))
	},
	rider: source.draw(element([false, true] as const)),
	orphan: source.draw(element([false, true] as const))
})

/** A sidecar's insert from its parameter, each fact it states. */
const fromParam = (param: Param) =>
	query(Lab).rule((r) => {
		const given = r.relation(param, sidecarFields)
		const { id, variable, value } = v(given, "given")
		return r.match(given, { id, variable, value }).find({ id, variable, value })
	})

/** The box's write: H's one fact, each sidecar from its parameter, G from p1 and p2, and, for a rider, a read-back of
 * S1's added facts. A ChangeSet over the box runs against its installation, whose content it is (reads/support.ts
 * Opened `schema`). */
export const changesOf = (rider: boolean) => {
	const writes = ChangeSet.empty(Lab)
		.insert(
			H,
			query(Lab).rule((r) => r.find({ id: r.param("id", H.fields.id) }))
		)
		.insert(S1, fromParam("p1"))
		.insert(S2, fromParam("p2"))
		.insert(S3, fromParam("p3"))
		.insert(
			G,
			query(Lab)
				.rule((r) => {
					const given = r.relation("p1", sidecarFields)
					const { id, variable, value } = v(given, "given")
					return r.match(given, { id, variable, value }).find({ id, variable, value })
				})
				.rule((r) => {
					const given = r.relation("p2", sidecarFields)
					const { id, variable, value } = v(given, "given")
					return r.match(given, { id, variable, value }).find({ id, variable, value })
				})
		)
	return rider
		? writes.read("added", (d) =>
				query(Lab).rule((r) => {
					const { id, variable, value } = v(S1, "added")
					return r.match(d.added(S1), { id, variable, value }).find({ id, variable, value })
				})
			)
		: writes
}

/**
 * What every case installs: the box, its login's workload serving the write each case runs, with its rider and
 * without. An installation installs the domains its artifacts and its served programs type, so a box that serves no
 * program installs no parameter's pattern domain, by design, and a write run against it is refused before it runs
 * (physical names UninstalledDomain, "serve the program from a workload of a login of the installation"): the case's
 * write is one the box serves.
 */
export const labInstall = {
	label: "parted_lab",
	programs: { write: changesOf(false), riderWrite: changesOf(true) }
} as const

/** The box installed once per member (reads/support.ts fixtureTemplate), which each case's own clone holds. */
export const labTemplate = fixtureTemplate(import.meta, Lab, labInstall)

/** A header no case writes, which an orphan's facts name. */
const elsewhere = "00000000-0000-7000-8000-0000000000ff"

/** A call's parameters for the header `header`: each parameter's facts, the variables a and b, p1's under p2's
 * variables c and d so G's two rules give it distinct facts; p2's naming `elsewhere` for an orphan. */
export const paramsOf = (box: Box, header: string): Readonly<Record<string, unknown>> => ({
	id: header,
	...Rec.fromEntries(
		Arr.map(["p1", "p2", "p3"] as const, (param) => [
			param,
			Arr.take(
				[
					{
						id: param === "p2" && box.orphan ? elsewhere : header,
						variable: param === "p1" ? "a" : "c",
						value: 1
					},
					{
						id: param === "p2" && box.orphan ? elsewhere : header,
						variable: param === "p1" ? "b" : "d",
						value: 2
					}
				],
				box.facts[param]
			)
		])
	)
})

/**
 * The oracle's write: `change` with each single statement sent whole whatever its call's inputs give, every unit of
 * its form assembled (runtime/write/parted.ts), as every call sent it before a statement was parted.
 */
export const wholeChange = (change: LoadedChange): LoadedChange => {
	const whole = (statement: FlightStatement): FlightStatement => {
		if (statement.kind === "whole") {
			return statement
		}
		const every = defined(
			statement.form.sentFor(() => true),
			"every unit of the statement"
		)
		return {
			kind: "whole",
			index: statement.index,
			step: statement.step,
			form: every,
			forms:
				statement.forms.kind === "one"
					? oneForm
					: {
							kind: "chosen",
							choices: statement.forms.choices,
							large: defined(
								statement.forms.large.sentFor(() => true),
								"every unit of its large form"
							)
						}
		}
	}
	const program: FlightWrite = {
		...change.entry.program,
		statements: Arr.map(change.entry.program.statements, whole)
	}
	return { ...change, entry: { ...change.entry, program } }
}

/**
 * The relations whose deltas the database's sessions hold, of the box's judged ones, by their delta's table name, which
 * the installation names `__delta_news_` and the relation's name segments (core/identity.ts ruleDelta, conversionOf:
 * S3's s_3), then its digest.
 */
export const heldDeltas = (admin: PgConnection): Effect.Effect<ReadonlyArray<string>, SqlError> =>
	Effect.map(
		admin.query(
			"SELECT c.relname FROM pg_catalog.pg_class c WHERE c.relpersistence = 't' AND c.relname LIKE '\\_\\_delta\\_news\\_%'",
			[]
		),
		(result) =>
			Arr.sort(
				Arr.filter(["S1", "S2", "S3", "G"], (name) =>
					Arr.some(result.rows, (row) =>
						Str.startsWith(`__delta_news_${conversionOf(name)}_`)(String(row["relname"]))
					)
				),
				Order.String
			)
	)
