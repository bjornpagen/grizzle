import { dictionary } from "@bjornpagen/testing/dictionary"
import { FAILURES } from "#test/generated/printed-requests.fixtures.ts"

/** Every failure the suite lists: the failures its package is built to answer. */
export const failures = dictionary(FAILURES)
