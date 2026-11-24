import { appendAll } from "@bjornpagen/grizzle-text/base/array"
import { defined } from "@bjornpagen/grizzle-text/base/invariant"
import {
	isNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray,
	sortNonEmpty
} from "@bjornpagen/grizzle-text/base/nonempty"
import * as Result from "@bjornpagen/grizzle-text/base/result"
import { type Closure, closureOf } from "#compiler/analysis/closure.ts"
import {
	analyzeDerivedRelation,
	type DerivedDefinition,
	derivedDefinition,
	type DerivedRelationAnalysis,
	shapedDefinition
} from "#compiler/analysis/derived/analyze.ts"
import {
	type DerivedHolding,
	derivedHolding,
	holdersOf
} from "#compiler/analysis/derived/storage.ts"
import { analyzeWorld, type WorldAnalysis } from "#compiler/analysis/derived/world.ts"
import { liveReading } from "#compiler/analysis/theory/query.ts"
import type { DeclaredMember } from "#compiler/analysis/theory/unit.ts"
import { closedReads, closedReadsAmong } from "#compiler/check/closed.ts"
import { DeclarationTable } from "#compiler/check/declarations.ts"
import { fail, failWith } from "#compiler/check/fail.ts"
import {
	closedReadNames,
	generatedRule,
	generatedTypeRule,
	generatedVolatilityRule,
	keyGeneratedRule,
	rowNode,
	type UnwrittenRead
} from "#compiler/check/generated.ts"
import type { AdmittedQuery } from "#compiler/check/index.ts"
import type { ClosedRelation, SchemaReading } from "#compiler/check/schema.ts"
import { CheckSession } from "#compiler/check/session.ts"
import { catchRefusal, unwrap } from "#compiler/core/canonical.ts"
import type { GeneratedRule } from "#compiler/core/causes.ts"
import { type CompileError, malformedDescription } from "#compiler/core/errors.ts"
import { StoredRelationName } from "#compiler/core/ids.ts"
import { childLoc, labeledChildLoc, SourceLoc } from "#compiler/core/loc.ts"
import { compareStrings, mapInput } from "#compiler/core/order.ts"
import type { DerivedRows } from "#compiler/ir/derived.ts"
import {
	descText,
	type ExprDesc,
	type FieldDesc,
	type KeySlotDesc,
	type LiteralDesc,
	nestedFields,
	type WriteMode
} from "#compiler/ir/desc.ts"
import { type ExprTable, fieldReads, type TypedLiteral, storedColumn } from "#compiler/ir/expr.ts"
import { instantInputText, isInstantDesc, isInstantType } from "#compiler/ir/instant.ts"
import type { GeneratedRead, ViewRead } from "#compiler/ir/keys.ts"
import {
	type ClosedSlot,
	type ClosedTheoryRelation,
	type FieldWriting,
	generationOf,
	headingColumns,
	isSpanField,
	type KeyName,
	type LawField,
	type RelationInfo,
	type TheoryRelation
} from "#compiler/ir/law.ts"
import { closedCell, closedValues, type DeclaredKey } from "#compiler/ir/rel.ts"
import {
	enteredType,
	isFloat,
	isRefined,
	Roster,
	type ScalarType,
	sameScalarType,
	typeLabel
} from "#compiler/ir/scalar.ts"
import type { ClosedTable } from "#compiler/runtime/write/fill.ts"
import { admitLiteral, refined } from "#compiler/scalar/compute/evaluate.ts"
import { admittedLiteral, type LiteralMeeting } from "#compiler/scalar/compute/literal.ts"
import { exprEmitter, lowerTerm } from "#compiler/scalar/compute/lower.ts"
import { binaryCoercion } from "#compiler/scalar/compute/registry.ts"
import { contractPredicateTable } from "#compiler/scalar/compute/total.ts"
import { type ClosedRelations, type LeafDesc, noParams } from "#compiler/scalar/compute/typing.ts"
import { isDrawnType } from "#compiler/scalar/natural.ts"
import type { PatternAutomata } from "#compiler/scalar/regex/patterns.ts"
import {
	type ScalarEnv,
	scalarTypeOf,
	searchedOnly,
	storedOnly
} from "#compiler/scalar/registry.ts"
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
import { type Slice, writesOf } from "#compiler/schema/reach.ts"
import type { Scope } from "#compiler/schema/scope.ts"
import { AnalyzedPatterns } from "#compiler/text/refinement.ts"

/**
 * A derived relation as a query reads it, stored or live alike (analysis/derived/analyze.ts DerivedDefinition): a Base
 * over it reads its definition's heading and the keys its rows are proven to have, each on its proof's own grounds
 * (`analysis.read`), so no verdict reads where its rows live; the lowering alone reads them from its table or from its
 * definition (ir/derived.ts servedDag, CheckedSchema `serves`), and a stored one's table, its unique indexes on its
 * keys, is the physical layer's (CheckedSchema holdings).
 */
interface DerivedRelation {
	readonly kind: "derived"
	readonly name: string
	readonly loc: SourceLoc
	readonly analysis: { readonly read: ViewRead }
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
 * One entry of a role's insert or write list over its base's handles, under its mode (schema/own.ts OwnedWrite):
 * "whole", the base's ordinary relation; "rows", a query entry with its writable entry.
 */
export type RoleWrite =
	| {
			readonly kind: "whole"
			readonly name: string
			readonly mode: WriteMode
			readonly relation: RelationInfo
			readonly loc: SourceLoc
	  }
	| {
			readonly kind: "rows"
			readonly name: string
			readonly mode: WriteMode
			readonly writable: CheckedEntry
			readonly loc: SourceLoc
	  }
	| {
			/** A scoped entry's write (schema/own.ts OwnedWrite scoped): its relation written whole, behind the precheck of
			 * its membership, its analysis `writable`, under its scope. */
			readonly kind: "scoped"
			readonly name: string
			readonly mode: WriteMode
			readonly relation: RelationInfo
			readonly writable: CheckedEntry
			readonly scope: Scope
			readonly loc: SourceLoc
	  }

/** A role's world: the owned role, its base's checked schema and its write list over the base's handles, by name. */
export interface RoleWorld {
	readonly kind: "role"
	readonly role: OwnedRole
	readonly base: CheckedSchema
	readonly writes: ReadonlyMap<string, RoleWrite>
}

/** The descriptor registry's environment of a schema (scalar/registry.ts ScalarEnv), which lowers contract predicates. */
type SchemaEnv = Extract<ScalarEnv, { readonly kind: "schema" }>

/** Reality's world: the relations and statements of an owned schema's closure over a slice (analysis/closure.ts). */
interface RealityWorld {
	readonly kind: "reality"
	readonly closure: Closure
}

/**
 * What a checked schema reads as: reality, the relations of an owned schema's closure; or a role, whose relations are
 * its entries over its base's checked schema.
 */
type CheckedWorld = RealityWorld | RoleWorld

/**
 * A role's write list over `base`'s handles: the one site where ownership's writable-entry analysis, which names a
 * target and its fields (schema/entry.ts writableEntry), meets the base's handles, which every write and the
 * installation read. Ownership analyzed each entry over the base's description, so a name it gives is one the base
 * declares; one it does not is a malformed role. It holds each write that reads only relations of the base's closure,
 * as the role's entries are (CheckedSchema): every write for everySlice.
 */
const roleWrites = (role: OwnedRole, base: CheckedSchema): ReadonlyMap<string, RoleWrite> => {
	const ordinary = (name: string, loc: SourceLoc): RelationInfo =>
		base.relations.get(name) ??
		fail("MalformedDescription", loc, `a write into an ordinary relation of the base, not ${name}`)
	const checkedEntry = (
		w: Extract<OwnedWrite, { readonly kind: "rows" | "scoped" }>
	): CheckedEntry => {
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
			entry: owned.entry,
			target,
			head: new Map(
				[...owned.head].map(([head, h]) => [head, { field: field(h.field), kind: h.kind }] as const)
			),
			fixed: owned.fixed.map((f) => ({ field: field(f.field), value: f.value })),
			filter: filter.kind === "none" ? filter : { ...filter, fields: filter.fields.map(field) }
		}
	}
	const checkedWrite = (w: OwnedWrite): RoleWrite => {
		switch (w.kind) {
			case "whole":
				return {
					kind: "whole",
					name: w.name,
					mode: w.mode,
					relation: ordinary(w.relation.name, w.loc),
					loc: w.loc
				}
			case "rows":
				return {
					kind: "rows",
					name: w.name,
					mode: w.mode,
					writable: checkedEntry(w),
					loc: w.loc
				}
			case "scoped":
				return {
					kind: "scoped",
					name: w.name,
					mode: w.mode,
					relation: ordinary(w.relation.name, w.loc),
					writable: checkedEntry(w),
					scope: w.scope,
					loc: w.loc
				}
		}
	}
	const within = base.closure.relations
	const inside = (w: OwnedWrite): boolean => {
		switch (w.kind) {
			case "whole":
				return within.has(w.relation.name)
			case "rows":
			case "scoped":
				return within.has(w.writable.target) && w.entry.reads.every((r) => within.has(r))
		}
	}
	return new Map(
		[...role.writes].flatMap(([name, w]) => (inside(w) ? [[name, checkedWrite(w)] as const] : []))
	)
}

/**
 * What a key generation may not read of the field `f` (check/generated.ts keyGeneratedRule): its writing where grizzle
 * or the database writes it, drawn, accumulated, place or the clock's instant; none for one its caller
 * writes, an instant it states as it read it (instant.stored) among them, whose value the caller holds as a key head,
 * or a generated one, which generatedRule refuses first.
 */
const unwrittenRead = (f: OwnedField): UnwrittenRead | undefined => {
	switch (f.writing.kind) {
		case "drawn":
		case "accumulated":
		case "place":
		case "instant":
			return f.writing.kind
		case "caller":
		case "generated":
			return undefined
	}
}

/** Where a generated field's refusal is: the field of its relation. */
const generatedLoc = (r: OwnedRelation, field: string): SourceLoc =>
	labeledChildLoc(r.loc, field, `generated field ${r.name}.${field}`)

/** The refusal of generated field `field` of `r` for breaking `rule` (check/generated.ts). */
const generatedRefused = (r: OwnedRelation, field: string, rule: GeneratedRule): never =>
	failWith({ _tag: "GeneratedRefused", at: generatedLoc(r, field), relation: r.name, field, rule })

/** How a field its caller writes is written: by its caller, never by PostgreSQL. */
const callerWriting: FieldWriting = Object.freeze({ kind: "caller" })

/** How a drawn field is written: by grizzle, from the nested arrays. */
const drawnWriting: FieldWriting = Object.freeze({ kind: "drawn" })

/** How an instant `instant` declares is written: by the database's clock, as its relation's laws say
 * (analysis/theory/instants.ts). */
const instantWriting: FieldWriting = Object.freeze({ kind: "instant" })

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
 * The relations some family that is no tree has as its member and a mutable relation as its owner, whose owner axis
 * carries the owner's columns into the member's accumulated fields by ON UPDATE CASCADE (CheckedSchema #inPlace): read
 * once a schema, so each relation's fields read it by name, where each relation scanned every statement of the schema,
 * O(r · s) for r relations and s statements (the compile bench's 120 relations: 71,880 tests where 60 made 17,940).
 */
const cascadedMembers = (owned: Owned): ReadonlySet<string> =>
	new Set(
		owned.statements.flatMap((s) =>
			s.kind === "family" && owned.relations[s.slots.owner]?.mutable === true
				? [s.member.relation]
				: []
		)
	)

/**
 * The generated fields of `fields` each with the fields its generation reads, those that determine it (ir/keys.ts
 * GeneratedRead): every generated field but one whose generation reads a float, in field order.
 */
const generatedReadsOf = (fields: ReadonlyArray<LawField>): ReadonlyArray<GeneratedRead> =>
	fields.flatMap((f): ReadonlyArray<GeneratedRead> => {
		const generation = generationOf(f)
		if (generation === undefined) {
			return []
		}
		const reads = fieldReads([generation])
		return reads.some((r) => fields.some((x) => x.name === r && isFloat(x.type)))
			? []
			: [Object.freeze({ field: f.name, reads })]
	})

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

/**
 * The closed relations of a checked schema as its evaluators read them (runtime/write/fill.ts ClosedTable), by name,
 * each its relation's own (check/schema.ts ClosedRelation `host`): its heading's names, its key's width and its rows in
 * heading order: the table a write compiled in process prepares its binding against, a served file's closed relations
 * are drawn from, and an installation indexes for its host's reads (ir/physical.ts PhysicalNames closedIndex).
 */
export const closedTableOf = (checked: Pick<CheckedSchema, "closed">): ClosedTable =>
	new Map(Array.from(checked.closed, ([name, c]) => [name, c.host] as const))

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
 *   declared rows as typed literals, held as the set of them by key (ir/desc.ts AdmittedClosedRelation). A roster is
 *   the closed relation whose one field `id` is a closed id of itself, with one row per handle in roster order.
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
 * - Query descriptors. A query may carry descriptors of its own: a Type.cast target, a Type.literal type, a
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
	/** A role's entries over its base, each reading only relations of the base's closure, in name order; reality holds
	 * none. */
	readonly entries: ReadonlyArray<RoleEntry>
	/** The ordinary and closed relations' handles, in name order: what the theory's laws read. */
	readonly stored: ReadonlyArray<TheoryRelation>
	/** The closure it reads (analysis/closure.ts): reality's own, whose statements its theory normalizes; a role's, its
	 * base's. */
	readonly closure: Closure
	/**
	 * Where each derived relation of the closure keeps its rows, by name, as the schema's dependency structure decides it
	 * (analysis/derived/storage.ts DerivedHolding): a role's are its base's.
	 */
	readonly holdings: ReadonlyMap<string, DerivedHolding>
	/**
	 * Whether a derived relation's table holds its rows as this schema reads it (`serves`): reality a stored one's, a role
	 * a stored one's it reads in full (schema/own.ts OwnedRole `wholeDerived`), its table's rows being then exactly its
	 * definition's over the rows the role sees.
	 */
	readonly #tables: (relation: string) => boolean
	/**
	 * The relations of the base a transaction of this schema may write, so a statement inside one may read a stored
	 * derived relation's table before its COMMIT's upkeep replaces it (`serves`): a role's, each relation its write list
	 * writes and each a write of those writes in turn (schema/reach.ts writesOf); reality's, every ordinary relation.
	 */
	readonly writable: ReadonlySet<string>
	/** Every derived relation's definition as every reader reads it (analyze.ts DerivedDefinition), by name: a role's are
	 * its base's. */
	readonly #definitions: ReadonlyMap<string, DerivedDefinition>
	/** A derived relation's definition as this schema reads it (`definition`). */
	readonly #definitionOf: (relation: string) => AdmittedQuery
	/**
	 * Every stored derived relation's analysis in creation order's levels, level then name: a role's are its base's. A
	 * live derived relation is read as a relation too (`relation`), its rows its definition's (ir/derived.ts), and a
	 * rule over it reads its definition (analysis/theory/query.ts).
	 */
	readonly derived: ReadonlyArray<DerivedRelationAnalysis>
	/** Every relation held as a base relation, by name: reality's own, or the ones a role holds whole. */
	readonly #held: ReadonlyMap<string, BaseRelation>
	/** A role's query entries, by name. */
	readonly #worlds: ReadonlyMap<string, WorldRelation>
	readonly #rosters = new Map<string, Roster>()
	/**
	 * Each contract the schema declares with a predicate (Owned.contracts), by name, with its predicate's table, lowered
	 * once where the schema is checked and kept as it came, a refusal included: every typing of a field, a column or a
	 * parameter of the contract reads it (`#env`). A role's are its base's. A contract only a query or a context declares
	 * is lowered where it is typed.
	 */
	readonly #predicates: ReadonlyMap<string, Result.Result<ExprTable, CompileError>>
	/** The relations whose accumulated fields a mutable owner's update cascades into (cascadedMembers). */
	readonly #cascaded: ReadonlySet<string>
	/**
	 * The admitted patterns the schema's compile meets, with the text analysis of each conjunction it types
	 * (text/refinement.ts AnalyzedPatterns): its one table, which its fields' and closed rows' typing, its contracts'
	 * predicates, its closed relations' pattern payloads and its generated fields read, and which its theory's and law
	 * model's typing take (analysis/theory/theory.ts typingEnv), so the compile parses, admits, minimizes and analyzes
	 * each distinct pattern and conjunction once. A role's is its base's, whose types it resolves against.
	 */
	readonly patterns: AnalyzedPatterns

	/**
	 * Reality holds its closure's stored relations: its rosters and closed relations first, which a generated field's
	 * expression reads, then its ordinary relations, each in name order; then each of its derived relations analyzed in
	 * level order against the relations held so far: a definition reads only the levels below its own (schema/own.ts),
	 * and the closure holds every relation a held one reads, so each Base it reads finds its view's keys. Every roster
	 * types a field, whatever the closure. A role holds its entries that read only relations of its base's closure: its
	 * whole entries as its base's relations, each query entry analyzed against its base, and its base's closed relations.
	 */
	constructor(owned: Owned, world: World) {
		this.owned = owned
		this.#cascaded = cascadedMembers(owned)
		this.world = world
		for (const r of Object.values(owned.relations)) {
			if (r.kind === "closed") {
				this.#rosters.set(r.name, r.roster)
			}
		}
		this.patterns = world.kind === "role" ? world.base.patterns : new AnalyzedPatterns()
		this.#predicates = world.kind === "role" ? world.base.#predicates : this.#declaredPredicates()
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
			this.holdings = read.base.holdings
			this.#definitions = read.base.#definitions
			/** A role reads a derived relation's definition over its own relations, each by its name, checked when a read
			 * of the role first needs it: a definition reading a relation the role holds none of is refused there, as a
			 * read of that relation is (OutsideRole). */
			const roleDefinitions = new Map<string, AdmittedQuery>()
			/** The one session of the role's definitions' checks, so an import they share is checked once for the role. */
			const roleSession = new CheckSession(this.patterns)
			this.#definitionOf = (relation) => {
				const known = roleDefinitions.get(relation)
				if (known !== undefined) {
					return known
				}
				const r = this.owned.relations[relation]
				if (r?.kind !== "derived") {
					return fail(
						"MalformedDescription",
						SourceLoc(`derived ${relation}`, []),
						"a derived relation"
					)
				}
				const checked = unwrap(
					shapedDefinition(this, `derived ${relation}`, r.desc.query, relation, r.loc, roleSession)
				).checked
				roleDefinitions.set(relation, checked)
				return checked
			}
			this.writable = writesOf(
				read.base.owned,
				[...read.writes.values()].map((write) =>
					write.kind === "rows" ? write.writable.target.name : write.relation.name
				)
			)
			const readsWhole = new Set(read.role.wholeDerived)
			this.#tables = (relation) =>
				read.base.holdings.get(relation)?.kind === "stored" && readsWhole.has(relation)
			this.derived = read.base.derived
			this.closedReads = read.base.closedReads
			this.closure = read.base.closure
			const within = this.closure.relations
			/** Each stored derived relation the role reads in full (schema/own.ts OwnedRole `wholeDerived`), held as a whole
			 * entry of its own: its table serves the role exactly where the role sees every row its definition reads. */
			const wholeDerived = read.role.wholeDerived.flatMap((relation): ReadonlyArray<OwnedEntry> => {
				const derived = read.base.owned.relations[relation]
				return derived !== undefined && read.base.holdings.get(relation)?.kind === "stored"
					? [{ kind: "whole", name: derived.name, relation: derived, loc: derived.loc }]
					: []
			})
			this.entries = [...Object.values(read.role.relations), ...wholeDerived]
				.filter((e) =>
					e.kind === "whole" ? within.has(e.relation.name) : e.reads.every((r) => within.has(r))
				)
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
			/** Every other derived relation of the base's closure, its rows its definition's over the role's relations: by the
			 * keys its definition proves, as the base reads it. */
			const throughDefinitions = [...read.base.#definitions].flatMap(([name, definition]) => {
				const derived = read.base.owned.relations[name]
				return derived !== undefined && within.has(name) && !this.#tables(name)
					? [
							{
								info: {
									kind: "derived" as const,
									name,
									loc: derived.loc,
									analysis: { read: definition.read }
								},
								whole: false
							}
						]
					: []
			})
			appendAll(reads, throughDefinitions)
			for (const r of reads.toSorted(mapInput(compareStrings, (x) => x.info.name))) {
				hold(r.info, r.whole)
			}
			return
		}
		this.entries = []
		this.closure = read.closure
		const ownedRelations = Object.values(owned.relations).filter((o) =>
			read.closure.relations.has(o.name)
		)
		const ownedStored = ownedRelations
			.flatMap((o): ReadonlyArray<OwnedStored> => (o.kind === "derived" ? [] : [o]))
			.toSorted(byName)
		const closedInfos = ownedStored.flatMap((r) =>
			r.kind === "relation" ? [] : [this.#closedInfo(r, this.patterns)]
		)
		const readable = closedInfos.filter((c) => !this.#rosters.has(c.name))
		this.closedReads = closedReads(readable, this.patterns)
		const ordinaryInfos = ownedStored.flatMap((r) =>
			r.kind === "relation" ? [this.#ordinaryInfo(r, readable, this.patterns)] : []
		)
		for (const info of [...closedInfos, ...ordinaryInfos].toSorted(byName)) {
			hold(info, true)
		}
		const derived: Array<DerivedRelationAnalysis> = []
		this.derived = derived
		const holdings = new Map<string, DerivedHolding>()
		this.holdings = holdings
		/** The relations a stored relation's unit-locality reads (storage.ts HoldingInput `known`): the closure's ordinary
		 * and closed ones, and each stored derived relation of the levels decided so far. */
		const known = new Map<string, TheoryRelation>(stored.map((r) => [r.name, r] as const))
		const members = new Map<string, DeclaredMember>()
		const definitions = new Map<string, DerivedDefinition>()
		this.#definitions = definitions
		/**
		 * The one session of every derived definition's check (check/session.ts CheckSession): a definition reads a
		 * derived relation below it as a relation, and an import its definitions share, a query several of them read, is
		 * checked once for the schema (check/checker.ts #closedImport), where a session of each definition's own checked it
		 * again for each.
		 */
		const session = new CheckSession(this.patterns)
		this.#definitionOf = (relation) =>
			defined(definitions.get(relation), `the definition of the derived relation ${relation}`)
				.checked
		this.writable = new Set(relations.keys())
		this.#tables = (relation) => holdings.get(relation)?.kind === "stored"
		/** A definition as its unit-locality reads it (storage.ts HoldingInput `definition`): every live derived relation it
		 * names, at any depth, read through its own definition, whose rows its upkeep would read. */
		const live = liveReading((relation) => {
			const r = owned.relations[relation]
			return r?.kind === "derived" && holdings.get(relation)?.kind !== "stored"
				? r.desc.query
				: undefined
		})
		for (const r of ownedRelations
			.flatMap((o) => (o.kind === "derived" ? [o] : []))
			.toSorted((a, b) =>
				a.desc.level === b.desc.level ? compareStrings(a.name, b.name) : a.desc.level - b.desc.level
			)) {
			const definition = unwrap(derivedDefinition(this, r, session))
			definitions.set(r.name, definition)
			const holding = derivedHolding({
				owned,
				relation: r,
				definition: live.query(r.desc.query),
				known,
				memberOf: (relation) => owned.unitOf.get(relation) ?? members.get(relation),
				analyze: () => analyzeDerivedRelation(this, r, definition)
			})
			holdings.set(r.name, holding)
			switch (holding.kind) {
				case "stored":
					derived.push(holding.analysis)
					known.set(r.name, holding.relation)
					if (holding.relation.unit.kind === "unit") {
						members.set(r.name, holding.relation.unit.declared)
					}
					break
				case "live":
					break
			}
			hold({ kind: "derived", name: r.name, loc: r.loc, analysis: { read: definition.read } }, true)
		}
	}

	/**
	 * The definition of the derived relation `relation` as this schema reads it, checked: reality's, checked once when
	 * the schema was built (analyze.ts derivedDefinition); a role's, over the role's own relations (`#definitionOf`). The
	 * lowering reads it where the relation's table does not serve a read (ir/derived.ts servedDag).
	 */
	definition(relation: string): AdmittedQuery {
		return this.#definitionOf(relation)
	}

	/** Every derived relation read through its definition, whatever this schema stores: what a membership reads, and
	 * what a verdict over a query's rows reads them from (ir/derived.ts DerivedRows). */
	expanded(): DerivedRows {
		return { serves: () => false, definition: (relation) => this.definition(relation) }
	}

	/** How a statement of a write that writes the relations `written` reads this schema's derived relations
	 * (ir/derived.ts DerivedRows): `serves`, and `definition` where a table does not. */
	rows(written: ReadonlySet<string>): DerivedRows {
		return {
			serves: (relation) => this.serves(relation, written),
			definition: (relation) => this.definition(relation)
		}
	}

	/**
	 * Whether the derived relation `relation`'s table serves a read of it, as this schema reads it, by a statement of a
	 * write that writes the relations `written` (none for a read, a judge or an upkeep, each of which reads every table
	 * its COMMIT's upkeep made current): where its table holds its rows (reality a stored one's, a role a stored one's it
	 * reads in full) and its definition reads none of `written`, at any depth. The write's own COMMIT replaces that
	 * relation's stored rows at the units it writes (the judge's phase A), so no statement of the write would read its
	 * table current, where its definition reads what the write's earlier statements wrote, as it did before the
	 * installation stored it (analysis/derived/storage.ts). Every other derived relation's rows are its definition's
	 * (ir/derived.ts servedDag).
	 */
	serves(relation: string, written: ReadonlySet<string>): boolean {
		const r = this.owned.relations[relation]
		return (
			r?.kind === "derived" &&
			this.#tables(relation) &&
			!holdersOf(this.owned, r).some((holder) => written.has(holder))
		)
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
		const name = StoredRelationName(r.name)
		const loc = r.loc
		const generated = new Set<string>(
			Object.values(r.fields).flatMap((f) => (f.writing.kind === "generated" ? [f.name] : []))
		)
		const isGenerated = (f: string): boolean => generated.has(f)
		const keyed = new Set<string>(r.desc.primaryKey)
		/** Each field of r a key generation may not read, by name, with its writing (unwrittenRead); a read of any other
		 * name is no field this rule judges. */
		const unwritten = new Map<string, UnwrittenRead>(
			Object.values(r.fields).flatMap((f) => {
				const writing = unwrittenRead(f)
				return writing === undefined ? [] : [[f.name, writing] as const]
			})
		)
		for (const f of Object.values(r.fields).toSorted(mapInput(compareStrings, (x) => x.name))) {
			const broken =
				f.writing.kind === "generated"
					? (generatedRule(f.writing.expr, isGenerated) ??
						(keyed.has(f.name)
							? keyGeneratedRule(f.writing.expr, (read) => unwritten.get(read))
							: undefined))
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
		const keyedFields = keyedBy(name, loc, declared)
		/**
		 * A declared key's handles and its span field. A key of two span fields ownership refused (Owned
		 * `unrepresentable`, KeyFault `spans`), and its first stands as its span, so the compile goes on to meet every
		 * other unrepresentable key.
		 */
		const keyName = (k: OwnedKey): KeyName => {
			const fields = keyedFields(k.fields)
			const [span] = fields.filter(isSpanField)
			return { fields, span, primary: k.primary, named: k.named }
		}
		const heading = sortNonEmpty(declared, byFieldName)
		const candidates = r.keys.filter((k) => !k.primary)
		const primaryFields = keyedFields(r.desc.primaryKey)
		return {
			kind: "relation",
			name,
			ident: r.ident,
			fields: declared,
			keyNames: mapNonEmpty(r.keys, keyName),
			heading,
			primaryKey: r.desc.primaryKey,
			keys: candidates.map((k) => k.fields),
			primaryFields,
			keyFields: candidates.map((k) => keyedFields(k.fields)),
			mutable: r.mutable,
			inserts: r.inserts,
			inPlace: this.#inPlace(r, declared, primaryFields),
			generated: generatedReadsOf(declared),
			level: r.level,
			loc
		}
	}

	/**
	 * The fields of `r` a write changes in place on a row it keeps (law.ts RelationInfo `inPlace`), its fields `fields`
	 * and its primary key's `primary`: of a mutable relation, every field outside its primary key; of an immutable one,
	 * its accumulated fields where some family that is no tree has it as its member and a mutable relation as its owner,
	 * whose owner axis carries the owner's columns into them by ON UPDATE CASCADE (laws/model/plan.ts ownerSources), and
	 * each generated field that reads one of them, which PostgreSQL generates again as they change.
	 */
	#inPlace(
		r: OwnedOrdinary,
		fields: NonEmptyReadonlyArray<LawField>,
		primary: NonEmptyReadonlyArray<LawField>
	): ReadonlyArray<string> {
		if (r.mutable) {
			return fields.flatMap((f) => (primary.includes(f) ? [] : [f.name]))
		}
		const cascaded = this.#cascaded.has(r.name)
		const rewritten = new Set(
			fields.flatMap((f) => (cascaded && f.writing.kind === "accumulated" ? [f.name] : []))
		)
		return fields.flatMap((f) =>
			rewritten.has(f.name) ||
			(f.writing.kind === "generated" && fieldReads([f.writing.expr]).some((g) => rewritten.has(g)))
				? [f.name]
				: []
		)
	}

	/**
	 * How an ordinary relation's field of type `type` is written (desc.ts Writing, resolved as law.ts FieldWriting): by
	 * its caller; drawn by grizzle, a natural or a value of a contract over an integer (a family's index or count, a
	 * tree's start or end); accumulated, filled on the host from its start, a literal of its type, at its axis's base, over no
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
		if (searchedOnly(type) && w.kind !== "generated" && w.kind !== "caller") {
			return fail(
				"UnsupportedOperation",
				at,
				`textSearch: ${r.name}.${f.name} of ${typeLabel(type)} is a search document, which searchDocument's generation parses from its row's texts or its caller writes as a read delivered it (pg.tsvector); it is ${w.kind}`
			)
		}
		if (isInstantDesc(f.desc) !== (w.kind === "instant") && w.kind !== "caller") {
			return fail(
				"MalformedDescription",
				at,
				isInstantDesc(f.desc)
					? `an instant field the database's clock writes (instant) or its caller writes as it read it (instant.stored); ${r.name}.${f.name} is ${w.kind}`
					: `a field the database's clock writes of instant's type; ${r.name}.${f.name} is ${typeLabel(type)}`
			)
		}
		switch (w.kind) {
			case "caller":
				return callerWriting
			case "instant":
				return instantWriting
			case "drawn":
				if (!isDrawnType(f.desc)) {
					return fail(
						"MalformedDescription",
						at,
						`a drawn field of type natural or a contract over an integer, the index, count, start or end grizzle draws; ${r.name}.${f.name} is ${typeLabel(type)}`
					)
				}
				return drawnWriting
			case "place":
				return Object.freeze({ kind: "place", order: w.order })
			case "accumulated":
				if (storedOnly(type)) {
					return fail(
						"UnsupportedOperation",
						at,
						`storage: accumulated field ${r.name}.${f.name} of ${typeLabel(type)}, which is stored only, written by its caller and never by grizzle's fill`
					)
				}
				if (f.desc.kind === "span" || f.desc.kind === "vector") {
					return fail(
						"MalformedDescription",
						at,
						`an accumulated field of a type a fold combines or a copy carries, no span or vector; ${r.name}.${f.name} is ${typeLabel(type)}`
					)
				}
				return {
					kind: "accumulated",
					start: this.literal(w.start, type, childLoc(at, "writing", "start"), patterns, "stored")
				}
			case "generated":
				return this.#generated(r, f.name, w.expr, type, row, patterns)
		}
	}

	/**
	 * A generated field's writing: its expression, which keeps the generated-field rule (#ordinaryInfo checked it), typed
	 * in "check" mode over its row, each field a column of `rowNode` of its written type, and the closed relations it may
	 * apply, and held at its declared type. A Type.base emits no node of its own, so where the node still carries the
	 * contract the term drops, the expression casts it, as a query's head does. A node that computes the type its column
	 * enters a value at (ir/scalar.ts enteredType), the plain text of a refined text a computation's type states, is
	 * stored as it is computed: the column's domain judges it, and the term's refinement, a translation's image, a
	 * collapse's or a concatenation's byte bound, names no domain of its own.
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
		if (storedOnly(declared)) {
			return fail(
				"UnsupportedOperation",
				loc,
				`storage: generated field ${r.name}.${field} of ${typeLabel(declared)}, which is stored only, written by its caller and never by PostgreSQL from its row`
			)
		}
		const above = closedReadNames(expr).find(row.above)
		if (above !== undefined) {
			return fail(
				"MalformedDescription",
				loc,
				`a closed read of a closed relation of this level or below; ${above} is declared above`
			)
		}
		const declarations = new DeclarationTable()
		const lowered = (desc: ExprDesc) => {
			const emit = exprEmitter(`generated ${r.name}.${field}`)
			const term = unwrap(
				lowerTerm(desc, {
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
						return Result.ok(storedColumn(rowNode, d.field, type))
					},
					params: noParams,
					fieldType: (d, l) =>
						catchRefusal(() => this.queryFieldType(d, l, declarations, patterns)),
					closed: row.closed,
					patterns
				})
			)
			return { desc, emit, term }
		}
		const whole = lowered(expr)
		const mismatch = generatedTypeRule(declared, whole.term.nominal, patterns)
		if (mismatch !== undefined) {
			return generatedRefused(r, field, mismatch)
		}
		/** A cast into the field's own type, proved where it stands, is the column's own: the column admits its operand into
		 * its type as the cast does, so the field is written as its operand is, of one SQL and one record, whichever of the
		 * two its source spells. */
		const operand =
			expr.kind === "cast" &&
			sameScalarType(this.queryFieldType(expr.to, loc, declarations, patterns), declared)
				? lowered(expr.arg)
				: undefined
		const { desc, emit, term } =
			operand !== undefined &&
			generatedTypeRule(declared, operand.term.nominal, patterns) === undefined
				? operand
				: whole
		const stable = generatedVolatilityRule(term.expr.volatility)
		if (stable !== undefined) {
			return generatedRefused(r, field, stable)
		}
		return {
			kind: r.desc.primaryKey.includes(field) ? "keyGenerated" : "generated",
			desc,
			expr:
				sameScalarType(term.expr.type, term.nominal) ||
				sameScalarType(term.expr.type, enteredType(term.nominal))
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
	 * its rows its declared rows in the order of their set (ir/desc.ts AdmittedClosedRelation), each value a literal of
	 * its field's type, its base proved where the relation was admitted and its refinements judged here (#cells).
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
		const readers = declared.map((f) => ({
			field: f.name,
			read: this.#cells(f.type, patterns, (row) => childLoc(loc, "rows", row, f.name))
		}))
		const rows = literals.map((row, i) =>
			readers.map(({ field, read }) => {
				const value = row[field]
				if (value === undefined) {
					return fail("MalformedDescription", loc, `row ${i} of ${name} with a value of ${field}`)
				}
				return read(value, i)
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
			values: declared.map((f) => closedValues(rows, f.position)),
			slots:
				desc.kind === "closed"
					? []
					: desc.slots.map((slot) => this.#slot(slot, primaryFields, loc, patterns))
		}
		const columns = headingColumns(heading)
		const headingRows = rows.map((row) => heading.map((f) => closedCell(row, f.position)))
		return {
			kind: "closed",
			relation,
			name,
			heading: columns,
			rows: headingRows,
			host: Object.freeze({
				heading: columns.map((h) => ({ name: h.name })),
				key: primaryFields.length,
				rows: headingRows
			}),
			loc,
			desc
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
		const at = (row: number): SourceLoc => childLoc(owner.loc, "rows", row, slot.fin.count)
		const countCell = this.#cells(countType, patterns, at)
		const ownerCells = mapNonEmpty(fields, (f) => ({
			field: f.field,
			read: this.#cells(f.own.type, patterns, at)
		}))
		return {
			field: slot.field,
			fin: { relation: owner.name, count: slot.fin.count },
			owner: mapNonEmpty(fields, (f) => f.own.name),
			counts: owner.rows.map((row, i) => {
				const count = countCell(defined(row[slot.fin.count], "a row's count"), i)
				return {
					owner: mapNonEmpty(ownerCells, (c) =>
						c.read(defined(row[c.field], "a row's key value"), i)
					),
					count:
						count.kind === "int"
							? count.value
							: fail("MalformedDescription", at(i), "a natural count")
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
		return failWith({
			_tag: "Refused",
			at: loc,
			refusal: "the relation is not in this query's schema"
		})
	}

	/**
	 * The descriptor registry's reading of the schema: a declared contract's predicate is the table `declared` holds, any
	 * other contract's lowered here, typed by `patterns`.
	 */
	#env(
		patterns: PatternAutomata,
		declared: ReadonlyMap<string, Result.Result<ExprTable, CompileError>>
	): SchemaEnv {
		const env: SchemaEnv = {
			kind: "schema",
			roster: (name) => this.#rosters.get(name),
			contractPredicate: (
				predicate,
				base,
				contract,
				facts
			): Result.Result<ExprTable, CompileError> =>
				declared.get(contract) ??
				contractPredicateTable(predicate, base, contract, facts, {
					loc: SourceLoc(`contract ${contract}`, []),
					fieldType: (d, at) => scalarTypeOf(d, env, at),
					patterns
				})
		}
		return env
	}

	/**
	 * Each declared contract's predicate table (`#predicates`), lowered over its base as a field of the contract types
	 * it; a contract whose base does not type is refused there, where every field of it is, and holds none.
	 */
	#declaredPredicates(): ReadonlyMap<string, Result.Result<ExprTable, CompileError>> {
		const env = this.#env(this.patterns, new Map())
		const out = new Map<string, Result.Result<ExprTable, CompileError>>()
		for (const c of Object.values(this.owned.contracts)) {
			const predicate = c.desc.predicate
			const base = scalarTypeOf(c.desc.base, env, c.loc)
			if (predicate !== undefined && base.ok) {
				out.set(c.name, env.contractPredicate(predicate, base.value, c.name, c.desc.facts))
			}
		}
		return out
	}

	/** The ScalarType of a descriptor, by the admitted patterns of the caller's compile. */
	#typeOf(desc: FieldDesc, loc: SourceLoc, patterns: PatternAutomata): ScalarType {
		return unwrap(scalarTypeOf(desc, this.#env(patterns, this.#predicates), loc))
	}

	/** The ScalarType of a schema descriptor, typed by the schema's own table (`patterns`). */
	fieldType(desc: FieldDesc, loc: SourceLoc): ScalarType {
		return this.#typeOf(desc, loc, this.patterns)
	}

	/**
	 * A literal of a declared value: the typed IR literal, checked against the type's contract and regex
	 * (ContractLiteral).
	 *
	 * Construction checks the literal's host kind and gives it its value as it meets the type (`meeting`,
	 * scalar/compute/literal.ts LiteralMeeting): a stored one the value its field stores, a compared one its value as
	 * written. A JavaScript number for a bigint or numeric type, a non-integer or out-of-range integer, a numeric(p, s)
	 * overflow, or a compared decimal of more digits than numeric(p, s) holds is a malformed literal whatever contract the
	 * type carries (MalformedDescription). Only a well-formed literal that the contract's predicate or the regex
	 * refinement refuses is ContractLiteral, judged by `patterns`, the admitted patterns of the caller's compile.
	 */
	literal(
		value: LiteralDesc,
		type: ScalarType,
		loc: SourceLoc,
		patterns: PatternAutomata,
		meeting: LiteralMeeting
	): TypedLiteral {
		if (isInstantType(type)) {
			return fail("MalformedDescription", loc, instantInputText("literal"))
		}
		const admitted = admitLiteral(value, type, { kind: "refinements", patterns }, meeting)
		if (!admitted.ok) {
			return fail(admitted.error.reason, loc, admitted.error.capability)
		}
		return admitted.value
	}

	/**
	 * The reader of a closed relation's or a roster's cells of type `type`, each admitted (ir/desc.ts
	 * AdmittedClosedRelation, a roster's rows its own handles): converted at the type and never held to its base again
	 * (scalar/compute/literal.ts admittedLiteral). Only the type's refinements, a contract's predicate and a pattern,
	 * which only a schema reads, are judged here (ContractLiteral), so a type without one judges no cell, and a refused
	 * cell is placed at `at` of its row, which no admitted cell spells.
	 */
	#cells(
		type: ScalarType,
		patterns: PatternAutomata,
		at: (row: number) => SourceLoc
	): (value: LiteralDesc, row: number) => TypedLiteral {
		if (!isRefined(type)) {
			return (value) => admittedLiteral(value, type)
		}
		return (value, row) => {
			const judged = refined(admittedLiteral(value, type), type, patterns)
			return judged.ok ? judged.value : fail(judged.error.reason, at(row), judged.error.capability)
		}
	}

	/** Whether a literal is a value of `type` as it meets it: one `literal` admits at it rather than refuses. */
	admits(
		value: LiteralDesc,
		type: ScalarType,
		patterns: PatternAutomata,
		meeting: LiteralMeeting
	): boolean {
		return admitLiteral(value, type, { kind: "refinements", patterns }, meeting).ok
	}

	/**
	 * A descriptor a query carries. Its closedIds name the schema's rosters, and a contract it names is the schema's
	 * contract of that name, or one the same query declares once (`declarations`, check/declarations.ts), with one
	 * descriptor; typed by `patterns`, the admitted patterns of the caller's compile.
	 */
	queryFieldType(
		desc: FieldDesc,
		loc: SourceLoc,
		declarations: DeclarationTable,
		patterns: PatternAutomata
	): ScalarType {
		nestedFields(desc, (d) => {
			if (isInstantDesc(d)) {
				fail("MalformedDescription", loc, instantInputText("value a query carries"))
			}
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
			declarations.declare("contract", d.name, { text, loc })
		})
		return this.#typeOf(desc, loc, patterns)
	}
}

/** The derived analysis of a checked schema, which read every derived relation's definition when it was built, refusing
 * one no derived relation may have (analyze.ts derivedDefinition), and analyzed each stored one's table: the analyses
 * by name and in creation order's levels, level then name. */
export interface DerivedAnalysis {
	readonly schema: CheckedSchema
	readonly relations: Readonly<Record<string, DerivedRelationAnalysis>>
	readonly order: ReadonlyArray<DerivedRelationAnalysis>
}

/** The derived analysis of a checked schema: the analyses it holds, by name and in creation order. */
export const derivedAnalysis = (schema: CheckedSchema): DerivedAnalysis => ({
	schema,
	relations: Object.fromEntries(schema.derived.map((a) => [a.name, a] as const)),
	order: schema.derived
})

/** The checker's reading of an owned schema over the closure of `slice` (analysis/closure.ts closureOf): every relation
 * and statement for everySlice. A pass that reads it again takes the one its caller holds (program/schema.ts
 * SchemaArtifacts.checked, the installation's builder), never this again. */
export const checkedSchema = (
	owned: Owned,
	slice: Slice
): Result.Result<CheckedSchema, CompileError> =>
	catchRefusal(
		() => new CheckedSchema(owned, { kind: "reality", closure: closureOf(owned, slice) })
	)

/** The checker's reading of an owned role, over its base's reading `base` (checkedSchema of role.base). */
export const checkedRoleOver = (
	role: OwnedRole,
	base: CheckedSchema
): Result.Result<CheckedSchema<RoleWorld>, CompileError> =>
	catchRefusal(
		() => new CheckedSchema(role.base, { kind: "role", role, base, writes: roleWrites(role, base) })
	)
