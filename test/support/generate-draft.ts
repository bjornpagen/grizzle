import { mapNonEmpty } from "@bjornpagen/grizzle-text/base/nonempty"
import * as Engine from "@bjornpagen/grizzle-text/base/result"
import { Array as Arr, Effect, Option } from "effect"
import { fromEngine } from "#adapter/engine.ts"
import type { CompiledSchema } from "#cli/config.ts"
import type { CliError } from "#cli/errors.ts"
import { type CodesFrom, installationUnder } from "#cli/generate.ts"
import { type CompileError, unrepresentableKeys } from "#compiler/core/errors.ts"
import { type Identity, identifierOf } from "#compiler/core/identity.ts"
import { silentPhases } from "#compiler/core/phase.ts"
import { type Codebook, keptRosters, noRenames } from "#compiler/ir/codes.ts"
import type { LoginDesc, SchemaDesc as EngineSchemaDesc } from "#compiler/ir/desc.ts"
import { noServedTypes, type ServedTypes } from "#compiler/physical/ddl/domains.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"
import { type BaseInput, roleOfDesc } from "#compiler/program/input.ts"
import { contentOfDesc, sameLevel } from "#compiler/schema/levels.ts"
import { type Owned, own, ownBuiltLogin } from "#compiler/schema/own.ts"
import { allocatedDesc, type FixtureSchema } from "#test/support/compile.ts"
import { planRealInstall, type RealInstallPlan } from "#test/support/oracle/install/real.ts"

/**
 * Generate's draft in test support, the steps every draft with logins shares, from values (install-migrate.ts
 * generatedDrafting) or from descriptions (describedPlan): a command-line step's refusal read as the compiler's, the
 * codes a draft continues stated as a history, and the plan of the installation generate drafted. A module of its own,
 * which imports no installer of a test's history, so the installers, the migrate harnesses and the oracle all import
 * it and none of them another.
 */

/**
 * The compiler's refusal a `grizzle generate` refusal carries, where the compiler refused the version's schema, a
 * login, a step of its draft or a login's workload; none for a refusal of the setup's own configuration, files or
 * snapshot, or of a workload no served file can hold.
 */
const compilerRefusal = (refusal: CliError): Option.Option<CompileError> => {
	const reason = refusal.reason
	switch (reason._tag) {
		case "SchemaEntryRefused":
		case "LoginEntryRefused":
			return reason.fault.kind === "uncompiled" ? Option.some(reason.fault.error) : Option.none()
		case "DraftRefused":
			return Option.some(reason.error)
		case "ServedRefused":
			return reason.error._tag === "CompileError" ? Option.some(reason.error) : Option.none()
		case "ArgumentsRefused":
		case "MigrationNameRefused":
		case "DeclarationRefused":
		case "SchemaChoiceRefused":
		case "ConfigMissing":
		case "ConfigUnloaded":
		case "ExportRefused":
		case "ConfigReadsGenerated":
		case "SettingRefused":
		case "ConnectionRefused":
		case "ConnectionThrew":
		case "ConnectionEnvironmentRefused":
		case "TreeRefused":
		case "TreeUnread":
		case "FolderExists":
		case "FolderUnwritten":
		case "SnapshotUnwritten":
		case "ServedUnwritten":
		case "FileTooLarge":
		case "MigrationsUnread":
		case "DraftInputUnread":
		case "SnapshotUnreadable":
		case "SnapshotFormat":
		case "SnapshotForeign":
		case "ChainRefused":
		case "RosterReordered":
			return Option.none()
	}
}

/**
 * A command-line step of a draft, its refusal the compiler's where the compiler refused (compilerRefusal), as a schema
 * installMigrated compiles is, so a test can expect it; the command line's refusal of anything else is a defect of the
 * setup.
 */
export const asCompiler = <A>(step: Effect.Effect<A, CliError>): Effect.Effect<A, CompileError> =>
	Effect.catchTag(step, "CliError", (refusal) =>
		Option.match(compilerRefusal(refusal), {
			onNone: () => Effect.die(refusal),
			onSome: Effect.fail
		})
	)

/**
 * The codes `codes`, holes included, as the history a draft continues (cli/generate.ts CodesFrom): each roster kept as
 * itself (ir/codes.ts keptRosters), none renamed, under the spellings they record, so the draft's codes are `codes`.
 */
export const keptHistory = (codes: Codebook): CodesFrom => ({
	previous: keptRosters(codes),
	renames: noRenames,
	spellings: codes.spellings
})

/**
 * The plan (oracle/install/real.ts planRealInstall) of `schema` whose installation is `installation`, the one generate
 * drafted, its logins' worlds its own, read under the allocation `allocation` and the codes `codes`.
 */
export const installedPlan = (
	schema: FixtureSchema,
	installation: Installation,
	allocation: Identity<"schema">,
	codes: Codebook
): Effect.Effect<RealInstallPlan, CompileError> =>
	fromEngine(
		planRealInstall(schema, {
			installation: allocation,
			extensions: [],
			codes,
			compile: () => Engine.ok(installation)
		})
	)

/** A schema input of an Owned (engine program/input.ts BaseInput): its Owned, its Description and its content. */
type OwnedBase = Extract<BaseInput, { readonly kind: "owned" }>

/** An owned schema as a compile takes it (OwnedBase). */
const ownedBase = (owned: Owned): OwnedBase => ({
	kind: "owned",
	owned,
	desc: owned.desc,
	content: contentOfDesc(owned.desc)
})

/**
 * A login of a description's install (describedPlan): its Description, over the schema's, and the parameter types it
 * serves beside its workload's programs (adapter/served/login.ts LoginInput `stated`): none, but for the one test
 * addition left, an oracle case's query's parameter domains (oracle/install/drafted.ts oraclePlanUnder).
 */
export interface DescribedLogin {
	readonly desc: LoginDesc
	readonly stated: ServedTypes
}

/** A login of a description's install that states no parameter type (DescribedLogin): every login but the oracle's. */
export const describedLogin = (desc: LoginDesc): DescribedLogin => ({ desc, stated: noServedTypes })

/**
 * A schema's Description and logins, each over it, compiled as cli/config.ts compileSchema compiles a configuration's
 * values (CompiledSchema), under the allocation `installation` names: every level declared under its allocated name
 * (compile.ts allocatedDesc), as the oracle's plan declares it (oracle/install/real.ts planRealInstall), each login's
 * base and its roles' bases with it; the schema owned once, and each login owned over that Owned or the Owned of the
 * level below it is over (ownBuiltLogin), its roles read from their Descriptions (engine program/input.ts roleOfDesc),
 * its base listing no relation value, its workload none, and its stated parameter types its own (DescribedLogin). A
 * schema whose unrepresentable keys its Owned carries is refused for them before a login's refusal, met after them, as
 * compileSchema refuses it.
 */
const describedSchema = (
	desc: EngineSchemaDesc,
	logins: ReadonlyArray<DescribedLogin>,
	installation: Identity<"schema">
): Effect.Effect<CompiledSchema, CompileError> =>
	Effect.gen(function* () {
		const allocated = identifierOf(installation)
		const as = (d: EngineSchemaDesc): EngineSchemaDesc => allocatedDesc(d, allocated)
		const owned = yield* fromEngine(own(as(desc)))
		const schema = ownedBase(owned)
		const compiledLogins = yield* Effect.mapError(
			Effect.forEach(logins, (given) =>
				Effect.gen(function* () {
					const login: LoginDesc = {
						...given.desc,
						base: as(given.desc.base),
						roles: mapNonEmpty(given.desc.roles, (r) => ({ ...r, base: as(r.base) }))
					}
					const base = yield* sameLevel(contentOfDesc(login.base), schema.content)
						? Effect.succeed(schema)
						: Effect.map(fromEngine(own(login.base)), ownedBase)
					const ownedLogin = yield* fromEngine(ownBuiltLogin(login, base.owned))
					return {
						login: {
							desc: login,
							base,
							roles: Arr.map(login.roles, (r) => roleOfDesc(r, base.owned)),
							workload: [],
							stated: given.stated,
							relations: []
						},
						owned: ownedLogin
					}
				})
			),
			(refused) =>
				Arr.isReadonlyArrayNonEmpty(owned.unrepresentable)
					? unrepresentableKeys(owned.unrepresentable)
					: refused
		)
		return { declared: owned.desc.name, schema, owned, logins: compiledLogins }
	})

/**
 * The plan of `desc` and `logins`, each over it, installed under the allocation `installation` and the codes `codes`,
 * holes included, as `grizzle generate` installs a schema once its configuration is compiled (cli/generate.ts
 * installationUnder): generate's installation from compiled descriptions (describedSchema), its logins' served
 * workload certified, every grant, guard and fence of it, under a history that holds those codes (keptHistory). Its
 * logins serve no workload: a program a served file holds is a value, whose records decoder only its builder carries.
 * Its result is the plan alone, so it drafts no migration and compiles no served file, which no reader of a plan reads.
 * A schema or login the compiler refuses fails with the compiler's refusal.
 */
export const describedPlan = (
	desc: EngineSchemaDesc,
	logins: ReadonlyArray<DescribedLogin>,
	installation: Identity<"schema">,
	codes: Codebook
): Effect.Effect<RealInstallPlan, CompileError> =>
	Effect.gen(function* () {
		const compiled = yield* describedSchema(desc, logins, installation)
		const under = yield* asCompiler(installationUnder(compiled, keptHistory(codes), silentPhases))
		return yield* installedPlan(desc, under.installation, installation, codes)
	})
