/**
 * The runtime plan: every engine name a served login's layer and its Dbs run by, each re-exported from the one module
 * that holds it. No module it re-exports loads the compiler (schema builders, law model, query or write compilers), so
 * the runtime entry (@bjornpagen/grizzle/runtime) loads none; .fallowrc.json's runtime zone holds the facade and every
 * module it reaches to that, and refuses any other value import.
 */
export { wellFormed } from "#compiler/core/text.ts"
export { clockInstantName } from "#compiler/ir/clock.ts"
export { assembled, cellKindOf, deliveryOf } from "#compiler/codec/delivery.ts"
export { encodeFailure, factPlace, slotPlace } from "#compiler/codec/fault.ts"
export { scalarReader } from "#compiler/codec/read.ts"
export {
	columnLiteral,
	normalArray,
	parameterNormalizer,
	positionalColumns,
	textArrayParam
} from "#compiler/codec/recordset.ts"
export {
	carrierSpecOf,
	countParam,
	paramEncoder,
	scalarCodec,
	textParam
} from "#compiler/codec/scalar.ts"
export { nominal } from "#compiler/core/brand.ts"
export { canonicalEquals } from "#compiler/core/canonical.ts"
export { outputTextOf, rowCell, rowText } from "#compiler/core/decoder.ts"
export { CompileError, malformedDescription } from "#compiler/core/errors.ts"
export { type CallerObject, type CallerRecord, readCaller } from "#compiler/core/host.ts"
export {
	admittedIdentifier,
	liveSlotOf,
	type ParamPlace,
	paramPlaceText,
	roleInSpace,
	type RoleInstallation,
	type RolePrefixFault,
	rolePrefixFaultText,
	type RoleSpace,
	roleSpaceOf
} from "#compiler/core/identity.ts"
export { SchemaFingerprint } from "#compiler/core/ids.ts"
export { defect, defined } from "@bjornpagen/grizzle-text/base/invariant"
export { flightMaxBytes, messageMaxBytes } from "#compiler/core/wire.ts"
export { maxStringLength } from "#compiler/core/canonical.ts"
export { SourceLoc } from "#compiler/core/loc.ts"
export { builtMark } from "#compiler/core/phantom.ts"
export { type Prepared, type StatementName, statementNameBytes } from "#compiler/core/prepared.ts"
export { hasProperties, isList, isRecord } from "#compiler/core/record.ts"
export * as Engine from "@bjornpagen/grizzle-text/base/result"
export { Sqlstate, sqlstateClass, sqlstates } from "#compiler/core/sqlstate.ts"
export { stemOf } from "#compiler/core/stems.ts"
export { temporarySchema } from "#compiler/core/temporary.ts"
export { isDecimal, type TextsId, TextsMap, textsId } from "#compiler/core/text.ts"
export { jsonText, trusted, trustedJson } from "#compiler/core/trusted.ts"
export { codeNames, rosterCodebook } from "#compiler/ir/codes.ts"
export { lawsOfConstraint } from "#compiler/ir/products.ts"
export { mergeOrder } from "#compiler/ir/rel.ts"
export { type CallError, callError, wireHeader, wireRefusals } from "#compiler/live/events.ts"
export {
	batchesOf,
	type LiveBatch,
	type LiveSecret,
	type WalPosition,
	type LiveTextRefused,
	type Notification,
	notificationText,
	openPayload,
	parseLiveSecret,
	parseNotification,
	parseWalPosition,
	type RouteColumn,
	type RouteKey,
	type RouteTable,
	sealBatch,
	sealNonce,
	type SealNonce
} from "#compiler/live/notify.ts"
export {
	parseSenderDeadline,
	parseSnapshot,
	type Placement,
	placement,
	type ReplicationCommand,
	type SenderDeadline,
	type Snapshot,
	slotCommand
} from "#compiler/live/replication.ts"
export { sealNonceBytes } from "#compiler/core/seal.ts"
export { Cidr, Inet } from "#compiler/scalar/values/net.ts"
export { explainAnalyzeOf, explainOf, type ExplainText } from "#compiler/runtime/explain.ts"
export { namedAbove, namedGenerated, namedLaw } from "#compiler/runtime/law-entry.ts"
export type { WriteText } from "#compiler/runtime/write/parted.ts"
export { columnPosition, columnType } from "#compiler/runtime/lower/columns.ts"
export { fusedTexts } from "#compiler/runtime/lower/fused.ts"
export { runsLargeForm } from "#compiler/runtime/lower/take.ts"
export { keyColumns, statementOutput } from "#compiler/runtime/lower/tree.ts"
export { mergeHeadingGroups } from "#compiler/runtime/lower/union.ts"
export { recordsReader } from "#compiler/runtime/read/record.ts"
export { rowTextOf } from "#compiler/runtime/read/text.ts"
export { recordsFacts } from "#compiler/runtime/records.ts"
export { Roster } from "#compiler/ir/scalar.ts"
export { parseDeclaredName } from "#compiler/core/identity.ts"
export { Sha256 } from "#compiler/scalar/values/sha256.ts"
export { artifactFormat } from "#compiler/core/format.ts"
export { Vector } from "#compiler/scalar/values/vector.ts"
export { bindWrite } from "#compiler/runtime/write/bind.ts"
export { drawableShape } from "#compiler/runtime/write/binding.ts"
export { readCall, type SlotReads } from "#compiler/runtime/write/read-call.ts"
export { loadWrite, standUpName } from "#compiler/runtime/write/flight.ts"
export { memberFactsOf } from "#compiler/runtime/write/members.ts"
export { outcomeKind } from "#compiler/runtime/write/net.ts"
export { interpretRows, keyWitness, witnessDecoder } from "#compiler/runtime/write/outcome.ts"
export { readChangeDetail, readLawDetail } from "#compiler/runtime/write/refusal.ts"
export { constraintLawsOf, usesLaws } from "#compiler/runtime/write/laws.ts"
export { inForce, writeBatching } from "#compiler/runtime/write/transport.ts"
export {
	aboveJudgement,
	type EntryKey,
	entryKey,
	hostJudgement,
	statementRelations
} from "#compiler/runtime/write/witness.ts"
export { ServedPatterns } from "#compiler/scalar/regex/matcher.ts"
export { sameBytes } from "#compiler/scalar/values/bytes.ts"
export { compareValues } from "#compiler/scalar/values/identity.ts"
export { contractFile, servedFile } from "#compiler/served/json.ts"
export { type ContractParser, contractParserOver } from "#compiler/runtime/contract.ts"
export { carried, servedTree } from "#compiler/served/read.ts"
export {
	decodeKey,
	decodeRecord,
	encodeInput,
	encodeKey,
	encodeRecord,
	type ParsedInput,
	parseInput,
	slotDecoders,
	slotEncoders
} from "#compiler/live/codec.ts"
export { memberWire, type ServedWire, type WireDigest } from "#compiler/live/member.ts"
export type { MemberShape, MemberWire, WireFault, WireOptions } from "#compiler/live/shape.ts"
export type { WireFaultKind, WireJson, WireScalar } from "#compiler/live/wire.ts"
