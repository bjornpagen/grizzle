/**
 * Why no field draws an id: grizzle mints none. A row is keyed by its natural identity, the facts that make it the one
 * it is, so a fact written twice is one fact and a key names the same row in every database that holds it.
 */
export const mintedRefusal =
	"grizzle mints no ids: key a row by its natural identity, its parent's key and its own name or place, a content digest, a published name and version, or an outside system's id under a contract of its own" as const

/**
 * Why no column is a bare uuid: an id is some system's, and a contract over uuid says whose, so a Clerk user's id is
 * never written where a Stripe customer's belongs. The relation builders refuse a bare uuid field by this message, and
 * the types where it is written (types/fields/field.ts NamedIds).
 */
export const unnamedIdRefusal =
	'say whose id this is: contract<typeof key>()("ClerkUserId", uuid)' as const

/**
 * What pg.smallserial, pg.serial, pg.bigserial and pg.uuidv7 are: no field descriptor but the refusal of one, a value
 * of the shape types/core/phantom.ts Refusal spells, which the pg namespace's type states spelt out (never under an
 * alias, so a diagnostic prints the message), so a declaration that names one is a type error that names the model,
 * and from JavaScript describeField refuses it by the same message (scalar/registry.ts refusedField).
 */
export const minted: { readonly "grizzle type error": typeof mintedRefusal } = Object.freeze({
	"grizzle type error": mintedRefusal
})
