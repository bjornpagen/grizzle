declare const require: (id: string) => unknown
declare const createRequire: (url: string) => unknown
export const lazy = import("#config/user.ts") // violation
export const other = import("#config/other.ts") // violation
export const cjs = require("node:fs") // violation
export const made = createRequire(import.meta.url) // violation
