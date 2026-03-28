import { prisma } from './db';
import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';

// ── Password Hashing (Simple & Secure) ─────────────────────────────────────────

export function hashPassword(password: string): string {
	const salt = randomBytes(16).toString('hex');
	const hash = scryptSync(password, salt, 64).toString('hex');
	return `${salt}:${hash}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
	const [salt, hash] = storedHash.split(':');
	const hashToVerify = scryptSync(password, salt, 64).toString('hex');
	return timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(hashToVerify, 'hex'));
}

// ── Session Management (Database-backed) ───────────────────────────────────────

const SESSION_DURATION = 30 * 24 * 60 * 60 * 1000; // 30 days

export async function createSession(userId: string): Promise<string> {
	const sessionId = crypto.randomUUID();
	const expiresAt = new Date(Date.now() + SESSION_DURATION);

	await prisma.session.create({
		data: {
			id: sessionId,
			userId,
			expiresAt
		}
	});

	return sessionId;
}

export async function getSession(sessionId: string) {
	const session = await prisma.session.findUnique({
		where: { id: sessionId },
		include: { user: true }
	});

	if (!session || session.expiresAt.getTime() < Date.now()) {
		if (session) await deleteSession(sessionId);
		return null;
	}

	return session;
}

export async function deleteSession(sessionId: string) {
	await prisma.session.delete({ where: { id: sessionId } }).catch(() => {});
}
