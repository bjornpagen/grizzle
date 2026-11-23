import { defect } from "@bjornpagen/grizzle-text/base/invariant"
import {
	isNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray
} from "@bjornpagen/grizzle-text/base/nonempty"
import * as Result from "@bjornpagen/grizzle-text/base/result"
import { TupleMap, TupleSet } from "@bjornpagen/grizzle-text/base/tuple-map"
import {
	type Candidate,
	certify,
	type Fence,
	isolationOf,
	type PivotWriter
} from "#compiler/analysis/isolation/certify.ts"
import type { MemberFacts } from "#compiler/analysis/isolation/facts.ts"
import type { CheckedSchema, RoleWorld } from "#compiler/analysis/schema.ts"
import type { RoleIsolation } from "#compiler/core/certificate.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import type { Isolation } from "#compiler/core/isolation.ts"
import { compareStrings } from "#compiler/core/order.ts"
import { prepared } from "#compiler/core/prepared.ts"
import { headsOf } from "#compiler/ir/instant.ts"
import type { NativeColumn, NativeObject } from "#compiler/ir/law.ts"
import { triggerLawsOver } from "#compiler/laws/model/model.ts"
import type { WriteParamSlot } from "#compiler/lower/conservative/types.ts"
import { libraryRef, tablelessLibrary } from "#compiler/physical/ddl/library.ts"
import { checkedRole, grantedPrivileges, readableRelations } from "#compiler/physical/ddl/roles.ts"
import type { ParamSource } from "#compiler/physical/install/plan.ts"
import {
	type ExtractNames,
	memberFacts,
	type RetiredTable
} from "#compiler/program/isolation/extract.ts"
import { isolationInput, type RoleSource } from "#compiler/program/isolation/input.ts"
import type { SchemaArtifacts } from "#compiler/program/schema.ts"
import {
	type CompiledVariants,
	type ReadCommittedRole,
	type RoleChanges,
	serializableChanges
} from "#compiler/program/workload/change.ts"
import { reachOf } from "#compiler/runtime/write/steps.ts"
import { releasesOf } from "#compiler/schema/own.ts"
import type { LockTable, ObjectName, SqlStatement } from "#compiler/sql/ast.ts"
import { emitText } from "#compiler/sql/emit.ts"
import { emptyNameMap } from "#compiler/sql/naming.ts"
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

/** Every compiled write of a ChangeSet's variants, holding before lacking. */
const variantWrites = (variants: CompiledVariants): ReadonlyArray<CompiledWrite> =>
	variants.kind === "form"
		? [variants.entry.compiled]
		: [...variantWrites(variants.holding), ...variantWrites(variants.lacking)]

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
const extractNames = (role: RoleChanges): ExtractNames => {
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
 * One role of a login as certification reads it (program/isolation/input.ts RoleSource): its login's and its own
 * declared name, its checked schema over the installation's, as the installation reads it to grant it
 * (physical/install/plan.ts planInstallation), the names its statements are read back by, and its change members at
 * READ COMMITTED, none where one has no READ COMMITTED form (ReadCommittedRole `unformed`), and `none` where it has no
 * change member, whose writes are unknown (RoleWrites).
 */
const roleSource = (
	artifacts: SchemaArtifacts,
	login: string,
	role: ReadCommittedRole
): Result.Result<
	RoleSource<CheckedSchema<RoleWorld>, ExtractNames, CompiledVariants>,
	CompileError
> =>
	Result.map(checkedRole(artifacts.derived.schema, role.changes.named), (checked) => ({
		login,
		role: role.changes.named.owned.name,
		checked: checked.checked,
		names: extractNames(role.changes),
		members:
			role.changes.members.size === 0
				? { kind: "none" }
				: {
						kind: "served",
						members:
							role.kind === "formed"
								? [...role.changes.members].map(([name, compiled]) => ({ name, compiled }))
								: []
					}
	}))

/**
 * The facts of the compiled writes certification reads (extract.ts memberFacts), each extracted once, where it is first
 * read, and read from here after: by the round that judges its role (isolationInput, each lowering) and by the fence
 * that locks what it writes (exclusionOf). One per certification, over the writes its roles are served, each a write of
 * one change member of one role, read back by that role's names and at the level it was compiled for, its own
 * (CompiledWrite `level`). Its facts are plain data (analysis/isolation/facts.ts): no walk of its statements, no
 * statement and no compiled write is held by them.
 */
class WriteFacts {
	readonly #facts = new Map<CompiledWrite, ReadonlyArray<MemberFacts>>()

	/** The facts of `write`, of change member `name`, read back by `names`: none where its flight sends no statement. */
	of(name: string, write: CompiledWrite, names: ExtractNames): ReadonlyArray<MemberFacts> {
		return this.#facts.getOrInsertComputed(write, () => extractedFacts(name, write, names))
	}

	/** The facts of one change member's variants: one set per variant whose flight sends any. */
	ofChange(
		name: string,
		variants: CompiledVariants,
		names: ExtractNames
	): ReadonlyArray<MemberFacts> {
		return variantWrites(variants).flatMap((write) => this.of(name, write, names))
	}
}

/** The facts of one compiled write of change member `name` at its level (extract.ts memberFacts), none where its flight
 * sends no statement: extracted afresh, which WriteFacts does once per write. */
const extractedFacts = (
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

/** Two tables in the order of their qualified names, schema then name: the one order every fenced write locks in. */
const byQualifiedName = (a: ObjectName, b: ObjectName): number =>
	compareStrings(a.schema, b.schema) || compareStrings(a.name, b.name)

/**
 * `write` of change member `name` with the relations of `fenced` its flight writes, by its facts at its level, locked
 * before its snapshot (runtime/write/flight.ts WriteExclusion): one LOCK TABLE ... IN EXCLUSIVE MODE over their tables
 * in the order of their qualified names, named as a served statement is; `write` as it is where it writes none.
 */
const exclusionOf = (
	name: string,
	write: CompiledWrite,
	fenced: ReadonlySet<string>,
	role: RoleChanges,
	names: ExtractNames,
	facts: WriteFacts
): CompiledWrite => {
	const written = new Set(
		facts
			.of(name, write, names)
			.flatMap((m) => m.statements.flatMap((s) => s.writes.map((w) => w.relation)))
	)
	const locked = [...written]
		.filter((relation) => fenced.has(relation))
		.map((relation) => ({ relation, table: role.artifacts.names.relation(relation) }))
		.toSorted((a, b) => byQualifiedName(a.table, b.table))
	if (!isNonEmpty(locked)) {
		return write
	}
	const lock: LockTable = {
		kind: "lockTable",
		tables: mapNonEmpty(locked, (l) => l.table),
		mode: "EXCLUSIVE",
		wait: "wait"
	}
	return {
		...write,
		exclusion: {
			kind: "lock",
			relations: mapNonEmpty(locked, (l) => l.relation),
			text: prepared(emitText(lock, emptyNameMap).text)
		}
	}
}

/** A change member's variants, each compiled write locking what it writes of `fenced` (exclusionOf). */
const fencedVariants = <S extends ParamSource>(
	name: string,
	variants: CompiledVariants<S>,
	fenced: ReadonlySet<string>,
	role: RoleChanges,
	names: ExtractNames,
	facts: WriteFacts
): CompiledVariants<S> =>
	variants.kind === "form"
		? {
				...variants,
				entry: {
					...variants.entry,
					compiled: exclusionOf(name, variants.entry.compiled, fenced, role, names, facts)
				}
			}
		: {
				...variants,
				holding: fencedVariants(name, variants.holding, fenced, role, names, facts),
				lacking: fencedVariants(name, variants.lacking, fenced, role, names, facts)
			}

/** A role's served changes with each of its writes locking what it writes of `fenced`, its login's fences, read off
 * the facts certification extracted of it (WriteFacts). */
const fencedChanges = <L extends Isolation, S extends ParamSource>(
	role: RoleChanges<L, S>,
	fenced: ReadonlySet<string>,
	names: ExtractNames,
	facts: WriteFacts
): RoleChanges<L, S> => ({
	...role,
	members: new Map(
		[...role.members].map(
			([name, variants]) =>
				[name, fencedVariants(name, variants, fenced, role, names, facts)] as const
		)
	)
})

/** Each of `as` beside the one of `bs` at its place: the two lists are one per role, in the roles' order. */
const zipped = <A, B>(
	as: ReadonlyArray<A>,
	bs: ReadonlyArray<B>
): ReadonlyArray<readonly [A, B]> => {
	if (as.length !== bs.length) {
		throw defect("two lists of one entry per role differ in length")
	}
	return as.flatMap((a, i): ReadonlyArray<readonly [A, B]> => {
		const b = bs[i]
		return b === undefined ? [] : [[a, b]]
	})
}

/**
 * Every role's certificate, by login and role in the order given, and the changes each is served, compiled for its
 * certificate's level: its READ COMMITTED form where it runs READ COMMITTED, and its SERIALIZABLE form
 * (program/workload/change.ts serializableChanges) where it runs SERIALIZABLE, so a served form's level
 * (RoleChanges.level) is its certificate's, each write of a login that fences a relation it writes locking it before
 * its snapshot; the fences (analysis/isolation/certify.ts Fence), by login then relation; and each relation a writer
 * that may be a pivot writes, with every such writer (certify.ts PivotWriter), which a read of it runs SERIALIZABLE by.
 */
export interface Certification<S extends ParamSource = ParamSource> {
	readonly certificates: ReadonlyArray<RoleIsolation>
	readonly served: ReadonlyMap<string, ReadonlyMap<string, RoleChanges<Isolation, S>>>
	readonly fences: ReadonlyArray<Fence>
	readonly pivots: ReadonlyMap<string, NonEmptyReadonlyArray<PivotWriter>>
}

/**
 * The certificate of every role of every login (analysis/isolation/certify.ts certify), from the installation's facts
 * over its artifacts `artifacts`, the configured schema's over every relation, and each login's roles with their change
 * members compiled for READ COMMITTED (program/workload/change.ts readCommittedChanges), by the login's name: each relation's
 * facts from the law model, each role's privileges as its grants hold them (physical/ddl/roles.ts grantedPrivileges),
 * and each change member's facts read from every statement each of its variants' flights may send, at the level they
 * were compiled for (extract.ts memberFacts). A role certifies READ COMMITTED only when the certifier proves it from
 * these; a variant that sends no statement has no facts.
 *
 * A role is served the form its level chooses, so the certificate is read from the statements served: the certifier
 * judges every role over its READ COMMITTED form, and lowers each role it leaves SERIALIZABLE to its SERIALIZABLE form
 * (serializableChanges), whose facts it judges the others by from then on. A role with a member that has no READ
 * COMMITTED form is compiled for SERIALIZABLE alone, and runs SERIALIZABLE by the condition `form` from the first round.
 */
export const certification = <S extends ParamSource>(
	artifacts: SchemaArtifacts,
	changes: ReadonlyMap<string, ReadonlyMap<string, ReadCommittedRole<S>>>
): Result.Result<Certification<S>, CompileError> => {
	const sources: Array<{
		readonly role: ReadCommittedRole<S>
		readonly source: RoleSource<CheckedSchema<RoleWorld>, ExtractNames, CompiledVariants>
	}> = []
	for (const [login, logged] of changes) {
		for (const role of logged.values()) {
			const source = roleSource(artifacts, login, role)
			if (!source.ok) {
				return source
			}
			sources.push({ role, source: source.value })
		}
	}
	const extracted = new WriteFacts()
	const input = isolationInput({
		model: artifacts.laws,
		roles: sources.map((r) => r.source),
		triggerLawsOver,
		grantedPrivileges,
		readableRelations,
		memberFacts: (name, variants, names) => extracted.ofChange(name, variants, names)
	})
	const certified = certify(
		input.relations,
		zipped(sources, input.roles).map(
			([{ role: compiled, source }, role]): Candidate<
				RoleChanges<"readCommitted", S>,
				RoleChanges<"serializable", S>,
				CompileError
			> => {
				const lowering = (lowered: RoleChanges<"serializable", S>) => ({
					facts: [...lowered.members].flatMap(([name, variants]) =>
						extracted.ofChange(name, variants, source.names)
					),
					form: lowered
				})
				return compiled.kind === "formed"
					? {
							kind: "formed",
							role,
							readCommitted: compiled.changes,
							lower: () => Result.map(serializableChanges(compiled.changes), lowering)
						}
					: {
							kind: "unformed",
							role,
							unformed: compiled.unformed,
							lowering: lowering(compiled.changes)
						}
			}
		)
	)
	if (!certified.ok) {
		return certified
	}
	const fenced = new Map<string, Set<string>>()
	for (const f of certified.value.fences) {
		const relations = fenced.getOrInsertComputed(f.login, () => new Set<string>())
		relations.add(f.relation)
	}
	const served = new Map<string, Map<string, RoleChanges<Isolation, S>>>()
	for (const [c, { source }] of zipped(certified.value.roles, sources)) {
		const logged = served.getOrInsertComputed(
			c.role.login,
			() => new Map<string, RoleChanges<Isolation, S>>()
		)
		const relations = fenced.get(c.role.login)
		logged.set(
			c.role.role,
			relations === undefined ? c.form : fencedChanges(c.form, relations, source.names, extracted)
		)
	}
	return Result.ok({
		certificates: certified.value.roles.map(isolationOf),
		served,
		fences: certified.value.fences,
		pivots: certified.value.pivots
	})
}
