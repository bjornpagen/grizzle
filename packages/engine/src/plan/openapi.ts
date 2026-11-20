/**
 * The OpenAPI plan: every engine name @bjornpagen/grizzle-openapi's writer reads (packages/openapi/src/openapi.ts),
 * each re-exported from the one module that holds it: a login's served file, the live event model its answers stream,
 * the wire's shapes and scalar table its schemas interpret, the canonical JSON and digest its text and its shared
 * components' names are, and the sharing that writes each repeated node once. The package's reader, which a browser
 * loads, reads the engine through plan/client.ts. The engine imports nothing of the package.
 */
export { canonicalEquals, type Json, writeCanonicalJson } from "#compiler/core/canonical.ts"
export type { CompileError } from "#compiler/core/errors.ts"
export { compareStrings } from "#compiler/core/order.ts"
export { isList } from "#compiler/core/record.ts"
export { sha256Base32 } from "#compiler/core/sha256.ts"
export { type Parts, type SharingFormat, shareRepeated } from "#compiler/core/share.ts"
export { octetsOf, regexRefOf, type ScalarType } from "#compiler/ir/scalar.ts"
export {
	type EventDescriptor,
	events,
	type Retry,
	type Role,
	wireHeader,
	wireRefusals
} from "#compiler/live/events.ts"
export {
	memberShape,
	roleWitness,
	type ServedLeaf,
	type ServedWire,
	wireScalarOf
} from "#compiler/live/member.ts"
export {
	inputSchema,
	type MemberShape,
	type RoleWitness,
	type SchemaReference,
	slotSchemas,
	type WireFacts,
	type WireInput,
	type WireParam
} from "#compiler/live/shape.ts"
export { type SchemaGap, scalarSchema, type WireSchema, withGaps } from "#compiler/live/wire.ts"
export type { ServedFile, ServedMember, ServedRoleForm } from "#compiler/served/forms.ts"
