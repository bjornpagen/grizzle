import type { Identity } from "#compiler/core/identity.ts"
import type { Codebook } from "#compiler/ir/codes.ts"
import { withDerivedRelations } from "#compiler/physical/derived/objects.ts"
import { type InstallOptions, installOptions } from "#compiler/physical/install/compile.ts"
import type { InstallExtension } from "#compiler/physical/install/extension.ts"
import type { Owned, OwnedLogin } from "#compiler/schema/own.ts"

/** The complete install options of a schema, as `grizzle generate` drafts it: every native, the caller's extensions
 * after them, the derived relations' materialized views last, and the worlds of `logins`, under `installation`, naming
 * no owner, for the installation that holds `codes`. Every reader of an installation's names compiles its
 * installation from these options, so no name is read from a partial installation, which would name the objects
 * production installs beside it as absent. */
export const completeInstallOptions = (
	owned: Owned,
	installation: Identity<"schema">,
	logins: ReadonlyArray<OwnedLogin>,
	extensions: ReadonlyArray<InstallExtension>,
	codes: Codebook
): InstallOptions =>
	withDerivedRelations({
		...installOptions(owned, undefined),
		installation,
		logins,
		extensions,
		codes
	})
