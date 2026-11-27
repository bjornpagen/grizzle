import { dictionary } from "@bjornpagen/testing/dictionary"
import { settings } from "#test/pg/served/absent-claims.fixtures.ts"

/** Every standing of the claims setting a reader reads under, the values the context source branches on. */
export const claimSettings = dictionary(settings)
