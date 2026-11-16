import { dictionary, word } from "@bjornpagen/testing/dictionary"
import { finite } from "@bjornpagen/testing/gen"
import { memberFormsItems } from "#test/types/changeset/budget/members.ts"

/** Every op and member kind, each a case of the members' cost gate. */
export const memberForms = finite(word(dictionary(memberFormsItems)))
