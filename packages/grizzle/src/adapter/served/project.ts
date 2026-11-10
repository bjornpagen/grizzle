import { Array as Arr, Record as Rec, Result } from "effect"
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
	type Isolation,
	levelChain,
	type LoginDesc,
	loginRoleName,
	raisableOf,
	servedSession,
	writesOf
} from "#compiler/plan/common.ts"
import {
	servedMatchers,
	servedMembers,
	servedRosters,
	type UnservedMember
} from "#compiler/plan/migration.ts"
import { servedRead, servedReadBacks } from "#compiler/plan/read.ts"
import {
	ledgerStatements,
	type ServedAbove,
	type ServedChange,
	type ServedContext,
	type ServedFile,
	type ServedMember,
	type ServedRead,
	type ServedRefusals,
	type ServedRoleForm,
	type ServedSnapshot,
	type ServedVariants
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
	readonly roles: ReadonlyArray<LeveledRole>
}

/**
 * A role of a login's compile with the isolation level its writes begin at (served/compile.ts): what its served form
 * records and its writes are projected at.
 */
export type LeveledRole = LayerRole & { readonly isolation: Isolation }

/** A rows form's read, served: its template, its Description's spine, and its decoder's form. */
const readOf = (form: RowsForm<unknown>): ServedRead => {
	const { compiled } = form.bound.compiled
	return servedRead(compiled.template, compiled.desc, form.decoder())
}

/**
 * A ChangeSet's variants, served at its role's isolation level `isolation`: each compiled change its program, projected
 * at that level (write/program/served.ts servedWrite), its read-backs, its reads decoder's form, the values its
 * declaration bound and the array members a call supplies (servedMembers), or every reason no call can serve it
 * (UnservedMember: a Stream member, a bound value with no canonical text, two array members of one relation).
 */
const variantsOf = (
	variants: ChangeVariants,
	isolation: Isolation
): Result.Result<ServedVariants, UnservedMember> => {
	switch (variants.kind) {
		case "form": {
			const { entry, decoder } = variants.form
			const compiled = entry.compiled
			return Result.gen(function* () {
				const program = yield* toResult(servedWrite(compiled, isolation))
				const members = yield* toResult(
					servedMembers(compiled.binding.members, entry.change.values)
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
				const holding = yield* variantsOf(variants.holding, isolation)
				const lacking = yield* variantsOf(variants.lacking, isolation)
				return { kind: "split", context: variants.context, holding, lacking }
			})
	}
}

/**
 * One workload member of a role whose writes begin at `isolation`, served: a read's and a key's read, a paged read's
 * read beside the page its runtime was served from (served/forms.ts pageTemplateFor), and a ChangeSet's variants.
 */
const memberOf = (
	member: WorkloadForm,
	isolation: Isolation
): Result.Result<ServedMember, UnservedMember> => {
	const { name } = member
	switch (member.kind) {
		case "read":
			return Result.succeed({ name, kind: "read", read: readOf(member.form) })
		case "key":
			return Result.succeed({
				name,
				kind: "key",
				fields: member.fields,
				read: readOf(member.form)
			})
		case "paged": {
			const source = member.form.page
			if (source.kind !== "compiled") {
				throw defect("a paged member's page template is compiled with it")
			}
			return Result.succeed({
				name,
				kind: "paged",
				read: readOf(member.form),
				page: source.page.runtime.page
			})
		}
		case "change":
			return Result.map(variantsOf(member.variants, isolation), (variants): ServedMember => ({
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

/** No refusal: what a role that writes nothing classifies, which no statement of it can raise. */
const noRefusals: ServedRefusals = {
	laws: {
		schemas: [],
		constraintLaws: [],
		theoryLaws: [],
		tables: new Map(),
		rosterDomains: [],
		generated: []
	},
	relations: new Map(),
	entries: new Map()
}

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

/** The relations every variant of a ChangeSet's compile writes (write/frontend/compile.ts WriteFrontend.written). */
const variantsWritten = (variants: ChangeVariants): ReadonlyArray<string> =>
	variants.kind === "form"
		? Arr.map(variants.form.entry.compiled.frontend.written, (r) => r.name)
		: [...variantsWritten(variants.holding), ...variantsWritten(variants.lacking)]

/**
 * The classifier of a role that writes, as data (served/refusals.ts refusalsOf), cut to what its members' writes can
 * raise (program/schema.ts raisableOf): of every relation its compiled writes write and every relation those writes
 * change besides them, a family's owner and members (schema/reach.ts writesOf). A role whose members write nothing
 * classifies nothing (noRefusals).
 */
const refusalsOf = (role: LayerRole): ServedRefusals => {
	const written = Arr.flatMap(role.workload, (member) =>
		member.kind === "change" ? variantsWritten(member.variants) : []
	)
	if (!Arr.isReadonlyArrayNonEmpty(written)) {
		return noRefusals
	}
	return servedRefusals(
		role.artifacts,
		raisableOf(role.artifacts, writesOf(role.artifacts.owned, written))
	)
}

/** One role of the login, served: its name, its PostgreSQL role, its level, its contexts, its classifier and its members. */
const roleOf = (role: LeveledRole): Result.Result<ServedRoleForm, UnservedMember> =>
	Result.map(
		Result.all(Arr.map(role.workload, (member) => memberOf(member, role.isolation))),
		(members): ServedRoleForm => ({
			name: role.role.name,
			installed: role.theory,
			isolation: role.isolation,
			contexts: contextsOf(role),
			refusals: refusalsOf(role),
			members
		})
	)

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
		const ledger = yield* toResult(ledgerStatements(schema))
		const role = yield* toResult(loginRoleName(login))
		const roles = yield* Result.all(Arr.map(compiled.roles, roleOf))
		const used = servedRosters(roles)
		return {
			login: login.name,
			fingerprint: snapshot.fingerprint,
			base: login.base.name,
			level: levelChain(login.base).length - 1,
			role,
			schema,
			prologue: { fence: ledger.fence.text, enter: ledger.enter.text },
			session: servedSession,
			rosters: new Map(
				Arr.map(
					Arr.filter([...snapshot.codes.rosters], ([name]) => used.has(name)),
					([name, codec]) => [name, codec.codes] as const
				)
			),
			matchers: servedMatchers(roles),
			closed: closedOfLogin(compiled.roles),
			above: servedAbove(lawsAbove(snapshot)),
			roles
		}
	})
