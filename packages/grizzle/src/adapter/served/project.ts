import { Array as Arr, Result } from "effect"
import type { ChangeVariants, WorkloadForm } from "#adapter/db/workload.ts"
import { toResult } from "#adapter/engine.ts"
import type { RowsForm } from "#adapter/reader/reader.ts"
import type { LayerRole } from "#adapter/served/login.ts"
import { refusalsOf as servedRefusals } from "#adapter/served/refusals.ts"
import { lawsAbove } from "#adapter/witness/keylaw.ts"
import {
	type CompileError,
	defect,
	levelChain,
	type LoginDesc,
	loginRoleName,
	servedSession
} from "#compiler/plan/common.ts"
import { servedRosters } from "#compiler/plan/migration.ts"
import { servedRead } from "#compiler/plan/read.ts"
import {
	ledgerStatements,
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
	readonly roles: ReadonlyArray<LayerRole>
}

/** A rows form's read, served: its template, its Description's spine, and its decoder's form. */
const readOf = (form: RowsForm<unknown>): ServedRead => {
	const { compiled } = form.bound.compiled
	return servedRead(compiled.template, compiled.desc, form.decoder())
}

/** A ChangeSet's variants, served: each compiled change its program, its reads decoder's form and its value's inputs. */
const variantsOf = (variants: ChangeVariants): ServedVariants => {
	switch (variants.kind) {
		case "form": {
			const { entry, decoder } = variants.form
			const change: ServedChange = {
				program: entry.compiled,
				decoder: decoder.form,
				change: { inputs: entry.change.inputs, values: entry.change.values }
			}
			return { kind: "change", change }
		}
		case "split":
			return {
				kind: "split",
				context: variants.context,
				holding: variantsOf(variants.holding),
				lacking: variantsOf(variants.lacking)
			}
	}
}

/**
 * One workload member of a role, served: a read's and a key's read, a paged read's read beside the page its runtime was
 * served from (served/forms.ts pageTemplateFor), and a ChangeSet's variants.
 */
const memberOf = (member: WorkloadForm): ServedMember => {
	const { name } = member
	switch (member.kind) {
		case "read":
			return { name, kind: "read", read: readOf(member.form) }
		case "key":
			return { name, kind: "key", fields: member.fields, read: readOf(member.form) }
		case "paged": {
			const source = member.form.page
			if (source.kind !== "compiled") {
				throw defect("a paged member's page template is compiled with it")
			}
			return { name, kind: "paged", read: readOf(member.form), page: source.page.runtime.page }
		}
		case "change":
			return { name, kind: "change", variants: variantsOf(member.variants) }
		case "refresh":
			return { name, kind: "refresh", targets: member.targets }
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

/**
 * The classifier of a role that writes, as data, the one its compile classifies by (served/refusals.ts refusalsOf): a
 * role whose members write nothing classifies nothing (noRefusals).
 */
const refusalsOf = (role: LayerRole): ServedRefusals => {
	if (!Arr.some(role.workload, (member) => member.kind === "change")) {
		return noRefusals
	}
	return servedRefusals(role.artifacts)
}

/** One role of the login, served: its name, its PostgreSQL role, its contexts, its classifier and its members. */
const roleOf = (role: LayerRole): ServedRoleForm => ({
	name: role.role.name,
	installed: role.theory,
	contexts: contextsOf(role),
	refusals: refusalsOf(role),
	members: Arr.map(role.workload, memberOf)
})

/**
 * The served file of a login's compile (see the header): the login, the snapshot fingerprint it compiled under, its
 * base and that level's index, its PostgreSQL role, its base's schema and the prologue's and session's texts, the codes
 * of exactly the rosters its roles read, the laws above its base, and its roles. A ledger or login role the naming door
 * refuses is its CompileError.
 */
export const servedFileOf = (compiled: CompiledLogin): Result.Result<ServedFile, CompileError> =>
	Result.gen(function* () {
		const { login, snapshot } = compiled
		const [first] = compiled.roles
		if (first === undefined) {
			throw defect("a compiled login holds a role")
		}
		const schema = first.artifacts.names.schema
		const ledger = yield* toResult(ledgerStatements(schema))
		const role = yield* toResult(loginRoleName(login))
		const roles = Arr.map(compiled.roles, roleOf)
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
			above: lawsAbove(snapshot),
			roles
		}
	})
