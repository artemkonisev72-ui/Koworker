<script lang="ts">
	/**
	 * +page.svelte — Main chat interface
	 * SSE client + sidebar + message list + input
	 */
	import { onMount, tick } from 'svelte';
	import MessageRenderer from '$lib/components/MessageRenderer.svelte';

	interface GraphPoint { x: number; y: number; }
	interface ChatMessage {
		id: string;
		role: 'USER' | 'ASSISTANT' | 'SYSTEM';
		content: string;
		graphData?: GraphPoint[] | null;
		imageData?: string | null; // JSON string of {base64, mimeType}
		createdAt?: string;
		isStreaming?: boolean;
	}
	interface Chat { id: string; title: string; updatedAt: string; }

	// ── State ─────────────────────────────────────────────────────────────────
	let chats = $state<Chat[]>([]);
	let activeChatId = $state<string | null>(null);
	let messages = $state<ChatMessage[]>([]);
	let inputValue = $state('');
	let isLoading = $state(false);
	let statusMessage = $state('');
	let sidebarOpen = $state(true);
	let messagesEnd: HTMLDivElement | undefined = $state();
	let inputEl: HTMLTextAreaElement | undefined = $state();
	let fileInputEl: HTMLInputElement | undefined = $state();

	// Image upload state
	let selectedImage = $state<{ base64: string; mimeType: string } | null>(null);

	// ── Init ──────────────────────────────────────────────────────────────────
	onMount(async () => {
		await loadChats();
		// Auto-select first chat or create one
		if (chats.length > 0) {
			await selectChat(chats[0].id);
		}
	});

	async function loadChats() {
		try {
			const res = await fetch('/api/chats');
			if (res.ok) chats = await res.json();
		} catch (e) {
			console.error('Failed to load chats', e);
		}
	}

	async function createChat() {
		try {
			const res = await fetch('/api/chats', { method: 'POST' });
			if (res.ok) {
				const chat = await res.json();
				chats = [chat, ...chats];
				await selectChat(chat.id);
			}
		} catch (e) {
			console.error('Failed to create chat', e);
		}
	}

	async function selectChat(chatId: string) {
		if (activeChatId === chatId) return;
		activeChatId = chatId;
		messages = [];
		await loadMessages(chatId);
	}

	async function loadMessages(chatId: string) {
		try {
			const res = await fetch(`/api/chat?chatId=${chatId}`);
			if (res.ok) {
				const data = await res.json();
				messages = data.map((m: ChatMessage & { graphData?: string | GraphPoint[] }) => ({
					...m,
					graphData: typeof m.graphData === 'string'
						? JSON.parse(m.graphData)
						: m.graphData
				}));
				await scrollToBottom();
			}
		} catch (e) {
			console.error('Failed to load messages', e);
		}
	}

	async function scrollToBottom() {
		await tick();
		messagesEnd?.scrollIntoView({ behavior: 'smooth' });
	}

	function handleFileChange(e: Event) {
		const target = e.target as HTMLInputElement;
		const file = target.files?.[0];
		if (!file) return;

		const reader = new FileReader();
		reader.onload = (event) => {
			const base64 = (event.target?.result as string).split(',')[1];
			selectedImage = { base64, mimeType: file.type };
		};
		reader.readAsDataURL(file);
	}

	function removeImage() {
		selectedImage = null;
		if (fileInputEl) fileInputEl.value = '';
	}

	// ── SSE Send ──────────────────────────────────────────────────────────────
	async function sendMessage() {
		const text = inputValue.trim();
		if (!text || isLoading) return;

		// Create chat if none active
		if (!activeChatId) await createChat();
		if (!activeChatId) return;

		inputValue = '';
		isLoading = true;
		statusMessage = '';

		// Optimistically add user message
		const userMsg: ChatMessage = {
			id: crypto.randomUUID(),
			role: 'USER',
			content: text,
			imageData: selectedImage ? JSON.stringify(selectedImage) : null,
			createdAt: new Date().toISOString()
		};
		messages = [...messages, userMsg];

		const imageData = selectedImage;
		selectedImage = null; // Clear input
		if (fileInputEl) fileInputEl.value = '';

		// Placeholder for assistant response
		const assistantId = crypto.randomUUID();
		const assistantPlaceholder: ChatMessage = {
			id: assistantId,
			role: 'ASSISTANT',
			content: '',
			isStreaming: true
		};
		messages = [...messages, assistantPlaceholder];
		await scrollToBottom();

		// Open SSE connection
		const res = await fetch('/api/chat', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ 
				chatId: activeChatId, 
				message: text,
				imageData: imageData
			})
		});

		if (!res.ok || !res.body) {
			messages = messages.map((m) =>
				m.id === assistantId
					? { ...m, content: 'Ошибка соединения с сервером.', isStreaming: false }
					: m
			);
			isLoading = false;
			return;
		}

		const reader = res.body.getReader();
		const decoder = new TextDecoder();
		let buffer = '';

		while (true) {
			const { done, value } = await reader.read();
			if (done) break;

			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split('\n');
			buffer = lines.pop() ?? '';

			for (const line of lines) {
				if (!line.startsWith('data: ')) continue;
				const payload = line.slice(6).trim();
				if (payload === '[DONE]') break;

				try {
					const event = JSON.parse(payload) as {
						type: string;
						message?: string;
						content?: string;
						generatedCode?: string;
						executionLogs?: string;
						graphData?: GraphPoint[];
					};

					if (event.type === 'status') {
						statusMessage = event.message ?? '';
					} else if (event.type === 'result') {
						messages = messages.map((m) =>
							m.id === assistantId
								? {
										...m,
										content: event.content ?? '',
										graphData: event.graphData ?? null,
										isStreaming: false
									}
								: m
						);
						statusMessage = '';
						await loadChats(); // Refresh sidebar titles
						await scrollToBottom();
					} else if (event.type === 'error') {
						messages = messages.map((m) =>
							m.id === assistantId
								? { ...m, content: `⚠️ ${event.message}`, isStreaming: false }
								: m
						);
						statusMessage = '';
						await scrollToBottom();
					}
				} catch {
					// JSON parse error — skip the line
				}
			}
		}

		isLoading = false;
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			sendMessage();
		}
	}

	function autoResize(e: Event) {
		const el = e.target as HTMLTextAreaElement;
		el.style.height = 'auto';
		el.style.height = Math.min(el.scrollHeight, 200) + 'px';
	}

	// Example prompts
	const EXAMPLES = [
		'Найди реакции опор балки длиной 4 м с равномерной нагрузкой q=10 кН/м',
		'Вычисли интеграл ∫ x²·sin(x) dx',
		'Построй эпюры M и Q для консольной балки с сосредоточенной силой P=5 кН',
		'Найди собственные значения матрицы [[2,1],[1,2]]'
	];
</script>

<div class="app-shell">

	<!-- ── Sidebar ────────────────────────────────────────────────────────── -->
	<aside class="sidebar" class:collapsed={!sidebarOpen}>
		<div class="sidebar-header">
			<div class="logo">
				<span class="logo-icon">⚛</span>
				<span class="logo-text">CoWorker AI</span>
			</div>
			<button class="icon-btn" onclick={() => (sidebarOpen = !sidebarOpen)} title="Свернуть">
				<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
					<path d="M21 3H3M21 12H3M21 21H3"/>
				</svg>
			</button>
		</div>

		<button class="new-chat-btn" onclick={createChat}>
			<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
				<path d="M12 5v14M5 12h14"/>
			</svg>
			Новый чат
		</button>

		<div class="chat-list">
			{#if chats.length === 0}
				<div class="chat-list-empty">Нет чатов. Создайте первый!</div>
			{/if}
			{#each chats as chat (chat.id)}
				<button
					class="chat-item"
					class:active={chat.id === activeChatId}
					onclick={() => selectChat(chat.id)}
				>
					<svg class="chat-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
						<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
					</svg>
					<span class="chat-title">{chat.title}</span>
				</button>
			{/each}
		</div>

		<div class="sidebar-footer">
			<div class="model-badge">
				<span class="model-dot"></span>
				Gemini Flash + Pro
			</div>
		</div>
	</aside>

	<!-- ── Main ──────────────────────────────────────────────────────────── -->
	<main class="chat-main">

		<!-- Header -->
		<header class="chat-header">
			{#if !sidebarOpen}
				<button class="icon-btn" onclick={() => (sidebarOpen = true)} title="Открыть меню">
					<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
						<path d="M21 3H3M21 12H3M21 21H3"/>
					</svg>
				</button>
			{/if}
			<div class="header-title">
				<h1>Точные науки</h1>
				<span class="header-subtitle">Термех · Сопромат · Матанализ</span>
			</div>
			<div class="header-status" class:active={isLoading}>
				{#if isLoading}
					<span class="typing-indicator">
						<span></span><span></span><span></span>
					</span>
				{/if}
			</div>
		</header>

		<!-- Messages area -->
		<div class="messages-area" id="messages-area">
			{#if messages.length === 0}
				<div class="welcome-screen">
					<div class="welcome-hero">
						<div class="hero-icon">∑</div>
						<h2>Задайте инженерную задачу</h2>
						<p>AI анализирует условие, генерирует Python-код и выполняет точные вычисления в Wasm-песочнице</p>
					</div>

					<div class="examples-grid">
						{#each EXAMPLES as ex}
							<button class="example-card" onclick={() => { inputValue = ex; inputEl?.focus(); }}>
								{ex}
							</button>
						{/each}
					</div>
				</div>
			{:else}
				<div class="messages-list">
					{#each messages as msg (msg.id)}
						<div class="message-wrapper" class:user={msg.role === 'USER'} class:assistant={msg.role === 'ASSISTANT'}>
							{#if msg.role === 'ASSISTANT'}
								<div class="avatar assistant-avatar">AI</div>
							{/if}

							<div class="message-bubble" class:user-bubble={msg.role === 'USER'} class:assistant-bubble={msg.role === 'ASSISTANT'}>
								{#if msg.isStreaming && !msg.content}
									<!-- Typing dots -->
									<div class="typing-dots">
										<span></span><span></span><span></span>
									</div>
									{#if statusMessage}
										<div class="status-text">{statusMessage}</div>
									{/if}
								{:else if msg.role === 'USER'}
									{#if msg.imageData}
										{@const img = JSON.parse(msg.imageData)}
										<img src={`data:${img.mimeType};base64,${img.base64}`} alt="Uploaded task" class="user-uploaded-img" />
									{/if}
									<p class="user-text">{msg.content}</p>
								{:else}
									<MessageRenderer message={msg} />
									{#if msg.isStreaming && statusMessage}
										<div class="status-text streaming">{statusMessage}</div>
									{/if}
								{/if}
							</div>

							{#if msg.role === 'USER'}
								<div class="avatar user-avatar">Вы</div>
							{/if}
						</div>
					{/each}
					<div bind:this={messagesEnd}></div>
				</div>
			{/if}
		</div>

		<!-- Input area -->
		<div class="input-area">
			{#if statusMessage && isLoading}
				<div class="status-bar">
					<span class="status-spinner"></span>
					{statusMessage}
				</div>
			{/if}

			<div class="input-container">
				<!-- File upload button -->
				<button 
					class="attach-btn" 
					onclick={() => fileInputEl?.click()} 
					disabled={isLoading}
					title="Прикрепить фото задачи"
				>
					<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
						<path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>
					</svg>
				</button>
				
				<input 
					type="file" 
					accept="image/*" 
					hidden 
					bind:this={fileInputEl} 
					onchange={handleFileChange} 
				/>

				<div class="input-wrapper">
					{#if selectedImage}
						<div class="image-preview">
							<img src={`data:${selectedImage.mimeType};base64,${selectedImage.base64}`} alt="Preview" />
							<button class="remove-img-btn" onclick={removeImage}>×</button>
						</div>
					{/if}
					<textarea
						id="main-input"
						bind:this={inputEl}
						bind:value={inputValue}
						onkeydown={handleKeydown}
						oninput={autoResize}
						placeholder="Опишите задачу или прикрепите фото..."
						rows="1"
						disabled={isLoading}
						class="message-input"
					></textarea>
				</div>

				<button
					class="send-btn"
					onclick={sendMessage}
					disabled={isLoading || !inputValue.trim()}
					title="Отправить"
				>
					{#if isLoading}
						<span class="spinner"></span>
					{:else}
						<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
							<path d="M22 2L11 13M22 2L15 22l-4-9-9-4 20-7z"/>
						</svg>
					{/if}
				</button>
			</div>

			<div class="input-hint">
				Числа берутся из Python · sympy · numpy. Gemini не вычисляет — только анализирует и объясняет.
			</div>
		</div>

	</main>
</div>

<style>
/* ── App Shell ─────────────────────────────────────────────────────────────── */
.app-shell {
	display: flex;
	height: 100vh;
	overflow: hidden;
	background: var(--bg-base);
}

/* ── Sidebar ───────────────────────────────────────────────────────────────── */
.sidebar {
	width: var(--sidebar-width);
	min-width: var(--sidebar-width);
	background: var(--bg-surface);
	border-right: 1px solid var(--border-subtle);
	display: flex;
	flex-direction: column;
	overflow: hidden;
	transition: width var(--transition-base), min-width var(--transition-base);
}

.sidebar.collapsed {
	width: 0;
	min-width: 0;
	border-right: none;
}

.sidebar-header {
	display: flex;
	align-items: center;
	justify-content: space-between;
	padding: 1rem 1rem 0.75rem;
	border-bottom: 1px solid var(--border-subtle);
}

.logo {
	display: flex;
	align-items: center;
	gap: 0.5rem;
}

.logo-icon {
	font-size: 1.3rem;
	background: var(--accent-gradient);
	-webkit-background-clip: text;
	-webkit-text-fill-color: transparent;
	background-clip: text;
}

.logo-text {
	font-weight: 700;
	font-size: 0.95rem;
	color: var(--text-primary);
	letter-spacing: -0.01em;
}

.icon-btn {
	display: flex;
	align-items: center;
	justify-content: center;
	width: 32px;
	height: 32px;
	border: none;
	background: transparent;
	color: var(--text-secondary);
	border-radius: var(--radius-sm);
	cursor: pointer;
	transition: background var(--transition-fast), color var(--transition-fast);
}
.icon-btn:hover {
	background: var(--bg-elevated);
	color: var(--text-primary);
}

.new-chat-btn {
	display: flex;
	align-items: center;
	gap: 0.5rem;
	margin: 0.75rem;
	padding: 0.6rem 1rem;
	background: var(--accent-primary);
	border: 1px solid var(--border-subtle);
	border-radius: var(--radius-md);
	color: var(--bg-base);
	font-size: 0.85rem;
	font-weight: 600;
	cursor: pointer;
	transition: opacity var(--transition-fast), transform var(--transition-fast);
	box-shadow: var(--shadow-glow);
}
.new-chat-btn:hover { opacity: 0.9; transform: translateY(-1px); }
.new-chat-btn:active { transform: translateY(0); }

.chat-list {
	flex: 1;
	overflow-y: auto;
	padding: 0.25rem 0.5rem;
}

.chat-list-empty {
	padding: 2rem 1rem;
	text-align: center;
	color: var(--text-muted);
	font-size: 0.8rem;
}

.chat-item {
	display: flex;
	align-items: center;
	gap: 0.5rem;
	width: 100%;
	padding: 0.55rem 0.75rem;
	background: transparent;
	border: none;
	border-radius: var(--radius-md);
	color: var(--text-secondary);
	font-size: 0.83rem;
	text-align: left;
	cursor: pointer;
	transition: background var(--transition-fast), color var(--transition-fast);
	white-space: nowrap;
	overflow: hidden;
}
.chat-item:hover { background: var(--bg-elevated); color: var(--text-primary); }
.chat-item.active {
	background: var(--bg-elevated);
	color: var(--accent-primary);
	font-weight: 600;
}

.chat-icon { flex-shrink: 0; }

.chat-title {
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.sidebar-footer {
	padding: 0.75rem;
	border-top: 1px solid var(--border-subtle);
}

.model-badge {
	display: flex;
	align-items: center;
	gap: 0.4rem;
	font-size: 0.75rem;
	color: var(--text-muted);
}
.model-dot {
	width: 6px; height: 6px;
	background: var(--success);
	border-radius: 50%;
	animation: pulse-soft 2s infinite;
}

/* ── Chat Main ─────────────────────────────────────────────────────────────── */
.chat-main {
	flex: 1;
	display: flex;
	flex-direction: column;
	overflow: hidden;
}

/* ── Header ────────────────────────────────────────────────────────────────── */
.chat-header {
	display: flex;
	align-items: center;
	gap: 0.75rem;
	padding: 0 1.25rem;
	height: var(--header-height);
	border-bottom: 1px solid var(--border-subtle);
	background: var(--bg-surface);
	flex-shrink: 0;
}

.header-title {
	display: flex;
	flex-direction: column;
}

.header-title h1 {
	font-size: 0.95rem;
	font-weight: 700;
	color: var(--text-primary);
	line-height: 1.2;
}

.header-subtitle {
	font-size: 0.72rem;
	color: var(--text-muted);
}

.header-status {
	margin-left: auto;
}

/* ── Messages ──────────────────────────────────────────────────────────────── */
.messages-area {
	flex: 1;
	overflow-y: auto;
	padding: 1.5rem;
	scroll-behavior: smooth;
}

/* Welcome screen */
.welcome-screen {
	display: flex;
	flex-direction: column;
	align-items: center;
	gap: 2rem;
	padding: 3rem 1rem;
	animation: fadeInUp 0.4s ease;
}

.welcome-hero {
	text-align: center;
	max-width: 480px;
}

.hero-icon {
	font-size: 4rem;
	background: var(--accent-gradient);
	-webkit-background-clip: text;
	-webkit-text-fill-color: transparent;
	background-clip: text;
	line-height: 1;
	margin-bottom: 1rem;
	font-weight: 900;
}

.welcome-hero h2 {
	font-size: 1.6rem;
	font-weight: 700;
	margin-bottom: 0.5rem;
	color: var(--text-primary);
}

.welcome-hero p {
	color: var(--text-secondary);
	font-size: 0.9rem;
	line-height: 1.6;
}

.examples-grid {
	display: grid;
	grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
	gap: 0.75rem;
	width: 100%;
	max-width: 720px;
}

.example-card {
	padding: 0.85rem 1rem;
	background: var(--bg-card);
	border: 1px solid var(--border-subtle);
	border-radius: var(--radius-lg);
	color: var(--text-secondary);
	font-size: 0.82rem;
	text-align: left;
	cursor: pointer;
	transition: all var(--transition-fast);
	line-height: 1.4;
}
.example-card:hover {
	border-color: var(--accent-primary);
	color: var(--text-primary);
	background: var(--bg-elevated);
	transform: translateY(-2px);
	box-shadow: var(--shadow-glow);
}

/* Messages list */
.messages-list {
	display: flex;
	flex-direction: column;
	gap: 1.25rem;
	max-width: 860px;
	margin: 0 auto;
}

.message-wrapper {
	display: flex;
	gap: 0.75rem;
	align-items: flex-start;
	animation: fadeInUp 0.25s ease;
}

.message-wrapper.user {
	flex-direction: row-reverse;
}

.avatar {
	width: 32px;
	height: 32px;
	border-radius: 50%;
	display: flex;
	align-items: center;
	justify-content: center;
	font-size: 0.7rem;
	font-weight: 700;
	flex-shrink: 0;
}

.assistant-avatar {
	background: var(--accent-primary);
	color: var(--bg-base);
	font-size: 0.65rem;
}

.user-avatar {
	background: var(--bg-elevated);
	border: 1px solid var(--border-medium);
	color: var(--text-secondary);
	font-size: 0.6rem;
}

.message-bubble {
	max-width: 75%;
	padding: 0.75rem 1rem;
	border-radius: var(--radius-lg);
	line-height: 1.6;
}

.user-bubble {
	background: var(--accent-primary);
	color: var(--bg-base);
	border-bottom-right-radius: var(--radius-sm);
}


.assistant-bubble {
	background: var(--bg-card);
	border: 1px solid var(--border-subtle);
	border-bottom-left-radius: var(--radius-sm);
}

.user-text { margin: 0; white-space: pre-wrap; font-size: 0.9rem; }

.status-text {
	font-size: 0.78rem;
	color: var(--text-muted);
	margin-top: 0.5rem;
	display: flex;
	align-items: center;
	gap: 0.4rem;
}

.status-text.streaming::before {
	content: '';
	width: 6px; height: 6px;
	background: var(--accent-primary);
	border-radius: 50%;
	animation: pulse-soft 1s infinite;
	display: inline-block;
}

/* ── Typing dots ───────────────────────────────────────────────────────────── */
.typing-dots, .typing-indicator {
	display: inline-flex;
	gap: 4px;
	align-items: center;
	padding: 0.25rem 0;
}

.typing-dots span,
.typing-indicator span {
	width: 6px;
	height: 6px;
	background: var(--accent-primary);
	border-radius: 50%;
	animation: typing-dot 1.2s infinite;
}
.typing-dots span:nth-child(2),
.typing-indicator span:nth-child(2) { animation-delay: 0.2s; }
.typing-dots span:nth-child(3),
.typing-indicator span:nth-child(3) { animation-delay: 0.4s; }

/* ── Input Area ────────────────────────────────────────────────────────────── */
.input-area {
	padding: 0.75rem 1.25rem 1rem;
	border-top: 1px solid var(--border-subtle);
	background: var(--bg-surface);
	flex-shrink: 0;
}

.status-bar {
	display: flex;
	align-items: center;
	gap: 0.5rem;
	font-size: 0.78rem;
	color: var(--accent-secondary);
	margin-bottom: 0.5rem;
	padding: 0 0.25rem;
}

/* ── Input container refinements ────────────────────────────────────────── */
.input-container {
	display: flex;
	align-items: flex-end;
	gap: 0.75rem;
	background: var(--bg-card);
	border: 1px solid var(--border-medium);
	border-radius: var(--radius-xl);
	padding: 0.5rem 0.75rem;
	transition: border-color var(--transition-fast), box-shadow var(--transition-fast);
}

.input-container:focus-within {
	border-color: var(--accent-primary);
	box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1);
}

.attach-btn {
	display: flex;
	align-items: center;
	justify-content: center;
	width: 36px;
	height: 36px;
	border: none;
	background: transparent;
	color: var(--text-secondary);
	border-radius: 50%;
	cursor: pointer;
	transition: all var(--transition-fast);
	flex-shrink: 0;
	margin-bottom: 2px;
}

.attach-btn:hover:not(:disabled) {
	background: var(--bg-elevated);
	color: var(--accent-primary);
	transform: rotate(15deg);
}

.input-wrapper {
	flex: 1;
	display: flex;
	flex-direction: column;
	gap: 0.5rem;
	min-width: 0;
}

.image-preview {
	position: relative;
	width: fit-content;
	padding-top: 0.5rem;
}

.image-preview img {
	max-width: 120px;
	max-height: 120px;
	border-radius: var(--radius-md);
	border: 1px solid var(--border-subtle);
	object-fit: cover;
}

.remove-img-btn {
	position: absolute;
	top: -2px;
	right: -8px;
	width: 20px;
	height: 20px;
	background: var(--error);
	color: white;
	border: none;
	border-radius: 50%;
	display: flex;
	align-items: center;
	justify-content: center;
	font-size: 14px;
	cursor: pointer;
	box-shadow: 0 2px 4px rgba(0,0,0,0.2);
}

.user-uploaded-img {
	max-width: 100%;
	max-height: 300px;
	border-radius: var(--radius-md);
	margin-bottom: 0.5rem;
	display: block;
	cursor: zoom-in;
}
.status-spinner {
	width: 12px; height: 12px;
	border: 2px solid var(--accent-primary);
	border-top-color: transparent;
	border-radius: 50%;
	animation: spin 0.8s linear infinite;
	flex-shrink: 0;
}

.message-input {
	flex: 1;
	background: transparent;
	border: none;
	outline: none;
	color: var(--text-primary);
	font-family: var(--font-sans);
	font-size: 0.9rem;
	line-height: 1.5;
	resize: none;
	min-height: 24px;
	max-height: 200px;
	padding: 0.2rem 0;
}
.message-input::placeholder { color: var(--text-muted); }
.message-input:disabled { opacity: 0.5; }

.send-btn {
	width: 38px;
	height: 38px;
	min-width: 38px;
	border: none;
	border-radius: 50%;
	background: var(--accent-gradient);
	color: white;
	cursor: pointer;
	display: flex;
	align-items: center;
	justify-content: center;
	transition: opacity var(--transition-fast), transform var(--transition-fast), box-shadow var(--transition-fast);
	box-shadow: var(--shadow-glow);
	margin-bottom: 2px;
}
.send-btn:hover:not(:disabled) { opacity: 0.9; transform: scale(1.05); }
.send-btn:active:not(:disabled) { transform: scale(0.95); }
.send-btn:disabled { opacity: 0.3; cursor: not-allowed; box-shadow: none; }

.spinner {
	width: 16px; height: 16px;
	border: 2px solid rgba(255,255,255,0.3);
	border-top-color: white;
	border-radius: 50%;
	animation: spin 0.7s linear infinite;
}

.input-hint {
	margin-top: 0.5rem;
	font-size: 0.7rem;
	color: var(--text-muted);
	text-align: center;
	letter-spacing: 0.02em;
}
</style>
