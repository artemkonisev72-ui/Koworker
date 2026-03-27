/**
 * db.ts — Prisma Client singleton
 * Prisma 7.x uses the driver adapter pattern.
 * Uses @prisma/adapter-pg with the pg Pool for PostgreSQL.
 */
import { PrismaClient } from '../../../generated/prisma/client.js';
import { PrismaPg } from '@prisma/adapter-pg';
import { DATABASE_URL } from '$env/static/private';

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };

function createPrismaClient(): PrismaClient {
	const adapter = new PrismaPg({ connectionString: DATABASE_URL });
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	return new PrismaClient({ adapter } as any);
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;
