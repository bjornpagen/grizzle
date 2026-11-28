/**
 * The family swarm's oracle (test/pg/write/swarm/families.test.ts), independent of grizzle's writer:
 *
 * - the stored rows are the reference writer's (test/support/families/fill.ts `writtenRows`), each family's extra end
 *   folded here directly from its members (max of their `v`, or of their sets `b`), and each plain relation's rows
 *   the ChangeSet's facts applied in stratum order, a query's rows read from the state its stratum starts from;
 * - which writes are lawful, and which laws refuse the others, is the law model's (test/support/laws/model.ts): every
 *   law the schema states between its relations, judged on the reference's rows, an immediate one at the end of each
 *   stratum, every one at the end; a family's own law (each member's owner present) is judged here, and breaks the
 *   family's law with every copy, fold and end along it; two facts at one key are that key's;
 * - a refill grizzle cannot draw is refused as the reference states (fill.ts `writesVerdict`): StaleDerivedRead for an
 *   immutable relation's rows, or for a put whose rows a query states;
 * - a stratum refused with UnorderableStratum names a cycle each of whose orders the stratum's writes require: the
 *   phases of one relation's statements, an immediate key between two relations (a foreign key the installation
 *   installs NOT DEFERRABLE, `immediateKeysOf`), or a family's count between its owner's and its member's statements
 *   (`justified`).
 */
import { defined } from "@bjornpagen/testing/assert"
import { Array as Arr, Option, Record as Rec } from "effect"
import type { LawId } from "#compiler/core/ids.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"
import type { Statement } from "#compiler/public/schema.ts"
import {
	type FillSpec,
	type FollowUp,
	followUpMembers,
	followUpRows,
	groupName,
	type InstanceRow,
	keyOfRelation,
	relationName,
	type SpecWrite,
	uuidOfRow,
	writesVerdict,
	writtenRows
} from "#test/support/families/fill.ts"
import {
	everyFact,
	type HostFact,
	type HostLaw,
	type HostSchema,
	type HostState,
	violations
} from "#test/support/laws/model.ts"
import {
	type BuiltSwarm,
	callerFields,
	copyName,
	countName,
	endName,
	familyOf,
	fieldNames,
	holderOf,
	maskUnion,
	maxIdentity,
	namedIdName,
	namedValueName,
	nestedOnly,
	type PlainRow,
	plainName,
	samePlain,
	swarmFacts,
	type SwarmSpec
} from "#test/support/pg/write/swarm/spec.ts"
import type { StateRow } from "#test/support/substrate/state.ts"

/** Where a plain write runs: in a stratum before the family stratum, in it, or after it (ChangeSet.sequence). */
export type Placed = "before" | "with" | "after"

/** A plain write: an insert, a put (a referrer's) or a delete of one row, in a stratum. */
export interface PlainOp {
	readonly op: "insert" | "put" | "delete"
	readonly row: PlainRow
	readonly at: Placed
}

/** A pure set's insert of every `v` family relation `relation` holds, from a query over the state its stratum reads. */
export interface QueryInsert {
	readonly relation: number
	readonly plain: number
	readonly at: Placed
}

/** How a ChangeSet states its facts: one member per fact, and every fact stated twice. */
export interface Shape {
	readonly split: boolean
	readonly repeat: boolean
}

/**
 * One ChangeSet of a case:
 * - `insert`: an instance's rows, top facts with their sequences nested, beside plain writes; `conflict` states one
 *   top fact a second time at its key with `v` one more, `orphan` names a counted member whose first counted family's
 *   owner it names no row of;
 * - `follow`: a follow-up over the stored rows (fill.ts `followUpGen`), beside plain writes and a query's insert;
 * - `query put`: a put of a relation no family has as a member, its rows a relation parameter's, from a query;
 * - `delete all`: a delete of every stored row, by `by` (DeleteAllForm).
 */
export type Step =
	| {
			readonly kind: "insert"
			readonly rows: ReadonlyArray<InstanceRow>
			readonly plain: ReadonlyArray<PlainOp>
			readonly conflict: number | undefined
			readonly orphan: number | undefined
			readonly shape: Shape
	  }
	| {
			readonly kind: "follow"
			readonly followUp: FollowUp | undefined
			readonly plain: ReadonlyArray<PlainOp>
			readonly query: QueryInsert | undefined
			readonly shape: Shape
	  }
	| {
			readonly kind: "query put"
			readonly relation: number
			readonly rows: ReadonlyArray<{ readonly id: number; readonly v: bigint }>
			readonly plain: ReadonlyArray<PlainOp>
	  }
	| { readonly kind: "delete all"; readonly by: DeleteAllForm }

/**
 * How a delete of everything states its rows, each relation holding a stored row named (deletedAll): `rows`, each such
 * relation's stored rows, a family's members' among them, as arrays; `selection`, each such relation no ordered or
 * counted family has as a member, every row of it by an empty field-equality selection (ChangeSet.deleteWhere), whose
 * whole delete removes every row nested under it through every family, as pantry's replace deletes a package's rows.
 */
export type DeleteAllForm = "rows" | "selection"

/** A case: a drawn schema and its ChangeSets, applied in order from the empty state. */
export interface SwarmCase {
	readonly spec: SwarmSpec
	readonly steps: ReadonlyArray<Step>
}

/** The stored state: the family core's rows as the reference writer's instance, and the plain rows. */
export interface State {
	readonly rows: ReadonlyArray<InstanceRow>
	readonly plain: ReadonlyArray<PlainRow>
}

export const nothingStored: State = { rows: [], plain: [] }

/** The law ids of an installed schema's statements and primary keys (test/support/kernel/naming.ts). */
export interface Laws {
	readonly of: (statement: Statement) => LawId
	readonly primaryKey: (relation: string) => LawId
}

/** A family relation's membership of family `f`: its owner and its slot, none when it is no member of `f`. */
const membership = (row: InstanceRow, f: number) =>
	Option.getOrUndefined(Arr.findFirst(row.memberOf, (m) => m.family === f))

/**
 * Every stored row of the core and the plain relations, by relation name: the reference writer's rows, each with its
 * set `b`, its extra ends and the columns it names a member's row by (spec.ts namedFacts), and each plain row as its
 * relation stores it. A member whose owner is absent, which no write stores, holds the reference's values with that
 * membership left out (ownedRows).
 */
export const storedRows = (
	spec: SwarmSpec,
	state: State
): ReadonlyMap<string, ReadonlyArray<StateRow>> => {
	const written = writtenRows(spec.fill, ownedRows(state.rows))
	const membersOf = (owner: number, f: number): ReadonlyArray<InstanceRow> =>
		Arr.filter(state.rows, (row) => membership(row, f)?.owner === owner)
	const out = new Map<string, Array<StateRow>>()
	for (const [r] of spec.fill.relations.entries()) {
		out.set(relationName(r), [])
	}
	for (const [j] of spec.plains.entries()) {
		out.set(plainName(j), [])
	}
	for (const row of state.rows) {
		const fields: Record<string, StateRow[string]> = {
			...written.get(row.id),
			...swarmFacts(spec, state.rows, row.relation, row.id)
		}
		for (const end of spec.ends) {
			if (familyOf(spec, end.family).owner !== row.relation) {
				continue
			}
			const members = membersOf(row.id, end.family)
			fields[endName(end.family)] =
				end.monoid === "max"
					? Arr.reduce(members, maxIdentity, (most, m) => (m.v > most ? m.v : most))
					: maskUnion(Arr.map(members, (m) => m.id))
		}
		out.get(relationName(row.relation))?.push(fields)
	}
	for (const row of state.plain) {
		out
			.get(plainName(row.plain))
			?.push(
				row.kind === "set" ? { x: row.x } : { id: uuidOfRow(row.id), r: uuidOfRow(row.r), x: row.x }
			)
	}
	return out
}

/** The host schema of a spec (model.ts): its relations by their primary keys, and its laws by their law ids. */
export const hostSchema = (spec: SwarmSpec, built: BuiltSwarm, laws: Laws): HostSchema => {
	const relations = [
		...Arr.map(spec.fill.relations, (r, i) => ({
			name: relationName(i),
			table: relationName(i),
			fields: Arr.map(fieldNames(spec, { kind: "core", r: i }), (name) => ({ name, column: name })),
			key: keyOfRelation(spec.fill, i),
			serial: [],
			mutable: r.mutable
		})),
		...Arr.map(spec.plains, (p, j) => ({
			name: plainName(j),
			table: plainName(j),
			fields: Arr.map(fieldNames(spec, { kind: "plain", j }), (name) => ({ name, column: name })),
			key: p.kind === "set" ? ["x"] : ["id"],
			serial: [],
			mutable: p.mutable
		}))
	]
	const side = (relation: string, fields: ReadonlyArray<string>) => ({
		relation,
		fields,
		selection: everyFact
	})
	const stated = Arr.map(spec.laws, (law, i): HostLaw => {
		const id = laws.of(defined(built.laws[i], "a law's statement"))
		switch (law.kind) {
			case "into set":
				return {
					kind: "contained",
					law: id,
					source: side(relationName(law.relation), ["v"]),
					target: side(plainName(law.plain), ["x"])
				}
			case "into rows":
				return {
					kind: "contained",
					law: id,
					source: side(plainName(law.plain), ["r"]),
					target: side(relationName(law.relation), ["id"])
				}
			case "into members": {
				const family = familyOf(spec, law.family)
				return {
					kind: "contained",
					law: id,
					source: side(plainName(law.plain), ["r", "x"]),
					target: side(relationName(family.member), [groupName(law.family), "v"])
				}
			}
			case "owner into members": {
				const family = familyOf(spec, law.family)
				const count = countName(law.family)
				return {
					kind: "contained",
					law: id,
					source: {
						relation: relationName(family.owner),
						fields: ["id", "v"],
						selection: law.selected
							? { kind: "where", holds: (f) => f[count] === 1, pinned: {} }
							: everyFact
					},
					target: side(relationName(family.member), [groupName(law.family), "v"])
				}
			}
			case "member key": {
				const family = familyOf(spec, law.family)
				return {
					kind: "key",
					law: id,
					relation: relationName(family.member),
					fields: [groupName(law.family), "v"],
					selection: everyFact
				}
			}
			case "selected": {
				const copy = defined(spec.fill.copies[law.copy], "a selected copy")
				const name = copyName(law.copy)
				return {
					kind: "contained",
					law: id,
					source: {
						relation: relationName(holderOf(spec.fill, copy)),
						fields: ["v"],
						selection: { kind: "where", holds: (f) => numberAt(f, name) > 0, pinned: {} }
					},
					target: side(plainName(law.plain), ["x"])
				}
			}
			case "check": {
				const family = law.family
				return {
					kind: "check",
					law: id,
					relation: relationName(law.relation),
					holds: (f) =>
						family === undefined
							? numberAt(f, "v") > -3
							: numberAt(f, countName(family)) < 3 || numberAt(f, "v") >= 0
				}
			}
			case "into member rows":
				return {
					kind: "contained",
					law: id,
					source: side(relationName(law.relation), [
						groupName(law.family),
						namedIdName(law.family),
						namedValueName(law.family)
					]),
					target: side(relationName(familyOf(spec, law.family).member), [
						groupName(law.family),
						"id",
						"v"
					])
				}
		}
	})
	const keys = Arr.map(relations, (r): HostLaw => ({
		kind: "key",
		law: laws.primaryKey(r.name),
		relation: r.name,
		fields: r.key,
		selection: everyFact
	}))
	return { relations, laws: [...keys, ...stated] }
}

/** A host fact's number at a field: a defect of the oracle where it holds none. */
const numberAt = (fact: HostFact, field: string): number => {
	const x = fact[field]
	if (typeof x !== "number") {
		throw new Error(`a host fact without the number ${field}`)
	}
	return x
}

/**
 * The host state of a state's stored rows (storedRows): every number a host number, every uuid its text, sets and ends
 * left out, and a member whose owner is absent its group field naming the absent owner.
 */
const hostState = (spec: SwarmSpec, state: State): HostState => {
	const stored = storedRows(spec, state)
	const held = new Set(Arr.map(state.rows, (row) => row.id))
	const groups = new Map(
		Arr.map(state.rows, (row) => [
			uuidOfRow(row.id),
			Rec.fromEntries(
				Arr.flatMap(row.memberOf, (m) =>
					held.has(m.owner) ? [] : [[groupName(m.family), uuidOfRow(m.owner)] as const]
				)
			)
		])
	)
	return new Map(
		Arr.map([...stored.entries()], ([name, rows]) => [
			name,
			Arr.map(rows, (row): HostFact => {
				const fact: Record<string, number | string> = {}
				for (const [field, value] of Rec.toEntries(row)) {
					if (typeof value === "bigint") {
						fact[field] = Number(value)
					}
					if (typeof value === "string") {
						fact[field] = value
					}
				}
				const id = fact["id"]
				return { ...fact, ...(typeof id === "string" ? groups.get(id) : undefined) }
			})
		])
	)
}

/** A state's rows with every membership whose owner it holds no row of left out: the rows the reference can write. */
export const ownedRows = (rows: ReadonlyArray<InstanceRow>): ReadonlyArray<InstanceRow> => {
	const ids = new Set(Arr.map(rows, (r) => r.id))
	return Arr.map(rows, (row) => ({
		...row,
		memberOf: Arr.filter(row.memberOf, (m) => ids.has(m.owner))
	}))
}

/** The laws of family `f` a member whose owner is absent breaks: the family's, and every copy, fold and end along it. */
const familyLaws = (
	spec: SwarmSpec,
	built: BuiltSwarm,
	laws: Laws,
	f: number
): ReadonlyArray<LawId> => [
	laws.of(defined(built.families[f], "a family's statement")),
	...Option.toArray(Option.map(Option.fromNullishOr(built.folds.get(f)), laws.of)),
	...Option.toArray(Option.map(Option.fromNullishOr(built.ends.get(f)), laws.of)),
	...Arr.flatMap(spec.fill.copies, (c, j) =>
		c.family === f ? [laws.of(defined(built.copies[j], "a copy's statement"))] : []
	)
]

/** A plain state after plain writes, in order: a delete removes its fact, a referrer's put its occupant, an insert adds. */
const plainAfter = (
	plain: ReadonlyArray<PlainRow>,
	ops: ReadonlyArray<PlainOp>
): ReadonlyArray<PlainRow> => {
	const deleted = Arr.filter(ops, (o) => o.op === "delete")
	const put = Arr.filter(ops, (o) => o.op === "put")
	const added = Arr.filter(ops, (o) => o.op !== "delete")
	const kept = Arr.filter(
		plain,
		(row) =>
			!Arr.some(deleted, (o) => samePlain(o.row, row)) &&
			!Arr.some(
				put,
				(o) =>
					o.row.plain === row.plain &&
					o.row.kind === "referrer" &&
					row.kind === "referrer" &&
					o.row.id === row.id
			)
	)
	return Arr.reduce(added, kept, (rows, o) =>
		Arr.some(rows, (r) => samePlain(r, o.row)) ? rows : [...rows, o.row]
	)
}

/** The plain rows a query's insert adds, read from `state`: each `v` of its relation's rows, once. */
const queried = (state: State, q: QueryInsert): ReadonlyArray<PlainOp> =>
	Arr.map(
		Arr.dedupe(Arr.flatMap(state.rows, (row) => (row.relation === q.relation ? [row.v] : []))),
		(x): PlainOp => ({ op: "insert", row: { kind: "set", plain: q.plain, x }, at: q.at })
	)

/** The rows a delete-all leaves, and what a step does to the core's rows, by kind. */
const rowsAfter = (spec: SwarmSpec, state: State, step: Step): ReadonlyArray<InstanceRow> => {
	switch (step.kind) {
		case "insert":
			return [...state.rows, ...orphaned(spec, step)]
		case "follow":
			return step.followUp === undefined ? state.rows : followUpRows(state.rows, step.followUp)
		case "query put":
			return Arr.map(state.rows, (row) => {
				const put = Arr.findFirst(
					step.rows,
					(p) => p.id === row.id && row.relation === step.relation
				)
				return Option.isSome(put) ? { ...row, v: put.value.v } : row
			})
		case "delete all":
			return []
	}
}

/** An absent row's id, which an orphan's membership names. */
export const absentId = 4095

/** An insert step's rows, its orphan's first counted membership naming the absent row. */
export const orphaned = (
	spec: SwarmSpec,
	step: Extract<Step, { readonly kind: "insert" }>
): ReadonlyArray<InstanceRow> =>
	Arr.map(step.rows, (row) => {
		if (row.id !== step.orphan) {
			return row
		}
		const first = Arr.findFirstIndex(
			row.memberOf,
			(m) => familyOf(spec, m.family).kind === "counted"
		)
		return Option.match(first, {
			onNone: () => row,
			onSome: (at) => ({
				...row,
				memberOf: Arr.map(row.memberOf, (m, i) => (i === at ? { ...m, owner: absentId } : m))
			})
		})
	})

/**
 * The relations a delete of everything names in its stratum: each holding a stored row, by `rows` every one, by
 * `selection` each no ordered or counted family has as a member (DeleteAllForm). A relation holding none is not named.
 */
export const deletedAll = (
	spec: SwarmSpec,
	state: State,
	by: DeleteAllForm
): ReadonlyArray<number> =>
	Arr.filter(
		Arr.map(spec.fill.relations, (_, r) => r),
		(r) =>
			Arr.some(state.rows, (x) => x.relation === r) &&
			(by === "rows" || !Arr.some(spec.fill.families, (f) => f.member === r && f.kind !== "tree"))
	)

/** Whether family `f` is relation `r`'s own tree, whose nodes are `r`'s rows. */
const ownTree = (f: FillSpec["families"][number], r: number): boolean =>
	f.kind === "tree" && f.owner === r && f.member === r

/**
 * Whether a stratum deleting `deleted` is refused when the ChangeSet compiles because it leaves a family's groups
 * partial, as the README's Writing a family states it: a delete of a relation that owns a family and is no other
 * family's member removes its rows and every row nested under them, through every family, to any depth, and "a delete
 * whose nested rows include a member of a family whose owner it does not remove" is refused. Its whole deletes are
 * judged together: a relation nested under them is a member of a family one of them or a relation nested under them
 * owns, and the stratum leaves partial the groups of any other family such a relation is a member of. Which rows are
 * stored is the call's, so the refusal is the ChangeSet's whatever the stored groups hold.
 */
const leavesGroupsPartial = (fill: FillSpec, deleted: ReadonlyArray<number>): boolean => {
	const roots = Arr.filter(
		deleted,
		(r) =>
			Arr.some(fill.families, (f) => f.owner === r) &&
			Arr.every(fill.families, (f) => f.member !== r || ownTree(f, r))
	)
	const nested: Array<number> = [...roots]
	for (const owner of nested) {
		for (const f of fill.families) {
			if (f.owner === owner && !ownTree(f, f.member) && !nested.includes(f.member)) {
				nested.push(f.member)
			}
		}
	}
	return Arr.some(nested, (r) =>
		Arr.some(fill.families, (f) => f.member === r && !ownTree(f, r) && !nested.includes(f.owner))
	)
}

/** The plain writes of a step, in stratum `at`, its query's rows read from `reads`. */
const plainIn = (step: Step, at: Placed, reads: State): ReadonlyArray<PlainOp> => {
	if (step.kind === "delete all") {
		return []
	}
	const own = Arr.filter(step.plain, (o) => o.at === at)
	const q = step.kind === "follow" ? step.query : undefined
	return q?.at === at ? [...queried(reads, q), ...own] : own
}

/**
 * The writes of a step's family stratum by relation and kind, as fill.ts `writesVerdict` reads them: none for a delete of
 * everything by selection, whose whole deletes of every top relation leave no stored row holding a value they change,
 * so they refill nothing.
 */
export const familyWrites = (
	spec: SwarmSpec,
	state: State,
	step: Step
): ReadonlyArray<{ readonly relation: number; readonly op: "insert" | "put" | "delete" }> => {
	switch (step.kind) {
		case "insert":
			return Arr.flatMap(
				Arr.map(spec.fill.relations, (_, r) => r),
				(r) =>
					!nestedOnly(spec.fill, r) && Arr.some(step.rows, (x) => x.relation === r)
						? [{ relation: r, op: "insert" as const }]
						: []
			)
		case "follow":
			return step.followUp === undefined
				? []
				: Arr.map(followUpMembers(spec.fill, state.rows, step.followUp), (m) => ({
						relation: m.relation,
						op: m.op
					}))
		case "query put":
			return [{ relation: step.relation, op: "put" }]
		case "delete all":
			switch (step.by) {
				case "rows":
					return Arr.map(Arr.dedupe(Arr.map(state.rows, (r) => r.relation)), (relation) => ({
						relation,
						op: "delete" as const
					}))
				case "selection":
					return []
			}
	}
}

/**
 * What a step must do from a lawful `state`:
 * - `uncompiled`: refused when it compiles, for any cause that applies: StaleDerivedRead where its refills update an
 *   immutable relation's rows (its relation one of `immutable`), where a put the step's ChangeSet states from a query,
 *   a query member whose rows grizzle never sees (changes.ts Built `queryPuts`), leaves a value stale (`query`), where the refills reach a family they refill again (`cycle`), where a value it leaves stale is a
 *   tree's (`tree`, one of `trees`), where one reads what a refill itself changes (`chained`, the refill one of
 *   `refills`), or where a family member's own write reaches a value grizzle refills only from a plain relation's put
 *   (`edit`, the family one of `edits`), each naming one of the writes whose path first reaches a refill (`origins`,
 *   fill.ts writesVerdict); UnsupportedOperation where its refills fall in a
 *   stratum after another (`later`), a refill being planned from one read before the ChangeSet's writes, and where a
 *   delete of everything leaves a family's groups partial (`partial`, leavesGroupsPartial);
 * - `refused`: invariant-rejected, naming only laws of `laws`, where two facts share a key, a family's member names no
 *   owner, an immediate law fails at the end of a stratum, or any law fails at the end;
 * - `written`: accepted, or no-change where nothing stored changes, leaving `next`.
 */
export type StepVerdict =
	| { readonly kind: "written"; readonly next: State; readonly changed: boolean }
	| { readonly kind: "refused"; readonly laws: ReadonlySet<LawId> }
	| {
			readonly kind: "uncompiled"
			readonly immutable: ReadonlyArray<string>
			readonly query: boolean
			readonly cycle: boolean
			readonly trees: ReadonlyArray<number>
			readonly refills: ReadonlyArray<number>
			readonly edits: ReadonlyArray<number>
			readonly later: boolean
			readonly partial: boolean
			readonly origins: ReadonlyArray<{
				readonly relation: string
				readonly op: "insert" | "put" | "delete"
			}>
	  }

/** The laws `host` finds broken in `state`, every one or the immediate ones alone. */
const brokenIn = (
	spec: SwarmSpec,
	host: HostSchema,
	state: State,
	immediateOnly: boolean
): ReadonlyArray<LawId> =>
	Arr.flatMap(violations(host, hostState(spec, state)), (v) =>
		!immediateOnly || v.immediate ? [v.law] : []
	)

/**
 * What step `step` must do from `state` (StepVerdict), its ChangeSet putting `queryPuts` by a query member, as the
 * ChangeSet built for it states them (changes.ts Built).
 */
export const expectStep = (
	spec: SwarmSpec,
	built: BuiltSwarm,
	laws: Laws,
	host: HostSchema,
	state: State,
	step: Step,
	queryPuts: ReadonlySet<string>
): StepVerdict => {
	if (step.kind !== "insert") {
		const verdict = writesVerdict(spec.fill, familyWrites(spec, state, step))
		const stale = Arr.isReadonlyArrayNonEmpty(verdict.stale)
		/** The writes that leave a value stale and are puts the ChangeSet states from a query, each once. */
		const queried = Arr.dedupeWith(
			Arr.flatMap(verdict.stale, (st): ReadonlyArray<SpecWrite> =>
				st.origin.op === "put" && queryPuts.has(relationName(st.origin.relation)) ? [st.origin] : []
			),
			(a: SpecWrite, b: SpecWrite) => a.relation === b.relation && a.op === b.op
		)
		const earlier =
			step.kind !== "delete all" &&
			(Arr.some(step.plain, (o) => o.at === "before") ||
				(step.kind === "follow" && step.query?.at === "before"))
		const uncompiled = {
			kind: "uncompiled" as const,
			immutable: verdict.kind === "refused" ? verdict.immutable : [],
			query: Arr.isReadonlyArrayNonEmpty(queried),
			cycle: verdict.kind === "cycle",
			trees: verdict.kind === "tree" ? verdict.trees : [],
			refills: verdict.kind === "chained" ? verdict.refills : [],
			edits: verdict.kind === "edit" ? verdict.families : [],
			later: earlier && stale,
			partial:
				step.kind === "delete all" &&
				leavesGroupsPartial(spec.fill, deletedAll(spec, state, step.by)),
			origins: Arr.map(verdict.kind === "written" ? queried : verdict.origins, (w) => ({
				relation: relationName(w.relation),
				op: w.op
			}))
		}
		if (
			Arr.isReadonlyArrayNonEmpty(uncompiled.immutable) ||
			uncompiled.query ||
			uncompiled.cycle ||
			Arr.isReadonlyArrayNonEmpty(uncompiled.trees) ||
			Arr.isReadonlyArrayNonEmpty(uncompiled.refills) ||
			Arr.isReadonlyArrayNonEmpty(uncompiled.edits) ||
			uncompiled.later ||
			uncompiled.partial
		) {
			return uncompiled
		}
	}
	const s1: State = {
		rows: state.rows,
		plain: plainAfter(state.plain, plainIn(step, "before", state))
	}
	const rows = rowsAfter(spec, state, step)
	const s2: State = {
		rows,
		plain: step.kind === "delete all" ? [] : plainAfter(s1.plain, plainIn(step, "with", s1))
	}
	const s3: State = { rows, plain: plainAfter(s2.plain, plainIn(step, "after", s2)) }
	const ids = new Set(Arr.map(rows, (r) => r.id))
	const orphans = Arr.dedupe(
		Arr.flatMap(rows, (row) =>
			Arr.flatMap(row.memberOf, (m) => (ids.has(m.owner) ? [] : [m.family]))
		)
	)
	const conflict =
		step.kind === "insert" && step.conflict !== undefined
			? Arr.flatMap(
					Arr.findFirst(step.rows, (r) => r.id === step.conflict).pipe(Option.toArray),
					(r) => [laws.primaryKey(relationName(r.relation))]
				)
			: []
	const broken = new Set<LawId>([
		...conflict,
		...Arr.flatMap(orphans, (f) => familyLaws(spec, built, laws, f)),
		...brokenIn(spec, host, s1, true),
		...brokenIn(spec, host, s2, true),
		...brokenIn(spec, host, s3, false)
	])
	if (broken.size > 0) {
		return { kind: "refused", laws: broken }
	}
	return { kind: "written", next: s3, changed: !sameStored(spec, state, s3) }
}

/** Whether two states store the same rows. */
const sameStored = (spec: SwarmSpec, a: State, b: State): boolean => {
	const x = storedRows(spec, a)
	const y = storedRows(spec, b)
	return Arr.every([...x.entries()], ([name, rows]) => {
		const other = y.get(name) ?? []
		return (
			rows.length === other.length &&
			Arr.every(rows, (row) => Arr.some(other, (o) => sameRow(row, o)))
		)
	})
}

const sameRow = (a: StateRow, b: StateRow): boolean => {
	const keys = Rec.keys(a)
	return (
		keys.length === Rec.keys(b).length &&
		Arr.every(keys, (k) => {
			const x = a[k]
			const y = b[k]
			return x instanceof Set && y instanceof Set
				? x.size === y.size && Arr.every([...x], (h) => y.has(h))
				: x === y
		})
	)
}

/** One write of a stratum as UnorderableStratum names it. */
export interface StratumWrite {
	readonly relation: string
	readonly op: "insert" | "put" | "delete" | "update" | "count"
}

/**
 * An immediate key from `from` into `to`, by what it reads of `from`: its caller's fields alone (callerColumns), which
 * only a put of `from` changes in place, or columns grizzle draws (a group, a copy, a count, a selected side's law
 * column), which any family statement may change.
 */
export interface ImmediateKey {
	readonly from: string
	readonly to: string
	readonly reads: "caller" | "drawn"
}

/**
 * The fields a caller states of each relation, by name, and only a put of it changes: a plain relation's every field,
 * and a family relation's caller fields (spec.ts callerFields).
 */
const callerColumns = (spec: SwarmSpec): ReadonlyMap<string, ReadonlyArray<string>> =>
	new Map([
		...Arr.map(
			spec.fill.relations,
			(_, r) => [relationName(r), Rec.keys(callerFields(spec, r))] as const
		),
		...Arr.map(
			spec.plains,
			(_, j) => [plainName(j), fieldNames(spec, { kind: "plain", j })] as const
		)
	])

/**
 * The immediate keys between relations, each `from` referencing `to`: every foreign key between two relations the
 * installation installs NOT DEFERRABLE, as the compile defers its keys and no second statement of that rule here can
 * disagree with it: a family axis its family defers (a counted predecessor and every last axis, an owner axis a cascade
 * feeds or a refill writes around), every key on a cycle of the keys that order a write's statements, and every key into
 * a target it does not reference whole are deferred, and so absent (README "Deferred foreign keys"). A key reads its
 * source's caller fields alone where each column it references from is one of them, and drawn columns otherwise.
 */
export const immediateKeysOf = (
	spec: SwarmSpec,
	installation: Installation
): ReadonlyArray<ImmediateKey> => {
	const caller = callerColumns(spec)
	return Arr.flatMap(installation.laws.natives, ({ object }): ReadonlyArray<ImmediateKey> => {
		if (
			object.kind !== "ForeignKey" ||
			object.deferrable ||
			object.relation.name === object.target.name
		) {
			return []
		}
		const fields = caller.get(object.relation.name) ?? []
		return [
			{
				from: object.relation.name,
				to: object.target.name,
				reads: Arr.every(object.columns, (c) => c.kind === "field" && fields.includes(c.field.name))
					? "caller"
					: "drawn"
			}
		]
	})
}

/**
 * Whether the stratum's writes require `a` before `b`, by the oracle's own statement of a stratum's order:
 * - one relation's statements in any order: an action runs before its relation's family statements, which run its
 *   deletions, refills, updates and insertions in turn, so either of two statements of one relation may come first;
 * - along an immediate key from a referencing to a referenced relation, the referenced relation's additions and
 *   changes run before the referencing one's, and the referencing one's removals and changes before the referenced
 *   one's removals and changes, where the change is at a column the key reads: a key over caller fields meets an
 *   update in place only of a relation the step puts (`puts`), a key over drawn columns every update and count;
 * - a family's count of its owner, or a refill of its owner that carries its counts (an update), runs after its
 *   member's and its owner's deletions, puts and updates, before its owner's insertions, and before its member's
 *   insertions where its owner axis is immediate;
 * - a member's update or put (a refill among them) runs before an update, a put or a count of its owner, or of an
 *   owner its owner's families lead up to: members first, ahead of the change that would cascade into them.
 */
export const justified = (
	spec: SwarmSpec,
	keys: ReadonlyArray<ImmediateKey>,
	puts: ReadonlySet<string>,
	a: StratumWrite,
	b: StratumWrite
): boolean => {
	if (a.relation === b.relation) {
		return true
	}
	const changes = (k: ImmediateKey, o: StratumWrite): boolean =>
		o.op === "insert" ||
		o.op === "delete" ||
		o.op === "put" ||
		(k.reads === "drawn" ? true : puts.has(o.relation) && o.op === "update")
	const adds = (k: ImmediateKey, o: StratumWrite) => o.op !== "delete" && changes(k, o)
	const removes = (k: ImmediateKey, o: StratumWrite) => o.op !== "insert" && changes(k, o)
	const keyed = Arr.some(
		keys,
		(k) =>
			(k.to === a.relation && k.from === b.relation && adds(k, a) && adds(k, b)) ||
			(k.from === a.relation && k.to === b.relation && removes(k, a) && removes(k, b))
	)
	if (keyed) {
		return true
	}
	const counts = (o: StratumWrite) => o.op === "count" || o.op === "update"
	const counted = Arr.some(spec.fill.families, (f) => {
		const owner = relationName(f.owner)
		const member = relationName(f.member)
		const immediate = Arr.some(keys, (k) => k.from === member && k.to === owner)
		const changes = (o: StratumWrite) =>
			(o.relation === owner || o.relation === member) &&
			(o.op === "delete" || o.op === "put" || o.op === "update")
		return (
			(b.relation === owner && counts(b) && changes(a)) ||
			(a.relation === owner &&
				counts(a) &&
				((b.relation === owner && b.op === "insert") ||
					(immediate && b.relation === member && b.op === "insert")))
		)
	})
	if (counted) {
		return true
	}
	const above = new Set<string>()
	const pending = [a.relation]
	for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
		for (const f of spec.fill.families) {
			const owner = relationName(f.owner)
			if (relationName(f.member) === at && owner !== at && !above.has(owner)) {
				above.add(owner)
				pending.push(owner)
			}
		}
	}
	return (
		(a.op === "update" || a.op === "put") &&
		above.has(b.relation) &&
		(b.op === "update" || b.op === "put" || b.op === "count")
	)
}
