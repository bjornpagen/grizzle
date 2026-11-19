/**
 * max_stack_depth's default, in kilobytes: how deep a backend's stack may grow before PostgreSQL refuses to recurse
 * further, which its regex compiler checks as it walks its NFAs (regexMaxDepth). It is the superuser's setting, which
 * no role grizzle admits can change, so Db.open and grizzle migrate refuse a server whose setting is below it.
 *
 * @limitKind published
 * @owner PostgreSQL 19rc2
 * @unit kilobytes
 * @scope max_stack_depth, as pg_settings reports it, of the server grizzle's patterns are compiled on
 * @constraint configurable default
 * @source https://github.com/postgres/postgres/blob/REL_19_RC2/doc/src/sgml/config.sgml#L2328
 * @quote The default setting is two megabytes (<literal>2MB</literal>)
 * @verified 2026-11-14
 */
export const maxStackDepth = 2_048
/**
 * What every plan is spelled in: the engine's errors and results, identifiers and names, descriptions and scalar
 * types, the SQL AST and its printed text, the schema the plans compile against, and the public types the shell's
 * signatures name.
 */
export type { CheckedEntry } from "#compiler/analysis/schema.ts"
export { nominal } from "#compiler/core/brand.ts"
export {
	canonicalEquals,
	catchCompileError,
	catchRefusal,
	decode,
	everyProperty,
	fromJson,
	noRevivers
} from "#compiler/core/canonical.ts"
export {
	type AttachmentLayout,
	type BindContext,
	type DecoderForm,
	decoderOf,
	type Layout,
	type OptionVocabulary,
	outputTextOf,
	type Row,
	rowCell,
	type RowDecoder,
	rowText
} from "#compiler/core/decoder.ts"
export {
	type CodecFault,
	CompileError,
	compileReasonText,
	type EncodingFailure,
	isCompileError,
	malformedArtifact,
	malformedDescription,
	prose,
	type TransientReason,
	unsupported
} from "#compiler/core/errors.ts"
export {
	admittedIdentifier,
	conversionOf,
	declaredAlike,
	type DeclaredName,
	identifierOf,
	parseDeclaredName
} from "#compiler/core/identity.ts"
export {
	type ColumnIdent,
	type ConstraintName,
	type DomainName,
	type EntryName,
	type Identifier,
	type IdentityKind,
	type LawId,
	type ParamId,
	type RelationIdent,
	type RoleRelationName,
	SchemaFingerprint,
	type StoredRelationName
} from "#compiler/core/ids.ts"
export { defect, defined } from "#compiler/core/invariant.ts"
export { flightMaxBytes, messageMaxBytes } from "#compiler/core/wire.ts"
export { handleMaxBytes } from "#compiler/schema/own.ts"
export { maxStringLength } from "#compiler/core/canonical.ts"
export { SourceLoc } from "#compiler/core/loc.ts"
export { prepared, type Prepared } from "#compiler/core/prepared.ts"
export { concatNonEmpty, mapNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
export {
	type Built,
	builtMark,
	type Delivering,
	type Phantom,
	type phantom
} from "#compiler/core/phantom.ts"
export { hasProperties, isList, isRecord } from "#compiler/core/record.ts"
export * as Engine from "#compiler/core/result.ts"
export { rowEvaluatorOver } from "#compiler/program/evaluate.ts"
export { codecTextOver, type TextedField } from "#compiler/program/text.ts"
export type { Isolation } from "#compiler/core/isolation.ts"
export type { Result } from "#compiler/core/result.ts"
export { sha256Hex, utf8Length } from "#compiler/core/sha256.ts"
export { Sqlstate, sqlstateClass, sqlstates } from "#compiler/core/sqlstate.ts"
export { compareCodePoints } from "#compiler/core/text.ts"
export { jsonText, trusted, trustedJson } from "#compiler/core/trusted.ts"
export { TupleMap } from "#compiler/core/tuple-map.ts"
export type {
	AssembledRows,
	Cell,
	OutputRows,
	OutputText,
	Param,
	ParamText
} from "#compiler/core/wire.ts"
export {
	type Codebook,
	codeNames,
	draftCodebook,
	type HandleRenames,
	type RosterCodec,
	type RosterRenames
} from "#compiler/ir/codes.ts"
export { type ClockBinding, noClock } from "#compiler/ir/clock.ts"
export {
	type AttachDesc,
	type ContextDesc,
	descText,
	type FieldDesc,
	type LoginDesc,
	type ProgramDesc,
	type QueryDesc,
	type QueryStageDesc,
	type RoleDesc,
	type SchemaDesc
} from "#compiler/ir/desc.ts"
export { constraintLaw } from "#compiler/ir/products.ts"
export type {
	CallerParamDecl,
	ClockParamDecl,
	ConstraintLaws,
	ConstraintOwner,
	Encoder,
	LiteralBound,
	MessageBound,
	ParamDecl,
	PhysicalReason,
	RelationParamDecl,
	StatementSpec
} from "#compiler/ir/products.ts"
export {
	type Carrier,
	contractOf,
	patternsText,
	type Roster,
	type ScalarType
} from "#compiler/ir/scalar.ts"
export type { DomainUse } from "#compiler/laws/model/model.ts"
export {
	type NamedLogin,
	type NamedRole,
	namedLogin,
	namedRole
} from "#compiler/physical/ddl/names.ts"
export { unserved, type ParamSource } from "#compiler/physical/install/plan.ts"
export { readGaps, servedLiveOf } from "#compiler/program/live.ts"
export { servedSession } from "#compiler/program/served.ts"
export { loginStem } from "#compiler/schema/stem.ts"
export {
	baseArtifacts,
	type BuiltSchema,
	type InstalledArtifacts,
	type InstalledSource,
	levelSchema,
	parseBuiltSchema,
	type ParsedRole,
	parseSchemaInput,
	type Raisable,
	raisableOf,
	roleArtifacts,
	type SchemaArtifacts,
	type SchemaInput
} from "#compiler/program/schema.ts"
export { type SchemaContent, sameLevel } from "#compiler/schema/levels.ts"
export {
	levelChain,
	own,
	ownBuilt,
	ownBuiltLogin,
	ownServed,
	type Owned,
	type OwnedLogin,
	type OwnedRole,
	rostersOf,
	schemaInstallation
} from "#compiler/schema/own.ts"
export { ownedEntry, ownedKind } from "#compiler/schema/protocol.ts"
export { writesOf } from "#compiler/schema/reach.ts"
export { bindGroups } from "#compiler/schema/record.ts"
export { admitDerived, derivedDraftOf } from "#compiler/schema/relation.ts"
export { schemaDescOf } from "#compiler/schema/schema.ts"
export { queryUses } from "#compiler/schema/walk.ts"
export { loginDescOf, loginRoleOf } from "#compiler/schema/world.ts"
export type {
	CreatePublication,
	EmittedText,
	Expr,
	ObjectName,
	SqlStatement,
	TypeSchema
} from "#compiler/sql/ast.ts"
export { lit, types } from "#compiler/sql/build.ts"
export { explainAnalyzeOf, explainOf } from "#compiler/runtime/explain.ts"
export { emit, emitCatalog, emitText } from "#compiler/sql/emit.ts"
export { differenceShown, escaped } from "#compiler/sql/escape.ts"
export {
	looksLikeLiteralPack,
	printCommentTarget,
	printObjectName,
	quoteIdent
} from "#compiler/sql/print.ts"
export type {
	Carriers,
	Invariant,
	OnlyParams,
	ParamArg,
	ParamMap,
	ParamValue,
	Refusal
} from "#compiler/types/core/phantom.ts"
export type {
	AnyWorkload,
	Clocked,
	Deferrable,
	Paged,
	ReadOf,
	Refresh,
	Workload
} from "#compiler/types/db/workload.ts"
export type { Evidence } from "#compiler/types/evidence/evidence.ts"
export type { AnyClosed, AnyRelation } from "#compiler/types/schema/relation.ts"
export type { RowEvaluator } from "#compiler/types/schema/evaluation.ts"
export type { AnySchema, LevelsOf } from "#compiler/types/schema/schema.ts"
export type { CandidateKey, KeyValues } from "#compiler/types/schema/statements.ts"
export type {
	AnyLogin,
	AnyRole,
	LoginReadsContext,
	LoginRole,
	ReadsContext,
	RefreshListOf,
	RolesOf,
	WithinRoleContexts,
	WriteListOf
} from "#compiler/types/schema/world.ts"
export { CompilePatterns, type PatternReads } from "#compiler/scalar/regex/patterns.ts"
