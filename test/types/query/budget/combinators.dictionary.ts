import { dictionary, word } from "@bjornpagen/testing/dictionary"
import { finite } from "@bjornpagen/testing/gen"
import { combinatorsItems } from "#test/types/query/budget/combinators.ts"

/** Every combinator a query is written with beyond its first rule, each a case of the combinators' cost gate. */
export const combinatorKinds = finite(word(dictionary(combinatorsItems)))
