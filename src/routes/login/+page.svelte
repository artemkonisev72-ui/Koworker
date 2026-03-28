<script lang="ts">
	let { form } = $props();
</script>

<div class="auth-container">
	<div class="auth-card">
		<header class="auth-header">
			<span class="auth-logo">⚛</span>
			<h1>Вход в CoWorker</h1>
			<p>С возвращением! Войдите в свою учетную запись.</p>
		</header>

		<form method="POST" class="auth-form">
			{#if form?.message}
				<div class="auth-error">{form.message}</div>
			{/if}

			<div class="form-group">
				<label for="email">Email</label>
				<input type="email" id="email" name="email" value={form?.email ?? ''} placeholder="name@example.com" required />
			</div>

			<div class="form-group">
				<label for="password">Пароль</label>
				<input type="password" id="password" name="password" placeholder="••••••••" required />
			</div>

			<button type="submit" class="auth-submit">Войти</button>
		</form>

		<footer class="auth-footer">
			Нет аккаунта? <a href="/register">Зарегистрироваться</a>
		</footer>
	</div>
</div>

<style>
	.auth-container {
		display: flex;
		align-items: center;
		justify-content: center;
		min-height: 100vh;
		background: var(--bg-base);
		padding: 1rem;
	}
	.auth-card {
		width: 100%;
		max-width: 400px;
		background: var(--bg-card);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-lg);
		padding: 2.5rem;
		box-shadow: var(--shadow-lg);
		animation: fadeInUp 0.4s ease;
	}
	.auth-header {
		text-align: center;
		margin-bottom: 2rem;
	}
	.auth-logo {
		font-size: 2.5rem;
		line-height: 1;
		margin-bottom: 0.5rem;
		display: block;
	}
	.auth-header h1 {
		font-size: 1.5rem;
		font-weight: 700;
		color: var(--text-primary);
		margin-bottom: 0.5rem;
	}
	.auth-header p {
		color: var(--text-secondary);
		font-size: 0.88rem;
	}
	.auth-form {
		display: flex;
		flex-direction: column;
		gap: 1.25rem;
	}
	.auth-error {
		padding: 0.75rem;
		background: rgba(0, 0, 0, 0.05);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-md);
		color: var(--text-primary);
		font-size: 0.85rem;
		text-align: center;
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
		margin-top: 0.5rem;
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
		margin-top: 2rem;
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
		from { opacity: 0; transform: translateY(10px); }
		to { opacity: 1; transform: translateY(0); }
	}
</style>
