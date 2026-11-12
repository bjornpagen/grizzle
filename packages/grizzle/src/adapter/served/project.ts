import { Array as Arr, Order, Record as Rec, Result } from "effect"
import type { ChangeVariants, WorkloadForm } from "#adapter/db/workload.ts"
import { toResult } from "#adapter/engine.ts"
import type { RowsForm } from "#adapter/reader/reader.ts"
import { refreshPlan } from "#adapter/refresh/statements.ts"
import type { LayerRole } from "#adapter/served/login.ts"
import { refusalsOf as servedRefusals } from "#adapter/served/refusals.ts"
import { type LawsAbove, lawsAbove } from "#adapter/witness/keylaw.ts"
import {
	closedNamed,
	type ClosedRows,
	type ClosedTable,
	closedTableOf,
	type CompiledWrite,
	servedWrite
} from "#compiler/plan/change.ts"
import {
	type CompileError,
	defect,
	levelChain,
	type LoginDesc,
	loginStem,
	type CallerParamDecl,
	type ClockParamDecl,
	prepared,
	raisableOf,
	type SchemaArtifacts,
	servedLiveOf,
	servedSession,
	writesOf
} from "#compiler/plan/common.ts"
import {
	type Footprint,
	memberWire,
	type ProgramFootprints,
	servedMatchers,
	servedMembers,
	servedRosters,
	servesRead,
	type UnservedMember
} from "#compiler/plan/migration.ts"
import {
	pageKey,
	type QueryTemplate,
	servedFootprint,
	servedInstantRead,
	servedRead,
	servedReadBacks,
	templateKey
} from "#compiler/plan/read.ts"
import {
	ledgerStatements,
	type ServedAbove,
	type ServedChange,
	type ServedContext,
	type ServedFile,
	type ServedInstantRead,
	type ServedKey,
	type ServedMember,
	type ServedMemberForm,
	type ServedRead,
	type ServedRefusals,
	type ServedRoleForm,
	type ServedSnapshot,
	type ServedTable,
	type ServedTables,
	type ServedVariants,
	type SnapshotTables
} from "#compiler/plan/serve.ts"

/**
 * A login's compile as its served file holds it (packages/engine/src/served/forms.ts ServedFile): what `grizzle
 * generate` writes and `grizzle check` compares, from the one compile of the login's roles (served/login.ts loginRoles)
 * under the snapshot it serves. Compile time only: a layer reads the file, never this.
 *
 * What a login's compile is: its Description, the snapshot it compiles under, at its base's level, and its roles, each
 * with its programs compiled.
 */
export interface CompiledLogin {
	readonly login: LoginDesc
	readonly snapshot: ServedSnapshot
	readonly roles: ReadonlyArray<LayerRole>
	/** The declared names of the relations its programs read and write (served/compile.ts CompiledServed). */
	readonly footprint: ReadonlySet<string>
	/** Each query program's footprint, by name (served/compile.ts CompiledServed footprints). */
	readonly footprints: ProgramFootprints
}

/**
 * The installed tables and materialized views of the relations in `footprint` (deploy/snapshot/types.ts SnapshotTables),
 * each with the name of every index PostgreSQL holds on it, in code-unit order, by schema and name (ServedTables): what
 * an explain of the login's members names a plan by. The planner may scan any of a footprint table's indexes, whatever
 * level's law or access asked for it, and no table outside the footprint: a relation the statements name, read through a
 * role's views, stands for the base relations its entry reads, and a derived one for what its definition reads
 * (schema/reach.ts sliceOf). Each index's reasons stay in snapshot.json, which generate reads and no layer loads.
 */
const tablesOf = (installed: SnapshotTables, footprint: ReadonlySet<string>): ServedTables => {
	const out: Record<string, Readonly<Record<string, ServedTable>>> = {}
	for (const [schema, tables] of Rec.toEntries(installed)) {
		const kept = Arr.filterMap(Rec.toEntries(tables), ([name, table]) =>
			footprint.has(table.relation)
				? Result.succeed([
						name,
						{ relation: table.relation, indexes: Arr.sort(Rec.keys(table.indexes), Order.String) }
					] as const)
				: Result.failVoid
		)
		if (Arr.isReadonlyArrayNonEmpty(kept)) {
			out[schema] = Rec.fromEntries(kept)
		}
	}
	return out
}

/**
 * A rows form's read, served: its template, its Description's spine, its decoder's form, the key its rows are
 * delivered under, its template's own (templateKey) unless a page's is given, and its footprint, named as installed
 * under the role's names `names`.
 */
const readOf = (
	form: RowsForm<unknown>,
	footprint: Footprint,
	names: SchemaArtifacts["names"],
	key: (template: QueryTemplate) => ServedKey
): ServedRead => {
	const { compiled } = form.bound.compiled
	return servedRead(
		compiled.template,
		compiled.desc,
		form.decoder(),
		key(compiled.template),
		servedFootprint(footprint, names)
	)
}

/**
 * A rows form's read at its call's instant, served: as readOf serves a read, with no footprint, since no change reaches
 * an instant member's answer.
 */
const instantReadOf = (form: RowsForm<unknown>): ServedInstantRead => {
	const { compiled } = form.bound.compiled
	return servedInstantRead(
		compiled.template,
		compiled.desc,
		form.decoder(),
		templateKey(compiled.template)
	)
}

/**
 * A ChangeSet's variants, served: each compiled change its program, projected at the level it was compiled for, its
 * role's (write/program/served.ts servedWrite), its read-backs, its reads decoder's form, the values its
 * declaration bound and the array members a call supplies (servedMembers), or every reason no call can serve it
 * (UnservedMember: a Stream member, a bound value with no canonical text, two array members of one relation).
 */
const variantsOf = (variants: ChangeVariants): Result.Result<ServedVariants, UnservedMember> => {
	switch (variants.kind) {
		case "form": {
			const { entry, decoder } = variants.form
			const compiled = entry.compiled
			return Result.gen(function* () {
				const program = yield* toResult(servedWrite(compiled))
				const members = yield* toResult(
					servedMembers(compiled.binding.members, entry.change.opaque)
				)
				const change: ServedChange = {
					program,
					readBacks: servedReadBacks(compiled.artifact.readBacks),
					decoder: decoder.form,
					bound: entry.change.values,
					members
				}
				return { kind: "change", change }
			})
		}
		case "split":
			return Result.gen(function* () {
				const holding = yield* variantsOf(variants.holding)
				const lacking = yield* variantsOf(variants.lacking)
				return { kind: "split", context: variants.context, holding, lacking }
			})
	}
}

/**
 * One workload member of a role, served: a read's and a key's read, a paged read's read beside the page its runtime was
 * served from (served/forms.ts pageTemplateFor), its rows keyed by the page's order, and a ChangeSet's variants. A
 * read's footprint is the workload plan's for its program, among `footprints`, named as installed under `names`.
 */
const memberOf = (
	member: WorkloadForm,
	footprints: ProgramFootprints,
	names: SchemaArtifacts["names"]
): Result.Result<ServedMemberForm, UnservedMember> => {
	const { name } = member
	const footprint = (): Footprint => {
		const read = footprints.get(name)
		if (read === undefined) {
			throw defect(`the footprint of query program ${name}, a query of its login's workload plan`)
		}
		return read
	}
	switch (member.kind) {
		case "read":
			return Result.succeed({
				name,
				kind: "read",
				read: readOf(member.form, footprint(), names, templateKey)
			})
		case "instant":
			return Result.succeed({ name, kind: "instant", read: instantReadOf(member.form) })
		case "key":
			return Result.succeed({
				name,
				kind: "key",
				fields: member.fields,
				read: readOf(member.form, footprint(), names, templateKey)
			})
		case "paged": {
			const page = member.form.page.runtime.page
			return Result.succeed({
				name,
				kind: "paged",
				read: readOf(member.form, footprint(), names, () => pageKey(page)),
				page
			})
		}
		case "change":
			return Result.map(variantsOf(member.variants), (variants): ServedMemberForm => ({
				name,
				kind: "change",
				variants
			}))
		case "refresh":
			return Result.succeed({ name, kind: "refresh", refresh: refreshPlan(member.targets) })
	}
}

/** A role's contexts, served: each one's name, claim and typed fields. */
const contextsOf = (role: LayerRole): ReadonlyArray<ServedContext> =>
	Arr.map(role.contexts, (c) => ({
		name: c.name,
		claim: c.claim,
		fields: Arr.map(c.fields, (f) => ({ name: f.name, type: f.type }))
	}))

/** Each compiled write of a ChangeSet's variants. */
const variantsWrites = (variants: ChangeVariants): ReadonlyArray<CompiledWrite> =>
	variants.kind === "form"
		? [variants.form.entry.compiled]
		: [...variantsWrites(variants.holding), ...variantsWrites(variants.lacking)]

/**
 * The closed relations a login's served writes evaluate, each once by name (served/forms.ts ServedFile closed): every
 * one a write's binding or witness names, drawn from the schema the write compiled over (decide.ts closedTableOf), in
 * the order the roles, their members and their variants first name it.
 */
const closedOfLogin = (roles: ReadonlyArray<LayerRole>): ClosedTable => {
	const table = new Map<string, ClosedRows>()
	for (const role of roles) {
		for (const member of role.workload) {
			if (member.kind === "change") {
				for (const write of variantsWrites(member.variants)) {
					const named = [
						...write.binding.evaluation.closed,
						...write.binding.witness.evaluation.closed
					]
					const missing = Arr.dedupe(Arr.filter(named, (name) => !table.has(name)))
					for (const [name, rows] of closedNamed(missing, closedTableOf(write.frontend))) {
						table.set(name, rows)
					}
				}
			}
		}
	}
	return table
}

/**
 * The classifier of a role, as data (served/refusals.ts refusalsOf), cut to what its members' writes can raise
 * (program/schema.ts raisableOf) by what they judge (Judged): every relation its compiled writes write and every
 * relation those writes change besides them, a family's owner and members (schema/reach.ts writesOf); and, for each
 * compiled write, the type of each claim of a context the role reads and of each scalar parameter it declares, which
 * its statements cast to it. A role whose members write nothing judges nothing, so it classifies nothing.
 */
const refusalsOf = (role: LayerRole): ServedRefusals => {
	const writes = Arr.flatMap(role.workload, (member) =>
		member.kind === "change" ? variantsWrites(member.variants) : []
	)
	const claims = Arr.flatMap(role.contexts, (context) =>
		Arr.map(context.fields, (field) => field.type)
	)
	const params = Arr.flatMap(role.workload, memberParams)
	const clocked = Arr.flatMap(role.workload, memberClocked)
	return servedRefusals(
		role.artifacts,
		raisableOf(role.artifacts, {
			written: writesOf(
				role.artifacts.owned,
				Arr.flatMap(writes, (write) => Arr.map(write.frontend.written, (r) => r.name))
			),
			cast: [
				...(writes.length === 0 ? [] : claims),
				...Arr.flatMap(params, (param) =>
					param.kind === "scalar" ? [param.type] : Arr.map(param.heading, (c) => c.type)
				),
				...Arr.map(clocked, (param) => param.type)
			]
		}),
		params
	)
}

/**
 * The parameters a member declares that a call supplies, each of whose values PostgreSQL checks against its
 * refinement's domain as it binds it: a read's, an instant read's, a page's, and every variant's of a ChangeSet; a
 * refresh declares none.
 */
const memberParams = (member: WorkloadForm): ReadonlyArray<CallerParamDecl> => {
	switch (member.kind) {
		case "read":
		case "instant":
		case "key":
			return member.form.bound.compiled.compiled.template.params
		case "paged":
			return [
				...member.form.bound.compiled.compiled.template.params,
				...member.form.page.compiled.template.params
			]
		case "change":
			return Arr.flatMap(variantsWrites(member.variants), (write) => write.params)
		case "refresh":
			return []
	}
}

/**
 * The parameters a member binds to the database's clock, each of whose readings PostgreSQL checks against its
 * contract's domain as its statement casts it: an instant read's, and every variant's of a ChangeSet.
 */
const memberClocked = (member: WorkloadForm): ReadonlyArray<ClockParamDecl> => {
	switch (member.kind) {
		case "instant":
			return member.form.bound.compiled.compiled.template.clocked
		case "change":
			return Arr.flatMap(variantsWrites(member.variants), (write) => write.clocked)
		case "read":
		case "key":
		case "paged":
		case "refresh":
			return []
	}
}

/**
 * One role of the login, served: its name, its PostgreSQL role, its level, its contexts, its classifier and its
 * members, each read with its footprint among the login's, `footprints`, and each with its wire, read off its form once
 * (live/member.ts memberWire), which a member whose shape no wire spells refuses.
 */
const roleOf = (
	role: LayerRole,
	footprints: ProgramFootprints
): Result.Result<ServedRoleForm, CompileError | UnservedMember> =>
	Result.gen(function* () {
		const forms = yield* Result.all(
			Arr.map(role.workload, (member) => memberOf(member, footprints, role.artifacts.names))
		)
		const named = { name: role.role.name, refusals: refusalsOf(role) }
		const members = yield* Result.all(
			Arr.map(forms, (form) =>
				Result.map(toResult(memberWire(form, named)), (wire): ServedMember => ({ ...form, wire }))
			)
		)
		return {
			name: named.name,
			installed: role.theory,
			isolation: role.isolation,
			contexts: contextsOf(role),
			refusals: named.refusals,
			members
		}
	})

/** One kind of owner's constraints above as a served file holds them: each one reporting a law of `laws`, under its
 * owner, an owner none of whose constraints does left out. */
const reportingAbove = (
	owned: LawsAbove["constraints"]["tables"],
	laws: LawsAbove["laws"]
): LawsAbove["constraints"]["tables"] =>
	Rec.fromEntries(
		Arr.flatMap(Rec.toEntries(owned), ([owner, named]) => {
			const reporting = Arr.filter(Rec.toEntries(named), ([, law]) => laws.has(law))
			return reporting.length === 0 ? [] : [[owner, Rec.fromEntries(reporting)] as const]
		})
	)

/**
 * The laws above a login's base as its served file holds them: every level schema, the laws of the levels above, and
 * the constraints above that report one of those laws. A violation reads the constraints above only where the role's
 * own tables name none, and names by them only a law of a level above (witness/keylaw.ts keyLawsOf lawsOf), so a
 * constraint reporting any other law is none a served Db reads.
 */
const servedAbove = (above: LawsAbove): ServedAbove => ({
	schemas: above.schemas,
	constraints: {
		tables: reportingAbove(above.constraints.tables, above.laws),
		domains: reportingAbove(above.constraints.domains, above.laws)
	},
	laws: above.laws
})

/**
 * The served file of a login's compile (see the header): the login, the snapshot fingerprint it compiled under, its
 * base and that level's index, its PostgreSQL role, its base's schema and the prologue's and session's texts, the codes
 * of exactly the rosters its roles read, the laws above its base, and its roles. A ledger or login role the naming door
 * refuses is its CompileError, and a workload ChangeSet no call can serve its UnservedMember.
 */
export const servedFileOf = (
	compiled: CompiledLogin
): Result.Result<ServedFile, CompileError | UnservedMember> =>
	Result.gen(function* () {
		const { login, snapshot } = compiled
		const [first] = compiled.roles
		if (first === undefined) {
			throw defect("a compiled login holds a role")
		}
		const schema = first.artifacts.names.schema
		const [root] = snapshot.schemas
		if (root === undefined) {
			throw defect("a served snapshot records its root level")
		}
		const ledger = yield* toResult(ledgerStatements(schema))
		const role = yield* toResult(loginStem(login))
		const roles = yield* Result.all(
			Arr.map(compiled.roles, (layered) => roleOf(layered, compiled.footprints))
		)
		const used = servedRosters(roles)
		return {
			login: login.name,
			fingerprint: snapshot.fingerprint,
			base: login.base.name,
			level: levelChain(login.base).length - 1,
			role,
			schema,
			prologue: { fence: prepared(ledger.fence.text), enter: prepared(ledger.enter.text) },
			session: servedSession,
			live: servesRead(compiled.footprints)
				? servedLiveOf(root, snapshot.derived.live)
				: { kind: "none" },
			rosters: new Map(
				Arr.map(
					Arr.filter([...snapshot.codes.rosters], ([name]) => used.has(name)),
					([name, codec]) => [name, codec.codes] as const
				)
			),
			matchers: servedMatchers(roles),
			closed: closedOfLogin(compiled.roles),
			above: servedAbove(lawsAbove(snapshot)),
			tables: tablesOf(snapshot.derived.tables, compiled.footprint),
			roles
		}
	})
