/**
 * The engine's facade for a contract's checked mint (contract/parser.ts), which the shell's contract entry
 * (@bjornpagen/grizzle/domain) reads the engine through: the parser and the types it is stated over, and nothing a
 * served process loads, so the runtime facade (plan/runtime.ts) holds none of it.
 */

export { type DomainParser, domainParserOf } from "#compiler/contract/parser.ts"
export type { Facts } from "#compiler/types/core/phantom.ts"
export type { Domain, FieldBase } from "#compiler/types/fields/field.ts"
export type { DomainParseRefused } from "#compiler/types/schema/evaluation.ts"
