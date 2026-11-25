import { mapNonEmpty } from "@bjornpagen/grizzle-text/base/nonempty"
import { defined } from "@bjornpagen/testing/assert"
import { array, boolean, element, type Gen, subarray } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Option, Record as Rec } from "effect"
import {
	type CompiledServed,
	type ServedEntry,
	type ServedRefusal,
	servedEntryOf,
	snapshotCompiled
} from "#adapter/served/compile.ts"
import { builtLogin, type LayerRole, ownLoginOver } from "#adapter/served/login.ts"
import { transactionClock } from "#compiler/ir/clock.ts"
import type { Codebook } from "#compiler/ir/codes.ts"
import { contextFieldAdmits, type FieldDecl, type SchemaDesc } from "#compiler/ir/desc.ts"
import { clockedMember, workload } from "#compiler/program/workload/value.ts"
import { Logic, Type } from "#compiler/public/compute.ts"
import { contract, pg } from "#compiler/public/fields.ts"
import { context, login, role, wholeEntriesOf } from "#compiler/public/schema.ts"
import { paged } from "#compiler/public/workload.ts"
import { queryOver, varsOver } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import type { Owned } from "#compiler/schema/own.ts"
import { schemaDescOf } from "#compiler/schema/schema.ts"
import { contextDescOf } from "#compiler/schema/world.ts"
import type { ServedFile, ServedRoleForm } from "#compiler/served/forms.ts"
import { servedFile } from "#compiler/served/json.ts"
import type { AnySchema } from "#compiler/types/schema/schema.ts"
import type { AnyContext, EntryValue } from "#compiler/types/schema/world.ts"
import { changeSetOver } from "#compiler/write/changeset/value.ts"
import { succeeded } from "#test/support/assert.ts"
import { jsonOf } from "#test/support/chunked.ts"
import { compiledSnapshot } from "#test/support/compiled-served.ts"
import { type BuiltSchema, buildRoot, buildSchema } from "#test/support/oracle/public/build.ts"
import {
	type LawLevel,
	type Laws,
	type LevelRelation,
	lawsOf
} from "#test/support/oracle/public/laws.ts"
import type { ProgramCase, Root } from "#test/support/oracle/public/program.ts"

/**
 * A login drawn over a generated public schema (test/support/oracle/public) extended by its law level (laws.ts), and
 * its served file compiled as `grizzle generate` compiles it, with no database, under the level's codes, holes and
 * all: what the served file's reach (test/unit/served/reach.test.ts), its classifier's cut
 * (test/unit/served/refusals.test.ts) and its round trip (test/unit/served/file.test.ts) are searched over.
 *
 * A login holds one or more roles over the extended schema, each holding every relation whole. A role draws:
 *
 * - the relations it may write, some of the schema's, the level's among them, but never the one its query entry writes,
 *   since a role writes each relation through one entry;
 * - perhaps a query entry, `Mine`, over one relation, which it writes too, reading a context of two claims: `key`,
 *   typed as a field of the entry's relation, which selects the relation's facts the entry holds, and `held`, typed as a
 *   field of any relation of the schema, its very descriptor, so its domain is that field's domain: a pattern's, or a
 *   checked contract's of the level;
 * - its workload's ChangeSets, each an insert into one relation it writes or into `Mine`, every relation closed, the facts the
 *   call's;
 * - its workload's reads, some of the case's queries, an ordered one read whole or paged;
 * - perhaps a clocked read (clockedRead): the schema's first relation's facts at or after `now`, a parameter typed
 *   by the checked contract `Instant` over bigint, which the member binds to the database's clock in milliseconds, so
 *   its statement casts the reading to the contract's domain.
 *
 * A login of the live suites (liveLoginGen) holds besides, in its first role, constructed rather than drawn: the query
 * entry, and a read through it, `Mine`'s facts at the key a parameter binds; and a read of the law level's derived
 * relation (laws.ts Laws view).
 *
 * Each draw is a choice among the case's own relations, fields and queries: the counts are the case's. The number of
 * roles is a search budget.
 */

/** The case's schema extended by its law level, with every relation of both by its declared name. */
export interface DrawnSchema {
	readonly case: ProgramCase
	readonly built: BuiltSchema
	readonly laws: Laws
	readonly relations: Arr.NonEmptyReadonlyArray<LevelRelation>
}

/** The case's schema over its built values, extended by `level`. */
export const drawnSchema = (c: ProgramCase, level: LawLevel): DrawnSchema => {
	const built = buildSchema(c.schema)
	const laws = lawsOf(c.schema, built, level)
	const [first, ...rest] = Arr.map(c.schema.relations, (r): LevelRelation => {
		const value = built.relation(r)
		return { name: r.name, value, fields: value.fields }
	})
	return { case: c, built, laws, relations: [first, ...rest, ...laws.relations] }
}

/** Where a role's ChangeSet writes: a relation it holds whole, by name, or its query entry `Mine`. */
type ChangeTarget =
	| { readonly kind: "whole"; readonly relation: string }
	| { readonly kind: "entry" }

/**
 * One ChangeSet of a role's workload: an insert into its target, the facts the call's. The drawn schema's relations are
 * closed, none declared mutable inside a unit, so their facts are inserted, never changed or deleted.
 */
interface ChangeShape {
	readonly target: ChangeTarget
}

/** A field of a relation of the schema, both by declared name. */
interface FieldAt {
	readonly relation: string
	readonly field: string
}

/**
 * A role's query entry `Mine` over `target`: the target's facts whose field `key` is the context's `key` claim, the
 * context holding beside it the claim `held`, typed as the field `held` names.
 */
interface EntryShape {
	readonly target: string
	readonly key: string
	readonly held: FieldAt
}

/** One of the case's queries a role's workload reads, by its place among the case's reads, an ordered one perhaps paged. */
interface ReadShape {
	readonly place: number
	readonly query: Root
	readonly paged: boolean
}

/**
 * A read of the role's own world a live login's first role holds (liveLoginGen): through its query entry, its facts at
 * the key a parameter binds, or of the law level's derived relation.
 */
export type WorldRead = "entry" | "view"

/** A role of a drawn login (see the header). */
export interface RoleShape {
	readonly writes: ReadonlyArray<string>
	readonly entry: Option.Option<EntryShape>
	readonly changes: ReadonlyArray<ChangeShape>
	readonly reads: ReadonlyArray<ReadShape>
	readonly worldReads: ReadonlyArray<WorldRead>
	readonly clocked: boolean
}

/**
 * The type of a clocked read's `now` (see the header): a checked contract over bigint, an instant in milliseconds, never
 * negative, whose domain's CHECK a reading cast to it meets.
 */
const Instant = contract("Instant", pg.bigint, (m) => Logic.ge(m, 0n))

/** The name of a role's clocked read, by the role's place. */
export const clockedReadName = (place: number): string => `${roleName(place)}clock`

/** The name of the query entry a role writes through, and of the login every case draws. */
const entryName = "Mine"
const loginName = "app"

/** A role's name in the login, by its place. */
export const roleName = (place: number): string => `role${place}`

/** The descriptor a relation of the drawn schema declares a field with. */
const descriptorOf = (drawn: DrawnSchema, at: FieldAt): unknown =>
	defined(
		Arr.findFirst(drawn.relations, (r) => r.name === at.relation).pipe(
			Option.flatMap((r) => Option.fromNullishOr(r.fields[at.field])),
			Option.getOrUndefined
		),
		`relation ${at.relation} declares field ${at.field}`
	)

/** A schema's description and every level below it, top first. */
const levelsOf = (desc: SchemaDesc | undefined): ReadonlyArray<SchemaDesc> =>
	desc === undefined ? [] : [desc, ...levelsOf(desc.bases[0])]

/** A field of the drawn schema's stored relations, and the declaration it has. */
interface DeclaredField {
	readonly at: FieldAt
	readonly decl: FieldDecl
}

/** Every field of the drawn schema's stored relations, every level's, read off the description its builders made. */
const declaredFields = (drawn: DrawnSchema): ReadonlyArray<DeclaredField> =>
	Arr.flatMap(levelsOf(schemaDescOf(drawn.laws.schema)), (level) =>
		Arr.flatMap(level.relations, (r) =>
			r.kind === "relation"
				? Arr.map(Rec.toEntries(r.fields), ([field, decl]): DeclaredField => ({
						at: { relation: r.name, field },
						decl
					}))
				: []
		)
	)

/** Whether a context's claim may carry a field: its caller writes it, and a claim admits its type. */
const carriesClaim = (f: DeclaredField): boolean =>
	f.decl.writing.kind === "caller" && contextFieldAdmits(f.decl.type)

/**
 * Every field of the drawn schema's relations a context's claim may carry, read off the description its builders made,
 * every level's: a field its caller writes whose type a claim admits (ir/desc.ts contextFieldAdmits).
 */
const claimFields = (drawn: DrawnSchema): ReadonlyArray<FieldAt> =>
	Arr.map(Arr.filter(declaredFields(drawn), carriesClaim), (f) => f.at)

/** Whether a field's type is a checked contract, whose domain holds its predicate as a CHECK. */
const checkedContract = (f: DeclaredField): boolean =>
	f.decl.type.kind === "contract" && f.decl.type.predicate !== undefined

/**
 * A role writing through its query entry alone, its `held` claim typed as a checked contract and the entry's target a
 * relation declaring no checked contract's field: the contract's domain types no column the role writes, so a write
 * through the entry meets that domain's CHECK when it casts the claim (test/unit/served/refusals.test.ts). The key, the
 * held claim and the write's op are drawn among those that qualify; none where no field qualifies for either.
 */
export const contractClaimRoleGen =
	(drawn: DrawnSchema): Gen<Option.Option<RoleShape>> =>
	(source) => {
		const fields = declaredFields(drawn)
		const contracted = new Set(Arr.map(Arr.filter(fields, checkedContract), (f) => f.at.relation))
		const [heldFirst, ...heldRest] = Arr.filter(
			fields,
			(f) => checkedContract(f) && carriesClaim(f)
		)
		const [keyFirst, ...keyRest] = Arr.filter(
			fields,
			(f) => carriesClaim(f) && !contracted.has(f.at.relation)
		)
		if (heldFirst === undefined || keyFirst === undefined) {
			return Option.none()
		}
		const key = source.draw(element([keyFirst, ...keyRest])).at
		const held = source.draw(element([heldFirst, ...heldRest])).at
		return Option.some({
			writes: [],
			entry: Option.some({ target: key.relation, key: key.field, held }),
			changes: [{ target: { kind: "entry" } }],
			reads: [],
			worldReads: [],
			clocked: false
		})
	}

/** A query entry over a relation of the schema with a field a claim may carry, or none where no relation has one. */
const heldEntryGen =
	(drawn: DrawnSchema): Gen<Option.Option<EntryShape>> =>
	(source) => {
		const [first, ...rest] = claimFields(drawn)
		if (first === undefined) {
			return Option.none()
		}
		const key = source.draw(element([first, ...rest]))
		const held = source.draw(element([first, ...rest]))
		return Option.some({ target: key.relation, key: key.field, held })
	}

/** A query entry drawn or not, as heldEntryGen draws it where it is drawn. */
const entryGen =
	(drawn: DrawnSchema): Gen<Option.Option<EntryShape>> =>
	(source) => {
		const [first, ...rest] = claimFields(drawn)
		if (first === undefined || !source.draw(boolean)) {
			return Option.none()
		}
		const key = source.draw(element([first, ...rest]))
		const held = source.draw(element([first, ...rest]))
		return Option.some({ target: key.relation, key: key.field, held })
	}

const roleGen =
	(drawn: DrawnSchema, held: Gen<Option.Option<EntryShape>>): Gen<RoleShape> =>
	(source) => {
		const entry = source.draw(held)
		const writes = source.draw(
			subarray(
				Arr.filter(
					Arr.map(drawn.relations, (r) => r.name),
					(name) => !Option.exists(entry, (e) => e.target === name)
				)
			)
		)
		const targets: ReadonlyArray<ChangeTarget> = [
			...Arr.map(writes, (relation): ChangeTarget => ({ kind: "whole", relation })),
			...(Option.isSome(entry) ? [{ kind: "entry" } as const] : [])
		]
		const changes = Arr.map(source.draw(subarray(targets)), (target): ChangeShape => ({ target }))
		const queries = Arr.flatMap(drawn.case.reads, (read, place) =>
			read.kind === "query" ? [{ place, query: read.query }] : []
		)
		const reads = Arr.map(source.draw(subarray(queries)), (read): ReadShape => ({
			...read,
			paged: read.query.delivery.kind === "ordered" && source.draw(boolean)
		}))
		return {
			writes,
			entry,
			changes,
			reads,
			worldReads: [],
			clocked: source.draw(boolean)
		}
	}

/** The roles of a login over the drawn schema, one or more (see the header). */
export const loginGen =
	(drawn: DrawnSchema): Gen<Arr.NonEmptyReadonlyArray<RoleShape>> =>
	(source) => [
		source.draw(roleGen(drawn, entryGen(drawn))),
		...source.draw(array(roleGen(drawn, entryGen(drawn)), { min: 0, max: 1 }))
	]

/**
 * The roles of a live suite's login (see the header): its first role holds the query entry wherever a field of the
 * schema may carry a claim, and reads through it and the law level's view; every other role as loginGen draws it.
 */
export const liveLoginGen =
	(drawn: DrawnSchema): Gen<Arr.NonEmptyReadonlyArray<RoleShape>> =>
	(source) => {
		const first = source.draw(roleGen(drawn, heldEntryGen(drawn)))
		return [
			{
				...first,
				worldReads: Option.isSome(first.entry) ? ["entry", "view"] : ["view"]
			},
			...source.draw(array(roleGen(drawn, entryGen(drawn)), { min: 0, max: 1 }))
		]
	}

/**
 * The roles of a login aimed at a paged member (unit/http/routes.test.ts): its first role reads every ordered query of
 * the case paged, beside the other reads loginGen draws for it; every other role as loginGen draws it.
 */
export const pagedLoginGen =
	(drawn: DrawnSchema): Gen<Arr.NonEmptyReadonlyArray<RoleShape>> =>
	(source) => {
		const [first, ...rest] = source.draw(loginGen(drawn))
		const ordered = Arr.flatMap(drawn.case.reads, (read, place): ReadonlyArray<ReadShape> =>
			read.kind === "query" && read.query.delivery.kind === "ordered"
				? [{ place, query: read.query, paged: true }]
				: []
		)
		return [
			{
				...first,
				reads: [
					...Arr.filter(first.reads, (r) => !Arr.some(ordered, (o) => o.place === r.place)),
					...ordered
				]
			},
			...rest
		]
	}

/** A value context(...) built, as the library recognizes one. */
const isContext = (value: unknown): value is AnyContext => contextDescOf(value) !== undefined

/** The context a role's query entry reads (EntryShape), built as a JavaScript caller builds one. */
const contextOf = (drawn: DrawnSchema, entry: EntryShape, place: number): AnyContext => {
	const value: unknown = Reflect.apply(context, undefined, [
		`Claims${place}`,
		{
			key: descriptorOf(drawn, { relation: entry.target, field: entry.key }),
			held: descriptorOf(drawn, entry.held)
		}
	])
	if (!isContext(value)) {
		throw new Error(`the context of role ${roleName(place)} is no context`)
	}
	return value
}

/** The value of a relation of the drawn schema, by its declared name. */
const relationValue = (drawn: DrawnSchema, name: string): unknown =>
	defined(
		Arr.findFirst(drawn.relations, (r) => r.name === name).pipe(Option.getOrUndefined),
		`relation ${name}`
	).value

/** The query entry `Mine` (EntryShape): the target's facts whose key field is the context's `key` claim. */
const entryOf = (drawn: DrawnSchema, entry: EntryShape, claims: AnyContext): EntryValue => {
	const target = relationValue(drawn, entry.target)
	return queryOver(drawn.laws.schema).rule((r: RuleValue) => {
		const fact = varsOver(target, "fact")
		const claim = varsOver(claims, "claims")
		return r
			.match(target, fact)
			.match(claims, { key: fact[entry.key], held: claim["held"] })
			.find(fact)
	})
}

/**
 * A drawn role's value and its workload's programs, by name. The role declares the context its query entry `Mine`
 * matches, the one its Db's claims hold, and none without the entry.
 */
const roleOf = (drawn: DrawnSchema, shape: RoleShape, place: number) => {
	const value: AnySchema = drawn.laws.schema
	const entries: Record<string, EntryValue> = { ...wholeEntriesOf(drawn.laws.schema) }
	const mine = Option.map(shape.entry, (entry) => ({
		entry,
		claims: contextOf(drawn, entry, place)
	}))
	if (Option.isSome(mine)) {
		entries[entryName] = entryOf(drawn, mine.value.entry, mine.value.claims)
	}
	const contexts = Option.match(mine, {
		onNone: (): ReadonlyArray<AnyContext> => [],
		onSome: (m) => [m.claims]
	})
	const written = Option.isSome(shape.entry) ? [...shape.writes, entryName] : shape.writes
	const made =
		written.length === 0
			? role(value, roleName(place), entries, { contexts })
			: role(value, roleName(place), entries, { insert: written, contexts })
	const changes = Arr.map(shape.changes, (change, i) => {
		const target =
			change.target.kind === "whole"
				? relationValue(drawn, change.target.relation)
				: defined(made.relations[entryName], `role ${roleName(place)}'s entry ${entryName}`)
		return [`${roleName(place)}change${i}`, changeSetOver.empty(made).insert(target, [])] as const
	})
	const reads = Arr.map(shape.reads, (read) => {
		const query = buildRoot(drawn.built, drawn.built.schema, read.query)
		return [
			`${roleName(place)}read${read.place}`,
			read.paged ? Reflect.apply(paged, undefined, [query]) : query
		] as const
	})
	const worldReads = Arr.flatMap(shape.worldReads, (world) =>
		Arr.map(
			worldReadOf(drawn, shape, made, world),
			(query) => [worldReadName(place, world), query] as const
		)
	)
	const clocked = shape.clocked ? [[clockedReadName(place), clockedRead(drawn)] as const] : []
	return {
		value: made,
		programs: Rec.fromEntries([...changes, ...reads, ...worldReads, ...clocked])
	}
}

/**
 * A role's clocked read (see the header): the schema's first relation's facts, kept while `now`, the clock's reading
 * typed by `Instant`, is at least 0, its member binding `now` to the database's clock in milliseconds.
 */
const clockedRead = (drawn: DrawnSchema): unknown => {
	const target = relationValue(drawn, Arr.headNonEmpty(drawn.relations).name)
	return clockedMember(
		queryOver(drawn.laws.schema).rule((r: RuleValue) => {
			const fact = varsOver(target, "fact")
			return r
				.match(target, fact)
				.where(r.ge(r.param("now", Instant), Type.literal(Instant, 0n)))
				.find(fact)
		}),
		{ now: "millis" }
	)
}

/** The name of a role's read of its own world (WorldRead), by the role's place. */
export const worldReadName = (place: number, world: WorldRead): string =>
	`${roleName(place)}${world}`

/** The parameter a read through the query entry binds its key to. */
const entryKeyParam = "mineKey"

/**
 * A role's read of its own world: through its query entry, every fact of `Mine` whose key field is the parameter
 * `mineKey`, typed as the field (none for a role with no entry); or every fact of the law level's view.
 */
const worldReadOf = (
	drawn: DrawnSchema,
	shape: RoleShape,
	made: ReturnType<typeof role>,
	world: WorldRead
): ReadonlyArray<unknown> => {
	switch (world) {
		case "view": {
			const view = drawn.laws.view.value
			return [
				queryOver(drawn.laws.schema).rule((r: RuleValue) => {
					const fact = varsOver(view, "fact")
					return r.match(view, fact).find(fact)
				})
			]
		}
		case "entry":
			return Option.match(shape.entry, {
				onNone: () => [],
				onSome: (entry) => {
					const mine = made.relations[entryName]
					return [
						queryOver(made).rule((r: RuleValue) => {
							const fact = varsOver(mine, "fact")
							return r
								.match(mine, fact)
								.where(
									r.eq(
										fact[entry.key],
										r.param(
											entryKeyParam,
											descriptorOf(drawn, { relation: entry.target, field: entry.key })
										)
									)
								)
								.find(fact)
						})
					]
				}
			})
	}
}

/** The login of a case's drawn roles: each role's workload holding its programs, a role of none holding no workload. */
export const drawnLogin = (drawn: DrawnSchema, shapes: Arr.NonEmptyReadonlyArray<RoleShape>) => {
	const roles = mapNonEmpty(shapes, (shape, place) => roleOf(drawn, shape, place))
	const base: AnySchema = drawn.laws.schema
	return login(
		base,
		loginName,
		mapNonEmpty(roles, (r) => r.value),
		{
			workload: Arr.flatMap(roles, (r) =>
				Rec.isEmptyRecord(r.programs) ? [] : [workload(r.value, r.programs)]
			)
		}
	)
}

/**
 * A login's compile as `grizzle generate` writes it (adapter/served/compile.ts snapshotCompiled, then servedEntryOf):
 * its roles, each with its artifacts and its compiled workload, the served file and its text, and the file read back
 * from the JSON value its text parses to, as a layer reads it (served/json.ts servedFile).
 */
interface CompiledLogin {
	readonly compiled: CompiledServed
	readonly entry: ServedEntry
	readonly json: unknown
	readonly back: ServedFile
}

/**
 * A login compiled over the snapshot.json generate writes for its base under the codes `codes` gives the owned base
 * (CompiledLogin): a drawn schema's, its law level's (Laws codes), or a fresh installation's; or the compile's refusal.
 */
export const compiledLogin = (
	login: unknown,
	codes: (owned: Owned) => Codebook
): Effect.Effect<CompiledLogin, ServedRefusal> =>
	Effect.gen(function* () {
		const built = defined(builtLogin(login), "a login built by login(...)")
		const base = succeeded(built.base.content.owned(), "the login's base")
		const owned = succeeded(ownLoginOver(built, base), "the login over its base")
		const snapshot = yield* compiledSnapshot(built, base, codes(base))
		const compiled = yield* snapshotCompiled({ login: built, owned }, snapshot, transactionClock)
		const entry = yield* servedEntryOf(compiled)
		const json = jsonOf(entry.text)
		return { compiled, entry, json, back: succeeded(servedFile(json), "the login's served file") }
	})

/** Each served role of a compiled login beside its compiled role, by the role's name. */
export const rolesOf = (
	compiled: CompiledLogin
): ReadonlyArray<{ readonly served: ServedRoleForm; readonly compiled: LayerRole }> =>
	Arr.map(compiled.back.roles, (served) => ({
		served,
		compiled: defined(
			Arr.findFirst(compiled.compiled.roles, (r) => r.role.name === served.name).pipe(
				Option.getOrUndefined
			),
			`the compiled role ${served.name}`
		)
	}))
