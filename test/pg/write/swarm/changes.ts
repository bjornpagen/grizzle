/**
 * The ChangeSets of the family swarm search (test/pg/write/swarm/families.test.ts), built over an installed schema from
 * a case's steps (oracle.ts Step): the facts of an instance's rows, top facts with their sequences nested, a stored
 * row's caller facts, a follow-up's members, plain writes, a query's insert and a put from a query, each stratum a
 * ChangeSet of its own and the strata in sequence. Each ChangeSet is served as an application writes it: the first
 * member of an op and relation is its array member, its facts the call's under that op and relation, and every further
 * one a query member over a relation parameter of its own, its rows the call's parameter, but where only an array
 * writes it, a family's member or a sequence's owner inserted, whose further facts join its array member's.
 */
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
	familyWrites,
	orphaned,
	type PlainOp,
	type Placed,
	type State,
	type Step
} from "#test/pg/write/swarm/oracle.ts"
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
} from "#test/pg/write/swarm/spec.ts"
import { defined } from "#test/support/assert.ts"
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

/** A fact as a ChangeSet states it. */
type Fact = { readonly [field: string]: unknown }

/**
 * The top facts of an instance's rows by relation: each row no sequence nests, with its caller's fields, its set `b`,
 * the columns it names a member's row by, its counted families' group fields, a tree root's own id as its root field,
 * and each sequence's members nested at its count field in slot order, each nested member its own caller's fields, set,
 * named row's columns and counted group fields.
 */
const topFacts = (
	spec: SwarmSpec,
	rows: ReadonlyArray<InstanceRow>
): ReadonlyMap<number, ReadonlyArray<Fact>> => {
	const written = writtenRows(spec.fill, rows)
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
}

/** A call's facts: under each op of the ChangeSet's array members, each one's facts under its relation's name. */
type CallFacts = Readonly<Record<string, Readonly<Record<string, ReadonlyArray<unknown>>>>>

/** A ChangeSet as a served call applies it: the ChangeSet, its call's facts and its parameters. */
interface Built {
	readonly changes: ChangeSetValue
	readonly facts: CallFacts
	readonly params: ParamMap
}

/** Facts of a member as a ChangeSet states them. */
const factsOf = (facts: ReadonlyArray<Fact>): Member["rows"] => ({ kind: "facts", facts })

/**
 * Whether only an array member writes `m`, a member of the stratum `stratum`, the served compile refusing it from a
 * query: any write of a family's member, whose family values grizzle draws from the call's rows on the host, and an
 * insert of a sequence's or a tree's owner, whose members it writes nested in order under it (UnsupportedOperation);
 * and an insert or a put of a counted family's owner in a stratum that inserts or puts a member of that family, an
 * inserted owner holding its final count and ends in its own row, which grizzle fills only from the facts the
 * ChangeSet states (QueriedOwnerAppend, write/frontend/compile.ts refuseQueriedOwnerAppend).
 */
const arrayOnly = (spec: SwarmSpec, m: Member, stratum: ReadonlyArray<Member>): boolean =>
	Arr.some(spec.fill.families, (f) => {
		const owner = relationName(f.owner)
		const member = relationName(f.member)
		return (
			member === m.relation.name ||
			(m.op === "insert" && f.kind !== "counted" && owner === m.relation.name) ||
			(m.op !== "delete" &&
				f.kind === "counted" &&
				owner === m.relation.name &&
				Arr.some(stratum, (s) => s.op !== "delete" && s.relation.name === member))
		)
	})

/**
 * Strata of members as one served ChangeSet over `value`, the strata in sequence, with its call's facts and parameters
 * beside `params`. The first member of an op and relation is its array member, its facts the call's under that op and
 * relation. Every further one is a query member over a relation parameter of its own, `rows<k>` in order, whose rows
 * the call gives as that parameter, each of the relation's fields its facts state: so a relation written from several
 * sources in one stratum, or in several strata, is written as an application writes it, a served call supplying one
 * array per op and relation. A further member of an op and relation only an array writes (arrayOnly) adds its facts to
 * that op and relation's array member, which holds them as its stratum's union does: every family write sits in the
 * middle stratum, so the array member is always in the further member's own.
 */
const servedOf = (
	spec: SwarmSpec,
	value: ReturnType<BuiltSwarm["rename"]>,
	strata: ReadonlyArray<ReadonlyArray<Member>>,
	params: ParamMap
): Built => {
	const arrays = new Map<Member["op"], Map<string, Array<Fact>>>()
	const given: Array<readonly [string, ReadonlyArray<Fact>]> = []
	/**
	 * The rows of `m`, a member of the stratum `stratum`, as its ChangeSet holds them, or none where its facts join its
	 * array member's.
	 */
	const sourceOf = (m: Member, stratum: ReadonlyArray<Member>): ReadonlyArray<MemberInput> => {
		if (m.rows.kind === "query") {
			return [m.rows.query]
		}
		const facts = m.rows.facts
		const byRelation = arrays.get(m.op) ?? new Map<string, Array<Fact>>()
		arrays.set(m.op, byRelation)
		const held = byRelation.get(m.relation.name)
		if (held === undefined) {
			byRelation.set(m.relation.name, [...facts])
			return [[]]
		}
		if (arrayOnly(spec, m, stratum)) {
			for (const fact of facts) {
				held.push(fact)
			}
			return []
		}
		const name = `rows${String(given.length)}`
		given.push([name, facts])
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
		Arr.reduce(members, ChangeSet.empty(value), (cs, m) =>
			Arr.reduce(sourceOf(m, members), cs, (out, source) => {
				switch (m.op) {
					case "insert":
						return out.insert(m.relation, source)
					case "put":
						return out.put(m.relation, source)
					case "delete":
						return out.delete(m.relation, source)
				}
			})
		)
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
	return { changes, facts, params: { ...params, ...Rec.fromEntries(given) } }
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
						...Arr.flatMap(spec.fill.relations, (_, r) => {
							const own = Arr.filter(state.rows, (x) => x.relation === r)
							return Arr.isReadonlyArrayNonEmpty(own)
								? [
										{
											relation: relationOf(relationName(r)),
											op: "delete" as const,
											rows: factsOf(Arr.map(own, (x) => callerFact(spec, state.rows, x)))
										}
									]
								: []
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
	return servedOf(spec, value, strata, family.params)
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
