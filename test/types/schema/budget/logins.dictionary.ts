import { dictionary, word } from "@bjornpagen/testing/dictionary"
import { finite } from "@bjornpagen/testing/gen"
import { loginDimensionsItems } from "#test/types/schema/budget/logins.ts"

/** The login-scale program's one dimension, its relations: a roster of one, its every size a program of its own. */
export const loginDimensions = finite(word(dictionary(loginDimensionsItems)))
