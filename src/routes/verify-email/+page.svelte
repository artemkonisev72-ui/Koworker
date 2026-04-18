<script lang="ts">
	import { resolve } from '$app/paths';

	let { data, form } = $props();
</script>

<div class="auth-container">
	<div class="auth-card">
		<header class="auth-header">
			<img src="/pwa-192x192.png" alt="Auth Logo" class="auth-logo" />
			<h1>Verify Email</h1>
			<p>Confirm your address to finish account activation.</p>
		</header>

		{#if data.tokenStatus === 'expired'}
			<div class="auth-error">This verification link has expired. Request a new one below.</div>
		{:else if data.tokenStatus === 'invalid'}
			<div class="auth-error">Invalid verification link. Request a fresh link below.</div>
		{/if}

		{#if form?.message}
			<div class={form?.success ? 'auth-success' : 'auth-error'}>{form.message}</div>
		{/if}

		<form method="POST" class="auth-form">
			<div class="form-group">
				<label for="email">Email</label>
				<input
					type="email"
					id="email"
					name="email"
					value={form?.email ?? data.email ?? ''}
					placeholder="name@example.com"
					required
				/>
			</div>
			<button type="submit" class="auth-submit">Send verification link</button>
		</form>

		<footer class="auth-footer">
			Already verified? <a href={resolve('/login')}>Sign in</a>
		</footer>
	</div>
</div>

<style>
	.auth-container {
		display: flex;
		align-items: center;
		justify-content: center;
		min-height: 100dvh;
		background: var(--bg-base);
		padding:
			calc(1rem + env(safe-area-inset-top))
			calc(1rem + env(safe-area-inset-right))
			calc(1rem + env(safe-area-inset-bottom))
			calc(1rem + env(safe-area-inset-left));
	}
	.auth-card {
		width: 100%;
		max-width: 420px;
		background: var(--bg-card);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-lg);
		padding: 2.5rem;
		box-shadow: var(--shadow-lg);
		animation: fadeInUp 0.4s ease;
	}
	.auth-header {
		text-align: center;
		margin-bottom: 1.5rem;
	}
	.auth-logo {
		width: 48px;
		height: 48px;
		object-fit: contain;
		margin: 0 auto 0.5rem;
		display: block;
	}
	.auth-header h1 {
		font-size: 1.6rem;
		font-weight: 700;
		color: var(--text-primary);
		margin-bottom: 0.35rem;
	}
	.auth-header p {
		color: var(--text-secondary);
		font-size: 0.9rem;
	}
	.auth-form {
		display: flex;
		flex-direction: column;
		gap: 1.2rem;
	}
	.auth-error,
	.auth-success {
		padding: 0.75rem;
		border-radius: var(--radius-md);
		font-size: 0.86rem;
		text-align: center;
		margin-bottom: 1rem;
	}
	.auth-error {
		background: rgba(239, 68, 68, 0.1);
		border: 1px solid rgba(239, 68, 68, 0.35);
		color: #991b1b;
	}
	.auth-success {
		background: rgba(16, 185, 129, 0.12);
		border: 1px solid rgba(16, 185, 129, 0.35);
		color: #065f46;
	}
	.form-group {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.form-group label {
		font-size: 0.85rem;
		font-weight: 600;
		color: var(--text-primary);
	}
	.form-group input {
		padding: 0.75rem 1rem;
		background: var(--bg-base);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-md);
		color: var(--text-primary);
		font-size: 0.95rem;
		transition: border-color var(--transition-fast);
	}
	.form-group input:focus {
		outline: none;
		border-color: var(--accent-primary);
	}
	.auth-submit {
		margin-top: 0.25rem;
		padding: 0.85rem;
		background: var(--accent-primary);
		color: var(--bg-base);
		border: none;
		border-radius: var(--radius-md);
		font-weight: 700;
		cursor: pointer;
		transition: opacity var(--transition-fast);
	}
	.auth-submit:hover {
		opacity: 0.9;
	}
	.auth-footer {
		margin-top: 1.5rem;
		text-align: center;
		font-size: 0.85rem;
		color: var(--text-secondary);
	}
	.auth-footer a {
		color: var(--text-primary);
		font-weight: 600;
		text-decoration: none;
	}
	.auth-footer a:hover {
		text-decoration: underline;
	}

	@keyframes fadeInUp {
		from {
			opacity: 0;
			transform: translateY(10px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}
</style>
