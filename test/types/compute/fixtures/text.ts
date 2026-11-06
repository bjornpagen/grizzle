import { Compute } from "#compiler/public/compute.ts"
import { contract, type Uuid } from "#compiler/public/fields.ts"
import { str } from "#compiler/public/text.ts"
import type { Guard } from "#compiler/types/compute/scalar.ts"
import type { SqlOfTerm, Term, TypeOfTerm } from "#compiler/types/core/phantom.ts"
import type { Infer } from "#compiler/types/fields/field.ts"
import type { Equals, Expect } from "#test/types/compute/support.ts"
import type { IsAssignable } from "#test/types/schema/support.ts"

/**
 * The text terms' public types: concat, startsWith, endsWith and matches. concat is text of no pattern, the two tests
 * boolean terms, and a match a guard over its subject whatever its pattern is. A literal pattern is read by ArkRegex's
 * grammar check under the flags "u", as str.regex reads its own source; a pattern term is any text term, its values
 * checked when the schema compiles. Every `@ts-expect-error -- TSnnnn` names the diagnostic the type-test batch
 * requires on its next line.
 */
const Body = contract("Body", str.regex("^.*$", "su"))

declare const text: Term<string, unknown, unknown, "text">
declare const other: Term<string, { readonly p: string }, unknown, "text">
declare const body: Term<Infer<typeof Body>, unknown, unknown, "text">
declare const id: Term<Uuid, unknown, unknown, "uuid">
declare const big: Term<bigint, unknown, unknown, "bigint">

/** concat is text of no pattern, its parameters both operands'. */
export const joined = Compute.concat(text, other)
export type JoinedText = Expect<Equals<SqlOfTerm<typeof joined>, "text">>
export type JoinedHost = Expect<Equals<TypeOfTerm<typeof joined>, string>>
export const joinedLiteral = Compute.concat(text, " ")
export type JoinedLiteral = Expect<Equals<SqlOfTerm<typeof joinedLiteral>, "text">>
/** A contract's text meets its own type only, as in every other operation. */
export const joinedBody = Compute.concat(body, body)
// @ts-expect-error -- TS2345: a contract's text never meets plain text without Compute.base
export const bodyAndText = Compute.concat(body, text)
// @ts-expect-error -- TS2345: concat is text's, never a uuid's
export const joinedUuid = Compute.concat(id, " ")
// @ts-expect-error -- TS2345: concat's second operand is text
export const textAndUuid = Compute.concat(text, id)

/** The prefix and suffix tests are boolean terms. */
export const starts = Compute.startsWith(text, "a")
export type StartsBoolean = Expect<Equals<SqlOfTerm<typeof starts>, "boolean">>
export const ends = Compute.endsWith(text, other)
export type EndsBoolean = Expect<Equals<SqlOfTerm<typeof ends>, "boolean">>
// @ts-expect-error -- TS2345: a suffix test is text's, never a bigint's
export const endsOfBig = Compute.endsWith(big, "1")

/** A match is a guard over its subject, of a literal pattern or a term. */
export const digits = Compute.matches(text, "^[0-9]+$")
export type DigitsGuard = Expect<
	IsAssignable<typeof digits, Guard<Term<string, unknown, unknown, "text">>>
>
export const byTerm = Compute.matches(text, other)
export type ByTermGuard = Expect<
	IsAssignable<typeof byTerm, Guard<Term<string, unknown, unknown, "text">>>
>
// @ts-expect-error -- TS2345: a pattern term meets its subject's type, and a contract's text is not plain text
export const byBody = Compute.matches(text, body)
/** Compute.when's branch receives the match's subject. */
export const parsed = Compute.when(Compute.matches(text, "^a"), (t) => Compute.concat(t, "!"), "")
export type WhenText = Expect<Equals<SqlOfTerm<typeof parsed>, "text">>
/** A source typed string is the builder's to admit where the call is written. */
declare const runtime: string
export const atRuntime = Compute.matches(text, runtime)
export type RuntimeGuard = Expect<
	IsAssignable<typeof atRuntime, Guard<Term<string, unknown, unknown, "text">>>
>
// @ts-expect-error -- TS2345: a pattern outside the grammar is refused by its literal, as str.regex refuses it
export const unclosed = Compute.matches(text, "a(")
// @ts-expect-error -- TS2345: a match's subject is text, never a bigint
export const bigMatch = Compute.matches(big, "^1$")
// @ts-expect-error -- TS2345: a pattern is text, never a uuid
export const uuidPattern = Compute.matches(text, id)
