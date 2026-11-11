import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import {
	accepted,
	type Answer,
	type Machine,
	type Program,
	program,
	type Real,
	refused,
	runProgram,
	took,
	type Verdict
} from "@grizzle/testing/commands"
import { type Case, drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, constant, element, type Gen, int, map, oneOf, weighted } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { fullSwarm } from "@grizzle/testing/swarm"
import { searched } from "@grizzle/testing/vitest"
import {
	Array as Arr,
	DateTime,
	Effect,
	FileSystem,
	Formatter,
	Option,
	Order,
	type Path,
	type PlatformError,
	String as Str,
	Struct
} from "effect"
import { readSnapshot } from "#adapter/boundary/snapshot.ts"
import { parseArgs } from "#cli/args.ts"
import { check } from "#cli/check.ts"
import { formatTimestamp } from "#cli/clock.ts"
import type { CliError } from "#cli/errors.ts"
import type { refusalText } from "#cli/refusals.ts"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import type { AbandonedSchema, Declarations } from "#compiler/deploy/diff/plan.ts"
import {
	type FolderNaming,
	fileNameMaxBytes,
	isFolderName,
	type MigrationName,
	maxMigrationNameLength,
	metaFileName
} from "#compiler/deploy/render/folder.ts"
import { customMigration, generateMigration } from "#compiler/deploy/render/generate.ts"
import { findMarkers, placeholderMarker } from "#compiler/deploy/render/markers.ts"
import { emptySnapshot } from "#compiler/deploy/snapshot/build.ts"
import {
	type DeploySnapshot,
	manifestFileName,
	type SnapshotFiles,
	snapshotFileName
} from "#compiler/deploy/snapshot/types.ts"
import { workloadExtension } from "#compiler/physical/access/extension.ts"
import { completeInstallOptions } from "#compiler/physical/complete.ts"
import { compileInstallation } from "#compiler/physical/install/compile.ts"
import { closedId, pg, uuid } from "#compiler/public/fields.ts"
import { closed, login, type Relation, relation, role, schema } from "#compiler/public/schema.ts"
import { installationsOf } from "#compiler/schema/own.ts"
import { ownLogin } from "#compiler/schema/own.ts"
import { loginDescOf } from "#compiler/schema/world.ts"
import { servedDirectory } from "#compiler/served/forms.ts"
import { placeholderToken } from "#compiler/sql/print.ts"
import type { FieldBase } from "#compiler/types/fields/field.ts"
import { defineConfig } from "#index.ts"
import {
	type CliRun,
	cliOver,
	configName,
	offlineOwner,
	resolvedConfig,
	workspace
} from "#test/pg/cli/support.ts"
import { assert, defined, nonEmpty, succeeded } from "#test/support/assert.ts"
import { compileTestWorkload, testCompile } from "#test/support/compile.ts"
import { parsedSchemaName } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { draftCodes, parsedMigrationName } from "#test/support/migrate/kit.ts"
import { owning } from "#test/support/policy.ts"
import { upTo } from "#test/support/up-to.ts"

/**
 * The loop a person runs over a project, without a database, as a state machine over the command line: edit the
 * schemas in code, `grizzle generate`, review what it drafts, and `grizzle check`, each command run through `runCli`
 * in process exactly as the bin runs it.
 *
 * The project is generated: one or two declared schemas, each a roster Kind and relations keyed by `id` whose fields
 * are integers, booleans, uuids or Kind's codes, read whole by the role `reader` of the login `server`. Its edits add,
 * drop and rename relations and fields, append, drop and move a roster's handles, and add, remove and rename a declared
 * schema, every new name a fresh one. The model is the documented loop (README "Migrations", SKILL.md "The loop" and
 * "Refusals"):
 *
 * - `generate` drafts a folder for each selected schema whose code differs from what its snapshot.json was generated
 *   from, `<timestamp>_<name>`, the timestamp the clock's second or one past the schema's newest folder, the name
 *   `--name`'s or the change's; and nothing for a schema that did not change. Each field added to a relation that
 *   already stood is a placeholder, its marker line and its value's line; a schema's first draft beside the directory
 *   of a schema the configuration no longer lists starts under the loss of its rows. `--custom --name` writes an empty
 *   folder of the committed snapshot. `--schema`, by a declared name or a PostgreSQL schema, chooses one of several
 *   schemas, and a custom folder or a declaration needs it there. A drop or rename is drafted only when declared
 *   (`--drop`, `--rename`, in the previous snapshot's names); a roster's handles declared out of their codes' order are
 *   refused; a schema whose directory is a file is refused. A refusal writes nothing for any schema, and exits 2 for a
 *   usage error, 1 otherwise.
 * - What generate writes is exactly what the pure generator drafts (deploy/render/generate.ts) from the committed
 *   snapshot read before it, the schema compiled with its login, the declared renames and drops, the name and the
 *   timestamp, byte for byte: every file, meta.json and snapshot.json.
 * - `check` finds, for each schema: an unresolved placeholder per marker line and value line, an undecided loss, and
 *   then, against the committed snapshot, a roster reordered, else an undeclared drop, else an ungenerated change beside
 *   its login's served file, missing before the schema's first draft and stale after, since the snapshot it compiles
 *   under is another; or, for a directory that is a file, only that. It exits 1 exactly when it finds anything.
 * - Reviewing deletes every marker line and writes every value; deciding a loss writes its statement in. A hidden
 *   entry an editor leaves beside the folders changes nothing.
 *
 * After every command the workspace is read back: the exit status and refusal, every schema's folders and their names,
 * and what the command wrote.
 *
 * Oracle: a model of the documented loop, and the pure generator fed the committed snapshot read before each generate
 * (a second implementation of what generate writes).
 *
 * Plants (~/.cache/grizzle-release/BR04/plants): cli-timestamp-repeats-newest.patch (a folder's timestamp repeats the
 * newest folder's), check-no-markers.patch (check reports no marker left in a file).
 *
 * Features: every command of the loop, each edit, each refusal, each finding, and a hidden entry ignored.
 */
type FieldKind = "int4" | "bool" | "uuid" | "code"

interface FieldSpec {
	readonly id: number
	readonly name: string
	readonly kind: FieldKind
}

interface RelationSpec {
	readonly id: number
	readonly name: string
	readonly fields: ReadonlyArray<FieldSpec>
}

interface HandleSpec {
	readonly id: number
	readonly name: string
}

/** A declared schema's code: its name, its relations and its roster's handles, each with an identity edits keep. */
interface SchemaSpec {
	readonly name: string
	readonly relations: ReadonlyArray<RelationSpec>
	readonly handles: Arr.NonEmptyReadonlyArray<HandleSpec>
}

/** How a folder was named: by `--name`, or after its change. */
type FolderName =
	| { readonly kind: "given"; readonly name: MigrationName }
	| { readonly kind: "derived" }

/** A folder a schema's directory holds, as the model knows it. */
interface FolderModel {
	/** Its timestamp, in seconds after the clock's start. */
	readonly second: number
	readonly name: FolderName
	readonly kind: "drafted" | "custom"
	/** Its unresolved placeholder lines. */
	readonly placeholders: number
	readonly loss: "none" | "undecided" | "decided"
}

/** A configured schema: its code, what its snapshot.json was generated from, its roster's codes and its folders. */
interface SchemaState {
	readonly current: SchemaSpec
	readonly committed: SchemaSpec | undefined
	/** The code each handle the snapshot records holds, a dropped handle's included, and the next code. */
	readonly codes: ReadonlyArray<readonly [handle: number, code: number]>
	readonly nextCode: number
	readonly folders: ReadonlyArray<FolderModel>
	/** Whether a file stands where its directory would, before its first folder. */
	readonly blocked: boolean
	/** Whether an editor's hidden entry stands beside its folders. */
	readonly hidden: boolean
}

interface Model {
	readonly schemas: Arr.NonEmptyReadonlyArray<SchemaState>
	/** The declared names of the schemas no longer configured whose directory holds a snapshot.json. */
	readonly abandoned: ReadonlyArray<string>
	/** The clock, in seconds after its start. */
	readonly clock: number
	/** The next fresh name's number. */
	readonly fresh: number
}

const freshSchema = (spec: SchemaSpec): SchemaState => ({
	current: spec,
	committed: undefined,
	codes: [],
	nextCode: 0,
	folders: [],
	blocked: false,
	hidden: false
})

const initial: Model = {
	schemas: [
		freshSchema({
			name: "Proj0",
			relations: [{ id: 1, name: "R1", fields: [] }],
			handles: [{ id: 2, name: "h2" }]
		})
	],
	abandoned: [],
	clock: 0,
	fresh: 3
}

/** The PostgreSQL schema a declared schema is installed in, through the naming door. */
const identOf = (name: string): string => identifierOf(identity.schema(parsedSchemaName(name)))

const sameSpec = (a: SchemaSpec, b: SchemaSpec): boolean =>
	a.name === b.name &&
	Arr.makeEquivalence(
		(x: RelationSpec, y: RelationSpec) =>
			x.id === y.id &&
			x.name === y.name &&
			Arr.makeEquivalence(
				(f: FieldSpec, g: FieldSpec) => f.id === g.id && f.name === g.name && f.kind === g.kind
			)(x.fields, y.fields)
	)(a.relations, b.relations) &&
	Arr.makeEquivalence((x: HandleSpec, y: HandleSpec) => x.id === y.id && x.name === y.name)(
		a.handles,
		b.handles
	)

/**
 * The declarations a draft from `committed` to `current` needs, in the previous snapshot's names: each relation dropped
 * or renamed, each field of a relation that stands dropped or renamed, each handle dropped.
 */
const neededOf = (s: SchemaState): ReadonlyArray<string> => {
	const committed = s.committed
	if (committed === undefined) {
		return []
	}
	const current = s.current
	return [
		...Arr.flatMap(committed.relations, (r) =>
			Option.match(
				Arr.findFirst(current.relations, (x) => x.id === r.id),
				{
					onNone: () => ["--drop", r.name],
					onSome: (now) => [
						...(now.name === r.name ? [] : ["--rename", `${r.name}=${now.name}`]),
						...Arr.flatMap(r.fields, (f) =>
							Option.match(
								Arr.findFirst(now.fields, (g) => g.id === f.id),
								{
									onNone: () => ["--drop", `${r.name}.${f.name}`],
									onSome: (g) =>
										g.name === f.name
											? []
											: ["--rename", `${r.name}.${f.name}=${now.name}.${g.name}`]
								}
							)
						)
					]
				}
			)
		),
		...Arr.flatMap(committed.handles, (h) =>
			Arr.some(current.handles, (x) => x.id === h.id) ? [] : ["--drop", `Kind#${h.name}`]
		)
	]
}

/** The code a handle holds in the snapshot, none for a handle the snapshot does not record. */
const codeOf = (s: SchemaState, handle: number): Option.Option<number> =>
	Option.map(
		Arr.findFirst(s.codes, ([h]) => h === handle),
		([, code]) => code
	)

/**
 * The codes a draft gives the current handles in declared order: each recorded handle its own, each new one the next.
 */
const draftedCodes = (s: SchemaState): ReadonlyArray<readonly [handle: number, code: number]> =>
	Arr.mapAccum(s.current.handles, s.nextCode, (next, h) =>
		Option.match(codeOf(s, h.id), {
			onNone: () => [next + 1, [h.id, next] as const],
			onSome: (code) => [next, [h.id, code] as const]
		})
	)[1]

/** Whether the roster declares a handle before one whose code is lower: its order is its codes' order. */
const reordered = (s: SchemaState): boolean => {
	const codes = Arr.map(draftedCodes(s), ([, code]) => code)
	return Arr.some(codes, (code, i) => i > 0 && code < defined(codes[i - 1], "the code before"))
}

/** The fields added to relations the committed snapshot holds: each a placeholder of two lines. */
const placeholdersOf = (s: SchemaState): number => {
	const committed = s.committed
	if (committed === undefined) {
		return 0
	}
	return Arr.reduce(s.current.relations, 0, (n, r) =>
		Option.match(
			Arr.findFirst(committed.relations, (c) => c.id === r.id),
			{
				onNone: () => n,
				onSome: (c) =>
					n + 2 * Arr.filter(r.fields, (f) => !Arr.some(c.fields, (g) => g.id === f.id)).length
			}
		)
	)
}

/** One edit of the project's code. */
type Change =
	| {
			readonly kind: "add a relation"
			readonly schema: number
			readonly fields: ReadonlyArray<FieldKind>
	  }
	| { readonly kind: "drop a relation"; readonly schema: number; readonly relation: number }
	| { readonly kind: "rename a relation"; readonly schema: number; readonly relation: number }
	| {
			readonly kind: "add a field"
			readonly schema: number
			readonly relation: number
			readonly field: FieldKind
	  }
	| {
			readonly kind: "drop a field"
			readonly schema: number
			readonly relation: number
			readonly field: number
	  }
	| {
			readonly kind: "rename a field"
			readonly schema: number
			readonly relation: number
			readonly field: number
	  }
	| { readonly kind: "append a handle"; readonly schema: number }
	| { readonly kind: "drop a handle"; readonly schema: number; readonly handle: number }
	| { readonly kind: "move a handle earlier"; readonly schema: number; readonly handle: number }
	| { readonly kind: "add a schema" }
	| { readonly kind: "remove a schema"; readonly schema: number }
	| { readonly kind: "rename a schema"; readonly schema: number }

const fieldKindGen: Gen<FieldKind> = element(["int4", "bool", "uuid", "code"])

/** An edit that applies to the schema at `i`. */
const schemaChangeGen = (m: Model, i: number): Gen<Change> => {
	const s = defined(m.schemas[i], "an edited schema").current
	const relations = s.relations.length
	const withFields = Arr.filter(
		upTo(relations, (i) => i),
		(r) => Option.exists(Arr.get(s.relations, r), (x) => x.fields.length > 0)
	)
	const fieldEdit =
		(kind: "drop a field" | "rename a field"): Gen<Change> =>
		(source) => {
			const relation = source.draw(element(nonEmpty(withFields, "a relation with fields")))
			const fields = defined(s.relations[relation], "the relation").fields.length
			return { kind, schema: i, relation, field: source.draw(int(0, fields - 1)) }
		}
	return oneOf<Change>([
		map(array(fieldKindGen, { min: 0, max: 2 }), (fields) => ({
			kind: "add a relation",
			schema: i,
			fields
		})),
		map(int(0, relations - 1), (relation) => ({ kind: "rename a relation", schema: i, relation })),
		(source) => ({
			kind: "add a field",
			schema: i,
			relation: source.draw(int(0, relations - 1)),
			field: source.draw(fieldKindGen)
		}),
		constant({ kind: "append a handle", schema: i }),
		constant({ kind: "rename a schema", schema: i }),
		...(relations > 1
			? [
					map(int(0, relations - 1), (relation): Change => ({
						kind: "drop a relation",
						schema: i,
						relation
					}))
				]
			: []),
		...(withFields.length > 0 ? [fieldEdit("drop a field"), fieldEdit("rename a field")] : []),
		...(s.handles.length > 1
			? [
					map(int(0, s.handles.length - 1), (handle): Change => ({
						kind: "drop a handle",
						schema: i,
						handle
					})),
					map(int(1, s.handles.length - 1), (handle): Change => ({
						kind: "move a handle earlier",
						schema: i,
						handle
					}))
				]
			: [])
	])
}

const changeGen =
	(m: Model): Gen<Change> =>
	(source) => {
		const count = m.schemas.length
		return source.draw(
			weighted<Change>([
				[6, (inner) => inner.draw(schemaChangeGen(m, inner.draw(int(0, count - 1))))],
				[
					2,
					count < 2
						? constant({ kind: "add a schema" })
						: map(int(0, count - 1), (schema): Change => ({ kind: "remove a schema", schema }))
				]
			])
		)
	}

/** The model's state with schema `i` replaced. */
const withSchema = (m: Model, i: number, f: (s: SchemaState) => SchemaState): Model => ({
	...m,
	schemas: Arr.map(m.schemas, (s, j) => (j === i ? f(s) : s))
})

/** The model after an edit: each new name a fresh one, a schema removed or renamed abandoning its snapshot. */
const applyChange = (m: Model, c: Change): Model => {
	const n = m.fresh
	const next = { ...m, fresh: n + 1 }
	const editRelations = (
		i: number,
		f: (relations: ReadonlyArray<RelationSpec>) => ReadonlyArray<RelationSpec>
	): Model =>
		withSchema(next, i, (s) => ({
			...s,
			current: { ...s.current, relations: f(s.current.relations) }
		}))
	const editFields = (
		i: number,
		r: number,
		f: (fields: ReadonlyArray<FieldSpec>) => ReadonlyArray<FieldSpec>
	): Model =>
		editRelations(i, (relations) =>
			Arr.map(relations, (x, j) => (j === r ? { ...x, fields: f(x.fields) } : x))
		)
	const abandons = (s: SchemaState): ReadonlyArray<string> =>
		s.committed === undefined ? [] : [s.current.name]
	switch (c.kind) {
		case "add a relation":
			return editRelations(c.schema, (relations) => [
				...relations,
				{
					id: n,
					name: `R${n}`,
					fields: Arr.map(c.fields, (kind, k) => ({ id: n * 10 + k, name: `f${n}x${k}`, kind }))
				}
			])
		case "drop a relation":
			return editRelations(c.schema, (relations) => Arr.remove(relations, c.relation))
		case "rename a relation":
			return editRelations(c.schema, (relations) =>
				Arr.map(relations, (x, j) => (j === c.relation ? { ...x, name: `R${n}` } : x))
			)
		case "add a field":
			return editFields(c.schema, c.relation, (fields) => [
				...fields,
				{ id: n, name: `f${n}`, kind: c.field }
			])
		case "drop a field":
			return editFields(c.schema, c.relation, (fields) => Arr.remove(fields, c.field))
		case "rename a field":
			return editFields(c.schema, c.relation, (fields) =>
				Arr.map(fields, (f, j) => (j === c.field ? { ...f, name: `f${n}` } : f))
			)
		case "append a handle":
			return withSchema(next, c.schema, (s) => ({
				...s,
				current: { ...s.current, handles: Arr.append(s.current.handles, { id: n, name: `h${n}` }) }
			}))
		case "drop a handle":
			return withSchema(next, c.schema, (s) => ({
				...s,
				current: {
					...s.current,
					handles: nonEmpty(Arr.remove(s.current.handles, c.handle), "a roster keeps a handle")
				}
			}))
		case "move a handle earlier":
			return withSchema(next, c.schema, (s) => {
				const h = s.current.handles
				const moved = defined(h[c.handle], "the moved handle")
				const before = defined(h[c.handle - 1], "the handle it moves before")
				return {
					...s,
					current: {
						...s.current,
						handles: Arr.map(h, (x, j) =>
							j === c.handle - 1 ? moved : j === c.handle ? before : x
						)
					}
				}
			})
		case "add a schema":
			return {
				...next,
				schemas: Arr.append(
					m.schemas,
					freshSchema({
						name: `Proj${n}`,
						relations: [{ id: n * 10, name: `R${n}`, fields: [] }],
						handles: [{ id: n * 10 + 1, name: `h${n}` }]
					})
				)
			}
		case "remove a schema": {
			const removed = defined(m.schemas[c.schema], "the removed schema")
			return {
				...next,
				schemas: nonEmpty(Arr.remove(m.schemas, c.schema), "a configuration keeps a schema"),
				abandoned: [...m.abandoned, ...abandons(removed)]
			}
		}
		case "rename a schema": {
			const renamed = defined(m.schemas[c.schema], "the renamed schema")
			return {
				...withSchema(next, c.schema, (s) => freshSchema({ ...s.current, name: `Proj${n}` })),
				abandoned: [...m.abandoned, ...abandons(renamed)]
			}
		}
	}
}

/** How generate names what it writes: after its change, by `--name`, or a custom folder, always named. */
type Naming =
	| { readonly kind: "derived" }
	| { readonly kind: "named"; readonly name: MigrationName }
	| { readonly kind: "custom"; readonly name: MigrationName }

/** `--schema`: none, a configured schema by its declared name or its PostgreSQL schema, or a name of none. */
type SchemaFlag =
	| { readonly kind: "none" }
	| { readonly kind: "declared"; readonly schema: number }
	| { readonly kind: "ident"; readonly schema: number }
	| { readonly kind: "unknown" }

interface GenerateParameters {
	/** The seconds the clock moved since the last command. */
	readonly advance: 0 | 1 | 2
	readonly naming: Naming
	readonly flag: SchemaFlag
	/** Whether the command line declares the renames and drops the drafts need. */
	readonly declare: boolean
}

/** What generate is refused by, by its reason's tag, an undeclared drop by the compiler's reason. */
type Refusal =
	| "SchemaChoiceRefused"
	| "TreeRefused"
	| "RosterReordered"
	| "UndeclaredDrop"
	| "a refusal the model has no name for"

/** The longest migration name, at the file name limit once its timestamp prefixes it. */
const longestName = parsedMigrationName(
	Arr.join(
		upTo(maxMigrationNameLength.value, () => "a"),
		""
	)
)

const nameGen: Gen<MigrationName> = weighted([
	[4, map(element(["init", "add_tier", "note-2", "v2"]), parsedMigrationName)],
	[1, constant(longestName)]
])

const generateGen =
	(m: Model): Gen<GenerateParameters> =>
	(source) => ({
		advance: source.draw(element<0 | 1 | 2>([0, 1, 2])),
		naming: source.draw(
			weighted<Naming>([
				[3, constant({ kind: "derived" })],
				[2, map(nameGen, (name) => ({ kind: "named", name }))],
				[1, map(nameGen, (name) => ({ kind: "custom", name }))]
			])
		),
		flag: source.draw(
			m.schemas.length > 1
				? weighted<SchemaFlag>([
						[2, constant({ kind: "none" })],
						[2, map(int(0, m.schemas.length - 1), (schema) => ({ kind: "declared", schema }))],
						[2, map(int(0, m.schemas.length - 1), (schema) => ({ kind: "ident", schema }))],
						[1, constant({ kind: "unknown" })]
					])
				: weighted<SchemaFlag>([
						[8, constant({ kind: "none" })],
						[1, map(int(0, 0), (schema) => ({ kind: "declared", schema }))]
					])
		),
		declare: source.draw(
			weighted([
				[4, constant(true)],
				[1, constant(false)]
			])
		)
	})

/** The schemas a generate selects, by index. */
const selectedOf = (m: Model, flag: SchemaFlag): ReadonlyArray<number> =>
	flag.kind === "declared" || flag.kind === "ident"
		? [flag.schema]
		: upTo(m.schemas.length, (i) => i)

/** The declarations a generate's command line gives: every selected schema's needed ones, when it declares any. */
const declarationsOf = (m: Model, p: GenerateParameters): ReadonlyArray<string> =>
	p.naming.kind === "custom" || !p.declare
		? []
		: Arr.flatMap(selectedOf(m, p.flag), (i) =>
				neededOf(defined(m.schemas[i], "a selected schema"))
			)

/** A schema's next folder's timestamp: the clock's second, or one past its newest folder's. */
const stampOf = (s: SchemaState, now: number): number =>
	Option.match(Arr.last(s.folders), {
		onNone: () => now,
		onSome: (f) => Math.max(now, f.second + 1)
	})

/** What generate does to one selected schema: nothing, a custom folder, or a draft. */
const generatedFor = (
	m: Model,
	s: SchemaState,
	p: GenerateParameters,
	now: number
): SchemaState => {
	if (p.naming.kind === "custom") {
		return {
			...s,
			folders: [
				...s.folders,
				{
					second: stampOf(s, now),
					name: { kind: "given", name: p.naming.name },
					kind: "custom",
					placeholders: 0,
					loss: "none"
				}
			]
		}
	}
	const committed = s.committed
	if (committed !== undefined && sameSpec(committed, s.current)) {
		return s
	}
	const codes = draftedCodes(s)
	return {
		...s,
		committed: s.current,
		codes: Arr.appendAll(
			s.codes,
			Arr.filter(codes, ([h]) => Option.isNone(codeOf(s, h)))
		),
		nextCode: s.nextCode + Arr.filter(codes, ([h]) => Option.isNone(codeOf(s, h))).length,
		folders: [
			...s.folders,
			{
				second: stampOf(s, now),
				name:
					p.naming.kind === "named" ? { kind: "given", name: p.naming.name } : { kind: "derived" },
				kind: "drafted",
				placeholders: placeholdersOf(s),
				loss: committed === undefined && m.abandoned.length > 0 ? "undecided" : "none"
			}
		]
	}
}

/**
 * The model's verdict on a generate: the schema choice, then each selected schema in configured order (its directory,
 * then for a draft its roster's order and its declarations), the first refusal refusing the whole command; otherwise
 * every selected schema's draft written.
 */
const judgeGenerate = (m: Model, p: GenerateParameters): Verdict<Model, Refusal> => {
	const several = m.schemas.length > 1
	if (p.flag.kind !== "none" && (!several || p.flag.kind === "unknown")) {
		return refused("SchemaChoiceRefused")
	}
	if (
		p.flag.kind === "none" &&
		several &&
		(p.naming.kind === "custom" || declarationsOf(m, p).length > 0)
	) {
		return refused("SchemaChoiceRefused")
	}
	const selected = selectedOf(m, p.flag)
	for (const i of selected) {
		const s = defined(m.schemas[i], "a selected schema")
		if (s.blocked) {
			return refused("TreeRefused")
		}
		if (p.naming.kind !== "custom") {
			if (reordered(s)) {
				return refused("RosterReordered")
			}
			if (!p.declare && neededOf(s).length > 0) {
				return refused("UndeclaredDrop")
			}
		}
	}
	const now = m.clock + p.advance
	return accepted({
		...m,
		clock: now,
		schemas: Arr.map(m.schemas, (s, i) =>
			Arr.contains(selected, i) ? generatedFor(m, s, p, now) : s
		)
	})
}

/** A finding of `grizzle check`, by its kind. */
type FindingKind = keyof typeof refusalText

/** What `grizzle check` finds for one schema, by kind, in the order it reports them. */
const findingsOf = (s: SchemaState): ReadonlyArray<FindingKind> => {
	if (s.blocked) {
		return ["strayEntry"]
	}
	const files: ReadonlyArray<FindingKind> = Arr.flatMap(s.folders, (f) => [
		...(f.placeholders > 0 ? upTo(f.placeholders, (): FindingKind => "placeholder") : []),
		...(f.loss === "undecided" ? (["unresolvedLoss"] as const) : [])
	])
	const committed = s.committed
	const draft: ReadonlyArray<FindingKind> = reordered(s)
		? ["rosterReordered"]
		: neededOf(s).length > 0
			? ["undeclaredDrop"]
			: committed === undefined
				? ["ungenerated", "servedMissing"]
				: !sameSpec(committed, s.current)
					? ["ungenerated", "servedStale"]
					: []
	return [...files, ...draft]
}

/** Every placeholder of every folder reviewed. */
const reviewed = (m: Model): Model => ({
	...m,
	schemas: Arr.map(m.schemas, (s) => ({
		...s,
		folders: Arr.map(s.folders, (f) => ({ ...f, placeholders: 0 }))
	}))
})

/** The loss of schema `i`'s first draft written in. */
const decided = (m: Model, i: number): Model =>
	withSchema(m, i, (s) => ({
		...s,
		folders: Arr.map(s.folders, (f) => (f.loss === "undecided" ? { ...f, loss: "decided" } : f))
	}))

/** The schemas, by index, whose state `holds` says something of. */
const schemasWhere = (m: Model, holds: (s: SchemaState) => boolean): ReadonlyArray<number> =>
	Arr.filter(
		upTo(m.schemas.length, (i) => i),
		(i) => Option.exists(Arr.get(m.schemas, i), holds)
	)

const anyWhere =
	(holds: (s: SchemaState) => boolean) =>
	(m: Model): boolean =>
		schemasWhere(m, holds).length > 0

const indexOf =
	(holds: (s: SchemaState) => boolean) =>
	(m: Model): Gen<number> =>
		element(nonEmpty(schemasWhere(m, holds), "a schema the command applies to"))

const undecided = (s: SchemaState): boolean => Arr.some(s.folders, (f) => f.loss === "undecided")
const unhidden = (s: SchemaState): boolean => s.folders.length > 0 && !s.hidden
const blockable = (s: SchemaState): boolean => s.folders.length === 0 && !s.blocked

/** The parameters each command of the loop draws. */
type ProjectParameters = {
	readonly "edit the code": Change
	readonly "grizzle generate": GenerateParameters
	readonly "grizzle check": undefined
	readonly "review the placeholders": undefined
	readonly "decide the data loss": number
	readonly "leave a hidden entry": number
	readonly "make a file of a schema's directory": number
	readonly "remove that file": number
}

const machine: Machine<Model, ProjectParameters, Refusal> = {
	initial,
	commands: {
		"edit the code": {
			weight: 4,
			applies: () => true,
			parameters: changeGen,
			judge: (m, c) => accepted(applyChange(m, c))
		},
		"grizzle generate": {
			weight: 4,
			applies: () => true,
			parameters: generateGen,
			judge: judgeGenerate
		},
		"grizzle check": {
			weight: 2,
			applies: () => true,
			parameters: () => constant(undefined),
			judge: (m) => accepted(m)
		},
		"review the placeholders": {
			weight: 2,
			applies: anyWhere((s) => Arr.some(s.folders, (f) => f.placeholders > 0)),
			parameters: () => constant(undefined),
			judge: (m) => accepted(reviewed(m))
		},
		"decide the data loss": {
			weight: 2,
			applies: anyWhere(undecided),
			parameters: indexOf(undecided),
			judge: (m, i) => accepted(decided(m, i))
		},
		"leave a hidden entry": {
			weight: 1,
			applies: anyWhere(unhidden),
			parameters: indexOf(unhidden),
			judge: (m, i) => accepted(withSchema(m, i, (s) => ({ ...s, hidden: true })))
		},
		"make a file of a schema's directory": {
			weight: 1,
			applies: anyWhere(blockable),
			parameters: indexOf(blockable),
			judge: (m, i) => accepted(withSchema(m, i, (s) => ({ ...s, blocked: true })))
		},
		"remove that file": {
			weight: 1,
			applies: anyWhere((s) => s.blocked),
			parameters: indexOf((s) => s.blocked),
			judge: (m, i) => accepted(withSchema(m, i, (s) => ({ ...s, blocked: false })))
		}
	}
}

/** The findings the loop's model predicts, each a situation of its own. */
const checkedKinds = [
	"placeholder",
	"unresolvedLoss",
	"undeclaredDrop",
	"rosterReordered",
	"ungenerated",
	"servedMissing",
	"servedStale",
	"strayEntry"
] as const satisfies ReadonlyArray<FindingKind>

/** The situations the loop must reach. */
type ProjectFeature =
	| "a first draft"
	| "a change drafted"
	| "nothing to draft"
	| "a draft named by --name"
	| "a draft named after its change"
	| "a folder named at the file name limit"
	| "a custom folder"
	| "a custom folder before the first draft"
	| "a folder in the same second as the newest"
	| "two schemas drafted at once"
	| "--schema by its declared name"
	| "--schema by its PostgreSQL schema"
	| "a placeholder drafted"
	| "the placeholders reviewed"
	| "a first draft beside an abandoned schema"
	| "the loss decided"
	| "renames and drops declared"
	| "a hidden entry ignored"
	| `generate refused: ${Exclude<Refusal, "a refusal the model has no name for">}`
	| "check passes"
	| `check finds ${(typeof checkedKinds)[number]}`

const projectFeatures = [
	"a first draft",
	"a change drafted",
	"nothing to draft",
	"a draft named by --name",
	"a draft named after its change",
	"a folder named at the file name limit",
	"a custom folder",
	"a custom folder before the first draft",
	"a folder in the same second as the newest",
	"two schemas drafted at once",
	"--schema by its declared name",
	"--schema by its PostgreSQL schema",
	"a placeholder drafted",
	"the placeholders reviewed",
	"a first draft beside an abandoned schema",
	"the loss decided",
	"renames and drops declared",
	"a hidden entry ignored",
	"generate refused: SchemaChoiceRefused",
	"generate refused: TreeRefused",
	"generate refused: RosterReordered",
	"generate refused: UndeclaredDrop",
	"check passes",
	"check finds placeholder",
	"check finds unresolvedLoss",
	"check finds undeclaredDrop",
	"check finds rosterReordered",
	"check finds ungenerated",
	"check finds servedMissing",
	"check finds servedStale",
	"check finds strayEntry"
] as const satisfies ReadonlyArray<ProjectFeature>

/** The workspace one program runs in, and the case its steps note what they reach through. */
interface Workspace {
	readonly dir: string
	readonly c: Case<ProjectFeature>
}

/** The roster and relations of a schema's code, as a configuration's schema value is built from them. */
type ProjectRelation = Relation<
	string,
	Record<string, FieldBase>,
	readonly [string, ...Array<string>]
>

const rosterOf = (spec: SchemaSpec) =>
	closed(
		"Kind",
		Arr.map(spec.handles, (h) => h.name)
	)

const fieldOf = (kind: FieldKind, roster: ReturnType<typeof rosterOf>): FieldBase => {
	switch (kind) {
		case "int4":
			return pg.integer
		case "bool":
			return pg.boolean
		case "uuid":
			return uuid
		case "code":
			return closedId(roster)
	}
}

const schemaOf = (
	name: string,
	relations: Readonly<Record<string, ReturnType<typeof rosterOf> | ProjectRelation>>
) => schema(name, relations, [])

/** A schema's value and its login `server`, whose role `reader` reads every relation, built from its code. */
const builtOf = (spec: SchemaSpec) => {
	const Kind = rosterOf(spec)
	const relations: Record<string, ReturnType<typeof rosterOf> | ProjectRelation> = { Kind }
	for (const r of spec.relations) {
		const fields: Record<string, FieldBase> = { id: uuid }
		for (const f of r.fields) {
			fields[f.name] = fieldOf(f.kind, Kind)
		}
		relations[r.name] = relation(r.name, fields, ["id"])
	}
	const value = schemaOf(spec.name, relations)
	return { schema: value, server: login(value, "server", [role(value, "reader", value.relations)]) }
}

/** The configuration of the model's schemas and their logins, as defineConfig builds it. */
const configOf = (m: Model) => {
	const built = Arr.map(m.schemas, (s) => builtOf(s.current))
	return defineConfig({
		schemas: [Arr.headNonEmpty(built).schema, ...Arr.map(Arr.tailNonEmpty(built), (b) => b.schema)],
		logins: Arr.map(built, (b) => b.server),
		migrations: "migrations",
		connection: () => offlineOwner
	})
}

/** The clock's start, 2026-10-12T12:00:00Z. */
const clockStart = DateTime.makeUnsafe({
	year: 2026,
	month: 10,
	day: 12,
	hour: 12,
	minute: 0,
	second: 0,
	millisecond: 0
})

const instantOf = (second: number): DateTime.Utc => DateTime.add(clockStart, { seconds: second })

const stampText = (second: number): string => formatTimestamp(instantOf(second))

const directoryOf = (r: Workspace, s: SchemaState): string =>
	`${r.dir}/migrations/${identOf(s.current.name)}`

/** Every entry under the migrations directory with its text, a directory's empty: what a refusal must leave alone. */
const contents = (r: Workspace) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const root = `${r.dir}/migrations`
		if (!(yield* fs.exists(root))) {
			return []
		}
		const out: Array<readonly [string, string]> = []
		const entries = yield* fs.readDirectory(root, { recursive: true })
		for (const entry of Arr.sort(entries, Order.String)) {
			const info = yield* fs.stat(`${root}/${entry}`)
			if (info.type === "Directory") {
				out.push([entry, "/"])
				continue
			}
			const text = yield* fs.readFileString(`${root}/${entry}`)
			out.push([entry, text])
		}
		return out
	})

/** A schema's folders on disk, by name: its directory's entries but snapshot.json and hidden ones. */
const foldersOnDisk = (r: Workspace, s: SchemaState) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const dir = directoryOf(r, s)
		if (s.blocked || !(yield* fs.exists(dir))) {
			return []
		}
		const entries = yield* fs.readDirectory(dir)
		return Arr.sort(
			Arr.filter(
				entries,
				(n) =>
					n !== snapshotFileName &&
					n !== manifestFileName &&
					n !== servedDirectory &&
					!Str.startsWith(".")(n)
			),
			Order.String
		)
	})

/** The texts of a schema's snapshot files, none where it holds none: generate writes snapshot.json and manifest.json
 * together. */
const snapshotFilesOf = (r: Workspace, s: SchemaState) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const directory = directoryOf(r, s)
		if (s.blocked || !(yield* fs.exists(`${directory}/${snapshotFileName}`))) {
			return Option.none<SnapshotFiles>()
		}
		const snapshot = yield* fs.readFileString(`${directory}/${snapshotFileName}`)
		const manifest = yield* fs.readFileString(`${directory}/${manifestFileName}`)
		return Option.some({ snapshot, manifest })
	})

/** The SQL files of a folder of a schema, by name, with their texts. */
const sqlFilesOf = (folder: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const entries = yield* fs.readDirectory(folder)
		const names = Arr.sort(
			Arr.filter(entries, (n) => Str.endsWith(".sql")(n)),
			Order.String
		)
		return yield* Effect.forEach(names, (name) =>
			Effect.map(fs.readFileString(`${folder}/${name}`), (text) => ({ name, text }))
		)
	})

/** Every schema's folders on disk are the model's: as many, each named by its timestamp and its given name. */
const confirmFolders = (r: Workspace, m: Model) =>
	Effect.forEach(m.schemas, (s) =>
		Effect.map(foldersOnDisk(r, s), (names) => {
			assert.equal(
				names.length,
				s.folders.length,
				`the folders of ${s.current.name}: ${Arr.join(names, ", ")}`
			)
			for (const [name, f] of Arr.zip(names, s.folders)) {
				assert.ok(isFolderName(name), `${name} is a folder's name`)
				assert.ok(
					Str.startsWith(`${stampText(f.second)}_`)(name),
					`${name} is stamped ${stampText(f.second)}`
				)
				if (f.name.kind === "given") {
					assert.equal(name, `${stampText(f.second)}_${f.name.name}`)
				}
			}
		})
	)

/** The command line's arguments of a generate. */
const generateArgv = (m: Model, p: GenerateParameters): ReadonlyArray<string> => {
	const naming = (() => {
		switch (p.naming.kind) {
			case "derived":
				return []
			case "named":
				return ["--name", p.naming.name]
			case "custom":
				return ["--custom", "--name", p.naming.name]
		}
	})()
	const flag = (() => {
		const f = p.flag
		switch (f.kind) {
			case "none":
				return []
			case "declared":
				return ["--schema", defined(m.schemas[f.schema], "the chosen schema").current.name]
			case "ident":
				return ["--schema", identOf(defined(m.schemas[f.schema], "the chosen schema").current.name)]
			case "unknown":
				return ["--schema", "Nope"]
		}
	})()
	return ["generate", configName, ...naming, ...flag, ...declarationsOf(m, p)]
}

/** What the system answered a generate: it ran, or the refusal its CliError names. */
const answerOf = (ran: CliRun): Answer<Refusal> => {
	const report = ran.report
	if (report.outcome !== "refused") {
		return took
	}
	const refusal = report.refusal
	if (refusal._tag !== "CliError") {
		return refused("a refusal the model has no name for")
	}
	const reason = refusal.reason
	if (
		reason._tag === "SchemaChoiceRefused" ||
		reason._tag === "TreeRefused" ||
		reason._tag === "RosterReordered"
	) {
		return refused(reason._tag)
	}
	return refused(
		reason._tag === "DraftRefused" && reason.error.reason._tag === "UndeclaredDrop"
			? "UndeclaredDrop"
			: "a refusal the model has no name for"
	)
}

/** The exit status an answer ends with: 0 when the command ran, 2 for a usage error, 1 for any other refusal. */
const statusOf = (answer: Answer<Refusal>): number =>
	answer.kind === "accepted" ? 0 : answer.refusal === "SchemaChoiceRefused" ? 2 : 1

/**
 * The draft the pure generator gives a schema's code from the committed snapshot read before the command: the schema
 * compiled with its login and the login's workload, under the codes drafted from the snapshot's, named and stamped as
 * the command names and stamps it.
 */
const oracleDraft = (
	spec: SchemaSpec,
	previousText: Option.Option<SnapshotFiles>,
	naming: FolderNaming,
	timestamp: string,
	declared: Declarations,
	abandoned: ReadonlyArray<AbandonedSchema>
) => {
	const b = builtOf(spec)
	const previous: DeploySnapshot = Option.match(previousText, {
		onNone: () => emptySnapshot({ schemaName: spec.name, schema: identOf(spec.name) }),
		onSome: (files) => succeeded(readSnapshot(files), "the committed snapshot").snapshot
	})
	const plan = succeeded(
		compileTestWorkload(
			[{ login: b.server.name, workloads: b.server.workload }],
			b.schema,
			testCompile
		)
	)
	const owned = owning(b.schema)
	const logins = [succeeded(ownLogin(defined(loginDescOf(b.server), "a login value")))]
	const codes = succeeded(
		draftCodes(
			b.schema,
			Option.isSome(previousText)
				? { kind: "snapshot", snapshot: previous }
				: { kind: "empty", abandoned: [] },
			declared
		)
	)
	const installation = succeeded(
		compileInstallation(
			owned,
			completeInstallOptions(
				owned,
				installationsOf(owned),
				logins,
				[workloadExtension(plan)],
				codes
			)
		)
	)
	return succeeded(
		generateMigration({
			previous,
			installation,
			workload: { access: plan.access, accessPaths: plan.requests, live: plan.live },
			declared,
			naming,
			timestamp,
			abandoned: Option.isSome(previousText) ? [] : abandoned
		})
	)
}

/** The written folder, file by file, is the expected one: its entries, every SQL file's text and its meta.json's. */
const confirmFolder = (
	dir: string,
	expected: {
		readonly metaText: string
		readonly files: ReadonlyArray<{ readonly name: string; readonly text: string }>
	}
) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const entries = yield* fs.readDirectory(dir)
		assert.deepEqual(
			Arr.sort(entries, Order.String),
			Arr.sort([metaFileName, ...Arr.map(expected.files, (f) => f.name)], Order.String)
		)
		const metaText = yield* fs.readFileString(`${dir}/${metaFileName}`)
		assert.equal(metaText, expected.metaText)
		for (const f of expected.files) {
			const text = yield* fs.readFileString(`${dir}/${f.name}`)
			assert.equal(text, f.text, f.name)
		}
	})

const runGenerate = (
	r: Workspace,
	p: GenerateParameters,
	before: Model,
	after: Model,
	verdict: Verdict<Model, Refusal>
) =>
	Effect.gen(function* () {
		const argv = generateArgv(before, p)
		const listed = yield* contents(r)
		const previous = yield* Effect.forEach(before.schemas, (s) => snapshotFilesOf(r, s))
		const ran = yield* cliOver(r.dir, configOf(before), argv, instantOf(before.clock + p.advance))
		const answer = answerOf(ran)
		assert.equal(ran.code, statusOf(answer), `grizzle ${Arr.join(argv, " ")}: ${ran.stderr}`)
		if (Arr.some(before.schemas, (s) => s.hidden)) {
			r.c.note("a hidden entry ignored")
		}
		if (answer.kind === "refused") {
			const left = yield* contents(r)
			assert.deepEqual(left, listed, "a refusal writes nothing")
			if (answer.refusal !== "a refusal the model has no name for") {
				r.c.note(`generate refused: ${answer.refusal}`)
			}
			return answer
		}
		if (verdict.kind === "refused") {
			return answer
		}
		yield* confirmFolders(r, after)
		const declared = succeeded(parseArgs(argv), "the command line")
		const declarations =
			declared.kind === "run" && declared.command.kind === "generate"
				? declared.command.declared
				: assert.fail("a generate command line")
		if (declarations.renames.length + declarations.drops.length > 0) {
			r.c.note("renames and drops declared")
		}
		const abandoned: ReadonlyArray<AbandonedSchema> = Arr.map(
			Arr.sort(Arr.map(before.abandoned, identOf), Order.String),
			(ident) => ({ schema: ident, directory: `migrations/${ident}` })
		)
		const written = Arr.filter(
			upTo(after.schemas.length, (i) => i),
			(i) => {
				const was = defined(before.schemas[i], "a schema before")
				return defined(after.schemas[i], "a schema after").folders.length > was.folders.length
			}
		)
		if (written.length === 0) {
			r.c.note("nothing to draft")
		}
		if (written.length > 1) {
			r.c.note("two schemas drafted at once")
		}
		if (p.flag.kind === "declared") {
			r.c.note("--schema by its declared name")
		}
		if (p.flag.kind === "ident") {
			r.c.note("--schema by its PostgreSQL schema")
		}
		for (const [i, s] of after.schemas.entries()) {
			const was = defined(before.schemas[i], "a schema before")
			const text = yield* snapshotFilesOf(r, s)
			const previousText = defined(previous[i], "a schema's committed snapshot")
			if (!Arr.contains(written, i)) {
				assert.deepEqual(text, previousText, `${s.current.name}'s snapshot.json stands`)
				continue
			}
			const folder = Arr.lastNonEmpty(nonEmpty(s.folders, "a written folder"))
			const onDisk = yield* foldersOnDisk(r, s)
			const name = Arr.lastNonEmpty(nonEmpty(onDisk, "a folder on disk"))
			const dir = `${directoryOf(r, s)}/${name}`
			const timestamp = stampText(folder.second)
			if (Option.exists(Arr.last(was.folders), (f) => f.second >= before.clock + p.advance)) {
				r.c.note("a folder in the same second as the newest")
			}
			if (Str.length(name) === fileNameMaxBytes.value) {
				r.c.note("a folder named at the file name limit")
			}
			if (folder.kind === "custom") {
				r.c.note("a custom folder")
				if (was.committed === undefined) {
					r.c.note("a custom folder before the first draft")
				}
				const previousSnapshot = Option.match(previousText, {
					onNone: () =>
						emptySnapshot({ schemaName: s.current.name, schema: identOf(s.current.name) }),
					onSome: (t) => succeeded(readSnapshot(t), "the committed snapshot").snapshot
				})
				const custom = succeeded(
					customMigration({
						snapshot: previousSnapshot,
						name:
							folder.name.kind === "given"
								? folder.name.name
								: assert.fail("a custom folder is named"),
						timestamp
					})
				)
				assert.equal(name, custom.name)
				yield* confirmFolder(dir, custom)
				assert.deepEqual(text, previousText, "a custom folder leaves snapshot.json alone")
				continue
			}
			r.c.note(was.committed === undefined ? "a first draft" : "a change drafted")
			r.c.note(
				folder.name.kind === "given" ? "a draft named by --name" : "a draft named after its change"
			)
			const draft = oracleDraft(
				was.current,
				previousText,
				folder.name.kind === "given"
					? { kind: "named", name: folder.name.name }
					: { kind: "derived" },
				timestamp,
				declarations,
				abandoned
			)
			assert.equal(name, draft.folder.name)
			yield* confirmFolder(dir, draft.folder)
			assert.deepEqual(
				text,
				Option.some(draft.snapshotFiles),
				"the snapshot's files are the draft's"
			)
			const placeholders = Arr.flatMap(draft.folder.files, (f) =>
				Arr.filter(findMarkers(f.text), (m) => m.kind === "placeholder")
			).length
			assert.equal(
				placeholders,
				folder.placeholders,
				"a placeholder's two lines for each field added"
			)
			if (placeholders > 0) {
				r.c.note("a placeholder drafted")
			}
			const losses = Arr.flatMap(draft.folder.meta.files, (f) =>
				Arr.filter(f.steps, (step) => step.kind === "loss")
			).length
			assert.equal(
				losses,
				folder.loss === "undecided" ? 1 : 0,
				"the loss of the abandoned schemas' rows"
			)
			if (losses > 0) {
				r.c.note("a first draft beside an abandoned schema")
			}
		}
		return answer
	})

const runCheck = (r: Workspace, m: Model) =>
	Effect.gen(function* () {
		const config = configOf(m)
		const ran = yield* cliOver(r.dir, config, ["check", configName], instantOf(m.clock))
		const read = yield* resolvedConfig(config, `${r.dir}/${configName}`)
		const resolved = succeeded(read)
		const checks = yield* check(resolved, r.dir)
		const expected = Arr.map(m.schemas, findingsOf)
		const sorted = (kinds: ReadonlyArray<FindingKind>) => Arr.sort(kinds, Order.String)
		assert.deepEqual(
			Arr.map(checks, (c) => sorted(Arr.map(c.findings, (f) => f.kind))),
			Arr.map(expected, sorted),
			"each schema's findings"
		)
		const markerLines = yield* Effect.forEach(m.schemas, (s) =>
			Effect.gen(function* () {
				const lines: Array<string> = []
				for (const name of yield* foldersOnDisk(r, s)) {
					for (const f of yield* sqlFilesOf(`${directoryOf(r, s)}/${name}`)) {
						for (const marker of findMarkers(f.text)) {
							lines.push(`migrations/${identOf(s.current.name)}/${name}/${f.name}:${marker.line}`)
						}
					}
				}
				return lines
			})
		)
		assert.deepEqual(
			Arr.map(checks, (c) =>
				Arr.sort(
					Arr.flatMap(c.findings, (f) => (f.kind === "placeholder" ? [f.where] : [])),
					Order.String
				)
			),
			Arr.map(markerLines, (lines) => Arr.sort(lines, Order.String)),
			"each placeholder found at its file and line"
		)
		const found = Arr.flatten(expected)
		assert.equal(ran.code, found.length > 0 ? 1 : 0, ran.stderr)
		assert.equal(ran.report.outcome, "ran")
		if (Arr.some(m.schemas, (s) => s.hidden)) {
			r.c.note("a hidden entry ignored")
		}
		if (found.length === 0) {
			r.c.note("check passes")
		}
		for (const kind of checkedKinds) {
			if (Arr.contains(found, kind)) {
				r.c.note(`check finds ${kind}`)
			}
		}
		return took
	})

/** Rewrites every SQL file of every folder of the configured schemas by `edit`. */
const rewriteFolders = (
	r: Workspace,
	m: Model,
	edit: (text: string) => string,
	only: (s: SchemaState, folder: number) => boolean
) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		for (const s of m.schemas) {
			for (const [i, name] of (yield* foldersOnDisk(r, s)).entries()) {
				if (!only(s, i)) {
					continue
				}
				const dir = `${directoryOf(r, s)}/${name}`
				for (const f of yield* sqlFilesOf(dir)) {
					yield* fs.writeFileString(`${dir}/${f.name}`, edit(f.text))
				}
			}
		}
	})

/** A reviewer's value for each placeholder, and the marker lines deleted. */
const resolvePlaceholders = (text: string): string =>
	Str.replaceAll(
		placeholderToken,
		"3"
	)(
		Arr.join(
			Arr.filter(
				Str.split(text, "\n"),
				(l) => !Str.startsWith(placeholderMarker)(Str.trimStart(l))
			),
			"\n"
		)
	)

/** The loss written in: the commented CREATE SCHEMA below its marker uncommented. */
const writeLossIn = (text: string): string =>
	Arr.join(
		Arr.map(Str.split(text, "\n"), (l) =>
			Str.startsWith("-- CREATE SCHEMA ")(l) ? Str.slice("-- ".length)(l) : l
		),
		"\n"
	)

const runReview = (r: Workspace, m: Model) =>
	Effect.gen(function* () {
		r.c.note("the placeholders reviewed")
		yield* rewriteFolders(r, m, resolvePlaceholders, () => true)
		for (const s of m.schemas) {
			for (const name of yield* foldersOnDisk(r, s)) {
				for (const f of yield* sqlFilesOf(`${directoryOf(r, s)}/${name}`)) {
					assert.deepEqual(findMarkers(f.text), [], `${name}/${f.name} reviewed`)
				}
			}
		}
		return took
	})

const runDecide = (r: Workspace, m: Model, i: number) =>
	Effect.gen(function* () {
		r.c.note("the loss decided")
		const target = defined(m.schemas[i], "the schema whose loss is decided")
		yield* rewriteFolders(
			r,
			m,
			writeLossIn,
			(s, folder) =>
				s === target && Option.exists(Arr.get(s.folders, folder), (f) => f.loss === "undecided")
		)
		return took
	})

const runHidden = (r: Workspace, m: Model, i: number) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		yield* fs.writeFileString(`${directoryOf(r, defined(m.schemas[i], "a schema"))}/.DS_Store`, "")
		return took
	})

const runBlock = (r: Workspace, m: Model, i: number, block: boolean) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = directoryOf(r, defined(m.schemas[i], "a schema"))
		if (block) {
			yield* fs.makeDirectory(`${r.dir}/migrations`, { recursive: true })
			yield* fs.writeFileString(path, "not a directory\n")
		} else {
			yield* fs.remove(path)
		}
		return took
	})

const realOf = (
	r: Workspace
): Real<
	Model,
	ProjectParameters,
	Refusal,
	PlatformError.PlatformError | CliError,
	FileSystem.FileSystem | Path.Path
> => ({
	"edit the code": () => Effect.succeed(took),
	"grizzle generate": (p, before, after, verdict) => runGenerate(r, p, before, after, verdict),
	"grizzle check": (_p, before) => runCheck(r, before),
	"review the placeholders": (_p, before) => runReview(r, before),
	"decide the data loss": (i, before) => runDecide(r, before, i),
	"leave a hidden entry": (i, before) => runHidden(r, before, i),
	"make a file of a schema's directory": (i, before) => runBlock(r, before, i, true),
	"remove that file": (i, before) => runBlock(r, before, i, false)
})

layer(NodeServices.layer, { excludeTestServices: true })(
	"the loop over a generated project",
	(it) => {
		it.effect(
			"every command's exit status, refusal and folders are the model's, and what generate writes is the pure generator's draft byte for byte",
			(ctx) =>
				searched(
					ctx,
					explore(
						{
							suite: "unit/cli/project",
							draw: drawn(
								program(machine, { min: 1, max: 12 }, fullSwarm(Struct.keys(machine.commands)))
							),
							literal: Formatter.format,
							oracle: {
								kind: "second-implementation",
								name: "a model of the documented loop, and the pure generator fed the committed snapshot read before each generate"
							},
							coverage: required<ProjectFeature>(projectFeatures, { cases: 120, sense: notesOnly }),
							kept: [],
							runs: 16,
							shrink: { kind: "bounded", candidates: 80 },
							concurrency: 1,
							steerEvery: 16,
							caseHang
						},
						(steps: Program<ProjectParameters>, c) =>
							Effect.scoped(
								Effect.gen(function* () {
									const dir = yield* workspace("project")
									yield* runProgram(machine, realOf({ dir, c }), steps)
								})
							)
					)
				)
		)
	}
)
