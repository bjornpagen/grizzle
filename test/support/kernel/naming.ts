import { exact, ordered } from "@grizzle/testing/oracle"
import { Array as Arr, Formatter, Option, Record as Rec } from "effect"
import type { TheoryLaw } from "#compiler/analysis/theory/laws.ts"
import { canonicalTextOf } from "#compiler/core/canonical.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import {
	admittedIdentifier,
	type DeclaredName,
	type Identity,
	identifierOf,
	identity,
	type LawEvent,
	parseDeclaredName,
	parseSchemaName,
	type SchemaName
} from "#compiler/core/identity.ts"

import type {
	ColumnIdent,
	ConstraintName,
	DomainName,
	IndexName,
	LawFunctionName,
	LawId,
	RelationIdent,
	TriggerName
} from "#compiler/core/ids.ts"
import { ledgerTable } from "#compiler/deploy/ledger/ledger.ts"
import {
	descText,
	type SideDesc,
	type SchemaDesc as SrcSchemaDesc,
	type StatementDesc
} from "#compiler/ir/desc.ts"

import {
	fieldNames,
	lawUnits,
	type NamedDetailCodec,
	type NativeKind,
	type NativeObject,
	type NativeOf,
	namedDetail,
	spanKeyColumns
} from "#compiler/ir/law.ts"
import type { PhysicalNames } from "#compiler/ir/physical.ts"
import { type ConstraintLaws, type ConstraintOwner, constraintLaw } from "#compiler/ir/products.ts"
import { type ConstraintLaw, compileLaws, type LawModel } from "#compiler/laws/model/model.ts"
import { completeInstallOptions } from "#compiler/physical/complete.ts"
import {
	installationTypes,
	roleReadNames,
	vectorTypes,
	worldNames
} from "#compiler/physical/ddl/names.ts"
import { indexedName } from "#compiler/physical/ddl/tables.ts"
import { compileInstallation, type Installation } from "#compiler/physical/install/compile.ts"
import type { AnyRelation, AnyRole, AnySchema, Statement } from "#compiler/public/schema.ts"
import { ownRole } from "#compiler/schema/own.ts"
import { expansionDescOf, statementDescOf } from "#compiler/schema/statements.ts"
import { roleDescOf } from "#compiler/schema/world.ts"
import { type SqlStatement, tableConstraints } from "#compiler/sql/ast.ts"
import { type CarrierName, carrierName } from "#compiler/sql/naming.ts"
import { quoteIdent } from "#compiler/sql/print.ts"
import type { Law } from "#compiler/types/changeset/changeset.ts"
import type { AnyDerived } from "#compiler/types/derived/derived.ts"
import type { RelationFieldsOf } from "#compiler/types/schema/relation.ts"
import type { AlternativesBase } from "#compiler/types/schema/statements.ts"
import { typesDigest } from "#compiler/write/carriers/carriers.ts"
import { exactValue } from "#test/support/equivalence.ts"
import type { AuthoredStatementDesc, SchemaDesc } from "#test/support/fixtures/ir/desc.ts"
import type { Installed } from "#test/support/install-migrate.ts"
import { ownedInput } from "#test/support/policy.ts"

/**
 * The `ordinal`-th carrier, from 1, of the unit relation's column types, which are none: named through the door as a
 * write program names it (write/carriers CarrierSupply).
 */
export const unitCarrier = (ordinal: number): CarrierName =>
	carrierName(typesDigest(canonicalTextOf([])), ordinal)

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
 * vector extension in `vectorSchema`: each name minted at the naming door (core/identity.ts), a relation's as a stored
 * relation's table. A structural text domain exists only where an installation types a column by it, so these names
 * name none.
 */
export const productionNames = (
	declaredSchema: string,
	at: InstalledAt,
	vectorSchema: string
): PhysicalNames => {
	const installation =
		at.kind === "declared" ? identity.schema(parsedSchemaName(declaredSchema)) : at.installation
	const schema = identifierOf(installation)
	const types = installationTypes(installation)
	return {
		relation: (relation) => ({ schema, name: identifierOf(identity.table(parsedName(relation))) }),
		column: (...[, field]) => identifierOf(identity.column(parsedName(field))),
		enumType: (closed) => ({ schema: types, name: identifierOf(identity.enumType(closed)) }),
		contractDomain: (contract) => ({
			schema: types,
			name: identifierOf(identity.contractDomain(contract))
		}),
		textDomain: () => undefined,
		vectorSchema: vectorTypes(vectorSchema),
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
	 * The one constraint, domain constraint or residual law identity of `kind` that reports `law`: one law
	 * can be reported by several (an alternatives arm's foreign key and the generated unique key it references, a PERIOD
	 * foreign key and its temporal unique), never by two of one kind.
	 */
	readonly constraintOf: (law: LawId, kind: ReportingKind) => ConstraintName
	/** The law a constraint reports, read under the table or domain it lives on, as PostgreSQL reports it. */
	readonly lawOfConstraint: (owner: ConstraintOwner, constraint: ConstraintName) => LawId
	/** A residual law's units: each participating relation and event's trigger and function. */
	readonly residual: (law: LawId) => ResidualNames
	/** The laws an alternatives value expands to (a public schema). */
	readonly alternativesOf: (value: AlternativesBase) => AlternativesLaws
	/** The laws of an alternatives expansion as a desc fixture spells it (fixtures/ir/desc.ts alternatives(...)). */
	readonly alternativesOfDesc: (expansion: ReadonlyArray<AuthoredStatementDesc>) => AlternativesLaws
	/** A contract's domain, its CHECK, and its law. */
	readonly contract: (contract: string) => ContractNames
}

/**
 * What installs a constraint that reports a law, as src names it: a native object of the law model by its kind
 * (ir/law.ts NativeKind), or a residual law, whose function raises the law's own identity.
 */
export type ReportingKind = NativeKind | "ResidualLaw"

export interface AlternativesLaws {
	/**
	 * Each armed handle's arm relation's law, its foreign key into the parent: one law per arm relation, which every
	 * handle it is the arm of names.
	 */
	readonly arms: Readonly<Record<string, LawId>>
	/** The family law, every arm's reverse containment as one residual law, `<parent>_<discriminator>`. */
	readonly reverse: LawId
}

/** One unit of a residual law: its relation and event, its trigger, and the function that trigger alone executes. */
export interface UnitNames {
	readonly relation: string
	readonly event: LawEvent
	readonly trigger: TriggerName
	readonly function: LawFunctionName
}

export interface ResidualNames {
	/** One per participating relation and threatening event, participant by participant in law order. */
	readonly units: Arr.NonEmptyReadonlyArray<UnitNames>
	/**
	 * The DETAIL codec of its refusal, and the witness relation whose keys it carries: a caller whose role holds that
	 * relation whole reads the keys, any other the withheld DETAIL (test/support/detail.ts).
	 */
	readonly detail: NamedDetailCodec
	readonly witness: string
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
	readonly law: LawId
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
	/** The bare identifiers, for comparison with catalog facts and DETAIL keys. */
	readonly tableIdent: (relation: NamedRelation) => RelationIdent
	readonly columnIdent: (relation: NamedRelation, field: string) => ColumnIdent
	/** A serial field's advance function, schema-qualified and quoted, without an argument list. */
	readonly advance: (relation: NamedRelation, field: string) => string
	/** A serial field's identity sequence, schema-qualified and quoted. */
	readonly sequence: (relation: NamedRelation, field: string) => string
	/** A residual law's unit triggers, schema-qualified and quoted (SET CONSTRAINTS). */
	readonly triggers: (law: LawId) => ReadonlyArray<string>
	/**
	 * The text refinement domain that types a column: a stored field, a closed relation's payload, or a derived view
	 * column (R12's "undeclared" view column included).
	 */
	readonly textDomain: (relation: NamedRelation, field: string) => TextDomainNames
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

/**
 * A foreign key as its constraint states it: the relation it lives on and its columns, the target and its columns, each
 * column named as its index names it (physical/ddl/tables.ts indexedName), a PERIOD one's spans last; and whether
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
				columns: [...Arr.map(o.columns, indexedName), o.span.name],
				target: o.target.name,
				targetColumns: [...Arr.map(o.targetColumns, indexedName), o.targetSpan.name],
				period: true,
				deferrable: true
			}
	}
}

/**
 * The named constraint a native object installs, if it installs one a ConstraintKind names. A span key's columns
 * already hold its span; a temporal unique and a PERIOD foreign key name theirs beside the columns; a native column is
 * named as its index names it, a field by its name and a law column by its identifier (physical/ddl/tables.ts
 * indexedName).
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
				fieldNames(spanKeyColumns(object))
			)
		case "Unique":
			return named("key", object.relation.name, Arr.map(object.columns, indexedName))
		case "TemporalUnique":
			return named("key", object.relation.name, fieldNames([...object.columns, object.span]))
		case "ForeignKey":
		case "PeriodForeignKey": {
			const fk = foreignKeyColumns(object)
			return named("fk", fk.relation, fk.columns)
		}
		case "FiniteCheck":
			return named(
				"check",
				object.relation.name,
				Arr.flatMap(object.facts.slice(0, 1), (fact) => Arr.map(fact, (v) => v.field.name))
			)
		case "TableCheck":
		case "Domain":
		case "Enum":
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
const identityText = (desc: unknown): string => {
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
 * Ownership canonicalizes each statement it owns (a check's conjunctions and disjunctions in operand order, an access
 * statement's scopes as sets), so a statement is matched in its owned form: own itself owns it over the model's own
 * levels, its top level holding the statement alone. The owned statements' identity texts are computed once.
 */
const holdingOf = (model: LawModel): Holding => {
	const texts = Arr.map(model.owned.statements, identityText)
	const ownedText = (desc: unknown): string => {
		const written = identityText(desc)
		/** The statement is the caller's value: the schema boundary parses it before ownership reads it. */
		const alone = ownedInput({ ...withoutStatements(model.owned.desc), statements: [desc] })
		if (!alone.ok) {
			throw refused(alone.error)
		}
		const [owned, ...more] = alone.value.statements
		if (owned === undefined || more.length > 0) {
			throw new Error(
				`ownership owns the statement ${written} as ${alone.value.statements.length} statements`
			)
		}
		return identityText(owned)
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

/**
 * The arm an alternatives side selects, as the expansion states it: its selection's predicate is `discriminator =
 * handle`, the parent's discriminator compared with the handle's literal; none for any other side.
 */
const armOf = (
	side: SideDesc
): { readonly discriminator: string; readonly handle: string } | undefined => {
	const [p, ...more] = side.selection.conjuncts
	return more.length === 0 &&
		p?.kind === "compare" &&
		p.op === "eq" &&
		p.left.kind === "field" &&
		p.right.kind === "literal" &&
		typeof p.right.value === "string"
		? { discriminator: p.left.field, handle: p.right.value }
		: undefined
}

/**
 * The laws of an alternatives expansion, every statement an arm's containment, in any order: each arm's handle, its
 * parent side's selection of the discriminator, to the law of its arm relation holding the arm's containment into its
 * parent, one for every handle the relation is the arm of; and the one law every arm's reverse containment belongs to.
 */
const alternativesLaws = <L>(
	holding: Holding,
	expansion: ReadonlyArray<StatementDesc<L>>
): AlternativesLaws => {
	const armLaws: Record<string, LawId> = {}
	const reverses = new Set<LawId>()
	for (const statement of expansion) {
		if (statement.kind !== "contained") {
			throw new Error(
				`the test names the laws of an alternatives expansion holding a ${statement.kind} statement, not an arm's containment`
			)
		}
		const { target, laws } = holding(statement)
		const arm = armOf(statement.left) ?? armOf(statement.right)
		if (arm === undefined) {
			throw new Error(`the test names an alternatives arm ${target} that selects no handle`)
		}
		const armed = Arr.filter(laws, (l) => l.detail.kind === "alternativesArm")
		const reversed = Arr.filter(laws, (l) => l.detail.kind === "alternatives")
		if (armed.length === 0 && reversed.length === 0) {
			throw new Error(
				`the test names an alternatives arm ${target}, which no alternatives law holds`
			)
		}
		if (armed.length > 0) {
			armLaws[arm.handle] = theLaw(target, armed, "arm relation's law")
		}
		for (const law of reversed) {
			reverses.add(law.id)
		}
	}
	const reverse = single(
		[...reverses],
		(count) =>
			`the test names the reverse law of an alternatives expansion whose arms name ${count}`
	)
	return { arms: armLaws, reverse }
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

/** The statements a mirrors or alternatives value expands to. */
const expansionOf = (value: unknown): { readonly statements: ReadonlyArray<StatementDesc> } => {
	const desc = expansionDescOf(value)
	if (desc === undefined) {
		throw new Error(
			"the test names the laws of a value that is no mirrors or alternatives expansion"
		)
	}
	return desc
}

/**
 * The law names of a law model, a constraint's law read from `constraintToLaw`: the model's own, or an installation's
 * (which adds its text domains' and span columns' CHECKs).
 */
const lawNamesOver = (model: LawModel, constraintToLaw: ConstraintLaws): LawNames => {
	const holding = holdingOf(model)
	/** What installs a constraint the law model maps: the one native of its owner that names it. */
	const nativeKind = (c: ConstraintLaw): NativeKind =>
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
							n.owner === c.owner &&
							n.check.kind === "checked" &&
							n.check.ident === c.name
							? [n.object.kind]
							: []
				}
			}),
			(count) => `the law model maps ${c.name} of ${c.owner}, which ${count} of its natives install`
		)
	const reporting: ReadonlyArray<{
		readonly name: ConstraintName
		readonly law: LawId
		readonly kind: ReportingKind
	}> = [
		...Arr.map(model.constraints, (c) => ({ name: c.name, law: c.law, kind: nativeKind(c) })),
		...Arr.map(model.residuals, (r) => ({
			name: r.lawId,
			law: r.lawId,
			kind: "ResidualLaw" as const
		}))
	]
	const lawOfDesc = (desc: unknown): LawId => {
		const { target, laws } = holding(desc)
		return theLaw(target, laws, "law")
	}
	const residual = (law: LawId): ResidualNames => {
		const found = Option.getOrUndefined(Arr.findFirst(model.residuals, (r) => r.lawId === law))
		if (found === undefined) {
			throw new Error(
				`the test names the residual law ${law}, which is none of ${Arr.join(
					Arr.map(model.residuals, (r) => r.lawId),
					", "
				)}`
			)
		}
		return {
			units: Arr.map(lawUnits(found), (u) => ({
				relation: u.participant.relation.name,
				event: u.event,
				trigger: identifierOf(u.unit.trigger),
				function: identifierOf(u.unit.function)
			})),
			detail: namedDetail(found.detail),
			witness: found.detail.relation.name
		}
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
		residual,
		alternativesOf: (value) => alternativesLaws(holding, expansionOf(value).statements),
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
			switch (native.check.kind) {
				case "checked":
					return {
						kind: "checked",
						domain: owned.domain,
						constraint: native.check.ident,
						law: native.object.lawIds[0]
					}
				case "unchecked":
					return { kind: "brand", domain: owned.domain, law: native.object.lawIds[0] }
			}
		}
	}
}

/** The law names of a subject: own and compileLaws. */
export const lawNamesOf = (subject: NamingSubject): LawNames => {
	const owned = ownedInput(subject)
	if (!owned.ok) {
		throw refused(owned.error)
	}
	const model = compileLaws(owned.value)
	if (!model.ok) {
		throw refused(model.error)
	}
	return lawNamesOver(model.value, model.value.constraintToLaw)
}

/** The LawId of a law statement of a schema, as the installer derives it. */
export const lawIdOf = (schema: AnySchema, law: Statement): LawId => lawNamesOf(schema).lawOf(law)

/**
 * The installed name of a constraint of a relation, named by its kind and its fields (as a set): a primary key, a
 * unique key or span key, a foreign key, or a finite check. A named row check has no field set: a test names its
 * constraint by its law, `lawNamesOf(schema).constraintOf(lawIdOf(schema, checkStatement), "TableCheck")`.
 */
export const constraintOf = <R extends AnyRelation>(
	schema: AnySchema,
	relation: R,
	kind: ConstraintKind,
	fields: ReadonlyArray<keyof R["fields"] & string>
): ConstraintName => lawNamesOf(schema).fieldConstraint(relation, kind, fields)

/**
 * A subject's whole installation compiled without a database, under the schema `at` names: own and compileInstallation
 * over the complete install options (physical/complete.ts), as `grizzle generate` drafts it (cli/generate.ts). A door
 * that named a partial installation would name objects production installs beside it as absent, so an installation
 * that leaves a residual law or a derived relation deferred is refused.
 */
export const installationOf = (subject: NamingSubject, at: InstalledAt): Installation => {
	const owned = lawNamesOf(subject).model.owned
	const under = at.kind === "declared" ? owned.installation : at.installation
	const installation = compileInstallation(owned, completeInstallOptions(owned, under, [], []))
	if (!installation.ok) {
		throw refused(installation.error)
	}
	const { residualLaws, derivedRelations } = installation.value.deferred
	if (residualLaws.length > 0 || derivedRelations.length > 0) {
		throw new Error(
			`the test names the installation of ${owned.name}, which leaves deferred the residual laws (${Arr.join(residualLaws, ", ")}) and the derived relations (${Arr.join(derivedRelations, ", ")})`
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

/**
 * The text domain of a column, by its installed table and column: the one of the installation's assignments that
 * types it, and the law its constraint reports.
 */
const textDomainOf = (
	installation: Installation,
	table: RelationIdent,
	column: ColumnIdent,
	what: string
): TextDomainNames => {
	const assigned = single(
		Arr.filter(installation.textDomains, (d) =>
			Arr.some(d.uses, (u) => u.table === table && u.column === column)
		),
		(count) =>
			`the test names the text domain of ${what}, which ${count} of the installation's domains type`
	)
	const law = constraintLaw(
		installation.constraintToLaw,
		{ kind: "domain", name: assigned.name },
		assigned.constraint
	)
	if (law === undefined) {
		throw new Error(`the text domain constraint ${assigned.constraint} reports no law`)
	}
	return { domain: assigned.name, constraint: assigned.constraint, law }
}

/** The names of an installation under `schema`. */
const namesOver = (installation: Installation, schema: string): Names => {
	const laws = lawNamesOver(installation.laws, installation.constraintToLaw)
	const names = installation.names
	const quotedSchema = quoteIdent(schema)
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
		triggers: (law) =>
			Arr.map(laws.residual(law).units, (u) => `${quotedSchema}.${quoteIdent(u.trigger)}`),
		textDomain: (relation, field) =>
			textDomainOf(
				installation,
				tableIdent(relation),
				columnIdent(relation, field),
				`${relation.name}.${field}`
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
					Arr.map(i.keys, (k) => k.field),
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
	const world = worldNames(owned, installed.installation.names.installation)
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

/** A contract's domain CHECK, as the naming door names it. */
export const contractCheckAt = (contract: string): ConstraintName =>
	identifierOf(identity.domainCheck(identity.contractDomain(parsedName(contract))))

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
 * localVectorSchema), with each pattern's structural text domain in that schema: a lowering without an installation
 * casts a delivered refined value it cannot prove to its domain, which the naming door names by its pattern key.
 */
export const standInNames = (declaredSchema: string): PhysicalNames => {
	const schema = installationTypes(identity.schema(parsedSchemaName(declaredSchema)))
	return {
		...productionNames(declaredSchema, { kind: "declared" }, localVectorSchema),
		textDomain: (regex) => ({ schema, name: identifierOf(identity.textDomain(regex.key)) })
	}
}

export interface NameMint {
	readonly lawId: (text: string) => LawId
	readonly constraint: (text: string) => ConstraintName
	readonly relation: (text: string) => RelationIdent
	readonly column: (text: string) => ColumnIdent
	readonly index: (text: string) => IndexName
	readonly domain: (text: string) => DomainName
	readonly trigger: (text: string) => TriggerName
	readonly lawFunction: (text: string) => LawFunctionName
}

/** Names admitted as the snapshot reader admits a name (core/identity.ts admittedIdentifier), each `prefix` and the text. */
const mint = (prefix: string): NameMint => ({
	lawId: (text): LawId => admittedIdentifier(`${prefix}${text}`),
	constraint: (text): ConstraintName => admittedIdentifier(`${prefix}${text}`),
	relation: (text): RelationIdent => admittedIdentifier(`${prefix}${text}`),
	column: (text): ColumnIdent => admittedIdentifier(`${prefix}${text}`),
	index: (text): IndexName => admittedIdentifier(`${prefix}${text}`),
	domain: (text): DomainName => admittedIdentifier(`${prefix}${text}`),
	trigger: (text): TriggerName => admittedIdentifier(`${prefix}${text}`),
	lawFunction: (text): LawFunctionName => admittedIdentifier(`${prefix}${text}`)
})

/**
 * Spellings the naming rule specifies, for its specification tests only: each admitted as the snapshot reader admits a
 * name.
 */
export const spelled: NameMint = mint("")

/**
 * Names no production rule produces, for name-agnostic machinery (a classifier's lookup, a stand-in, an evidence
 * premise, a hand-built table in the substrate tests): `~` and the token. `~` is outside [a-z0-9_], so a wild name
 * never equals a production name, and quoting keeps it a valid identifier.
 */
export const wild: NameMint = mint("~")
