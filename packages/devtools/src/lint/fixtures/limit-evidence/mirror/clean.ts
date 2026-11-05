import { Effect } from "effect"

/** A documentation mirror, which the options except: the documented application's numbers are its own. */
export const retried = Effect.void.pipe(Effect.retry({ times: 3 }))
