import type { ApplyError, OpenError, ReadError } from "#adapter/errors/execution.ts"
import type { CompileError } from "#compiler/core/errors.ts"

/** Every tag a grizzle error has: a closed vocabulary superlint's unchecked-vocabulary-literal reads. */
export type GrizzleErrorTag =
	| CompileError["_tag"]
	| OpenError["_tag"]
	| ReadError["_tag"]
	| ApplyError["_tag"]
	| "CredentialError"
	| "TokenError"
	| "CursorError"
	| "KeyConflict"
