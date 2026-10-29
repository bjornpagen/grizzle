import type { Identity } from "#compiler/core/identity.ts"
import { withDerivedRelations } from "#compiler/physical/derived/objects.ts"
import { type InstallOptions, installOptions } from "#compiler/physical/install/compile.ts"
import type { InstallExtension } from "#compiler/physical/install/extension.ts"
import { withResidualLaws } from "#compiler/physical/laws/objects.ts"
import type { Owned, OwnedLogin } from "#compiler/schema/own.ts"

/** The complete install options of a schema, as `grizzle generate` drafts it: every native, the residual laws'
 * functions and triggers, the caller's extensions after them, the derived relations' materialized views last, and the
 * worlds of `logins`, under `installation`, naming no owner. Every reader of an installation's names compiles its
 * installation from these options, so no name is read from a partial installation, which would name the objects
 * production installs beside it as absent. */
export const completeInstallOptions = (
	owned: Owned,
	installation: Identity<"schema">,
	logins: ReadonlyArray<OwnedLogin>,
	extensions: ReadonlyArray<InstallExtension>
): InstallOptions =>
	withDerivedRelations(
		withResidualLaws({ ...installOptions(owned, undefined), installation, logins, extensions })
	)
