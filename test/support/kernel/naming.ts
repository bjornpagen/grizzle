import { exact, ordered } from "@grizzle/testing/oracle"
import { Array as Arr, Formatter, Option, Record as Rec } from "effect"
import type { TheoryLaw } from "#compiler/analysis/theory/laws.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import {
	admittedIdentifier,
	type DeclaredName,
	type Identity,
	identifierOf,
	identity,
	parseDeclaredName,
	parseSchemaName,
	type SchemaName
} from "#compiler/core/identity.ts"
import {
	installationsOf,
	type Owned,
	type OwnedLogin,
	ownRole,
	rostersOf
} from "#compiler/schema/own.ts"
import type { NativeKind } from "#test/support/native/model.ts"

import type {
	ColumnIdent,
	ConstraintName,
	DomainName,
	IndexName,
	LawId,
	RelationIdent
} from "#compiler/core/ids.ts"
import { appendNonEmpty } from "#compiler/core/nonempty.ts"
import * as Result from "#compiler/core/result.ts"
import { ledgerTable } from "#compiler/deploy/ledger/ledger.ts"
import {
	descText,
	type ExprDesc,
	type SchemaDesc as SrcSchemaDesc,
	type StatementDesc
} from "#compiler/ir/desc.ts"

import { type Codebook, codeOf, firstCodebook } from "#compiler/ir/codes.ts"
import {
	fieldNames,
	type NativeColumn,
	type NativeObject,
	type NativeOf
} from "#compiler/ir/law.ts"
import type { PhysicalNames } from "#compiler/ir/physical.ts"
import { type ConstraintLaws, type ConstraintOwner, constraintLaw } from "#compiler/ir/products.ts"
import { type ConstraintLaw, compileLaws, type LawModel } from "#compiler/laws/model/model.ts"
import { completeInstallOptions } from "#compiler/physical/complete.ts"
import { type TextDomain, textDomainIdentity } from "#compiler/physical/ddl/domains.ts"
import {
	installationTypes,
	roleReadNames,
	vectorTypes,
	worldNames
} from "#compiler/physical/ddl/names.ts"
import { compileInstallation, type Installation } from "#compiler/physical/install/compile.ts"
import type {
	AnyRelation,
	AnyRole,
	AnyRoster,
	AnySchema,
	Statement
} from "#compiler/public/schema.ts"
import { everySlice } from "#compiler/schema/reach.ts"
import { statementDescOf } from "#compiler/schema/statements.ts"
import { roleDescOf } from "#compiler/schema/world.ts"
import { type SqlStatement, tableConstraints } from "#compiler/sql/ast.ts"
import { quoteIdent } from "#compiler/sql/print.ts"
import type { Law } from "#compiler/types/changeset/changeset.ts"
import type { AnyDerived } from "#compiler/types/derived/derived.ts"
import type { RelationFieldsOf } from "#compiler/types/schema/relation.ts"
import type { AlternativesBase } from "#compiler/types/schema/statements.ts"
import { allocatedLevels } from "#test/support/compile.ts"
import { exactValue } from "#test/support/equivalence.ts"
import type { AuthoredStatementDesc, SchemaDesc } from "#test/support/fixtures/ir/desc.ts"
import type { Installed } from "#test/support/install-migrate.ts"
import { ownedInput } from "#test/support/policy.ts"

/**
 * What a test names production identifiers of: a public schema value or a desc fixture, as the schema boundary
 * (parseSchemaInput) accepts either.
 */
export type NamingSubject = AnySchema | SchemaDesc
/** A relation by its declared name: a public relation or derived relation value, or an authored relation desc. */
export type NamedRelation = { readonly name: string }

/** A name a test declares, parsed by the naming door's rule (core/identity.ts parseDeclaredName): one the rule refuses
 * is a defect of the test. */
export const parsedName = (name: string): DeclaredName => {
	const parsed = parseDeclaredName(name)
	if (!parsed.ok) {
		throw new Error(
			`the test declares ${Formatter.format(name)}, a name the naming door refuses: ${parsed.error}`
		)
	}
	return parsed.value
}

/** A schema name a test declares or installs under, parsed by the naming door's rule for schemas (core/identity.ts
 * parseSchemaName): one the rule refuses is a defect of the test. */
export const parsedSchemaName = (name: string): SchemaName => {
	const parsed = parseSchemaName(name)
	if (!parsed.ok) {
		throw new Error(
			`the test names the schema ${Formatter.format(name)}, which the naming door refuses: ${parsed.error}`
		)
	}
	return parsed.value
}

/**
 * The schema identity an installation is created under: its declared name's, or the identity of a name of the test's
 * own (a unique schema of the test's, install-migrate.ts Installed.declared), whose identifier is the PostgreSQL schema.
 */
export type InstalledAt =
	| { readonly kind: "declared" }
	| { readonly kind: "installed"; readonly installation: Identity<"schema"> }

/** Installed under its declared name's identity. */
export const atDeclaredName: InstalledAt = { kind: "declared" }

/** Installed under the identity of `name`, a name of the test's own. */
export const atName = (name: string): InstalledAt => ({
	kind: "installed",
	installation: identity.schema(parsedSchemaName(name))
})

/**
 * The schema the local cluster installs the vector extension in (scripts/pg/init.sh: CREATE EXTENSION vector SCHEMA
 * vector_ext).
 */
export const localVectorSchema = "vector_ext"

/**
 * The physical names of one declared schema without an installation, every object in the schema `at` names, with the
 * vector extension in `vectorSchema` and the installation's codes `codes` (a fresh one's: ir/codes.ts firstCodebook):
 * each name minted at the naming door (core/identity.ts), a relation's as a stored relation's table. A structural text
 * domain exists only where an installation types a column by it, so these names name none; and they name no closed
 * relation's constant and no contract's domain, which only an installation holds, since a contract's domain is named
 * by its definition's digest.
 */
export const productionNames = (
	declaredSchema: string,
	at: InstalledAt,
	vectorSchema: string,
	codes: Codebook
): PhysicalNames => {
	const installation =
		at.kind === "declared" ? identity.schema(parsedSchemaName(declaredSchema)) : at.installation
	const schema = identifierOf(installation)
	const types = installationTypes(installation)
	return {
		relation: (relation) => ({ schema, name: identifierOf(identity.table(parsedName(relation))) }),
		column: (...[, field]) => identifierOf(identity.column(parsedName(field))),
		rosterDomain: (roster) => ({
			schema: types,
			name: identifierOf(identity.rosterDomain(roster))
		}),
		bitsDomain: (roster) => {
			const codec = codes.rosters.get(roster)
			if (codec === undefined) {
				throw new Error(`the test's codebook holds no roster ${roster}, whose sets it names`)
			}
			return { schema: types, name: identifierOf(identity.bitsDomain(roster, codec.width)) }
		},
		contractDomain: (contract) => {
			throw new Error(
				`productionNames names no contract's domain, so none of contract ${contract}: a contract's domain is named by its definition's digest, which only an installation holds, so a test that names one reads installationOf(subject, at).names`
			)
		},
		textDomain: () => undefined,
		selectionKeys: () => [],
		vectorSchema: vectorTypes(vectorSchema),
		codes,
		closed: (relation) => {
			throw new Error(
				`productionNames names no installed constant, so none of closed relation ${relation}: a test that reads one names an installation (installationOf)`
			)
		},
		refusal: { kind: "qualified", schema, name: identifierOf(identity.refusal()) }
	}
}

/**
 * The kinds of constraint a test names by its fields: a primary key, a foreign key, a key (a unique constraint or
 * index, or a span key), and a finite check.
 */
type ConstraintKind = "pk" | "fk" | "key" | "check"

export interface LawNames {
	readonly model: LawModel
	/** The law a public statement declares (a statement rebuilt through the builders names the same law). */
	readonly lawOf: (statement: Statement) => LawId
	/** The law an authored statement desc declares. */
	readonly lawOfDesc: (statement: AuthoredStatementDesc) => LawId
	/** The law a relation's primary key reports. */
	readonly primaryKeyLaw: (relation: NamedRelation) => LawId
	/**
	 * The constraint of `relation` of `kind` over `fields` (as a set): a primary key, a key or span key, a foreign key,
	 * or a finite check. A constraint over a law column is named among its columns by the column's minted identifier,
	 * which no test spells: a test names it by its law (`constraintOf`).
	 */
	readonly fieldConstraint: (
		relation: NamedRelation,
		kind: ConstraintKind,
		fields: ReadonlyArray<string>
	) => ConstraintName
	/**
	 * The one constraint or domain constraint of `kind` that reports `law`: one law can be reported by several (an
	 * alternatives arm's foreign key and the generated unique key it references); a test names it here only where it is
	 * the one of its kind.
	 */
	readonly constraintOf: (law: LawId, kind: NativeKind) => ConstraintName
	/**
	 * Every constraint of `kind` that reports `law`, in the law model's order: a family's law is reported by several of
	 * one kind (its axes' foreign keys, its keys over the drawn index).
	 */
	readonly constraintsOf: (law: LawId, kind: NativeKind) => ReadonlyArray<ConstraintName>
	/** The law a constraint reports, read under the table or domain it lives on, as PostgreSQL reports it. */
	readonly lawOfConstraint: (owner: ConstraintOwner, constraint: ConstraintName) => LawId
	/** The laws an alternatives value expands to (a public schema). */
	readonly alternativesOf: (value: AlternativesBase) => AlternativesLaws
	/** The laws of an alternatives expansion as a desc fixture spells it (fixtures/ir/desc.ts alternatives(...)). */
	readonly alternativesOfDesc: (expansion: ReadonlyArray<AuthoredStatementDesc>) => AlternativesLaws
	/** A contract's domain, its CHECK, and its law. */
	readonly contract: (contract: string) => ContractNames
}

export interface AlternativesLaws {
	/**
	 * Each armed handle's arm relation's law, its foreign key into the parent: one law per arm relation, which every
	 * handle it is the arm of names.
	 */
	readonly arms: Readonly<Record<string, LawId>>
	/**
	 * The parent selected by each armed handle in that handle's arm, keyed by the handle: one containment per armed
	 * handle (fin.md §7).
	 */
	readonly reverse: Readonly<Record<string, LawId>>
}

export type ContractNames =
	| {
			readonly kind: "checked"
			readonly domain: DomainName
			readonly constraint: ConstraintName
			readonly law: LawId
	  }
	| { readonly kind: "brand"; readonly domain: DomainName; readonly law: LawId }

export interface TextDomainNames {
	readonly domain: DomainName
	readonly constraint: ConstraintName
}

export type SpanCheck =
	| { readonly kind: "shape" }
	| { readonly kind: "width" }
	| { readonly kind: "endpoint"; readonly contract: string }

export interface Names extends LawNames {
	readonly installation: Installation
	/** A law of the installation as an outcome names it (types/changeset Law). */
	readonly described: (law: LawId) => Law
	/** The LawId of the law an outcome names: exactly one law of the installation has that description. */
	readonly reported: (law: Law) => LawId
	/** The PostgreSQL schema the installation lives in. */
	readonly schema: string
	/** A stored, closed or derived relation's table or view, schema-qualified and quoted. */
	readonly table: (relation: AnyRelation | AnyDerived) => string
	/**
	 * Every stored relation's table, as `table` names it: the tables a reset truncates together
	 * (substrate/replace.ts installationGroup).
	 */
	readonly storedTables: ReadonlyArray<string>
	/** A field's column, quoted; a derived relation's view column by its head name. */
	readonly column: <R extends AnyRelation | AnyDerived>(
		relation: R,
		field: keyof RelationFieldsOf<R> & string
	) => string
	/**
	 * The code a closed id's column stores for a live handle of `roster`, under the installation's codes: the smallint a
	 * direct writer binds and a direct read returns, never the handle's text.
	 */
	readonly code: <R extends AnyRoster>(roster: R, handle: R["handles"][number]) => number
	/** The bare identifiers, for comparison with catalog facts and DETAIL keys. */
	readonly tableIdent: (relation: NamedRelation) => RelationIdent
	readonly columnIdent: (relation: NamedRelation, field: string) => ColumnIdent
	/** A serial field's advance function, schema-qualified and quoted, without an argument list. */
	readonly advance: (relation: NamedRelation, field: string) => string
	/** A serial field's identity sequence, schema-qualified and quoted. */
	readonly sequence: (relation: NamedRelation, field: string) => string
	/**
	 * The text refinement domain that types a column: a stored field, a closed relation's payload, or a derived view
	 * column (R12's "undeclared" view column included).
	 */
	readonly textDomain: (relation: NamedRelation, field: string) => TextDomainNames
	/**
	 * A stored field's pattern law, by the naming door's rule (identity.patternLaw) over the text domain that types its
	 * column, never read back from the installation's constraint records, which a test holds to it.
	 */
	readonly patternLaw: (relation: NamedRelation, field: string) => LawId
	/** A span column's installed CHECK. */
	readonly spanCheck: (relation: NamedRelation, field: string, check: SpanCheck) => ConstraintName
	/** A vector column's cosine-domain CHECK. */
	readonly normCheck: (relation: NamedRelation, field: string) => ConstraintName
	/** The access index the index engine created over `keys` (field names, in key order). */
	readonly accessIndex: (relation: NamedRelation, keys: ReadonlyArray<string>) => IndexName
	/** A derived relation's inherited key's unique index. */
	readonly viewKeyIndex: (view: NamedRelation, fields: ReadonlyArray<string>) => ConstraintName
}

/** The one item of `items`, or the defect of the test, described by how many there are. */
const single = <A>(items: ReadonlyArray<A>, describe: (count: number) => string): A => {
	const [item, ...more] = items
	if (item === undefined || more.length > 0) {
		throw new Error(describe(items.length))
	}
	return item
}

const refused = (error: CompileError): Error =>
	new Error(`the test names a schema src refuses: ${error.message}`)

/** What a constraint lives on, as PostgreSQL reports it: a table constraint's table, or a domain constraint's domain. */
export const constraintOwner = (c: ConstraintLaw): ConstraintOwner =>
	c.kind === "domainConstraint"
		? { kind: "domain", name: c.owner }
		: { kind: "table", name: c.owner }

/** A native object that installs a named constraint of one relation over a field set. */
interface NamedConstraint {
	readonly ident: ConstraintName
	readonly relation: string
	readonly kind: ConstraintKind
	readonly fields: ReadonlyArray<string>
	readonly object: NativeKind
}

/** A native object that installs a foreign key. */
type ForeignKeyObject = NativeOf<"ForeignKey" | "PeriodForeignKey">

/** A native column as a constraint's column list names it: a field by its name, a law column by its identifier. */
const indexedName = (c: NativeColumn): string => (c.kind === "field" ? c.field.name : c.column)

/**
 * A foreign key as its constraint states it: the relation it lives on and its columns, the target and its columns, each
 * column named as its index names it (indexedName), a PERIOD one's spans last; and whether
 * PostgreSQL checks it at COMMIT, as a PERIOD one's always is.
 */
export interface ForeignKeyColumns {
	readonly relation: string
	readonly columns: ReadonlyArray<string>
	readonly target: string
	readonly targetColumns: ReadonlyArray<string>
	readonly period: boolean
	readonly deferrable: boolean
}

export const foreignKeyColumns = (o: ForeignKeyObject): ForeignKeyColumns => {
	switch (o.kind) {
		case "ForeignKey":
			return {
				relation: o.relation.name,
				columns: Arr.map(o.columns, indexedName),
				target: o.target.name,
				targetColumns: Arr.map(o.targetColumns, indexedName),
				period: false,
				deferrable: o.deferrable
			}
		case "PeriodForeignKey":
			return {
				relation: o.relation.name,
				columns: [...Arr.map(o.columns, indexedName), indexedName(o.span)],
				target: o.target.name,
				targetColumns: [...Arr.map(o.targetColumns, indexedName), indexedName(o.targetSpan)],
				period: true,
				deferrable: true
			}
	}
}

/**
 * The named constraint a native object installs, if it installs one a ConstraintKind names. A span key's columns
 * already hold its span; a PERIOD foreign key names its spans beside the columns; a native column is named as its index
 * names it, a field by its name and a law column by its identifier (indexedName).
 */
const constraintsOf = (
	object: NativeObject,
	ident: ConstraintName
): ReadonlyArray<NamedConstraint> => {
	const named = (
		kind: ConstraintKind,
		relation: string,
		fields: ReadonlyArray<string>
	): ReadonlyArray<NamedConstraint> => [{ ident, relation, kind, fields, object: object.kind }]
	switch (object.kind) {
		case "PrimaryKey":
			return named("pk", object.relation.name, fieldNames(object.columns))
		case "WithoutOverlaps":
			return named(
				object.key.kind === "primary" ? "pk" : "key",
				object.relation.name,
				Arr.map(appendNonEmpty(object.key.scalars, object.span), indexedName)
			)
		case "Unique":
			return named("key", object.relation.name, Arr.map(object.columns, indexedName))
		case "ForeignKey":
		case "PeriodForeignKey": {
			const fk = foreignKeyColumns(object)
			return named("fk", fk.relation, fk.columns)
		}
		case "ClosedCheck":
			return named(
				"check",
				object.relation.name,
				Arr.map(object.pairs, (pair) => indexedName(pair.source))
			)
		case "TableCheck":
		case "Domain":
		case "RosterDomain":
		case "LawColumn":
		case "ReverseIndex":
			return []
	}
}

/**
 * Every named constraint of a law model's natives over a relation's fields: those installed under a constraint name (a
 * law column names a column, a domain's CHECK no field set, and an unnamed native nothing).
 */
const namedConstraints = (model: LawModel): ReadonlyArray<NamedConstraint> =>
	Arr.flatMap(model.natives, (native) =>
		native.namespace === "constraint"
			? constraintsOf(native.object, identifierOf(native.named))
			: []
	)

const describeConstraint = (c: NamedConstraint): string =>
	`${c.object}(${Arr.join(c.fields, ", ")})`

/** The one named constraint of `relation` of `kind` whose fields are `fields` as a set, or the defect of the test. */
const theConstraint = (
	model: LawModel,
	relation: string,
	kind: ConstraintKind,
	fields: ReadonlyArray<string>
): NamedConstraint => {
	const ofRelation = Arr.filter(namedConstraints(model), (c) => c.relation === relation)
	const wanted = new Set(fields)
	const matches = Arr.filter(ofRelation, (c) => {
		const named = new Set(c.fields)
		return (
			c.kind === kind && named.size === wanted.size && Arr.every([...wanted], (f) => named.has(f))
		)
	})
	return single(
		matches,
		(count) =>
			`the test names the ${kind} (${Arr.join(fields, ", ")}) of ${relation}, which ${count} of its natives install: ${Arr.join(Arr.map(ofRelation, describeConstraint), "; ")}`
	)
}

/** A statement's canonical identity text, source locations excluded (ir/desc.ts descText). */
export const identityText = (desc: unknown): string => {
	const text = descText(desc)
	if (!text.ok) {
		throw new Error(`the test names a statement src cannot encode: ${text.error.message}`)
	}
	return text.value
}

/**
 * The laws of a law model holding a statement: the theory's laws whose statements hold an owned statement of the same
 * canonical identity (source locations excluded) as the statement's owned form.
 */
type Holding = (desc: unknown) => {
	readonly target: string
	readonly laws: ReadonlyArray<TheoryLaw>
}

/** A schema's levels with no statement, each relation kept at its level. */
const withoutStatements = (level: SrcSchemaDesc): SrcSchemaDesc => ({
	...level,
	statements: [],
	extends: level.extends === undefined ? undefined : withoutStatements(level.extends)
})

/**
 * `desc` owned alone at the lowest level of `bare`, a description with no statement, that admits it: a level states a
 * law only over its own relations and through the ones below it as its level allows (schema/own.ts LevelRefused), so a
 * statement of a lower level is owned at that level, under the levels below it; the top level's refusal when none does.
 */
const ownedAtItsLevel = (
	bare: SrcSchemaDesc,
	desc: unknown
): Result.Result<Owned, CompileError> => {
	const below = bare.extends === undefined ? undefined : ownedAtItsLevel(bare.extends, desc)
	return below?.ok === true ? below : ownedInput({ ...bare, statements: [desc] })
}

/**
 * The identity text of the owned statement `desc` is: own itself owns it over `base`'s levels, at the lowest level
 * holding the statement alone, or refuses it there, such as a statement over a relation `base` does not declare. The statement is
 * the caller's value: the schema boundary parses it before ownership reads it.
 */
export const ownedStatementText = (
	base: SrcSchemaDesc,
	desc: unknown
): Result.Result<string, CompileError> =>
	Result.map(ownedAtItsLevel(withoutStatements(base), desc), (alone) => {
		const [owned, ...more] = alone.statements
		if (owned === undefined || more.length > 0) {
			throw new Error(
				`ownership owns the statement ${identityText(desc)} as ${alone.statements.length} statements`
			)
		}
		return identityText(owned)
	})

/**
 * Ownership canonicalizes each statement it owns (a check's conjunctions and disjunctions in operand order, an access
 * statement's scopes as sets), so a statement is matched in its owned form (ownedStatementText) over the model's own
 * levels. The owned statements' identity texts are computed once.
 */
const holdingOf = (model: LawModel): Holding => {
	const texts = Arr.map(model.owned.statements, identityText)
	const ownedText = (desc: unknown): string => {
		const text = ownedStatementText(model.owned.desc, desc)
		if (!text.ok) {
			throw refused(text.error)
		}
		return text.value
	}
	return (desc) => {
		const target = ownedText(desc)
		const indices = Arr.flatMap(texts, (text, i) => (text === target ? [i] : []))
		return {
			target,
			laws: Arr.filter(model.theory.laws, (law) =>
				Arr.some(law.statements, (i) => indices.includes(i))
			)
		}
	}
}

const theLaw = (target: string, laws: ReadonlyArray<TheoryLaw>, what: string): LawId =>
	single(
		laws,
		(count) =>
			`the test names the ${what} of ${target}, which ${count} laws hold: ${Arr.join(
				Arr.map(laws, (l) => l.id),
				", "
			)}`
	).id

/** A literal of a discriminator's selection as its handle: the handle a desc spells, or a typed handle literal. */
const handleText = (value: unknown): ReadonlyArray<string> =>
	typeof value === "string"
		? [value]
		: typeof value === "object" &&
			  value !== null &&
			  "kind" in value &&
			  value.kind === "handle" &&
			  "handle" in value &&
			  typeof value.handle === "string"
			? [value.handle]
			: []

/**
 * The handles a selection fixes its discriminator to, as an alternatives expansion states it (ir/desc.ts
 * discriminated): `discriminator = handle` fixes one, `discriminator in (handle…)` several; none for any other
 * selection.
 */
const selectedHandles = (
	conjuncts: ReadonlyArray<{ readonly predicate: ExprDesc }>
): ReadonlyArray<string> => {
	const [p, ...more] = conjuncts
	if (p === undefined || more.length > 0) {
		return []
	}
	const predicate = p.predicate
	if (predicate.kind === "compare" && predicate.op === "eq" && predicate.right.kind === "literal") {
		return handleText(predicate.right.value)
	}
	return predicate.kind === "in" ? Arr.flatMap(predicate.values, handleText) : []
}

/**
 * The laws an alternatives statement expands to, every one a containment (fin.md §7): an arm relation's,
 * `contained(on(Arm, …), on(select(P, tag ∈ handles), …))`, its target the parent selected by the handles the relation
 * is the arm of, which every one of those handles names; and each armed handle's reverse, `contained(on(select(P, tag =
 * h), …), on(Arm_h, …))`, its source the parent selected by its handle. The statement is one owned statement, so its
 * laws are the theory's laws that hold it, each classified by the side its selection is on.
 */
const alternativesLaws = <L>(
	holding: Holding,
	expansion: ReadonlyArray<StatementDesc<L>>
): AlternativesLaws => {
	const armLaws: Record<string, LawId> = {}
	const reverseLaws: Record<string, LawId> = {}
	for (const statement of expansion) {
		if (statement.kind !== "alternatives") {
			throw new Error(
				`the test names the laws of an alternatives expansion holding a ${statement.kind} statement, not an alternatives statement`
			)
		}
		const { target, laws } = holding(statement)
		const handles = new Set(Arr.map(statement.arms, (a) => a.handle))
		for (const law of laws) {
			if (law.detail.kind !== "containment") {
				throw new Error(
					`the alternatives statement ${target} holds the ${law.detail.kind} law ${law.id}`
				)
			}
			const reverse = selectedHandles(law.detail.from.selection.conjuncts)
			const arm = selectedHandles(law.detail.to.selection.conjuncts)
			const [handle, ...others] = reverse
			if (handle !== undefined && others.length === 0 && arm.length === 0) {
				reverseLaws[handle] = law.id
			} else if (arm.length > 0 && reverse.length === 0) {
				for (const handle of arm) {
					armLaws[handle] = law.id
				}
			} else {
				throw new Error(
					`the alternatives statement ${target} holds ${law.id}, which selects no one handle side`
				)
			}
		}
		for (const handle of handles) {
			if (armLaws[handle] === undefined || reverseLaws[handle] === undefined) {
				throw new Error(
					`the test names the laws of ${target}, which hold no arm law and reverse law for ${handle}: ${Arr.join(
						Arr.map(laws, (l) => l.id),
						", "
					)}`
				)
			}
		}
	}
	return { arms: armLaws, reverse: reverseLaws }
}

/** The one statement a law-naming value is; a mirrors or alternatives value expands to several and names none. */
const descOf = (statement: Statement): StatementDesc => {
	const desc = statementDescOf(statement)
	if (desc === undefined) {
		throw new Error(
			"the test names a law by a value that is not one statement (a mirrors or alternatives value expands to several): name one of its expanded statements"
		)
	}
	return desc
}

/**
 * The law names of a law model, a constraint's law read from `constraintToLaw`: the model's own, or an installation's
 * (which adds its text domains' and span columns' CHECKs).
 */
const lawNamesOver = (
	model: LawModel,
	constraintToLaw: ConstraintLaws,
	contractNamed: (contract: DeclaredName) => Identity<"contractDomain">
): LawNames => {
	const holding = holdingOf(model)
	/** What installs a constraint the law model maps: the one native of its owner that names it. */
	const nativeKind = (c: Exclude<ConstraintLaw, { readonly kind: "trigger" }>): NativeKind =>
		single(
			Arr.flatMap(model.natives, (n): ReadonlyArray<NativeKind> => {
				switch (c.kind) {
					case "constraint":
						return n.namespace === "constraint" &&
							n.owner === c.owner &&
							identifierOf(n.named) === c.name
							? [n.object.kind]
							: []
					case "domainConstraint":
						return n.namespace === "domain" &&
							identifierOf(contractNamed(n.object.name)) === c.owner &&
							n.object.check.kind === "checked"
							? [n.object.kind]
							: []
				}
			}),
			(count) => `the law model maps ${c.name} of ${c.owner}, which ${count} of its natives install`
		)
	const reporting: ReadonlyArray<{
		readonly name: ConstraintName
		readonly law: LawId
		readonly kind: NativeKind
	}> = Arr.flatMap(model.constraints, (c) => {
		if (c.kind === "trigger") {
			return []
		}
		const kind = nativeKind(c)
		return Arr.map(c.laws, (l) => ({ name: c.name, law: l.law, kind }))
	})
	const lawOfDesc = (desc: unknown): LawId => {
		const { target, laws } = holding(desc)
		return theLaw(target, laws, "law")
	}
	return {
		model,
		lawOf: (statement) => lawOfDesc(descOf(statement)),
		lawOfDesc,
		primaryKeyLaw: (relation) => {
			const pks = Arr.flatMap(model.natives, (n) => {
				if (n.namespace !== "constraint") {
					return []
				}
				const o = n.object
				if (o.kind === "PrimaryKey" || (o.kind === "WithoutOverlaps" && o.key.kind === "primary")) {
					return o.relation.name === relation.name ? [n] : []
				}
				return []
			})
			const pk = single(
				pks,
				(count) =>
					`the test names the primary key of ${relation.name}, which ${count} natives install`
			)
			const law = constraintLaw(
				model.constraintToLaw,
				{ kind: "table", name: pk.owner },
				identifierOf(pk.named)
			)
			const raised = Arr.findFirst(pk.object.lawIds, (l) => l === law)
			if (Option.isNone(raised)) {
				throw new Error(
					`the primary key ${identifierOf(pk.named)} of ${relation.name} reports no law it holds`
				)
			}
			return raised.value
		},
		fieldConstraint: (relation, kind, fields) =>
			theConstraint(model, relation.name, kind, fields).ident,
		constraintsOf: (law, kind) =>
			Arr.flatMap(reporting, (r) => (r.law === law && r.kind === kind ? [r.name] : [])),
		constraintOf: (law, kind) => {
			const ofLaw = Arr.filter(reporting, (r) => r.law === law)
			return single(
				Arr.filter(ofLaw, (r) => r.kind === kind),
				(count) =>
					`the test names the ${kind} constraint of ${law}, which ${count} of its reporting names are: ${Arr.join(
						Arr.map(ofLaw, (r) => `${r.kind} ${r.name}`),
						", "
					)}`
			).name
		},
		lawOfConstraint: (owner, constraint) => {
			const law = constraintLaw(constraintToLaw, owner, constraint)
			if (law === undefined) {
				throw new Error(
					`the test names the constraint ${constraint} of ${owner.kind} ${owner.name}, which reports no law`
				)
			}
			return law
		},
		alternativesOf: (value) => alternativesLaws(holding, [descOf(value)]),
		alternativesOfDesc: (expansion) => alternativesLaws(holding, expansion),
		contract: (name) => {
			const owned = model.owned.contracts[name]
			if (owned === undefined) {
				throw new Error(
					`the test names the contract ${name}, which ${model.owned.name} does not declare: ${Arr.join(Rec.keys(model.owned.contracts), ", ")}`
				)
			}
			const native = single(
				Arr.flatMap(model.natives, (n) =>
					n.namespace === "domain" && n.object.name === name ? [n] : []
				),
				(count) =>
					`the test names the domain of the contract ${name}, which ${count} natives install`
			)
			/** The domain its definition's digest names (physical/ddl/names.ts contractNamed), shared by contracts of one
			 * definition, and its CHECK. */
			const named = contractNamed(owned.name)
			const domain: DomainName = identifierOf(named)
			switch (native.object.check.kind) {
				case "checked":
					return {
						kind: "checked",
						domain,
						constraint: identifierOf(identity.domainCheck(named)),
						law: native.object.lawIds[0]
					}
				case "unchecked":
					return { kind: "brand", domain, law: native.object.lawIds[0] }
			}
		}
	}
}

/**
 * The law names of a subject: own and compileLaws. A contract's domain is named by its definition, which only an
 * installation holds, so it is read off the subject's installation under its declared name (installationOf), compiled
 * only when a test names one.
 */
export const lawNamesOf = (subject: NamingSubject): LawNames => {
	const owned = ownedInput(subject)
	if (!owned.ok) {
		throw refused(owned.error)
	}
	const model = compileLaws(owned.value, everySlice(owned.value), { kind: "planned" })
	if (!model.ok) {
		throw refused(model.error)
	}
	let installed: Installation | undefined
	return lawNamesOver(model.value, model.value.constraintToLaw, (contract) => {
		installed ??= installationOf(subject, atDeclaredName)
		return installed.names.contractNamed(contract)
	})
}

/** The LawId of a law statement of a schema, as the installer derives it. */
export const lawIdOf = (schema: AnySchema, law: Statement): LawId => lawNamesOf(schema).lawOf(law)

/**
 * A subject's whole installation compiled without a database, under the schema `at` names: own and compileInstallation
 * over the complete install options (physical/complete.ts), as `grizzle generate` drafts it (cli/generate.ts), its codes
 * a fresh installation's and no login (installationWith takes a history's codes and the logins it installs). A door
 * that named a partial installation would name objects production installs beside it as absent, so an installation
 * that leaves a derived relation deferred is refused.
 */
export const installationOf = (subject: NamingSubject, at: InstalledAt): Installation =>
	installationWith(subject, at, firstCodebook(rostersOf(lawNamesOf(subject).model.owned)), [])

/**
 * A subject's whole installation compiled under `codes` with `logins`, as installationOf compiles it: the installation
 * a history whose rosters hold holes reaches, which a fresh installation's codes would number otherwise, holding what
 * its logins' roles install beside the base (each role's views, and the text and contract domains of the context
 * fields they read).
 */
export const installationWith = (
	subject: NamingSubject,
	at: InstalledAt,
	codes: Codebook,
	logins: ReadonlyArray<OwnedLogin>
): Installation => {
	const owned = lawNamesOf(subject).model.owned
	const under =
		at.kind === "declared" ? installationsOf(owned) : allocatedLevels(at.installation, owned.levels)
	const installation = compileInstallation(
		owned,
		completeInstallOptions(owned, under, logins, [], codes)
	)
	if (!installation.ok) {
		throw refused(installation.error)
	}
	const { derivedRelations } = installation.value.deferred
	if (derivedRelations.length > 0) {
		throw new Error(
			`the test names the installation of ${owned.name}, which leaves deferred the derived relations (${Arr.join(derivedRelations, ", ")})`
		)
	}
	return installation.value
}

/** The span CHECK a SpanCheck names, as the naming door takes it. */
const suffixOf = (check: SpanCheck): Parameters<typeof identity.spanCheck>[2] => {
	switch (check.kind) {
		case "shape":
			return { kind: "shape" }
		case "width":
			return { kind: "width" }
		case "endpoint":
			return { kind: "endpoint", contract: check.contract }
	}
}

/**
 * What the install script creates on a table: each constraint of its CREATE TABLE, each constraint an ALTER TABLE
 * adds, and each index created on it.
 */
const createdOn = (
	statements: ReadonlyArray<SqlStatement>,
	table: RelationIdent
): ReadonlyArray<string> =>
	Arr.flatMap(statements, (s): ReadonlyArray<string> => {
		if (s.kind === "createTable" && s.table.name === table) {
			return Arr.map(tableConstraints(s), (c) => c.name)
		}
		if (s.kind === "alterTable" && s.table.name === table) {
			return Arr.flatMap(s.actions, (a) => (a.kind === "addConstraint" ? [a.constraint.name] : []))
		}
		if (s.kind === "createIndex" && s.table.name === table) {
			return [s.name]
		}
		return []
	})

const sameList = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean =>
	Option.isNone(ordered(exact)(a, b))

const sameLaw = (a: Law, b: Law): boolean => Option.isNone(exactValue(a, b))

/**
 * The LawId of the law an outcome names (types/changeset Law), read back through an installation's described laws
 * (physical/install Installation.described): exactly one of them has that description, or the description is a defect.
 */
export const reportedLawId = (described: ReadonlyMap<LawId, Law>, law: Law): LawId =>
	single(
		Arr.flatMap([...described], ([id, d]) => (sameLaw(d, law) ? [id] : [])),
		(count) =>
			`${count} of the installation's laws have the description of the reported ${law.kind} law`
	)

/** The one of the installation's text domains that types a column, by its installed table and column. */
const assignedDomain = (
	installation: Installation,
	table: RelationIdent,
	column: ColumnIdent,
	what: string
): TextDomain =>
	single(
		Arr.filter(installation.textDomains, (d) =>
			Arr.some(d.uses, (u) => u.table === table && u.column === column)
		),
		(count) =>
			`the test names the text domain of ${what}, which ${count} of the installation's domains type`
	)

/** The names of an installation under `schema`. */
const namesOver = (installation: Installation, schema: string): Names => {
	const laws = lawNamesOver(
		installation.laws,
		installation.constraintToLaw,
		installation.names.contractNamed
	)
	const names = installation.names
	const tableIdent = (relation: NamedRelation): RelationIdent => names.relation(relation.name).name
	const columnIdent = (relation: NamedRelation, field: string): ColumnIdent =>
		names.column(relation.name, field)
	/** A name the naming rule computes, once the install script is seen to create it on the relation's table. */
	const created = <N extends string>(relation: NamedRelation, name: N, what: string): N => {
		const made = createdOn(installation.statements, tableIdent(relation))
		if (!made.includes(name)) {
			throw new Error(
				`the test names the ${what} ${name} of ${relation.name}, which the installation does not create; it creates ${Arr.join(made, ", ")}`
			)
		}
		return name
	}
	const table = (relation: NamedRelation): string => {
		const q = names.relation(relation.name)
		return `${quoteIdent(q.schema)}.${quoteIdent(q.name)}`
	}
	return {
		...laws,
		installation,
		described: (law) => {
			const found = installation.described.get(law)
			if (found === undefined) {
				throw new Error(`the test names the law ${law}, which the installation does not describe`)
			}
			return found
		},
		reported: (law) => reportedLawId(installation.described, law),
		schema,
		table,
		storedTables: Arr.flatMap(Rec.values(installation.owned.relations), (r) =>
			r.kind === "relation" ? [table(r)] : []
		),
		column: (relation, field) => quoteIdent(names.column(relation.name, field)),
		code: (roster, handle) => {
			const codec = names.codes.rosters.get(parsedName(roster.name))
			if (codec === undefined) {
				throw new Error(
					`the test names the roster ${roster.name}, which the installation holds no codes of`
				)
			}
			return codeOf(codec, handle)
		},
		tableIdent,
		columnIdent,
		advance: (relation, field) => {
			const f = installation.names.advance(relation.name, field)
			return `${quoteIdent(f.schema)}.${quoteIdent(f.name)}`
		},
		sequence: (relation, field) => {
			const s = installation.names.sequence(relation.name, field)
			return `${quoteIdent(s.schema)}.${quoteIdent(s.name)}`
		},
		textDomain: (relation, field) => {
			const assigned = assignedDomain(
				installation,
				tableIdent(relation),
				columnIdent(relation, field),
				`${relation.name}.${field}`
			)
			return { domain: assigned.name, constraint: assigned.constraint }
		},
		patternLaw: (relation, field) =>
			identifierOf(
				identity.patternLaw(
					assignedDomain(
						installation,
						tableIdent(relation),
						columnIdent(relation, field),
						`${relation.name}.${field}`
					).named,
					relation.name,
					field
				)
			),
		spanCheck: (relation, field, check) =>
			created(
				relation,
				identifierOf(identity.spanCheck(relation.name, field, suffixOf(check))),
				`${check.kind} CHECK of the span ${field}`
			),
		normCheck: (relation, field) =>
			created(
				relation,
				identifierOf(identity.normCheck(relation.name, field)),
				`norm CHECK of the vector ${field}`
			),
		accessIndex: (relation, keys) => {
			const engine = Arr.flatMap(installation.indexes, (i): ReadonlyArray<IndexName> =>
				i.index.kind === "created" &&
				i.relation === relation.name &&
				sameList(
					Arr.map(i.keys, (k) => (k.column.kind === "field" ? k.column.field : k.column.column)),
					keys
				)
					? [i.index.name]
					: []
			)
			return single(
				engine,
				(count) =>
					`the test names the access index (${Arr.join(keys, ", ")}) of ${relation.name}, which the index engine created ${count} times`
			)
		},
		viewKeyIndex: (view, fields) => {
			const owned = installation.owned.relations[view.name]
			if (owned === undefined) {
				throw new Error(`the test names the view ${view.name}, which the schema does not own`)
			}
			return created(
				view,
				identifierOf(identity.derivedKey(view.name, fields)),
				`unique index of the key (${Arr.join(fields, ", ")})`
			)
		}
	}
}

/** The names of a compiled installation under its declared schema. */
export const installationNamesOf = (installation: Installation): Names =>
	namesOver(installation, installation.names.schema)

/**
 * An installed installation's names, under its installed schema: a migrated database holds the names a fresh
 * installation gives, since no name has a history.
 */
export const namesOf = (installed: Installed): Names =>
	namesOver(installed.installation, installed.schema)

/**
 * A role's names, as a direct SQL reader that has taken on the role reads them: each role relation's view in the role's
 * schema, schema-qualified and quoted, and each view column, quoted (physical/ddl/names.ts roleReadNames). The role is
 * the value over the schema rebuilt under the installed name, so its schema is the installation's.
 */
export interface RoleNames {
	readonly view: (relation: string) => string
	readonly column: (relation: string, field: string) => string
	/**
	 * A writable entry's filter function and its key probe for one key of T (key fields in key order), each
	 * schema-qualified and quoted, without an argument list.
	 */
	readonly filterFunction: (entry: string) => string
	readonly keyProbe: (entry: string, key: ReadonlyArray<string>) => string
}

/** A schema-qualified name, each part quoted. */
const qualified = (f: { readonly schema: string; readonly name: string }): string =>
	`${quoteIdent(f.schema)}.${quoteIdent(f.name)}`

export const roleNamesOf = (installed: Installed, role: AnyRole): RoleNames => {
	const desc = roleDescOf(role)
	if (desc === undefined) {
		throw new Error(`the test names a role ${role.name} no role(...) built`)
	}
	const ownedRole = ownRole(desc)
	if (!ownedRole.ok) {
		throw refused(ownedRole.error)
	}
	const owned = ownedRole.value
	const read = roleReadNames(installed.installation.names, owned)
	const world = worldNames(owned, installed.installation.names)
	return {
		view: (relation) => qualified(read.relation(relation)),
		column: (relation, field) => quoteIdent(read.column(relation, field)),
		filterFunction: (entry) => qualified(world.filterFunction(entry, [])),
		keyProbe: (entry, key) => qualified(world.keyProbe(entry, key, []))
	}
}

/**
 * The PostgreSQL roles of an installation's one login and its one role, as the installation created them: what a direct
 * SQL writer logs in as and takes on. An installation of other than one login of one role is a defect of the test.
 */
export const soleWorldOf = (
	installation: Installation
): { readonly login: string; readonly role: string } => {
	const [login, ...moreLogins] = installation.worlds
	const [role, ...moreRoles] = login?.roles ?? []
	if (login === undefined || role === undefined || moreLogins.length + moreRoles.length > 0) {
		throw new Error(
			"the test reads the one world of an installation that has other than one login of one role"
		)
	}
	return { login: login.role, role: role.role }
}

/**
 * Whether a catalog object of a schema is the migrations ledger's (deploy/ledger), the deployment's own table no schema
 * declares: the table itself, or a constraint its DDL declares, a key's index sharing the key's name. The names are
 * src's (ledgerTable), so a ledger whose DDL changes is still recognized.
 */
export const isLedgerObject = (schema: string, name: string): boolean => {
	const ddl = ledgerTable(schema)
	return (
		name === ddl.table.name ||
		Arr.some(tableConstraints(ddl), (constraint) => constraint.name === name)
	)
}

/**
 * The physical names of one declared schema without an installation (productionNames, with the vector extension in
 * localVectorSchema, under `codes`), with each pattern's structural text domain in that schema: a lowering without an
 * installation casts a delivered refined value it cannot prove to its domain, which the naming door names by the digest
 * of its definition (physical/ddl/domains.ts textDomainIdentity).
 */
export const standInNames = (declaredSchema: string, codes: Codebook): PhysicalNames => {
	const schema = installationTypes(identity.schema(parsedSchemaName(declaredSchema)))
	return {
		...productionNames(declaredSchema, { kind: "declared" }, localVectorSchema, codes),
		textDomain: (regex) => ({ schema, name: identifierOf(textDomainIdentity(regex)) })
	}
}

export interface NameMint {
	readonly lawId: (text: string) => LawId
	readonly constraint: (text: string) => ConstraintName
	readonly relation: (text: string) => RelationIdent
	readonly column: (text: string) => ColumnIdent
	readonly index: (text: string) => IndexName
	readonly domain: (text: string) => DomainName
}

/** Names admitted as the snapshot reader admits a name (core/identity.ts admittedIdentifier), each `prefix` and the text. */
const mint = (prefix: string): NameMint => ({
	lawId: (text): LawId => admittedIdentifier(`${prefix}${text}`),
	constraint: (text): ConstraintName => admittedIdentifier(`${prefix}${text}`),
	relation: (text): RelationIdent => admittedIdentifier(`${prefix}${text}`),
	column: (text): ColumnIdent => admittedIdentifier(`${prefix}${text}`),
	index: (text): IndexName => admittedIdentifier(`${prefix}${text}`),
	domain: (text): DomainName => admittedIdentifier(`${prefix}${text}`)
})

/**
 * Names no production rule produces, for name-agnostic machinery (a classifier's lookup, a stand-in, an evidence
 * premise, a hand-built table in the substrate tests): `~` and the token. `~` is outside [a-z0-9_], so a wild name
 * never equals a production name, and quoting keeps it a valid identifier.
 */
export const wild: NameMint = mint("~")
