import { defined } from "@bjornpagen/grizzle-text/base/invariant"
/**
 * The bound of the pg_stat_statements entries one call of a served program makes (docs/reads-and-writes.md "A call's planned queries are
 * bounded"): every statement the call sends, by the user it runs as, and every query PostgreSQL plans behind them, which the
 * installation's planned queries record (physical/planned/graph.ts PlannedGraph) and a walk from the call's own
 * statements reaches: the functions they call, the views and policies they read, the domains they cast to, the
 * triggers, referential actions and row checks of the relations they write, and so on from each of those.
 *
 * pg_stat_statements keys an entry by its user, its database, its query id and whether it ran at the top level
 * (REL_19_0 contrib/pg_stat_statements pgssHashKey, `toplevel`), and records one at its first planning, execution or
 * normalized parse in a backend. So a call's entries are, on a session's first call, as a Db sends them
 * (adapter wire/batch.ts, apply/stand-up.ts, wire/pool.ts):
 *
 * - its session's read of its reap window, as the login's own user, the session's (served/forms.ts ServedSession);
 * - BEGIN, the ledger's fence and the exclusion's LOCK, as the login, before its prologue enters the role; the prologue's
 *   statement, planned as the login and run as the role it enters (deploy/ledger/ledger.ts enterQuery); COMMIT, as the
 *   role, and ROLLBACK, as the login, which a failed attempt sends; a stand-up's transaction sends the same texts; and a
 *   refused write's diagnosis (adapter apply/run.ts diagnosedWitness), its statements again, its witness query and the
 *   ROLLBACK that ends it, both as the role;
 * - each statement it can send as the role: a write's stand-ups' calls, each of its statements in every form one call
 *   can send (`statementTexts`), and each read-back sent behind them; a read's one statement;
 * - every query the walk reaches from those statements: a definer function's as the installation's owner, an invoker's
 *   as its caller, a trigger's and a referential action's as the owner, each at the top level where it fires at COMMIT.
 *
 * It is an upper bound: two queries the graph names apart may be one query id, and it counts every branch a body may
 * take, a refusal's among them. A call that reaches an application's declared function, whose body grizzle never reads,
 * has no bound (`declared`).
 */
import type { NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import { compareStrings } from "#compiler/core/order.ts"
import type {
	PlannedGraph,
	PlannedReach,
	PlannedReachKey,
	PlannedTrigger
} from "#compiler/physical/planned/graph.ts"
import type { ServedStatement } from "#compiler/runtime/write/flight.ts"
import type { SqlStatement } from "#compiler/sql/ast.ts"
import { type Reach, ReachOf, type WriteEvent } from "#compiler/sql/reach.ts"
import type { ServableWrite } from "#compiler/write/program/served.ts"

/**
 * The users a call's entries run as: the login's own, its session user (`login`); the role its prologue enters (`role`);
 * the installation's owner, every definer function's, table's and referential action's (`owner`).
 */
export const plannedUsers = ["login", "role", "owner"] as const

/** A user a call's entries run as (plannedUsers). */
export type PlannedUser = (typeof plannedUsers)[number]

/** A count of entries at the top level, as pg_stat_statements' `toplevel` keys them, and below it. */
export interface Levels {
	readonly top: number
	readonly nested: number
}

/**
 * The bound of one call's pg_stat_statements entries: `bounded`, the entries it can make at most (`queries`), and that
 * many by the user each runs as and its level (`by`), as pg_stat_statements keys them; or `declared`, where it reaches an
 * application's declared functions, by their printed names, whose bodies' queries grizzle cannot count.
 */
export type PlannedQueries =
	| {
			readonly kind: "bounded"
			readonly queries: number
			readonly by: { readonly [U in PlannedUser]: Levels }
	  }
	| { readonly kind: "declared"; readonly functions: NonEmptyReadonlyArray<string> }

/**
 * One call as the bound reads it: its frame, a read's or a write's, the write's exclusion LOCK where it locks; the texts
 * its own statements can send at most past the frame; and what those statements reach.
 */
export interface PlannedCall {
	readonly frame: { readonly kind: "read" } | { readonly kind: "write"; readonly locks: boolean }
	readonly texts: number
	readonly reach: Reach
}

/**
 * The top-level entries a call's frame makes as the login (see the header): the reap window's read, BEGIN, the fence,
 * the prologue's planning and ROLLBACK, and a write's exclusion LOCK where it locks; and as the role, the prologue's run
 * and COMMIT, and a write's refusal's diagnosis query and the ROLLBACK that ends its flight.
 */
const frameEntries = (
	frame: PlannedCall["frame"]
): { readonly login: number; readonly role: number } => {
	switch (frame.kind) {
		case "read":
			return { login: 5, role: 2 }
		case "write":
			return { login: 5 + (frame.locks ? 1 : 0), role: 4 }
	}
}

/**
 * The forms a single statement's parts can send in one call: its parts' every subset at most, and, where its facts are
 * cut into batched executions (runtime/write/bind.ts batchCuts), one form an interval of its member slots holds facts
 * of, the intervals of m slots a cut walks in order being 2m - 1 at most; one where it has no member slot.
 */
const partedTexts = (
	form: Extract<ServedStatement, { readonly kind: "parted" }>["form"]
): number => {
	const parts = form.units.filter((u) => u.kind === "part").length
	const members = new Set(
		form.units.flatMap((u) => u.params.flatMap((p) => (p.kind === "member" ? [p.slot] : [])))
	).size
	return Math.min(2 ** parts, Math.max(1, 2 * members - 1))
}

/** The texts one call can send of `statement`: a whole statement's one text; a single statement's forms (`partedTexts`). */
const statementTexts = (statement: ServedStatement): number => {
	switch (statement.kind) {
		case "whole":
			return 1
		case "parted":
			return partedTexts(statement.form)
	}
}

/** One call of a served write (see the header): its stand-ups, its statements and its read-backs sent behind them. */
export const writeCall = (write: ServableWrite): PlannedCall => ({
	frame: { kind: "write", locks: write.exclusion.kind === "lock" },
	texts:
		write.standUps.length +
		write.statements.reduce((sum, s) => sum + statementTexts(s), 0) +
		write.readBacks.filter((r) => r.carried.kind === "sent").length,
	reach: write.reach
})

/**
 * One call of a served read whose statements are `statements`, each form of each (a paged read's bound and page
 * statements among them), of which a call sends `texts` at most.
 */
export const readCall = (statements: ReadonlyArray<SqlStatement>, texts: number): PlannedCall => {
	const reach = new ReachOf()
	for (const s of statements) {
		reach.statement(s)
	}
	return { frame: { kind: "read" }, texts, reach: reach.reach() }
}

/** Whether `trigger` fires for a write's `event`: its event's, and an update of a column it names, if it names any. */
const fires = (trigger: PlannedTrigger, event: WriteEvent): boolean => {
	if (trigger.event !== event.kind) {
		return false
	}
	return (
		event.kind !== "update" ||
		trigger.columns.length === 0 ||
		event.columns.some((c) => trigger.columns.includes(c))
	)
}

/** A reach of the call's own statements, as the graph's walk reads one. */
const plannedOf = (r: Reach): PlannedReach => ({
	queries: [],
	raises: [],
	calls: [...r.calls],
	reads: [...r.relations],
	types: [...r.types],
	writes: r.writes
})

/**
 * The walk of the graph from a call's statements: each query it reaches, as pg_stat_statements keys its entry, by its
 * user, its level and its number in the graph, the queries of each user and level apart; and each declared function it
 * calls. Each reach is walked once for each user and level it runs at.
 */
class Walk {
	readonly entries: {
		readonly [U in PlannedUser]: { readonly top: Set<number>; readonly nested: Set<number> }
	} = {
		login: { top: new Set(), nested: new Set() },
		role: { top: new Set(), nested: new Set() },
		owner: { top: new Set(), nested: new Set() }
	}
	/** Each RAISE reached, by the user and level it runs at: one of them at most runs in a call. */
	readonly raises: {
		readonly [U in PlannedUser]: {
			readonly top: Array<ReadonlyArray<number>>
			readonly nested: Array<ReadonlyArray<number>>
		}
	} = {
		login: { top: [], nested: [] },
		role: { top: [], nested: [] },
		owner: { top: [], nested: [] }
	}
	readonly declared = new Set<string>()
	readonly #graph: PlannedGraph
	/** Each reach walked, by its key or, for a call's own statements', itself, with each user and level it ran at. */
	readonly #walked = new Map<PlannedReach | PlannedReachKey, Set<string>>()

	constructor(graph: PlannedGraph) {
		this.#graph = graph
	}

	/** The reach of `key` in the graph's table of reaches (PlannedGraph `reaches`), walked as `reach` walks it. */
	keyed(key: PlannedReachKey, user: PlannedUser, top: boolean): void {
		this.reach(
			defined(this.#graph.reaches[key], `the planned reach ${key} the graph's table holds`),
			user,
			top,
			key
		)
	}

	/**
	 * `reach`, its own queries run as `user` at the top level where `top`, everything they reach below it, once for each
	 * user and level, by `by`, its key in the graph, or itself.
	 */
	reach(
		reach: PlannedReach,
		user: PlannedUser,
		top: boolean,
		by: PlannedReach | PlannedReachKey
	): void {
		const at = `${user} ${String(top)}`
		const walked = this.#walked.get(by) ?? new Set<string>()
		if (walked.has(at)) {
			return
		}
		walked.add(at)
		this.#walked.set(by, walked)
		const level = top ? "top" : "nested"
		const entries = this.entries[user][level]
		for (const query of reach.queries) {
			entries.add(query)
		}
		for (const raise of reach.raises) {
			this.raises[user][level].push(raise)
		}
		for (const name of reach.calls) {
			this.call(name, user)
		}
		for (const name of reach.reads) {
			const relation = this.#graph.relations[name]
			if (relation !== undefined) {
				this.keyed(relation.read, user, false)
			}
		}
		for (const name of reach.types) {
			const domain = this.#graph.domains[name]
			if (domain !== undefined) {
				this.keyed(domain, user, false)
			}
		}
		for (const write of reach.writes) {
			this.write(write.relation, write.event, user)
		}
	}

	/** A call of the function `name` by `caller`: none where the installation installs no such function, a builtin's. */
	call(name: string, caller: PlannedUser): void {
		const fn = this.#graph.functions[name]
		if (fn === undefined) {
			return
		}
		switch (fn.kind) {
			case "declared":
				this.declared.add(name)
				return
			case "definer":
				return this.keyed(fn.reach, "owner", false)
			case "invoker":
				return this.keyed(fn.reach, caller, false)
		}
	}

	/** A write of `relation` at `event` by `writer`: its rows' checks as the writer, its triggers as the owner. */
	write(relation: string, event: WriteEvent, writer: PlannedUser): void {
		const planned = this.#graph.relations[relation]
		if (planned === undefined) {
			return
		}
		if (event.kind === "insert" || event.kind === "update") {
			this.keyed(planned.row, writer, false)
		}
		for (const trigger of planned.triggers) {
			if (fires(trigger, event)) {
				this.keyed(trigger.reach, "owner", trigger.fires === "deferred")
			}
		}
	}
}

/**
 * The bound of one call's entries (see the header) under the installation's planned queries `graph`, whose Db's
 * prologue statement is `prologue` (deploy/ledger/ledger.ts enterQuery), the call `call`.
 */
export const plannedQueries = (
	graph: PlannedGraph,
	prologue: SqlStatement,
	call: PlannedCall
): PlannedQueries => {
	const walk = new Walk(graph)
	const prologueReach = plannedOf(new ReachOf().statement(prologue).reach())
	const callReach = plannedOf(call.reach)
	walk.reach(prologueReach, "role", false, prologueReach)
	walk.reach(callReach, "role", false, callReach)
	const [first, ...rest] = [...walk.declared].toSorted(compareStrings)
	if (first !== undefined) {
		return { kind: "declared", functions: [first, ...rest] }
	}
	const frame = frameEntries(call.frame)
	/** The entries of `user` at `level`: every query reached there, and the most new ones one RAISE reached there plans. */
	const reached = (user: PlannedUser, level: "top" | "nested"): number => {
		const entries = walk.entries[user][level]
		return (
			entries.size +
			walk.raises[user][level].reduce(
				(most, raise) => Math.max(most, raise.filter((q) => !entries.has(q)).length),
				0
			)
		)
	}
	const by = {
		login: { top: frame.login + reached("login", "top"), nested: reached("login", "nested") },
		role: {
			top: frame.role + call.texts + reached("role", "top"),
			nested: reached("role", "nested")
		},
		owner: { top: reached("owner", "top"), nested: reached("owner", "nested") }
	}
	return {
		kind: "bounded",
		queries: plannedUsers.reduce((sum, u) => sum + by[u].top + by[u].nested, 0),
		by
	}
}
