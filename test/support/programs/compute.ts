/**
 * The names the Compute agreement's generated program reads (test/support/agreement/compute.ts), its prelude
 * (test/support/prelude.ts): the program imports these alone, each through this module.
 */
export { Compute } from "#compiler/public/compute.ts"
export { Bits, bytes, Decimal, generated, Money, uuid } from "#compiler/public/fields.ts"
export type { CalendarDate, Span, Uuid, Vector } from "#compiler/public/fields.ts"
export { query, v } from "#compiler/public/query.ts"
export type { HeadOf, ParamsOf, ParamType, Rule } from "#compiler/public/query.ts"
export { relation, schema } from "#compiler/public/schema.ts"
export { lexicalForm, str } from "#compiler/public/text.ts"
export type { DomainOf, Rostered, SqlOfTerm, TypeOfTerm } from "#compiler/types/core/phantom.ts"
export type { Infer } from "#compiler/types/fields/field.ts"
export type { Aggregate } from "#compiler/types/query/terms.ts"
export { Cell, Cells, Heads, Tone, Tuning } from "#test/support/agreement/compute-schema.ts"
