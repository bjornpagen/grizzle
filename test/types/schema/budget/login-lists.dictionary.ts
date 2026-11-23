import { dictionary, word } from "@bjornpagen/testing/dictionary"
import { finite } from "@bjornpagen/testing/gen"
import { loginListsItems } from "#test/types/schema/budget/login-lists.ts"

/** The login list's one dimension, its length, the case of its cost gate. */
export const loginLists = finite(word(dictionary(loginListsItems)))
