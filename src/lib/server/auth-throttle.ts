import type { RequestEvent } from '@sveltejs/kit';
import { createHash } from 'node:crypto';
import { prisma } from './db';

export type AuthAction = 'register' | 'login' | 'resend';

type Scope = 'ip' | 'email';

type AuthThrottleRule = {
	scope: Scope;
	limit: number;
	windowMs: number;
	blockMs: number;
};

type ConsumeDecision = {
	allowed: boolean;
	retryAfterSeconds: number;
};

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

const RULES: Record<AuthAction, AuthThrottleRule[]> = {
	register: [
		{ scope: 'ip', limit: 5, windowMs: 15 * MINUTE_MS, blockMs: 15 * MINUTE_MS },
		{ scope: 'email', limit: 3, windowMs: 15 * MINUTE_MS, blockMs: 15 * MINUTE_MS }
	],
	login: [
		{ scope: 'ip', limit: 10, windowMs: 15 * MINUTE_MS, blockMs: 15 * MINUTE_MS },
		{ scope: 'email', limit: 5, windowMs: 15 * MINUTE_MS, blockMs: 15 * MINUTE_MS }
	],
	resend: [
		{ scope: 'email', limit: 1, windowMs: MINUTE_MS, blockMs: MINUTE_MS },
		{ scope: 'email', limit: 5, windowMs: 24 * HOUR_MS, blockMs: HOUR_MS },
		{ scope: 'ip', limit: 10, windowMs: HOUR_MS, blockMs: HOUR_MS }
	]
};

function hashScopeKey(input: string): string {
	return createHash('sha256').update(input).digest('hex');
}

function secondsUntil(date: Date): number {
	return Math.max(1, Math.ceil((date.getTime() - Date.now()) / 1000));
}

function extractIpFromHeader(value: string | null): string | null {
	if (!value) return null;
	const first = value
		.split(',')
		.map((part) => part.trim())
		.find(Boolean);
	return first || null;
}

export function resolveClientIp(event: RequestEvent): string {
	const realIp = extractIpFromHeader(event.request.headers.get('x-real-ip'));
	if (realIp) return realIp;

	const forwardedFor = extractIpFromHeader(event.request.headers.get('x-forwarded-for'));
	if (forwardedFor) return forwardedFor;

	try {
		return event.getClientAddress();
	} catch {
		return 'unknown';
	}
}

async function consumeLimit(action: AuthAction, scope: Scope, scopeValue: string, rule: AuthThrottleRule): Promise<ConsumeDecision> {
	const now = new Date();
	const scopeKeyHash = hashScopeKey(`${scope}:${scopeValue}`);

	return prisma.$transaction(async (tx) => {
		const bucket = await tx.authThrottleBucket.findUnique({
			where: {
				action_scopeKeyHash: {
					action,
					scopeKeyHash
				}
			}
		});

		if (!bucket) {
			await tx.authThrottleBucket.create({
				data: {
					action,
					scopeKeyHash,
					windowStart: now,
					hitCount: 1
				}
			});
			return { allowed: true, retryAfterSeconds: 0 };
		}

		if (bucket.blockedUntil && bucket.blockedUntil > now) {
			return {
				allowed: false,
				retryAfterSeconds: secondsUntil(bucket.blockedUntil)
			};
		}

		const windowEnded = now.getTime() - bucket.windowStart.getTime() >= rule.windowMs;
		if (windowEnded) {
			await tx.authThrottleBucket.update({
				where: { id: bucket.id },
				data: {
					windowStart: now,
					hitCount: 1,
					blockedUntil: null
				}
			});
			return { allowed: true, retryAfterSeconds: 0 };
		}

		const nextHits = bucket.hitCount + 1;
		if (nextHits > rule.limit) {
			const blockedUntil = new Date(now.getTime() + rule.blockMs);
			await tx.authThrottleBucket.update({
				where: { id: bucket.id },
				data: {
					hitCount: nextHits,
					blockedUntil
				}
			});
			return {
				allowed: false,
				retryAfterSeconds: secondsUntil(blockedUntil)
			};
		}

		await tx.authThrottleBucket.update({
			where: { id: bucket.id },
			data: { hitCount: nextHits }
		});
		return { allowed: true, retryAfterSeconds: 0 };
	});
}

export async function enforceAuthRateLimit(event: RequestEvent, action: AuthAction, emailNormalized?: string): Promise<ConsumeDecision> {
	const rules = RULES[action];
	const ip = resolveClientIp(event);
	let maxRetryAfterSeconds = 0;

	for (const rule of rules) {
		const scopeValue = rule.scope === 'email' ? emailNormalized : ip;
		if (!scopeValue) continue;

		const decision = await consumeLimit(action, rule.scope, scopeValue, rule);
		if (!decision.allowed) {
			maxRetryAfterSeconds = Math.max(maxRetryAfterSeconds, decision.retryAfterSeconds);
		}
	}

	if (maxRetryAfterSeconds > 0) {
		return { allowed: false, retryAfterSeconds: maxRetryAfterSeconds };
	}

	return { allowed: true, retryAfterSeconds: 0 };
}
