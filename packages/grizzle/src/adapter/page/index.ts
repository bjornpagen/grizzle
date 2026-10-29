import type { Effect } from "effect"
import type { ReadError } from "#adapter/errors/execution.ts"
import { type PageRun, runPage } from "#adapter/page/page.ts"
import type { CursorError } from "#compiler/core/errors.ts"
import type { Page } from "#compiler/types/page/page.ts"

/**
 * The cursor-pagination runtime: QueryReader.page and Compiled.page.
 *
 * The readers (reader/reader.ts) dispatch here with the contract below (PageRun): the Db context,
 * the reader's executor, and the page's query, parameters and request, plus the template a compiled handle holds. The
 * modules:
 *
 * - request.ts: the four request shapes and the size bound, checked before anything else;
 * - template.ts: the page runtime template of a compiled ordered query: the page compiler's statements of every
 *   request variant and probe with their specs and the cursor codec, once per template;
 * - execute.ts: one request as the flight of one transaction: the k + 1 rows, the heading-group merge, the lookahead,
 *   the backward reversal, the attachments over the delivered page and the probe of the opposite flag;
 * - page.ts: the operation itself, from the request to the Page with its cursors.
 */
export const page = <A, Q>(run: PageRun<A>): Effect.Effect<Page<A, Q>, ReadError | CursorError> =>
	runPage<A, Q>(run)
