/**
 * A compiled write's isolation facts (analysis/isolation/facts.ts MemberFacts), extracted from the statements its flight
 * may send (extract.ts memberFacts), read back by its role's names (ExtractNames), at the level it was compiled for:
 * what certification compares of it (program/isolation/certification.ts), extracted once, as its member compiles
 * (program/workload/change.ts certifiableEntry), so nothing holds its statements' ASTs past its compile.
 */
import { isNonEmpty, mapNonEmpty } from "@bjornpagen/grizzle-text/base/nonempty"
import { TupleMap, TupleSet } from "@bjornpagen/grizzle-text/base/tuple-map"
import type { MemberFacts } from "#compiler/analysis/isolation/facts.ts"
import { headsOf } from "#compiler/ir/instant.ts"
import type { NativeColumn, NativeObject } from "#compiler/ir/law.ts"
import type { WriteParamSlot } from "#compiler/lower/conservative/types.ts"
import { libraryRef, tablelessLibrary } from "#compiler/physical/ddl/library.ts"
import type { NamedRole } from "#compiler/physical/ddl/names.ts"
import {
	type ExtractNames,
	memberFacts,
	type RetiredTable
} from "#compiler/program/isolation/extract.ts"
import type { SchemaArtifacts } from "#compiler/program/schema.ts"
import { reachOf } from "#compiler/runtime/write/steps.ts"
import { releasesOf } from "#compiler/schema/own.ts"
import type { SqlStatement } from "#compiler/sql/ast.ts"
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
 * Every statement a compiled write's flight may send, in the order it sends them (adapter/apply/run.ts), but its holds:
 * its write statements, each in every form an execution may send (write/program/served.ts projectWrite), then its
 * read-backs', which run in the change's own transaction at its level: a read-back riding a write statement is parts
 * of that statement's own forms (write/program/artifact.ts ReadBackCarried), and sends nothing of its own. A staged
 * statement reads its nested rows from carriers in place of its arrays and reads the stored relations its inline form
 * reads (write/program/staged.ts), so its inline form stands for it. A hold (write/hold/statement.ts) states no fact: it reads only its unit's header, whose key no
 * call changes, and its lock keeps every group the call states unretired until the call ends, so each body's rows are,
 * for the call, an insert-only relation's, which is how the certifier reads them (analysis/isolation/certify.ts, a
 * retirement no change); a read fact of it would cut the clean prefix the reads after it are sealed by. A statement
 * that reaches only the call's parameters, the admission, reads no relation and writes nothing (runtime/write/steps.ts
 * reachOf).
 */
const flightStatements = (compiled: CompiledWrite): ReadonlyArray<SentStatement> => [
	...compiled.artifact.statements
		.filter(
			(s) => s.step.kind !== "readBack" && s.step.kind !== "hold" && reachOf(s.step) === "state"
		)
		.flatMap(sentForms),
	...compiled.artifact.readBacks.flatMap((r) =>
		r.carried.kind === "sent" ? sentForms(r.carried.statement) : []
	)
]

/** The declared parameter a placeholder's slot carries when it is a scalar's, none for any other slot or no slot. */
const scalarParam = (slot: WriteParamSlot | undefined): string | undefined =>
	slot?.kind === "scalar" ? slot.param : undefined

/**
 * How the extractor reads a role's statements back (program/isolation/extract.ts ExtractNames), from the names its
 * artifacts give the installation's objects:
 *
 * - a stored relation's table and a materialized derived relation's view are that relation, but a table the role writes
 *   under a row policy that reads another relation's table (a write entry whose filter reads others), whose reads no
 *   statement shows, is none;
 * - the role's view of a whole entry is its relation; a view of a query entry is none, its definition's reads being
 *   the view's own;
 * - a column of a stored relation's table is its field, and none of a law column;
 * - the refusal function, each closed relation's constant functions, each library function whose definition reads no
 *   table (physical/ddl/library.ts tablelessLibrary, a text's digest among them), each declared function and each head's
 *   stamp function read no table: a declared function runs as the installation's function owner, which holds no
 *   privilege on any table or view, so a read of one fails its call with 42501 (physical/ddl/functions.ts); a stamp
 *   function writes and reads only its head's table, which no relation names, and returns each child's stamp, a value
 *   its call takes as it takes the clock's (physical/ddl/stamps.ts); a retirable unit's retirement function writes its
 *   header's and its bodies' tables by a retirement; any other function may read any;
 * - the objects an ON CONFLICT with no target arbitrates on a relation's table are its primary key's, each UNIQUE's and
 *   each span key's natives, each by the columns of its fields.
 *
 * Every name the extractor meets that these do not name is a reason the certifier refuses, never a pass.
 */
export const extractNames = (role: {
	readonly named: NamedRole
	readonly artifacts: SchemaArtifacts
}): ExtractNames => {
	const { artifacts } = role
	const owned = role.named.owned
	const names = artifacts.names
	const stored = Object.entries(artifacts.owned.relations)
	const policed = new Set(
		[...owned.writes.values()].flatMap((w) =>
			w.kind !== "whole" && w.writable.filter.kind === "query" && w.writable.filter.readsOther
				? [w.writable.target]
				: []
		)
	)
	const tabled = new Set(
		stored.flatMap(([name, r]) =>
			(r.kind === "relation" && !policed.has(name)) ||
			(r.kind === "derived" && r.view.kind !== "live")
				? [name]
				: []
		)
	)
	const relations = new TupleMap<readonly [string, string], string>()
	for (const name of tabled) {
		const table = names.relation(name)
		relations.set([table.schema, table.name], name)
	}
	const world = artifacts.world
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
	for (const [name, r] of stored) {
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
	const retirements = new TupleMap<readonly [string, string], ReadonlyArray<RetiredTable>>()
	for (const st of owned.base.statements) {
		if (st.kind !== "retirable") {
			continue
		}
		const fn = names.retire(st.header.relation)
		const bodies = st.bodies.map((b) => b.relation)
		retirements.set(
			[fn.schema, fn.name],
			[
				...[st.header.relation, ...bodies].map((r): RetiredTable => ({
					table: names.relation(r),
					op: "retire"
				})),
				...releasesOf(owned.base.statements, bodies).flatMap((r) =>
					r.target.map((side): RetiredTable => ({
						table: names.relation(side.relation),
						op: "delete"
					}))
				)
			]
		)
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
	return {
		relationOf: (table) => relations.get([table.schema, table.name]),
		fieldOf: (relation, column) => columns.get([relation, column]),
		readsNoTable: (fn) => noTable.has([fn.schema, fn.name]),
		retirementOf: (fn) => retirements.get([fn.schema, fn.name]),
		arbitersOf: (relation) => arbiters.get(relation) ?? []
	}
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
					(statement, n) => scalarParam(sent[statement]?.slots[n - 1]),
					write.level
				)
			]
		: []
}
