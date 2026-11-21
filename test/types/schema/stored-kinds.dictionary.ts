import { dictionary } from "@bjornpagen/testing/dictionary"
import { storedKindsBoxItems } from "#test/types/schema/stored-kinds.ts"

/** The box: every way a caller writes or states a stored search document or a stored computed numeric. */
export const storedKindsBox = dictionary(storedKindsBoxItems)
