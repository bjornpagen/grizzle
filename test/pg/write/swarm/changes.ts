/**
 * The ChangeSets of the family swarm search (test/pg/write/swarm/families.test.ts), built over an installed schema from
 * a case's steps (oracle.ts Step): the facts of an instance's rows, top facts with their sequences nested, a stored
 * row's caller facts, a follow-up's members, plain writes, a query's insert and a put from a query, each stratum a
 * ChangeSet of its own and the strata in sequence. Each ChangeSet is served as an application writes it: the first
 * member of an op and relation is its array member, its facts the call's under that op and relation, and every further
 * one a query member over a relation parameter of its own, its rows the call's parameter, but where the served compile
 * refuses it from a query, a family's member, a sequence's owner inserted, or a counted family's owner its stratum
 * appends to, whose further facts join its array member's; and, for each owner whose facts it so joins, the same
 * strata with that owner's further facts from queries, which the served compile refuses (Queried).
 */
import { defined } from "@bjornpagen/testing/assert"
import { Array as Arr, Option, Record as Rec } from "effect"
import type { ParamMap } from "#compiler/plan/common.ts"
import { query, v } from "#compiler/public/query.ts"
import type { FieldBase } from "#compiler/types/fields/field.ts"
import type { HeadShape } from "#compiler/types/query/terms.ts"
import {
	changeSetOver as ChangeSet,
	type ChangeSetValue,
	type MemberInput
} from "#compiler/write/changeset/value.ts"
import {
	deletedAll,
	familyWrites,
	orphaned,
	ownedRows,
	type PlainOp,
	type Placed,
	type State,
	type Step
} from "#test/pg/write/swarm/oracle.ts"
import {
	followUpMembers,
	followUpRows,
	groupEntries,
	groupName,
	insertedRelations,
	type InstanceRow,
	membershipIn,
	relationName,
	rootEntries,
	uuidOfRow,
	type WrittenRow,
	writtenRows
} from "#test/support/families/fill.ts"
import {
	type BuiltRelation,
	type BuiltSwarm,
	callerFields,
	countName,
	familyOf,
	idOfUuid,
	plainFact,
	plainName,
	swarmFacts,
	type SwarmSpec
} from "#test/support/pg/write/swarm/spec.ts"

/** A fact as a ChangeSet states it. */
type Fact = { readonly [field: string]: unknown }

/**
 * The top facts of an instance's rows by relation: each row no sequence nests, with its caller's fields, its set `b`,
 * the columns it names a member's row by, its counted families' group fields, a tree root's own id as its root field,
 * and each sequence's members nested at its count field in slot order, each nested member its own caller's fields, set,
 * named row's columns and counted group fields. An orphan's group names its absent owner by that owner's uuid
 * (`groupOf`), the reference's rows read with that membership left out (oracle.ts ownedRows), as the oracle stores them.
 */
const topFacts = (
	spec: SwarmSpec,
	rows: ReadonlyArray<InstanceRow>
): ReadonlyMap<number, ReadonlyArray<Fact>> => {
	const written = writtenRows(spec.fill, ownedRows(rows))
	const factOf = (row: InstanceRow, nested: boolean): Fact => {
		const fact: Record<string, unknown> = {
			id: uuidOfRow(row.id),
			v: row.v,
			...swarmFacts(spec, rows, row.relation, row.id)
		}
		for (const m of row.memberOf) {
			if (familyOf(spec, m.family).kind === "counted") {
				for (const [field, value] of groupOf(spec, written, m)) {
					fact[field] = value
				}
			}
		}
		for (const [f, family] of spec.fill.families.entries()) {
			if (family.kind === "tree" && family.member === row.relation && !nested) {
				for (const [name, value] of rootEntries(f, row.id)) {
					fact[name] = value
				}
			}
			if (family.owner !== row.relation || family.kind === "counted") {
				continue
			}
			fact[countName(f)] = Arr.map(
				Arr.sort(
					Arr.filter(rows, (r) => membershipIn(r, f)?.owner === row.id),
					(a: InstanceRow, b: InstanceRow) =>
						(membershipIn(a, f)?.slot ?? 0) < (membershipIn(b, f)?.slot ?? 0) ? -1 : 1
				),
				(member) => factOf(member, true)
			)
		}
		return fact
	}
	const out = new Map<number, Array<Fact>>()
	for (const row of rows) {
		if (Arr.some(row.memberOf, (m) => familyOf(spec, m.family).kind !== "counted")) {
			continue
		}
		const list = out.get(row.relation) ?? []
		list.push(factOf(row, false))
		out.set(row.relation, list)
	}
	return out
}

/**
 * A stored row's caller fact among `rows`, as a delete or a put states it: its `v`, its set, the columns it names a
 * member's row by and its group of every family.
 */
const callerFact = (spec: SwarmSpec, rows: ReadonlyArray<InstanceRow>, row: InstanceRow): Fact => {
	const written = writtenRows(spec.fill, rows)
	return {
		id: uuidOfRow(row.id),
		v: row.v,
		...swarmFacts(spec, rows, row.relation, row.id),
		...Rec.fromEntries(Arr.flatMap(row.memberOf, (m) => groupOf(spec, written, m)))
	}
}

/**
 * A membership's group fields as a fact states them: its owner's key as the reference writer fills it in `written`,
 * or, where `written` holds no row of the owner (an orphan's absent owner, an id-keyed relation's), the owner's uuid.
 */
const groupOf = (
	spec: SwarmSpec,
	written: ReadonlyMap<number, WrittenRow>,
	m: InstanceRow["memberOf"][number]
): ReadonlyArray<readonly [string, string | bigint]> =>
	written.has(m.owner)
		? groupEntries(spec.fill, written, m.family, m.owner)
		: [[groupName(m.family), uuidOfRow(m.owner)]]

/** One member of a ChangeSet: its relation, its operation, and its rows, facts or a query. */
interface Member {
	readonly relation: BuiltRelation
	readonly op: "insert" | "put" | "delete"
	readonly rows:
		| { readonly kind: "facts"; readonly facts: ReadonlyArray<Fact> }
		| {
				readonly kind: "query"
				readonly query: MemberInput
		  }
		| {
				/** A field-equality deletion's selection (ChangeSet.deleteWhere), a delete's alone. */
				readonly kind: "selection"
				readonly fields: Readonly<Record<string, unknown>>
		  }
}

/** A call's facts: under each op of the ChangeSet's array members, each one's facts under its relation's name. */
type CallFacts = Readonly<Record<string, Readonly<Record<string, ReadonlyArray<unknown>>>>>

/**
 * A refusal the served compile names for an owner's write from a query (QueriedOwnerAppend): the write's op, its
 * owner, a counted family the owner owns, by its owner and count, and that family's member, whose rows the write's
 * stratum adds.
 */
interface OwnerAppend {
	readonly op: "insert" | "put"
	readonly owner: string
	readonly family: { readonly owner: string; readonly count: string }
	readonly member: string
}

/**
 * A step's ChangeSet as an application might write it instead, the further facts of one op and owner the served one
 * joins to their array member for their families' appends alone (`ownerAppends`) each a query member of its own: the
 * served compile refuses it, naming one of `refusals`, that op and owner's.
 */
interface Queried {
	readonly changes: ChangeSetValue
	readonly refusals: Arr.NonEmptyReadonlyArray<OwnerAppend>
}

/**
 * A ChangeSet as a served call applies it: the ChangeSet, its call's facts and its parameters, and what the served
 * compile may name refusing each further owner fact it joined to its array member for its families' appends alone, had
 * it written that fact from a query (`ownerAppends`).
 */
interface Served {
	readonly changes: ChangeSetValue
	readonly facts: CallFacts
	readonly params: ParamMap
	readonly appends: ReadonlyArray<OwnerAppend>
	readonly queryPuts: ReadonlySet<string>
}

/**
 * A step's ChangeSet as a served call applies it; the relations it puts by a query member (`queryPuts`), a put from a
 * query's own or a further put of a relation, whose rows grizzle never sees; and for each op and owner whose further
 * facts it joins for their families' appends, the same strata with those facts from queries (`Queried`).
 */
interface Built {
	readonly changes: ChangeSetValue
	readonly facts: CallFacts
	readonly params: ParamMap
	readonly queryPuts: ReadonlySet<string>
	readonly queried: ReadonlyArray<Queried>
}

/** Facts of a member as a ChangeSet states them. */
const factsOf = (facts: ReadonlyArray<Fact>): Member["rows"] => ({ kind: "facts", facts })

/**
 * The relations whose rows `m` adds: an insert's own and every member its sequences nest under it, to any depth (the
 * served compile's write/frontend/compile.ts insertedBy), each counted family of such a member appended to as its own
 * insert would; a put's own, which inserts a row its key finds none at; a delete's none.
 */
const addedBy = (spec: SwarmSpec, m: Member): ReadonlySet<string> => {
	switch (m.op) {
		case "insert": {
			const added = new Set([m.relation.name])
			for (const at of added) {
				for (const f of spec.fill.families) {
					if (f.kind !== "counted" && relationName(f.owner) === at) {
						added.add(relationName(f.member))
					}
				}
			}
			return added
		}
		case "put":
			return new Set([m.relation.name])
		case "delete":
			return new Set()
	}
}

/**
 * Whether the served compile refuses `m` from a query for its own families (UnsupportedOperation): any write of a
 * family's member, whose family values grizzle draws from the call's rows on the host, and an insert of a sequence's
 * or a tree's owner, whose members it writes nested in order under it.
 */
const familyOnly = (spec: SwarmSpec, m: Member): boolean =>
	Arr.some(
		spec.fill.families,
		(f) =>
			relationName(f.member) === m.relation.name ||
			(m.op === "insert" && f.kind !== "counted" && relationName(f.owner) === m.relation.name)
	)

/**
 * What the served compile may name refusing `m`, a member of the stratum `stratum`, from a query (QueriedOwnerAppend,
 * write/frontend/compile.ts refuseQueriedOwnerAppend): an insert or a put of a counted family's owner whose stratum adds
 * rows of the family's member (`addedBy`), its own write of the member or one nested under another relation's insert,
 * each such family; an inserted owner holds its final count and ends in its own row, which grizzle fills only from the
 * facts the ChangeSet states. None for any other member.
 */
const ownerAppends = (
	spec: SwarmSpec,
	m: Member,
	stratum: ReadonlyArray<Member>
): ReadonlyArray<OwnerAppend> => {
	const op = m.op
	if (op === "delete") {
		return []
	}
	return Arr.flatMap(spec.fill.families, (f, k): ReadonlyArray<OwnerAppend> => {
		const member = relationName(f.member)
		return f.kind === "counted" &&
			relationName(f.owner) === m.relation.name &&
			Arr.some(stratum, (s) => addedBy(spec, s).has(member))
			? [
					{
						op,
						owner: m.relation.name,
						family: { owner: m.relation.name, count: countName(k) },
						member
					}
				]
			: []
	})
}

/**
 * Strata of members as one served ChangeSet over `value`, the strata in sequence, with its call's facts and parameters
 * beside `params`. The first member of an op and relation is its array member, its facts the call's under that op and
 * relation. Every further one is a query member over a relation parameter of its own, `rows<k>` in order, whose rows
 * the call gives as that parameter, each of the relation's fields its facts state: so a relation written from several
 * sources in one stratum, or in several strata, is written as an application writes it, a served call supplying one
 * array per op and relation. A further member of an op and relation `joined` names adds its facts to that op and
 * relation's array member, which holds them as its stratum's union does: every family write sits in the middle
 * stratum, so the array member is always in the further member's own.
 */
const servedOf = (
	spec: SwarmSpec,
	value: ReturnType<BuiltSwarm["rename"]>,
	strata: ReadonlyArray<ReadonlyArray<Member>>,
	params: ParamMap,
	joined: (m: Member, stratum: ReadonlyArray<Member>) => boolean
): Served => {
	const arrays = new Map<Member["op"], Map<string, Array<Fact>>>()
	const given: Array<readonly [string, ReadonlyArray<Fact>]> = []
	const appends: Array<OwnerAppend> = []
	const queryPuts = new Set<string>()
	/**
	 * The rows of `m`, a member of the stratum `stratum`, as its ChangeSet holds them, or none where its facts join its
	 * array member's.
	 */
	const sourceOf = (
		m: Member,
		rows: Exclude<Member["rows"], { readonly kind: "selection" }>,
		stratum: ReadonlyArray<Member>
	): ReadonlyArray<MemberInput> => {
		if (rows.kind === "query") {
			if (m.op === "put") {
				queryPuts.add(m.relation.name)
			}
			return [rows.query]
		}
		const facts = rows.facts
		const byRelation = arrays.get(m.op) ?? new Map<string, Array<Fact>>()
		arrays.set(m.op, byRelation)
		const held = byRelation.get(m.relation.name)
		if (held === undefined) {
			byRelation.set(m.relation.name, [...facts])
			return [[]]
		}
		if (joined(m, stratum)) {
			for (const fact of facts) {
				held.push(fact)
			}
			if (!familyOnly(spec, m)) {
				for (const append of ownerAppends(spec, m, stratum)) {
					appends.push(append)
				}
			}
			return []
		}
		const name = `rows${String(given.length)}`
		given.push([name, facts])
		if (m.op === "put") {
			queryPuts.add(m.relation.name)
		}
		const fields: Readonly<Record<string, FieldBase>> = Rec.fromEntries(
			Arr.map(
				Arr.dedupe(Arr.flatMap(facts, (f) => Rec.keys(f))),
				(field): readonly [string, FieldBase] => [
					field,
					defined(m.relation.fields[field], `the field ${field} of ${m.relation.name}`)
				]
			)
		)
		return [
			query(value).rule((r) => {
				const rows = r.relation(name, fields)
				const row = v(rows, "row")
				return r.match(rows, row).find(row)
			})
		]
	}
	const stratumOf = (members: ReadonlyArray<Member>): ChangeSetValue =>
		Arr.reduce(members, ChangeSet.empty(value), (cs, m) => {
			const rows = m.rows
			return rows.kind === "selection"
				? cs.deleteWhere({ [m.relation.name]: rows.fields })
				: Arr.reduce(sourceOf(m, rows, members), cs, (out, source) => {
						switch (m.op) {
							case "insert":
								return out.insert(m.relation, source)
							case "put":
								return out.put(m.relation, source)
							case "delete":
								return out.delete(m.relation, source)
						}
					})
		})
	const [first, ...rest] = Arr.map(strata, stratumOf)
	const changes = Arr.reduce(rest, first ?? ChangeSet.empty(value), (a, b) =>
		ChangeSet.sequence(a, b)
	)
	const facts: CallFacts = Rec.fromEntries(
		Arr.map(
			[...arrays],
			([op, byRelation]): readonly [string, Readonly<Record<string, ReadonlyArray<unknown>>>] => [
				op,
				Rec.fromEntries([...byRelation])
			]
		)
	)
	return { changes, facts, params: { ...params, ...Rec.fromEntries(given) }, appends, queryPuts }
}

/**
 * A step's ChangeSet over the installed schema `value`: its plain writes in the strata they are placed in, its family
 * writes in the middle one, a first insert writing every relation a caller inserts itself (fill.ts insertedRelations),
 * those without a row of the instance by an empty insert, as a stratum that inserts an immutable owner must, each stratum a ChangeSet of its own and the strata in sequence, each list of facts one
 * member or, split, one member per fact, every member stated twice where the shape repeats it.
 */
export const changeSetOf = (
	spec: SwarmSpec,
	built: BuiltSwarm,
	value: ReturnType<BuiltSwarm["rename"]>,
	state: State,
	step: Step
): Built => {
	const relationOf = (name: string): BuiltRelation =>
		defined(built.relations[name], `the relation ${name}`)
	const shape =
		step.kind === "insert" || step.kind === "follow" ? step.shape : { split: false, repeat: false }
	const spread = (
		relation: BuiltRelation,
		op: Member["op"],
		facts: ReadonlyArray<Fact>
	): ReadonlyArray<Member> => {
		const members: ReadonlyArray<Member> = shape.split
			? Arr.map(facts, (f): Member => ({ relation, op, rows: factsOf([f]) }))
			: Arr.isReadonlyArrayNonEmpty(facts)
				? [{ relation, op, rows: factsOf(facts) }]
				: []
		return shape.repeat ? [...members, ...members] : members
	}
	const plainMembers = (ops: ReadonlyArray<PlainOp>): ReadonlyArray<Member> =>
		Arr.flatMap(ops, (o) => spread(relationOf(plainName(o.row.plain)), o.op, [plainFact(o.row)]))
	const plainAt = (at: Placed): ReadonlyArray<Member> =>
		step.kind === "delete all" ? [] : plainMembers(Arr.filter(step.plain, (o) => o.at === at))
	const queryAt = (at: Placed): ReadonlyArray<Member> => {
		const q = step.kind === "follow" ? step.query : undefined
		if (q?.at !== at) {
			return []
		}
		const read = relationOf(relationName(q.relation))
		return [
			{
				relation: relationOf(plainName(q.plain)),
				op: "insert",
				rows: {
					kind: "query",
					query: query(value).rule((r) => {
						const x = defined(v(read, "row")["v"], "the v of the relation a query reads")
						const bound: Readonly<Record<string, typeof x>> = { v: x }
						const head: HeadShape = { x }
						return r.match(read, bound).find(head)
					})
				}
			}
		]
	}
	const family = ((): {
		readonly members: ReadonlyArray<Member>
		readonly params: ParamMap
	} => {
		switch (step.kind) {
			case "insert": {
				const rows = orphaned(spec, step)
				const facts = topFacts(spec, rows)
				return {
					members: Arr.flatMap(insertedRelations(spec.fill), (r): ReadonlyArray<Member> => {
						const list = facts.get(r) ?? []
						const relation = relationOf(relationName(r))
						const conflicting = Arr.flatMap(list, (f) =>
							step.conflict !== undefined && f["id"] === uuidOfRow(step.conflict)
								? [{ ...f, v: (typeof f["v"] === "bigint" ? f["v"] : 0n) + 1n }]
								: []
						)
						return Arr.isReadonlyArrayNonEmpty(list)
							? spread(relation, "insert", [...list, ...conflicting])
							: [{ relation, op: "insert", rows: factsOf([]) }]
					}),
					params: {}
				}
			}
			case "follow":
				return {
					members: Option.match(Option.fromUndefinedOr(step.followUp), {
						onNone: (): ReadonlyArray<Member> => [],
						onSome: (followUp) => {
							const after = followUpRows(state.rows, followUp)
							return Arr.flatMap(followUpMembers(spec.fill, state.rows, followUp), (m) =>
								spread(
									relationOf(relationName(m.relation)),
									m.op,
									Arr.map(m.facts, (f) => ({
										...f,
										...swarmFacts(spec, after, m.relation, idOfUuid(f["id"]))
									}))
								)
							)
						}
					}),
					params: {}
				}
			case "query put":
				return {
					members: [
						{
							relation: relationOf(relationName(step.relation)),
							op: "put",
							rows: {
								kind: "query",
								query: query(value).rule((r) => {
									const rows = r.relation("rows", callerFields(spec, step.relation))
									const row = v(rows, "row")
									return r.match(rows, row).find(row)
								})
							}
						}
					],
					params: {
						rows: Arr.map(step.rows, (p) => ({
							id: uuidOfRow(p.id),
							v: p.v,
							...swarmFacts(spec, state.rows, step.relation, p.id)
						}))
					}
				}
			case "delete all":
				return {
					members: [
						...Arr.map(deletedAll(spec, state, step.by), (r): Member => {
							const relation = relationOf(relationName(r))
							switch (step.by) {
								case "rows":
									return {
										relation,
										op: "delete",
										rows: factsOf(
											Arr.map(
												Arr.filter(state.rows, (x) => x.relation === r),
												(x) => callerFact(spec, state.rows, x)
											)
										)
									}
								case "selection":
									return { relation, op: "delete", rows: { kind: "selection", fields: {} } }
							}
						}),
						...plainMembers(
							Arr.map(state.plain, (row): PlainOp => ({ op: "delete", row, at: "with" }))
						)
					],
					params: {}
				}
		}
	})()
	const strata = Arr.filter(
		[
			[...plainAt("before"), ...queryAt("before")],
			[...family.members, ...plainAt("with"), ...queryAt("with")],
			[...plainAt("after"), ...queryAt("after")]
		],
		Arr.isReadonlyArrayNonEmpty
	)
	const joined = (m: Member, stratum: ReadonlyArray<Member>): boolean =>
		familyOnly(spec, m) || Arr.isReadonlyArrayNonEmpty(ownerAppends(spec, m, stratum))
	const served = servedOf(spec, value, strata, family.params, joined)
	const writes = Arr.dedupeWith(served.appends, (a, b) => a.op === b.op && a.owner === b.owner)
	return {
		changes: served.changes,
		facts: served.facts,
		params: served.params,
		queryPuts: served.queryPuts,
		queried: Arr.flatMap(writes, (write): ReadonlyArray<Queried> => {
			const ofWrite = Arr.filter(
				served.appends,
				(a) => a.op === write.op && a.owner === write.owner
			)
			return Arr.isReadonlyArrayNonEmpty(ofWrite)
				? [
						{
							changes: servedOf(
								spec,
								value,
								strata,
								family.params,
								(m, stratum) =>
									!(m.op === write.op && m.relation.name === write.owner) && joined(m, stratum)
							).changes,
							refusals: ofWrite
						}
					]
				: []
		})
	}
}

/** The relations a step puts, in any of its strata: its follow-up's puts, its plain puts and a put from a query. */
export const putsOf = (spec: SwarmSpec, state: State, step: Step): ReadonlySet<string> =>
	new Set([
		...Arr.flatMap(familyWrites(spec, state, step), (w) =>
			w.op === "put" ? [relationName(w.relation)] : []
		),
		...(step.kind === "delete all"
			? []
			: Arr.flatMap(step.plain, (o) => (o.op === "put" ? [plainName(o.row.plain)] : [])))
	])
