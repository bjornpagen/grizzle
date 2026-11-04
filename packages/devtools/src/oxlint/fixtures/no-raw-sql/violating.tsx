declare const column: string
export const literal = "SELECT x::text" // violation
export const template = `SELECT ${column}::text` // violation
export const after = `CASE ${column} WHEN 'a' THEN 1 END::integer` // violation
export const unclosed = "SELECT $1::name" // violation
