import { dictionary } from "@bjornpagen/testing/dictionary"
import { callKinds } from "#test/support/call-sources.ts"

/** Every call a rule matches at a row (test/support/call-sources.ts): each kind of call source, the domain itself. */
export const callSourceBox = dictionary(callKinds)
