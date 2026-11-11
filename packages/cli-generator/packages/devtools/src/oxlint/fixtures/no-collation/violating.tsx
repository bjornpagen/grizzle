export const ordered = "select name from users order by name collate \"C\"" // violation
export const upper = `SELECT name FROM users ORDER BY name COLLATE "C"` // violation
export const catalog = "select datcollate from pg_database"
export const word = "collateral damage"
