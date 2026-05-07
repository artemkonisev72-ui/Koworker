import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type MailPayload = {
	from: string;
	to: string;
	subject: string;
	text: string;
	html: string;
};

const sendMailMock = vi.hoisted(() => vi.fn());
const createTransportMock = vi.hoisted(() => vi.fn());

vi.mock('$env/dynamic/private', () => ({
	env: process.env
}));

vi.mock('nodemailer', () => ({
	default: {
		createTransport: createTransportMock
	}
}));

const ORIGINAL_ENV = { ...process.env };

function getSentMail(): MailPayload {
	expect(sendMailMock).toHaveBeenCalledTimes(1);
	return sendMailMock.mock.calls[0][0] as MailPayload;
}

beforeEach(() => {
	vi.resetModules();
	vi.clearAllMocks();
	process.env = {
		...ORIGINAL_ENV,
		NODE_ENV: 'test',
		APP_BASE_URL: 'https://env.koworker.test',
		SMTP_HOST: 'smtp.example.com',
		SMTP_PORT: '2525',
		SMTP_SECURE: 'false',
		SMTP_FROM: 'Coworker <no-reply@example.com>'
	};
	sendMailMock.mockResolvedValue({});
	createTransportMock.mockReturnValue({ sendMail: sendMailMock });
});

afterEach(() => {
	process.env = ORIGINAL_ENV;
});

describe('auth email rendering', () => {
	it('sends a branded verification email with CTA, logo, fallback link, and escaped name', async () => {
		const { sendVerificationEmail } = await import('./auth-email');

		const result = await sendVerificationEmail({
			to: 'user@example.com',
			name: '<Анна & Co>',
			token: 'verify-token',
			baseUrl: 'https://koworker.test'
		});

		const verificationUrl = 'https://koworker.test/verify-email?token=verify-token';
		const mail = getSentMail();

		expect(result).toEqual({ delivered: true, verificationUrl });
		expect(createTransportMock).toHaveBeenCalledWith(
			expect.objectContaining({
				host: 'smtp.example.com',
				port: 2525,
				secure: false
			})
		);
		expect(mail).toMatchObject({
			from: 'Coworker <no-reply@example.com>',
			to: 'user@example.com',
			subject: 'Подтвердите адрес электронной почты'
		});
		expect(mail.text).toContain(`Ссылка для подтверждения: ${verificationUrl}`);
		expect(mail.html).toContain('<!doctype html>');
		expect(mail.html).toContain('background-color:#f9f8f6');
		expect(mail.html).toContain('background-color:#ffffff');
		expect(mail.html).toContain('src="https://koworker.test/pwa-192x192.png"');
		expect(mail.html).toContain('Koworker');
		expect(mail.html).toContain(`href="${verificationUrl}"`);
		expect(mail.html).toContain('Подтвердить почту');
		expect(mail.html).toContain('Ссылка для подтверждения');
		expect(mail.html).toContain('Здравствуйте, &lt;Анна &amp; Co&gt;!');
		expect(mail.html).not.toContain('Здравствуйте, <Анна & Co>!');
	});

	it('sends a branded password reset email with the shared template and reset URL', async () => {
		const { sendPasswordResetEmail } = await import('./auth-email');

		const result = await sendPasswordResetEmail({
			to: 'user@example.com',
			name: null,
			token: 'reset-token',
			baseUrl: 'https://koworker.test'
		});

		const resetUrl = 'https://koworker.test/reset-password?token=reset-token';
		const mail = getSentMail();

		expect(result).toEqual({ delivered: true, resetUrl });
		expect(mail).toMatchObject({
			from: 'Coworker <no-reply@example.com>',
			to: 'user@example.com',
			subject: 'Смена пароля Koworker'
		});
		expect(mail.text).toContain(`Ссылка для смены пароля: ${resetUrl}`);
		expect(mail.html).toContain('src="https://koworker.test/pwa-192x192.png"');
		expect(mail.html).toContain('Смена пароля');
		expect(mail.html).toContain('Сменить пароль');
		expect(mail.html).toContain('Ссылка для смены пароля');
		expect(mail.html).toContain(`href="${resetUrl}"`);
		expect(mail.html).toContain('Если вы не запрашивали смену пароля');
	});
});
