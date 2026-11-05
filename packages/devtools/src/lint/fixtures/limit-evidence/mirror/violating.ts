import { Effect } from "effect"

export const retried = Effect.void.pipe(Effect.retry({ times: 3 })) // violation
