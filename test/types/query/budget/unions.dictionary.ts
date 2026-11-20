import { dictionary, word } from "@bjornpagen/testing/dictionary"
import { finite } from "@bjornpagen/testing/gen"
import { boundMembersItems, unionArmsItems } from "#test/types/query/budget/unions.ts"

/** A union's arms, the arms gate's one dimension: its name, its steps, and its program at a size. */
export const unionArms = finite(word(dictionary(unionArmsItems)))

/** A ChangeSet's members over a bound union, the members gate's one dimension. */
export const boundMembers = finite(word(dictionary(boundMembersItems)))
