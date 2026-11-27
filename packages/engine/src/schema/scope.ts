import { isNonEmpty, type NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import * as Result from "@bjornpagen/grizzle-text/base/result"
import type { ScopeRule } from "#compiler/core/causes.ts"
import type { SourceLoc } from "#compiler/core/loc.ts"
import { deepFreeze } from "#compiler/core/record.ts"
import {
	candidateKeyFields,
	type ExprDesc,
	type FieldDesc,
	exprChildren,
	levelChain,
	type MatchDesc,
	type QueryDesc,
	type QueryStageDesc,
	type RelationDesc,
	type SchemaDesc,
	type UnitDesc,
	type VarDesc
} from "#compiler/ir/desc.ts"

/**
 * A role's scope (role(base, name, entries, { scope })): the units its claims bind, each by an owner, a query over the
 * base whose head is the unit's heading, by name: the unit keys the session's claims name, `{ child }` the children a
 * student's Clerk user signs in as, or a coach's by their grant. The role's world holds every member of a scoped unit
 * at those keys alone, and every read on the role means its evaluation over that world (ir/derived.ts servedDag): a
 * program, every import, negation, aggregate and take in it, and every derived definition it reads. No read on the
 * role states the restriction, and none can leave it out.
 *
 * An owner's rows are the session's own: each arm reads the role's contexts, and every other relation it matches at a
 * prefix of one of its keys that literals, the contexts and the rows before it bind, so its rows are the keys the
 * claims name, read from the claims down an index, however the rest of the database stands (`ownerOf`).
 */
export interface UnitOwner {
	readonly query: QueryDesc
	/** The unit it binds: the one whose heading its head is, by name and type. */
	readonly unit: string
	/** Its head's fields, the unit's heading in the unit's order. */
	readonly fields: NonEmptyReadonlyArray<string>
}

/** The relations of a schema through every level it extends, by name, a level's own first. */
const relationsOf = (schema: SchemaDesc): ReadonlyMap<string, RelationDesc> => {
	const out = new Map<string, RelationDesc>()
	for (const level of levelChain(schema).toReversed()) {
		for (const relation of level.relations) {
			if (!out.has(relation.name)) {
				out.set(relation.name, relation)
			}
		}
	}
	return out
}

/** Whether two lists of fields hold the same fields, each once. */
const sameFields = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean =>
	a.length === b.length && a.every((f) => b.includes(f))

/**
 * The keys of an ordinary relation of `schema`, each in its own order: its primary key, then every candidate key a key
 * statement of any level declares over it, each once; none for any other relation.
 */
const keysOf = (schema: SchemaDesc, relation: string): ReadonlyArray<ReadonlyArray<string>> => {
	const desc = relationsOf(schema).get(relation)
	if (desc?.kind !== "relation") {
		return []
	}
	const keys: Array<ReadonlyArray<string>> = [desc.primaryKey]
	for (const level of levelChain(schema)) {
		for (const s of level.statements) {
			const fields =
				s.kind === "key" && s.side.relation === relation ? candidateKeyFields(s.side) : undefined
			if (fields !== undefined && !keys.some((k) => sameFields(k, fields))) {
				keys.push(fields)
			}
		}
	}
	return keys
}

/** The rules stage under any names `.named()` gives a query. */
const unnamed = (stage: QueryStageDesc): QueryStageDesc =>
	stage.kind === "named" ? unnamed(stage.input) : stage

/** Whether an expression reads a relation: an absence or an existence anywhere in it. */
const readsRelation = (e: ExprDesc): boolean =>
	e.kind === "absent" || e.kind === "exists" || exprChildren(e).some((c) => readsRelation(c.term))

/**
 * Whether `matches` read every relation down an index from what an evaluation fixes: each context match binds its
 * variables; each match of an ordinary relation is read where a non-empty prefix of one of its keys is bound to
 * literals and variables bound so, binding its own; and every match is so read, in some order.
 */
const keyedFromContexts = (
	schema: SchemaDesc,
	matches: ReadonlyArray<MatchDesc>
): ReadonlySet<string> | undefined => {
	const bound = new Set<string>()
	const bind = (m: MatchDesc): void => {
		for (const e of Object.values(m.bindings)) {
			if (e.kind === "var") {
				bound.add(e.var)
			}
		}
	}
	const settled = (e: ExprDesc | undefined): boolean =>
		e !== undefined && (e.kind === "literal" || (e.kind === "var" && bound.has(e.var)))
	for (const m of matches) {
		if (m.source.kind === "context") {
			bind(m)
		}
	}
	let pending = matches.flatMap((m) =>
		m.source.kind === "relation" ? [{ match: m, keys: keysOf(schema, m.source.name) }] : []
	)
	const led = (p: (typeof pending)[number]): boolean =>
		p.keys.some((k) => {
			const [first] = k
			return first !== undefined && settled(p.match.bindings[first])
		})
	for (let ready = pending.filter(led); ready.length > 0; ready = pending.filter(led)) {
		for (const p of ready) {
			bind(p.match)
		}
		pending = pending.filter((p) => !ready.includes(p))
	}
	return pending.length === 0 ? bound : undefined
}

/** The units every level of a schema states, each once by name. */
const unitsOf = (schema: SchemaDesc): ReadonlyArray<UnitDesc> => {
	const out = new Map<string, UnitDesc>()
	for (const level of levelChain(schema)) {
		for (const s of level.statements) {
			if (s.kind === "unit" && !out.has(s.name)) {
				out.set(s.name, s)
			}
		}
	}
	return [...out.values()]
}

/**
 * The type the first match of `matches` binding variable `v` binds it at: a context's field's, or an ordinary relation's
 * field's; none where no match binds it.
 */
const boundType = (
	relations: ReadonlyMap<string, RelationDesc>,
	matches: ReadonlyArray<MatchDesc>,
	v: string
): FieldDesc | undefined => {
	for (const m of matches) {
		for (const [field, e] of Object.entries(m.bindings)) {
			if (e.kind !== "var" || e.var !== v) {
				continue
			}
			if (m.source.kind === "context") {
				return m.source.context.fields[field]
			}
			const r = m.source.kind === "relation" ? relations.get(m.source.name) : undefined
			return r?.kind === "relation" ? r.fields[field]?.type : undefined
		}
	}
	return undefined
}

/**
 * The owner `query` states over `schema`, or the rule of an owner it breaks (ScopeRule): a rules stage, under any names,
 * of one head, the same fields in every arm, each a variable (`heading`); each arm reading at least one context
 * (`noContext`), every other match an ordinary relation read down an index from the contexts (`keyedFromContexts`,
 * `undetermined`), each term a variable or a literal, filters that read no relation and no interior or attachment
 * (`source`), and every head variable bound so (`undetermined`). Its rows are then the session's own: a function of the
 * claims and of the rows an index holds at what they bind. Its head is a unit's heading, the same fields (`unit`), so it
 * names keys of that unit, each bound at a type of the unit's, which ownership holds (schema/own.ts ownRole, unitType).
 */
const ownerOf = (schema: SchemaDesc, query: QueryDesc): Result.Result<UnitOwner, ScopeRule> => {
	const broken = (why: Extract<ScopeRule, { readonly kind: "owner" }>["why"]) =>
		Result.err({ kind: "owner" as const, why })
	const stage = unnamed(query.stage)
	if (stage.kind !== "rules") {
		return broken("heading")
	}
	const [first] = stage.arms
	const headFields = Object.keys(first.head)
	if (
		!isNonEmpty(headFields) ||
		stage.arms.some((arm) => !sameFields(Object.keys(arm.head), headFields))
	) {
		return broken("heading")
	}
	const relations = relationsOf(schema)
	/** A match an owner may read: a context, or an ordinary relation bound to variables and literals. */
	const readable = (m: MatchDesc): boolean =>
		Object.values(m.bindings).every((e) => e.kind === "var" || e.kind === "literal") &&
		(m.source.kind === "context" ||
			(m.source.kind === "relation" && relations.get(m.source.name)?.kind === "relation"))
	for (const arm of stage.arms) {
		if (
			arm.interiors.length > 0 ||
			arm.attach.length > 0 ||
			arm.where.some(readsRelation) ||
			!arm.matches.every(readable)
		) {
			return broken("source")
		}
		if (!arm.matches.some((m) => m.source.kind === "context")) {
			return broken("noContext")
		}
		const bound = keyedFromContexts(schema, arm.matches)
		const headBound = headFields.every((f) => {
			const head = arm.head[f]
			return head?.kind === "var" && bound?.has(head.var) === true
		})
		if (bound === undefined || !headBound) {
			return broken("undetermined")
		}
	}
	const unit = unitsOf(schema).find((u) =>
		sameFields(
			u.heading.map((f) => f.field),
			headFields
		)
	)
	if (unit === undefined) {
		return Result.err({ kind: "unit", fields: headFields })
	}
	const [lead, ...rest] = unit.heading
	return Result.ok({ query, unit: unit.name, fields: [lead.field, ...rest.map((f) => f.field)] })
}

/**
 * The type each arm of `owner` binds its head field `field` at: the type of the first match of the arm that binds the
 * field's variable, a context's field's or an ordinary relation's; none for an arm where no match binds it.
 */
export const headTypes = (
	schema: SchemaDesc,
	owner: UnitOwner,
	field: string
): ReadonlyArray<FieldDesc | undefined> => {
	const stage = unnamed(owner.query.stage)
	const relations = relationsOf(schema)
	return stage.kind === "rules"
		? stage.arms.map((arm) => {
				const head = arm.head[field]
				return head?.kind === "var" ? boundType(relations, arm.matches, head.var) : undefined
			})
		: []
}

/**
 * The owners a role's scope lists (`ownerOf` each), each by its position, or the rule the first that breaks one breaks,
 * at its position: an owner breaking ownerOf's rules, or one of a unit an earlier owner binds (`twice`), since a role's
 * claims bind a unit by one owner, whose rules are its every way. The builder and ownership read a scope by it alike.
 */
export const ownersOf = (
	schema: SchemaDesc,
	queries: ReadonlyArray<QueryDesc>
): Result.Result<ReadonlyArray<UnitOwner>, { readonly at: number; readonly rule: ScopeRule }> => {
	const owners: Array<UnitOwner> = []
	for (const [at, query] of queries.entries()) {
		const owner = ownerOf(schema, query)
		if (!owner.ok) {
			return Result.err({ at, rule: owner.error })
		}
		if (owners.some((o) => o.unit === owner.value.unit)) {
			return Result.err({ at, rule: { kind: "twice", unit: owner.value.unit } })
		}
		owners.push(owner.value)
	}
	return Result.ok(owners)
}

/** The variable the claims filter of a member binds the row's field `field` to. */
const rowVar = (field: string): string => `row.${field}`

/**
 * The claims filter of a member of the unit `owner` binds (analysis/schema.ts ClaimsMembership): a membership query,
 * as a writable entry's filter is (schema/entry.ts), over the row a write states (ir/desc.ts RowSourceDesc), its fields
 * holding the unit's key at the unit heading's positions (`key`, each with its type), each bound to the owner's head
 * field at its position, so the row is a member's of the world exactly where the query holds a row. A write of the
 * member on the role asks it of each fact it states (write/entry/precheck.ts), a fact outside the units the claims bind
 * outsideWorld.
 */
export const claimsFilter = (
	key: NonEmptyReadonlyArray<{ readonly field: string; readonly type: FieldDesc }>,
	owner: UnitOwner,
	loc: SourceLoc
): QueryDesc =>
	deepFreeze<QueryDesc>({
		stage: {
			kind: "rules",
			loc,
			arms: [
				{
					loc,
					vars: key.map((k): VarDesc => ({
						id: rowVar(k.field),
						origin: { relation: owner.unit, field: k.field },
						loc
					})),
					matches: [
						{
							loc,
							source: {
								kind: "row",
								heading: Object.fromEntries(key.map((k) => [k.field, k.type] as const))
							},
							bindings: Object.fromEntries(
								key.map((k): readonly [string, ExprDesc] => [
									k.field,
									{ kind: "var", var: rowVar(k.field) }
								])
							)
						},
						{
							loc,
							source: { kind: "query", query: owner.query, bind: {} },
							bindings: Object.fromEntries(
								owner.fields.flatMap((theirs, i): ReadonlyArray<readonly [string, ExprDesc]> => {
									const ours = key[i]
									return ours === undefined
										? []
										: [[theirs, { kind: "var", var: rowVar(ours.field) }]]
								})
							)
						}
					],
					where: [],
					head: {},
					interiors: [],
					attach: []
				}
			]
		}
	})
