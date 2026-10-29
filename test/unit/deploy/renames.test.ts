import { describe, it } from "@effect/vitest"
import { type Case, exhaust } from "@grizzle/testing/explore"
import { features } from "@grizzle/testing/features"
import { array, boolean, element, type Gen, int, map, oneOf, shuffled } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import {
	Array as Arr,
	Duration,
	Effect,
	Formatter,
	Option,
	Order,
	pipe,
	Record as Rec,
	Result,
	String as Str
} from "effect"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { splitRenames } from "#compiler/deploy/render/chosen.ts"
import { type MigrationMeta, readDecisions } from "#compiler/deploy/render/folder.ts"
import type { GenerateResult } from "#compiler/deploy/render/generate.ts"
import {
	findMarkers,
	fromFirstToken,
	placeholderToken,
	splitStatements
} from "#compiler/deploy/render/markers.ts"
import { noWorkload } from "#compiler/deploy/snapshot/build.ts"
import type { DeploySnapshot } from "#compiler/deploy/snapshot/types.ts"
import type { TypedLiteral } from "#compiler/ir/expr.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"
import type { TypeRef } from "#compiler/sql/ast.ts"
import {
	carry,
	noExtras,
	type Renames,
	serialFields,
	typedDefault,
	versionOf
} from "#test/pg/migrate-gen/support.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import { closed, f, relation, type SchemaDesc } from "#test/support/fixtures/ir/desc.ts"
import { parsedName, parsedSchemaName } from "#test/support/kernel/naming.ts"
import {
	emptyState,
	interpret,
	load,
	type State,
	typeText
} from "#test/support/migrate/interpret.ts"
import { asDrafted, compile, fromEmpty, fromSnapshot, generate } from "#test/support/migrate/kit.ts"
import {
	draftFiles,
	leftUnfilled,
	type Placeholder,
	plainPlan,
	planStatements,
	type Reviewed,
	renderReviewed,
	review
} from "#test/support/migrate/review.ts"
import { int4, int8, literalEqualityKey } from "#test/support/oracle/gen/domain.ts"
import type { GenFacts, LiteralRow } from "#test/support/oracle/gen/facts.ts"
import type { GenSchema } from "#test/support/oracle/gen/schema.ts"
import { indices } from "#test/support/oracle/pick.ts"

/** Rename drafting, proved over a small box, with no database.
 *
 * The box holds three kinds of schema. One relation whose fields, up to three, are each renamed to a name of a pool
 * twice their number or keep their name, each with its type changed or not; up to three relations, likewise renamed,
 * each with its one payload field's type changed or not, which a candidate converts in place; and one keyed relation,
 * renamed or not, whose primary key moves between its two fields, maybe referenced by another relation's foreign key,
 * which a candidate drops before the key and the draft adds again. Every injective map of the names into the pool is
 * drawn, so plain renames, swaps, chains, and renames onto a name the same migration removes all occur, a removed
 * relation pairs with several added ones and the reverse, and the first field, the primary key, is renamed too. Each draft from A to B is reviewed every way its candidates can be decided:
 * every set of chosen candidates that chooses at most one rename for each added and each removed name, as documented,
 * every other candidate kept. Each reviewed folder must:
 *
 * (a) pass grizzle check's reading: no marker left, no candidate decided two ways, each candidate
 *     decided exactly as its instruction says, so a commented alternative not taken stays with any placeholder it holds,
 *     and a note of the reviewer's in a block comment names the placeholder too; and refuse, with every placeholder of
 *     the SQL left unfilled, exactly the lines that hold one;
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
 * Then B is renamed back to A, and every review of the way back must pass (a), (b), (c), (d) carried from B's rows,
 * (e) against a fresh install of A, and (f). So a rename undone applies whichever way each rename went. The keyed kind goes forward only: its way back
 * drafts a reference into a relation the kept candidate leaves empty, which validation refuses, a reviewed data step.
 *
 * A third box changes a closed roster of one to three handles into every other, which the documented rule renames in
 * place, extends, or rebuilds when handles are removed or reordered; a row holding a renamed handle holds its new name,
 * one holding a removed handle the one the reviewer maps it to, and a selected containment over the roster, a stored
 * tag and a foreign key over the enum, is dropped and created again around the rebuild.
 *
 * The box of up to two names forward and one name back is proved whole, and so are the rosters of three handles. Every
 * case runs on the host in milliseconds: this is the small-scope proof migrate-gen's paths on PostgreSQL sample from. */
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

/** One case of the box: a schema A, its successor B, and where each name of B came from. */
interface Box {
	readonly kind: Kind
	readonly a: GenSchema
	readonly b: GenSchema
	/** For each name of A in order, the pool index of its name in B, and whether its type changed. */
	readonly renamed: ReadonlyArray<number>
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

/** Relations of the given names, each keyed by `id` with a payload field `v` of the given type. */
const relationsSchema = (
	relations: ReadonlyArray<{ readonly name: string; readonly type: ScalarType }>
): GenSchema => ({
	name: schemaName,
	relations: Arr.map(relations, (r) => ({
		name: r.name,
		columns: [
			{ name: "id", type: int8 },
			{ name: "v", type: r.type }
		],
		primaryKey: ["id"],
		keys: [],
		mutable: false
	})),
	closed: [],
	containments: []
})

const boxOf = (
	kind: "fields" | "relations",
	renamed: ReadonlyArray<number>,
	retyped: ReadonlyArray<boolean>
): Box => {
	const pool = kind === "fields" ? fieldPool : relationPool
	const build = kind === "fields" ? itemSchema : relationsSchema
	const a = build(
		Arr.map(indices(renamed.length), (i) => ({ name: nameAt(pool, i), type: types[0] }))
	)
	const b = build(
		Arr.map(renamed, (to, i) => ({
			name: nameAt(pool, to),
			type: retyped[i] === true ? types[1] : types[0]
		}))
	)
	return { kind, a, b, renamed, retyped, keyed: undefined }
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
		renamed: [to],
		retyped: [false],
		keyed: { a: keyA, b: keyB, referenced }
	}
}

/** Every injective map of `k` names into the first `2k` names of the pool, as the indices of the new names. */
const injections = (k: number): Gen<ReadonlyArray<number>> =>
	shuffled(indices(2 * k), { min: k, max: k })

/** Every box of `k` names of one kind. */
const boxes =
	(kind: "fields" | "relations", k: number): Gen<Box> =>
	(source) =>
		boxOf(kind, source.draw(injections(k)), source.draw(array(boolean, { min: k, max: k })))

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
		Arr.map(box.renamed, (to, i) => `${i}→${to}${box.retyped[i] === true ? " retyped" : ""}`),
		", "
	)}${
		box.keyed === undefined
			? ""
			: `, key ${box.keyed.a}→${box.keyed.b}${box.keyed.referenced ? ", referenced" : ""}`
	}`

/** A candidate rename as its own offer's alternative spells it: a field of a table renamed, or a table. */
type Pair =
	| {
			readonly kind: "column"
			readonly table: string
			readonly from: string
			readonly to: string
			readonly retype: boolean
	  }
	| {
			readonly kind: "table"
			readonly from: string
			readonly to: string
			readonly retype: boolean
			readonly rebuilds: boolean
	  }

/** Each candidate of a draft, by index, as its rename offer spells it. */
const candidatePairs = (g: GenerateResult): ReadonlyArray<Pair> => {
	const found = new Map<number, Pair>()
	for (const step of g.plan.steps) {
		if (step.draft.kind !== "choice") {
			continue
		}
		for (const offer of step.draft.offers) {
			if (offer.kind !== "rename") {
				continue
			}
			const [first] = offer.alternative
			if (first.kind !== "statement") {
				throw new Error(`candidate ${offer.candidate} renames by no statement`)
			}
			const s = first.statement
			const retype = Arr.some(offer.alternative, (x) => x.kind === "placeholderRetype")
			if (s.kind === "renameColumn") {
				found.set(offer.candidate, {
					kind: "column",
					table: s.table.name,
					from: s.from,
					to: s.to,
					retype
				})
			} else if (s.kind === "rename" && s.object === "TABLE") {
				const to = s.to
				const rebuilds = Arr.some(
					offer.alternative,
					(x) =>
						x.kind === "statement" &&
						x.statement.kind === "alterTable" &&
						x.statement.table.name !== to &&
						Arr.some(x.statement.actions, (a) => a.kind === "dropConstraint")
				)
				found.set(offer.candidate, { kind: "table", from: s.name.name, to, retype, rebuilds })
			} else {
				throw new Error(`candidate ${offer.candidate} renames by a ${s.kind} statement`)
			}
		}
	}
	return Arr.map(indices(g.plan.candidates.length), (i) => {
		const pair = found.get(i)
		if (pair === undefined) {
			throw new Error(`candidate ${i} has no rename offer`)
		}
		return pair
	})
}

const ends = (p: Pair): readonly [string, string] =>
	p.kind === "column" ? [`${p.table}.${p.from}`, `${p.table}.${p.to}`] : [p.from, p.to]

/** Every set of candidates that chooses at most one rename for each added and each removed name. */
const matchings = (pairs: ReadonlyArray<Pair>): ReadonlyArray<ReadonlySet<number>> => {
	const out: Array<ReadonlySet<number>> = []
	const go = (
		i: number,
		chosen: ReadonlyArray<number>,
		from: ReadonlySet<string>,
		to: ReadonlySet<string>
	) => {
		const p = pairs[i]
		if (p === undefined) {
			out.push(new Set(chosen))
			return
		}
		go(i + 1, chosen, from, to)
		const [removed, added] = ends(p)
		if (!from.has(removed) && !to.has(added)) {
			go(i + 1, [...chosen, i], new Set([...from, removed]), new Set([...to, added]))
		}
	}
	go(0, [], new Set(), new Set())
	return out
}

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

/** The renames of the chosen candidates, by declared names, for the carry model. */
const renamesOf = (
	pairs: ReadonlyArray<Pair>,
	chosen: ReadonlySet<number>,
	from: GenSchema,
	to: GenSchema
): Renames => {
	const before = namesOf(from)
	const after = namesOf(to)
	const relations = new Map<string, string>()
	const columns = new Map<string, string>()
	for (const i of chosen) {
		const p = pairs[i]
		if (p === undefined) {
			continue
		}
		if (p.kind === "table") {
			relations.set(after.relation(p.to), before.relation(p.from))
		} else {
			columns.set(
				`${after.relation(p.table)}.${after.field(p.table, p.to)}`,
				before.field(p.table, p.from)
			)
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

/** One fact per relation of A, every value distinct and no typed default; a keyed case's relation holds one value in both
 * its fields, which `Ref` references, so the reference holds whichever field is the key. */
const factsOf = (box: Box): GenFacts => {
	const a = box.a
	if (box.kind === "keyed") {
		return Rec.fromEntries(
			Arr.map(a.relations, (r): readonly [string, ReadonlyArray<LiteralRow>] => [
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
	let n = 1000n
	return Rec.fromEntries(
		Arr.map(
			a.relations,
			(r) =>
				[r.name, [Arr.map(r.columns, (): TypedLiteral => ({ kind: "int", value: n++ }))]] as const
		)
	)
}

const loaded = (state: State, s: GenSchema, facts: GenFacts): State =>
	Arr.reduce(s.relations, state, (t, r) => {
		const rows = Arr.map(
			facts[r.name] ?? [],
			(row) =>
				new Map(
					Arr.map(r.columns, (c, i) => {
						const value = row[i]
						if (value === undefined) {
							throw new Error(`a fact of ${r.name} without ${c.name}`)
						}
						return [identifierOf(identity.column(parsedName(c.name))), value] as const
					})
				)
		)
		return load(t, identifierOf(identity.table(parsedName(r.name))), rows)
	})

/** The drafts of one case over its schemas, each schema's installation compiled when the drafter is made. */
class Drafter {
	readonly #installations: ReadonlyMap<GenSchema, Installation>
	#timestamp = 0

	constructor(schemas: ReadonlyArray<GenSchema>) {
		this.#installations = new Map(
			Arr.map(schemas, (s) => [s, compile(versionOf(s, noExtras).desc, asDrafted)] as const)
		)
	}

	#installation(s: GenSchema): Installation {
		return defined(this.#installations.get(s), "the installation of one of the case's schemas")
	}

	/** The first draft of `s`, from the empty snapshot. */
	first(s: GenSchema): GenerateResult {
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
	draft(s: GenSchema, previous: DeploySnapshot): GenerateResult {
		this.#timestamp++
		return succeeded(
			generate({
				previous: fromSnapshot(previous),
				installation: this.#installation(s),
				name: `step_${this.#timestamp}`,
				timestamp: this.#stamp(),
				workload: noWorkload
			})
		)
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

/** The rows the carry model expects, in the same form. */
const expectedRows = (facts: GenFacts, s: GenSchema): ReadonlyArray<string> =>
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

/** Checks one reviewed draft against (a) to (c) and returns the state it leaves.
 *
 * (a). The review fills every placeholder of the SQL, so a token it leaves is in a comment. */
const applyReviewed = (
	c: Case<ReviewFeature>,
	g: GenerateResult,
	chosen: ReadonlySet<number>,
	state: State,
	where: string
): Applied => {
	const reviewed = review(g, { chosen, losses: "written", value: sqlValue })
	if (Result.isFailure(reviewed)) {
		assert.fail(
			`${where}: a statement of ${reviewed.failure.file} that candidates ${Arr.join(
				Arr.map(reviewed.failure.candidates, (k) => String(k)),
				" and "
			)}, all chosen, decide has no form for all of them`
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
	const renames = succeeded(readDecisions(g.folder.meta.decisions))
	assert.deepEqual(splitRenames(renames, prefaced), [], `${where}: a note splits a candidate`)
	assert.deepEqual(splitRenames(renames, files), [], `${where}: a candidate decided two ways`)
	assert.deepEqual(
		statementsOf(files),
		statementsOf(
			Arr.map(reviewed.success.plan, (step) => ({ text: renderReviewed(step, sqlValue) }))
		),
		`${where}: the reviewed text is not the reviewed plan`
	)
	/** (c) */
	const after = interpret(schema, state, reviewed.success.plan, literalValue)
	if (Result.isFailure(after)) {
		assert.fail(
			`${where}: ${after.failure.file}, action ${after.failure.action}: ${after.failure.reason}`
		)
	}
	return { state: after.success, folders: [committed(g, files)], snapshot: g.snapshot }
}

/** (f): the draft of `s` once a step reached it changes nothing. */
const settled = (d: Drafter, s: GenSchema, step: Applied, where: string): void => {
	assert.equal(
		d.draft(s, step.snapshot).change,
		"none",
		`${where}: the draft after the migration changes something`
	)
}

/** The state a fresh install of `s` creates on the model. */
const fresh = (d: Drafter, s: GenSchema): State => {
	const installed = interpret(schema, emptyState, plainPlan(d.first(s)), literalValue)
	if (Result.isFailure(installed)) {
		assert.fail(`a fresh install fails: ${installed.failure.reason}`)
	}
	return installed.success
}

const noteBox = (c: Case<Feature>, box: Box, g: GenerateResult, pairs: ReadonlyArray<Pair>) => {
	if (pairs.length > 0) {
		c.note("a candidate offered")
	}
	const counts = new Map<string, number>()
	for (const p of pairs) {
		for (const end of ends(p)) {
			counts.set(end, (counts.get(end) ?? 0) + 1)
		}
	}
	if (Arr.some([...counts.values()], (n) => n > 1)) {
		c.note("several candidates for one name")
	}
	const moved = Arr.some(box.renamed, (to, i) => to !== i)
	if (moved && g.change === "none") {
		c.note("names swapped, drafting no change")
	}
	if (Arr.some(box.renamed, (to, i) => to === i && box.retyped[i] === true)) {
		c.note("a type changed in place")
	}
	if (Arr.some(box.renamed, (to, i) => to !== i && to < box.renamed.length)) {
		c.note("a name renamed onto one the migration removes")
	}
	if (box.kind === "fields" && (box.renamed[0] ?? 0) !== 0) {
		c.note("the primary key's field renamed")
	}
}

const noteChosen = (
	c: Case<Feature>,
	box: Box,
	pairs: ReadonlyArray<Pair>,
	chosen: ReadonlySet<number>
) => {
	if (pairs.length > 0 && chosen.size === 0) {
		c.note("every candidate kept")
	}
	for (const i of chosen) {
		const p = pairs[i]
		if (p?.kind === "table") {
			c.note("a relation rename chosen")
			if (p.retype) {
				c.note("a relation rename chosen with a field retyped")
			}
			if (box.keyed !== undefined && box.keyed.a !== box.keyed.b) {
				c.note("a relation rename chosen with its key changed")
			}
			if (p.rebuilds) {
				c.note("a referenced key rebuilt in a chosen rename")
			}
		} else if (p?.retype === true) {
			c.note("a field rename chosen with its type changed")
		} else if (p !== undefined) {
			c.note("a field rename chosen")
		}
	}
}

/** The forward proof of one box: (a) to (f) for every review of A to B. */
const forward = (c: Case<Feature>, box: Box, back: boolean): void => {
	const d = new Drafter([box.a, box.b])
	const label = printBox(box)
	const gA = d.first(box.a)
	const facts = factsOf(box)
	const installedA = interpret(schema, emptyState, plainPlan(gA), literalValue)
	if (Result.isFailure(installedA)) {
		assert.fail(`${label}: installing A fails: ${installedA.failure.reason}`)
	}
	const gB = d.draft(box.b, gA.snapshot)
	const pairs = candidatePairs(gB)
	noteBox(c, box, gB, pairs)
	const freshB = shapeOf(fresh(d, box.b))
	const freshA = back ? shapeOf(fresh(d, box.a)) : []
	for (const chosen of matchings(pairs)) {
		noteChosen(c, box, pairs, chosen)
		const where = `${label}, choosing {${Arr.join(
			Arr.map([...chosen], (k) => String(k)),
			", "
		)}} of ${pairs.length}`
		/** A holds the facts whose carried forms B's laws admit under this review: a reference into a relation the review
		 * leaves empty would fail validation, a reviewed data step. */
		const model = carry(
			versionOf(box.a, noExtras),
			versionOf(box.b, noExtras),
			facts,
			renamesOf(pairs, chosen, box.a, box.b),
			serialFields(versionOf(box.b, noExtras))
		)
		const start = loaded(installedA.success, box.a, model.loaded)
		const step = applyReviewed(c, gB, chosen, start, where)
		settled(d, box.b, step, where)
		assert.deepEqual(
			rowsOf(step.state, box.b),
			expectedRows(model.expected, box.b),
			`${where}: the rows are not the carry model's`
		)
		assert.deepEqual(shapeOf(step.state), freshB, `${where}: the tables are not a fresh install's`)
		if (!back) {
			continue
		}
		c.note("renamed back")
		const gBack = d.draft(box.a, step.snapshot)
		const backPairs = candidatePairs(gBack)
		for (const chosenBack of matchings(backPairs)) {
			if (chosenBack.size > 0) {
				c.note("a rename back chosen")
			}
			const there = `${where}, back choosing {${Arr.join(
				Arr.map([...chosenBack], (k) => String(k)),
				", "
			)}} of ${backPairs.length}`
			const stepBack = applyReviewed(c, gBack, chosenBack, step.state, there)
			settled(d, box.a, stepBack, there)
			assert.deepEqual(
				shapeOf(stepBack.state),
				freshA,
				`${there}: the tables are not a fresh install's of A`
			)
			const modelBack = carry(
				versionOf(box.b, noExtras),
				versionOf(box.a, noExtras),
				model.expected,
				renamesOf(backPairs, chosenBack, box.b, box.a),
				serialFields(versionOf(box.a, noExtras))
			)
			assert.deepEqual(
				rowsOf(stepBack.state, box.a),
				expectedRows(modelBack.expected, box.a),
				`${there}: the rows are not the carry model's`
			)
		}
	}
}

/** The box: every case of one or two names forward, and those of one name renamed back too. */
const names: Arr.NonEmptyReadonlyArray<number> = [1, 2]
const back = 1

const prove = () =>
	exhaust(
		{
			suite: "unit/deploy/renames-full",
			generator: boxesUpTo(names),
			literal: Formatter.format,
			limit: 4_000,
			features: features<Feature>(featureNames),
			caseHang: Duration.minutes(2)
		},
		(box, c) =>
			Effect.sync(() => forward(c, box, box.kind !== "keyed" && box.renamed.length <= back))
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
 * handle, a relation Child contained in the Item rows that hold it, which Child carries as a stored tag, and a row check
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
			{
				kind: "contained" as const,
				left: { relation: "Child", fields: ["id"] as const, selection: {} },
				right: { relation: "Item", fields: ["id"] as const, selection: { level: handle } },
				origin: undefined
			},
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
					]
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
	const step = applyReviewed(c, gB, new Set(), start, where)
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
			features: features<RosterFeature>(rosterFeatures),
			caseHang: Duration.minutes(2)
		},
		(x, c) => Effect.sync(() => roster(c, x))
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
})
