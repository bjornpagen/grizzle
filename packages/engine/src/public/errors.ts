export type {
	ClaimRule,
	DatumUnbounded,
	DerivedRefusal,
	EntryKind,
	InexactConversion,
	KeyFault,
	LoginRule,
	RecursionArm,
	RecursionRefusal,
	RoleRule,
	WritabilityReason
} from "#compiler/core/causes.ts"

export {
	type Artifact,
	type CompileBound,
	type CodecFault,
	type CodecReason,
	CompileError,
	type CompileReason,
	CursorError,
	type CursorFault,
	type CursorReason,
	type Duplicate,
	EncodingFailure,
	type EncodingPlace,
	type RegexSpaceMeasure,
	type RoleAccess
} from "#compiler/core/errors.ts"
export type { ConstraintName } from "#compiler/core/ids.ts"
export type { SourceLoc } from "#compiler/core/loc.ts"
export type { Sqlstate } from "#compiler/core/sqlstate.ts"
