/**
 * The engine's facade for a contract's checked mint (contract/parser.ts), which the shell's contract entry
 * (@bjornpagen/grizzle/contract) reads the engine through: the parser and the types it is stated over, and nothing a
 * served process loads, so the runtime facade (plan/runtime.ts) holds none of it.
 */

export { type ContractParser, contractParserOf } from "#compiler/contract/parser.ts"
export type { Facts } from "#compiler/types/core/phantom.ts"
export type { Contract, FieldBase } from "#compiler/types/fields/field.ts"
export type { ContractRefused } from "#compiler/types/schema/evaluation.ts"
