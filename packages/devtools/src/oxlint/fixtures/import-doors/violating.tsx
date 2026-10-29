import assert from "node:assert" // violation
import { isDeepStrictEqual } from "node:util" // violation
import * as util from "node:util" // violation
import { inspect } from "node:util"
export { isDeepStrictEqual as same } from "node:util" // violation
export * from "node:util" // violation
export const used = [assert, isDeepStrictEqual, util, inspect]
