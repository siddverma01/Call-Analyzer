import type { User as UserRow } from "../../../generated/prisma/client.ts";

export type { FastifyReply, FastifyRequest } from "fastify";

/** Public shape of a user, with the password hash always excluded. */
export function toPublicUser(user: UserRow): {
  id: string;
  name: string;
  email: string;
  role: UserRow["role"];
  status: UserRow["status"];
  createdAt: Date;
} {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    status: user.status,
    createdAt: user.createdAt,
  };
}