/**
 * The read plan: what a compiled read or page is, and what the shell runs and decodes it by — the template and its
 * programs, their statements, forms and placeholders, and the codecs of their parameters and rows.
 */
export { parentUse } from "#compiler/check/scan.ts"
export { encodeFailure, factPlace, slotPlace } from "#compiler/codec/fault.ts"
export {
	columnLiteral,
	type NormalizedRelation,
	normalArray,
	type ParameterNormalizer,
	parameterNormalizer,
	positionalColumns,
	type RelationSpec,
	textArrayParam
} from "#compiler/codec/recordset.ts"
export {
	carrierSpecOf,
	countParam,
	paramEncoder,
	scalarCodec,
	type ScalarCodec,
	textParam
} from "#compiler/codec/scalar.ts"
export type { PageFill, SizeFill } from "#compiler/ir/products.ts"
export type { CompletedOrder, Heading, NodeOf, TakeBound } from "#compiler/ir/rel.ts"
export {
	type ConservativeParamSlot,
	type DeclaredParamSlot,
	type GroupMerge,
	type PageStatementSlot,
	type ProgramDelivery,
	type RelationColumn
} from "#compiler/lower/conservative/types.ts"
export { type FusedAttachment, fusedTexts, type FusedTexts } from "#compiler/runtime/lower/fused.ts"
export type { PartDivision, TaggedPart } from "#compiler/lower/parts.ts"
export type {
	DeliveredPart,
	FusedStatement,
	RelationChoice,
	ShapeChoice
} from "#compiler/lower/shapes/index.ts"
export {
	compilePageOf,
	type PageArtifact,
	type PageProgram,
	type PageRequestProgram,
	type PageTemplate,
	statedOrderOf
} from "#compiler/lower/shapes/page/compile.ts"
export type {
	AnchoredVariant,
	PageComparator,
	PageDirection,
	PageVariant,
	VariantFill
} from "#compiler/lower/shapes/page/seek.ts"
export { type ChoiceInput, type RelationInput } from "#compiler/lower/shapes/take/index.ts"
export type { SpecifiedStatement } from "#compiler/lower/template.ts"
export { queryInput, type QueryInput, type QueryTemplate } from "#compiler/program/compile.ts"
export {
	pageKey,
	servedInstantRead,
	servedPage,
	servedRead,
	servedReadLive,
	templateKey
} from "#compiler/program/served.ts"
export type { StatementForms } from "#compiler/runtime/lower/forms.ts"
export { pageStatementSlotOf } from "#compiler/runtime/lower/slots.ts"
export {
	type CompiledTemplate,
	type ExecutionRequest,
	templateFor
} from "#compiler/program/template.ts"
export { workloadState } from "#compiler/program/workload/value.ts"
export { hostArguments } from "#compiler/query/build/host.ts"
export { isOrderedValue, isQueryValue } from "#compiler/query/build/index.ts"
export { keyLookup, keyQuery } from "#compiler/query/build/key.ts"
export { queryState } from "#compiler/query/build/state.ts"
export { columnPosition, columnType } from "#compiler/runtime/lower/columns.ts"
export { runsLargeForm } from "#compiler/runtime/lower/take.ts"
export {
	type AttachedTree,
	keyColumns,
	mapTree,
	statementOutput,
	type StatementOutput,
	type StatementRoots,
	type StatementTree,
	traverseTree
} from "#compiler/runtime/lower/tree.ts"
export { mergeHeadingGroups } from "#compiler/runtime/lower/union.ts"
export { type CarrierHost, compareValues } from "#compiler/scalar/values/identity.ts"
export { servedSource } from "#compiler/served/read.ts"
export { servedReadBacks, servedSpine } from "#compiler/served/spine.ts"
export type {
	ContextsOf,
	EvidenceOfQuery,
	Ordered,
	OrderedBase,
	ParamsOf,
	Query,
	QueryBase,
	UnionArms
} from "#compiler/types/query/query.ts"
