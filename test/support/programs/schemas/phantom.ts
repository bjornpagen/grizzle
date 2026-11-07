/**
 * The names of types/core/phantom.ts the schema agreement's generated program reads as Ph
 * (test/support/agreement/schemas.ts), its prelude (test/support/prelude.ts): the program reads that namespace through
 * this module alone.
 */
export type {
	DomainOf,
	LanguageOf,
	SqlOfCarrier,
	SqlOfTerm,
	TypeOfTerm
} from "#compiler/types/core/phantom.ts"
