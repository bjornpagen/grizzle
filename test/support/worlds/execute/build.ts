import { Array as Arr, Effect, Option, Record as Rec, Result } from "effect"
import { login } from "#compiler/program/workload/login.ts"
import { closedId, pg, span, uuid } from "#compiler/public/fields.ts"
import {
	type AnyClosed,
	type AnyRelation,
	type AnySchema,
	check,
	closed,
	contained,
	context,
	key,
	mutable,
	on,
	relation,
	type RowScalars,
	schema,
	select,
	type Statement
} from "#compiler/public/schema.ts"
import { compute } from "#compiler/scalar/compute/builders.ts"
import { derived } from "#compiler/schema/relation.ts"
import { alternativesBuilder } from "#compiler/schema/statements.ts"
import { contextDescOf, role } from "#compiler/schema/world.ts"
import { regexField } from "#compiler/text/field.ts"
import type { Predicate } from "#compiler/types/core/phantom.ts"
import type { AnyDerived } from "#compiler/types/derived/derived.ts"
import type { FieldBase } from "#compiler/types/fields/field.ts"
import type { Relation, Roster } from "#compiler/types/schema/relation.ts"
import type { AnyContext } from "#compiler/types/schema/world.ts"
import type { EntryValue } from "#compiler/types/schema/world.ts"
import { contractDescriptor as contractField } from "#test/support/fixtures/descriptors.ts"
import { argumentsOf, nonEmptyArgumentsOf } from "#test/support/list.ts"
import { definitionOf, type RuleSources } from "#test/support/worlds/execute/describe.ts"
import { carrierOf, isWide } from "#test/support/worlds/execute/host.ts"
import { attempt, type RealizeRefused } from "#test/support/worlds/execute/refused.ts"
import { fieldDomain } from "#test/support/worlds/model/host.ts"
import type {
	BaseSpec,
	ContextSpec,
	FieldDomain,
	FieldSpec,
	InstallSpec,
	LawSpec,
	RelationSpec,
	RoleSpec,
	RowPredicate,
	SideSpec
} from "#test/support/worlds/model/types.ts"

/** A relation built from a spec: its name, fields and key are known only at run time. */
export type BuiltRelation = Relation<
	string,
	Record<string, FieldBase>,
	readonly [string, ...Array<string>]
>
export type BuiltClosed = Roster<string, readonly [string, ...Array<string>]>
/** A role built from a spec: its entries and lists are known only at run time, and its type reads no context. */
export type BuiltRole = ReturnType<
	typeof role<
		AnySchema,
		string,
		Readonly<Record<string, EntryValue>>,
		ReadonlyArray<string>,
		ReadonlyArray<string>
	>
>

export type BuiltLogin = ReturnType<
	typeof login<AnySchema, string, readonly [BuiltRole, ...Array<BuiltRole>]>
>

/** The grizzle values of an installation, built under one declared schema name. */
export interface Built {
	readonly base: AnySchema
	readonly relations: Readonly<Record<string, BuiltRelation>>
	readonly closed: Readonly<Record<string, BuiltClosed>>
	readonly contexts: Readonly<Record<string, AnyContext>>
	/** The statement value of each `BaseSpec.laws` entry, in order. */
	readonly laws: ReadonlyArray<Statement>
	readonly roles: Readonly<Record<string, BuiltRole>>
	readonly logins: Readonly<Record<string, BuiltLogin>>
}

/** The first element and the rest of a list the spec guarantees nonempty. */
const nonEmpty = (
	fields: ReadonlyArray<string>,
	what: string
): Effect.Effect<readonly [string, ...Array<string>]> => {
	const [first, ...rest] = fields
	return first === undefined
		? Effect.die(new Error(`${what} names no field`))
		: Effect.succeed([first, ...rest])
}

const found = <A>(
	record: Readonly<Record<string, A>>,
	name: string,
	what: string
): Effect.Effect<A> =>
	Option.match(Rec.get(record, name), {
		onNone: () =>
			Effect.die(
				new Error(`the installation names the ${what} ${name}, which it does not declare`)
			),
		onSome: Effect.succeed
	})

/** What a field's value is built over: the base's closed rosters, and its integer contracts, each built once by name. */
interface Kit {
	readonly rosters: Readonly<Record<string, BuiltClosed>>
	readonly contracts: Readonly<Record<string, FieldBase>>
}

const fieldOf = (domain: FieldDomain, kit: Kit): Effect.Effect<FieldBase> => {
	switch (domain.kind) {
		case "uuid":
			return Effect.succeed(uuid)
		case "text":
			return Effect.succeed(regexField(domain.pattern, [domain.flags]))
		case "integer":
			return Effect.succeed(
				domain.bits === 16 ? pg.smallint : domain.bits === 32 ? pg.integer : pg.bigint
			)
		case "serial":
			return Effect.succeed(domain.bits === 32 ? pg.serial : pg.bigserial)
		case "boolean":
			return Effect.succeed(pg.boolean)
		case "handle":
			return Effect.map(found(kit.rosters, domain.closed, "closed roster"), (roster) =>
				closedId(roster)
			)
		case "span":
			return Effect.succeed(domain.bits === 32 ? span(pg.integer) : span(pg.bigint))
		case "contract":
			return found(kit.contracts, domain.name, "contract")
	}
}

/**
 * An integer contract: a DOMAIN over the integer type whose CHECK keeps its values in [min, max], built on the contract
 * builder's runtime path, since its name is known only at run time.
 */
const contractOf = (
	domain: Extract<FieldDomain, { readonly kind: "contract" }>
): Effect.Effect<FieldBase> =>
	Effect.sync(() => {
		const wide = domain.bits === 64
		const integer = domain.bits === 16 ? pg.smallint : domain.bits === 32 ? pg.integer : pg.bigint
		const low = wide ? BigInt(domain.min) : domain.min
		const high = wide ? BigInt(domain.max) : domain.max
		return contractField(domain.name, integer, (v: unknown) => compute.between(v, low, high))
	})

/**
 * The base's integer contracts by name, each built once from its domain: a relation's field and a context's field of
 * one contract are the one contract, as two contracts of one name would be two DOMAINs of one name.
 */
const contractsOf = (base: BaseSpec): Effect.Effect<Readonly<Record<string, FieldBase>>> =>
	Effect.gen(function* () {
		const domains = Arr.flatMap([...base.relations, ...base.contexts], (owner) =>
			Arr.filterMap(owner.fields, (f) =>
				f.domain.kind === "contract" ? Result.succeed(f.domain) : Result.failVoid
			)
		)
		const contracts: Record<string, FieldBase> = {}
		const declared = new Map<string, Extract<FieldDomain, { readonly kind: "contract" }>>()
		for (const domain of domains) {
			const first = Option.fromNullishOr(declared.get(domain.name))
			if (Option.isNone(first)) {
				declared.set(domain.name, domain)
				contracts[domain.name] = yield* contractOf(domain)
			} else if (
				first.value.bits !== domain.bits ||
				first.value.min !== domain.min ||
				first.value.max !== domain.max
			) {
				return yield* Effect.die(
					new Error(`the base declares the contract ${domain.name} twice, differently`)
				)
			}
		}
		return contracts
	})

/**
 * A context field's value: a field of the domains a context admits (README "Permissions": text, uuid, boolean, the integer
 * types, contracts over them and closed handles). A contract is built on the contract builder's runtime path, whose
 * value is no `ContextField` by its type, so a context is built as a JavaScript caller builds one (contextOf).
 */
const contextFieldOf = (domain: FieldDomain, kit: Kit): Effect.Effect<unknown> => {
	switch (domain.kind) {
		case "uuid":
		case "text":
		case "integer":
		case "boolean":
		case "handle":
		case "contract":
			return fieldOf(domain, kit)
		case "serial":
		case "span":
			return Effect.die(
				new Error(`a context field of a ${domain.kind} domain, which no context admits`)
			)
	}
}

/** A context value, as the library recognizes one: what `context` built. */
const isContext = (value: unknown): value is AnyContext => contextDescOf(value) !== undefined

/** The domain of a field of a relation of the base. */
export const domainOf = (
	base: BaseSpec,
	relationName: string,
	field: string
): Effect.Effect<FieldDomain> => {
	const domain = fieldDomain(base, { kind: "ordinary", name: relationName }, field)
	return domain === undefined
		? Effect.die(new Error(`the base declares no field ${relationName}.${field}`))
		: Effect.succeed(domain)
}

const recordOf = <A>(
	fields: ReadonlyArray<FieldSpec>,
	build: (domain: FieldDomain) => Effect.Effect<A>
): Effect.Effect<Record<string, A>> =>
	Effect.map(
		Effect.forEach(fields, (f) => Effect.map(build(f.domain), (value) => [f.name, value] as const)),
		Rec.fromEntries
	)

const relationOf = (spec: RelationSpec, kit: Kit): Effect.Effect<BuiltRelation, RealizeRefused> =>
	Effect.gen(function* () {
		const fields = yield* recordOf(spec.fields, (domain) => fieldOf(domain, kit))
		const primary = yield* nonEmpty(spec.key, `the primary key of ${spec.name}`)
		return yield* attempt(`relation ${spec.name}`, () => relation(spec.name, fields, primary))
	})

/** A context of the spec, built by `context` handed its fields and its claim object's key, if any. */
const contextOf = (spec: ContextSpec, kit: Kit): Effect.Effect<AnyContext, RealizeRefused> =>
	Effect.gen(function* () {
		const fields = yield* recordOf(spec.fields, (domain) => contextFieldOf(domain, kit))
		const claim = spec.claim
		const value = yield* attempt<unknown>(`context ${spec.name}`, (): unknown =>
			claim.kind === "top-level"
				? Reflect.apply(context, undefined, [spec.name, fields])
				: Reflect.apply(context, undefined, [spec.name, fields, { claim: claim.key }])
		)
		return isContext(value)
			? value
			: yield* Effect.die(new Error(`context ${spec.name} built no context`))
	})

interface Space {
	readonly base: BaseSpec
	readonly relations: Readonly<Record<string, BuiltRelation>>
	readonly closed: Readonly<Record<string, BuiltClosed>>
}

/**
 * A side of a law: its relation, selected by its selector's values when it fixes any (each field equal to its value,
 * carried as the field's domain stores it), on its paired fields.
 */
const sideOf = (space: Space, side: SideSpec) =>
	Effect.gen(function* () {
		const r = yield* found(space.relations, side.relation, "relation")
		const fields = yield* nonEmpty(side.fields, `a side of ${side.relation}`)
		const where = yield* Effect.forEach(Rec.toEntries(side.where), ([field, value]) =>
			Effect.map(
				domainOf(space.base, side.relation, field),
				(domain) => [field, carrierOf(domain, value)] as const
			)
		)
		const [first, ...rest] = where
		return first === undefined
			? on(r, ...nonEmptyArgumentsOf(fields))
			: on(
					select(r, (row) => selectorOf(row, [first, ...rest])),
					...nonEmptyArgumentsOf(fields)
				)
	})

/**
 * The statement of one law spec. A coverage is a containment between two sides each ending in its span field, the
 * spec's sides holding their scalars alone (README "Rules": `contained` between two `span` fields).
 */
const lawOf = (space: Space, law: LawSpec): Effect.Effect<Statement, RealizeRefused> =>
	Effect.gen(function* () {
		switch (law.kind) {
			case "key": {
				const r = yield* found(space.relations, law.relation, "relation")
				const fields = yield* nonEmpty(law.fields, `a key of ${law.relation}`)
				return yield* attempt(`key of ${law.relation}`, () =>
					key(on(r, ...nonEmptyArgumentsOf(fields)))
				)
			}
			case "spanKey": {
				const r = yield* found(space.relations, law.relation, "relation")
				const fields = yield* nonEmpty(
					law.spanAt === "first" ? [law.span, ...law.scalars] : [...law.scalars, law.span],
					`a span key of ${law.relation}`
				)
				return yield* attempt(`span key of ${law.relation}`, () =>
					key(on(r, ...nonEmptyArgumentsOf(fields)))
				)
			}
			case "check": {
				const r = yield* found(space.relations, law.relation, "relation")
				const domains = yield* Effect.map(
					Effect.forEach(fieldsOf(law.predicate), (field) =>
						Effect.map(
							domainOf(space.base, law.relation, field),
							(domain) => [field, domain] as const
						)
					),
					Rec.fromEntries
				)
				return yield* attempt(`check ${law.name}`, () =>
					check(law.name, r, (row) => predicateOf(row, law.predicate, domains))
				)
			}
			case "contained": {
				const source = yield* sideOf(space, law.source)
				const target = yield* sideOf(space, law.target)
				return yield* attempt(`containment of ${law.source.relation}`, () =>
					contained(source, target)
				)
			}
			case "covered": {
				const source = yield* sideOf(space, {
					...law.source,
					fields: Arr.append(law.source.fields, law.span.source)
				})
				const target = yield* sideOf(space, {
					...law.target,
					fields: Arr.append(law.target.fields, law.span.target)
				})
				return yield* attempt(`coverage of ${law.source.relation}`, () => contained(source, target))
			}
			case "alternatives": {
				const parent = yield* found(space.relations, law.relation, "relation")
				const roster = yield* found(space.closed, law.closed, "closed roster")
				const arms = yield* Effect.map(
					Effect.forEach(Rec.toEntries(law.arms), ([handle, armRelation]) =>
						Effect.map(
							found(space.relations, armRelation, "relation"),
							(arm) => [handle, arm] as const
						)
					),
					Rec.fromEntries
				)
				return yield* attempt(`alternatives of ${law.relation}`, () =>
					alternativesBuilder(parent, law.tag, roster, arms)
				)
			}
		}
	})

const fieldsOf = (predicate: RowPredicate): ReadonlyArray<string> =>
	predicate.kind === "compare" ? [predicate.field] : Arr.flatMap(predicate.parts, fieldsOf)

type Row = RowScalars<BuiltRelation>

type RowTerm = NonNullable<Row[string]>

const compared = (
	row: Row,
	op: RowPredicate & { readonly kind: "compare" },
	term: RowTerm,
	literal: number
): Predicate => {
	switch (op.op) {
		case "<":
			return row.lt(term, literal)
		case "<=":
			return row.le(term, literal)
		case "=":
			return row.eq(term, literal)
		case "<>":
			return row.ne(term, literal)
		case ">=":
			return row.ge(term, literal)
		case ">":
			return row.gt(term, literal)
	}
}

const comparedWide = (
	row: Row,
	op: RowPredicate & { readonly kind: "compare" },
	term: RowTerm,
	literal: bigint
): Predicate => {
	switch (op.op) {
		case "<":
			return row.lt(term, literal)
		case "<=":
			return row.le(term, literal)
		case "=":
			return row.eq(term, literal)
		case "<>":
			return row.ne(term, literal)
		case ">=":
			return row.ge(term, literal)
		case ">":
			return row.gt(term, literal)
	}
}

/**
 * A selection's predicate over the row of a relation built at run time: each selected field equal to its value,
 * conjoined. A field the relation does not hold is a defect of the caller's spec.
 */
export const selectorOf = (
	row: Row,
	where: Arr.NonEmptyReadonlyArray<readonly [string, unknown]>
): Predicate =>
	row.and(
		...argumentsOf(
			Arr.map(where, ([field, value]) => {
				const term = row[field]
				if (term === undefined) {
					throw new Error(`a selector reads ${field}, which its relation does not hold`)
				}
				return row.eq(term, value)
			})
		)
	)

/** A row check's predicate over the row's scalars: each comparison's literal typed by its field. */
const predicateOf = (
	row: Row,
	predicate: RowPredicate,
	domains: Readonly<Record<string, FieldDomain>>
): Predicate => {
	if (predicate.kind === "and") {
		return row.and(
			...argumentsOf(Arr.map(predicate.parts, (part) => predicateOf(row, part, domains)))
		)
	}
	const term = row[predicate.field]
	const domain = domains[predicate.field]
	if (term === undefined || domain === undefined) {
		throw new Error(`a row check reads ${predicate.field}, which its relation does not hold`)
	}
	return isWide(domain)
		? comparedWide(row, predicate, term, BigInt(predicate.value))
		: compared(row, predicate, term, predicate.value)
}

/**
 * The base schema of a spec, its derived relations added by `schema.extend`, under `name`, with the values its rules
 * match: what an installation's roles are built over, and what a test builds a rule set over (describe.ts definitionOf).
 */
export const buildBase = (
	spec: BaseSpec,
	name: string
): Effect.Effect<BuiltBase & { readonly laws: ReadonlyArray<Statement> }, RealizeRefused> =>
	Effect.gen(function* () {
		const rosters: Record<string, BuiltClosed> = {}
		for (const c of spec.closed) {
			rosters[c.name] = yield* attempt(`closed ${c.name}`, () => closed(c.name, c.members))
		}
		const kit: Kit = { rosters, contracts: yield* contractsOf(spec) }
		const relations: Record<string, BuiltRelation> = {}
		for (const r of spec.relations) {
			relations[r.name] = yield* relationOf(r, kit)
		}
		const space: Space = { base: spec, relations, closed: rosters }
		const mutables = yield* Effect.forEach(
			Arr.filter(spec.relations, (r) => r.mutability === "mutable"),
			(r) =>
				Effect.flatMap(found(relations, r.name, "relation"), (value) =>
					attempt(`mutable ${r.name}`, () => mutable(value))
				)
		)
		const laws = yield* Effect.forEach(spec.laws, (law) => lawOf(space, law))
		const contexts: Record<string, AnyContext> = {}
		for (const c of spec.contexts) {
			contexts[c.name] = yield* contextOf(c, kit)
		}
		const declared: Record<string, AnyRelation | AnyClosed> = { ...rosters, ...relations }
		const root = yield* attempt(`schema ${name}`, () =>
			schema(name, declared, [...mutables, ...laws])
		)
		const derivedValues: Record<string, AnyDerived> = {}
		let base: AnySchema = root
		for (const d of spec.derived) {
			const level = base
			const definition = yield* definitionOf(
				spec,
				{ relations: { ...rosters, ...relations, ...derivedValues }, contexts },
				d.rules,
				level,
				`derived ${d.name}`
			)
			const value = yield* attempt(`derived ${d.name}`, () => derived(d.name, definition, []))
			derivedValues[d.name] = value
			base = yield* attempt(`derived ${d.name}`, () =>
				schema.extend(level, { [d.name]: value }, [])
			)
		}
		return { base, relations, closed: rosters, derived: derivedValues, contexts, laws }
	})

export interface BuiltBase {
	readonly base: AnySchema
	readonly relations: Readonly<Record<string, BuiltRelation>>
	readonly closed: Readonly<Record<string, BuiltClosed>>
	readonly derived: Readonly<Record<string, AnyDerived>>
	readonly contexts: Readonly<Record<string, AnyContext>>
}

/** A whole entry's value: the base's relation, closed roster or derived relation of that name. */
const wholeOf = (made: BuiltBase, name: string): Effect.Effect<EntryValue> => {
	const value = made.relations[name] ?? made.closed[name] ?? made.derived[name]
	return value === undefined
		? Effect.die(new Error(`a whole entry of ${name}, which the base does not declare`))
		: Effect.succeed(value)
}

/** The values a rule over a built base matches: its rosters, relations and derived relations, and its contexts. */
export const sourcesOf = (made: BuiltBase): RuleSources => ({
	relations: { ...made.closed, ...made.relations, ...made.derived },
	contexts: made.contexts
})

const roleOf = (spec: InstallSpec, made: BuiltBase, r: RoleSpec) =>
	Effect.gen(function* () {
		const entries: Record<string, EntryValue> = {}
		for (const [name, entry] of Rec.toEntries(r.entries)) {
			entries[name] =
				entry.kind === "whole"
					? yield* wholeOf(made, entry.relation)
					: yield* definitionOf(
							spec.base,
							sourcesOf(made),
							entry.rules,
							made.base,
							`entry ${r.name}.${name}`
						)
		}
		const value: BuiltRole = yield* attempt(`role ${r.name}`, () =>
			role(made.base, r.name, entries, { write: r.write, refresh: r.refresh })
		)
		return value
	})

/** Every value of an installation, built through the public builders under the declared schema name `name`. */
export const buildInstall = (
	spec: InstallSpec,
	name: string
): Effect.Effect<Built, RealizeRefused> =>
	Effect.gen(function* () {
		const made = yield* buildBase(spec.base, name)
		const roles: Record<string, BuiltRole> = {}
		for (const r of spec.roles) {
			roles[r.name] = yield* roleOf(spec, made, r)
		}
		const logins: Record<string, BuiltLogin> = {}
		for (const l of spec.logins) {
			const members = yield* Effect.forEach(l.roles, (r) => found(roles, r, "role"))
			logins[l.name] = yield* attempt(`login ${l.name}`, () => login(made.base, l.name, members))
		}
		return {
			base: made.base,
			relations: made.relations,
			closed: made.closed,
			contexts: made.contexts,
			laws: made.laws,
			roles,
			logins
		}
	})
