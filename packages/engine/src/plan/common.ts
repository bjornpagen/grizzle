/**
 * max_stack_depth's default, in kilobytes: how deep a backend's stack may grow before PostgreSQL refuses to recurse
 * further, which its regex compiler checks as it walks its NFAs (regexMaxDepth). It is the superuser's setting, which
 * no role grizzle admits can change, so Db.open and grizzle migrate refuse a server whose setting is below it.
 *
 * @limitKind published
 * @owner PostgreSQL 19.0
 * @unit kilobytes
 * @scope max_stack_depth, as pg_settings reports it, of the server grizzle's patterns are compiled on
 * @constraint configurable default
 * @source https://github.com/postgres/postgres/blob/REL_19_0/doc/src/sgml/config.sgml#L2328
 * @quote The default setting is two megabytes (<literal>2MB</literal>)
 * @verified 2026-11-20
 */
export { quoteIdent } from "#compiler/core/text.ts"
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
	formatRefusal,
	type RecordedFormat,
	recordedFormatText,
	servedFileFix
} from "#compiler/core/format.ts"
export {
	type Artifact,
	type CodecFault,
	CompileError,
	compileReasonText,
	type EncodingFailure,
	isCompileError,
	malformedArtifact,
	malformedDescription,
	prose,
	type TransientReason,
	unrepresentableKeys,
	unsupported
} from "#compiler/core/errors.ts"
export {
	admittedIdentifier,
	conversionOf,
	declaredAlike,
	type DeclaredName,
	identifierOf,
	longestRoleBytes,
	maxIdentifierBytes,
	maxRolePrefixBytes,
	nameFaultText,
	parseDeclaredName,
	parseRolePrefixBound,
	prefixPastBound,
	type RolePrefixBound
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
export { defect, defined } from "@bjornpagen/grizzle-text/base/invariant"
export { flightMaxBytes, messageMaxBytes } from "#compiler/core/wire.ts"
export { handleMaxBytes } from "#compiler/schema/own.ts"
export { maxStringLength } from "#compiler/core/canonical.ts"
export { SourceLoc } from "#compiler/core/loc.ts"
export { stemOf, type WorldStem } from "#compiler/core/stems.ts"
export { type Phase, type Phases, phased, silentPhases } from "#compiler/core/phase.ts"
export { prepared, type Prepared } from "#compiler/core/prepared.ts"
export {
	concatNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray
} from "@bjornpagen/grizzle-text/base/nonempty"
export {
	type Built,
	builtMark,
	type Delivering,
	type Phantom,
	type phantom
} from "#compiler/core/phantom.ts"
export { hasProperties, isList, isRecord } from "#compiler/core/record.ts"
export * as Engine from "@bjornpagen/grizzle-text/base/result"
export { rowEvaluatorOver } from "#compiler/program/evaluate.ts"
export { codecTextOver, rowTextOver, type TextedField } from "#compiler/program/text.ts"
export type { Isolation } from "#compiler/core/isolation.ts"
export type { Decoders, HeadOf } from "#compiler/types/query/query.ts"
export type { AnyRecords, OwnerFacts, RecordsInsert } from "#compiler/types/schema/records.ts"
export type { Result } from "@bjornpagen/grizzle-text/base/result"
export { sha256ChunksHex, sha256Hex } from "#compiler/core/sha256.ts"
export { wellFormed } from "#compiler/core/text.ts"
export { catalogDeparted, Sqlstate, sqlstateClass, sqlstates } from "#compiler/core/sqlstate.ts"
export { jsonText, trusted, trustedJson } from "#compiler/core/trusted.ts"
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
	noRenames,
	type PreviousRoster,
	type RosterCodec,
	type RosterRenames
} from "#compiler/ir/codes.ts"
export {
	type ClockBinding,
	type ClockSource,
	movedClock,
	noClock,
	transactionClock
} from "#compiler/ir/clock.ts"
export {
	type AttachDesc,
	type ContextDesc,
	type ContextFactSource,
	descText,
	type FieldDesc,
	type LoginDesc,
	type ProgramDesc,
	type QueryDesc,
	type QueryStageDesc,
	type RoleDesc,
	type SchemaDesc
} from "#compiler/ir/desc.ts"
export { lawsOfConstraint } from "#compiler/ir/products.ts"
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
export { type Carrier, patternsText, type Roster, type ScalarType } from "#compiler/ir/scalar.ts"
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
	type InstalledArtifacts,
	type InstalledSource,
	type Raisable,
	raisableOf,
	roleArtifacts,
	type SchemaArtifacts,
	unmatchedOf
} from "#compiler/program/schema.ts"
export {
	type BuiltSchema,
	levelSchema,
	parseBuiltSchema,
	type ParsedRole,
	parseSchemaInput,
	type SchemaInput
} from "#compiler/program/input.ts"
export { type SchemaContent, sameLevel } from "#compiler/schema/levels.ts"
export { levelChain } from "#compiler/ir/desc.ts"
export {
	own,
	ownBuiltLogin,
	ownServed,
	type Owned,
	type OwnedLogin,
	type OwnedRole,
	rostersOf,
	schemaInstallation
} from "#compiler/schema/own.ts"
export { servedRecordsOf } from "#compiler/program/records.ts"
export { ownedEntry, ownedKind } from "#compiler/schema/protocol.ts"
export { writesOf } from "#compiler/schema/reach.ts"
export { bindGroups } from "#compiler/schema/record.ts"
export { recordsReader } from "#compiler/runtime/read/record.ts"
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
export { emit, emitCatalog, emitCommands, emitText } from "#compiler/sql/emit.ts"
export { differenceShown, escaped } from "#compiler/sql/escape.ts"
export { looksLikeLiteralPack, printCommentTarget, printObjectName } from "#compiler/sql/print.ts"
export type {
	Carriers,
	Invariant,
	OnlyParams,
	ParamArg,
	ParamMap,
	ParamValue,
	Refusal
} from "#compiler/types/core/phantom.ts"
export type { AnyWorkload, Clocked, Paged, ReadOf, Workload } from "#compiler/types/db/workload.ts"
export type { Evidence } from "#compiler/types/evidence/evidence.ts"
export type { AnyClosed, AnyRelation } from "#compiler/types/schema/relation.ts"
export { constraintNamesOf, lawsByStatement, lawsOf } from "#compiler/program/laws.ts"
export type {
	AdmittedRow,
	CheckNameOf,
	CheckVerdict,
	DomainRefused,
	EvaluatedRow,
	GeneratedFieldOf,
	RowEvaluation,
	RowEvaluator,
	RowSource,
	SourceRelation,
	Unevaluated,
	ValueRefused
} from "#compiler/types/schema/evaluation.ts"
export type { AnySchema, LevelsOf } from "#compiler/types/schema/schema.ts"
export type { CandidateKey, KeyValues } from "#compiler/types/schema/statements.ts"
export type {
	AnyLogin,
	AnyRole,
	AttestedFactsOf,
	AttestedRecord,
	LoginReadsToken,
	LoginRole,
	ProgramsOf,
	ReadsAttested,
	ReadsToken,
	RolesOf,
	WithinRoleContexts,
	WriteListOf
} from "#compiler/types/schema/world.ts"
export { CompilePatterns, type PatternReads } from "#compiler/scalar/regex/patterns.ts"
