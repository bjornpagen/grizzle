import { dictionary } from "@bjornpagen/testing/dictionary"
import { unionJoinBoxItems } from "#test/types/query/union-join.ts"

/** Every union shape the union-join program writes, each a cell of its box. */
export const unionJoinBox = dictionary(unionJoinBoxItems)
