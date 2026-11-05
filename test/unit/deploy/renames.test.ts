import { describe, it } from "@effect/vitest"
import { type Case, exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { array, boolean, element, type Gen, int, map, oneOf, shuffled } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import {
	Array as Arr,
	Effect,
	Formatter,
	Option,
	Order,
	pipe,
	Record as Rec,
	Result,
	String as Str
} from "effect"
import { indices } from "#compiler/core/array.ts"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import {
	type Candidate,
	candidatesOf,
	type Draft,
	type Offer,
	pathOf,
	type RelationStep,
	rivals,
	samePath
} from "#compiler/deploy/diff/plan.ts"
import { splitRenames } from "#compiler/deploy/render/chosen.ts"
import type { MigrationMeta, ReadCandidate } from "#compiler/deploy/render/folder.ts"
import type { GenerateResult } from "#compiler/deploy/render/generate.ts"
import { findMarkers, fromFirstToken, splitStatements } from "#compiler/deploy/render/markers.ts"
import { noWorkload } from "#compiler/deploy/snapshot/build.ts"
import type { DeploySnapshot } from "#compiler/deploy/snapshot/types.ts"
import type { FieldDesc } from "#compiler/ir/desc.ts"
import type { TypedLiteral } from "#compiler/ir/expr.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import { completeInstallOptions } from "#compiler/physical/complete.ts"
import { compileInstallation, type Installation } from "#compiler/physical/install/compile.ts"
import { ownLogin } from "#compiler/schema/own.ts"
import { loginDescOf } from "#compiler/schema/world.ts"
import type { TypeRef } from "#compiler/sql/ast.ts"
import { placeholderToken } from "#compiler/sql/print.ts"
import {
	carry,
	noExtras,
	type Renames,
	serialFields,
	typedDefault,
	versionOf
} from "#test/pg/migrate-gen/support.ts"
import { assert, defined, refused, succeeded } from "#test/support/assert.ts"
import {
	capacity,
	closed,
	contained,
	eq,
	f,
	field,
	ge,
	literal,
	on,
	onWhere,
	relation,
	type SchemaDesc,
	value,
	within
} from "#test/support/fixtures/ir/desc.ts"
import { parsedName, parsedSchemaName } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import {
	catalogOf,
	emptyState,
	interpret,
	load,
	type State,
	typeText
} from "#test/support/migrate/interpret.ts"
import { asDrafted, compile, fromEmpty, fromSnapshot, generate } from "#test/support/migrate/kit.ts"
import {
	choosable,
	decisionText,
	draftActions,
	draftFiles,
	leftUnfilled,
	type Placeholder,
	plainPlan,
	planStatements,
	readsBack,
	type Reviewed,
	recordFaults,
	renderReviewed,
	review
} from "#test/support/migrate/review.ts"
import { int4, int8, literalEqualityKey, scalarOfSpec } from "#test/support/oracle/gen/domain.ts"
import type { LiteralRow, ValueFacts } from "#test/support/oracle/gen/facts.ts"
import type { GenSchema } from "#test/support/oracle/gen/schema.ts"
import { nonEmptyList } from "#test/support/oracle/pick.ts"
import { owning } from "#test/support/policy.ts"
import { buildInstall } from "#test/support/worlds/execute/build.ts"
import type {
	FieldDomain,
	InstallSpec,
	RelationSpec,
	Rule
} from "#test/support/worlds/model/types.ts"

/** Rename drafting, proved over a small box, with no database.
 *
 * The box holds three kinds of schema. One relation whose fields, up to three, are each renamed to a name of a pool
 * twice their number or keep their name, each with its type changed or not; up to two relations, each renamed to a name
 * of a pool twice their number, kept, or removed, each with its one payload field kept, renamed or dropped and its type
 * changed or not, which a candidate converts in place; and one keyed relation, renamed or not, whose primary key moves
 * between its two fields, maybe referenced by another relation's foreign key, which a candidate drops before the key
 * and the draft adds again. Every injective map of the names into the pool is drawn, so plain renames, swaps, chains,
 * removals and renames onto a name the same migration removes all occur, a removed relation pairs with several added
 * ones and the reverse, two removed relations rival for one added one, each with its own nested field's rename or its
 * own drop of the payload, and the first field, the primary key, is renamed too. Each draft from A to B is reviewed
 * every way the documented rules allow its candidates to be decided (`choosable`: at most one rename for each added and
 * each removed name, a field's rename nested in a relation's only under it, a field's rename only with the type's it
 * requires), every other candidate kept. Each draft's meta.json is the complete record of its files, and each reviewed
 * folder must:
 *
 * (a) read back as the decision made, by path, with nothing refused (the read-back oracle): no marker left, each
 *     candidate decided exactly as its instruction says, so a commented alternative not taken stays with any placeholder
 *     it holds, and a note of the reviewer's in a block comment names the placeholder too; and refuse, with every
 *     placeholder of the SQL left unfilled, exactly the lines that hold one;
 * (b) spell the reviewed plan: the markers and alternatives say what the draft means;
 * (c) run on the host model of PostgreSQL's DDL without failing where PostgreSQL
 *     would, a key dropped under a foreign key included, from A installed with one fact per relation (the facts whose
 *     carried forms B's laws admit), through B;
 * (d) leave every row holding what the carry model of the drafted rules says (`carry`),
 *     the chosen candidates being its renames: a value under its name, or a chosen rename's, when its type is kept, and
 *     the reviewer's placeholder value otherwise;
 * (e) leave the tables and columns a fresh install of B creates, and nothing else;
 * (f) draft nothing more: once migrated, B drafts no change.
 *
 * Two rival relation renames both chosen, the second written as its head alone, are refused as twice.
 *
 * Then B is renamed back to A, and every review of the way back must pass (a), (b), (c), (d) carried from B's rows,
 * (e) against a fresh install of A, and (f). So a rename undone applies whichever way each rename went. The keyed kind
 * goes forward only: its way back drafts a reference into a relation the kept candidate leaves empty, which validation
 * refuses, a reviewed data step.
 *
 * A third box changes a closed roster of one to three handles into every other, which the documented rule renames in
 * place, extends, or rebuilds when handles are removed or reordered; a row holding a renamed handle holds its new name,
 * one holding a removed handle the one the reviewer maps it to, and a selected containment over the roster, a stored
 * tag and a foreign key over the enum, is dropped and created again around the rebuild.
 *
 * The bounded migration matrix adds a box per candidate kind beyond relations and fields, each of one or two objects
 * removed and one or two added, every injective map of their names into a pool twice their number or out of it, the
 * objects sharing their shape or each its own, and each drawn through the same oracles as the first box, every
 * choosable decision read back as itself, against a model of identity apart from the engine and a fresh install's
 * whole catalog:
 *
 * - closed relations, each typing its own field of one relation, each roster kept, its last handle renamed in place,
 *   reordered or shrunk: a rename of a roster kept is a type candidate, and a roster renamed in place or rebuilt is a
 *   group the reviewer confirms, a removed handle mapped by the reviewer; each row's handle is its handle's identity's
 *   name, or the roster's first where its handle is removed. A field moving between two closed relations both rebuilt is
 *   refused, as the documented rule says;
 * - contracts over bigint, each typing its own field of one relation, renamed with their predicate kept or changed, the
 *   field renamed with it or kept: a contract renamed with its predicate is a type candidate, and the field's rename
 *   requires it; every value is kept, a contract's conversion being its cast;
 * - indexes: the relations box with each payload field under an at-most-one capacity's unique index, so a relation's
 *   rename and its field's rename carry the index under the name of what it indexes;
 * - context fields: the relations box under a world, a login holding a role whose entry over each relation reads one
 *   field of a context, shared by both entries or each its own; B renames the fields read and the context, so every
 *   world object is created again over the renamed relations and fields as a fresh install creates it.
 *
 * The box of up to two names forward and one name back is proved whole, and so are the rosters of three handles and the
 * matrix. Every case runs on the host in milliseconds: this is the small-scope proof migrate-gen's paths on PostgreSQL
 * sample from. */
const schemaName = "Box"
const schema = identifierOf(identity.schema(parsedSchemaName(schemaName)))

/** The two types a name's type changes between: one stored value class, two physical types, so a change is a real
 * retype of the column and a value of either fits the other. */
const types = [int4, int8] as const
const scalarOfType = (t: TypeRef): ScalarType | undefined =>
	t.kind !== "builtin" || t.array
		? undefined
		: t.name === "integer"
			? int4
			: t.name === "bigint"
				? int8
				: undefined

/** The pools of names: fields, and relations. */
const fieldPool = ["a", "b", "c", "d", "e", "f"] as const
const relationPool = ["Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Zeta"] as const

type Kind = "fields" | "relations" | "keyed"

/** The field a keyed relation's primary key is. */
type KeyField = "id" | "v"

/** What B makes of a name of A: renamed to the pool name at `at` (itself when it is its own place), or removed. */
type Fate = { readonly kind: "to"; readonly at: number } | { readonly kind: "removed" }

/** What B makes of a relation's payload field `v`: kept, renamed to `w`, or dropped. */
type Payload = "kept" | "renamed" | "dropped"

/** One case of the box: a schema A, its successor B, and where each name of B came from. */
interface Box {
	readonly kind: Kind
	readonly a: GenSchema
	readonly b: GenSchema
	/** For each name of A in order, its fate in B, its payload (a relation's), and whether its type changed. */
	readonly fates: ReadonlyArray<Fate>
	readonly payloads: ReadonlyArray<Payload>
	readonly retyped: ReadonlyArray<boolean>
	/** A keyed case's primary key in A and in B, and whether a foreign key references it; undefined for the other kinds. */
	readonly keyed:
		| { readonly a: KeyField; readonly b: KeyField; readonly referenced: boolean }
		| undefined
}

const nameAt = (pool: ReadonlyArray<string>, i: number): string => {
	const name = pool[i]
	if (name === undefined) {
		throw new Error(`no name ${i} in the pool`)
	}
	return name
}

/** A relation `Item` whose fields are the given names, the first its primary key. */
const itemSchema = (
	fields: ReadonlyArray<{ readonly name: string; readonly type: ScalarType }>
): GenSchema => {
	const [key] = fields
	if (key === undefined) {
		throw new Error("a relation of no field")
	}
	return {
		name: schemaName,
		relations: [
			{ name: "Item", columns: fields, primaryKey: [key.name], keys: [], mutable: false }
		],
		closed: [],
		containments: []
	}
}

/** Relations of the given names, each keyed by `id` with a payload field of the given name and type, or none, beside
 * `Anchor`, which every version keeps as it is, so a version whose drawn relations are all removed still declares one. */
const relationsSchema = (
	relations: ReadonlyArray<{
		readonly name: string
		readonly payload: { readonly name: string; readonly type: ScalarType } | undefined
	}>
): GenSchema => ({
	name: schemaName,
	relations: [
		{
			name: "Anchor",
			columns: [
				{ name: "id", type: int8 },
				{ name: "z", type: int8 },
				{ name: "y", type: int8 }
			],
			primaryKey: ["z", "y"],
			keys: [],
			mutable: false
		},
		...Arr.map(relations, (r) => ({
			name: r.name,
			columns: [{ name: "id", type: int8 }, ...(r.payload === undefined ? [] : [r.payload])],
			primaryKey: ["id"],
			keys: [],
			mutable: false
		}))
	],
	closed: [],
	containments: []
})

const fieldsBox = (fates: ReadonlyArray<Fate>, retyped: ReadonlyArray<boolean>): Box => {
	const a = itemSchema(
		Arr.map(indices(fates.length), (i) => ({ name: nameAt(fieldPool, i), type: types[0] }))
	)
	const b = itemSchema(
		Arr.flatMap(fates, (fate, i) =>
			fate.kind === "removed"
				? []
				: [{ name: nameAt(fieldPool, fate.at), type: retyped[i] === true ? types[1] : types[0] }]
		)
	)
	return { kind: "fields", a, b, fates, payloads: [], retyped, keyed: undefined }
}

const relationsBox = (
	fates: ReadonlyArray<Fate>,
	payloads: ReadonlyArray<Payload>,
	retyped: ReadonlyArray<boolean>
): Box => {
	const a = relationsSchema(
		Arr.map(indices(fates.length), (i) => ({
			name: nameAt(relationPool, i),
			payload: { name: "v", type: types[0] }
		}))
	)
	const b = relationsSchema(
		Arr.flatMap(fates, (fate, i) => {
			if (fate.kind === "removed") {
				return []
			}
			const payload = defined(payloads[i], "a payload for each relation")
			const type = retyped[i] === true ? types[1] : types[0]
			return [
				{
					name: nameAt(relationPool, fate.at),
					payload:
						payload === "dropped" ? undefined : { name: payload === "kept" ? "v" : "w", type }
				}
			]
		})
	)
	return { kind: "relations", a, b, fates, payloads, retyped, keyed: undefined }
}

/** A relation of the given name with fields `id` and `v`, keyed by `key`, and maybe `Ref`, whose `item` references that
 * key: a foreign key into it. */
const keyedSchema = (name: string, key: KeyField, referenced: boolean): GenSchema => ({
	name: schemaName,
	relations: [
		{
			name,
			columns: [
				{ name: "id", type: int8 },
				{ name: "v", type: int8 }
			],
			primaryKey: [key],
			keys: [],
			mutable: false
		},
		...(referenced
			? [
					{
						name: "Ref",
						columns: [
							{ name: "id", type: int8 },
							{ name: "item", type: int8 }
						],
						primaryKey: ["id"],
						keys: [],
						mutable: false
					}
				]
			: [])
	],
	closed: [],
	containments: referenced
		? [{ from: { relation: "Ref", fields: ["item"] }, to: { relation: name, fields: [key] } }]
		: []
})

const keyFields: Gen<KeyField> = element<KeyField>(["id", "v"])

/** Every keyed case: the relation kept or renamed, its key in A and in B, and referenced or not. */
const keyedBoxes: Gen<Box> = (source) => {
	const to = source.draw(int(0, 1))
	const keyA = source.draw(keyFields)
	const keyB = source.draw(keyFields)
	const referenced = source.draw(boolean)
	return {
		kind: "keyed",
		a: keyedSchema(nameAt(relationPool, 0), keyA, referenced),
		b: keyedSchema(nameAt(relationPool, to), keyB, referenced),
		fates: [{ kind: "to", at: to }],
		payloads: [],
		retyped: [false],
		keyed: { a: keyA, b: keyB, referenced }
	}
}

/** Every injective map of `k` names into the first `2k` names of the pool, each name kept in it. */
const injections = (k: number): Gen<ReadonlyArray<Fate>> =>
	map(shuffled(indices(2 * k), { min: k, max: k }), (ats) =>
		Arr.map(ats, (at): Fate => ({ kind: "to", at }))
	)

/** Every injective map of `k` names into the first `2k` names of the pool or out of it: which names B keeps, then where
 * the kept ones go. */
const injectionsOrRemoved =
	(k: number): Gen<ReadonlyArray<Fate>> =>
	(source) => {
		const kept = source.draw(array(boolean, { min: k, max: k }))
		const ats = source.draw(
			shuffled(indices(2 * k), {
				min: Arr.filter(kept, (x) => x).length,
				max: Arr.filter(kept, (x) => x).length
			})
		)
		let next = 0
		return Arr.map(kept, (x): Fate => {
			if (!x) {
				return { kind: "removed" }
			}
			const at = defined(ats[next], "a pool name for each kept relation")
			next++
			return { kind: "to", at }
		})
	}

const payloadGen: Gen<Payload> = element<Payload>(["kept", "renamed", "dropped"])

/** Every box of `k` names of one kind. */
const boxes =
	(kind: "fields" | "relations", k: number): Gen<Box> =>
	(source) =>
		kind === "fields"
			? fieldsBox(source.draw(injections(k)), source.draw(array(boolean, { min: k, max: k })))
			: relationsBox(
					source.draw(injectionsOrRemoved(k)),
					source.draw(array(payloadGen, { min: k, max: k })),
					source.draw(array(boolean, { min: k, max: k }))
				)

const boxesUpTo = (sizes: Arr.NonEmptyReadonlyArray<number>): Gen<Box> =>
	oneOf([
		(source) => {
			const kind = source.draw(element<"fields" | "relations">(["fields", "relations"]))
			return source.draw(oneOf(Arr.map(sizes, (k) => boxes(kind, k))))
		},
		keyedBoxes
	])

const printBox = (box: Box): string =>
	`${box.kind}: ${Arr.join(
		Arr.map(
			box.fates,
			(fate, i) =>
				`${i}→${fate.kind === "removed" ? "removed" : String(fate.at)}${box.payloads[i] === undefined ? "" : ` payload ${box.payloads[i]}`}${box.retyped[i] === true ? " retyped" : ""}`
		),
		", "
	)}${
		box.keyed === undefined
			? ""
			: `, key ${box.keyed.a}→${box.keyed.b}${box.keyed.referenced ? ", referenced" : ""}`
	}`

/** A candidate's own rename offer as the plan drafts it, by its candidate, and its alternative. */
interface Own {
	readonly candidate: Candidate
	readonly alternative: ReadonlyArray<RelationStep>
}

/** Every candidate's own rename offer a draft holds, nested ones included. */
const ownOffers = (g: GenerateResult): ReadonlyArray<Own> => {
	const inSteps = (steps: ReadonlyArray<Draft | RelationStep>): ReadonlyArray<Own> =>
		Arr.flatMap(steps, (d) =>
			d.kind === "choice"
				? Arr.flatMap(d.offers, (o: Offer): ReadonlyArray<Own> => {
						switch (o.kind) {
							case "rename":
							case "nested rename":
								return [{ candidate: o.candidate, alternative: o.alternative }]
							case "relation rename":
								return [
									{ candidate: o.candidate, alternative: o.alternative },
									...inSteps(o.alternative)
								]
							case "rewrite":
							case "delete":
							case "convert":
								return []
						}
					})
				: []
		)
	return inSteps(Arr.map(g.plan.steps, (s) => s.draft))
}

/** The alternative of a candidate's own offer. */
const alternativeOf = (g: GenerateResult, c: Candidate): ReadonlyArray<RelationStep> =>
	Arr.flatMap(ownOffers(g), (o) => (o.candidate === c ? o.alternative : []))

/** Whether a candidate's alternative converts a column by the reviewer's placeholder. */
const retypes = (g: GenerateResult, c: Candidate): boolean =>
	Arr.some(alternativeOf(g, c), (x) => x.kind === "placeholderRetype")

/** Whether a relation's alternative drops a key of another relation before a key it drops: a referenced key rebuilt. */
const rebuildsReference = (g: GenerateResult, c: Candidate): boolean =>
	c.kind === "relation" &&
	Arr.some(
		alternativeOf(g, c),
		(x) =>
			(x.kind === "statement" &&
				x.statement.kind === "alterTable" &&
				x.statement.table.name !== c.added.name &&
				Arr.some(x.statement.actions, (a) => a.kind === "dropConstraint")) ||
			(x.kind === "choice" &&
				x.keep.kind === "statement" &&
				x.keep.statement.kind === "alterTable" &&
				x.keep.statement.table.name !== c.added.name &&
				Arr.some(x.keep.statement.actions, (a) => a.kind === "dropConstraint"))
	)

/** Whether a relation's alternative drops a field of the removed relation, a loss of its values. */
const dropsField = (g: GenerateResult, c: Candidate): boolean =>
	Arr.some(alternativeOf(g, c), (x) => x.kind === "loss")

/** The declared names of a schema's physical tables and columns. */
interface Names {
	readonly relation: (table: string) => string
	readonly field: (table: string, column: string) => string
}

/** A relation is named by its table, or, set aside, by the name the naming door sets its table aside under. */
const namesOf = (s: GenSchema): Names => {
	const relations = new Map(
		Arr.flatMap(
			s.relations,
			(r): ReadonlyArray<readonly [string, (typeof s.relations)[number]]> => [
				[identifierOf(identity.table(parsedName(r.name))), r],
				[identifierOf(identity.aside(identifierOf(identity.table(parsedName(r.name))))), r]
			]
		)
	)
	const relationOf = (table: string) => {
		const r = relations.get(table)
		if (r === undefined) {
			throw new Error(`no relation of the table ${table}`)
		}
		return r
	}
	return {
		relation: (table) => relationOf(table).name,
		field: (table, column) => {
			const c = Arr.findFirst(
				relationOf(table).columns,
				(x) => identifierOf(identity.column(parsedName(x.name))) === column
			)
			if (Option.isNone(c)) {
				throw new Error(`no field of the column ${table}.${column}`)
			}
			return c.value.name
		}
	}
}

/** The renames of the chosen candidates, by declared names, for the carry model: a relation's by its two relations, a
 * field's by its relation in B and its field in A, a nested field's by its relation's added and removed relations. */
const renamesOf = (chosen: ReadonlySet<Candidate>, from: GenSchema, to: GenSchema): Renames => {
	const before = namesOf(from)
	const after = namesOf(to)
	const relations = new Map<string, string>()
	const columns = new Map<string, string>()
	for (const c of chosen) {
		switch (c.kind) {
			case "relation":
				relations.set(after.relation(c.added.name), before.relation(c.removed.name))
				break
			case "field":
				columns.set(
					`${after.relation(c.relation.name)}.${after.field(c.relation.name, c.added)}`,
					before.field(c.relation.name, c.removed)
				)
				break
			case "nested field":
				columns.set(
					`${after.relation(c.parent.added.name)}.${after.field(c.parent.added.name, c.added)}`,
					before.field(c.parent.removed.name, c.removed)
				)
				break
			case "type":
			case "login":
				break
		}
	}
	return { relations, columns }
}

/** The value a reviewer writes for a placeholder: in the text, any SQL (no database reads it); in the model, the typed
 * default of the column's type, which the carry model gives a field it does not carry. */
const sqlValue = (): string => "0"
/** A removed handle maps to the new roster's first. */
const literalValue = (p: Placeholder): TypedLiteral => {
	if (p.kind === "placeholderHandles") {
		return { kind: "enum", handle: p.labels[0] }
	}
	const type = scalarOfType(p.column.type)
	if (type === undefined) {
		throw new Error(`a placeholder of the column ${p.column.name}, whose type is outside the box`)
	}
	return typedDefault(type)
}

/** One fact per relation of a schema of integer fields, every value distinct and no typed default. */
const distinctFacts = (s: GenSchema): ValueFacts => {
	let n = 1000n
	return Rec.fromEntries(
		Arr.map(
			s.relations,
			(r) =>
				[r.name, [Arr.map(r.columns, (): TypedLiteral => ({ kind: "int", value: n++ }))]] as const
		)
	)
}

/** One fact per relation of A, every value distinct and no typed default; a keyed case's relation holds one value in both
 * its fields, which `Ref` references, so the reference holds whichever field is the key. */
const factsOf = (box: Box): ValueFacts => {
	if (box.kind !== "keyed") {
		return distinctFacts(box.a)
	}
	return Rec.fromEntries(
		Arr.map(box.a.relations, (r): readonly [string, ReadonlyArray<LiteralRow>] => [
			r.name,
			[
				r.name === "Ref"
					? [
							{ kind: "int", value: 1001n },
							{ kind: "int", value: 1000n }
						]
					: [
							{ kind: "int", value: 1000n },
							{ kind: "int", value: 1000n }
						]
			]
		])
	)
}

const loaded = (state: State, s: GenSchema, facts: ValueFacts): State =>
	Arr.reduce(s.relations, state, (t, r) => {
		const rows = Arr.map(
			facts[r.name] ?? [],
			(row) =>
				new Map(
					Arr.map(r.columns, (c, i) => {
						const held = row[i]
						if (held === undefined) {
							throw new Error(`a fact of ${r.name} without ${c.name}`)
						}
						return [identifierOf(identity.column(parsedName(c.name))), held] as const
					})
				)
		)
		return load(t, identifierOf(identity.table(parsedName(r.name))), rows)
	})

/** What a version of a case installs: its description alone, or worlds over its base too (logins, roles and a
 * context), built through the public builders from the worlds model's install description. */
type Installs =
	| { readonly kind: "described"; readonly desc: SchemaDesc }
	| { readonly kind: "worlds"; readonly spec: InstallSpec }

/** One version of a case: its relations as the identity models and the host model's rows read them, and what it
 * installs. */
interface Shape {
	readonly schema: GenSchema
	readonly installs: Installs
}

/** A version that installs its relations as their description says. */
const described = (schema: GenSchema): Shape => ({
	schema,
	installs: { kind: "described", desc: versionOf(schema, noExtras).desc }
})

/** The installation of a version as `grizzle generate` compiles it: its natives, residual laws and derived relations,
 * and its logins' worlds. */
const installationOf = (s: Shape): Installation => {
	switch (s.installs.kind) {
		case "described":
			return compile(s.installs.desc, asDrafted)
		case "worlds": {
			const built = Effect.runSync(Effect.orDie(buildInstall(s.installs.spec, schemaName)))
			const owned = owning(built.base)
			const logins = Arr.map(Rec.values(built.logins), (l) =>
				succeeded(ownLogin(defined(loginDescOf(l), "a login built by login(...)")))
			)
			return succeeded(
				compileInstallation(owned, {
					...completeInstallOptions(owned, owned.installation, logins, []),
					owner: undefined
				})
			)
		}
	}
}

/** The drafts of one case over its versions, each version's installation compiled when the drafter is made. */
class Drafter {
	readonly #installations: ReadonlyMap<Shape, Installation>
	#timestamp = 0

	constructor(shapes: ReadonlyArray<Shape>) {
		this.#installations = new Map(Arr.map(shapes, (s) => [s, installationOf(s)] as const))
	}

	#installation(s: Shape): Installation {
		return defined(this.#installations.get(s), "the installation of one of the case's versions")
	}

	/** The first draft of `s`, from the empty snapshot. */
	first(s: Shape): GenerateResult {
		this.#timestamp++
		return succeeded(
			generate({
				installation: this.#installation(s),
				name: `step_${this.#timestamp}`,
				timestamp: this.#stamp(),
				previous: fromEmpty,
				workload: noWorkload
			})
		)
	}

	/** The draft of `s` after the snapshot `previous`. */
	draft(s: Shape, previous: DeploySnapshot): GenerateResult {
		return succeeded(this.attempt(s, previous))
	}

	/** The draft of `s` after the snapshot `previous`, or its refusal. */
	attempt(s: Shape, previous: DeploySnapshot): ReturnType<typeof generate> {
		this.#timestamp++
		return generate({
			previous: fromSnapshot(previous),
			installation: this.#installation(s),
			name: `step_${this.#timestamp}`,
			timestamp: this.#stamp(),
			workload: noWorkload
		})
	}

	#stamp(): string {
		return `2026101500${pipe(String(Math.floor(this.#timestamp / 60)), Str.padStart(2, "0"))}${pipe(String(this.#timestamp % 60), Str.padStart(2, "0"))}`
	}
}

/** A committed folder as later drafts and check read it: its meta.json and its reviewed files. */
interface Committed {
	readonly meta: MigrationMeta
	readonly files: ReadonlyArray<{ readonly name: string; readonly text: string }>
}

const committed = (g: GenerateResult, files: Reviewed["files"]): Committed => ({
	meta: g.folder.meta,
	files
})

const statementsOf = (files: ReadonlyArray<{ readonly text: string }>): ReadonlyArray<string> =>
	Arr.flatMap(files, (file) => Arr.map(splitStatements(file.text), fromFirstToken))

/** The tables and columns of a model state, each column with its type, and its enums with their labels in order, in a
 * canonical order. */
const shapeOf = (state: State): ReadonlyArray<string> =>
	Arr.sort(
		[
			...Arr.flatMap([...state.tables], ([table, t]) => [
				table,
				...Arr.map(t.columns, (c) => `${table}.${c.name} ${typeText(c)}`)
			]),
			...Arr.map([...state.enums], ([name, labels]) => `enum ${name}: ${Arr.join(labels, ", ")}`)
		],
		Order.String
	)

/** Each relation's rows in a model state, each row as its values' keys in the relation's field order. */
const rowsOf = (state: State, s: GenSchema): ReadonlyArray<string> =>
	Arr.sort(
		Arr.flatMap(s.relations, (r) => {
			const t = state.tables.get(identifierOf(identity.table(parsedName(r.name))))
			if (t === undefined) {
				throw new Error(`the table of ${r.name} is gone`)
			}
			return Arr.map(
				t.rows,
				(row) =>
					`${r.name}: ${Arr.join(
						Arr.map(r.columns, (c) => {
							const cell = row.get(identifierOf(identity.column(parsedName(c.name))))
							if (cell?.kind !== "value") {
								throw new Error(`${r.name}.${c.name} holds no value`)
							}
							return literalEqualityKey(cell.value)
						}),
						", "
					)}`
			)
		}),
		Order.String
	)

/** The rows an identity model expects, in the same form. */
const expectedRows = (facts: ValueFacts, s: GenSchema): ReadonlyArray<string> =>
	Arr.sort(
		Arr.flatMap(s.relations, (r) =>
			Arr.map(
				facts[r.name] ?? [],
				(row) => `${r.name}: ${Arr.join(Arr.map(row, literalEqualityKey), ", ")}`
			)
		),
		Order.String
	)

/** What a review reaches in either suite of this file: a placeholder in a commented alternative the review leaves, and
 * a placeholder of the SQL left unfilled. */
type ReviewFeature =
	| "a placeholder left in a commented alternative"
	| "a placeholder left unfilled refused"

const featureNames = [
	"a placeholder left in a commented alternative",
	"a placeholder left unfilled refused",
	"a candidate offered",
	"every candidate kept",
	"a field rename chosen",
	"a field rename chosen with its type changed",
	"a relation rename chosen",
	"the primary key's field renamed",
	"several candidates for one name",
	"names swapped, drafting no change",
	"a type changed in place",
	"a name renamed onto one the migration removes",
	"a relation rename chosen with a field retyped",
	"a relation rename chosen with its key changed",
	"a referenced key rebuilt in a chosen rename",
	"a relation removed",
	"a field's rename nested under two rival relation renames, one chosen",
	"a field dropped under two rival relation renames, written in under the chosen one",
	"two rival relation renames both chosen refused",
	"renamed back",
	"a rename back chosen"
] as const
type Feature = (typeof featureNames)[number]

/** What a reviewed step leaves: the model's state, and the folders committed so far. */
interface Applied {
	readonly state: State
	readonly folders: ReadonlyArray<Committed>
	readonly snapshot: DeploySnapshot
}

/** Checks one reviewed draft against (a) to (c) and returns the state it leaves, the reviewer writing `placeholder` at
 * each placeholder of the model.
 *
 * (a). The review fills every placeholder of the SQL, so a token it leaves is in a comment. */
const applyReviewed = (
	c: Case<ReviewFeature>,
	g: GenerateResult,
	chosen: ReadonlySet<Candidate>,
	state: State,
	placeholder: (p: Placeholder) => TypedLiteral,
	where: string
): Applied => {
	const reviewed = review(g, { chosen, losses: "written", value: sqlValue })
	if (Result.isFailure(reviewed)) {
		assert.fail(
			`${where}: a statement of ${reviewed.failure.file} that ${decisionText(new Set(reviewed.failure.candidates))}, all chosen, decide has no form for all of them`
		)
	}
	const files = reviewed.success.files
	if (Arr.some(files, (file) => Str.includes(placeholderToken)(file.text))) {
		c.note("a placeholder left in a commented alternative")
	}
	assert.deepEqual(
		Arr.flatMap(files, (file) =>
			Arr.map(
				findMarkers(`${file.text}/* ${placeholderToken} */\n`),
				(m) => `${file.name}:${m.line} ${m.kind}`
			)
		),
		[],
		`${where}: markers left`
	)
	/** With every placeholder of the SQL left unfilled, each behind a note of the reviewer's that a lone carriage return
	 * ends, exactly the lines that hold one are refused. */
	const left = leftUnfilled(g, chosen, reviewed.success)
	if (left.lines.length > 0) {
		c.note("a placeholder left unfilled refused")
	}
	const noted = Arr.map(left.files, (file) => ({
		name: file.name,
		text: Arr.join(
			Arr.map(Str.split(file.text, "\n"), (line, i) =>
				Arr.some(left.lines, (l) => l.file === file.name && l.line === i + 1)
					? `-- note\r${line}`
					: line
			),
			"\n"
		)
	}))
	assert.deepEqual(
		Arr.flatMap(noted, (file) =>
			Arr.map(findMarkers(file.text), (m) => `${file.name}:${m.line} ${m.kind}`)
		),
		Arr.map(left.lines, (l) => `${l.file}:${l.line} placeholder`),
		`${where}: the placeholders left unfilled`
	)
	/** A note of the reviewer's that a lone carriage return ends, before each statement, changes no statement check reads. */
	const prefaced = Arr.map(files, (file) => ({
		name: file.name,
		text: Arr.join(
			Arr.map(splitStatements(file.text), (s) => `-- note\r${s};`),
			"\n"
		)
	}))
	assert.deepEqual(
		statementsOf(prefaced),
		statementsOf(files),
		`${where}: a note before a statement changes it`
	)
	assert.deepEqual(readsBack(g, chosen, files), [], `${where}: the review reads back as made`)
	assert.deepEqual(readsBack(g, chosen, prefaced), [], `${where}: a note changes the decision read`)
	assert.deepEqual(
		statementsOf(files),
		statementsOf(
			Arr.map(reviewed.success.plan, (step) => ({ text: renderReviewed(step, sqlValue) }))
		),
		`${where}: the reviewed text is not the reviewed plan`
	)
	/** (c) */
	const after = interpret(schema, state, reviewed.success.plan, placeholder)
	if (Result.isFailure(after)) {
		assert.fail(
			`${where}: ${after.failure.file}, action ${after.failure.action}: ${after.failure.reason}`
		)
	}
	return { state: after.success, folders: [committed(g, files)], snapshot: g.snapshot }
}

/** (f): the draft of `s` once a step reached it changes nothing. */
const settled = (d: Drafter, s: Shape, step: Applied, where: string): void => {
	assert.equal(
		d.draft(s, step.snapshot).change,
		"none",
		`${where}: the draft after the migration changes something`
	)
}

/** The state a fresh install of `s` creates on the model. */
const fresh = (d: Drafter, s: Shape, placeholder: (p: Placeholder) => TypedLiteral): State => {
	const installed = interpret(schema, emptyState, plainPlan(d.first(s)), placeholder)
	if (Result.isFailure(installed)) {
		assert.fail(`a fresh install fails: ${installed.failure.reason}`)
	}
	return installed.success
}

const noteBox = (c: Case<Feature>, box: Box, g: GenerateResult) => {
	const offered = candidatesOf(g.plan)
	if (offered.length > 0) {
		c.note("a candidate offered")
	}
	if (Arr.some(offered, (x) => Arr.some(offered, (y) => x !== y && rivals(x, y)))) {
		c.note("several candidates for one name")
	}
	const moved = Arr.some(box.fates, (fate, i) => fate.kind === "to" && fate.at !== i)
	if (moved && g.change === "none") {
		c.note("names swapped, drafting no change")
	}
	if (
		Arr.some(box.fates, (fate, i) => fate.kind === "to" && fate.at === i && box.retyped[i] === true)
	) {
		c.note("a type changed in place")
	}
	if (
		Arr.some(
			box.fates,
			(fate, i) => fate.kind === "to" && fate.at !== i && fate.at < box.fates.length
		)
	) {
		c.note("a name renamed onto one the migration removes")
	}
	if (Arr.some(box.fates, (fate) => fate.kind === "removed")) {
		c.note("a relation removed")
	}
	const [first] = box.fates
	if (box.kind === "fields" && first?.kind === "to" && first.at !== 0) {
		c.note("the primary key's field renamed")
	}
}

/** Whether a relation candidate has a rival among the draft's. */
const rivalled = (offered: ReadonlyArray<Candidate>, c: Candidate): boolean =>
	Arr.some(offered, (x) => x !== c && x.kind === "relation" && rivals(x, c))

const noteChosen = (
	c: Case<Feature>,
	box: Box,
	g: GenerateResult,
	chosen: ReadonlySet<Candidate>
) => {
	const offered = candidatesOf(g.plan)
	if (offered.length > 0 && chosen.size === 0) {
		c.note("every candidate kept")
	}
	for (const x of chosen) {
		switch (x.kind) {
			case "relation":
				c.note("a relation rename chosen")
				if (retypes(g, x)) {
					c.note("a relation rename chosen with a field retyped")
				}
				if (box.keyed !== undefined && box.keyed.a !== box.keyed.b) {
					c.note("a relation rename chosen with its key changed")
				}
				if (rebuildsReference(g, x)) {
					c.note("a referenced key rebuilt in a chosen rename")
				}
				if (rivalled(offered, x) && dropsField(g, x)) {
					c.note(
						"a field dropped under two rival relation renames, written in under the chosen one"
					)
				}
				break
			case "nested field":
				if (rivalled(offered, x.parent)) {
					c.note("a field's rename nested under two rival relation renames, one chosen")
				}
				c.note(
					retypes(g, x) ? "a field rename chosen with its type changed" : "a field rename chosen"
				)
				break
			case "field":
				c.note(
					retypes(g, x) ? "a field rename chosen with its type changed" : "a field rename chosen"
				)
				break
			case "type":
			case "login":
				break
		}
	}
}

/** The record's candidate a plan candidate is, by path. */
const recordedAs = (g: GenerateResult, c: Candidate): ReadCandidate => {
	const path = pathOf(c)
	const [found] = Arr.filter(
		Arr.flatMap(g.record.candidates, (r): ReadonlyArray<ReadCandidate> =>
			r.kind === "relation" ? [r, ...r.fields] : [r]
		),
		(r) => samePath(r.path, path)
	)
	return defined(found, "the record's candidate of a plan candidate")
}

/** Two rival renames of one kind both chosen: the first's review, the second's head written in its file too, refused as
 * twice. Whether the draft offers two such rivals. */
const rivalsRefused = (g: GenerateResult, kind: "relation" | "type", where: string): boolean => {
	const offered = Arr.filter(candidatesOf(g.plan), (x) => x.kind === kind)
	const [pair] = Arr.flatMap(offered, (x) =>
		Arr.flatMap(offered, (y) => (y !== x && rivals(x, y) ? [[x, y] as const] : []))
	)
	if (pair === undefined) {
		return false
	}
	const [one, other] = pair
	const reviewed = succeeded(
		review(g, { chosen: new Set([one]), losses: "written", value: sqlValue })
	)
	const head = recordedAs(g, other)
	const files = Arr.map(reviewed.files, (file) =>
		file.name === head.file ? { name: file.name, text: `${file.text}\n${head.head.text};\n` } : file
	)
	assert.ok(
		Arr.some(splitRenames(g.record, files), (r) => r.kind === "twice"),
		`${where}: two rival ${kind} renames both chosen pass check`
	)
	return true
}

/** The rows a decision leaves by a case's model of identity: A's facts it loads (those whose carried forms B's laws
 * admit), and B's rows after the migration. */
interface Carried {
	readonly loaded: ValueFacts
	readonly expected: ValueFacts
}

/** What a suite notes of a case as the forward proof meets it: the draft, each decision, and two rivals both chosen
 * refused. */
interface Notes {
	readonly draft: (g: GenerateResult) => void
	readonly decision: (g: GenerateResult, chosen: ReadonlySet<Candidate>) => void
	readonly refused: () => void
}

/** Whether a case is renamed back too: forward only, or B renamed back to A, each review of the way back carried from
 * the rows the review there left, and noted. */
type Back =
	| { readonly kind: "forward" }
	| {
			readonly kind: "back"
			readonly carried: (chosen: ReadonlySet<Candidate>, there: ValueFacts) => Carried
			readonly note: (chosen: ReadonlySet<Candidate>) => void
	  }

/** A case as the forward proof reads it: its two versions; the rows each decision leaves by the case's model of
 * identity; the value a reviewer writes at each placeholder; the catalog a migration must leave as a fresh install
 * leaves it; the kind of root candidate whose two rivals both chosen are refused; what it notes; and whether it is
 * renamed back. */
interface Proved {
	readonly label: string
	readonly a: Shape
	readonly b: Shape
	readonly carried: (chosen: ReadonlySet<Candidate>) => Carried
	readonly placeholder: (p: Placeholder) => TypedLiteral
	readonly catalog: (state: State) => ReadonlyArray<string>
	readonly rivals: "relation" | "type"
	readonly notes: Notes
	readonly back: Back
}

/** The carry model of the drafted rules from `from` to `to`, the chosen candidates its renames. */
const carriedBy = (
	from: GenSchema,
	to: GenSchema,
	facts: ValueFacts,
	chosen: ReadonlySet<Candidate>
): Carried =>
	carry(
		versionOf(from, noExtras),
		versionOf(to, noExtras),
		facts,
		renamesOf(chosen, from, to),
		serialFields(versionOf(to, noExtras))
	)

/** The forward proof of one case: (a) to (f) for every review of A to B, and, for a case renamed back, for every review
 * of the way back from each. */
const forward = (c: Case<ReviewFeature>, p: Proved): void => {
	const d = new Drafter([p.a, p.b])
	const gA = d.first(p.a)
	const installedA = interpret(schema, emptyState, plainPlan(gA), p.placeholder)
	if (Result.isFailure(installedA)) {
		assert.fail(`${p.label}: installing A fails: ${installedA.failure.reason}`)
	}
	const gB = d.draft(p.b, gA.snapshot)
	assert.deepEqual(recordFaults(gB), [], `${p.label}: meta.json is the complete record`)
	p.notes.draft(gB)
	if (rivalsRefused(gB, p.rivals, p.label)) {
		p.notes.refused()
	}
	const freshB = p.catalog(fresh(d, p.b, p.placeholder))
	const freshA = p.back.kind === "back" ? p.catalog(fresh(d, p.a, p.placeholder)) : []
	for (const chosen of choosable(gB)) {
		p.notes.decision(gB, chosen)
		const where = `${p.label}, ${decisionText(chosen)}`
		/** A holds the facts whose carried forms B's laws admit under this review: a reference into a relation the review
		 * leaves empty would fail validation, a reviewed data step. */
		const model = p.carried(chosen)
		const start = loaded(installedA.success, p.a.schema, model.loaded)
		const step = applyReviewed(c, gB, chosen, start, p.placeholder, where)
		settled(d, p.b, step, where)
		assert.deepEqual(
			rowsOf(step.state, p.b.schema),
			expectedRows(model.expected, p.b.schema),
			`${where}: the rows are not the identity model's`
		)
		assert.deepEqual(
			p.catalog(step.state),
			freshB,
			`${where}: the catalog is not a fresh install's`
		)
		const way = p.back
		if (way.kind === "forward") {
			continue
		}
		const gBack = d.draft(p.a, step.snapshot)
		assert.deepEqual(
			recordFaults(gBack),
			[],
			`${where}: the way back's meta.json is the complete record`
		)
		for (const chosenBack of choosable(gBack)) {
			way.note(chosenBack)
			const there = `${where}, back ${decisionText(chosenBack)}`
			const stepBack = applyReviewed(c, gBack, chosenBack, step.state, p.placeholder, there)
			settled(d, p.a, stepBack, there)
			assert.deepEqual(
				p.catalog(stepBack.state),
				freshA,
				`${there}: the catalog is not a fresh install's of A`
			)
			assert.deepEqual(
				rowsOf(stepBack.state, p.a.schema),
				expectedRows(way.carried(chosenBack, model.expected).expected, p.a.schema),
				`${there}: the rows are not the identity model's`
			)
		}
	}
}

/** The box: every case of one or two names forward, and those of one name renamed back too. */
const names: Arr.NonEmptyReadonlyArray<number> = [1, 2]
const namesBack = 1

/** A case of the first box as the forward proof reads it: the carry model its model of identity, its tables and
 * columns compared, and renamed back when it is of one name, not of the keyed kind. */
const boxProved = (c: Case<Feature>, box: Box): Proved => {
	const facts = factsOf(box)
	return {
		label: printBox(box),
		a: described(box.a),
		b: described(box.b),
		carried: (chosen) => carriedBy(box.a, box.b, facts, chosen),
		placeholder: literalValue,
		catalog: shapeOf,
		rivals: "relation",
		notes: {
			draft: (g) => noteBox(c, box, g),
			decision: (g, chosen) => noteChosen(c, box, g, chosen),
			refused: () => c.note("two rival relation renames both chosen refused")
		},
		back:
			box.kind !== "keyed" && box.fates.length <= namesBack
				? {
						kind: "back",
						carried: (chosen, there) => carriedBy(box.b, box.a, there, chosen),
						note: (chosen) => {
							c.note("renamed back")
							if (chosen.size > 0) {
								c.note("a rename back chosen")
							}
						}
					}
				: { kind: "forward" }
	}
}

const prove = () =>
	exhaust(
		{
			suite: "unit/deploy/renames-full",
			generator: boxesUpTo(names),
			literal: Formatter.format,
			limit: 4_000,
			coverage: requiredInSpace<Feature>(featureNames),
			caseHang
		},
		(box, c) => Effect.sync(() => forward(c, boxProved(c, box)))
	)

/** Closed rosters: every roster of one to three handles from a pool, changed into every other. The documented rule decides
 * each change: a roster renamed in place (as many handles, each that differs absent from the other roster) is drafted
 * as RENAME VALUE, whose marker the reviewer confirms; handles added with every old one kept in order are drafted as
 * ADD VALUE in a no-transaction file; any other change removes or reorders handles, which rebuilds the enum in one
 * Structure transaction under a marker the reviewer confirms, each removed handle mapped by the reviewer, here to the
 * new roster's first. A row holding a renamed handle then holds its new name, one holding a removed handle the mapped
 * one, the labels end in the new roster's order, the catalog is a fresh install's, and the next draft is no change.
 * Where the two rosters share a handle, a relation Child is contained in the Item rows that select it, so the rebuild
 * meets a stored tag of the enum and a foreign key over it. */
type RosterChange =
	| { readonly kind: "same" }
	| { readonly kind: "renamed"; readonly renames: ReadonlyArray<string> }
	| { readonly kind: "added"; readonly labels: ReadonlyArray<string> }
	| { readonly kind: "rebuilt"; readonly removed: ReadonlyArray<string> }

const rosterChange = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): RosterChange => {
	if (a.length === b.length && Arr.every(a, (h, i) => h === b[i])) {
		return { kind: "same" }
	}
	if (
		a.length === b.length &&
		Arr.every(a, (h, i) => h === b[i] || (!b.includes(h) && !a.includes(b[i] ?? h)))
	) {
		return {
			kind: "renamed",
			renames: Arr.sort(
				Arr.flatMap(a, (h, i) => (b[i] === undefined || b[i] === h ? [] : [`${h} → ${b[i]}`])),
				Order.String
			)
		}
	}
	let kept = 0
	for (const h of b) {
		if (h === a[kept]) {
			kept++
		}
	}
	if (kept === a.length && b.length > a.length) {
		return {
			kind: "added",
			labels: Arr.sort(
				Arr.filter(b, (h) => !a.includes(h)),
				Order.String
			)
		}
	}
	return { kind: "rebuilt", removed: Arr.filter(a, (h) => !b.includes(h)) }
}

const handlePool = ["a", "b", "c", "d"] as const

/** Every roster of one to three distinct handles from the first `pool` handles. */
const rosters = (pool: number): Gen<ReadonlyArray<string>> =>
	map(shuffled(indices(pool), { min: 1, max: 3 }), (xs) =>
		Arr.map(xs, (x) => nameAt(handlePool, x))
	)

/**
 * A closed relation Level of the given handles, and a relation Item a field of which it types; with a `selected`
 * handle, a relation Child contained in the Item rows that hold it, which Child carries as a constant law column, and a
 * row check
 * of Item that names the handle, which holds of every row.
 */
const rosterDesc = (
	handles: ReadonlyArray<string>,
	selected: Option.Option<string>
): SchemaDesc => ({
	name: schemaName,
	relations: [
		closed("Level", handles),
		relation("Item", { id: f.uuid, level: f.closedId("Level") }, ["id"]),
		...(Option.isSome(selected) ? [relation("Child", { id: f.uuid }, ["id"])] : [])
	],
	statements: Option.match(selected, {
		onNone: () => [],
		onSome: (handle) => [
			contained(on("Child", ["id"]), onWhere("Item", ["id"], eq(field("level"), literal(handle)))),
			{
				kind: "check" as const,
				name: "Known",
				relation: "Item",
				predicate: {
					kind: "or" as const,
					args: [
						{
							kind: "compare" as const,
							op: "eq" as const,
							left: { kind: "field" as const, field: "level" },
							right: { kind: "literal" as const, value: handle, type: undefined }
						},
						{
							kind: "compare" as const,
							op: "ne" as const,
							left: { kind: "field" as const, field: "level" },
							right: { kind: "literal" as const, value: handle, type: undefined }
						}
					] as const
				}
			}
		]
	}),
	extends: undefined
})

const rosterFeatures = [
	"a placeholder left unfilled refused",
	"no change",
	"a handle renamed in place",
	"handles added",
	"handles reordered, rebuilt",
	"handles removed, rebuilt",
	"a rebuild around a stored tag, its foreign key and a row check"
] as const
type RosterFeature = (typeof rosterFeatures)[number] | ReviewFeature

/** The draft of a roster schema at step `at`: the first from the empty snapshot, or one after `previous`. */
const firstDraft = (desc: SchemaDesc, at: number) =>
	generate({
		installation: compile(desc, asDrafted),
		name: `roster_${at}`,
		timestamp: `2026101500000${at}`,
		previous: fromEmpty,
		workload: noWorkload
	})

const draftDesc = (desc: SchemaDesc, at: number, previous: DeploySnapshot) =>
	generate({
		previous: fromSnapshot(previous),
		installation: compile(desc, asDrafted),
		name: `roster_${at}`,
		timestamp: `2026101500000${at}`,
		workload: noWorkload
	})

const roster = (
	c: Case<RosterFeature>,
	[a, b]: readonly [ReadonlyArray<string>, ReadonlyArray<string>]
) => {
	const where = `[${Arr.join(a, ", ")}] to [${Arr.join(b, ", ")}]`
	const expected = rosterChange(a, b)
	/** A handle both rosters have, which Child's containment selects. */
	const selected = Arr.findFirst(a, (h) => b.includes(h))
	const gA = succeeded(firstDraft(rosterDesc(a, selected), 1))
	const installed = interpret(schema, emptyState, plainPlan(gA), literalValue)
	if (Result.isFailure(installed)) {
		assert.fail(`${where}: installing A fails: ${installed.failure.reason}`)
	}
	const first = nameAt(a, 0)
	const start = load(installed.success, identifierOf(identity.table(parsedName("Item"))), [
		new Map<string, TypedLiteral>([
			[
				identifierOf(identity.column(parsedName("id"))),
				{ kind: "uuid", value: "00000000-0000-4000-8000-000000000001" }
			],
			[identifierOf(identity.column(parsedName("level"))), { kind: "enum", handle: first }]
		])
	])
	const drafted = draftDesc(rosterDesc(b, selected), 2, gA.snapshot)
	if (!drafted.ok) {
		assert.fail(`${where}: refused: ${drafted.error.message}`)
	}
	const gB = drafted.value
	const statements = planStatements(gB.plan)
	const renames: ReadonlyArray<string> = Arr.sort(
		Arr.flatMap(statements, (x) =>
			x.kind === "alterEnumRenameValue" ? [`${x.from} → ${x.to}`] : []
		),
		Order.String
	)
	const labels: ReadonlyArray<string> = Arr.sort(
		Arr.flatMap(statements, (x) => (x.kind === "alterEnumAddValue" ? [x.label] : [])),
		Order.String
	)
	switch (expected.kind) {
		case "same":
			c.note("no change")
			assert.equal(gB.change, "none", `${where}: a change`)
			return
		case "renamed":
			c.note("a handle renamed in place")
			assert.deepEqual(renames, expected.renames, `${where}: the handles renamed`)
			assert.deepEqual(labels, [], `${where}: labels added`)
			break
		case "added":
			c.note("handles added")
			assert.deepEqual(labels, expected.labels, `${where}: the labels added`)
			assert.deepEqual(renames, [], `${where}: handles renamed`)
			{
				const adding = Arr.filter(draftFiles(gB), (file) =>
					Arr.some(
						file.drafts,
						(d) => d.kind === "statement" && d.statement.kind === "alterEnumAddValue"
					)
				)
				assert.ok(
					adding.length > 0 && Arr.every(adding, (file) => !file.transaction),
					`${where}: the labels are added outside a transaction`
				)
			}
			break
		case "rebuilt": {
			c.note(
				expected.removed.length === 0 ? "handles reordered, rebuilt" : "handles removed, rebuilt"
			)
			if (Option.isSome(selected)) {
				c.note("a rebuild around a stored tag, its foreign key and a row check")
			}
			assert.deepEqual(renames, [], `${where}: handles renamed`)
			assert.deepEqual(labels, [], `${where}: labels added`)
			/** A rebuild is the plan's confirmed new enum, never read off the name it is allocated. */
			const rebuilt = Arr.filter(
				gB.plan.steps,
				(x) => x.draft.kind === "confirm" && Arr.some(x.draft.keep, (k) => k.kind === "createEnum")
			)
			assert.equal(rebuilt.length, 1, `${where}: one rebuilt type`)
			/** The rebuild runs in one transaction. */
			const rebuilding = Arr.filter(draftFiles(gB), (file) =>
				Arr.some(
					file.drafts,
					(d) => d.kind === "confirm" && Arr.some(d.keep, (k) => k.kind === "createEnum")
				)
			)
			assert.ok(
				rebuilding.length === 1 && Arr.every(rebuilding, (file) => file.transaction),
				`${where}: the rebuild runs in one transaction`
			)
			break
		}
	}
	const step = applyReviewed(c, gB, new Set<Candidate>(), start, literalValue, where)
	/** A renamed handle takes its new name, and a removed one the reviewer's mapping, the new roster's first. */
	const renamedFirst =
		expected.kind === "renamed"
			? (b[a.indexOf(first)] ?? first)
			: expected.kind === "rebuilt" && !b.includes(first)
				? nameAt(b, 0)
				: first
	const item = step.state.tables.get(identifierOf(identity.table(parsedName("Item"))))
	const levels =
		item === undefined
			? undefined
			: Arr.map(item.rows, (row) => row.get(identifierOf(identity.column(parsedName("level")))))
	assert.deepEqual(
		levels,
		[{ kind: "value", value: { kind: "enum", handle: renamedFirst } }],
		`${where}: the row's handle`
	)
	assert.deepEqual(
		step.state.enums.get(identifierOf(identity.enumType(parsedName("Level")))),
		b,
		`${where}: the labels in order`
	)
	assert.deepEqual(
		shapeOf(step.state),
		shapeOf(freshDesc(rosterDesc(b, selected))),
		`${where}: the catalog is not a fresh install's`
	)
	const again = succeeded(draftDesc(rosterDesc(b, selected), 3, gB.snapshot))
	assert.equal(again.change, "none", `${where}: the draft after it is a change`)
}

const freshDesc = (desc: SchemaDesc): State => {
	const installed = interpret(
		schema,
		emptyState,
		plainPlan(succeeded(firstDraft(desc, 4))),
		literalValue
	)
	if (Result.isFailure(installed)) {
		assert.fail(`a fresh install fails: ${installed.failure.reason}`)
	}
	return installed.success
}

const proveRosters = (pool: number) =>
	exhaust(
		{
			suite: `unit/deploy/renames-rosters-${pool}`,
			generator: (source) => [source.draw(rosters(pool)), source.draw(rosters(pool))] as const,
			literal: Formatter.format,
			limit: 2_000,
			coverage: requiredInSpace<RosterFeature>(rosterFeatures),
			caseHang
		},
		(x, c) => Effect.sync(() => roster(c, x))
	)

/** The bounded migration matrix: a box per candidate kind beyond the first box's, of one or two objects of the kind in
 * A, each renamed into a pool twice their number, kept in place, or removed in B (injectionsOrRemoved). */
const matrix: Arr.NonEmptyReadonlyArray<number> = [1, 2]

/** Every box of one kind, of one or two objects. */
const upTo = <A>(box: (k: number) => Gen<A>): Gen<A> => oneOf(Arr.map(matrix, (k) => box(k)))

/** Each object's fate in B, from its name in A, by the pool both are drawn from. */
const fatesText = (
	pool: ReadonlyArray<string>,
	fates: ReadonlyArray<Fate>,
	more: (i: number) => string
): string =>
	Arr.join(
		Arr.map(
			fates,
			(fate, i) =>
				`${nameAt(pool, i)}→${fate.kind === "removed" ? "removed" : nameAt(pool, fate.at)}${more(i)}`
		),
		", "
	)

/** The arm a box draws for its object at `i`, one per object. */
const armAt = <A>(arms: ReadonlyArray<A>, i: number): A =>
	defined(arms[i], "an arm for each object of the box")

/** Whether an object of a box is renamed onto the name of another of A, which the migration removes or renames away. */
const ontoRemoved = (fates: ReadonlyArray<Fate>): boolean =>
	Arr.some(fates, (fate, i) => fate.kind === "to" && fate.at !== i && fate.at < fates.length)

const removedAny = (fates: ReadonlyArray<Fate>): boolean =>
	Arr.some(fates, (fate) => fate.kind === "removed")

/** Whether a draft offers two rival candidates of a kind. */
const rivalsOffered = (g: GenerateResult, kind: Candidate["kind"]): boolean => {
	const offered = Arr.filter(candidatesOf(g.plan), (x) => x.kind === kind)
	return Arr.some(offered, (x) => Arr.some(offered, (y) => x !== y && rivals(x, y)))
}

/** The type candidates a draft offers. */
const typeCandidates = (g: GenerateResult): ReadonlyArray<Candidate> =>
	Arr.filter(candidatesOf(g.plan), (x) => x.kind === "type")

const closedPool = ["Kappa", "Lambda", "Mu", "Nu"] as const

/** What B makes of a closed relation's roster: kept, its last handle renamed in place, its two handles reordered, or its
 * last handle removed. */
type RosterFate = "kept" | "renamed" | "reordered" | "shrunk"

/** One case of the closed box: up to two closed relations, each typing its own field `k<i>` of Holder by its place in A;
 * where B takes each; what B makes of each roster; and whether A's closed relations hold one roster or each its own. */
interface ClosedBox {
	readonly fates: ReadonlyArray<Fate>
	readonly rosters: ReadonlyArray<RosterFate>
	readonly shared: boolean
}

const closedBoxes =
	(k: number): Gen<ClosedBox> =>
	(source) => ({
		fates: source.draw(injectionsOrRemoved(k)),
		rosters: source.draw(
			array(element<RosterFate>(["kept", "renamed", "reordered", "shrunk"]), { min: k, max: k })
		),
		shared: k > 1 && source.draw(boolean)
	})

/** Closed relation `i`'s roster in A: two handles, one roster for every closed relation when they share it. */
const rosterIn = (box: ClosedBox, i: number): readonly [string, string] =>
	box.shared || i === 0 ? ["a", "b"] : ["c", "d"]

const rosterFate = (box: ClosedBox, i: number): RosterFate =>
	defined(box.rosters[i], "a roster's fate for each closed relation")

/** Closed relation `i`'s roster in B: a renamed handle takes a name of its own, which no roster of A holds. */
const rosterOut = (box: ClosedBox, i: number): Arr.NonEmptyReadonlyArray<string> => {
	const [first, last] = rosterIn(box, i)
	switch (rosterFate(box, i)) {
		case "kept":
			return [first, last]
		case "renamed":
			return [first, `${last}${i}`]
		case "reordered":
			return [last, first]
		case "shrunk":
			return [first]
	}
}

/** The handle Holder's row holds in B in the field of closed relation `i`: the last handle of its roster in A, by its
 * identity, under its new name where it is renamed in place, and where it is removed, the reviewer's mapping, the
 * roster's first. */
const heldHandle = (box: ClosedBox, i: number): string => {
	const [first, last] = rosterIn(box, i)
	switch (rosterFate(box, i)) {
		case "kept":
		case "reordered":
			return last
		case "renamed":
			return `${last}${i}`
		case "shrunk":
			return first
	}
}

/** The enum type of a closed relation of the given handles. */
const enumOf = (name: string, handles: Arr.NonEmptyReadonlyArray<string>): ScalarType =>
	scalarOfSpec({ carrier: "enum", roster: { closed: name, handles } })

/** A version of the closed box: each closed relation under its name with its roster, and Holder, keyed by `id`, with each
 * one's field. */
const closedShape = (box: ClosedBox, after: boolean): Shape => {
	const held = Arr.flatMap(
		box.fates,
		(
			fate,
			i
		): ReadonlyArray<{
			readonly origin: number
			readonly name: string
			readonly handles: Arr.NonEmptyReadonlyArray<string>
		}> =>
			!after
				? [{ origin: i, name: nameAt(closedPool, i), handles: rosterIn(box, i) }]
				: fate.kind === "removed"
					? []
					: [{ origin: i, name: nameAt(closedPool, fate.at), handles: rosterOut(box, i) }]
	)
	return described({
		name: schemaName,
		relations: [
			{
				name: "Holder",
				columns: [
					{ name: "id", type: int8 },
					...Arr.map(held, (x) => ({ name: `k${x.origin}`, type: enumOf(x.name, x.handles) }))
				],
				primaryKey: ["id"],
				keys: [],
				mutable: false
			}
		],
		closed: Arr.map(held, (x) => ({ name: x.name, handles: x.handles, payload: [], rows: [] })),
		containments: []
	})
}

/** Holder's one row in A: each field holds its closed relation's last handle. */
const closedFacts = (box: ClosedBox): ValueFacts => ({
	Holder: [
		[
			{ kind: "int", value: 1000n },
			...Arr.map(box.fates, (_, i): TypedLiteral => ({ kind: "enum", handle: rosterIn(box, i)[1] }))
		]
	]
})

/** Holder's row in B by each handle's identity (heldHandle), whichever way each candidate is decided. */
const closedRows = (box: ClosedBox): ValueFacts => ({
	Holder: [
		[
			{ kind: "int", value: 1000n },
			...Arr.flatMap(box.fates, (fate, i): ReadonlyArray<TypedLiteral> =>
				fate.kind === "removed" ? [] : [{ kind: "enum", handle: heldHandle(box, i) }]
			)
		]
	]
})

/** What the reviewer writes at the closed box's placeholders: at a field converted to another closed relation's type, its
 * handle by identity (heldHandle); at a rebuilt roster's removed handle, the new roster's first. */
const closedValue =
	(box: ClosedBox) =>
	(p: Placeholder): TypedLiteral => {
		switch (p.kind) {
			case "placeholderHandles":
				return { kind: "enum", handle: p.labels[0] }
			case "placeholderRetype": {
				const [at] = Arr.filter(
					indices(box.fates.length),
					(i) => identifierOf(identity.column(parsedName(`k${i}`))) === p.column.name
				)
				return {
					kind: "enum",
					handle: heldHandle(box, defined(at, `the field of the column ${p.column.name}`))
				}
			}
			case "placeholderColumn":
				throw new Error(
					`the closed box adds no field, yet a draft adds the column ${p.column.name}`
				)
		}
	}

/** Whether the documented rule refuses B: "a field whose type moves from one closed relation to another while the
 * handles of both are removed or reordered" stops the draft (SKILL.md, Renames), each closed relation's roster compared
 * by its name, as the draft compares it. */
const closedRefused = (box: ClosedBox): boolean => {
	const before = new Map(
		Arr.map(box.fates, (_, i) => [nameAt(closedPool, i), rosterIn(box, i)] as const)
	)
	const after = new Map(
		Arr.flatMap(box.fates, (fate, i) =>
			fate.kind === "removed" ? [] : [[nameAt(closedPool, fate.at), rosterOut(box, i)] as const]
		)
	)
	const rebuilt = (name: string): boolean => {
		const was = before.get(name)
		const now = after.get(name)
		return was !== undefined && now !== undefined && rosterChange(was, now).kind === "rebuilt"
	}
	return Arr.some(
		box.fates,
		(fate, i) =>
			fate.kind === "to" &&
			fate.at !== i &&
			rebuilt(nameAt(closedPool, i)) &&
			rebuilt(nameAt(closedPool, fate.at))
	)
}

/** Whether a draft confirms a group holding a statement of the kind: a handle renamed in place, or a rebuilt enum. */
const confirms = (g: GenerateResult, kind: "alterEnumRenameValue" | "createEnum"): boolean =>
	Arr.some(
		g.plan.steps,
		(s) => s.draft.kind === "confirm" && Arr.some(s.draft.keep, (k) => k.kind === kind)
	)

const closedFeatures = [
	"a placeholder left unfilled refused",
	"a closed relation's rename chosen",
	"a closed relation's rename kept, its field converted",
	"two closed relations rival for one name",
	"two rival closed renames both chosen refused",
	"a handle renamed in place, confirmed",
	"a roster rebuilt, confirmed",
	"a removed handle mapped",
	"a closed relation renamed onto one the migration removes",
	"a closed relation removed",
	"a field moving between two rebuilt closed relations refused"
] as const
type ClosedFeature = (typeof closedFeatures)[number] | ReviewFeature

const closedProved = (c: Case<ClosedFeature>, box: ClosedBox): Proved => {
	const facts = closedFacts(box)
	const rows = closedRows(box)
	return {
		label: `closed${box.shared ? ", one roster" : ""}: ${fatesText(closedPool, box.fates, (i) => ` roster ${rosterFate(box, i)}`)}`,
		a: closedShape(box, false),
		b: closedShape(box, true),
		carried: () => ({ loaded: facts, expected: rows }),
		placeholder: closedValue(box),
		catalog: catalogOf,
		rivals: "type",
		notes: {
			draft: (g) => {
				if (confirms(g, "alterEnumRenameValue")) {
					c.note("a handle renamed in place, confirmed")
				}
				if (confirms(g, "createEnum")) {
					c.note("a roster rebuilt, confirmed")
				}
				if (
					Arr.some(g.plan.steps, (s) =>
						Arr.some(draftActions(s.draft), (x) => x.kind === "placeholderHandles")
					)
				) {
					c.note("a removed handle mapped")
				}
				if (rivalsOffered(g, "type")) {
					c.note("two closed relations rival for one name")
				}
				if (ontoRemoved(box.fates)) {
					c.note("a closed relation renamed onto one the migration removes")
				}
				if (removedAny(box.fates)) {
					c.note("a closed relation removed")
				}
			},
			decision: (g, chosen) => {
				const offered = typeCandidates(g)
				if (Arr.some(offered, (x) => chosen.has(x))) {
					c.note("a closed relation's rename chosen")
				}
				if (Arr.some(offered, (x) => !chosen.has(x))) {
					c.note("a closed relation's rename kept, its field converted")
				}
			},
			refused: () => c.note("two rival closed renames both chosen refused")
		},
		back: { kind: "forward" }
	}
}

/** A case of the closed box: refused where the documented rule refuses it, else proved forward. */
const closedCase = (c: Case<ClosedFeature>, box: ClosedBox): void => {
	const p = closedProved(c, box)
	if (!closedRefused(box)) {
		forward(c, p)
		return
	}
	const d = new Drafter([p.a, p.b])
	refused(
		d.attempt(p.b, d.first(p.a).snapshot),
		"UnsupportedOperation",
		`${p.label}: a field moving between two rebuilt closed relations is drafted`
	)
	c.note("a field moving between two rebuilt closed relations refused")
}

const contractPool = ["Cap", "Lim", "Quo", "Tally"] as const

/** What B makes of a name a box does not rename as a candidate: kept, or renamed. */
type FieldFate = "kept" | "renamed"

/** What B makes of a contract's predicate: kept, or its least value lowered. */
type PredicateFate = "kept" | "changed"

/** One case of the contracts box: up to two contracts over bigint, each typing its own field `c<i>` of Holder by its
 * place in A; where B takes each, its field then plain bigint where B removes it; whether B renames each field to
 * `d<i>`; what B makes of each predicate; and whether A's contracts share one predicate or each has its own. */
interface ContractBox {
	readonly fates: ReadonlyArray<Fate>
	readonly fields: ReadonlyArray<FieldFate>
	readonly predicates: ReadonlyArray<PredicateFate>
	readonly shared: boolean
}

const contractBoxes =
	(k: number): Gen<ContractBox> =>
	(source) => ({
		fates: source.draw(injectionsOrRemoved(k)),
		fields: source.draw(array(element<FieldFate>(["kept", "renamed"]), { min: k, max: k })),
		predicates: source.draw(array(element<PredicateFate>(["kept", "changed"]), { min: k, max: k })),
		shared: k > 1 && source.draw(boolean)
	})

/** Contract `i`'s least value: one for every contract of A when they share their predicate, else one each; B's changed
 * predicate lowers it, so the stored values and bigint's typed default hold under every bound of the box. */
const leastOf = (box: ContractBox, i: number, after: boolean): bigint =>
	(box.shared ? -1n : -1n - BigInt(i)) - (after && box.predicates[i] === "changed" ? 10n : 0n)

/** The contract over bigint of the given name, its values at least `least`. */
const contractOver = (name: string, least: bigint): FieldDesc =>
	f.contract(name, f.bigint, ge(value, literal(least)))

/** A version of the contracts box: Holder, keyed by `id`, with each contract's field. The carry model reads every field
 * as bigint, the base each contract converts to and from by its cast. */
const contractShape = (box: ContractBox, after: boolean): Shape => {
	const fields = Arr.map(box.fates, (fate, i) => ({
		name: after && box.fields[i] === "renamed" ? `d${i}` : `c${i}`,
		desc: !after
			? contractOver(nameAt(contractPool, i), leastOf(box, i, false))
			: fate.kind === "removed"
				? f.bigint
				: contractOver(nameAt(contractPool, fate.at), leastOf(box, i, true))
	}))
	return {
		schema: {
			name: schemaName,
			relations: [
				{
					name: "Holder",
					columns: [
						{ name: "id", type: int8 },
						...Arr.map(fields, (x) => ({ name: x.name, type: int8 }))
					],
					primaryKey: ["id"],
					keys: [],
					mutable: false
				}
			],
			closed: [],
			containments: []
		},
		installs: {
			kind: "described",
			desc: {
				name: schemaName,
				relations: [
					relation(
						"Holder",
						{
							id: f.bigint,
							...Rec.fromEntries(Arr.map(fields, (x) => [x.name, x.desc] as const))
						},
						["id"]
					)
				],
				statements: [],
				extends: undefined
			}
		}
	}
}

/** What the reviewer writes at a placeholder of the contracts box: every column is bigint or a contract over it, and
 * bigint's typed default holds under every bound of the box. */
const contractValue = (p: Placeholder): TypedLiteral => {
	if (p.kind === "placeholderHandles") {
		throw new Error("the contracts box changes no roster")
	}
	return typedDefault(int8)
}

const contractFeatures = [
	"a placeholder left unfilled refused",
	"a contract's rename chosen",
	"a contract's rename kept, its field converted by its cast",
	"a field's rename chosen with the contract's rename it requires",
	"two contracts rival for one name",
	"two rival contract renames both chosen refused",
	"a contract's predicate changed in place",
	"a contract renamed onto one the migration removes",
	"a contract removed, its field kept as its base"
] as const
type ContractFeature = (typeof contractFeatures)[number] | ReviewFeature

const contractProved = (c: Case<ContractFeature>, box: ContractBox): Proved => {
	const a = contractShape(box, false)
	const b = contractShape(box, true)
	const facts = distinctFacts(a.schema)
	return {
		label: `contracts${box.shared ? ", one predicate" : ""}: ${fatesText(contractPool, box.fates, (i) => ` field ${armAt(box.fields, i)}, predicate ${armAt(box.predicates, i)}`)}`,
		a,
		b,
		carried: (chosen) => carriedBy(a.schema, b.schema, facts, chosen),
		placeholder: contractValue,
		catalog: catalogOf,
		rivals: "type",
		notes: {
			draft: (g) => {
				if (rivalsOffered(g, "type")) {
					c.note("two contracts rival for one name")
				}
				if (
					Arr.some(
						box.fates,
						(fate, i) => fate.kind === "to" && fate.at === i && box.predicates[i] === "changed"
					)
				) {
					c.note("a contract's predicate changed in place")
				}
				if (ontoRemoved(box.fates)) {
					c.note("a contract renamed onto one the migration removes")
				}
				if (removedAny(box.fates)) {
					c.note("a contract removed, its field kept as its base")
				}
			},
			decision: (g, chosen) => {
				const offered = typeCandidates(g)
				if (Arr.some(offered, (x) => chosen.has(x))) {
					c.note("a contract's rename chosen")
				}
				if (Arr.some(offered, (x) => !chosen.has(x))) {
					c.note("a contract's rename kept, its field converted by its cast")
				}
				if (
					Arr.some(
						[...chosen],
						(x) => (x.kind === "field" || x.kind === "nested field") && x.requires.kind === "type"
					)
				) {
					c.note("a field's rename chosen with the contract's rename it requires")
				}
			},
			refused: () => c.note("two rival contract renames both chosen refused")
		},
		back: { kind: "forward" }
	}
}

/** A relation of the relations box by its place in A: its name, and its payload field, if it has one. */
interface Placed {
	readonly origin: number
	readonly name: string
	readonly payload: { readonly name: string; readonly type: ScalarType } | undefined
}

/** The relations box's relations of A, by their place, each with its payload field `v`. */
const relationsIn = (k: number): ReadonlyArray<Placed> =>
	Arr.map(indices(k), (i) => ({
		origin: i,
		name: nameAt(relationPool, i),
		payload: { name: "v", type: types[0] }
	}))

/** The relations box's relations of B, by their place in A: each where its fate takes it, with its payload kept as `v`,
 * renamed to `w`, or dropped. */
const relationsOut = (
	fates: ReadonlyArray<Fate>,
	payloads: ReadonlyArray<Payload>
): ReadonlyArray<Placed> =>
	Arr.flatMap(fates, (fate, i): ReadonlyArray<Placed> => {
		if (fate.kind === "removed") {
			return []
		}
		const payload = defined(payloads[i], "a payload for each relation")
		return [
			{
				origin: i,
				name: nameAt(relationPool, fate.at),
				payload:
					payload === "dropped"
						? undefined
						: { name: payload === "kept" ? "v" : "w", type: types[0] }
			}
		]
	})

/** One case of the indexes box: the relations box's relations without retypes, each payload under an index. */
interface IndexBox {
	readonly fates: ReadonlyArray<Fate>
	readonly payloads: ReadonlyArray<Payload>
}

const indexBoxes =
	(k: number): Gen<IndexBox> =>
	(source) => ({
		fates: source.draw(injectionsOrRemoved(k)),
		payloads: source.draw(array(payloadGen, { min: k, max: k }))
	})

/** A version of the indexes box: the relations, and Target, keyed by `id`, which each relation's payload names at most
 * once, a capacity of at most one whose unique index is over the payload. */
const indexShape = (relations: ReadonlyArray<Placed>): Shape => {
	const base = relationsSchema(relations)
	const schema: GenSchema = {
		...base,
		relations: [
			...base.relations,
			{
				name: "Target",
				columns: [{ name: "id", type: types[0] }],
				primaryKey: ["id"],
				keys: [],
				mutable: false
			}
		]
	}
	const desc = versionOf(schema, noExtras).desc
	return {
		schema,
		installs: {
			kind: "described",
			desc: {
				...desc,
				statements: [
					...desc.statements,
					...Arr.flatMap(relations, (r) =>
						r.payload === undefined
							? []
							: [
									capacity(on("Target", ["id"]), on(r.name, [r.payload.name]), within(0n, 1n), {
										kind: "count"
									})
								]
					)
				]
			}
		}
	}
}

const indexFeatures = [
	"a placeholder left unfilled refused",
	"a relation rename chosen over its index",
	"a field's nested rename chosen under its index",
	"an index dropped with its field",
	"two rival relation renames, each with its index",
	"two rival relation renames both chosen refused",
	"a relation removed with its index"
] as const
type IndexFeature = (typeof indexFeatures)[number] | ReviewFeature

/** Whether a version's relation of the table `table` holds a payload, and so an index. */
const indexedAt = (s: GenSchema, table: string): boolean =>
	Arr.some(
		s.relations,
		(r) =>
			r.name !== "Anchor" &&
			r.columns.length > 1 &&
			identifierOf(identity.table(parsedName(r.name))) === table
	)

const indexProved = (c: Case<IndexFeature>, box: IndexBox): Proved => {
	const a = indexShape(relationsIn(box.fates.length))
	const b = indexShape(relationsOut(box.fates, box.payloads))
	const facts = distinctFacts(a.schema)
	return {
		label: `indexes: ${fatesText(relationPool, box.fates, (i) => ` payload ${armAt(box.payloads, i)}`)}`,
		a,
		b,
		carried: (chosen) => carriedBy(a.schema, b.schema, facts, chosen),
		placeholder: literalValue,
		catalog: catalogOf,
		rivals: "relation",
		notes: {
			draft: (g) => {
				if (rivalsOffered(g, "relation")) {
					c.note("two rival relation renames, each with its index")
				}
				if (Arr.some(box.fates, (fate, i) => fate.kind === "to" && box.payloads[i] === "dropped")) {
					c.note("an index dropped with its field")
				}
				if (removedAny(box.fates)) {
					c.note("a relation removed with its index")
				}
			},
			decision: (_, chosen) => {
				for (const x of chosen) {
					if (x.kind === "relation" && indexedAt(b.schema, x.added.name)) {
						c.note("a relation rename chosen over its index")
					}
					if (x.kind === "nested field") {
						c.note("a field's nested rename chosen under its index")
					}
				}
			},
			refused: () => c.note("two rival relation renames both chosen refused")
		},
		back: { kind: "forward" }
	}
}

const contextPool = ["Session", "Caller"] as const

/** One case of the contexts box: the relations box's relations, each payload kept or renamed, under a world. The login
 * `app` holds the role `reader`, which holds Anchor whole and, for each relation, the entry `Seen<i>` of its rows whose
 * `id` is a field of the context: every entry reads one field, or each its own. B renames each field read or keeps it,
 * and renames the context or keeps it. */
interface ContextBox {
	readonly fates: ReadonlyArray<Fate>
	readonly payloads: ReadonlyArray<FieldFate>
	readonly shared: boolean
	readonly claims: ReadonlyArray<FieldFate>
	readonly context: FieldFate
}

const contextBoxes =
	(k: number): Gen<ContextBox> =>
	(source) => {
		const shared = k > 1 && source.draw(boolean)
		const read = shared ? 1 : k
		return {
			fates: source.draw(injectionsOrRemoved(k)),
			payloads: source.draw(array(element<FieldFate>(["kept", "renamed"]), { min: k, max: k })),
			shared,
			claims: source.draw(array(element<FieldFate>(["kept", "renamed"]), { min: read, max: read })),
			context: source.draw(element<FieldFate>(["kept", "renamed"]))
		}
	}

/** The context's fields: `c`, which every entry reads, or `c<i>`, which the entry over relation `i` reads; each renamed
 * in B to `d` or `d<i>`. */
const claimNames = (box: ContextBox, after: boolean): Arr.NonEmptyReadonlyArray<string> =>
	nonEmptyList(
		Arr.map(
			box.claims,
			(fate, i) => `${after && fate === "renamed" ? "d" : "c"}${box.shared ? "" : String(i)}`
		),
		"the context's fields"
	)

/** The field of the context the entry over relation `i` reads. */
const claimOf = (box: ContextBox, i: number, after: boolean): string =>
	defined(claimNames(box, after)[box.shared ? 0 : i], "the field an entry reads")

const variable = (name: string) => ({ kind: "var", name }) as const

/** The rule of an entry over a relation: its rows whose `id` is the context's field, with their payload. */
const seenRule = (
	relationName: string,
	payload: string | undefined,
	context: string,
	claim: string
): Rule => {
	const fields = {
		id: variable("x"),
		...(payload === undefined ? {} : { [payload]: variable("y") })
	}
	return {
		matches: [
			{ source: { kind: "ordinary", name: relationName }, fields },
			{ source: { kind: "context", name: context }, fields: { [claim]: variable("x") } }
		],
		negations: [],
		comparisons: [],
		head: fields
	}
}

const integerDomain = (bits: 32 | 64): FieldDomain => ({ kind: "integer", bits })

/** A version of the contexts box: the relations as the carry model reads them, and the world over them. */
const contextShape = (box: ContextBox, after: boolean): Shape => {
	const relations = after ? relationsOut(box.fates, box.payloads) : relationsIn(box.fates.length)
	const context = nameAt(contextPool, after && box.context === "renamed" ? 1 : 0)
	const spec: InstallSpec = {
		base: {
			name: schemaName,
			closed: [],
			relations: [
				{
					name: "Anchor",
					fields: [
						{ name: "id", domain: integerDomain(64) },
						{ name: "z", domain: integerDomain(64) },
						{ name: "y", domain: integerDomain(64) }
					],
					key: ["z", "y"],
					mutability: "immutable"
				},
				...Arr.map(relations, (r): RelationSpec => ({
					name: r.name,
					fields: [
						{ name: "id", domain: integerDomain(64) },
						...(r.payload === undefined
							? []
							: [{ name: r.payload.name, domain: integerDomain(32) }])
					],
					key: ["id"],
					mutability: "immutable"
				}))
			],
			laws: [],
			contexts: [
				{
					name: context,
					claim: { kind: "top-level" },
					fields: Arr.map(claimNames(box, after), (name) => ({ name, domain: integerDomain(64) }))
				}
			],
			derived: []
		},
		roles: [
			{
				name: "reader",
				entries: {
					Anchor: { kind: "whole", relation: "Anchor" },
					...Rec.fromEntries(
						Arr.map(
							relations,
							(r) =>
								[
									`Seen${r.origin}`,
									{
										kind: "query",
										rules: [
											seenRule(r.name, r.payload?.name, context, claimOf(box, r.origin, after))
										]
									}
								] as const
						)
					)
				},
				write: [],
				refresh: []
			}
		],
		logins: [{ name: "app", roles: ["reader"] }]
	}
	return { schema: relationsSchema(relations), installs: { kind: "worlds", spec } }
}

const contextFeatures = [
	"a placeholder left unfilled refused",
	"a context field renamed under its entry",
	"the context renamed",
	"one context field read by two entries",
	"a relation rename chosen under its world entry",
	"a field's nested rename chosen under its world entry",
	"two rival relation renames under world entries",
	"two rival relation renames both chosen refused",
	"a relation removed with its world entry"
] as const
type ContextFeature = (typeof contextFeatures)[number] | ReviewFeature

const contextProved = (c: Case<ContextFeature>, box: ContextBox): Proved => {
	const a = contextShape(box, false)
	const b = contextShape(box, true)
	const facts = distinctFacts(a.schema)
	return {
		label: `contexts${box.shared ? ", one field read" : ""}, context ${box.context}, fields ${Arr.join(box.claims, " ")}: ${fatesText(relationPool, box.fates, (i) => ` payload ${armAt(box.payloads, i)}`)}`,
		a,
		b,
		carried: (chosen) => carriedBy(a.schema, b.schema, facts, chosen),
		placeholder: literalValue,
		catalog: catalogOf,
		rivals: "relation",
		notes: {
			draft: (g) => {
				if (
					Arr.some(
						box.fates,
						(fate, i) => fate.kind === "to" && box.claims[box.shared ? 0 : i] === "renamed"
					)
				) {
					c.note("a context field renamed under its entry")
				}
				if (box.context === "renamed") {
					c.note("the context renamed")
				}
				if (box.shared && !removedAny(box.fates)) {
					c.note("one context field read by two entries")
				}
				if (rivalsOffered(g, "relation")) {
					c.note("two rival relation renames under world entries")
				}
				if (removedAny(box.fates)) {
					c.note("a relation removed with its world entry")
				}
			},
			decision: (_, chosen) => {
				for (const x of chosen) {
					if (x.kind === "relation") {
						c.note("a relation rename chosen under its world entry")
					}
					if (x.kind === "nested field") {
						c.note("a field's nested rename chosen under its world entry")
					}
				}
			},
			refused: () => c.note("two rival relation renames both chosen refused")
		},
		back: { kind: "forward" }
	}
}

const proveClosed = () =>
	exhaust(
		{
			suite: "unit/deploy/renames-closed",
			generator: upTo(closedBoxes),
			literal: Formatter.format,
			limit: 1_000,
			coverage: requiredInSpace<ClosedFeature>(closedFeatures),
			caseHang
		},
		(box, c) => Effect.sync(() => closedCase(c, box))
	)

const proveContracts = () =>
	exhaust(
		{
			suite: "unit/deploy/renames-contracts",
			generator: upTo(contractBoxes),
			literal: Formatter.format,
			limit: 1_000,
			coverage: requiredInSpace<ContractFeature>(contractFeatures),
			caseHang
		},
		(box, c) => Effect.sync(() => forward(c, contractProved(c, box)))
	)

const proveIndexes = () =>
	exhaust(
		{
			suite: "unit/deploy/renames-indexes",
			generator: upTo(indexBoxes),
			literal: Formatter.format,
			limit: 400,
			coverage: requiredInSpace<IndexFeature>(indexFeatures),
			caseHang
		},
		(box, c) => Effect.sync(() => forward(c, indexProved(c, box)))
	)

const proveContexts = () =>
	exhaust(
		{
			suite: "unit/deploy/renames-contexts",
			generator: upTo(contextBoxes),
			literal: Formatter.format,
			limit: 1_500,
			coverage: requiredInSpace<ContextFeature>(contextFeatures),
			caseHang
		},
		(box, c) => Effect.sync(() => forward(c, contextProved(c, box)))
	)

describe("rename drafting, over every rename of a small box", () => {
	it.effect(
		"checks, runs and carries the rows as the carry model says, for every review of up to two names, and of one name renamed back",
		(ctx) => searched(ctx, prove())
	)

	it.effect(
		"renames every closed handle in place, adds labels, or refuses a removal or reorder, for every roster of a pool of three",
		(ctx) => searched(ctx, proveRosters(3))
	)

	it.effect(
		"renames one or two closed relations or confirms their rosters' renames and rebuilds, every review read back as itself, each row's handle its identity's, and refuses a field moving between two rebuilt rosters",
		(ctx) => searched(ctx, proveClosed())
	)

	it.effect(
		"renames one or two contracts, each field's rename with its contract's, every review read back as itself and every value kept",
		(ctx) => searched(ctx, proveContracts())
	)

	it.effect(
		"renames one or two relations with the index over each payload, every review read back as itself and the catalog a fresh install's",
		(ctx) => searched(ctx, proveIndexes())
	)

	it.effect(
		"renames one or two relations under world entries over a context whose fields and name change, every review read back as itself and every world object a fresh install's",
		(ctx) => searched(ctx, proveContexts())
	)
})
