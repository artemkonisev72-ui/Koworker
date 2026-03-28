/**
 * db.ts — Prisma Client singleton
 * Prisma 7.x uses the driver adapter pattern.
 * PrismaPg requires a pg.Pool instance (not a raw config object).
 */
import { PrismaClient } from '../../../generated/prisma/index.js';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { DATABASE_URL } from '$env/static/private';

const { Pool } = pg;

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };

function createPrismaClient(): PrismaClient {
	if (!DATABASE_URL) {
		throw new Error('[DB] DATABASE_URL is not defined. Check your .env file on the server.');
	}
	const pool = new Pool({ connectionString: DATABASE_URL });
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const adapter = new PrismaPg(pool as any);
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	return new PrismaClient({ adapter } as any);
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;
