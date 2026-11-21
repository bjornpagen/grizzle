import { dictionary } from "@bjornpagen/testing/dictionary"
import { foldDigestsBoxItems } from "#test/types/schema/fold-digests.ts"

/** Every cell: a concat fold's running texts named as themselves or by their digests, and a sum's by a generated field. */
export const foldDigestsBox = dictionary(foldDigestsBoxItems)
