import {
	analyzeDerivedRelation,
	type DerivedRelationAnalysis
} from "#compiler/analysis/derived/analyze.ts"
import { analyzeWorld, type WorldAnalysis } from "#compiler/analysis/derived/world.ts"
import { fail, failWith, unwrap } from "#compiler/check/fail.ts"
import type { ClosedRelation, SchemaReading } from "#compiler/check/schema.ts"
import { catchRefusal, compareText } from "#compiler/core/canonical.ts"
import type { KeyFault } from "#compiler/core/causes.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import { childLoc, SourceLoc } from "#compiler/core/loc.ts"
import {
	isNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray,
	sortNonEmpty
} from "#compiler/core/nonempty.ts"
import { compareStrings, mapInput } from "#compiler/core/order.ts"
import * as Result from "#compiler/core/result.ts"
import {
	descText,
	type FieldDesc,
	type LiteralDesc,
	type RoleDesc,
	type SchemaDesc
} from "#compiler/ir/desc.ts"
import type { ExprTable, TypedLiteral } from "#compiler/ir/expr.ts"
import {
	type ClosedTheoryRelation,
	headingColumns,
	isKeyField,
	isSpanField,
	type KeyField,
	type KeyName,
	type LawField,
	type RelationInfo,
	type TheoryRelation
} from "#compiler/ir/law.ts"
import type { DeclaredKey } from "#compiler/ir/rel.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import { admitLiteral } from "#compiler/scalar/compute/evaluate.ts"
import { irLiteral } from "#compiler/scalar/compute/literal.ts"
import { contractPredicateTable } from "#compiler/scalar/compute/total.ts"
import { type ScalarEnv, scalarTypeOf } from "#compiler/scalar/registry.ts"
import type { WritableEntry } from "#compiler/schema/entry.ts"
import {
	type Owned,
	type OwnedEntry,
	type OwnedKey,
	type OwnedRelation,
	type OwnedRole,
	type OwnedWorldEntry,
	type OwnedWrite,
	own,
	ownRole
} from "#compiler/schema/own.ts"
import { regexMember, textLookup } from "#compiler/text/refinement.ts"

/** The refusal of a declared key whose index entry is unrepresentable, for `fault`, as ownership words it. */
const unrepresentableKey = (
	relation: string,
	key: DeclaredKey,
	fault: KeyFault,
	loc: SourceLoc
): never =>
	failWith({
		_tag: "UnrepresentableKey",
		at: loc,
		subject: `key (${key.join(", ")}) of ${relation}`,
		key,
		fault
	})

/**
 * A derived relation with its analysis (analysis/derived/analyze.ts): its definition checked against the levels below
 * it, its heading and its inherited keys, which a Base over its view reads (`analysis.read`).
 */
interface DerivedRelation {
	readonly kind: "derived"
	readonly name: string
	readonly loc: SourceLoc
	readonly analysis: DerivedRelationAnalysis
}

/**
 * A role's query entry with its analysis (analysis/derived/world.ts): its definition checked against the base, its
 * heading and its keys, which a Base over its view reads (`analysis.read`).
 */
interface WorldRelation {
	readonly kind: "world"
	readonly name: string
	readonly loc: SourceLoc
	readonly entry: OwnedWorldEntry
	readonly analysis: WorldAnalysis
}

/** A stored relation of an owned schema: an ordinary or a closed one. */
type OwnedStored = Exclude<OwnedRelation, { readonly kind: "derived" }>

/** A relation of an owned schema as its checked schema holds it: an ordinary, a closed or a derived relation. */
type BaseRelation = RelationInfo | ClosedRelation | DerivedRelation

/** A relation of the schema, of any kind. */
type SchemaRelation = BaseRelation | WorldRelation

/** A role's whole entry as ownership admitted it (schema/own.ts OwnedEntry). */
type WholeEntry = Extract<OwnedEntry, { readonly kind: "whole" }>

/**
 * One entry of a role over its base's checked schema: a whole entry with the base relation it holds, the base's own
 * handle or analysis; or a query entry with its analysis.
 */
export type RoleEntry =
	| { readonly kind: "whole"; readonly entry: WholeEntry; readonly relation: BaseRelation }
	| WorldRelation

/** A writable entry over its base's handles: its target's RelationInfo and its fields' handles (schema/entry.ts). */
export type CheckedEntry = WritableEntry<RelationInfo, LawField>

/**
 * One entry of a role's write list over its base's handles (schema/own.ts OwnedWrite): "whole", the base's ordinary
 * relation; "rows", a query entry with its writable entry.
 */
export type RoleWrite =
	| {
			readonly kind: "whole"
			readonly name: string
			readonly relation: RelationInfo
			readonly loc: SourceLoc
	  }
	| {
			readonly kind: "rows"
			readonly name: string
			readonly writable: CheckedEntry
			readonly loc: SourceLoc
	  }

/** A role's world: the owned role, its base's checked schema and its write list over the base's handles, by name. */
export interface RoleWorld {
	readonly kind: "role"
	readonly role: OwnedRole
	readonly base: CheckedSchema
	readonly writes: ReadonlyMap<string, RoleWrite>
}

/**
 * What a checked schema reads as: reality, an owned schema's relations; or a role, whose relations are its entries over
 * its base's checked schema.
 */
type CheckedWorld = { readonly kind: "reality" } | RoleWorld

const reality: CheckedWorld = Object.freeze({ kind: "reality" })

/**
 * A role's write list over `base`'s handles: the one site where ownership's writable-entry analysis, which names a
 * target and its fields (schema/entry.ts writableEntry), meets the base's handles, which every write and the
 * installation read. Ownership analyzed each entry over the base's description, so a name it gives is one the base
 * declares; one it does not is a malformed role.
 */
const roleWrites = (role: OwnedRole, base: CheckedSchema): ReadonlyMap<string, RoleWrite> => {
	const ordinary = (name: string, loc: SourceLoc): RelationInfo =>
		base.relations.get(name) ??
		fail("MalformedDescription", loc, `a write into an ordinary relation of the base, not ${name}`)
	const checkedWrite = (w: OwnedWrite): RoleWrite => {
		if (w.kind === "whole") {
			return { kind: "whole", name: w.name, relation: ordinary(w.relation.name, w.loc), loc: w.loc }
		}
		const owned = w.writable
		const target = ordinary(owned.target, w.loc)
		const byName = new Map(target.heading.map((f) => [f.name, f] as const))
		const field = (name: string): LawField =>
			byName.get(name) ??
			fail(
				"MalformedDescription",
				w.loc,
				`a writable entry over fields of ${target.name}, not ${name}`
			)
		const filter = owned.filter
		return {
			kind: "rows",
			name: w.name,
			writable: {
				entry: owned.entry,
				target,
				head: new Map(
					[...owned.head].map(
						([head, h]) => [head, { field: field(h.field), kind: h.kind }] as const
					)
				),
				fixed: owned.fixed.map((f) => ({ field: field(f.field), value: f.value })),
				filter: filter.kind === "none" ? filter : { ...filter, fields: filter.fields.map(field) }
			},
			loc: w.loc
		}
	}
	return new Map([...role.writes].map(([name, w]) => [name, checkedWrite(w)] as const))
}

/** Every descriptor inside `desc`: itself, a contract's base, a span's endpoint. */
const nestedFields = (desc: FieldDesc, visit: (d: FieldDesc) => void): void => {
	visit(desc)
	if (desc.kind === "contract") {
		nestedFields(desc.base, visit)
	} else if (desc.kind === "span") {
		nestedFields(desc.endpoint, visit)
	}
}

/**
 * The schema as the checker reads it (check/schema.ts SchemaReading), with its views analyzed.
 *
 * A query is checked against an owned schema (schema/own.ts) or an owned role: every relation it matches resolves to
 * a typed heading, and every descriptor it carries resolves to a ScalarType. CheckedSchema holds those readings, built
 * once per schema or role and shared by every query checked against it.
 *
 * - Worlds. Reality is an owned schema's own relations. A role's relations are its entries (schema/own.ts OwnedRole): a
 *   whole entry reads as the base relation of its name, a query entry as a world relation whose heading is its
 *   definition's head, checked against the base's CheckedSchema as a derived definition is. Types resolve against the
 *   base's rosters and contracts either way, so `owned` is the base's Owned for a role.
 *
 * - Headings. A Description's records are unordered: the canonical form sorts object keys, so a SchemaDesc read back
 *   from its text lists its fields in code-unit order whatever order the builder recorded. A stored
 *   relation's heading is therefore its fields in that canonical order, so one schema gives one heading however it
 *   arrived. A closed relation's heading is its handle column `id`, then its payload in canonical order, and its
 *   rows are the declared facts as typed literals in roster order.
 * - Types. A FieldDesc resolves through the descriptor registry (scalar/registry.ts) with the environment the
 *   registry leaves to the checker: the schema's closed rosters, the text package's canonical regex metadata (a
 *   proved tautology is the canonical wildcard), and each contract's predicate as the total-fragment
 *   table its ContractLiteral check evaluates. Regex membership of a constant is the text package's
 *   NFA, never RegExp.
 * - Query descriptors. A query may carry descriptors of its own: a Compute.cast target, a Compute.literal type, a
 *   relation parameter's heading, a context's fields. A contract named there with a descriptor other than the schema's,
 *   or than another descriptor of the same query, reuses one name for two descriptors: DuplicateIdentity. A closedId
 *   over a roster the schema does not declare is MalformedDescription.
 */
export class CheckedSchema<World extends CheckedWorld = CheckedWorld> implements SchemaReading {
	/** The owned schema whose rosters and contracts types resolve against: a role's base. */
	readonly owned: Owned
	readonly world: World
	/** The ordinary relations and the closed relations, each in name order: a role's are the ones it holds whole. */
	readonly relations: ReadonlyMap<string, RelationInfo>
	readonly closed: ReadonlyMap<string, ClosedRelation>
	/** A role's entries over its base, in name order; reality holds none. */
	readonly entries: ReadonlyArray<RoleEntry>
	/** The ordinary and closed relations' handles, in name order: what the theory's laws read. */
	readonly stored: ReadonlyArray<TheoryRelation>
	/** Every derived relation's analysis in refresh order's levels, level then name: a role's are its base's. */
	readonly derived: ReadonlyArray<DerivedRelationAnalysis>
	/** Every relation held as a base relation, by name: reality's own, or the ones a role holds whole. */
	readonly #held: ReadonlyMap<string, BaseRelation>
	/** A role's query entries, by name. */
	readonly #worlds: ReadonlyMap<string, WorldRelation>
	readonly #rosters = new Map<string, ReadonlyArray<string>>()

	/**
	 * Reality holds its stored relations, then each derived relation analyzed in level order against the relations held
	 * so far: a definition reads only the levels below its own (schema/own.ts), so each Base it reads finds its view's
	 * keys. A role holds its whole entries as its base's relations, and each query entry analyzed against its base.
	 */
	constructor(owned: Owned, world: World) {
		this.owned = owned
		this.world = world
		for (const r of Object.values(owned.relations)) {
			if (r.desc.kind === "closed") {
				this.#rosters.set(r.name, r.desc.handles)
			}
		}
		const relations = new Map<string, RelationInfo>()
		const closed = new Map<string, ClosedRelation>()
		const held = new Map<string, BaseRelation>()
		const worlds = new Map<string, WorldRelation>()
		const stored: Array<TheoryRelation> = []
		this.relations = relations
		this.closed = closed
		this.stored = stored
		this.#held = held
		this.#worlds = worlds
		const hold = (info: BaseRelation): void => {
			held.set(info.name, info)
			if (info.kind === "relation") {
				relations.set(info.name, info)
				stored.push(info)
			} else if (info.kind === "closed") {
				closed.set(info.name, info)
				stored.push(info.relation)
			}
		}
		const byName = mapInput(compareStrings, (named: { readonly name: string }) => named.name)
		const read: CheckedWorld = world
		if (read.kind === "role") {
			this.derived = read.base.derived
			this.entries = Object.values(read.role.relations)
				.toSorted(byName)
				.map((e): RoleEntry =>
					e.kind === "whole"
						? { kind: "whole", entry: e, relation: read.base.#baseRelation(e.relation.name, e.loc) }
						: {
								kind: "world",
								name: e.name,
								loc: e.loc,
								entry: e,
								analysis: unwrap(analyzeWorld(read.base, e))
							}
				)
			for (const e of this.entries) {
				if (e.kind === "whole") {
					hold(e.relation)
				} else {
					worlds.set(e.name, e)
				}
			}
			return
		}
		this.entries = []
		const ownedRelations = Object.values(owned.relations)
		for (const r of ownedRelations
			.flatMap((o): ReadonlyArray<OwnedStored> => (o.kind === "derived" ? [] : [o]))
			.toSorted(byName)) {
			hold(this.#relationInfo(r))
		}
		const derived: Array<DerivedRelationAnalysis> = []
		this.derived = derived
		for (const r of ownedRelations
			.flatMap((o) => (o.kind === "derived" ? [o] : []))
			.toSorted((a, b) =>
				a.desc.level === b.desc.level ? compareText(a.name, b.name) : a.desc.level - b.desc.level
			)) {
			const analysis = unwrap(analyzeDerivedRelation(this, r))
			derived.push(analysis)
			hold({ kind: "derived", name: r.name, loc: r.loc, analysis })
		}
	}

	/** A relation of this schema a role over it holds whole, with its handles: the role reads the base's own. */
	#baseRelation(name: string, loc: SourceLoc): BaseRelation {
		return (
			this.#held.get(name) ??
			fail("MalformedDescription", loc, `a whole entry over a relation of the base, not ${name}`)
		)
	}

	/** The checked schema a derived or world definition is checked against: reality's own, or a role's base. */
	definitions(): CheckedSchema {
		const read: CheckedWorld = this.world
		return read.kind === "role" ? read.base : this
	}

	#relationInfo(r: OwnedStored): RelationInfo | ClosedRelation {
		const name = r.name
		const loc = r.loc
		const at = (field: string) => childLoc(loc, "fields", field)
		const declared = Object.values(r.fields).map((f, position): LawField => ({
			name: f.name,
			type: this.fieldType(f.desc, at(f.name)),
			desc: f.desc,
			column: f.column,
			position
		}))
		if (!isNonEmpty(declared)) {
			return fail("MalformedDescription", loc, "a relation with at least one field")
		}
		/** A declared key's fields resolved to their handles, refused when it names a field the relation lacks or one of a
		 * vector type, whose index entry is unrepresentable as ownership's representability already refuses. */
		const keyed = (key: DeclaredKey): NonEmptyReadonlyArray<KeyField> =>
			mapNonEmpty(key, (k) => {
				const field =
					declared.find((f) => f.name === k) ??
					fail("MalformedDescription", loc, `a key over fields of ${name}; ${k} is not one`)
				return isKeyField(field)
					? field
					: unrepresentableKey(name, key, { kind: "vector", field: k }, loc)
			})
		/** A declared key's handles and its one span field, refused for two as ownership's representability already does. */
		const keyName = (k: OwnedKey): KeyName => {
			const fields = keyed(k.fields)
			const [span, ...more] = fields.filter(isSpanField)
			if (more.length > 0) {
				return unrepresentableKey(
					name,
					k.fields,
					{ kind: "spans", fields: fields.filter(isSpanField).map((f) => f.name) },
					loc
				)
			}
			return { fields, span, primary: k.primary, named: k.named }
		}
		const byName = mapInput(compareStrings, (f: LawField) => f.name)
		if (r.kind === "relation") {
			const heading = sortNonEmpty(declared, byName)
			const candidates = r.keys.filter((k) => !k.primary)
			return {
				kind: "relation",
				name,
				ident: r.ident,
				fields: declared,
				keyNames: mapNonEmpty(r.keys, keyName),
				heading,
				primaryKey: r.desc.primaryKey,
				keys: candidates.map((k) => k.fields),
				primaryFields: keyed(r.desc.primaryKey),
				keyFields: candidates.map((k) => keyed(k.fields)),
				mutable: r.mutable,
				level: r.level,
				serial: heading.flatMap((f) => (f.desc.kind === "serial" ? [f.name] : [])),
				loc
			}
		}
		const desc = r.desc
		const primaryFields = keyed(["id"])
		const [id] = primaryFields
		const payload = declared.filter((f) => f !== id).toSorted(byName)
		const relation: ClosedTheoryRelation = {
			kind: "closed",
			name,
			ident: r.ident,
			fields: declared,
			keyNames: [],
			heading: [id, ...payload],
			primaryKey: ["id"],
			keys: [],
			primaryFields,
			keyFields: [],
			mutable: false,
			level: r.level,
			loc,
			handles: desc.handles,
			rows: desc.handles.map((handle) =>
				declared.map((f) => {
					const value: LiteralDesc | undefined = f === id ? handle : desc.facts[handle]?.[f.name]
					const typed = value === undefined ? undefined : irLiteral(value, f.type)
					if (typed === undefined || !typed.ok) {
						return fail(
							"MalformedDescription",
							loc,
							`a fact of ${name}.${handle} for ${f.name} of its type`
						)
					}
					return typed.value.literal
				})
			)
		}
		const rows = desc.handles.map((handle): ClosedRelation["rows"][number] => [
			{ kind: "enum", handle },
			...payload.map((f) => {
				const value = desc.facts[handle]?.[f.name]
				if (value === undefined) {
					return fail(
						"MalformedDescription",
						at(f.name),
						`a payload value of ${name}.${handle} for ${f.name}`
					)
				}
				return this.literal(value, f.type, childLoc(loc, "facts", handle, f.name))
			})
		])
		return { kind: "closed", relation, name, heading: headingColumns(relation.heading), rows, loc }
	}

	/**
	 * A relation of the schema or role by name. A role reads only its own relations: one of its base it does not hold
	 * is outside the role (OutsideRole), as a write outside its write list is.
	 */
	relation(name: string, loc: SourceLoc): SchemaRelation {
		const r = this.#held.get(name) ?? this.#worlds.get(name)
		if (r !== undefined) {
			return r
		}
		const world: CheckedWorld = this.world
		if (world.kind === "role" && world.base.#held.has(name)) {
			return failWith({
				_tag: "OutsideRole",
				at: loc,
				role: world.role.name,
				access: { kind: "read", relation: name, base: world.base.owned.name }
			})
		}
		return fail(
			"MalformedDescription",
			loc,
			`a relation the schema declares, not ${JSON.stringify(name)}`
		)
	}

	readonly #env: ScalarEnv = {
		kind: "schema",
		roster: (name) => this.#rosters.get(name),
		text: textLookup,
		contractPredicate: (predicate, base, contract): Result.Result<ExprTable, CompileError> =>
			contractPredicateTable(predicate, base, contract, {
				loc: SourceLoc(`contract ${contract}`, []),
				fieldType: (d, at) => scalarTypeOf(d, this.#env, at),
				regexMember
			})
	}

	/** The ScalarType of a schema descriptor. */
	fieldType(desc: FieldDesc, loc: SourceLoc): ScalarType {
		return unwrap(scalarTypeOf(desc, this.#env, loc))
	}

	/**
	 * A literal of a declared value: the typed IR literal, checked against the type's contract and regex
	 * (ContractLiteral).
	 *
	 * Construction checks the literal's host kind and gives it the value its field stores: a JavaScript number for a
	 * bigint or numeric type, a non-integer or out-of-range integer, or a numeric(p, s) overflow is a malformed literal
	 * whatever contract the type carries (MalformedDescription). Only a well-formed literal
	 * that the contract's predicate or the regex refinement refuses is ContractLiteral.
	 */
	literal(value: LiteralDesc, type: ScalarType, loc: SourceLoc): TypedLiteral {
		const admitted = admitLiteral(value, type, { kind: "refinements", regexMember })
		if (!admitted.ok) {
			return fail(admitted.error.reason, loc, admitted.error.capability)
		}
		return admitted.value.literal
	}

	/** Whether a literal is a value of `type`: one `literal` admits at it rather than refuses. */
	admits(value: LiteralDesc, type: ScalarType): boolean {
		return admitLiteral(value, type, { kind: "refinements", regexMember }).ok
	}

	/**
	 * A descriptor a query carries. Its closedIds name the schema's rosters, and a contract it names is the schema's
	 * contract of that name, or one the same query declares once (`seen`), with one descriptor.
	 */
	queryFieldType(
		desc: FieldDesc,
		loc: SourceLoc,
		seen: Map<string, { text: string; loc: SourceLoc }>
	): ScalarType {
		nestedFields(desc, (d) => {
			if (d.kind !== "contract") {
				return
			}
			const text = unwrap(descText(d))
			const declared = this.owned.contracts[d.name]
			if (declared !== undefined) {
				if (unwrap(descText(declared.desc)) !== text) {
					failWith({
						_tag: "DuplicateIdentity",
						at: loc,
						duplicate: { kind: "contract", name: d.name, earlier: declared.loc }
					})
				}
				return
			}
			const prior = seen.get(d.name)
			if (prior === undefined) {
				seen.set(d.name, { text, loc })
			} else if (prior.text !== text) {
				failWith({
					_tag: "DuplicateIdentity",
					at: loc,
					duplicate: { kind: "contract", name: d.name, earlier: prior.loc }
				})
			}
		})
		return this.fieldType(desc, loc)
	}
}

/** The derived analysis of a checked schema, which analyzed each derived relation when it was built: the analyses by
 * name and in refresh order's levels, level then name. */
export interface DerivedAnalysis {
	readonly schema: CheckedSchema
	readonly relations: Readonly<Record<string, DerivedRelationAnalysis>>
	readonly order: ReadonlyArray<DerivedRelationAnalysis>
}

/** The derived analysis of a checked schema: the analyses it holds, by name and in refresh order. */
export const derivedAnalysis = (schema: CheckedSchema): DerivedAnalysis => ({
	schema,
	relations: Object.fromEntries(schema.derived.map((a) => [a.name, a] as const)),
	order: schema.derived
})

/** The checker's reading of an owned schema. A pass that reads it again takes the one its caller holds (program/schema.ts
 * SchemaArtifacts.checked, the installation's builder), never this again. */
export const checkedSchema = (owned: Owned): Result.Result<CheckedSchema, CompileError> =>
	catchRefusal(() => new CheckedSchema(owned, reality))

/** The checker's reading of a schema description, owned first, with ownership's refusals passed through. */
export const checkedDesc = (desc: SchemaDesc): Result.Result<CheckedSchema, CompileError> =>
	Result.flatMap(own(desc), checkedSchema)

/** The checker's reading of an owned role, over its base's reading `base` (checkedSchema of role.base). */
export const checkedRoleOver = (
	role: OwnedRole,
	base: CheckedSchema
): Result.Result<CheckedSchema<RoleWorld>, CompileError> =>
	catchRefusal(
		() => new CheckedSchema(role.base, { kind: "role", role, base, writes: roleWrites(role, base) })
	)

/** The checker's reading of an owned role, over its base's reading. */
const checkedRole = (role: OwnedRole): Result.Result<CheckedSchema, CompileError> =>
	Result.flatMap(checkedSchema(role.base), (base) => checkedRoleOver(role, base))

/** The checker's reading of a role description, owned first, with ownership's refusals passed through. */
export const checkedRoleDesc = (desc: RoleDesc): Result.Result<CheckedSchema, CompileError> =>
	Result.flatMap(ownRole(desc), checkedRole)
