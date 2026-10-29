import { CursorError, type CursorFault } from "#compiler/core/errors.ts"

/**
 * The cursor refusal vocabulary.
 *
 * Every refusal of a token is CursorError{ reason: { _tag: word } } with one fixed word below, raised on the host before any SQL is
 * sent. A reason never carries the token, its bytes, a boundary value or a parameter, so default logs never hold a
 * raw cursor or a parameter. The words are listed in the order validation
 * checks them, so a token that is wrong in several ways reports the first (test/unit/cursor/codec.test.ts pins each
 * adjacent pair). One check is reported out of list order: a tuple whose count differs from the codec's comparators
 * is cursorMalformed, but it is checked after cursorComparator, because the count only means something against a
 * matching comparator sequence. A token of an order with another number of comparators is
 * therefore cursorComparator; only a forged token whose comparator digest matches reaches the arity check.
 */
export const cursorError = (fault: CursorFault): CursorError => CursorError.make({ _tag: fault })
