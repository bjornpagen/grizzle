import { defect } from "@bjornpagen/grizzle-text/base/invariant"
import {
	isNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray
} from "@bjornpagen/grizzle-text/base/nonempty"
import * as Result from "@bjornpagen/grizzle-text/base/result"
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
import { triggerLawsOver } from "#compiler/laws/model/model.ts"
import { checkedRole, grantedPrivileges, readableRelations } from "#compiler/physical/ddl/roles.ts"
import type { ParamSource } from "#compiler/physical/install/plan.ts"
import { isolationInput, type RoleSource } from "#compiler/program/isolation/input.ts"
import type { SchemaArtifacts } from "#compiler/program/schema.ts"
import {
	type CertifiableEntry,
	type CertifiableRole,
	certifiedRole,
	type ReadCommittedRole,
	type ServableRole,
	serializableChanges,
	type Variants,
	variantsEntries,
	variantsMap
} from "#compiler/program/workload/change.ts"
import type { LockTable, ObjectName } from "#compiler/sql/ast.ts"
import { emitText } from "#compiler/sql/emit.ts"
import { emptyNameMap } from "#compiler/sql/naming.ts"

/**
 * One role of a login as certification reads it (program/isolation/input.ts RoleSource): its login's and its own
 * declared name, its checked schema over the installation's, as the installation reads it to grant it
 * (physical/install/plan.ts planInstallation), no names (each member's facts extracted as it compiled, CertifiableEntry
 * `facts`), and its change members at
 * READ COMMITTED, none where one has no READ COMMITTED form (ReadCommittedRole `unformed`), and `none` where it has no
 * change member, whose writes are unknown (RoleWrites).
 */
const roleSource = (
	artifacts: SchemaArtifacts,
	login: string,
	role: ReadCommittedRole
): Result.Result<
	RoleSource<CheckedSchema<RoleWorld>, undefined, Variants<CertifiableEntry>>,
	CompileError
> =>
	Result.map(checkedRole(artifacts.derived.schema, role.changes.named), (checked) => ({
		login,
		role: role.changes.named.owned.name,
		checked: checked.checked,
		names: undefined,
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

/** Two tables in the order of their qualified names, schema then name: the one order every fenced write locks in. */
const byQualifiedName = (a: ObjectName, b: ObjectName): number =>
	compareStrings(a.schema, b.schema) || compareStrings(a.name, b.name)

/**
 * The facts of one change member's variants (CertifiableEntry `facts`): one set per variant whose flight sends any,
 * holding before lacking, each extracted as its member compiled (program/isolation/member-facts.ts compiledFacts).
 */
const variantsFacts = (variants: Variants<CertifiableEntry>): ReadonlyArray<MemberFacts> =>
	variantsEntries(variants).flatMap((entry) => entry.facts)

/**
 * `entry`'s write with the relations of `fenced` its flight writes, by its facts at its level, locked before its
 * snapshot (runtime/write/flight.ts WriteExclusion): one LOCK TABLE ... IN EXCLUSIVE MODE over their tables in the
 * order of their qualified names, named as a served statement is; `entry` as it is where it writes none.
 */
const exclusionOf = <S extends ParamSource>(
	entry: CertifiableEntry<S>,
	fenced: ReadonlySet<string>,
	role: ServableRole
): CertifiableEntry<S> => {
	const written = new Set(
		entry.facts.flatMap((m) => m.statements.flatMap((s) => s.writes.map((w) => w.relation)))
	)
	const locked = [...written]
		.filter((relation) => fenced.has(relation))
		.map((relation) => ({ relation, table: role.artifacts.names.relation(relation) }))
		.toSorted((a, b) => byQualifiedName(a.table, b.table))
	if (!isNonEmpty(locked)) {
		return entry
	}
	const lock: LockTable = {
		kind: "lockTable",
		tables: mapNonEmpty(locked, (l) => l.table),
		mode: "EXCLUSIVE",
		wait: "wait"
	}
	return {
		...entry,
		compiled: {
			...entry.compiled,
			exclusion: {
				kind: "lock",
				relations: mapNonEmpty(locked, (l) => l.relation),
				text: prepared(emitText(lock, emptyNameMap).text)
			}
		}
	}
}

/** A role's served changes with each of its writes locking what it writes of `fenced`, its login's fences, read off
 * the facts each member's compile extracted (CertifiableEntry `facts`). */
const fencedChanges = <L extends Isolation, S extends ParamSource>(
	role: CertifiableRole<L, S>,
	fenced: ReadonlySet<string>
): CertifiableRole<L, S> => ({
	...role,
	members: new Map(
		[...role.members].map(
			([name, variants]) =>
				[name, variantsMap(variants, (entry) => exclusionOf(entry, fenced, role))] as const
		)
	)
})

/** Each of `as` beside the one of `bs` at its place: the two lists are one per role, in the roles' order. */
const zipped = <A, B>(
	as: ReadonlyArray<A>,
	bs: ReadonlyArray<B>
): ReadonlyArray<readonly [A, B]> => {
	if (as.length !== bs.length) {
		defect("two lists of one entry per role differ in length")
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
 * (ServableRole `level`) is its certificate's, each write of a login that fences a relation it writes locking it before
 * its snapshot, each entry as its served file reads it (program/workload/change.ts servableRole); the fences
 * (analysis/isolation/certify.ts Fence), by login then relation; and each relation a writer that may be a pivot writes,
 * with every such writer (certify.ts PivotWriter), which a read of it runs SERIALIZABLE by.
 */
export interface Certification<S extends ParamSource = ParamSource> {
	readonly certificates: ReadonlyArray<RoleIsolation>
	readonly served: ReadonlyMap<string, ReadonlyMap<string, ServableRole<Isolation, S>>>
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
		readonly source: RoleSource<CheckedSchema<RoleWorld>, undefined, Variants<CertifiableEntry>>
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
	const input = isolationInput({
		model: artifacts.laws,
		roles: sources.map((r) => r.source),
		triggerLawsOver,
		grantedPrivileges,
		readableRelations,
		memberFacts: (_name, variants) => variantsFacts(variants)
	})
	const certified = certify(
		input.relations,
		zipped(sources, input.roles).map(
			([{ role: compiled }, role]): Candidate<
				CertifiableRole<"readCommitted", S>,
				CertifiableRole<"serializable", S>,
				CompileError
			> => {
				const lowering = (lowered: CertifiableRole<"serializable", S>) => ({
					facts: [...lowered.members.values()].flatMap(variantsFacts),
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
	const served = new Map<string, Map<string, ServableRole<Isolation, S>>>()
	for (const c of certified.value.roles) {
		const logged = served.getOrInsertComputed(
			c.role.login,
			() => new Map<string, ServableRole<Isolation, S>>()
		)
		const relations = fenced.get(c.role.login)
		logged.set(
			c.role.role,
			certifiedRole(relations === undefined ? c.form : fencedChanges(c.form, relations))
		)
	}
	return Result.ok({
		certificates: certified.value.roles.map(isolationOf),
		served,
		fences: certified.value.fences,
		pivots: certified.value.pivots
	})
}
