import {
	isNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray
} from "@bjornpagen/grizzle-text/base/nonempty"
import * as Result from "@bjornpagen/grizzle-text/base/result"
import type { ScopeRule } from "#compiler/core/causes.ts"
import type { SourceLoc } from "#compiler/core/loc.ts"
import { compareStrings } from "#compiler/core/order.ts"
import { deepFreeze } from "#compiler/core/record.ts"
import {
	candidateKeyFields,
	type ExprDesc,
	exprChildren,
	levelChain,
	type MatchDesc,
	type QueryDesc,
	type QueryStageDesc,
	type RelationDesc,
	type SchemaDesc,
	type VarDesc
} from "#compiler/ir/desc.ts"

/**
 * Scoped entries: a role's entry under a relation's own name that holds the relation's rows of one owner, a row
 * predicate over it (scopedEntriesOf, schema/world.ts).
 *
 * A role holding every relation of its base whole runs every program over the base (schema/level.ts). A scoped entry
 * holds its relation T under T's own name, with T's whole heading, and only the rows of T its owner holds: so a role
 * whose every relation is whole or scoped runs the base's programs too, each over the rows its owner holds, which
 * PostgreSQL enforces (physical/ddl/roles.ts: a security-barrier view for reads, one row policy for writes). Its rows are
 * a row predicate, decided by each row of T alone and the session's context, in one of two forms:
 *
 * - **root**: T semi-joined with the owner on one field, `T ⋉ owner` on `T.field = owner.field`. The owner is a query
 *   over the base of one field that reads the role's contexts and the rows they determine by a key (`ownerOf`): the
 *   persons a Clerk session signs in as, Session ⋈ ClerkAccount{clerk} → person.
 * - **reached**: T semi-joined with the scoped rows of another relation A along a key of A that T's fields entail by
 *   declared containments (`Reach`), `T ⋉ scoped(A)` on `T.columns = A.key`. Each row of T reaches exactly one row of A,
 *   the containment's, so the predicate is still a row of T's alone. Chains compose: A may be reached itself.
 *
 * A scope is never inferred from a hand-written query: scopedEntriesOf states the roots and derives every reached scope
 * along declared containments (`deriveScopes`), and each scoped entry is a Description entry of its own kind (ir/desc.ts
 * RoleEntryDesc scoped) holding the scope's definition, which role(...) and ownership parse back into the scope
 * (`entryScope`, world.ts RoleLevel.scoped, own.ts OwnedRole.scoped). The definition is the query entry the role
 * installs, read by its security-barrier view and, where the role writes it, by the one policy and the precheck of a
 * write that is otherwise the relation's whole write (write/frontend/compile.ts WholeCheck).
 */

/** Fields of a relation in a key's order, or the fields of another relation a containment pairs with them. */
export type Columns = NonEmptyReadonlyArray<string>

/** A field of a reached key, and the field of the reaching relation it equals. */
export interface Paired {
	readonly key: string
	readonly column: string
}

/**
 * A key of `into` that fields of a relation T entail by declared containments, each field of the key, in the key's own
 * order, paired with the field of T it equals: every row of T has a row of `into` whose key equals its paired fields,
 * and at most one, the key's. A declared containment T(c) ⊆ A(k) into a key k of A is one; and from a reach of A at k,
 * a declared containment A(d) ⊆ B(k2) into a key k2 of B whose every field of d is a field of k reaches B at k2 by the
 * fields of T that k pairs with d (`reachesOf`).
 */
export interface Reach {
	readonly into: string
	readonly pairs: NonEmptyReadonlyArray<Paired>
}

/** The field of the reaching relation a reach pairs with field `key` of its key; none for a field outside the key. */
const columnOf = (reach: Reach, key: string): string | undefined =>
	reach.pairs.find((p) => p.key === key)?.column

/** The fields of the reaching relation a reach pairs with `fields` of its key, in their order; none where one is outside it. */
const columnsOf = (reach: Reach, fields: Columns): Columns | undefined => {
	const columns = fields.flatMap((f) => {
		const c = columnOf(reach, f)
		return c === undefined ? [] : [c]
	})
	return isNonEmpty(columns) && columns.length === fields.length ? columns : undefined
}

/** A role's owner: a query over its base of one field, `field`, reading its contexts and the rows they determine by a key. */
export interface Owner {
	readonly query: QueryDesc
	readonly field: string
}

/**
 * How a scoped entry's relation `relation` holds its owner's rows: `definition` is the query entry it installs, the
 * relation's rows its owner holds under the relation's whole heading. A root holds the rows whose `field` the owner
 * holds; a reached scope the rows that reach a row `parent` holds along `reach`.
 */
export type Scope =
	| {
			readonly kind: "root"
			readonly relation: string
			readonly definition: QueryDesc
			readonly field: string
			readonly owner: Owner
	  }
	| {
			readonly kind: "reached"
			readonly relation: string
			readonly definition: QueryDesc
			readonly reach: Reach
			readonly parent: Scope
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

/**
 * The fields of a relation of `schema` a role may scope, an ordinary one's declared fields, at least one; none for any
 * other relation, or one it lacks: a role reads a derived relation through the relations its definition reads.
 */
export const scopableFields = (schema: SchemaDesc, relation: string): Columns | undefined => {
	const desc = relationsOf(schema).get(relation)
	const fields = desc?.kind === "relation" ? Object.keys(desc.fields) : []
	return isNonEmpty(fields) ? fields : undefined
}

/** Whether two lists of fields hold the same fields, each once. */
const sameFields = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean =>
	a.length === b.length && a.every((f) => b.includes(f))

/**
 * The keys of an ordinary relation of `schema`, each in its own order: its primary key, then every candidate key a key
 * statement of any level declares over it, each once; none for any other relation.
 */
export const keysOf = (schema: SchemaDesc, relation: string): ReadonlyArray<Columns> => {
	const desc = relationsOf(schema).get(relation)
	if (desc?.kind !== "relation") {
		return []
	}
	const keys: Array<Columns> = [desc.primaryKey]
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

/**
 * A declared containment of fields into fields, each side reading every fact of its relation: each field of `into` it
 * names, paired with the field of `from` the statement pairs it with by position.
 */
interface Containment {
	readonly from: string
	readonly into: string
	readonly pairs: NonEmptyReadonlyArray<{ readonly from: string; readonly onto: string }>
}

const containmentsOf = (schema: SchemaDesc): ReadonlyArray<Containment> =>
	levelChain(schema).flatMap((level) =>
		level.statements.flatMap((s): ReadonlyArray<Containment> => {
			const left = s.kind === "contained" ? candidateKeyFields(s.left) : undefined
			const right = s.kind === "contained" ? candidateKeyFields(s.right) : undefined
			if (s.kind !== "contained" || left === undefined || right === undefined) {
				return []
			}
			const pairs = left.flatMap((from, i) => {
				const onto = right[i]
				return onto === undefined ? [] : [{ from, onto }]
			})
			return isNonEmpty(pairs) ? [{ from: s.left.relation, into: s.right.relation, pairs }] : []
		})
	)

/** A reach's identity: its target and its pairs. */
const reachKey = (r: Reach): string =>
	JSON.stringify([r.into, r.pairs.map((p) => [p.key, p.column])])

/**
 * Every key of another ordinary relation that the fields `fields` of `relation` entail (Reach), in the order a
 * breadth-first walk over the declared containments finds them, each once: from `relation`, each declared containment
 * whose left fields the walk's relation has from T, into fields that are a key of an ordinary relation, reaches it at
 * that key; the reached relation has from T exactly that key's fields. `relation` itself is never reached.
 */
const reachesOf = (
	schema: SchemaDesc,
	relation: string,
	fields: ReadonlyArray<string>
): ReadonlyArray<Reach> => {
	const containments = containmentsOf(schema)
	const out: Array<Reach> = []
	const seen = new Set<string>()
	const frontier: Array<{ readonly at: string; readonly given: ReadonlyMap<string, string> }> = [
		{ at: relation, given: new Map(fields.map((f) => [f, f])) }
	]
	for (let next = frontier.shift(); next !== undefined; next = frontier.shift()) {
		const { at, given } = next
		for (const c of containments) {
			const key =
				c.from === at && c.into !== relation
					? keysOf(schema, c.into).find((k) =>
							sameFields(
								k,
								c.pairs.map((p) => p.onto)
							)
						)
					: undefined
			const pairs = (key ?? []).flatMap((k) => {
				const from = c.pairs.find((p) => p.onto === k)?.from
				const column = from === undefined ? undefined : given.get(from)
				return column === undefined ? [] : [{ key: k, column }]
			})
			if (key === undefined || !isNonEmpty(pairs) || pairs.length !== key.length) {
				continue
			}
			const reach: Reach = { into: c.into, pairs }
			const id = reachKey(reach)
			if (!seen.has(id)) {
				seen.add(id)
				out.push(reach)
				frontier.push({ at: c.into, given: new Map(pairs.map((p) => [p.key, p.column])) })
			}
		}
	}
	return out
}

/** The rules stage under any names `.named()` gives a query. */
const unnamed = (stage: QueryStageDesc): QueryStageDesc =>
	stage.kind === "named" ? unnamed(stage.input) : stage

/** Whether an expression reads a relation: an absence or an existence anywhere in it. */
const readsRelation = (e: ExprDesc): boolean =>
	e.kind === "absent" || e.kind === "exists" || exprChildren(e).some((c) => readsRelation(c.term))

/**
 * The variables `matches` fix for one evaluation: each a context match binds, and each a match of an ordinary relation
 * binds where a key of it is bound whole to `given` leaves and to variables fixed so, by the key's one row; and the
 * relation matches no key fixes.
 */
export const keyFixed = (
	schema: SchemaDesc,
	matches: ReadonlyArray<MatchDesc>,
	given: (e: ExprDesc) => boolean
): { readonly fixed: ReadonlySet<string>; readonly unfixed: ReadonlyArray<MatchDesc> } => {
	const fixed = new Set<string>()
	const bind = (m: MatchDesc): void => {
		for (const e of Object.values(m.bindings)) {
			if (e.kind === "var") {
				fixed.add(e.var)
			}
		}
	}
	const settled = (e: ExprDesc | undefined): boolean =>
		e !== undefined && (e.kind === "var" ? fixed.has(e.var) : given(e))
	for (const m of matches) {
		if (m.source.kind === "context") {
			bind(m)
		}
	}
	let unfixed = matches.flatMap((m) =>
		m.source.kind === "relation" ? [{ match: m, keys: keysOf(schema, m.source.name) }] : []
	)
	const keyed = (p: (typeof unfixed)[number]): boolean =>
		p.keys.some((k) => k.every((f) => settled(p.match.bindings[f])))
	for (let ready = unfixed.filter(keyed); ready.length > 0; ready = unfixed.filter(keyed)) {
		for (const p of ready) {
			bind(p.match)
		}
		unfixed = unfixed.filter((p) => !ready.includes(p))
	}
	return { fixed, unfixed: unfixed.map((p) => p.match) }
}

/**
 * The owner `query` states over `schema`, or the rule of an owner it breaks (ScopeRule owner): a rules stage, under any
 * names, each arm reading at least one context, every other match an ordinary relation whose row the contexts determine
 * by a key, each a fact of a key whose every field is bound to a literal or to a variable a context or a determined row
 * binds; filters that read no relation; no interior or attachment; and a head of one field, the same in every arm, a
 * variable a context or a determined row binds. Its rows are then the session's own, a function of the contexts and of
 * the rows a key determines, however the rest of the database stands.
 */
export const ownerOf = (
	schema: SchemaDesc,
	query: QueryDesc
): Result.Result<Owner, Extract<ScopeRule, { readonly kind: "owner" }>> => {
	const broken = (why: Extract<ScopeRule, { readonly kind: "owner" }>["why"]) =>
		Result.err({ kind: "owner" as const, why })
	const stage = unnamed(query.stage)
	if (stage.kind !== "rules") {
		return broken("heading")
	}
	const relations = relationsOf(schema)
	const fieldNames = new Set<string>()
	for (const arm of stage.arms) {
		for (const f of Object.keys(arm.head)) {
			fieldNames.add(f)
		}
	}
	const [field] = fieldNames
	if (field === undefined || fieldNames.size !== 1) {
		return broken("heading")
	}
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
		const { fixed, unfixed } = keyFixed(schema, arm.matches, (e) => e.kind === "literal")
		const head = arm.head[field]
		if (unfixed.length > 0 || head?.kind !== "var" || !fixed.has(head.var)) {
			return broken("undetermined")
		}
	}
	return Result.ok({ query, field })
}

/** The variable a scoped entry's definition binds field `field` of its relation to. */
const rowVar = (field: string): string => `row.${field}`

/**
 * The one rule of a scoped entry's definition: every field of `relation` bound to a variable of its own and found under
 * its own name, the relation's whole heading, beside a match of the query `other` imports, its fields `bindings` binds
 * each bound to the variable of a field of `relation`.
 */
const definitionOf = (
	relation: string,
	fields: Columns,
	other: QueryDesc,
	bindings: ReadonlyArray<readonly [string, string]>,
	loc: SourceLoc
): QueryDesc => {
	const terms: Readonly<Record<string, ExprDesc>> = Object.fromEntries(
		fields.map((f): readonly [string, ExprDesc] => [f, { kind: "var", var: rowVar(f) }])
	)
	const vars = fields.map((f): VarDesc => ({ id: rowVar(f), origin: { relation, field: f }, loc }))
	return deepFreeze<QueryDesc>({
		stage: {
			kind: "rules",
			loc,
			arms: [
				{
					loc,
					vars,
					matches: [
						{ loc, source: { kind: "relation", name: relation }, bindings: terms },
						{
							loc,
							source: { kind: "query", query: other, bind: {} },
							bindings: Object.fromEntries(
								bindings.map(([theirs, ours]): readonly [string, ExprDesc] => [
									theirs,
									{ kind: "var", var: rowVar(ours) }
								])
							)
						}
					],
					where: [],
					head: terms,
					interiors: [],
					attach: []
				}
			]
		}
	})
}

/**
 * The scope `query` states of `relation`, the one parse of a scoped entry (RoleEntryDesc scoped): the definition
 * `definitionOf` builds, a rules stage of one arm, under any names, of exactly two matches and nothing else, one
 * binding every field of `relation` (scopableFields) to a variable of its own, found under its own name, and one
 * importing a query with no bind map, each field it binds bound to one of those variables. The import is the owner
 * (ownerOf), bound at its field, for a root; or the scope of another relation A (this parse, read of the import), bound
 * at a key of A that the fields bound to it reach (reachesOf), for a reached scope. Anything else states no scope.
 */
export const entryScope = (
	schema: SchemaDesc,
	relation: string,
	query: QueryDesc
): Scope | undefined => {
	const fields = scopableFields(schema, relation)
	const stage = unnamed(query.stage)
	const [arm, ...more] = stage.kind === "rules" ? stage.arms : []
	if (
		fields === undefined ||
		arm === undefined ||
		more.length > 0 ||
		arm.where.length > 0 ||
		arm.interiors.length > 0 ||
		arm.attach.length > 0 ||
		arm.matches.length !== 2
	) {
		return undefined
	}
	const own = arm.matches.find((m) => m.source.kind === "relation" && m.source.name === relation)
	const other = arm.matches.find((m) => m !== own)
	if (
		own === undefined ||
		other?.source.kind !== "query" ||
		Object.keys(other.source.bind).length > 0 ||
		!sameFields(Object.keys(own.bindings), fields) ||
		!sameFields(Object.keys(arm.head), fields)
	) {
		return undefined
	}
	const fieldOf = new Map<string, string>()
	for (const f of fields) {
		const bound = own.bindings[f]
		const found = arm.head[f]
		if (
			bound?.kind !== "var" ||
			found?.kind !== "var" ||
			found.var !== bound.var ||
			fieldOf.has(bound.var)
		) {
			return undefined
		}
		fieldOf.set(bound.var, f)
	}
	const pairs = Object.entries(other.bindings).flatMap(([key, e]) => {
		const column = e.kind === "var" ? fieldOf.get(e.var) : undefined
		return column === undefined ? [] : [{ key, column }]
	})
	if (!isNonEmpty(pairs) || pairs.length !== Object.keys(other.bindings).length) {
		return undefined
	}
	const imported = other.source.query
	const owner = ownerOf(schema, imported)
	if (owner.ok) {
		const [p, ...rest] = pairs
		return rest.length === 0 && p.key === owner.value.field
			? { kind: "root", relation, definition: query, field: p.column, owner: owner.value }
			: undefined
	}
	const importedStage = unnamed(imported.stage)
	const targets =
		importedStage.kind === "rules"
			? importedStage.arms[0].matches.flatMap((m) =>
					m.source.kind === "relation" ? [m.source.name] : []
				)
			: []
	for (const into of targets) {
		const parent = into === relation ? undefined : entryScope(schema, into, imported)
		const reach = reachesOf(schema, relation, fields).find(
			(r) =>
				r.into === into &&
				r.pairs.length === pairs.length &&
				pairs.every((p) => r.pairs.some((q) => q.key === p.key && q.column === p.column))
		)
		if (parent !== undefined && reach !== undefined) {
			return { kind: "reached", relation, definition: query, reach, parent }
		}
	}
	return undefined
}

/** The root scope of `relation` by its field `field`: its rows whose `field` the owner holds. */
const rootScope = (
	relation: string,
	fields: Columns,
	owner: Owner,
	field: string,
	loc: SourceLoc
): Scope => ({
	kind: "root",
	relation,
	definition: definitionOf(relation, fields, owner.query, [[owner.field, field]], loc),
	field,
	owner
})

/** The scope of `relation` reached along `reach`: its rows that reach a row `parent` holds. */
const reachedScope = (
	relation: string,
	fields: Columns,
	reach: Reach,
	parent: Scope,
	loc: SourceLoc
): Scope => ({
	kind: "reached",
	relation,
	definition: definitionOf(
		relation,
		fields,
		parent.definition,
		reach.pairs.map((p) => [p.key, p.column] as const),
		loc
	),
	reach,
	parent
})

/**
 * How a reach of a relation T would hold T's rows, in its shortest form: through a root A whose field is in the reached
 * key, as a root of T by the field of T that key pairs with it; through a scope of A that reaches on along fields of the
 * reached key, as that scope's own reach, taken from T (`reachesOf` holds it too); otherwise along the reach itself.
 * Two reaches of T hold the same rows exactly when their forms are equal.
 */
type ScopeForm =
	| { readonly kind: "root"; readonly field: string }
	| { readonly kind: "reached"; readonly reach: Reach; readonly parent: Scope }

const formKey = (f: ScopeForm): string =>
	f.kind === "root" ? `root ${f.field}` : `reached ${reachKey(f.reach)}`

const formOf = (reach: Reach, target: Scope): ScopeForm => {
	switch (target.kind) {
		case "root": {
			const field = columnOf(reach, target.field)
			return field === undefined
				? { kind: "reached", reach, parent: target }
				: { kind: "root", field }
		}
		case "reached": {
			const onward = target.reach.pairs.flatMap((p) => {
				const column = columnOf(reach, p.column)
				return column === undefined ? [] : [{ key: p.key, column }]
			})
			return isNonEmpty(onward) && onward.length === target.reach.pairs.length
				? formOf({ into: target.reach.into, pairs: onward }, target.parent)
				: { kind: "reached", reach, parent: target }
		}
	}
}

/**
 * The scopes of scopedEntriesOf(schema, { owner, roots }) (world.ts): each root by its stated field, then every
 * scopable relation of the schema (scopableFields) some declared containment chain reaches a scoped relation's key from
 * (`reachesOf`), each in its shortest form (ScopeForm); a relation whose reaches into scoped relations hold its rows in
 * two forms is refused (ScopeRule ambiguous), naming two. Every other relation stays whole. `roots` name scopable
 * relations by a field of theirs; the caller has refused any other.
 */
export const deriveScopes = (
	schema: SchemaDesc,
	owner: Owner,
	roots: ReadonlyMap<string, string>,
	loc: SourceLoc
): Result.Result<ReadonlyMap<string, Scope>, ScopeRule> => {
	const scopable = new Map(
		[...relationsOf(schema).keys()].flatMap((relation) => {
			const fields = scopableFields(schema, relation)
			return fields === undefined ? [] : [[relation, fields] as const]
		})
	)
	const scopes = new Map<string, Scope>()
	for (const [relation, field] of [...roots].toSorted(([a], [b]) => compareStrings(a, b))) {
		const fields = scopable.get(relation)
		if (fields !== undefined) {
			scopes.set(relation, rootScope(relation, fields, owner, field, loc))
		}
	}
	const reaches = new Map(
		[...scopable]
			.filter(([relation]) => !roots.has(relation))
			.map(([relation, fields]) => [relation, reachesOf(schema, relation, fields)] as const)
	)
	const scoped = new Set(scopes.keys())
	for (let moved = true; moved;) {
		moved = false
		for (const [relation, rs] of reaches) {
			if (!scoped.has(relation) && rs.some((r) => scoped.has(r.into))) {
				scoped.add(relation)
				moved = true
			}
		}
	}
	const visiting = new Set<string>()
	const derived = (relation: string): Result.Result<Scope | undefined, ScopeRule> => {
		const held = scopes.get(relation)
		const fields = scopable.get(relation)
		if (
			held !== undefined ||
			fields === undefined ||
			!scoped.has(relation) ||
			visiting.has(relation)
		) {
			return Result.ok(held)
		}
		visiting.add(relation)
		const forms = new Map<string, ScopeForm>()
		for (const r of reaches.get(relation) ?? []) {
			if (!scoped.has(r.into)) {
				continue
			}
			const target = derived(r.into)
			if (!target.ok) {
				return target
			}
			if (target.value !== undefined) {
				const form = formOf(r, target.value)
				forms.set(formKey(form), form)
			}
		}
		visiting.delete(relation)
		const [first, second] = [...forms.values()]
		if (first === undefined) {
			return Result.ok(undefined)
		}
		if (second !== undefined) {
			return Result.err({
				kind: "ambiguous",
				relation,
				through: [formKey(first), formKey(second)]
			})
		}
		const scope =
			first.kind === "root"
				? rootScope(relation, fields, owner, first.field, loc)
				: reachedScope(relation, fields, first.reach, first.parent, loc)
		scopes.set(relation, scope)
		return Result.ok(scope)
	}
	for (const relation of [...scoped].toSorted(compareStrings)) {
		const s = derived(relation)
		if (!s.ok) {
			return s
		}
	}
	return Result.ok(scopes)
}

/**
 * A scope's pin forms: each a statement that its relation's row is in its role's slice exactly when another fact is,
 * named by `chain` and read off the row's fields `columns`, from the nearest to the farthest. A root's one form is its
 * owner holding the value of its field; a reached scope's first is the row of its target at the reached key being in
 * its target's slice, then each form of its target whose fields lie in the reached key, read through it. The last form
 * is the scope's own (program/slice.ts).
 */
export interface PinForm {
	readonly chain: PinChain
	readonly columns: Columns
}

/** What a pin form states its row's slice by: its owner holding a value, or a row of a scope at a key. */
export type PinChain =
	| { readonly kind: "owner"; readonly owner: Owner }
	| { readonly kind: "key"; readonly scope: Scope; readonly key: Columns }

export const pinForms = (scope: Scope): NonEmptyReadonlyArray<PinForm> => {
	switch (scope.kind) {
		case "root":
			return [{ chain: { kind: "owner", owner: scope.owner }, columns: [scope.field] }]
		case "reached": {
			const { reach, parent } = scope
			const onward = pinForms(parent).flatMap((f): ReadonlyArray<PinForm> => {
				const columns = columnsOf(reach, f.columns)
				return columns === undefined ? [] : [{ chain: f.chain, columns }]
			})
			return [
				{
					chain: { kind: "key", scope: parent, key: mapNonEmpty(reach.pairs, (p) => p.key) },
					columns: mapNonEmpty(reach.pairs, (p) => p.column)
				},
				...onward
			]
		}
	}
}

/**
 * Whether fields `fields` of a scope's relation determine whether a row is its owner's: they hold every field of one of
 * its pin forms (`pinForms`), so two rows equal at `fields` are both the owner's or neither is. A unique object that
 * compares such fields for equality meets no row outside the owner's rows from a row inside them, so a scoped write
 * probes none there (write/insert/unique.ts scopedProbes).
 */
export const determines = (scope: Scope, fields: ReadonlyArray<string>): boolean =>
	pinForms(scope).some((f) => f.columns.every((c) => fields.includes(c)))
