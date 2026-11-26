/**
 * A compiled write's isolation facts (analysis/isolation/facts.ts MemberFacts), extracted from the statements its flight
 * may send (extract.ts memberFacts), read back by its role's names (ExtractNames), at the level it was compiled for:
 * what certification compares of it (program/isolation/certification.ts), extracted once, as its member compiles
 * (program/workload/change.ts certifiableEntry), so nothing holds its statements' ASTs past its compile.
 */
import { defect, defined } from "@bjornpagen/grizzle-text/base/invariant"
import { isNonEmpty, mapNonEmpty } from "@bjornpagen/grizzle-text/base/nonempty"
import * as Result from "@bjornpagen/grizzle-text/base/result"
import { type ReadonlyTupleMap, TupleMap, TupleSet } from "@bjornpagen/grizzle-text/base/tuple-map"
import type { MemberFacts } from "#compiler/analysis/isolation/facts.ts"
import { catchRefusal, unwrap } from "#compiler/core/canonical.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import type { ParamId } from "#compiler/core/ids.ts"
import { headsOf } from "#compiler/ir/instant.ts"
import type { NativeColumn, NativeObject } from "#compiler/ir/law.ts"
import { evidenceCatalog } from "#compiler/laws/model/catalog.ts"
import type {
	ArrayPart,
	RelationColumn,
	WriteParamSlot
} from "#compiler/lower/conservative/types.ts"
import { libraryRef, tablelessLibrary } from "#compiler/physical/ddl/library.ts"
import type { NamedRole } from "#compiler/physical/ddl/names.ts"
import {
	entryMembership,
	entryProbes,
	holdMembership,
	type Membership,
	type MembershipContext,
	ownerHolds,
	roleWrites
} from "#compiler/physical/ddl/roles.ts"
import { lowerDefinition } from "#compiler/physical/derived/definition.ts"
import {
	argumentColumn,
	argumentsRow,
	type Definition,
	type ExtractNames,
	memberFacts,
	policyRow,
	type SlotFill
} from "#compiler/program/isolation/extract.ts"
import type { ArtifactsWorld, SchemaArtifacts } from "#compiler/program/schema.ts"
import { reachOf } from "#compiler/runtime/write/steps.ts"
import type { Expr, SqlStatement } from "#compiler/sql/ast.ts"
import { col } from "#compiler/sql/build.ts"
import { fieldColumns } from "#compiler/write/defined.ts"
import { filterReadsOther, renderMembership, renderProbes } from "#compiler/write/entry/render.ts"
import { probeParams } from "#compiler/write/insert/unique.ts"
import type { ArtifactStatement } from "#compiler/write/program/artifact.ts"
import type { CompiledWrite } from "#compiler/write/program/compile.ts"
import { refusalFunction } from "#compiler/write/refusal.ts"

/** The forms one statement may be sent in: its own, and its whole-relation form where an execution may choose it. */
const sentForms = (statement: ArtifactStatement): ReadonlyArray<SentStatement> =>
	statement.forms.kind === "chosen"
		? [
				{ ast: statement.ast, slots: statement.spec.paramSlots },
				{ ast: statement.forms.large.ast, slots: statement.forms.large.params }
			]
		: [{ ast: statement.ast, slots: statement.spec.paramSlots }]

/** One form of a statement a flight may send: its AST, and what fills each of its placeholders, $n the slot n - 1. */
interface SentStatement {
	readonly ast: SqlStatement
	readonly slots: ReadonlyArray<WriteParamSlot>
}

/**
 * Every statement a compiled write's flight may send, in the order it sends them (adapter/apply/run.ts):
 * its write statements, each in every form an execution may send (write/program/served.ts projectWrite), then its
 * read-backs', which run in the change's own transaction at its level: a read-back riding a write statement is parts
 * of that statement's own forms (write/program/artifact.ts ReadBackCarried), and sends nothing of its own. A staged
 * statement reads its nested rows from carriers in place of its arrays and reads the stored relations its inline form
 * reads (write/program/staged.ts), so its inline form stands for it. A statement
 * that reaches only the call's parameters, the admission, reads no relation and writes nothing (runtime/write/steps.ts
 * reachOf).
 */
const flightStatements = (compiled: CompiledWrite): ReadonlyArray<SentStatement> => [
	...compiled.artifact.statements
		.filter((s) => s.step.kind !== "readBack" && reachOf(s.step) === "state")
		.flatMap(sentForms),
	...compiled.artifact.readBacks.flatMap((r) =>
		r.carried.kind === "sent" ? sentForms(r.carried.statement) : []
	)
]

/**
 * What fills a placeholder, as the extractor reads it (extract.ts SlotFill): a declared scalar's parameter, by its
 * name; a relation parameter's or a member slot's array of one column, that field of its input's heading; and any other
 * array, a stratum's nested rows' or an input's count.
 */
const slotFill = (slot: WriteParamSlot | undefined): SlotFill => {
	if (slot === undefined) {
		throw defect("a placeholder its statement allocates no slot for")
	}
	switch (slot.kind) {
		case "scalar":
			return { kind: "param", name: slot.param }
		case "relation":
			return inputFill(slot.param, slot.columns, slot.part)
		case "member":
			return inputFill(slot.slot, slot.columns, slot.part)
		case "nestedRows":
			return { kind: "rows" }
	}
}

/** The fill of one array of a relation input: its column's field, or, for its count, none. */
const inputFill = (
	parameter: ParamId,
	columns: ReadonlyArray<RelationColumn>,
	part: ArrayPart
): SlotFill => {
	if (part.kind === "count") {
		return { kind: "rows" }
	}
	const column = columns[part.index]
	if (column === undefined) {
		throw defect("an input's array of a column its input holds")
	}
	return { kind: "input", parameter, field: column.name }
}

/**
 * How the extractor reads a role's statements back (program/isolation/extract.ts ExtractNames), from the names its
 * artifacts give the installation's objects:
 *
 * - a stored relation's table and a stored derived relation's table are that relation, a table the role reads
 *   under a row policy of its own among them;
 * - the role's view of a whole entry is its relation; a view of a query entry is its definition (roleWorld);
 * - a column of a stored relation's table is its field, and none of a law column;
 * - the refusal function, each closed relation's constant functions, each library function whose definition reads no
 *   table (physical/ddl/library.ts tablelessLibrary, a text's digest among them), each declared function and each head's
 *   stamp function read no table: a declared function runs as the installation's function owner, which holds no
 *   privilege on any table or view, so a read of one fails its call with 42501 (physical/ddl/functions.ts); a stamp
 *   function writes and reads only its head's table, which no relation names, and returns each child's stamp, a value
 *   its call takes as it takes the clock's (physical/ddl/stamps.ts); a world function is its body (roleWorld); any
 *   other function may read any;
 * - the role's row policies are its own (roleWorld);
 * - the objects an ON CONFLICT with no target arbitrates on a relation's table are its primary key's, each UNIQUE's and
 *   each span key's natives, each by the columns of its fields.
 *
 * Every name the extractor meets that these do not name is a reason the certifier refuses, never a pass. A role's world
 * is rendered as the installation renders it, which refuses it where its rendering does.
 */
export const extractNames = (role: {
	readonly named: NamedRole
	readonly artifacts: SchemaArtifacts
}): Result.Result<ExtractNames, CompileError> => {
	const { artifacts } = role
	const owned = role.named.owned
	const names = artifacts.names
	const tabled = new Set([
		...Object.values(artifacts.owned.relations).flatMap((r) =>
			r.kind === "relation" ? [r.name] : []
		),
		...artifacts.derived.order.map((a) => a.name)
	])
	const relations = new TupleMap<readonly [string, string], string>()
	for (const name of tabled) {
		const table = names.relation(name)
		relations.set([table.schema, table.name], name)
	}
	const world = artifacts.world
	const read =
		world.kind === "role"
			? catchRefusal(() => roleWorld(role.named, artifacts, world))
			: Result.ok(noWorld)
	if (!read.ok) {
		return read
	}
	const { functions, policies, definitions } = read.value
	if (world.kind === "role") {
		for (const entry of Object.values(owned.relations)) {
			if (entry.kind === "whole" && tabled.has(entry.relation.name)) {
				const view = world.names.view(entry.name)
				relations.set([view.schema, view.name], entry.relation.name)
			}
		}
	}
	const columns = new TupleMap<readonly [string, string], string>()
	const refuse = refusalFunction(names.schema)
	const noTable = new TupleSet<readonly [string, string]>().add([refuse.schema, refuse.name])
	for (const fn of tablelessLibrary) {
		const ref = libraryRef(names.schema, fn)
		noTable.add([ref.schema, ref.name])
	}
	for (const fn of Object.keys(artifacts.owned.functions)) {
		const { ref } = names.declaredFunction(fn)
		noTable.add([ref.schema, ref.name])
	}
	for (const [name, r] of Object.entries(artifacts.owned.relations)) {
		if (r.kind === "relation") {
			for (const field of Object.values(r.fields)) {
				columns.set([name, names.column(name, field.name)], field.name)
			}
		} else if (r.kind === "closedRelation") {
			for (const fn of names.closed(name).functions) {
				noTable.add([fn.schema, fn.name])
			}
		}
	}
	for (const head of headsOf(artifacts.laws.theory.instants)) {
		const stamp = names.stamp(head.relation, head.field.name)
		noTable.add([stamp.schema, stamp.name])
	}
	const arbiters = new Map<string, Array<ReadonlyArray<string>>>()
	for (const { object } of artifacts.laws.natives) {
		const arbiter = arbiterOf(object)
		if (arbiter === undefined) {
			continue
		}
		const held = arbiters.getOrInsertComputed(arbiter.relation, () => [])
		held.push(arbiter.fields.map((field) => names.column(arbiter.relation, field)))
	}
	return Result.ok({
		relationOf: (table) => relations.get([table.schema, table.name]),
		fieldOf: (relation, column) => columns.get([relation, column]),
		readsNoTable: (fn) => noTable.has([fn.schema, fn.name]),
		bodyOf: (fn) => functions.get([fn.schema, fn.name]),
		policyOf: (table) => policies.get([table.schema, table.name]),
		definitionOf: (view) => definitions.get([view.schema, view.name]),
		arbitersOf: (relation) => arbiters.get(relation) ?? []
	})
}

/** An installed object by its schema and its name. */
type Qualified = readonly [string, string]

/**
 * What a role's statements read beyond their text (ExtractNames `bodyOf`, `policyOf`, `definitionOf`), each object by
 * its schema and its name: each world function's body, each row policy's predicate and each query entry's view's
 * definition.
 */
interface RoleWorldReads {
	readonly functions: ReadonlyTupleMap<Qualified, Expr>
	readonly policies: ReadonlyTupleMap<Qualified, Expr>
	readonly definitions: ReadonlyTupleMap<Qualified, Definition>
}

/** Reality's: no role, so no world function, row policy or role view. */
const noWorld: RoleWorldReads = {
	functions: new TupleMap(),
	policies: new TupleMap(),
	definitions: new TupleMap()
}

/**
 * What the role `named` installs that its statements read beyond their text, rendered as the installation renders each
 * (physical/ddl/roles.ts addRole), over its base checked, its installed names and its catalog (laws/model/catalog.ts
 * evidenceCatalog), the installation's own:
 *
 * - each writable entry's world functions, its filter function where its filter reads another relation, its body the
 *   entry's membership (write/entry/render.ts renderMembership), and each key and unique probe (physical/ddl/roles.ts
 *   entryProbes), its body renderProbes's, each over its arguments (extract.ts argumentsRow), in its parameters' order;
 * - each table the role's row policy narrows, its own writable entry's target (physical/ddl/roles.ts entryMembership)
 *   and the owner of each family whose member it writes through no entry of the owner (holdMembership), with the
 *   policy's predicate over its row (extract.ts policyRow);
 * - each query entry's view, by its name in the role's schema, with its definition (physical/derived/definition.ts
 *   lowerDefinition) and its columns, each a heading column's: the view's every row is its definition's, the decoded
 *   name of a closed id beside its code read from a constant, which reads no table.
 */
const roleWorld = (
	named: NamedRole,
	artifacts: SchemaArtifacts,
	world: Extract<ArtifactsWorld, { readonly kind: "role" }>
): RoleWorldReads => {
	const names = artifacts.names
	const model = artifacts.laws
	const role = world.role
	const cx: MembershipContext = {
		checked: world.checked.world.base,
		catalog: evidenceCatalog(artifacts)
	}
	const argument = (position: number): Expr => col(argumentsRow, argumentColumn(position))
	const functions = new TupleMap<Qualified, Expr>()
	const policies = new TupleMap<Qualified, Expr>()
	const policed = (relation: string, membership: Membership): void => {
		if (membership.kind === "narrowed") {
			const table = names.relation(relation)
			policies.set(
				[table.schema, table.name],
				membership.over((f) => col(policyRow, names.column(relation, f.name)))
			)
		}
	}
	const written = roleWrites(world.checked.world)
	const writers = new Map<string, { readonly entry: string; readonly membership: Membership }>()
	for (const w of written) {
		const relation = w.relation.name
		const membership = entryMembership(names, cx, named.theory, w)
		writers.set(relation, { entry: `${role.name}.${w.write.name}`, membership })
		policed(relation, membership)
		const e = w.write
		if (e.kind === "whole") {
			continue
		}
		const writable = e.writable
		if (filterReadsOther(writable)) {
			const fn = world.names.filterFunction(e.name, [])
			functions.set(
				[fn.schema, fn.name],
				unwrap(
					renderMembership(writable, {
						schema: cx.checked,
						names,
						catalog: cx.catalog,
						row: (_, position) => argument(position)
					})
				)
			)
		}
		const probed = unwrap(
			renderProbes(writable, {
				schema: cx.checked,
				names,
				catalog: cx.catalog,
				dag: model.theory.dag,
				table: names.relation(relation),
				column: (f) => names.column(relation, f.name)
			})
		)
		for (const probe of entryProbes(model, role, { write: e, relation: w.relation })) {
			const fn = world.names.probe(e.name, probe, [])
			functions.set(
				[fn.schema, fn.name],
				probed(probe, fieldColumns(probeParams(probe), (_, position) => argument(position)).of)
			)
		}
	}
	for (const hold of ownerHolds(model, written)) {
		if (!writers.has(hold.owner.name)) {
			policed(
				hold.owner.name,
				holdMembership(names, role, hold, (member) =>
					defined(writers.get(member), `the writer of ${member}, a member ${role.name} writes`)
				)
			)
		}
	}
	const definitions = new TupleMap<Qualified, Definition>()
	for (const e of world.checked.entries) {
		if (e.kind !== "world") {
			continue
		}
		const view = world.names.view(e.entry.name)
		definitions.set([view.schema, view.name], {
			query: unwrap(
				lowerDefinition(`${role.name}.${e.entry.name}`, e.analysis.query, {
					names,
					catalog: cx.catalog,
					rows: world.checked.world.base.rows(world.checked.writable)
				})
			).query,
			columns: e.analysis.heading.map((c) => identifierOf(identity.column(c.name)))
		})
	}
	return { functions, policies, definitions }
}

/** The fields of a native's columns, its law columns left out. */
const fieldNames = (columns: ReadonlyArray<NativeColumn>): ReadonlyArray<string> =>
	columns.flatMap((column) => (column.kind === "field" ? [column.field.name] : []))

/**
 * The relation and fields of a native an ON CONFLICT with no target arbitrates by (sql/ast.ts OnConflict `every`): a
 * primary key, a UNIQUE or a span key; none for any other native.
 */
const arbiterOf = (
	object: NativeObject
): { readonly relation: string; readonly fields: ReadonlyArray<string> } | undefined => {
	if (object.kind === "PrimaryKey") {
		return { relation: object.relation.name, fields: object.columns.map((f) => f.name) }
	}
	if (object.kind === "Unique") {
		return { relation: object.relation.name, fields: fieldNames(object.columns) }
	}
	return object.kind === "WithoutOverlaps"
		? { relation: object.relation.name, fields: fieldNames([...object.key.scalars, object.span]) }
		: undefined
}

/**
 * The facts of `write`, a compiled write of change member `name`, at the level it was compiled for (extract.ts
 * memberFacts), read back by `names`: one set, or none where its flight sends no statement.
 */
export const compiledFacts = (
	name: string,
	write: CompiledWrite,
	names: ExtractNames
): ReadonlyArray<MemberFacts> => {
	const sent = flightStatements(write)
	return isNonEmpty(sent)
		? [
				memberFacts(
					name,
					mapNonEmpty(sent, (s) => s.ast),
					names,
					(statement, n) => slotFill(sent[statement]?.slots[n - 1]),
					write.level
				)
			]
		: []
}
