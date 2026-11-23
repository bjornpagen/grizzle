import { element, type Gen } from "@bjornpagen/testing/gen"
import { keep, type Swarm, swarmChoice } from "@bjornpagen/testing/swarm"
import { Array as Arr, Effect, Record } from "effect"
import type { ApplyOutcome } from "#adapter/types/db.ts"
import type { TransientTag } from "#compiler/core/errors.ts"
import { quoteIdent, quoteString } from "#compiler/core/text.ts"
import {
	type HostFact,
	type HostSchema,
	type HostState,
	isSpan,
	type HostOp,
	relationOf,
	hostSpan,
	type HostValue
} from "#test/support/laws/model.ts"

import { defined } from "@bjornpagen/testing/assert"
import { type ClosedField, closedField, namedText } from "#test/support/closed/stored.ts"
import type { GrizzleSettled, Outcome, Settled, WitnessKey } from "#test/support/history/check.ts"
import type { GrizzleWriter, HistoryRig } from "#test/support/history/families.ts"
import { type Immediacy } from "#test/support/history/model.ts"
import {
	type BelowForm,
	type BelowSpelling,
	belowForms,
	belowLevels,
	type Cell
} from "#test/support/history/refused.ts"
import type { Names } from "#test/support/kernel/naming.ts"
import { type Domains, unorderableCycle } from "#test/support/laws/support.ts"
import type { SqlError } from "#test/support/pg.ts"
import { untilApplied } from "#test/support/schedules/grizzle.ts"

import {
	type PgErrorFields,
	reportedOwnerOf,
	type TransactionRolledBack
} from "#test/support/substrate/errors.ts"
import { replaceRows, tablesGroup } from "#test/support/substrate/replace.ts"
import type { BelowSerializable } from "#test/support/substrate/session.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

import { regex } from "arkregex"
import { refusedEntries } from "#test/support/refused.ts"
/**
 * What a direct writer makes immediate after its last statement, drawn under its swarm: nothing, unless the swarm keeps
 * immediate constraints, and then every constraint.
 */
export const immediacyGen =
	(drawn: Swarm<"immediate">): Gen<Immediacy> =>
	(source) =>
		source.draw(keep(drawn, "immediate")) ? "every constraint" : "deferred"

/**
 * A planted writer's level and statement, as its swarm chose them: a write of a form, reading the relation first when
 * the swarm keeps it, or a read alone. What it names is the resolver's: the relation and fact a history picks, or what
 * a race's threat writes.
 */
export type BelowChoice =
	| { readonly kind: "read only"; readonly level: BelowSerializable }
	| {
			readonly kind: "write"
			readonly level: BelowSerializable
			readonly form: BelowForm
			readonly read: boolean
	  }

/** A planted writer's level, drawn evenly, then its form or a read alone under its swarm. */
export const belowChoiceGen =
	(drawn: Swarm<BelowForm | "read only" | "read first">): Gen<BelowChoice> =>
	(source) => {
		const level = source.draw(element(belowLevels))
		const form = source.draw(swarmChoice(drawn, Arr.append(belowForms, "read only")))
		return form === "read only"
			? { kind: "read only", level }
			: { kind: "write", level, form, read: source.draw(keep(drawn, "read first")) }
	}

/** One installed family schema, with the reads the histories share. */
export interface HistoryEnv {
	readonly host: HostSchema
	readonly domains: Domains
	readonly rig: HistoryRig
	/** The installation's names, through the naming door: tables and constraints' laws. */
	readonly names: Names
}

/** The closed id `relation`'s `field` holds on this installation, whose column stores its handle's code. */
const closedOf = (env: HistoryEnv, relation: string, field: string): ClosedField | undefined =>
	closedField(env.rig.installed.installation, relation, field)

/** A value as a literal at its column: a closed id as its handle's code, which its column stores. */
const literal = (closed: ClosedField | undefined, x: HostValue): string => {
	if (isSpan(x)) {
		return `int4range(${x.start}, ${x.end})`
	}
	if (typeof x !== "string") {
		return String(x)
	}
	return closed === undefined ? quoteString(x) : closed.literal(x)
}

/**
 * A value's host form from its text, by the kind its field's domain draws: an integer, a boolean, a span, or a text.
 */
const hostValue = (sample: HostValue | undefined, text: string): HostValue => {
	if (sample === undefined) {
		throw new Error(`no domain for a value spelled ${text}`)
	}
	if (typeof sample === "number") {
		return Number(text)
	}
	if (typeof sample === "boolean") {
		return text === "true"
	}
	if (isSpan(sample)) {
		const bounds = regex("^\\[(-?[0-9]+),(-?[0-9]+)\\)$").exec(text)
		if (bounds === null) {
			throw new Error(`a span spelled ${text}`)
		}
		return hostSpan(Number(bounds[1]), Number(bounds[2]))
	}
	return text
}

const sampleOf = (env: HistoryEnv, relation: string, field: string): HostValue | undefined =>
	env.domains[relation]?.[field]?.[0]

const tableOf = (env: HistoryEnv, relation: string): string =>
	`${quoteIdent(env.rig.installed.schema)}.${quoteIdent(relationOf(env.host, relation).table)}`

/** A fact's cells in heading order, each value a literal; a fact without a field of its relation is a defect. */
const cellsOf = (
	env: HistoryEnv,
	relation: string,
	fact: HostFact
): Arr.NonEmptyReadonlyArray<Cell> => {
	const [first, ...rest] = Arr.map(relationOf(env.host, relation).fields, (f): Cell => {
		const x = fact[f.name]
		if (x === undefined) {
			throw new Error(`${relation} fact without ${f.name}`)
		}
		return {
			field: f.name,
			column: quoteIdent(f.column),
			value: literal(closedOf(env, relation, f.name), x)
		}
	})
	if (first === undefined) {
		throw new Error(`${relation} has no field`)
	}
	return [first, ...rest]
}

/** How a planted writer's SQL is spelled on this installation. */
export const belowSpelling = (env: HistoryEnv): BelowSpelling => ({
	table: (relation) => tableOf(env, relation),
	cells: (relation, fact) => cellsOf(env, relation, fact)
})

const rowOf = (env: HistoryEnv, relation: string, fact: HostFact): string =>
	`(${Arr.join(
		Arr.map(cellsOf(env, relation, fact), (c) => c.value),
		", "
	)})`

const columnsOf = (env: HistoryEnv, relation: string): string =>
	Arr.join(
		Arr.map(relationOf(env.host, relation).fields, (f) => quoteIdent(f.column)),
		", "
	)

const insertSql = (env: HistoryEnv, relation: string, facts: ReadonlyArray<HostFact>): string =>
	`INSERT INTO ${tableOf(env, relation)} (${columnsOf(env, relation)}) VALUES ${Arr.join(
		Arr.map(facts, (f) => rowOf(env, relation, f)),
		", "
	)}`

/**
 * A direct writer's statements for `ops`, each with the relation it writes: every deletion, then every insertion and
 * put, in order.
 */
export const writeSteps = (
	env: HistoryEnv,
	ops: ReadonlyArray<HostOp>
): ReadonlyArray<{ readonly sql: string; readonly relation: string }> => {
	const deletes = Arr.map(
		Arr.filter(ops, (o) => o.kind === "delete"),
		(o) => ({
			relation: o.relation,
			sql: `DELETE FROM ${tableOf(env, o.relation)} WHERE (${columnsOf(env, o.relation)}) IN (${Arr.join(
				Arr.map(o.facts, (f) => rowOf(env, o.relation, f)),
				", "
			)})`
		})
	)
	const writes = Arr.map(
		Arr.filter(ops, (o) => o.kind !== "delete"),
		(o) => {
			const insert = insertSql(env, o.relation, o.facts)
			if (o.kind === "insert") {
				return { relation: o.relation, sql: insert }
			}
			const r = relationOf(env.host, o.relation)
			const keys = Arr.map(
				Arr.filter(r.fields, (f) => r.key.includes(f.name)),
				(f) => quoteIdent(f.column)
			)
			const payload = Arr.map(
				Arr.filter(r.fields, (f) => !r.key.includes(f.name)),
				(f) => `${quoteIdent(f.column)} = EXCLUDED.${quoteIdent(f.column)}`
			)
			return {
				relation: o.relation,
				sql: `${insert} ON CONFLICT (${Arr.join(keys, ", ")}) DO UPDATE SET ${Arr.join(payload, ", ")}`
			}
		}
	)
	return [...deletes, ...writes]
}

/**
 * Empties every table and loads `state`, as the owner, in one transaction after the tables' rows are deleted
 * (substrate/replace.ts replaceRows): the reset before every interleaving of a history, never a TRUNCATE. No table of
 * a grizzle installation owns a sequence, so a run's physical start is a function of its logical state.
 */
export const load = (
	env: HistoryEnv,
	state: HostState
): Effect.Effect<void, SqlError | TransactionRolledBack, Substrate> =>
	Effect.gen(function* () {
		const s = yield* Substrate
		yield* replaceRows(
			s.admin,
			tablesGroup(Arr.map(env.host.relations, (r) => tableOf(env, r.name))),
			Arr.flatMap(env.host.relations, (r) => {
				const facts = state.get(r.name) ?? []
				return facts.length === 0 ? [] : [{ sql: insertSql(env, r.name, facts), params: [] }]
			})
		)
	})

/**
 * The committed state, read as the owner, each value parsed by the kind its domain draws, a closed id's code read back
 * as the handle it names.
 */
export const read = (env: HistoryEnv): Effect.Effect<HostState, SqlError, Substrate> =>
	Effect.gen(function* () {
		const s = yield* Substrate
		const out = new Map<string, ReadonlyArray<HostFact>>()
		for (const r of env.host.relations) {
			const texts = Arr.map(r.fields, (f) =>
				namedText(env.rig.installed.installation, r.name, f.name)
			)
			const rows = yield* s.admin.queryValues(
				`SELECT ${Arr.join(
					Arr.map(r.fields, (f) => `${quoteIdent(f.column)}::text`),
					", "
				)} FROM ${tableOf(env, r.name)}`,
				[]
			)
			out.set(
				r.name,
				Arr.map(rows, (row) =>
					Record.fromEntries(
						Arr.map(
							r.fields,
							(f, i) =>
								[
									f.name,
									hostValue(
										sampleOf(env, r.name, f.name),
										defined(texts[i], `${r.name}'s reader ${i}`)(String(row[i]))
									)
								] as const
						)
					)
				)
			)
		}
		return out
	})

/** A witness key's values in the host's form: an integer key host value may arrive as a bigint. */
const hostKeys = (keys: ReadonlyArray<WitnessKey>): ReadonlyArray<WitnessKey> =>
	Arr.map(keys, (k) => ({
		relation: k.relation,
		values: Record.fromEntries(
			Arr.map(Record.toEntries(k.values), ([f, x]) => [f, typeof x === "bigint" ? Number(x) : x])
		)
	}))

/**
 * A grizzle operation's answer as a history outcome. A history's writers run as full roles, whose worlds are reality:
 * no fact lies outside them, so an outside-world outcome is a defect.
 */
const grizzleOutcome = (names: Names, o: ApplyOutcome<unknown>): Effect.Effect<Settled> => {
	if (o.kind === "outside-world") {
		return Effect.die(new Error(`a full role's write is outside its world: ${o.relation}`))
	}
	if (o.kind !== "invariant-rejected") {
		return Effect.succeed({ kind: o.kind })
	}
	return Effect.succeed({
		kind: "invariant-rejected",
		laws: Arr.map(refusedEntries(o.refused), names.reported),
		keys: o.witness.kind === "key" ? hostKeys([o.witness]) : []
	})
}

/**
 * A grizzle operation's outcome and the TransientFailure reason each discarded attempt met. grizzle makes one attempt
 * per call; the writer calls again after each TransientFailure until a call answers (untilApplied), as an
 * application does, so a refused attempt committed nothing and takes no place in the order, and the operation's
 * outcome is its answer. Its refusals end with the history's other transactions, so an operation that never answers is
 * its case's hang (caseHang).
 */
export interface GrizzleRun {
	readonly outcome: GrizzleSettled
	readonly transients: ReadonlyArray<TransientTag>
}

/**
 * `writer`'s operation `ops`, run as an application runs a write: its answer, or its ChangeSet refused as it compiled,
 * before any attempt, because no order of its stratum's writes keeps every immediate key; any other failure is a
 * defect.
 */
export const runGrizzle = (
	env: HistoryEnv,
	writer: GrizzleWriter,
	ops: ReadonlyArray<HostOp>
): Effect.Effect<GrizzleRun> =>
	Effect.flatMap(env.rig.writes[writer](ops), (call) => untilApplied(call)).pipe(
		Effect.flatMap((run) =>
			Effect.map(grizzleOutcome(env.names, run.answered), (outcome) => ({
				outcome,
				transients: run.refused
			}))
		),
		Effect.catch((failure) =>
			unorderableCycle(failure) === undefined
				? Effect.die(failure)
				: Effect.succeed<GrizzleRun>({ outcome: { kind: "unorderable" }, transients: [] })
		)
	)

/**
 * What classifying a direct writer's error reads: the installation's names (a constraint's law, through the naming
 * door), the host schema, and a witness key's text in its field's host form.
 */
interface DirectClassifier {
	readonly names: Names
	readonly host: HostSchema
	readonly value: (relation: string, field: string, text: string) => HostValue
}

export const directClassifier = (env: HistoryEnv): DirectClassifier => ({
	names: env.names,
	host: env.host,
	value: (relation, field, text) => hostValue(sampleOf(env, relation, field), text)
})

/**
 * A direct SERIALIZABLE writer's PostgreSQL error as an outcome: 40001 and 40P01 abort it; a native constraint's
 * violation refuses it with the law the constraint reports: a foreign key, a unique key, a row check, a span key's
 * exclusion. Every law is native (fin.md §7), so no 23000 is a law's. Any other error is a defect of the history.
 * PostgreSQL states the violating key only in prose.
 */
export const classifyDirect = (
	env: DirectClassifier,
	fields: PgErrorFields
): Effect.Effect<Outcome> =>
	Effect.sync((): Outcome => {
		const constraint = fields.constraint
		switch (fields.code) {
			case "40001":
				return { kind: "aborted", cause: { kind: "serialization failure" } }
			case "40P01":
				return { kind: "aborted", cause: { kind: "deadlock" } }
			case "23503":
			case "23505":
			case "23514":
			case "23P01": {
				const owner = reportedOwnerOf(fields)
				if (constraint === undefined || owner === undefined) {
					throw new Error(`SQLSTATE ${fields.code} on no constraint and owner: ${fields.message}`)
				}
				return {
					kind: "invariant-rejected",
					laws: env.names.lawsOfConstraint(owner, constraint),
					keys: []
				}
			}
			default:
				throw new Error(`SQLSTATE ${fields.code}: ${fields.message}`)
		}
	})
