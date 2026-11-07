import {
	analyzeDerivedRelation,
	type DerivedRelationAnalysis
} from "#compiler/analysis/derived/analyze.ts"
import { analyzeWorld, type WorldAnalysis } from "#compiler/analysis/derived/world.ts"
import { closedReads, closedReadsAmong } from "#compiler/check/closed.ts"
import { fail, failWith, unwrap } from "#compiler/check/fail.ts"
import {
	closedReadNames,
	generatedRule,
	generatedTypeRule,
	rowNode
} from "#compiler/check/generated.ts"
import type { ClosedRelation, SchemaReading } from "#compiler/check/schema.ts"
import { catchRefusal, compareText } from "#compiler/core/canonical.ts"
import type { GeneratedRule, KeyFault } from "#compiler/core/causes.ts"
import { type CompileError, malformedDescription } from "#compiler/core/errors.ts"
import { defined } from "#compiler/core/invariant.ts"
import { childLoc, labeledChildLoc, SourceLoc } from "#compiler/core/loc.ts"
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
	type ExprDesc,
	type FieldDesc,
	type KeySlotDesc,
	type LiteralDesc
} from "#compiler/ir/desc.ts"
import type { ExprTable, TypedLiteral } from "#compiler/ir/expr.ts"
import {
	type ClosedSlot,
	type ClosedTheoryRelation,
	type FieldWriting,
	headingColumns,
	isSpanField,
	type KeyName,
	type LawField,
	type RelationInfo,
	type TheoryRelation
} from "#compiler/ir/law.ts"
import { closedCell, type DeclaredKey } from "#compiler/ir/rel.ts"
import { Roster, type ScalarType, sameScalarType, typeLabel } from "#compiler/ir/scalar.ts"
import { admitLiteral, refined } from "#compiler/scalar/compute/evaluate.ts"
import { admittedLiteral } from "#compiler/scalar/compute/literal.ts"
import {
	type ClosedRelations,
	exprEmitter,
	type LeafDesc,
	lowerTerm,
	noParams
} from "#compiler/scalar/compute/lower.ts"
import { binaryCoercion } from "#compiler/scalar/compute/registry.ts"
import { contractPredicateTable } from "#compiler/scalar/compute/total.ts"
import { isNaturalDesc } from "#compiler/scalar/natural.ts"
import { CompilePatterns, type PatternAutomata } from "#compiler/scalar/regex/patterns.ts"
import { type ScalarEnv, scalarTypeOf } from "#compiler/scalar/registry.ts"
import type { WritableEntry } from "#compiler/schema/entry.ts"
import type {
	Owned,
	OwnedEntry,
	OwnedKey,
	OwnedRelation,
	OwnedRole,
	OwnedWorldEntry,
	OwnedWrite
} from "#compiler/schema/own.ts"
import { textLookup } from "#compiler/text/refinement.ts"

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

/** A stored relation of an owned schema: an ordinary relation, a roster or a closed relation. */
type OwnedStored = Exclude<OwnedRelation, { readonly kind: "derived" }>

/** An ordinary relation of an owned schema. */
type OwnedOrdinary = Extract<OwnedRelation, { readonly kind: "relation" }>

/** A field of an owned stored relation: its descriptor, its column and how it is written. */
type OwnedField = OwnedStored["fields"][string]

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

/** Where a generated field's refusal is: the field of its relation. */
const generatedLoc = (r: OwnedRelation, field: string): SourceLoc =>
	labeledChildLoc(r.loc, field, `generated field ${r.name}.${field}`)

/** The refusal of generated field `field` of `r` for breaking `rule` (check/generated.ts). */
const generatedRefused = (r: OwnedRelation, field: string, rule: GeneratedRule): never =>
	failWith({ _tag: "GeneratedRefused", at: generatedLoc(r, field), relation: r.name, field, rule })

/** How a field its caller writes is written: by its caller, never by PostgreSQL. */
const callerWriting: FieldWriting = Object.freeze({ kind: "caller" })

/** How a serial field is written: by its sequence. */
const serialWriting: FieldWriting = Object.freeze({ kind: "serial" })

/** How a drawn field is written: by grizzle, from the nested arrays. */
const drawnWriting: FieldWriting = Object.freeze({ kind: "drawn" })

/**
 * What a generated field's expression reads: each written field's type (undefined for a generated field or no field),
 * the closed relations it applies, and whether a closed relation it names is declared above its own relation's level.
 */
interface GenerationRow {
	readonly written: (field: string) => ScalarType | undefined
	readonly closed: ClosedRelations
	readonly above: (relation: string) => boolean
}

/** Fields in canonical order, by name in code units: a heading's order. */
const byFieldName = mapInput(compareStrings, (f: LawField) => f.name)

/**
 * The handles of a key over the fields `declared` of relation `relation`, in key order, refused when it names a field
 * the relation lacks.
 */
const keyedBy =
	(relation: string, loc: SourceLoc, declared: ReadonlyArray<LawField>) =>
	(key: DeclaredKey): NonEmptyReadonlyArray<LawField> =>
		mapNonEmpty(
			key,
			(k) =>
				declared.find((f) => f.name === k) ??
				fail("MalformedDescription", loc, `a key over fields of ${relation}; ${k} is not one`)
		)

/** What a leaf other than a field reads, as a refusal names it. */
const leafText = (leaf: LeafDesc): string => {
	switch (leaf.kind) {
		case "field":
			return `field ${leaf.field}`
		case "var":
			return `variable ${leaf.var}`
		case "value":
			return "a contract's value"
		case "parent":
			return `parent column ${leaf.column}`
	}
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
 *   definition's head, checked against the base's CheckedSchema as a derived definition is. A closed relation is no
 *   role's entry: every role reads its base's closed relations, by a match and by C.at and C.row. Types resolve
 *   against the base's rosters and contracts either way, so `owned` is the base's Owned for a role.
 *
 * - Headings. A Description's records are unordered: the canonical form sorts object keys, so a SchemaDesc read back
 *   from its text lists its fields in code-unit order whatever order the builder recorded. An ordinary relation's
 *   heading is therefore its fields in that canonical order, so one schema gives one heading however it arrived. A
 *   closed relation's heading is its key fields in key order, then its payload in canonical order, and its rows are its
 *   declared rows as typed literals, held in its key's text order (schema/own.ts). A roster is the closed relation
 *   whose one field `id` is a closed id of itself, with one row per handle in roster order.
 * - Writings. Each field of an ordinary relation says how it is written (ir/law.ts FieldWriting): by its caller, by
 *   its sequence, drawn by grizzle (a natural), accumulated on the host from a start literal of its type, or generated
 *   by PostgreSQL from its row (check/generated.ts). A generated field's expression is refused, as GeneratedRefused,
 *   when it reads an input beyond its row or a generated field, and when it is typed (in "check" mode, over its row's
 *   written fields and the closed relations of its level or below) to another type than the field declares. Its
 *   writing holds the typed expression, whose column leaves name the row (`rowNode`).
 * - Types. A FieldDesc resolves through the descriptor registry (scalar/registry.ts) with the environment the
 *   registry leaves to the checker: the schema's rosters, the text package's canonical regex metadata (a
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
	/** The ordinary relations, in name order: a role's are the ones it holds whole. */
	readonly relations: ReadonlyMap<string, RelationInfo>
	/**
	 * The closed relations, rosters among them, in name order: reality's own; a role's, the rosters it holds whole and
	 * every closed relation of its base.
	 */
	readonly closed: ReadonlyMap<string, ClosedRelation>
	/** The closed relations C.at and C.row apply, by name: every closed relation (no roster) the schema reads. */
	readonly closedReads: ClosedRelations
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
	readonly #rosters = new Map<string, Roster>()

	/**
	 * Reality holds its stored relations: its rosters and closed relations first, which a generated field's expression
	 * reads, then its ordinary relations, each in name order; then each derived relation analyzed in level order against
	 * the relations held so far: a definition reads only the levels below its own (schema/own.ts), so each Base it reads
	 * finds its view's keys. A role holds its whole entries as its base's relations, each query entry analyzed against
	 * its base, and its base's closed relations.
	 */
	constructor(owned: Owned, world: World) {
		this.owned = owned
		this.world = world
		for (const r of Object.values(owned.relations)) {
			if (r.desc.kind === "closed") {
				this.#rosters.set(r.name, new Roster(r.name, r.desc.handles))
			}
		}
		const relations = new Map<string, RelationInfo>()
		const closed = new Map<string, ClosedRelation>()
		const held = new Map<string, BaseRelation>()
		const worlds = new Map<string, WorldRelation>()
		this.relations = relations
		this.closed = closed
		this.#held = held
		this.#worlds = worlds
		const byName = mapInput(compareStrings, (named: { readonly name: string }) => named.name)
		const read: CheckedWorld = world
		const stored: Array<TheoryRelation> = []
		this.stored = stored
		/** Holds a base relation: an ordinary relation and a roster held whole are what the theory's laws read. */
		const hold = (info: BaseRelation, theory: boolean): void => {
			held.set(info.name, info)
			if (info.kind === "relation") {
				relations.set(info.name, info)
				stored.push(info)
			} else if (info.kind === "closed") {
				closed.set(info.name, info)
				if (theory) {
					stored.push(info.relation)
				}
			}
		}
		if (read.kind === "role") {
			this.derived = read.base.derived
			this.closedReads = read.base.closedReads
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
			const reads: Array<{ readonly info: BaseRelation; readonly whole: boolean }> = []
			for (const e of this.entries) {
				if (e.kind === "whole") {
					reads.push({ info: e.relation, whole: true })
				} else {
					worlds.set(e.name, e)
				}
			}
			for (const c of read.base.closed.values()) {
				if (!this.#rosters.has(c.name)) {
					reads.push({ info: c, whole: false })
				}
			}
			for (const r of reads.toSorted(mapInput(compareStrings, (x) => x.info.name))) {
				hold(r.info, r.whole)
			}
			return
		}
		this.entries = []
		const ownedRelations = Object.values(owned.relations)
		const ownedStored = ownedRelations
			.flatMap((o): ReadonlyArray<OwnedStored> => (o.kind === "derived" ? [] : [o]))
			.toSorted(byName)
		const patterns = new CompilePatterns()
		const closedInfos = ownedStored.flatMap((r) =>
			r.kind === "relation" ? [] : [this.#closedInfo(r, patterns)]
		)
		const readable = closedInfos.filter((c) => !this.#rosters.has(c.name))
		this.closedReads = closedReads(readable)
		const ordinaryInfos = ownedStored.flatMap((r) =>
			r.kind === "relation" ? [this.#ordinaryInfo(r, readable, patterns)] : []
		)
		for (const info of [...closedInfos, ...ordinaryInfos].toSorted(byName)) {
			hold(info, true)
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
			hold({ kind: "derived", name: r.name, loc: r.loc, analysis }, true)
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

	/**
	 * A stored relation's fields as LawFields, in declared order: each typed, then written as `writing` says, called in
	 * field-name order (code units), so the first refusal it makes is of the least field it refuses.
	 */
	#lawFields(
		r: OwnedStored,
		writing: (field: OwnedField, type: ScalarType, loc: SourceLoc) => FieldWriting,
		patterns: PatternAutomata
	): NonEmptyReadonlyArray<LawField> {
		const typed = Object.values(r.fields).map((f, position) => {
			const at = childLoc(r.loc, "fields", f.name)
			return { f, position, at, type: this.#typeOf(f.desc, at, patterns) }
		})
		const fields = typed
			.toSorted(mapInput(compareStrings, (t) => t.f.name))
			.map(({ f, position, at, type }): LawField => ({
				name: f.name,
				type,
				desc: f.desc,
				column: f.column,
				position,
				writing: writing(f, type, at)
			}))
			.toSorted((a, b) => a.position - b.position)
		if (!isNonEmpty(fields)) {
			return fail("MalformedDescription", r.loc, "a relation with at least one field")
		}
		return fields
	}

	/**
	 * An ordinary relation's RelationInfo: its fields typed and written (#writing), and its declared keys resolved to
	 * their handles.
	 *
	 * Every generated field is checked against the generated-field rule first, in field-name order (code units), and
	 * only then is any field typed: so the refusal of a relation whose generated fields read one another names the least
	 * generated field that reads one and the least one it reads, whatever their types.
	 */
	#ordinaryInfo(
		r: OwnedOrdinary,
		readable: ReadonlyArray<ClosedRelation>,
		patterns: PatternAutomata
	): RelationInfo {
		const name = r.name
		const loc = r.loc
		const generated = new Set<string>(
			Object.values(r.fields).flatMap((f) => (f.writing.kind === "generated" ? [f.name] : []))
		)
		const isGenerated = (f: string): boolean => generated.has(f)
		/** A field grizzle writes on the host, which no generation expression reads. */
		const unwritten = (f: string): "drawn" | "accumulated" | undefined => {
			const writing = r.fields[f]?.writing.kind
			return writing === "drawn" || writing === "accumulated" ? writing : undefined
		}
		for (const f of Object.values(r.fields).toSorted(mapInput(compareStrings, (x) => x.name))) {
			const broken =
				f.writing.kind === "generated"
					? generatedRule(f.writing.expr, isGenerated, unwritten)
					: undefined
			if (broken !== undefined) {
				generatedRefused(r, f.name, broken)
			}
		}
		const below = readable.filter((c) => c.relation.level <= r.level)
		const row: GenerationRow = {
			written: (f) => {
				const field = r.fields[f]
				return field === undefined || isGenerated(f)
					? undefined
					: this.#typeOf(field.desc, childLoc(loc, "fields", f), patterns)
			},
			closed: closedReadsAmong(this.closedReads, below),
			above: (c) => readable.some((x) => x.name === c) && !below.some((x) => x.name === c)
		}
		const declared = this.#lawFields(
			r,
			(f, type, at) => this.#writing(r, f, type, at, row, patterns),
			patterns
		)
		const keyed = keyedBy(name, loc, declared)
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
		const heading = sortNonEmpty(declared, byFieldName)
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
			loc
		}
	}

	/**
	 * How an ordinary relation's field of type `type` is written (desc.ts Writing, resolved as law.ts FieldWriting): by
	 * its caller; by its sequence, a serial's integer; drawn by grizzle, a natural (a family's index or count, a tree's
	 * start or end); accumulated, filled on the host from its start, a literal of its type, at its axis's base, over no
	 * span or vector, which no fold combines and no copy carries; or generated by PostgreSQL (#generated). Which
	 * statement names a drawn or an accumulated field is the theory's to resolve (analysis/theory).
	 */
	#writing(
		r: OwnedOrdinary,
		f: OwnedField,
		type: ScalarType,
		at: SourceLoc,
		row: GenerationRow,
		patterns: PatternAutomata
	): FieldWriting {
		const w = f.writing
		switch (w.kind) {
			case "caller":
				return callerWriting
			case "serial":
				return serialWriting
			case "drawn":
				if (!isNaturalDesc(f.desc)) {
					return fail(
						"MalformedDescription",
						at,
						`a drawn field of type natural, the index, count, start or end grizzle draws; ${r.name}.${f.name} is ${typeLabel(type)}`
					)
				}
				return drawnWriting
			case "accumulated":
				if (f.desc.kind === "span" || f.desc.kind === "vector") {
					return fail(
						"MalformedDescription",
						at,
						`an accumulated field of a type a fold combines or a copy carries, no span or vector; ${r.name}.${f.name} is ${typeLabel(type)}`
					)
				}
				return {
					kind: "accumulated",
					start: this.literal(w.start, type, childLoc(at, "writing", "start"), patterns)
				}
			case "generated":
				return this.#generated(r, f.name, w.expr, type, row, patterns)
		}
	}

	/**
	 * A generated field's writing: its expression, which keeps the generated-field rule (#ordinaryInfo checked it), typed
	 * in "check" mode over its row, each field a column of `rowNode` of its written type, and the closed relations it may
	 * apply, and held at its declared type. A Compute.base emits no node of its own, so where the node still carries the
	 * contract the term drops, the expression casts it, as a query's head does.
	 */
	#generated(
		r: OwnedOrdinary,
		field: string,
		expr: ExprDesc,
		declared: ScalarType,
		row: GenerationRow,
		patterns: PatternAutomata
	): FieldWriting {
		const loc = generatedLoc(r, field)
		const above = closedReadNames(expr).find(row.above)
		if (above !== undefined) {
			return fail(
				"MalformedDescription",
				loc,
				`a closed read of a closed relation of this level or below; ${above} is declared above`
			)
		}
		const seen = new Map<string, { text: string; loc: SourceLoc }>()
		const emit = exprEmitter(`generated ${r.name}.${field}`)
		const term = unwrap(
			lowerTerm(expr, {
				mode: "check",
				loc,
				emit,
				leaf: (d, l) => {
					const type = d.kind === "field" ? row.written(d.field) : undefined
					if (d.kind !== "field" || type === undefined) {
						return Result.err(
							malformedDescription(l, `a written field of ${r.name}, not ${leafText(d)}`)
						)
					}
					return Result.ok({
						kind: "column",
						column: { node: rowNode, name: d.field },
						args: [],
						type,
						nonNull: "storage"
					})
				},
				params: noParams,
				fieldType: (d, l) => catchRefusal(() => this.queryFieldType(d, l, seen, patterns)),
				closed: row.closed,
				patterns,
				patternLanguage: textLookup
			})
		)
		const mismatch = generatedTypeRule(declared, term.nominal)
		if (mismatch !== undefined) {
			return generatedRefused(r, field, mismatch)
		}
		return {
			kind: "generated",
			expr: sameScalarType(term.expr.type, term.nominal)
				? term.expr
				: emit({
						kind: "cast",
						cast: binaryCoercion,
						args: [term.expr],
						type: term.nominal,
						nonNull: "strict",
						volatility: "immutable"
					})
		}
	}

	/**
	 * A roster's or a closed relation's reading. A roster is the closed relation whose one field `id` is a closed id of
	 * itself, keyed by it, one row per handle in roster order. A closed relation's key is its declared key in key order,
	 * its rows its declared rows in its key's text order, each value a literal of its field's type, its base proved where
	 * the relation was admitted and its refinements judged here (#admittedCell).
	 * Its heading is its key fields, then its payload in canonical order; its theory rows list the same literals in
	 * declared field order.
	 */
	#closedInfo(r: Exclude<OwnedStored, OwnedOrdinary>, patterns: PatternAutomata): ClosedRelation {
		const name = r.name
		const loc = r.loc
		const declared = this.#lawFields(r, () => callerWriting, patterns)
		const keyed = keyedBy(name, loc, declared)
		const desc = r.desc
		const primaryFields = desc.kind === "closed" ? keyed(["id"]) : keyed(desc.key)
		const payload = declared.filter((f) => !primaryFields.includes(f)).toSorted(byFieldName)
		const heading: NonEmptyReadonlyArray<LawField> = [...primaryFields, ...payload]
		const literals: ReadonlyArray<Readonly<Record<string, LiteralDesc>>> =
			desc.kind === "closed" ? desc.handles.map((handle) => ({ id: handle })) : desc.rows
		const rows = literals.map((row, i) =>
			declared.map((f) => {
				const value = row[f.name]
				if (value === undefined) {
					return fail("MalformedDescription", loc, `row ${i} of ${name} with a value of ${f.name}`)
				}
				return this.#admittedCell(value, f.type, childLoc(loc, "rows", i, f.name), patterns)
			})
		)
		const relation: ClosedTheoryRelation = {
			kind: "closed",
			name,
			fields: declared,
			keyNames: [],
			heading,
			primaryKey: mapNonEmpty(primaryFields, (f) => f.name),
			keys: [],
			primaryFields,
			keyFields: [],
			mutable: false,
			level: r.level,
			loc,
			rows,
			slots:
				desc.kind === "closed"
					? []
					: desc.slots.map((slot) => this.#slot(slot, primaryFields, loc, patterns))
		}
		return {
			kind: "closed",
			relation,
			name,
			heading: headingColumns(heading),
			rows: rows.map((row) => heading.map((f) => closedCell(row, f.position))),
			loc
		}
	}

	/**
	 * A closed relation's slot, fin(O, n), with each owner O holds a row for and its count: O's key pairs with the
	 * relation's first key fields (schema/own.ts), so each owner's key values are literals of those fields' types, and its
	 * count is O's natural n.
	 */
	#slot(
		slot: KeySlotDesc,
		key: NonEmptyReadonlyArray<LawField>,
		loc: SourceLoc,
		patterns: PatternAutomata
	): ClosedSlot {
		const declared = this.owned.relations[slot.fin.owner]
		if (declared?.kind !== "closedRelation") {
			return fail(
				"MalformedDescription",
				loc,
				`a closed relation ${slot.fin.owner}, whose count numbers slots`
			)
		}
		const owner = declared.desc
		const fields = mapNonEmpty(owner.key, (field, i) => ({
			field,
			own: defined(key[i], "an owner's key pairs with the relation's first key fields")
		}))
		const countType = defined(
			this.#lawFields(declared, () => callerWriting, patterns).find(
				(f) => f.name === slot.fin.count
			),
			"a slot's count is a field of its owner"
		).type
		return {
			field: slot.field,
			fin: { relation: owner.name, count: slot.fin.count },
			owner: mapNonEmpty(fields, (f) => f.own.name),
			counts: owner.rows.map((row, i) => {
				const at = childLoc(owner.loc, "rows", i, slot.fin.count)
				const count = this.#admittedCell(
					defined(row[slot.fin.count], "a row's count"),
					countType,
					at,
					patterns
				)
				return {
					owner: mapNonEmpty(fields, (f) =>
						this.#admittedCell(defined(row[f.field], "a row's key value"), f.own.type, at, patterns)
					),
					count:
						count.kind === "int" ? count.value : fail("MalformedDescription", at, "a natural count")
				}
			})
		}
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

	/** The descriptor registry's reading of the schema, its contracts' predicates typed by `patterns`. */
	#env(patterns: PatternAutomata): ScalarEnv {
		const env: ScalarEnv = {
			kind: "schema",
			roster: (name) => this.#rosters.get(name),
			contractPredicate: (
				predicate,
				base,
				contract,
				facts
			): Result.Result<ExprTable, CompileError> =>
				contractPredicateTable(predicate, base, contract, facts, {
					loc: SourceLoc(`contract ${contract}`, []),
					fieldType: (d, at) => scalarTypeOf(d, env, at),
					patterns,
					patternLanguage: textLookup
				})
		}
		return env
	}

	/** The ScalarType of a descriptor, by the admitted patterns of the caller's compile. */
	#typeOf(desc: FieldDesc, loc: SourceLoc, patterns: PatternAutomata): ScalarType {
		return unwrap(scalarTypeOf(desc, this.#env(patterns), loc))
	}

	/** The ScalarType of a schema descriptor, typed as a compile of its own. */
	fieldType(desc: FieldDesc, loc: SourceLoc): ScalarType {
		return this.#typeOf(desc, loc, new CompilePatterns())
	}

	/**
	 * A literal of a declared value: the typed IR literal, checked against the type's contract and regex
	 * (ContractLiteral).
	 *
	 * Construction checks the literal's host kind and gives it the value its field stores: a JavaScript number for a
	 * bigint or numeric type, a non-integer or out-of-range integer, or a numeric(p, s) overflow is a malformed literal
	 * whatever contract the type carries (MalformedDescription). Only a well-formed literal
	 * that the contract's predicate or the regex refinement refuses is ContractLiteral, judged by `patterns`, the admitted
	 * patterns of the caller's compile.
	 */
	literal(
		value: LiteralDesc,
		type: ScalarType,
		loc: SourceLoc,
		patterns: PatternAutomata
	): TypedLiteral {
		const admitted = admitLiteral(value, type, { kind: "refinements", patterns })
		if (!admitted.ok) {
			return fail(admitted.error.reason, loc, admitted.error.capability)
		}
		return admitted.value.literal
	}

	/**
	 * A cell of a closed relation or a roster, each admitted (ir/desc.ts AdmittedClosedRelation, a roster's rows its own
	 * handles): converted at its field's type and never held to the type's base again (scalar/compute/literal.ts
	 * admittedLiteral). Only the type's refinements, a contract's predicate and a pattern, which only a schema reads, are
	 * judged here (ContractLiteral).
	 */
	#admittedCell(
		value: LiteralDesc,
		type: ScalarType,
		loc: SourceLoc,
		patterns: PatternAutomata
	): TypedLiteral {
		const judged = refined(admittedLiteral(value, type), type, patterns)
		if (!judged.ok) {
			return fail(judged.error.reason, loc, judged.error.capability)
		}
		return judged.value.literal
	}

	/** Whether a literal is a value of `type`: one `literal` admits at it rather than refuses. */
	admits(value: LiteralDesc, type: ScalarType, patterns: PatternAutomata): boolean {
		return admitLiteral(value, type, { kind: "refinements", patterns }).ok
	}

	/**
	 * A descriptor a query carries. Its closedIds name the schema's rosters, and a contract it names is the schema's
	 * contract of that name, or one the same query declares once (`seen`), with one descriptor; typed by `patterns`, the
	 * admitted patterns of the caller's compile.
	 */
	queryFieldType(
		desc: FieldDesc,
		loc: SourceLoc,
		seen: Map<string, { text: string; loc: SourceLoc }>,
		patterns: PatternAutomata
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
		return this.#typeOf(desc, loc, patterns)
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

/** The checker's reading of an owned role, over its base's reading `base` (checkedSchema of role.base). */
export const checkedRoleOver = (
	role: OwnedRole,
	base: CheckedSchema
): Result.Result<CheckedSchema<RoleWorld>, CompileError> =>
	catchRefusal(
		() => new CheckedSchema(role.base, { kind: "role", role, base, writes: roleWrites(role, base) })
	)
