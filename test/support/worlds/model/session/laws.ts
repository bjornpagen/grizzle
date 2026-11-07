import { Array as Arr, Option, Record as Rec } from "effect"
import {
	type HostLaw,
	type HostSchema,
	type HostState,
	relationOf,
	type Violation,
	violations,
	witnessOf
} from "#test/support/laws/model.ts"
import { holdsWhole } from "#test/support/worlds/model/session/state.ts"
import type { HostFact, RoleSpec, SqlState, Witness } from "#test/support/worlds/model/types.ts"

/**
 * How PostgreSQL meets a broken law, for every writer: at the statement that breaks it or at COMMIT, and with which
 * SQLSTATE. A key is a PRIMARY KEY or UNIQUE constraint (23505), a span key one WITHOUT OVERLAPS (23P01), a row check a
 * CHECK (23514), all at the statement. A containment is a foreign key (23503), a selected source's over its law
 * columns, deferred exactly when a lawful ChangeSet could break it in passing: its target has a field outside the
 * referenced ones, or it lies on a cycle of foreign keys; a containment into a selected target is deferred too, and one
 * into a closed roster is a row CHECK. A coverage is a PERIOD foreign key, from a selected source's range law column
 * where it has one, always deferred. Every law is native (fin.md §7): nothing raises 23000.
 */
export interface LawMeeting {
	readonly sqlstate: SqlState
	readonly at: "statement" | "commit"
}

/** Whether a containment's foreign key lies on a cycle of plain foreign keys: its target reaches its source. */
const onCycle = (
	host: HostSchema,
	law: Extract<HostLaw, { readonly kind: "contained" }>
): boolean => {
	const edges = Arr.flatMap(host.laws, (l) =>
		l.kind === "contained" ? [{ from: l.source.relation, to: l.target.relation }] : []
	)
	const seen = new Set<string>([law.target.relation])
	const frontier = [law.target.relation]
	for (let at = frontier.pop(); at !== undefined; at = frontier.pop()) {
		if (at === law.source.relation) {
			return true
		}
		for (const e of edges) {
			if (e.from === at && !seen.has(e.to)) {
				seen.add(e.to)
				frontier.push(e.to)
			}
		}
	}
	return false
}

export const meetingOf = (host: HostSchema, law: HostLaw): LawMeeting => {
	switch (law.kind) {
		case "key":
			return { sqlstate: "23505", at: "statement" }
		case "spanKey":
			return { sqlstate: "23P01", at: "statement" }
		case "check":
			return { sqlstate: "23514", at: "statement" }
		case "contained": {
			const target = relationOf(host, law.target.relation)
			const deferred =
				law.target.selection.kind === "where" ||
				Arr.some(target.fields, (f) => !law.target.fields.includes(f.name)) ||
				onCycle(host, law)
			return { sqlstate: "23503", at: deferred ? "commit" : "statement" }
		}
		case "covered":
			return { sqlstate: "23503", at: "commit" }
	}
}

const lawNamed = (host: HostSchema, violation: Violation): HostLaw | undefined =>
	Option.getOrUndefined(Arr.findFirst(host.laws, (l) => l.law === violation.law))

/** The broken laws PostgreSQL meets at `at`, each with its meeting. */
export const brokenAt = (
	host: HostSchema,
	state: HostState,
	at: LawMeeting["at"]
): ReadonlyArray<Refusal> =>
	Arr.flatMap(violations(host, state), (violation) => {
		const law = lawNamed(host, violation)
		if (law === undefined) {
			return []
		}
		const meeting = meetingOf(host, law)
		return meeting.at === at ? [{ violation, meeting }] : []
	})

/** A broken law as PostgreSQL meets it. */
export interface Refusal {
	readonly violation: Violation
	readonly meeting: LawMeeting
}

/**
 * The laws a statement's result breaks that PostgreSQL meets at the statement, in the order it meets them as the row
 * enters: a row CHECK, then a unique index or exclusion constraint, then, at the end of the statement, an immediate
 * foreign key. Several broken objects of one stage may report in either order, so each is one of the refusals allowed.
 */
export const statementRefusals = (host: HostSchema, after: HostState): ReadonlyArray<Refusal> => {
	const broken = brokenAt(host, after, "statement")
	const stage = (states: ReadonlyArray<SqlState>): ReadonlyArray<Refusal> =>
		Arr.filter(broken, (b) => states.includes(b.meeting.sqlstate))
	const checks = stage(["23514"])
	if (checks.length > 0) {
		return checks
	}
	const uniques = stage(["23505", "23P01"])
	return uniques.length > 0 ? uniques : stage(["23503"])
}

/** The laws COMMIT may fail on: a deferred foreign key, whichever fires first. */
export const commitRefusals = (host: HostSchema, view: HostState): ReadonlyArray<Refusal> =>
	brokenAt(host, view, "commit")

/** A fact a ChangeSet submitted, by the base relation it writes. */
export interface Submitted {
	readonly relation: string
	readonly fact: HostFact
	/** Each target field the caller wrote, by the name it wrote it under: a query entry's head field, else its own. */
	readonly terms: Readonly<Record<string, string>>
}

const pick = (fact: HostFact, fields: ReadonlyArray<string>): HostFact =>
	Rec.fromEntries(
		Arr.flatMap(fields, (f) => {
			const value = fact[f]
			return value === undefined ? [] : [[f, value] as const]
		})
	)

/**
 * The most a refusal's witness may show (README "Errors and outcomes"): the key values of the violating facts, never a payload
 * column; of those, only the keys the caller submitted, in the fields it wrote them in, and the keys of relations its
 * role holds whole. A row check's names its facts by their relation's primary key, as the host judges the facts a
 * ChangeSet states; a containment or coverage PostgreSQL reports only in prose shows none. The observed witness may
 * show fewer.
 */
export const witnessFor = (
	host: HostSchema,
	role: RoleSpec,
	violation: Violation,
	submitted: ReadonlyArray<Submitted>
): Witness => {
	const law = lawNamed(host, violation)
	const witnessed = law === undefined ? undefined : witnessOf(law, host)
	if (witnessed === undefined || witnessed.kind === "unnamed") {
		return { kind: "withheld" }
	}
	const wholeViolators = Arr.filter(violation.violators, (v) => holdsWhole(role, v.relation))
	const held = Arr.map(wholeViolators, (v) => v.values)
	const atWitness = Arr.filter(submitted, (s) => s.relation === witnessed.relation)
	const own = Arr.flatMap(atWitness, (s) => {
		const keyed = pick(s.fact, witnessed.key)
		const written = Arr.flatMap(Rec.toEntries(s.terms), ([field, name]) => {
			const value = keyed[field]
			return value === undefined ? [] : [[name, value] as const]
		})
		return [keyed, Rec.fromEntries(written)]
	})
	const keys = [...held, ...own]
	return keys.length === 0 ? { kind: "withheld" } : { kind: "shown", keys }
}
