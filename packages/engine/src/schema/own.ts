import { arrayText, catchRefusal, compareText, Refusal } from "#compiler/core/canonical.ts"
import type { RoleRule } from "#compiler/core/causes.ts"
import {
	CompileError,
	type CompileReason,
	malformedDescription,
	type ProseTag,
	prose
} from "#compiler/core/errors.ts"
import { type SchemaLevel, schemaLevel } from "#compiler/core/fingerprint.ts"
import {
	type DeclaredName,
	DeclaredNamespace,
	decodedColumnFits,
	type Identity,
	identifierOf,
	identity,
	parseSchemaName
} from "#compiler/core/identity.ts"

import {
	type ColumnIdent,
	type ConstraintName,
	FieldId,
	type IdentityKind,
	type RelationIdent,
	type SchemaFingerprint
} from "#compiler/core/ids.ts"
import { defect } from "#compiler/core/invariant.ts"
import { handleMaxBytes } from "#compiler/core/limits.ts"
import { labeledChildLoc, type SourceLoc } from "#compiler/core/loc.ts"
import {
	appendNonEmpty,
	lastNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray,
	sortNonEmpty
} from "#compiler/core/nonempty.ts"
import { compareStrings } from "#compiler/core/order.ts"
import * as Result from "#compiler/core/result.ts"
import { utf8Length } from "#compiler/core/sha256.ts"
import {
	type AdmittedClosedRelation,
	candidateKeyFields,
	type CompareOp,
	conjunctsOf,
	type ContextDesc,
	decodeRoleOver,
	descText,
	descTextOver,
	type ExprDesc,
	type FieldDesc,
	fieldTypes,
	type LiteralDesc,
	type LoginDesc,
	nestedFields,
	type QueryDesc,
	type DerivedStorage,
	heldRelation,
	type QueryStageDesc,
	type RelationDesc,
	type RoleDesc,
	type RoleEntryDesc,
	type SchemaDesc,
	type SchemaRelationDesc,
	schemaLevelDesc,
	type SelectionDesc,
	type SideDesc,
	type SlotsDesc,
	type StatementDesc,
	type TermDesc,
	termText,
	type Writing
} from "#compiler/ir/desc.ts"
import type { OwnedSchema } from "#compiler/ir/products.ts"
import type { DeclaredKey } from "#compiler/ir/rel.ts"
import { Roster } from "#compiler/ir/scalar.ts"
import { isNaturalDesc } from "#compiler/scalar/natural.ts"
import { descCapabilities } from "#compiler/scalar/registry.ts"
import { type WritableEntry, writableEntry } from "#compiler/schema/entry.ts"
import type { SchemaContent } from "#compiler/schema/levels.ts"
import { keyLayout } from "#compiler/schema/representability.ts"
import { foreignInput } from "#compiler/schema/terms.ts"
import { approximates, attachesHeading, queryUses } from "#compiler/schema/walk.ts"

/**
 * An owned field: `named` is its column's identity at the naming door and `column` that identity's identifier; `writing`
 * says how it is written, by its caller unless PostgreSQL generates it from its row.
 */
interface OwnedField {
	readonly id: FieldId
	readonly name: DeclaredName
	readonly desc: FieldDesc
	readonly writing: Writing
	readonly named: Identity<"column">
	readonly column: ColumnIdent
	/** A serial field's identity sequence; any other field has none. */
	readonly sequence: Identity<"sequence"> | undefined
}

export interface OwnedKey {
	readonly fields: DeclaredKey
	readonly primary: boolean
	/** The key's identity at the naming door, a primary key's or a candidate key's over its fields in declared order. */
	readonly named: Identity<"primaryKey" | "key">
	/** The constraint identifier, the identity's. */
	readonly constraint: ConstraintName
	readonly loc: SourceLoc
}

/** An owned row check: its identity at the naming door and its constraint identifier, the identity's. */
export interface OwnedCheck {
	readonly named: Identity<"check">
	readonly constraint: ConstraintName
}

/** What an owned relation of any kind holds before its kind: its name, level and location. */
type OwnedBase = Omit<Owning<RelationDesc["kind"]>, "kind" | "desc">

/**
 * An owned relation of kind K. `level` is the schema level that declares it: 0 for the root schema, n for its n-th
 * extension.
 */
interface Owning<K extends RelationDesc["kind"]> {
	readonly name: DeclaredName
	readonly kind: K
	readonly level: number
	readonly desc: Extract<SchemaRelationDesc, { readonly kind: K }>
	readonly loc: SourceLoc
}

/**
 * What an installed relation is named by: `named` its table's, roster domain's or materialized view's identity at the
 * naming door, and `ident` that identity's identifier. A closed relation and a live derived relation install no
 * relation of their own.
 */
interface Installed<K extends "table" | "rosterDomain" | "view"> {
	readonly named: Identity<K>
	readonly ident: RelationIdent
}

export type OwnedRelation =
	| (Owning<"relation"> &
			Installed<"table"> & {
				readonly fields: Readonly<Record<string, OwnedField>>
				/** Its primary key, then each key statement's key over it, in statement order. */
				readonly keys: readonly [OwnedKey, ...ReadonlyArray<OwnedKey>]
				/** Each row check statement's check over it, in statement order. */
				readonly checks: ReadonlyArray<OwnedCheck>
				readonly mutable: boolean
			})
	| (Owning<"closed"> &
			Installed<"rosterDomain"> & {
				/** Its one field, its handle under `id`. */
				readonly fields: Readonly<Record<string, OwnedField>>
				readonly keys: readonly []
				readonly mutable: false
			})
	| (Owning<"closedRelation"> & {
			readonly fields: Readonly<Record<string, OwnedField>>
			readonly keys: readonly []
			readonly mutable: false
	  })
	| (Owning<"derived"> & {
			readonly fields: Readonly<Record<string, never>>
			readonly keys: readonly []
			readonly mutable: false
			readonly reads: ReadonlyArray<string>
			/** Its materialized view, where PostgreSQL stores its rows; a live one's are its definition's alone. */
			readonly view: OwnedView
	  })

/** Where a derived relation's rows are: its definition's alone, or a materialized view of them too. */
export type OwnedView =
	| { readonly kind: "live" }
	| ({ readonly kind: "materialized" } & Installed<"view">)

/**
 * An owned contract: its declared name, its type-level brand, and its descriptor. Ownership names no installed object
 * for it: its domain is named by the domain's physical definition, which only the installation's names spell
 * (physical/ddl/names.ts InstallNames.contractNamed), so contracts of one definition share one domain.
 */
export interface OwnedContract {
	readonly name: DeclaredName
	readonly desc: FieldDesc & { readonly kind: "contract" }
	readonly loc: SourceLoc
}

/**
 * Ownership: a SchemaDesc to an OwnedSchema.
 *
 * own() is the first compiler pass over a schema. It turns the Description the builders recorded, or one a caller
 * deserialized, into the owned product: canonical fields with stable FieldIds, closed facts, declarations and their
 * source locations, the derived PostgreSQL identifiers, and the schema fingerprint. It is pure, returns a Result, and
 * never throws. It refuses, each with its source location:
 *
 * - a malformed description, or a statement naming a relation, field or handle no level declares
 *   (MalformedDescription), including a derived relation outside an extension, a derived level that disagrees with
 *   what the definition reads, a definition that reads its own level or above, and a definition that reads a parameter
 *   or a context;
 * - a relation, closed relation or contract name reused with a conflicting descriptor (DuplicateIdentity);
 * - a roster handle longer than a name's 63 bytes, and a closed relation's row value of a closedId field, at
 *   any contract depth, or a selection or row check literal compared with one, that is not a handle of its roster
 *   (MalformedDescription);
 * - a side term pred of a field that is not natural, a selection or row check that reads anything but its own row,
 *   and a key over a closed relation (MalformedDescription);
 * - a key over a field of a type with no equality, and a side that reads one, as bytes is (UnsupportedOperation,
 *   scalar/registry.ts descCapabilities);
 * - a family, tree, fold, alternatives or mutable statement over anything but ordinary relations (a derived relation's
 *   rows are its definition's, which no write draws), its slots' owner one with a field of its count, and a roster
 *   (MalformedDescription); a key's, a check's or a containment's side may read a derived relation, its terms and
 *   selection fields of the definition's heading, and the theory reads the rule over its definition
 *   (analysis/theory/query.ts);
 * - a primary or candidate key whose index entry can exceed PostgreSQL's limit (UnrepresentableKey, representability.ts);
 * - a declared name the naming door's rule refuses (MalformedDescription, core/identity.ts parseDeclaredName, and
 *   parseSchemaName for the schema's), and two names of one namespace that convert to one identifier
 *   (IdentifierCollision with both locations, core/identity.ts DeclaredNamespace), a role's views included.
 *
 * Semantic identity excludes allocation order, callback identity, aliases and source locations.
 * Equivalent declarations agree: a relation, closed relation or statement declared twice identically is one
 * declaration, and the canonical description sorts each level's relations by name and its statements by canonical
 * text. A statement is canonicalized first: a check's and a selection's conjunctions and disjunctions have their
 * operands in canonical order, each comparison its canonical orientation and each IN list its values in canonical
 * order, so that reordered but equal declarations share one text. Roster order is kept, because it is comparison
 * order. The fingerprint hashes that canonical description (core/fingerprint.ts schemaLevel).
 * PostgreSQL identifiers are part of the installation artifact, not of the fingerprint.
 *
 * The owned schema: the frozen schema product (desc and fingerprint, ir/products.ts) with what ownership resolved
 * beside it.
 */
export interface Owned extends OwnedSchema {
	readonly name: string
	/**
	 * Each level of the schema, root first and the schema itself last: its declared name, the identity at the naming door
	 * of the PostgreSQL schema its relations install in, and its own fingerprint, the owned fingerprint of the schema
	 * whose top it is. An owned relation's `level` indexes it. The root's schema also holds what is the installation's
	 * own, every level's alike: its migrations ledger, its functions and its contract and text domains.
	 */
	readonly levels: NonEmptyReadonlyArray<OwnedLevel>
	readonly relations: Readonly<Record<string, OwnedRelation>>
	/**
	 * Every statement of every level, deduplicated, in canonical order, each at its location in the decoded description.
	 */
	readonly statements: ReadonlyArray<OwnedStatement>
	/**
	 * Each statement's index in `statements` by its canonical text (canonicalStatementText): the owned statement a declared
	 * statement of any level is, which a law's `statements` name.
	 */
	readonly statementAt: ReadonlyMap<string, number>
	readonly contracts: Readonly<Record<string, OwnedContract>>
	/** Every field of every relation and closed relation, sorted. */
	readonly fieldIds: ReadonlyArray<FieldId>
}

/** One level of an owned schema (Owned.levels). */
export interface OwnedLevel {
	readonly name: string
	readonly installation: Identity<"schema">
	readonly fingerprint: SchemaFingerprint
	readonly loc: SourceLoc
}

/** A statement's side beside the terms it pairs: its relation and its selection. */
export type SideScope = Omit<SideDesc, "terms">

/** A term of a statement's left side with the term of its right side at its position: a contained's left and right. */
export interface SidePair {
	readonly left: TermDesc
	readonly right: TermDesc
}

/**
 * What ownership made of a key statement. A key over a whole relation whose terms are all fields is a candidate key of
 * the relation, its identity minted, which the relation's keys hold beside its primary key. A key over a selection or
 * with a pred term constrains only the facts its side reads, so it is no key of the relation: it is a law over the
 * side, which the law model lowers from the statement's side.
 */
export type OwnedKeyLaw =
	| { readonly kind: "candidate"; readonly key: OwnedKey }
	| { readonly kind: "projected" }

/**
 * A statement as ownership admitted it. A statement over two sides holds their scopes and their terms paired by
 * position, which ownership parsed once from two sides of one width (pairSides), so no later pass pairs two sides by
 * position. A family, a tree, a fold and an alternatives statement are their Descriptions, whose families the theory
 * resolves.
 */
export type OwnedStatement =
	| Extract<StatementDesc, { readonly kind: "mutable" }>
	| (Extract<StatementDesc, { readonly kind: "key" }> & { readonly key: OwnedKeyLaw })
	| (Extract<StatementDesc, { readonly kind: "check" }> & { readonly check: OwnedCheck })
	| (Omit<Extract<StatementDesc, { readonly kind: "contained" }>, "left" | "right"> & {
			readonly left: SideScope
			readonly right: SideScope
			readonly pairs: NonEmptyReadonlyArray<SidePair>
	  })
	| Extract<StatementDesc, { readonly kind: "family" | "tree" | "fold" | "alternatives" }>

/**
 * Every identity ownership minted, each once, in relation name order: the installation's, each relation's and its
 * fields', sequences', keys' and checks'. A contract's domain is the installation's to name. The installation's census
 * and its comments read them (physical/install/comments.ts).
 */
/** The identity of the relation PostgreSQL installs for `r`, none for a closed or live derived relation. */
const installedIdentity = (r: OwnedRelation): ReadonlyArray<Identity<IdentityKind>> => {
	switch (r.kind) {
		case "closedRelation":
			return []
		case "derived":
			return r.view.kind === "live" ? [] : [r.view.named]
		case "relation":
		case "closed":
			return [r.named]
	}
}

/** Where the derived relation `name`'s rows are, by its storage: a materialized one's view named at the naming door. */
const ownedView = (name: DeclaredName, storage: DerivedStorage): OwnedView => {
	switch (storage) {
		case "live":
			return { kind: "live" }
		case "materialized": {
			const named = identity.view(name)
			return { kind: "materialized", named, ident: identifierOf(named) }
		}
	}
}

export const ownedIdentities = (owned: Owned): ReadonlyArray<Identity<IdentityKind>> => [
	...owned.levels.map((l) => l.installation),
	...Object.values(owned.relations).flatMap((r): ReadonlyArray<Identity<IdentityKind>> => [
		...installedIdentity(r),
		...Object.values(r.fields).flatMap((f) =>
			f.sequence === undefined ? [f.named] : [f.named, f.sequence]
		),
		...r.keys.map((k) => k.named),
		...(r.kind === "relation" ? r.checks.map((c) => c.named) : [])
	])
]

/**
 * The rosters a schema declares, in name order, each its declared name and its live handles in declared order: what
 * the installation's codebook holds codes for (ir/codes.ts draftCodebook).
 */
export const rostersOf = (owned: Owned): ReadonlyArray<Roster> =>
	Object.values(owned.relations).flatMap((r) =>
		r.kind === "closed" ? [new Roster(r.name, r.desc.handles)] : []
	)

/**
 * A function declaration, so that control flow knows a call never returns. Ownership's refusals are Refusals, which
 * own's boundary returns (core/canonical.ts catchRefusal).
 */
function fail(tag: ProseTag, loc: SourceLoc, text: string): never {
	throw new Refusal(CompileError.make(prose(tag, loc, text)))
}

/** A refusal for `reason`, a reason with facts beyond a sentence. A function declaration, as fail is. */
function failWith(reason: CompileReason): never {
	throw new Refusal(CompileError.make(reason))
}

const unwrap = <A>(result: Result.Result<A, CompileError>): A => {
	if (!result.ok) {
		throw new Refusal(result.error)
	}
	return result.value
}

/** `name` declared, a `kind` at `loc`, into `namespace` (core/identity.ts DeclaredNamespace): the name, parsed, or its
 * refusal. */
const declareName = (
	namespace: DeclaredNamespace,
	name: string,
	kind: string,
	loc: SourceLoc
): DeclaredName => unwrap(namespace.declare(name, kind, loc))

const textOf = (value: unknown): string => unwrap(descText(value))

const scopeOf = (side: SideDesc): SideScope => ({
	relation: side.relation,
	selection: side.selection
})

/** The terms of a statement's two sides paired by position (OwnedStatement): sides of one width. */
const pairSides = (
	left: SideDesc,
	right: SideDesc,
	s: StatementEntry
): NonEmptyReadonlyArray<SidePair> => {
	const unequal = (): never =>
		fail(
			"MalformedDescription",
			s.desc.loc,
			`${statementLabel(s.desc)} between sides of one width: ${left.terms.length} term(s) against ${right.terms.length}`
		)
	if (right.terms.length > left.terms.length) {
		unequal()
	}
	return mapNonEmpty(left.terms, (l, i) => {
		const r = right.terms[i]
		return r === undefined ? unequal() : { left: l, right: r }
	})
}

interface RelationEntry {
	readonly desc: SchemaRelationDesc
	readonly level: number
}

/** A relation that stores facts: an ordinary or a closed relation, never a derived one. */
type StoredRelationDesc = Exclude<SchemaRelationDesc, { readonly kind: "derived" }>

/** A relation a law names, with its heading: a stored relation declared at the law's level or below. */
interface LawRelationEntry {
	readonly desc: StoredRelationDesc
	readonly level: number
	readonly heading: Readonly<Record<string, FieldDesc>>
}

/** The relation a rule's side reads: a stored relation with its heading, or a derived one with its definition's fields. */
type SideRelationEntry =
	| { readonly kind: "stored"; readonly entry: LawRelationEntry }
	| { readonly kind: "derived"; readonly name: string; readonly fields: ReadonlySet<string> }

/** The fields a definition derives: its first rules' head, through every stage that keeps its input's heading. */
const definitionFields = (query: QueryDesc): ReadonlyArray<string> => {
	const fields = (stage: QueryStageDesc): ReadonlyArray<string> => {
		switch (stage.kind) {
			case "rules":
				return Object.keys(stage.arms[0].head)
			case "recursive":
				return Object.keys(stage.recursive.row)
			case "union":
			case "named":
			case "order":
			case "take":
			case "approx":
				return fields(stage.input)
			case "attach":
				return [...fields(stage.input), stage.attach.name]
		}
	}
	return fields(query.stage)
}

interface StatementEntry {
	readonly desc: StatementDesc
	readonly level: number
	readonly text: string
}

/** The entries of a map in name order, as `[...map.keys()].sort()` orders the names. */
const byName = <V>(map: ReadonlyMap<string, V>): ReadonlyArray<readonly [string, V]> =>
	[...map].toSorted(([a], [b]) => compareText(a, b))

/** A roster's heading: its handle, under `id`. */
const rosterHeading = (desc: RosterDesc): Readonly<Record<string, FieldDesc>> => ({
	id: { kind: "closedId", roster: desc.name }
})

/** A stored relation's heading: an ordinary or closed relation's fields' types, a roster's handle. */
const headingOf = (desc: StoredRelationDesc): Readonly<Record<string, FieldDesc>> => {
	switch (desc.kind) {
		case "relation":
			return fieldTypes(desc.fields)
		case "closed":
			return rosterHeading(desc)
		case "closedRelation":
			return desc.fields
	}
}

/** A roster's Description. */
type RosterDesc = Extract<RelationDesc, { readonly kind: "closed" }>

/** An ordinary relation's Description. */
type OrdinaryRelationOf = Extract<RelationDesc, { readonly kind: "relation" }>

/** The text a closed relation's row is ordered by: its key fields' handles, in key order (ir/desc.ts holds them so). */
const rowKeyText = (
	r: AdmittedClosedRelation,
	row: Readonly<Record<string, LiteralDesc>>
): string =>
	r.key
		.map((f) => row[f])
		.filter((v): v is string => typeof v === "string")
		.join("\u0000")

/** A closed relation with its rows in their key's text order, the one order a set of rows is held in. */
const canonicalRows = (r: AdmittedClosedRelation): AdmittedClosedRelation => ({
	...r,
	rows: r.rows
		.map((row) => ({ row, text: rowKeyText(r, row) }))
		.toSorted((a, b) => compareText(a.text, b.text))
		.map((e) => e.row)
})

/** The closedId a descriptor is, through any depth of contracts. */
const closedIdBase = (desc: FieldDesc): (FieldDesc & { readonly kind: "closedId" }) | undefined =>
	desc.kind === "closedId" ? desc : desc.kind === "contract" ? closedIdBase(desc.base) : undefined

/** The roster a closed relation's closed-id field `field` is over, through any depth of contracts. */
const fieldRosterOf = (r: AdmittedClosedRelation, field: string): string | undefined => {
	const desc = r.fields[field]
	return desc === undefined ? undefined : closedIdBase(desc)?.roster
}

const isHandle = (roster: StoredRelationDesc, value: LiteralDesc): boolean =>
	roster.kind === "closed" && isRosterHandle(roster, value)

const isRosterHandle = (roster: RosterDesc, value: LiteralDesc): boolean =>
	typeof value === "string" && roster.handles.includes(value)

/** How a closed relation's fields are written: by its declaration, which is its one caller. */
const callerWritten: Writing = Object.freeze({ kind: "caller" })

/** Each comparison's mirror: the operator that holds of the same two operands written the other way round. */
const mirrorOf: { readonly [Op in CompareOp]: CompareOp } = {
	eq: "eq",
	ne: "ne",
	lt: "gt",
	le: "ge",
	gt: "lt",
	ge: "le"
}

/** Whether an operand is a bare literal, which takes the type of the term it meets and so never stands first. */
const isBare = (e: ExprDesc): boolean => e.kind === "literal" && e.type === undefined

/**
 * A canonical form with its canonical text (ir/desc.ts descText), read once where the form is made: a form made of
 * canonical parts is written from their texts (ir/desc.ts descTextOver), so no part is encoded twice.
 */
interface Canonical<T> {
	readonly form: T
	readonly text: string
}

/** A form that is canonical as it is, with its text. */
const asIs = <T>(form: T): Canonical<T> => ({ form, text: textOf(form) })

/** A form made of canonical parts: each member `parts` names holds one, written from the text `parts` maps it to. */
const madeOf = <T>(form: T, parts: ReadonlyMap<string, string>): Canonical<T> => ({
	form,
	text: unwrap(descTextOver(form, parts))
})

/**
 * A comparison in the one orientation of the two that mean it: a bare literal stands second; of two operands that may
 * stand either way, eq and ne put them in canonical text order, and an ordering is stated as lt or le. Each of
 * PostgreSQL's comparison operators has its mirror as its commutator: both are NULL when either operand is, and both
 * read NaN as above every other float, so the two orientations mean the same.
 */
const canonicalComparison = (
	expr: Extract<ExprDesc, { readonly kind: "compare" }>
): Canonical<ExprDesc> => {
	const left = canonicalPredicate(expr.left)
	const right = canonicalPredicate(expr.right)
	const swapped =
		isBare(left.form) !== isBare(right.form)
			? isBare(left.form)
			: expr.op === "eq" || expr.op === "ne"
				? compareText(left.text, right.text) > 0
				: expr.op === "gt" || expr.op === "ge"
	const [first, second] = swapped ? [right, left] : [left, right]
	return madeOf(
		Object.freeze({
			...expr,
			op: swapped ? mirrorOf[expr.op] : expr.op,
			left: first.form,
			right: second.form
		}),
		new Map([
			["left", first.text],
			["right", second.text]
		])
	)
}

/**
 * A predicate in canonical form, recursively: every conjunction's and disjunction's operands in canonical order, every
 * comparison in its canonical orientation (`canonicalComparison`), and every IN list's values each once, in canonical
 * order. No operation of a row check raises (scalar/compute/registry.ts Totality), so none of these orders carries
 * meaning. No other term reorders: a computation's operands keep their meaning by position.
 */
const canonicalPredicate = (expr: ExprDesc): Canonical<ExprDesc> => {
	switch (expr.kind) {
		case "and":
		case "or": {
			const sorted = sortNonEmpty(mapNonEmpty(expr.args, canonicalPredicate), (a, b) =>
				compareText(a.text, b.text)
			)
			const args = mapNonEmpty(sorted, (a) => a.form)
			Object.freeze(args)
			return madeOf(
				Object.freeze({ ...expr, args }),
				new Map([["args", arrayText(sorted.map((a) => a.text))]])
			)
		}
		case "not": {
			const arg = canonicalPredicate(expr.arg)
			return madeOf(Object.freeze({ ...expr, arg: arg.form }), new Map([["arg", arg.text]]))
		}
		case "compare":
			return canonicalComparison(expr)
		case "in": {
			const arg = canonicalPredicate(expr.arg)
			const values = [...new Map(expr.values.map((v) => [textOf(v), v] as const))].toSorted(
				([a], [b]) => compareText(a, b)
			)
			return madeOf(
				Object.freeze({
					...expr,
					arg: arg.form,
					values: Object.freeze(values.map(([, v]) => v))
				}),
				new Map([
					["arg", arg.text],
					["values", arrayText(values.map(([text]) => text))]
				])
			)
		}
		case "var":
		case "field":
		case "value":
		case "parent":
		case "param":
		case "literal":
		case "compute":
		case "cast":
		case "base":
		case "cond":
		case "when":
		case "between":
		case "allen":
		case "pointIn":
		case "absent":
		case "closedAt":
		case "closedRow":
		case "closedHas":
			return asIs(expr)
	}
}

/**
 * A selection in canonical form with its text: its conjuncts' own conjuncts (ir/desc.ts conjunctsOf), each with its
 * operands ordered, each once, in the order of their canonical texts. A conjunction is the set of its conjuncts, so
 * two selections of one set of conjuncts are one selection, and one of none reads every fact.
 */
const canonicalSelectionOf = (selection: SelectionDesc): Canonical<SelectionDesc> => {
	const conjuncts = [
		...new Map(
			selection.conjuncts
				.flatMap(conjunctsOf)
				.map(canonicalPredicate)
				.map((c) => [c.text, c.form] as const)
		)
	].toSorted(([a], [b]) => compareText(a, b))
	return madeOf(
		Object.freeze({ conjuncts: Object.freeze(conjuncts.map(([, conjunct]) => conjunct)) }),
		new Map([["conjuncts", arrayText(conjuncts.map(([text]) => text))]])
	)
}

/** A selection in canonical form (`canonicalSelectionOf`). */
export const canonicalSelection = (selection: SelectionDesc): SelectionDesc =>
	canonicalSelectionOf(selection).form

/** A side in canonical form: its selection's (`canonicalSelectionOf`). */
const canonicalSide = (side: SideDesc): Canonical<SideDesc> => {
	const selection = canonicalSelectionOf(side.selection)
	return madeOf(
		Object.freeze({ ...side, selection: selection.form }),
		new Map([["selection", selection.text]])
	)
}

/**
 * A statement in canonical form: a check's predicate and each side's selection with their operands ordered.
 * Equivalent declarations then have one canonical text, one fingerprint, and are one declaration.
 */
const canonicalStatement = (s: StatementDesc): Canonical<StatementDesc> => {
	switch (s.kind) {
		case "check": {
			const predicate = canonicalPredicate(s.predicate)
			return madeOf(
				Object.freeze({ ...s, predicate: predicate.form }),
				new Map([["predicate", predicate.text]])
			)
		}
		case "key": {
			const side = canonicalSide(s.side)
			return madeOf(Object.freeze({ ...s, side: side.form }), new Map([["side", side.text]]))
		}
		case "contained": {
			const left = canonicalSide(s.left)
			const right = canonicalSide(s.right)
			return madeOf(
				Object.freeze({ ...s, left: left.form, right: right.form }),
				new Map([
					["left", left.text],
					["right", right.text]
				])
			)
		}
		case "fold": {
			const step = canonicalSide(s.step)
			return madeOf(Object.freeze({ ...s, step: step.form }), new Map([["step", step.text]]))
		}
		case "mutable":
		case "family":
		case "tree":
		case "alternatives":
			return asIs(s)
	}
}

/**
 * A statement in canonical form and that form's canonical text: equal statements, however written, have one, and a
 * schema keeps one statement of each (Owner's collectStatements, schema/levels.ts levelContent).
 */
export interface CanonicalStatement {
	readonly form: StatementDesc
	readonly text: string
}

/** A statement's canonical form and text (CanonicalStatement), read once where the statement is built or enters. */
export const canonicalStatementOf = (s: StatementDesc): CanonicalStatement =>
	Object.freeze(canonicalStatement(s))

/** The canonical text of a statement, its canonical form's (CanonicalStatement). */
export const canonicalStatementText = (s: StatementDesc): string => canonicalStatementOf(s).text

/** The row's fields an expression references, added to `out`; a variable, value, parameter or literal holds none. */
const fieldRefs = (expr: ExprDesc, out: Set<string>): Set<string> => {
	switch (expr.kind) {
		case "field":
			out.add(expr.field)
			return out
		case "compute":
		case "and":
		case "or":
		case "closedAt":
		case "closedRow":
		case "closedHas":
			for (const a of expr.args) {
				fieldRefs(a, out)
			}
			return out
		case "cast":
		case "base":
		case "not":
		case "in":
			fieldRefs(expr.arg, out)
			return out
		case "cond":
			fieldRefs(expr.pred, out)
			fieldRefs(expr.onTrue, out)
			fieldRefs(expr.onFalse, out)
			return out
		case "when":
			fieldRefs(expr.subject, out)
			fieldRefs(expr.proved, out)
			fieldRefs(expr.otherwise, out)
			return out
		case "compare":
			fieldRefs(expr.left, out)
			fieldRefs(expr.right, out)
			return out
		case "between":
			fieldRefs(expr.arg, out)
			fieldRefs(expr.low, out)
			fieldRefs(expr.high, out)
			return out
		case "allen":
			fieldRefs(expr.left, out)
			fieldRefs(expr.right, out)
			return out
		case "pointIn":
			fieldRefs(expr.point, out)
			fieldRefs(expr.span, out)
			return out
		case "var":
		case "value":
		case "parent":
		case "param":
		case "literal":
		case "absent":
			return out
	}
}

const statementLabel = (s: StatementDesc): string => {
	switch (s.kind) {
		case "key":
			return `key (${s.side.terms.map(termText).join(", ")}) of ${s.side.selection.conjuncts.length === 0 ? "" : "selected "}${s.side.relation}`
		case "mutable":
			return `mutable ${s.relation}`
		case "check":
			return `check ${s.name}`
		case "contained":
			return `contained ${s.left.relation} in ${s.right.relation}`
		case "family":
			return `${s.order} ${s.member.relation} in ${s.slots.owner}.${s.slots.count}`
		case "tree":
			return `tree ${s.member.relation}`
		case "fold":
			return `fold ${s.monoid} of ${s.step.relation} into ${s.end.relation}`
		case "alternatives":
			return `alternatives ${s.parent.relation}.${s.discriminator}`
	}
}

/** The key over `keyFields` of the ordinary relation `name` described by `r`, its identity minted: refused when it names a
 * field `r` lacks, or when its index entry is unrepresentable (UnrepresentableKey). */
const ownKey = (
	name: string,
	r: RelationDesc & { readonly kind: "relation" },
	keyFields: DeclaredKey,
	primary: boolean,
	loc: SourceLoc
): OwnedKey => {
	const layout = keyLayout(
		keyFields.map((field) => {
			const decl = r.fields[field]
			if (decl === undefined) {
				return fail(
					"MalformedDescription",
					loc,
					`a key over fields of ${name}; ${field} is not one`
				)
			}
			if (!descCapabilities(decl.type).includes("equality")) {
				return fail(
					"UnsupportedOperation",
					loc,
					`equality: a key over ${name}.${field}, of a type with no equality, as bytes is: no key holds one`
				)
			}
			return { field, desc: decl.type }
		})
	)
	if (!layout.ok) {
		failWith({
			_tag: "UnrepresentableKey",
			at: loc,
			subject: `key (${keyFields.join(", ")}) of ${name}`,
			key: keyFields,
			fault: layout.error
		})
	}
	const named = primary ? identity.primaryKey(name) : identity.key(name, keyFields)
	return { fields: keyFields, primary, named, constraint: identifierOf(named), loc }
}

/**
 * The identity at the naming door of a schema's installation under its declared name `name`, declared at `loc`: refused
 * as MalformedDescription when the name breaks a schema name's rule (core/identity.ts parseSchemaName). A command that
 * only places a schema's migrations reads it without owning the schema.
 */
export const schemaInstallation = (
	name: string,
	loc: SourceLoc
): Result.Result<Identity<"schema">, CompileError> => {
	const schemaName = parseSchemaName(name)
	return schemaName.ok
		? Result.ok(identity.schema(schemaName.value))
		: Result.err(
				malformedDescription(
					loc,
					`the declared schema name ${JSON.stringify(name)} as ${schemaName.error}`
				)
			)
}

/** Whether a field is a span, through any depth of contracts: a containment pairing one is a coverage law. */
const spanned = (desc: FieldDesc | undefined): boolean =>
	desc?.kind === "span" || (desc?.kind === "contract" && spanned(desc.base))

/**
 * Whether a side of an ordinary relation reads every fact by fields of no span: the side a foreign key's columns are,
 * which needs no column, no unique index and no CHECK of its own.
 */
const plainSide = (side: SideDesc, entry: RelationEntry): boolean => {
	const fields = candidateKeyFields(side)
	const desc = entry.desc
	return (
		fields !== undefined &&
		desc.kind === "relation" &&
		!fields.some((f) => spanned(desc.fields[f]?.type))
	)
}

/**
 * The levels of a canonical description, root first, each with its installation, minted from its declared name, and
 * its fingerprint, which `fingerprinted` gives the chain of levels. Two levels whose names convert to one PostgreSQL
 * schema are IdentifierCollision.
 */
const ownedLevels = (
	canonical: SchemaDesc,
	fingerprinted: LevelFingerprints
): NonEmptyReadonlyArray<OwnedLevel> => {
	const schemas = new Map<string, SchemaDesc>()
	return mapNonEmpty(fingerprinted(levelChain(canonical)), ({ level, fingerprint }): OwnedLevel => {
		const installation = unwrap(schemaInstallation(level.name, level.loc))
		const ident = identifierOf(installation)
		const prior = schemas.get(ident)
		if (prior !== undefined) {
			failWith({
				_tag: "IdentifierCollision",
				at: level.loc,
				other: prior.loc,
				identifier: ident,
				what: "the installation's schema",
				declaration: `schema ${level.name}`,
				otherDeclaration: `schema ${prior.name}`
			})
		}
		schemas.set(ident, level)
		return {
			name: level.name,
			installation,
			fingerprint,
			loc: level.loc
		}
	})
}

/** The chain of an owned schema's levels, root first, each with its fingerprint. */
type LevelFingerprints = (
	levels: NonEmptyReadonlyArray<SchemaDesc>
) => NonEmptyReadonlyArray<{ readonly level: SchemaDesc; readonly fingerprint: SchemaFingerprint }>

/**
 * Each level's fingerprint hashed over its canonical description: the digest of the canonical description it tops,
 * each level's text written once and read by the level above (core/fingerprint.ts schemaLevel). What `grizzle
 * generate` and `grizzle check` record and verify.
 */
const hashedLevels: LevelFingerprints = (levels) => {
	let below: SchemaLevel | undefined
	return mapNonEmpty(levels, (level) => {
		below = unwrap(schemaLevel(level, below))
		return { level, fingerprint: below.fingerprint }
	})
}

/** A level of a schema as its installation's snapshot records it: its declared name and its fingerprint. */
/**
 * Each level's fingerprint as the installation's snapshot records it at the level's position: the fingerprints a layer
 * serves under, which `grizzle generate` hashed and recorded, so the layer hashes none. The snapshot is trusted as the
 * one generate wrote for the schema, which check, drift and migrate verify, so nothing of it is compared with the
 * schema here; a position it records no level at is MalformedDescription, since no fingerprint stands there.
 */
const recordedLevels =
	(recorded: ReadonlyArray<SchemaFingerprint>): LevelFingerprints =>
	(levels) =>
		mapNonEmpty(levels, (level, at) => {
			const fingerprint = recorded[at]
			if (fingerprint === undefined) {
				return fail(
					"MalformedDescription",
					level.loc,
					`a snapshot.json that records level ${at}, schema ${level.name}: it records ${recorded.length} levels`
				)
			}
			return { level, fingerprint }
		})

/** The PostgreSQL schemas an owned schema's levels install in under their declared names, root first. */
export const installationsOf = (owned: Owned): NonEmptyReadonlyArray<Identity<"schema">> =>
	mapNonEmpty(owned.levels, (l) => l.installation)

/** A description's levels, root first and `desc` last. */
export const levelChain = (desc: SchemaDesc): NonEmptyReadonlyArray<SchemaDesc> =>
	desc.extends === undefined ? [desc] : appendNonEmpty(levelChain(desc.extends), desc)

/** The candidate keys and row checks the statements state over one relation, in statement order. */
interface RelationLaws {
	readonly keys: ReadonlyArray<OwnedKey>
	readonly checks: ReadonlyArray<OwnedCheck>
}

class Owner {
	readonly #schemaName: string
	readonly #levels: NonEmptyReadonlyArray<SchemaDesc>
	readonly #relations = new Map<string, RelationEntry>()
	readonly #statements: Array<StatementEntry> = []
	/** Each ordinary relation's namespace of row checks, filled as its check statements are owned. */
	readonly #checkNames = new Map<string, DeclaredNamespace>()
	readonly #contracts = new Map<
		string,
		{ readonly desc: FieldDesc & { readonly kind: "contract" }; readonly loc: SourceLoc }
	>()
	readonly #mutable = new Set<string>()

	/**
	 * Each level's statements, root first, as the level writes them, each in canonical form with its canonical text
	 * (CanonicalStatement): read once where each statement was built or entered.
	 */
	readonly #written: NonEmptyReadonlyArray<ReadonlyArray<CanonicalStatement>>

	constructor(desc: SchemaDesc, written: NonEmptyReadonlyArray<ReadonlyArray<CanonicalStatement>>) {
		this.#levels = levelChain(desc)
		this.#schemaName = desc.name
		this.#written = written
	}

	run(fingerprinted: LevelFingerprints): Owned {
		this.#collectRelations()
		this.#checkDerived()
		this.#collectFields()
		this.#collectStatements()
		const statements = this.#statements.map((s) => {
			const statement = this.#checkStatement(s)
			this.#checkLevels(s)
			return { text: s.text, statement }
		})
		const relations = this.#ownRelations(statements.map((s) => s.statement))
		const contracts = this.#ownContracts()
		const canonical = this.#canonicalDesc()
		const levels = ownedLevels(canonical, fingerprinted)
		const fingerprint = lastNonEmpty(levels).fingerprint
		const fieldIds = Object.values(relations)
			.flatMap((r) => Object.values(r.fields).map((f) => f.id))
			.toSorted()
		const ordered = statements.toSorted((a, b) => (a.text < b.text ? -1 : 1))
		return {
			desc: canonical,
			fingerprint,
			name: this.#schemaName,
			levels,
			relations,
			statements: ordered.map((s) => s.statement),
			statementAt: new Map(ordered.map((s, i) => [s.text, i] as const)),
			contracts,
			fieldIds
		}
	}

	/**
	 * Each relation a level declares: a derived one only above the base, and one declaration per name. A closed
	 * relation's rows are a set, so they are held in one order, their key's text order, and two declarations of one set
	 * of rows are one declaration.
	 */
	#collectRelations(): void {
		for (const [level, schema] of this.#levels.entries()) {
			for (const declared of schema.relations) {
				const r = declared.kind === "closedRelation" ? canonicalRows(declared) : declared
				if (r.kind === "derived" && level === 0) {
					fail(
						"MalformedDescription",
						r.loc,
						`derived relation ${r.name} declared in an extension of the schema its definition reads, schema.extend`
					)
				}
				const prior = this.#relations.get(r.name)
				if (prior === undefined) {
					this.#relations.set(r.name, { desc: r, level })
					continue
				}
				if (textOf(prior.desc) !== textOf(r)) {
					failWith({
						_tag: "DuplicateIdentity",
						at: r.loc,
						duplicate: { kind: "relation", name: r.name, earlier: prior.desc.loc }
					})
				}
			}
		}
	}

	#relation(name: string, loc: SourceLoc, what: string): RelationEntry {
		const entry = this.#relations.get(name)
		if (entry === undefined) {
			return fail(
				"MalformedDescription",
				loc,
				`${what} names ${name}, which no level of the schema declares`
			)
		}
		return entry
	}

	/**
	 * Derived definitions read no parameter and no context: a materialized view holds no session, so no context fact
	 * reaches a derived definition. Each reads a live derived relation through its definition, as the query builder
	 * writes a match of one, never by its name, which no stored relation answers. Each is one level above the highest
	 * derived level it reads.
	 */
	#checkDerived(): void {
		for (const entry of this.#relations.values()) {
			const r = entry.desc
			if (r.kind !== "derived") {
				continue
			}
			const uses = queryUses(r.query)
			if (uses.inputs.size > 0) {
				fail(
					"MalformedDescription",
					entry.desc.loc,
					`a parameterless definition for ${r.name}; it reads ${[...uses.inputs].toSorted(compareStrings).join(", ")}`
				)
			}
			if (uses.contexts.size > 0) {
				fail(
					"MalformedDescription",
					entry.desc.loc,
					`a definition for ${r.name} that matches no context, which a materialized view holds no session for; it matches ${[...uses.contexts.keys()].toSorted(compareStrings).join(", ")}`
				)
			}
			let level = 1
			for (const read of uses.relations) {
				const lower = this.#relation(read, entry.desc.loc, `the definition of ${r.name}`)
				if (lower.desc.kind === "derived" && lower.desc.storage === "live") {
					fail(
						"MalformedDescription",
						entry.desc.loc,
						`a definition of ${r.name} that reads the live derived relation ${read} through its definition; it matches ${read} by name, and a live derived relation stores nothing to match, so a query over it matches the query it is defined by`
					)
				}
				if (lower.level >= entry.level) {
					fail(
						"MalformedDescription",
						entry.desc.loc,
						`a definition over the levels below ${r.name}; ${read} is declared at its own level or above`
					)
				}
				if (lower.desc.kind === "derived") {
					level = Math.max(level, lower.desc.level + 1)
				}
			}
			if (level !== r.level) {
				fail(
					"MalformedDescription",
					entry.desc.loc,
					`derived level ${level} for ${r.name}, one above the highest derived level it reads, not ${r.level}`
				)
			}
		}
	}

	/**
	 * Fields: closed references and sets resolve to declared rosters of the field's level or below, and contract names
	 * are not reused with a conflicting descriptor. A derived relation's fields are its definition's, which derived
	 * analysis reads. How many columns a table holds is PostgreSQL's limit, checked where the installation emits the
	 * table (physical/ddl/context.ts).
	 */
	#collectFields(): void {
		const ordered = [...this.#relations.values()].toSorted((a, b) =>
			a.desc.name < b.desc.name ? -1 : 1
		)
		for (const entry of ordered) {
			if (entry.desc.kind === "derived") {
				continue
			}
			const heading = headingOf(entry.desc)
			for (const [field, desc] of Object.entries(heading)) {
				const loc = labeledChildLoc(entry.desc.loc, field, `field ${entry.desc.name}.${field}`)
				nestedFields(desc, (d) => {
					if (d.kind === "closedId" || d.kind === "bits") {
						this.#rosterAt(d.roster, entry, loc, d.kind === "closedId" ? "closedId" : "bits")
					}
					if (d.kind === "contract") {
						const prior = this.#contracts.get(d.name)
						if (prior === undefined) {
							this.#contracts.set(d.name, { desc: d, loc })
						} else if (textOf(prior.desc) !== textOf(d)) {
							failWith({
								_tag: "DuplicateIdentity",
								at: loc,
								duplicate: { kind: "contract", name: d.name, earlier: prior.loc }
							})
						}
					}
				})
			}
			switch (entry.desc.kind) {
				case "relation":
					this.#checkDecodedColumns(entry, entry.desc)
					break
				case "closed":
					this.#checkRoster(entry, entry.desc)
					break
				case "closedRelation":
					this.#checkKeySlots(entry, entry.desc)
					break
			}
		}
	}

	/**
	 * Each slot of a closed relation's key names fin(O, n) over a closed relation O of its level or below and a natural
	 * field n of O beside O's key, and O's key pairs with the relation's first key fields, roster for roster in order:
	 * those fields are the owner prefix, which every slot follows and every slot's O shares the length of. That an
	 * owner's count bounds each row's slot code is a law of the codes, checked when the installation packs the relation.
	 */
	#checkKeySlots(entry: RelationEntry, r: AdmittedClosedRelation): void {
		let prefix: number | undefined
		for (const slot of r.slots) {
			const loc = labeledChildLoc(entry.desc.loc, slot.field, `slot ${r.name}.${slot.field}`)
			const fin = `fin(${slot.fin.owner}, ${JSON.stringify(slot.fin.count)})`
			const declared = this.#relations.get(slot.fin.owner)
			if (declared?.desc.kind !== "closedRelation") {
				return fail(
					"MalformedDescription",
					loc,
					`${fin} over a closed relation the schema declares; ${slot.fin.owner} is not one`
				)
			}
			if (declared.level > entry.level) {
				return fail(
					"MalformedDescription",
					loc,
					`${fin} over a closed relation of this level or below; ${slot.fin.owner} is declared above`
				)
			}
			const owner = declared.desc
			const count = owner.fields[slot.fin.count]
			if (count === undefined || owner.key.includes(slot.fin.count) || !isNaturalDesc(count)) {
				return fail(
					"MalformedDescription",
					loc,
					`${fin} counted by a natural field of ${owner.name} beside its key; ${slot.fin.count} is not one`
				)
			}
			const paired = owner.key.every((field, i) => {
				const own = r.key[i]
				const roster = own === undefined ? undefined : fieldRosterOf(r, own)
				return roster !== undefined && roster === fieldRosterOf(owner, field)
			})
			if (!paired || r.key.indexOf(slot.field) < owner.key.length) {
				return fail(
					"MalformedDescription",
					loc,
					`${fin} whose key, ${owner.key.join(", ")}, pairs with ${r.name}'s first key fields in order, roster for roster, the slot after them`
				)
			}
			if (prefix !== undefined && prefix !== owner.key.length) {
				return fail(
					"MalformedDescription",
					loc,
					`slots counted over one owner prefix of ${r.name}'s key; ${fin}'s key has ${owner.key.length} fields where another slot's has ${prefix}`
				)
			}
			prefix = owner.key.length
		}
	}

	/** The roster `roster` a field of `entry` reads, declared at the field's level or below. */
	#rosterAt(roster: string, entry: RelationEntry, loc: SourceLoc, former: string): RosterDesc {
		const declared = this.#relations.get(roster)
		if (declared?.desc.kind !== "closed") {
			return fail(
				"MalformedDescription",
				loc,
				`${former}(${roster}) over a roster the schema declares; ${roster} is not one`
			)
		}
		if (declared.level > entry.level) {
			fail(
				"MalformedDescription",
				loc,
				`${former}(${roster}) over a roster of this level or below; ${roster} is declared above`
			)
		}
		return declared.desc
	}

	/** A roster's handles fit the name its names constant holds each in. */
	/**
	 * A roster's handles must each be a name PostgreSQL stores as written: no NUL (a name ends at its first one, as
	 * NAMEDATALEN's C string does), no lone surrogate (no UTF-8 encodes one), and at most `handleMaxBytes` bytes.
	 */
	#checkRoster(entry: RelationEntry, r: RosterDesc): void {
		for (const handle of r.handles) {
			if (handle.includes("\u0000") || !handle.isWellFormed()) {
				fail(
					"MalformedDescription",
					labeledChildLoc(entry.desc.loc, "handles", `roster of ${r.name}`),
					`handles that hold no NUL and no lone surrogate, as a PostgreSQL name does; ${JSON.stringify(handle)} holds one`
				)
			}
			if (utf8Length(handle) > handleMaxBytes.value) {
				fail(
					"MalformedDescription",
					labeledChildLoc(entry.desc.loc, "handles", `roster of ${r.name}`),
					`handles of at most ${handleMaxBytes.value} UTF-8 bytes, the most a name holds (NAMEDATALEN - 1); ${JSON.stringify(handle)} has ${utf8Length(handle)}`
				)
			}
		}
	}

	/**
	 * A role view shows each closed-id field `f` beside its name, the column decodedColumn(f): that column's identifier
	 * fits a name, and no other field of the relation converts to it.
	 */
	#checkDecodedColumns(entry: RelationEntry, r: OrdinaryRelationOf): void {
		const columns = new Map<string, string>()
		for (const field of Object.keys(r.fields)) {
			const declared = unwrap(this.#fieldName(field, entry))
			columns.set(identifierOf(identity.column(declared)), field)
		}
		for (const [field, decl] of Object.entries(r.fields)) {
			if (closedIdBase(decl.type) === undefined) {
				continue
			}
			const loc = labeledChildLoc(entry.desc.loc, field, `field ${r.name}.${field}`)
			const declared = unwrap(this.#fieldName(field, entry))
			if (!decodedColumnFits(declared)) {
				fail(
					"MalformedDescription",
					loc,
					`a closed-id field whose decoded column ${field}_name fits a name of ${handleMaxBytes.value} bytes`
				)
			}
			const other = columns.get(identifierOf(identity.decodedColumn(declared)))
			if (other !== undefined) {
				fail(
					"MalformedDescription",
					loc,
					`a closed-id field whose decoded column ${field}_name is no field of ${r.name}; ${other} is`
				)
			}
		}
	}

	/** A field's name parsed by the naming door, as its relation's ownership declares it. */
	#fieldName(field: string, entry: RelationEntry): Result.Result<DeclaredName, CompileError> {
		return new DeclaredNamespace(`relation ${entry.desc.name}'s field`).declare(
			field,
			"field",
			labeledChildLoc(entry.desc.loc, field, `field ${entry.desc.name}.${field}`)
		)
	}

	/** Each statement a level writes, in its canonical form, kept once however many levels state it. */
	#collectStatements(): void {
		const seen = new Set<string>()
		for (const [level, statements] of this.#written.entries()) {
			for (const { form, text } of statements) {
				if (!seen.has(text)) {
					seen.add(text)
					this.#statements.push({ desc: form, level, text })
				}
			}
		}
	}

	/**
	 * A relation a statement names, declared at the statement's level or below: a stored relation, or a derived one,
	 * which a key's, a check's and a containment's side may read (`#sideRelation`).
	 */
	#declared(name: string, s: StatementEntry): RelationEntry {
		const entry = this.#relation(name, s.desc.loc, statementLabel(s.desc))
		if (entry.level > s.level) {
			fail(
				"MalformedDescription",
				s.desc.loc,
				`${statementLabel(s.desc)} names ${name}, which a higher level declares`
			)
		}
		return entry
	}

	/**
	 * A stored relation a statement names, declared at the statement's level or below: a family, a tree, a fold, an
	 * alternatives statement and mutable name the rows grizzle writes, which a derived relation's definition states.
	 */
	#lawRelation(name: string, s: StatementEntry): LawRelationEntry {
		const entry = this.#declared(name, s)
		const desc = entry.desc
		if (desc.kind === "derived") {
			return fail(
				"MalformedDescription",
				s.desc.loc,
				`${statementLabel(s.desc)} over a stored relation; ${name} is a derived relation, whose rows its definition states and no write draws`
			)
		}
		return { desc, level: entry.level, heading: headingOf(desc) }
	}

	/**
	 * The relation a key's, a check's or a containment's side reads: a stored relation, or a derived relation, read by
	 * its definition's heading, whose fields' types the theory reads (analysis/theory/query.ts).
	 */
	#sideRelation(name: string, s: StatementEntry): SideRelationEntry {
		const entry = this.#declared(name, s)
		const desc = entry.desc
		return desc.kind === "derived"
			? { kind: "derived", name, fields: new Set(definitionFields(desc.query)) }
			: { kind: "stored", entry: { desc, level: entry.level, heading: headingOf(desc) } }
	}

	#ordinary(name: string, s: StatementEntry, why: string): LawRelationEntry {
		const entry = this.#lawRelation(name, s)
		if (entry.desc.kind !== "relation") {
			fail(
				"MalformedDescription",
				s.desc.loc,
				`${statementLabel(s.desc)} over an ordinary relation; ${name} ${why}`
			)
		}
		return entry
	}

	#requireFields(entry: LawRelationEntry, fields: ReadonlyArray<string>, s: StatementEntry): void {
		for (const f of fields) {
			if (!Object.hasOwn(entry.heading, f)) {
				fail(
					"MalformedDescription",
					s.desc.loc,
					`${statementLabel(s.desc)} names ${entry.desc.name}.${f}, which is not a field of ${entry.desc.name}`
				)
			}
		}
	}

	/**
	 * A key's or a containment's side as ownership admits it: a side of a stored relation (`#checkSide`), or of a derived
	 * relation, each term's field one of its definition's heading and its selection a predicate over that heading's
	 * fields alone; the theory types the terms, the selection and every handle it compares (analysis/theory/query.ts).
	 */
	#checkRuleSide(side: SideDesc, s: StatementEntry): SideRelationEntry {
		const read = this.#sideRelation(side.relation, s)
		if (read.kind === "stored") {
			this.#checkSide(side, s)
			return read
		}
		const requireField = (field: string): void => {
			if (!read.fields.has(field)) {
				fail(
					"MalformedDescription",
					s.desc.loc,
					`${statementLabel(s.desc)} names ${side.relation}.${field}, which is not a field of ${side.relation}`
				)
			}
		}
		for (const t of side.terms) {
			requireField(t.field)
		}
		for (const conjunct of side.selection.conjuncts) {
			const foreign = foreignInput(conjunct)
			if (foreign !== undefined) {
				fail(
					"MalformedDescription",
					s.desc.loc,
					`${statementLabel(s.desc)} selects ${side.relation} by its row only, not ${foreign}`
				)
			}
			for (const f of fieldRefs(conjunct, new Set())) {
				requireField(f)
			}
		}
		return read
	}

	/**
	 * A law side as ownership admits it: over a stored relation of the statement's level or below, each term a field of
	 * its heading and each pred term's field natural, and its selection a predicate over its own row, every field it
	 * reads the relation's and every handle it compares with a closedId field one of its roster's.
	 */
	#checkSide(side: SideDesc, s: StatementEntry): LawRelationEntry {
		const entry = this.#lawRelation(side.relation, s)
		this.#requireFields(
			entry,
			side.terms.map((t) => t.field),
			s
		)
		for (const t of side.terms) {
			const desc = entry.heading[t.field]
			if (desc !== undefined && !descCapabilities(desc).includes("equality")) {
				fail(
					"UnsupportedOperation",
					s.desc.loc,
					`equality: ${statementLabel(s.desc)} reads ${side.relation}.${t.field}, of a type with no equality, as bytes is: no rule's side reads one`
				)
			}
			if (t.kind === "pred" && (desc === undefined || !isNaturalDesc(desc))) {
				fail(
					"MalformedDescription",
					s.desc.loc,
					`${statementLabel(s.desc)} reads pred(${side.relation}.${t.field}); pred reads a natural field, and ${t.field} is not one`
				)
			}
		}
		for (const conjunct of side.selection.conjuncts) {
			const foreign = foreignInput(conjunct)
			if (foreign !== undefined) {
				fail(
					"MalformedDescription",
					s.desc.loc,
					`${statementLabel(s.desc)} selects ${side.relation} by its row only, not ${foreign}`
				)
			}
			this.#requireFields(entry, [...fieldRefs(conjunct, new Set())], s)
			this.#checkPredicateHandles(conjunct, entry.heading, s)
		}
		return entry
	}

	/** The closed relation a closedId descriptor references, through any depth of contracts. */
	#rosterOf(desc: FieldDesc | undefined): RosterDesc | undefined {
		const base = desc === undefined ? undefined : closedIdBase(desc)
		if (base === undefined) {
			return undefined
		}
		const roster = this.#relations.get(base.roster)?.desc
		return roster?.kind === "closed" ? roster : undefined
	}

	/**
	 * A row check's literals compared with a closedId field, at any contract depth, are handles of its roster. Only a
	 * comparison, a range and a set membership compare a field with literals.
	 */
	#checkPredicateHandles(
		predicate: ExprDesc,
		heading: Readonly<Record<string, FieldDesc>>,
		s: StatementEntry
	): void {
		const check = (term: ExprDesc, values: ReadonlyArray<LiteralDesc>) => {
			if (term.kind !== "field") {
				return
			}
			const roster = this.#rosterOf(heading[term.field])
			if (roster === undefined) {
				return
			}
			for (const value of values) {
				if (!isHandle(roster, value)) {
					fail(
						"MalformedDescription",
						s.desc.loc,
						`${statementLabel(s.desc)} compares ${term.field} with a handle of ${roster.name}; ${JSON.stringify(value)} is not one`
					)
				}
			}
		}
		const literal = (e: ExprDesc): ReadonlyArray<LiteralDesc> =>
			e.kind === "literal" ? [e.value] : []
		switch (predicate.kind) {
			case "compare":
				check(predicate.left, literal(predicate.right))
				check(predicate.right, literal(predicate.left))
				return
			case "between":
				check(predicate.arg, [...literal(predicate.low), ...literal(predicate.high)])
				return
			case "in":
				check(predicate.arg, predicate.values)
				return
			case "and":
			case "or":
				for (const arg of predicate.args) {
					this.#checkPredicateHandles(arg, heading, s)
				}
				return
			case "not":
				this.#checkPredicateHandles(predicate.arg, heading, s)
				return
			case "var":
			case "field":
			case "value":
			case "parent":
			case "param":
			case "literal":
			case "compute":
			case "cast":
			case "base":
			case "cond":
			case "when":
			case "allen":
			case "pointIn":
			case "absent":
			case "closedAt":
			case "closedRow":
			case "closedHas":
				return
		}
	}

	/**
	 * A statement reaches an ordinary relation of a level below its own only where no write of that level changes: as
	 * one side of a containment between stored relations whose sides are fields, unselected and of no span, its target
	 * on the target relation's primary key or on a key declared at that relation's level or below, which PostgreSQL holds
	 * as a deferred foreign key judged at COMMIT; or in a rule over a query, a containment one of whose sides is a
	 * derived relation, or a key or a check over one, whose deferred triggers PostgreSQL runs at COMMIT. A process over
	 * the lower level holds none of the levels above it and compiles its writes alone, so every other reach is
	 * LevelRefused: a key, a check, mutable, a family, tree, fold or alternatives over a lower relation, and a
	 * containment with both sides on lower relations, or reaching one by a selected, pred or span side, or into no key.
	 * A roster's, a closed relation's and a derived relation's rows no write changes.
	 */
	#checkLevels(s: StatementEntry): void {
		const lower = (relation: string): RelationEntry | undefined => {
			const entry = this.#relations.get(relation)
			return entry?.desc.kind === "relation" && entry.level < s.level ? entry : undefined
		}
		const refuse = (relation: string, entry: RelationEntry): never =>
			failWith({
				_tag: "LevelRefused",
				at: s.desc.loc,
				statement: statementLabel(s.desc),
				level: this.#levelName(s.level),
				relation,
				below: this.#levelName(entry.level)
			})
		const reach = (relations: ReadonlyArray<string>): void => {
			for (const relation of relations) {
				const entry = lower(relation)
				if (entry !== undefined) {
					refuse(relation, entry)
				}
			}
		}
		const d = s.desc
		const derived = (relation: string): boolean =>
			this.#relations.get(relation)?.desc.kind === "derived"
		switch (d.kind) {
			case "contained": {
				if (derived(d.left.relation) || derived(d.right.relation)) {
					return
				}
				const source = lower(d.left.relation)
				const target = lower(d.right.relation)
				if (source !== undefined) {
					const keyed = this.#relation(d.right.relation, s.desc.loc, statementLabel(s.desc))
					if (target !== undefined || !plainSide(d.left, source) || !this.#keyOf(d.right, keyed)) {
						refuse(d.left.relation, source)
					}
					return
				}
				if (target !== undefined && !this.#keyOf(d.right, target)) {
					refuse(d.right.relation, target)
				}
				return
			}
			case "key":
				return reach([d.side.relation])
			case "mutable":
			case "check":
				return reach([d.relation])
			case "family":
			case "tree":
				return reach([d.member.relation, d.slots.owner])
			case "fold":
				return reach([d.family.owner, d.step.relation, d.end.relation])
			case "alternatives":
				return reach([d.parent.relation, ...d.arms.map((a) => a.arm.relation)])
		}
	}

	/** The declared name of the level at `index`. */
	#levelName(index: number): string {
		const level = this.#levels[index]
		if (level === undefined) {
			throw defect(`ownership's level ${index} is one of the schema's levels`)
		}
		return level.name
	}

	/**
	 * Whether `side` reads every fact of `entry`'s ordinary relation by fields of no span, which are its primary key or a
	 * candidate key a key statement of its level or below declares.
	 */
	#keyOf(side: SideDesc, entry: RelationEntry): boolean {
		const fields = candidateKeyFields(side)
		const desc = entry.desc
		if (fields === undefined || desc.kind !== "relation" || !plainSide(side, entry)) {
			return false
		}
		const same = (key: ReadonlyArray<string>): boolean =>
			key.length === fields.length && key.every((f) => fields.includes(f))
		return (
			same(desc.primaryKey) ||
			this.#statements.some((k) => {
				if (
					k.desc.kind !== "key" ||
					k.desc.side.relation !== side.relation ||
					k.level > entry.level
				) {
					return false
				}
				const declared = candidateKeyFields(k.desc.side)
				return declared !== undefined && same(declared)
			})
		)
	}

	/** The statement as ownership admits it (OwnedStatement). */
	#checkStatement(s: StatementEntry): OwnedStatement {
		const d = s.desc
		switch (d.kind) {
			case "key": {
				const read = this.#checkRuleSide(d.side, s)
				if (read.kind === "derived") {
					return { ...d, key: { kind: "projected" } }
				}
				const entry = read.entry
				if (entry.desc.kind !== "relation") {
					fail(
						"MalformedDescription",
						s.desc.loc,
						`a key over an ordinary relation; ${d.side.relation} is keyed by its declaration`
					)
				}
				const fields = candidateKeyFields(d.side)
				return {
					...d,
					key:
						fields === undefined
							? { kind: "projected" }
							: {
									kind: "candidate",
									key: ownKey(d.side.relation, entry.desc, fields, false, d.loc)
								}
				}
			}
			case "mutable":
				this.#ordinary(d.relation, s, "is a closed relation, immutable by nature")
				this.#mutable.add(d.relation)
				return d
			case "check": {
				const read = this.#sideRelation(d.relation, s)
				if (read.kind === "derived") {
					return this.#derivedCheck(d, read, s)
				}
				const entry = this.#ordinary(
					d.relation,
					s,
					"has fixed facts, which no row check constrains"
				)
				const foreign = foreignInput(d.predicate)
				if (foreign !== undefined) {
					fail(
						"MalformedDescription",
						s.desc.loc,
						`check ${d.name} over its row only, not ${foreign}`
					)
				}
				this.#requireFields(entry, [...fieldRefs(d.predicate, new Set())], s)
				this.#checkPredicateHandles(d.predicate, entry.heading, s)
				const checks =
					this.#checkNames.get(d.relation) ??
					new DeclaredNamespace(`relation ${d.relation}'s check`)
				this.#checkNames.set(d.relation, checks)
				const named = identity.check(d.relation, declareName(checks, d.name, "check", d.loc))
				return { ...d, check: { named, constraint: identifierOf(named) } }
			}
			case "contained": {
				this.#checkRuleSide(d.left, s)
				this.#checkRuleSide(d.right, s)
				return {
					kind: d.kind,
					left: scopeOf(d.left),
					right: scopeOf(d.right),
					pairs: pairSides(d.left, d.right, s),
					loc: d.loc
				}
			}
			case "family": {
				const member = this.#ordinary(d.member.relation, s, "is no family's member")
				this.#checkSide(d.member, s)
				this.#checkSlots(d.slots, s)
				if (member.level > this.#lawRelation(d.slots.owner, s).level) {
					fail(
						"MalformedDescription",
						s.desc.loc,
						`${statementLabel(d)} over an owner of the member's level or below`
					)
				}
				return d
			}
			case "tree": {
				const tree = this.#ordinary(d.member.relation, s, "is no tree's relation")
				this.#checkSide(d.member, s)
				this.#checkSlots(d.slots, s)
				if (d.slots.owner !== d.member.relation) {
					fail(
						"MalformedDescription",
						s.desc.loc,
						`${statementLabel(d)} counted over its own relation; ${d.slots.owner} is another`
					)
				}
				this.#requireFields(tree, [d.root], s)
				return d
			}
			case "fold": {
				this.#checkSlots(d.family, s)
				this.#checkSide(d.step, s)
				this.#checkSide(d.end, s)
				return d
			}
			case "alternatives": {
				const parent = this.#ordinary(d.parent.relation, s, "is no alternatives parent")
				this.#checkSide(d.parent, s)
				for (const a of d.arms) {
					this.#ordinary(a.arm.relation, s, "is no alternatives arm")
					this.#checkSide(a.arm, s)
				}
				const roster = this.#lawRelation(d.roster, s)
				if (roster.desc.kind !== "closed") {
					fail(
						"MalformedDescription",
						s.desc.loc,
						`${statementLabel(d)} over a roster; ${d.roster} is none`
					)
				}
				const disc = parent.heading[d.discriminator]
				if (disc === undefined || closedIdBase(disc)?.roster !== d.roster) {
					fail(
						"MalformedDescription",
						s.desc.loc,
						`${statementLabel(d)} discriminated by a closedId(${d.roster}) field of ${d.parent.relation}`
					)
				}
				for (const a of d.arms) {
					if (!isHandle(roster.desc, a.handle)) {
						fail(
							"MalformedDescription",
							s.desc.loc,
							`${statementLabel(d)} armed by ${d.roster}'s handles; ${a.handle} is not one`
						)
					}
				}
				return d
			}
		}
	}

	/**
	 * A row check over a derived relation's facts: its predicate over the definition's heading alone, and its name
	 * declared in the derived relation's check namespace. The triggers that hold it on the tables it reads are named by its
	 * law (laws/model/model.ts RuleTrigger), never by its name, which is unique in no table's namespace.
	 */
	#derivedCheck(
		d: Extract<StatementDesc, { readonly kind: "check" }>,
		read: Extract<SideRelationEntry, { readonly kind: "derived" }>,
		s: StatementEntry
	): OwnedStatement {
		const foreign = foreignInput(d.predicate)
		if (foreign !== undefined) {
			fail("MalformedDescription", s.desc.loc, `check ${d.name} over its row only, not ${foreign}`)
		}
		for (const f of fieldRefs(d.predicate, new Set())) {
			if (!read.fields.has(f)) {
				fail(
					"MalformedDescription",
					s.desc.loc,
					`${statementLabel(d)} names ${d.relation}.${f}, which is not a field of ${d.relation}`
				)
			}
		}
		const checks =
			this.#checkNames.get(d.relation) ?? new DeclaredNamespace(`relation ${d.relation}'s check`)
		this.#checkNames.set(d.relation, checks)
		const named = identity.check(d.relation, declareName(checks, d.name, "check", d.loc))
		return { ...d, check: { named, constraint: identifierOf(named) } }
	}

	/** The slots of a count: its owner an ordinary relation of the statement's level or below, and its count a field. */
	#checkSlots(slots: SlotsDesc, s: StatementEntry): void {
		const owner = this.#ordinary(slots.owner, s, "has no drawn count")
		this.#requireFields(owner, [slots.count], s)
	}

	/** The schema's one namespace of relations, derived relations, rosters and contracts (PostgreSQL's relation and type
	 * namespaces, which grizzle treats as one). */
	readonly #schemaNames = new DeclaredNamespace("relation, roster and contract")

	/** The relations, each owning the keys and checks `statements` state over it, read off them once by relation. */
	#ownRelations(
		statements: ReadonlyArray<OwnedStatement>
	): Readonly<Record<string, OwnedRelation>> {
		const keys = new Map<string, Array<OwnedKey>>()
		const checks = new Map<string, Array<OwnedCheck>>()
		const add = <A>(by: Map<string, Array<A>>, relation: string, item: A): void => {
			const held = by.get(relation)
			if (held === undefined) {
				by.set(relation, [item])
			} else {
				held.push(item)
			}
		}
		for (const s of statements) {
			if (s.kind === "key" && s.key.kind === "candidate") {
				add(keys, s.side.relation, s.key.key)
			} else if (s.kind === "check") {
				add(checks, s.relation, s.check)
			}
		}
		const out: Record<string, OwnedRelation> = {}
		for (const [name, entry] of byName(this.#relations)) {
			out[name] = this.#ownRelation(
				{ keys: keys.get(name) ?? [], checks: checks.get(name) ?? [] },
				name,
				entry
			)
		}
		return out
	}

	/**
	 * One relation's owned identifiers: its table, roster domain or materialized view, and what each kind owns besides.
	 * A closed relation installs no relation of its own.
	 */
	#ownRelation(laws: RelationLaws, declared: string, entry: RelationEntry): OwnedRelation {
		const r = entry.desc
		const what: Readonly<Record<RelationDesc["kind"], string>> = {
			relation: "relation",
			closed: "roster",
			closedRelation: "closed relation",
			derived: "relation"
		}
		const name = declareName(this.#schemaNames, declared, what[r.kind], entry.desc.loc)
		const owning: OwnedBase = { name, level: entry.level, loc: entry.desc.loc }
		switch (r.kind) {
			case "relation":
				return this.#ownStored(laws, owning, entry, r)
			case "closed": {
				const named = identity.rosterDomain(name)
				return {
					...owning,
					kind: r.kind,
					desc: r,
					named,
					ident: identifierOf(named),
					fields: this.#closedFields(owning, entry, rosterHeading(r)),
					keys: [],
					mutable: false
				}
			}
			case "closedRelation":
				return {
					...owning,
					kind: r.kind,
					desc: r,
					fields: this.#closedFields(owning, entry, r.fields),
					keys: [],
					mutable: false
				}
			case "derived": {
				const reads = [...queryUses(r.query).relations].toSorted(compareStrings)
				return {
					...owning,
					kind: r.kind,
					desc: r,
					fields: {},
					keys: [],
					mutable: false,
					reads,
					view: ownedView(name, r.storage)
				}
			}
		}
	}

	/** A stored relation's columns, identity sequences, keys and row checks. */
	#ownStored(
		laws: RelationLaws,
		owning: OwnedBase,
		entry: RelationEntry,
		r: OrdinaryRelationOf
	): OwnedRelation {
		const { name } = owning
		const fields: Record<string, OwnedField> = {}
		const columns = new DeclaredNamespace(`relation ${name}'s field`)
		for (const [declared, decl] of Object.entries(r.fields)) {
			const field = declareName(
				columns,
				declared,
				"field",
				labeledChildLoc(entry.desc.loc, declared, `field ${name}.${declared}`)
			)
			const named = identity.column(field)
			const sequence = decl.writing.kind === "serial" ? identity.sequence(name, field) : undefined
			fields[field] = {
				id: FieldId(name, field),
				name: field,
				desc: decl.type,
				writing: decl.writing,
				named,
				column: identifierOf(named),
				sequence
			}
		}
		const primary = ownKey(
			name,
			r,
			r.primaryKey,
			true,
			labeledChildLoc(entry.desc.loc, "primaryKey", `primary key of ${name}`)
		)
		const named = identity.table(name)
		return {
			...owning,
			kind: r.kind,
			desc: r,
			named,
			ident: identifierOf(named),
			fields,
			keys: [primary, ...laws.keys],
			checks: laws.checks,
			mutable: this.#mutable.has(name)
		}
	}

	/** A roster's or closed relation's fields: every one fixed when the schema compiles, none a serial. */
	#closedFields(
		owning: OwnedBase,
		entry: RelationEntry,
		heading: Readonly<Record<string, FieldDesc>>
	): Readonly<Record<string, OwnedField>> {
		const { name } = owning
		const fields: Record<string, OwnedField> = {}
		const columns = new DeclaredNamespace(`closed relation ${name}'s field`)
		for (const [declared, desc] of Object.entries(heading)) {
			const field = declareName(
				columns,
				declared,
				"field",
				labeledChildLoc(entry.desc.loc, declared, `field ${name}.${declared}`)
			)
			const named = identity.column(field)
			fields[field] = {
				id: FieldId(name, field),
				name: field,
				desc,
				writing: callerWritten,
				named,
				column: identifierOf(named),
				sequence: undefined
			}
		}
		return fields
	}

	/** Each contract by its declared name, a contract's name its type-level brand alone (OwnedContract). */
	#ownContracts(): Readonly<Record<string, OwnedContract>> {
		const out: Record<string, OwnedContract> = {}
		const names = new DeclaredNamespace("contract")
		for (const [declared, c] of byName(this.#contracts)) {
			const name = declareName(names, declared, "contract", c.loc)
			out[name] = { name, desc: c.desc, loc: c.loc }
		}
		return out
	}

	/**
	 * The canonical description: each level's relations by name, less those an equal lower declaration already holds,
	 * and its statements deduplicated in canonical order.
	 */
	#canonicalDesc(): SchemaDesc {
		const placed = new Set<string>()
		const canonicalLevel = (
			level: number,
			schema: SchemaDesc,
			below: SchemaDesc | undefined
		): SchemaDesc => {
			const relations = schema.relations
				.filter((r) => this.#relations.get(r.name)?.level === level && !placed.has(r.name))
				.toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
			for (const r of relations) {
				placed.add(r.name)
			}
			const statements = this.#statements
				.filter((s) => s.level === level)
				.toSorted((a, b) => (a.text < b.text ? -1 : a.text > b.text ? 1 : 0))
				.map((s) => s.desc)
			return schemaLevelDesc({
				name: schema.name,
				relations,
				statements,
				extends: below,
				loc: schema.loc
			})
		}
		const [root, ...above] = this.#levels
		let top = canonicalLevel(0, root, undefined)
		for (const [i, schema] of above.entries()) {
			top = canonicalLevel(i + 1, schema, top)
		}
		return top
	}
}

/** Every Owned that own() returned. An Owned is what own() built, never a value that merely has its keys. */
const owners = new WeakMap<object, Owned>()

/** The Owned that own() built, when `input` is one; undefined for any other value. */
export const ownedOf = (input: unknown): Owned | undefined =>
	typeof input === "object" && input !== null ? owners.get(input) : undefined

/**
 * Owns a schema description: one decoded at a boundary, or an Owned's own, each statement put in canonical form here.
 */
export const own = (desc: SchemaDesc): Result.Result<Owned, CompileError> =>
	ownWith(
		desc,
		mapNonEmpty(levelChain(desc), (level) => level.statements.map(canonicalStatementOf)),
		hashedLevels
	)

/** A schema value's built schema: its description and its content (levels.ts SchemaContent), read at its build. */
interface BuiltLevels {
	readonly desc: SchemaDesc
	readonly content: SchemaContent
}

/** Each level's statements in canonical form as a built schema's content carries them, root first (writtenOf). */
const writtenOf = (
	content: SchemaContent
): NonEmptyReadonlyArray<ReadonlyArray<CanonicalStatement>> =>
	content.below === undefined
		? [content.canonical]
		: appendNonEmpty(writtenOf(content.below), content.canonical)

/**
 * own() of a schema schema(...) or schema.extend built: each level's statements read in the canonical form and text
 * its level content carries from their build (levels.ts SchemaContent.canonical), none put in canonical form again.
 */
export const ownBuilt = (built: BuiltLevels): Result.Result<Owned, CompileError> =>
	ownWith(built.desc, writtenOf(built.content), hashedLevels)

/**
 * ownBuilt(), each level's fingerprint taken from its installation's snapshot (`recorded`, root first) rather than
 * hashed: what DbLayer.make owns its login's base with, serving under the fingerprints `grizzle generate` recorded.
 */
export const ownServed = (
	built: BuiltLevels,
	recorded: ReadonlyArray<SchemaFingerprint>
): Result.Result<Owned, CompileError> =>
	ownWith(built.desc, writtenOf(built.content), recordedLevels(recorded))

/**
 * Owns `desc`, each level's statements in canonical form in `written` (root first, as levelChain gives its levels),
 * each level's fingerprint as `fingerprinted` gives it.
 */
const ownWith = (
	desc: SchemaDesc,
	written: NonEmptyReadonlyArray<ReadonlyArray<CanonicalStatement>>,
	fingerprinted: LevelFingerprints
): Result.Result<Owned, CompileError> =>
	Result.map(
		catchRefusal(() => new Owner(desc, written).run(fingerprinted)),
		(owned) => {
			owners.set(owned, owned)
			return owned
		}
	)

/**
 * A role relation as ownership admitted it: a whole entry with the base's owned relation, or a query entry with its
 * decoded entry and the base relations and the contexts its definition reads.
 */
export type OwnedEntry =
	| {
			readonly kind: "whole"
			readonly name: DeclaredName
			readonly relation: OwnedRelation
			readonly loc: SourceLoc
	  }
	| OwnedWorldEntry

/** A role's query entry as ownership admitted it (OwnedEntry). */
export interface OwnedWorldEntry {
	readonly kind: "world"
	readonly name: DeclaredName
	readonly entry: Extract<RoleEntryDesc, { readonly kind: "world" }>
	readonly query: QueryDesc
	readonly reads: ReadonlyArray<string>
	readonly contexts: ReadonlyArray<string>
	readonly loc: SourceLoc
}

/**
 * One entry of a role's write list as ownership admitted it: "whole", a whole entry of an ordinary relation, which
 * writes its table as it is; "rows", a query entry the writable-entry analysis admits, with its analysis, whose writes
 * the table's row security holds to the entry's membership.
 */
export type OwnedWrite =
	| {
			readonly kind: "whole"
			readonly name: string
			readonly relation: Extract<OwnedRelation, { readonly kind: "relation" }>
			readonly loc: SourceLoc
	  }
	| {
			readonly kind: "rows"
			readonly name: string
			readonly entry: OwnedWorldEntry
			readonly writable: WritableEntry<string, string>
			readonly loc: SourceLoc
	  }

/**
 * The owned role: its name, its base's Owned, its relations by name, its write list as admitted entries by name in name
 * order, its refresh list in name order, whether it holds every relation of its base whole (a full role, whose base is
 * among its levels), and the contexts its relations read, by name.
 */
export interface OwnedRole {
	readonly name: DeclaredName
	readonly loc: SourceLoc
	readonly base: Owned
	readonly relations: Readonly<Record<string, OwnedEntry>>
	readonly writes: ReadonlyMap<string, OwnedWrite>
	readonly refresh: ReadonlyArray<string>
	readonly full: boolean
	readonly contexts: Readonly<Record<string, ContextDesc>>
}

/** The owned login: its name, its base's Owned and its owned roles in name order. */
export interface OwnedLogin {
	readonly name: DeclaredName
	readonly loc: SourceLoc
	readonly base: Owned
	readonly roles: ReadonlyArray<OwnedRole>
}

const ownRoleOf = (desc: RoleDesc, base: Owned): OwnedRole => {
	const label = `role ${desc.name}`
	/** The role's refusal at `loc` for breaking `rule`. A function declaration, so control flow knows it never returns. */
	function broken(loc: SourceLoc, rule: RoleRule): never {
		failWith({ _tag: "RoleRefused", at: loc, role: desc.name, rule })
	}
	/** A role's name is a declared name: its PostgreSQL role and its schema are `<schema>__<name>`. Its login's
	 * ownership holds it apart from the login's other names. */
	const roleName = declareName(new DeclaredNamespace("role"), desc.name, "role", desc.loc)
	const relations: Record<string, OwnedEntry> = {}
	const contexts = new Map<
		string,
		{ readonly desc: ContextDesc; readonly text: string; readonly loc: SourceLoc }
	>()
	/** The role's schema holds one view per relation, named by the relation's declared name. */
	const views = new DeclaredNamespace(`${label}'s relation`)
	for (const e of desc.relations) {
		const entryName = declareName(views, e.name, "relation", e.loc)
		if (e.kind === "whole") {
			const relation = base.relations[e.name]
			if (relation === undefined) {
				broken(e.loc, { kind: "wholeEntryUndeclared", entry: e.name, base: base.name })
			}
			if (relation.kind === "derived" && relation.desc.storage === "live") {
				broken(e.loc, { kind: "wholeEntryLive", entry: e.name })
			}
			relations[e.name] = { kind: "whole", name: entryName, relation, loc: e.loc }
			continue
		}
		if (e.query.stage.kind === "order") {
			broken(e.loc, { kind: "entryOrdered", entry: e.name })
		}
		const uses = queryUses(e.query)
		if (uses.inputs.size > 0) {
			broken(e.loc, {
				kind: "entryParameters",
				entry: e.name,
				parameters: [...uses.inputs].toSorted(compareText)
			})
		}
		for (const read of uses.relations) {
			if (base.relations[read] === undefined) {
				broken(e.loc, { kind: "entryOutsideBase", entry: e.name, relation: read })
			}
		}
		if (attachesHeading(e.query)) {
			broken(e.loc, { kind: "entryAttaches", entry: e.name })
		}
		if (approximates(e.query)) {
			broken(e.loc, { kind: "entryApproximate", entry: e.name })
		}
		for (const [name, c] of uses.contexts) {
			const text = textOf(c)
			const prior = contexts.get(name)
			if (prior === undefined) {
				contexts.set(name, { desc: c, text, loc: e.loc })
			} else if (prior.text !== text) {
				failWith({
					_tag: "DuplicateIdentity",
					at: e.loc,
					duplicate: { kind: "context", name, earlier: prior.loc }
				})
			}
		}
		relations[e.name] = {
			kind: "world",
			name: entryName,
			entry: e,
			query: e.query,
			reads: [...uses.relations].toSorted(compareText),
			contexts: [...uses.contexts.keys()].toSorted(compareText),
			loc: e.loc
		}
	}
	const targets = new Map<string, string>()
	const target = (relation: string, entry: string): void => {
		const prior = targets.get(relation)
		if (prior !== undefined) {
			broken(desc.loc, { kind: "writeTwice", relation, entries: [prior, entry] })
		}
		targets.set(relation, entry)
	}
	const admitted = new Map<string, OwnedWrite>()
	for (const w of desc.write) {
		const r = Object.hasOwn(relations, w) ? relations[w] : undefined
		if (r === undefined) {
			broken(desc.loc, { kind: "writeOutside", name: w })
		}
		if (r.kind === "whole") {
			const relation = r.relation
			if (relation.kind !== "relation") {
				broken(desc.loc, {
					kind: "writeKind",
					name: w,
					entryKind: relation.kind === "closedRelation" ? "closed" : relation.kind
				})
			}
			target(w, w)
			admitted.set(w, { kind: "whole", name: w, relation, loc: r.loc })
			continue
		}
		const analyzed = writableEntry(base.desc, r.entry)
		if (!analyzed.ok) {
			broken(r.loc, { kind: "writeUnwritable", entry: w, why: analyzed.error.reason })
		}
		target(analyzed.value.target, w)
		admitted.set(w, { kind: "rows", name: w, entry: r, writable: analyzed.value, loc: r.loc })
	}
	for (const f of desc.refresh) {
		const r = relations[f]
		if (r === undefined) {
			broken(desc.loc, { kind: "refreshOutside", name: f })
		}
		if (r.kind === "world") {
			broken(desc.loc, { kind: "refreshKind", name: f, entryKind: "query" })
		}
		if (r.relation.kind !== "derived") {
			broken(desc.loc, {
				kind: "refreshKind",
				name: f,
				entryKind: r.relation.kind === "closedRelation" ? "closed" : r.relation.kind
			})
		}
	}
	const full = Object.values(base.relations).every(
		(r) => !heldRelation(r.desc) || relations[r.name]?.kind === "whole"
	)
	const ownedContexts: Record<string, ContextDesc> = {}
	for (const [name, c] of [...contexts].toSorted(([a], [b]) => compareText(a, b))) {
		ownedContexts[name] = c.desc
	}
	return {
		name: roleName,
		loc: desc.loc,
		base,
		relations,
		writes: new Map([...admitted].toSorted(([a], [b]) => compareText(a, b))),
		refresh: [...desc.refresh].toSorted(compareText),
		full,
		contexts: ownedContexts
	}
}

/**
 * Owns a role description, its base first.
 *
 * ownRole is ownership of a role: its base owned first, then every rule of a role's relations, write and refresh lists
 * checked against it, each a RoleRefused naming the rule it breaks (core/causes.ts RoleRule): a whole entry names a relation of the base
 * under its own name; a query entry is a Query over the base that reads no parameter; a write entry is a whole ordinary
 * relation or a query entry the writable-entry analysis admits, at most one per base relation; a refresh entry is a
 * derived whole entry; and the contexts the role's relations read agree on each context's descriptor
 * (DuplicateIdentity). The relations' names are declared names of one namespace, the role's schema of views
 * (core/identity.ts DeclaredNamespace: MalformedDescription, or IdentifierCollision for two that convert alike). A
 * query entry's heading and types are the checker's, against the base (analysis/schema.ts checkedRoleOver), and its heading's
 * names are its view's columns (analysis/derived/world.ts). ownLogin owns each role and checks they share the login's
 * base (LoginRefused), under names that convert apart from each other's and the login's (IdentifierCollision), the login's
 * name kept to the declared-name rule (MalformedDescription), as each role's own is.
 */
export const ownRole = (desc: RoleDesc): Result.Result<OwnedRole, CompileError> =>
	Result.flatMap(own(desc.base), (base) => catchRefusal(() => ownRoleOf(desc, base)))

/**
 * A login over its owned base and its roles, each owned over that base: the login's name and its roles' are one
 * namespace of declared names, since each is the PostgreSQL role `<schema>__<name>`, each role's own name kept to the
 * rule by its ownership.
 */
const ownLoginOf = (
	desc: LoginDesc,
	base: Owned,
	ownRoles: () => ReadonlyArray<OwnedRole>
): OwnedLogin => {
	const label = `login ${desc.name}`
	const names = new DeclaredNamespace(`${label}'s and its roles'`)
	const loginName = declareName(names, desc.name, "login", desc.loc)
	const roles = ownRoles()
	for (const r of roles) {
		declareName(names, r.name, "role", r.loc)
	}
	return {
		name: loginName,
		loc: desc.loc,
		base,
		roles: roles.toSorted((a, b) => compareText(a.name, b.name))
	}
}

/**
 * Owns a login description: its base, then each role over its own base, which must be the login's (LoginRefused): a
 * description from outside the builders, whose roles nothing has held to its base.
 */
export const ownLogin = (desc: LoginDesc): Result.Result<OwnedLogin, CompileError> =>
	Result.flatMap(own(desc.base), (base) =>
		catchRefusal(() =>
			ownLoginOf(desc, base, () =>
				desc.roles.map((d) => {
					const r = unwrap(ownRole(d))
					if (r.base.fingerprint !== base.fingerprint || r.base.name !== base.name) {
						failWith({
							_tag: "LoginRefused",
							at: r.loc,
							login: desc.name,
							rule: { kind: "roleBase", role: r.name, base: base.name }
						})
					}
					return r
				})
			)
		)
	)

/**
 * Owns the description of a login login(...) built over `base`, its base owned: login(...) held each of its roles to
 * that base, so each role is owned over it, and the base is owned once for the login and all its roles.
 */
export const ownBuiltLogin = (
	desc: LoginDesc,
	base: Owned
): Result.Result<OwnedLogin, CompileError> =>
	catchRefusal(() => ownLoginOf(desc, base, () => desc.roles.map((r) => ownRoleOf(r, base))))

/**
 * Owns the description of a role role(...) built over `base`, its base owned: role(...) built it over that base.
 */
export const ownBuiltRole = (desc: RoleDesc, base: Owned): Result.Result<OwnedRole, CompileError> =>
	catchRefusal(() => ownRoleOf(desc, base))

/**
 * The description of the full role `name` over a schema description: every relation of every level a role holds
 * whole (desc.ts heldRelation), writing its ordinary relations and refreshing its materialized derived ones.
 */
export const fullRoleDesc = (
	base: SchemaDesc,
	name: string,
	loc: SourceLoc
): Result.Result<RoleDesc, CompileError> =>
	Result.flatMap(own(base), (owned) => {
		const relations = Object.values(owned.relations)
			.filter((r) => heldRelation(r.desc))
			.toSorted((a, b) => compareText(a.name, b.name))
		const [first, ...rest] = relations.map((r): RoleEntryDesc => ({
			kind: "whole",
			name: r.name,
			loc
		}))
		if (first === undefined) {
			return Result.err(malformedDescription(loc, "a base with at least one relation"))
		}
		return decodeRoleOver(base, {
			name,
			relations: [first, ...rest],
			write: relations.filter((r) => r.kind === "relation").map((r) => r.name),
			refresh: relations.filter((r) => r.kind === "derived").map((r) => r.name),
			loc
		})
	})
