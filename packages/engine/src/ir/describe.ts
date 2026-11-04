import type { Json } from "#compiler/core/canonical.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import * as Result from "#compiler/core/result.ts"
import { decodeDesc, descToJson, type QueryDesc } from "#compiler/ir/desc.ts"

/**
 * The QueryDescription codec.
 *
 * describeQuery and lowerQuery are the inspection vocabulary. A QueryDescription is the serializable form of a query:
 * its Description in JSON form, bigints and decimals as tagged strings and source locations kept, so it can be stored
 * and sent without the caller authoring a query tree. This module is the codec only; the program package wraps it as
 * describeQuery over query values.
 *
 * Nothing in a QueryDescription is executable, and no parameter value is part of it.
 */

/** A Description to its QueryDescription. The Description is decoded first, so a malformed one never escapes. */
export const toQueryDescription = (desc: QueryDesc): Result.Result<Json, CompileError> =>
	Result.flatMap(decodeDesc("query", desc), descToJson)
