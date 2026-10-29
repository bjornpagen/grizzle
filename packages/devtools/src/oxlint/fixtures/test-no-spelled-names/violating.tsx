export const key = "users__pk" // violation
export const foreign = `orders__fk__users` // violation
export const label = "users primary key"
export const record = { users__pk: 1 }
export const quoted = { "users__pk": 1 }
export type Name = "users__pk"
