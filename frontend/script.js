// ============================================
// CONFIGURATION
// ============================================

const SUPABASE_URL = "https://ouintjjakyvlueglowru.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im91aW50ampha3l2bHVlZ2xvd3J1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI1MzM1MjQsImV4cCI6MjA4ODEwOTUyNH0.TQ1KGoCzKeP7n_QDpi4R7ZpANotv-TomETDtt1Ykl0A";

// const supabaseClient = window.supabase.createClient(
//     SUPABASE_URL,
//     SUPABASE_ANON_KEY
// );

// const SUPABASE_URL = 'https://zkwrprmuoacuugklqllc.supabase.co'; // Replace with your Supabase URL
// const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inprd3Jwcm11b2FjdXVna2xxbGxjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE5MzAyMDMsImV4cCI6MjA4NzUwNjIwM30.IwIJJcOu6OfjqNJl4Oc1jrhcdcrYQkkbr3r0TkYrATo'; // Replace with your Supabase Anon Key

let BACKEND_URL = localStorage.getItem('backendUrl') || 'http://localhost:8000';

// const BACKEND_URL = "https://invigorative-dawson-crestfallenly.ngrok-free.dev";

// ============================================
// GLOBAL STATE
// ============================================

let currentUser = null;
let currentDocument = null;  // { id, name, pages, words }
let currentConversationId = null;
let conversationHistory = [];  // [{role, content}] — full history sent to LLM
let settings = {
    fullContext: localStorage.getItem('fullContext') !== 'false'
};

// ============================================
// SUPABASE INIT
// ============================================

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ============================================
// UTILITIES
// ============================================

function showToast(message, type = 'info', duration = 3500) {
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), duration);
}

function showConfirm(title, message) {
    return new Promise(resolve => {
        const dialog = document.getElementById('confirmDialog');
        document.getElementById('confirmTitle').textContent = title;
        document.getElementById('confirmMessage').textContent = message;
        dialog.style.display = 'flex';
        const ok = document.getElementById('confirmOk');
        const cancel = document.getElementById('confirmCancel');
        const cleanup = (result) => {
            dialog.style.display = 'none';
            ok.replaceWith(ok.cloneNode(true));
            cancel.replaceWith(cancel.cloneNode(true));
            resolve(result);
        };
        document.getElementById('confirmOk').addEventListener('click', () => cleanup(true));
        document.getElementById('confirmCancel').addEventListener('click', () => cleanup(false));
    });
}

function formatDate(dateString) {
    const d = new Date(dateString);
    return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function getInitials(name) {
    if (!name) return 'U';
    return name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
}

// ============================================
// THEME
// ============================================

function applyTheme(theme) {
    document.body.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
    const isDark = theme === 'dark';

    // Main toggle
    const icon = document.querySelector('#themeToggle .theme-toggle-icon');
    const text = document.querySelector('#themeToggle .theme-toggle-text');
    if (icon) icon.textContent = isDark ? '🌙' : '☀️';
    if (text) text.textContent = isDark ? 'Night' : 'Day';

    // Gate toggle
    const gIcon = document.querySelector('#gateThemeToggle .theme-toggle-icon');
    const gText = document.querySelector('#gateThemeToggle .theme-toggle-text');
    if (gIcon) gIcon.textContent = isDark ? '🌙' : '☀️';
    if (gText) gText.textContent = isDark ? 'Night' : 'Day';

    // Settings toggle
    const dmToggle = document.getElementById('darkModeToggle');
    if (dmToggle) dmToggle.checked = isDark;
}

const savedTheme = localStorage.getItem('theme') ||
    (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
applyTheme(savedTheme);

document.getElementById('themeToggle').addEventListener('click', () => {
    const next = document.body.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    applyTheme(next);
});

document.getElementById('gateThemeToggle').addEventListener('click', () => {
    const next = document.body.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    applyTheme(next);
});

// ============================================
// PAGE NAVIGATION
// ============================================

const PAGE_IDS = ['landingPage', 'processingPage', 'chatPage', 'chatHistoryPage', 'documentsPage', 'settingsPage'];

function navigateToPage(pageId) {
    PAGE_IDS.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.remove('active');
    });
    const target = document.getElementById(pageId);
    if (target) target.classList.add('active');

    // Trigger page-specific load
    if (pageId === 'chatHistoryPage') loadChatHistoryPage();
    if (pageId === 'documentsPage') loadDocumentsPage();
    if (pageId === 'settingsPage') loadSettingsPage();

    closeSidebar();
}

// ============================================
// BACKEND CONNECTION CHECK
// ============================================

async function checkBackendStatus() {
    const dot = document.getElementById('statusDot');
    const text = document.getElementById('statusText');
    dot.className = 'status-dot checking';
    text.textContent = 'Connecting…';
    try {
        const res = await fetch(`${BACKEND_URL}/health`, { signal: AbortSignal.timeout(4000) });
        if (res.ok) {
            dot.className = 'status-dot online';
            text.textContent = 'Backend Online';
        } else {
            throw new Error('not ok');
        }
    } catch {
        dot.className = 'status-dot offline';
        text.textContent = 'Backend Offline';
    }
}

// ============================================
// LOGIN GATE
// ============================================

const loginGate = document.getElementById('loginGate');

supabaseClient.auth.onAuthStateChange((event, session) => {
    if (session && session.user) {
        currentUser = session.user;
        loginGate.style.display = 'none';
        onUserLoggedIn(session.user);
    } else {
        currentUser = null;
        loginGate.style.display = 'flex';
        onUserLoggedOut();
    }
});

// Check initial session
(async () => {
    const { data: { session } } = await supabaseClient.auth.getSession();
    if (session && session.user) {
        currentUser = session.user;
        loginGate.style.display = 'none';
        onUserLoggedIn(session.user);
    } else {
        loginGate.style.display = 'flex';
    }
})();

function onUserLoggedIn(user) {
    const email = user.email || user.user_metadata?.full_name || 'User';
    const name = user.user_metadata?.full_name || email.split('@')[0];

    document.getElementById('userChip').style.display = 'flex';
    document.getElementById('usernameDisplay').textContent = name;
    document.getElementById('userAvatar').textContent = getInitials(name);

    checkBackendStatus();
    fetchSidebarHistory();
}

function onUserLoggedOut() {
    document.getElementById('userChip').style.display = 'none';
    navigateToPage('landingPage');
}

// Gate Login Form
document.getElementById('gateLoginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('gateEmail').value.trim();
    const password = document.getElementById('gatePassword').value;
    const btn = document.getElementById('gateLoginBtn');
    const errEl = document.getElementById('gateLoginError');
    errEl.style.display = 'none';

    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Logging in…';

    try {
        const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
        if (error) throw error;
    } catch (err) {
        errEl.textContent = err.message || 'Login failed. Check credentials.';
        errEl.style.display = 'block';
        btn.disabled = false;
        btn.textContent = 'Login';
    }
});

// Social logins
document.getElementById('gateGoogle').addEventListener('click', async () => {
    await supabaseClient.auth.signInWithOAuth({ provider: 'google' });
});
document.getElementById('gateGithub').addEventListener('click', async () => {
    await supabaseClient.auth.signInWithOAuth({ provider: 'github' });
});
document.getElementById('gateMicrosoft').addEventListener('click', async () => {
    await supabaseClient.auth.signInWithOAuth({ provider: 'azure' });
});

// Logout
async function handleLogout() {
    const confirmed = await showConfirm('Sign Out', 'Are you sure you want to sign out?');
    if (!confirmed) return;
    await supabaseClient.auth.signOut();
    showToast('Signed out successfully', 'success');
    location.reload();
}

// ============================================
// SIDEBAR
// ============================================

const hamburgerBtn = document.getElementById('hamburgerBtn');
const sidebar = document.getElementById('sidebar');
const sidebarOverlay = document.getElementById('sidebarOverlay');

hamburgerBtn.addEventListener('click', () => {
    sidebar.classList.add('active');
    sidebarOverlay.classList.add('active');
});

document.getElementById('closeSidebarBtn').addEventListener('click', closeSidebar);
sidebarOverlay.addEventListener('click', closeSidebar);

function closeSidebar() {
    sidebar.classList.remove('active');
    sidebarOverlay.classList.remove('active');
}

document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', e => {
        e.preventDefault();
        const action = item.dataset.action;
        closeSidebar();
        switch (action) {
            case 'home': navigateToPage('landingPage'); break;
            case 'new-chat':
                currentDocument = null; currentConversationId = null; conversationHistory = [];
                navigateToPage('landingPage');
                break;
            case 'chat-history': navigateToPage('chatHistoryPage'); break;
            case 'documents': navigateToPage('documentsPage'); break;
            case 'settings': navigateToPage('settingsPage'); break;
            case 'logout': handleLogout(); break;
        }
    });
});

// Logo → Home
document.getElementById('logoHome').addEventListener('click', () => navigateToPage('landingPage'));

// ============================================
// SIDEBAR CHAT HISTORY (in chat sidebar)
// ============================================

async function fetchSidebarHistory() {
    if (!currentUser) return;
    try {
        const { data, error } = await supabaseClient
            .from('conversations')
            .select('id, title, created_at')
            .eq('user_id', currentUser.id)
            .order('created_at', { ascending: false })
            .limit(8);

        if (error) throw error;

        const list = document.getElementById('chatHistoryList');
        list.innerHTML = '<h5>Recent Chats</h5>';
        if (!data || data.length === 0) {
            list.innerHTML += '<p style="font-size:0.8rem;color:var(--color-text-secondary);padding:8px 0;">No chats yet</p>';
            return;
        }
        data.forEach(chat => {
            const div = document.createElement('div');
            div.className = 'chat-item';
            div.textContent = chat.title || 'Untitled Chat';
            div.title = formatDate(chat.created_at);
            div.addEventListener('click', () => loadConversation(chat.id));
            list.appendChild(div);
        });
    } catch (err) {
        console.error('fetchSidebarHistory error:', err);
    }
}

async function loadConversation(conversationId) {
    if (!currentUser) return;
    try {
        const { data, error } = await supabaseClient
            .from('messages')
            .select('role, content, created_at')
            .eq('conversation_id', conversationId)
            .order('created_at', { ascending: true });

        if (error) throw error;

        currentConversationId = conversationId;
        conversationHistory = data.map(m => ({ role: m.role, content: m.content }));

        // Get document info for this conversation
        const { data: convData } = await supabaseClient
            .from('conversations')
            .select('document_id, title, documents(name, pages, words)')
            .eq('id', conversationId)
            .single();

        if (convData?.documents) {
            currentDocument = {
                id: convData.document_id,
                name: convData.documents.name,
                pages: convData.documents.pages,
                words: convData.documents.words
            };
            updateDocumentInfo();
        }

        navigateToPage('chatPage');
        renderChatHistory(data);
        fetchSidebarHistory();

        // Mark active
        document.querySelectorAll('.chat-item').forEach(el => {
            el.classList.toggle('active', el.dataset.convId === conversationId);
        });
    } catch (err) {
        console.error('loadConversation error:', err);
        showToast('Failed to load conversation', 'error');
    }
}

function renderChatHistory(messages) {
    const container = document.getElementById('chatMessages');
    container.innerHTML = '';
    messages.forEach(m => addMessage(m.content, m.role === 'assistant' ? 'ai' : 'user', false));
    container.scrollTop = container.scrollHeight;
}

// ============================================
// GLOBAL SEARCH
// ============================================

const globalSearch = document.getElementById('globalSearch');
const searchDropdown = document.getElementById('searchDropdown');
let searchTimeout = null;

globalSearch.addEventListener('input', () => {
    clearTimeout(searchTimeout);
    const q = globalSearch.value.trim();
    if (!q) { searchDropdown.style.display = 'none'; return; }
    searchTimeout = setTimeout(() => performSearch(q), 350);
});

globalSearch.addEventListener('keydown', e => {
    if (e.key === 'Enter') performSearch(globalSearch.value.trim());
    if (e.key === 'Escape') searchDropdown.style.display = 'none';
});

document.getElementById('searchBtn').addEventListener('click', () => {
    const q = globalSearch.value.trim();
    if (q) performSearch(q);
});

document.addEventListener('click', e => {
    if (!e.target.closest('.search-section')) searchDropdown.style.display = 'none';
});

async function performSearch(query) {
    if (!currentUser || !query) return;
    searchDropdown.style.display = 'block';
    searchDropdown.innerHTML = '<div class="search-result-item"><span class="sri-icon"><span class="spinner"></span></span> Searching…</div>';

    try {
        const [docsResult, chatsResult] = await Promise.all([
            supabaseClient.from('documents').select('id, name, created_at')
                .eq('user_id', currentUser.id).ilike('name', `%${query}%`).limit(4),
            supabaseClient.from('conversations').select('id, title, created_at')
                .eq('user_id', currentUser.id).ilike('title', `%${query}%`).limit(4)
        ]);

        const results = [];
        (docsResult.data || []).forEach(d => results.push({ type: 'doc', ...d }));
        (chatsResult.data || []).forEach(c => results.push({ type: 'chat', ...c }));

        if (results.length === 0) {
            searchDropdown.innerHTML = '<div class="search-result-item" style="color:var(--color-text-secondary);">No results found</div>';
            return;
        }

        searchDropdown.innerHTML = '';
        results.forEach(r => {
            const div = document.createElement('div');
            div.className = 'search-result-item';
            div.innerHTML = `<span class="sri-icon">${r.type === 'doc' ? '📄' : '💬'}</span>
                <span>${r.name || r.title}</span>
                <span style="margin-left:auto;font-size:0.75rem;color:var(--color-text-secondary);">${formatDate(r.created_at)}</span>`;
            div.addEventListener('click', () => {
                searchDropdown.style.display = 'none';
                globalSearch.value = '';
                if (r.type === 'chat') loadConversation(r.id);
                else navigateToPage('documentsPage');
            });
            searchDropdown.appendChild(div);
        });
    } catch (err) {
        searchDropdown.innerHTML = '<div class="search-result-item" style="color:#ff6b6b;">Search failed</div>';
    }
}

// ============================================
// FILE UPLOAD
// ============================================

const fileInput = document.getElementById('fileInput');
const dropZone = document.getElementById('dropZone');

document.getElementById('systemUploadBtn').addEventListener('click', () => {
    if (!currentUser) { showToast('Please log in first', 'error'); return; }
    fileInput.click();
});

dropZone.addEventListener('click', () => {
    if (!currentUser) { showToast('Please log in first', 'error'); return; }
    fileInput.click();
});

dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', e => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    if (!currentUser) { showToast('Please log in first', 'error'); return; }
    if (e.dataTransfer.files.length > 0) handleFileUpload(e.dataTransfer.files[0]);
});

fileInput.addEventListener('change', e => {
    if (e.target.files.length > 0) handleFileUpload(e.target.files[0]);
});

document.getElementById('docsUploadBtn').addEventListener('click', () => {
    if (!currentUser) { showToast('Please log in first', 'error'); return; }
    fileInput.click();
});

async function handleFileUpload(file) {
    if (!file.type.includes('pdf')) {
        showToast('Please upload a PDF file only', 'error');
        return;
    }

    const dropProgress = document.getElementById('dropProgress');
    const progressFill = document.getElementById('progressFill');
    const progressText = document.getElementById('progressText');

    dropProgress.style.display = 'block';
    progressFill.style.width = '10%';
    progressText.textContent = 'Uploading…';

    navigateToPage('processingPage');
    updateProcessingSteps(1);

    // Animate progress
    let pct = 10;
    const progressInterval = setInterval(() => {
        pct = Math.min(pct + 5, 85);
        progressFill.style.width = pct + '%';
        progressText.textContent = `Uploading… ${pct}%`;
    }, 400);

    const formData = new FormData();
    formData.append('file', file);
    formData.append('user_id', currentUser.id);

    try {
        updateProcessingSteps(2);
        const response = await fetch(`${BACKEND_URL}/api/documents/upload`, {
            method: 'POST',
            body: formData
        });

        clearInterval(progressInterval);

        if (!response.ok) {
            const errData = await response.json().catch(() => ({}));
            throw new Error(errData.detail || 'Failed to process document');
        }

        const data = await response.json();
        progressFill.style.width = '100%';
        progressText.textContent = 'Done!';

        currentDocument = {
            id: data.document_id,
            name: file.name,
            pages: data.pages || '?',
            words: data.words || '?'
        };

        updateProcessingSteps(3);

        // Show summary
        const summaryContent = document.getElementById('summaryContent');
        summaryContent.innerHTML = formatMessageContent(data.summary || 'Summary generated successfully.');

        document.getElementById('confidenceScore').textContent = `Pages: ${data.pages || '?'}`;

        // Show suggested questions
        if (data.suggested_questions && data.suggested_questions.length > 0) {
            const wrap = document.getElementById('suggestedQuestionsWrap');
            const qContainer = document.getElementById('suggestedQuestions');
            qContainer.innerHTML = '';
            data.suggested_questions.forEach(q => {
                const btn = document.createElement('button');
                btn.className = 'suggested-q-btn';
                btn.textContent = q;
                btn.addEventListener('click', () => {
                    startChattingWithQuestion(q);
                });
                qContainer.appendChild(btn);
            });
            wrap.style.display = 'block';
        }

        showProcessingSummary();
        showToast('Document processed successfully!', 'success');
        fetchSidebarHistory();
        loadDocumentsPage();

    } catch (error) {
        clearInterval(progressInterval);
        console.error('Upload failed:', error);
        showToast(error.message || 'Failed to process document. Is the backend running?', 'error');
        navigateToPage('landingPage');
        dropProgress.style.display = 'none';
    }
}

function updateProcessingSteps(stepNumber) {
    for (let i = 1; i <= 3; i++) {
        const step = document.getElementById(`step${i}`);
        const conn = document.getElementById(`connector${i}`);
        if (step) step.classList.toggle('active', i <= stepNumber);
        if (conn) conn.classList.toggle('active', i < stepNumber);
    }
}

function showProcessingSummary() {
    document.getElementById('summaryCard').style.display = 'block';
    document.getElementById('startChattingBtn').style.display = 'inline-flex';
    document.getElementById('summaryCard').classList.add('fade-in');
}

document.getElementById('startChattingBtn').addEventListener('click', () => {
    initializeChatPage();
    navigateToPage('chatPage');
});

function startChattingWithQuestion(question) {
    initializeChatPage();
    navigateToPage('chatPage');
    setTimeout(() => {
        document.getElementById('chatInput').value = question;
        sendChatMessage();
    }, 300);
}

// ============================================
// CHAT
// ============================================

function initializeChatPage() {
    if (!currentDocument) return;
    currentConversationId = null;
    conversationHistory = [];
    updateDocumentInfo();

    const chatMessages = document.getElementById('chatMessages');
    chatMessages.innerHTML = `
        <div class="message ai-message fade-in">
            <div class="message-content">
                <p>Hello! I've analyzed <strong>${currentDocument.name}</strong>. Ask me anything — I'll answer based solely on its contents.</p>
            </div>
        </div>`;
    fetchSidebarHistory();
}

function updateDocumentInfo() {
    if (!currentDocument) return;
    document.getElementById('documentTitle').textContent = currentDocument.name;
    if (currentDocument.pages) document.getElementById('docPages').textContent = `Pages: ${currentDocument.pages}`;
    if (currentDocument.words) document.getElementById('docWords').textContent = `Words: ${currentDocument.words}`;
}

const chatInput = document.getElementById('chatInput');
const sendBtn = document.getElementById('sendBtn');
const chatMessages = document.getElementById('chatMessages');
const typingIndicator = document.getElementById('typingIndicator');

sendBtn.addEventListener('click', sendChatMessage);
chatInput.addEventListener('keypress', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChatMessage(); }
});

document.getElementById('newChatBtn').addEventListener('click', async () => {
    const ok = await showConfirm('New Chat', 'Start a fresh chat? Current conversation will remain saved.');
    if (!ok) return;
    currentConversationId = null;
    conversationHistory = [];
    chatMessages.innerHTML = `
        <div class="message ai-message fade-in">
            <div class="message-content">
                <p>Started a new conversation. Ask me anything about <strong>${currentDocument?.name || 'your document'}</strong>.</p>
            </div>
        </div>`;
    chatInput.focus();
});

async function sendChatMessage() {
    const message = chatInput.value.trim();
    if (!message || !currentDocument) {
        if (!currentDocument) showToast('Please upload a document first', 'error');
        return;
    }

    addMessage(message, 'user');
    chatInput.value = '';
    typingIndicator.style.display = 'flex';
    chatMessages.scrollTop = chatMessages.scrollHeight;

    // Add to local history
    conversationHistory.push({ role: 'user', content: message });

    try {
        const payload = {
            query: message,
            document_id: currentDocument.id,
            user_id: currentUser.id,
            conversation_id: currentConversationId,
            // Send full history if setting enabled
            history: settings.fullContext ? conversationHistory.slice(0, -1) : []
        };

        const response = await fetch(`${BACKEND_URL}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            throw new Error(err.detail || 'Server error');
        }

        const data = await response.json();

        if (data.conversation_id && !currentConversationId) {
            currentConversationId = data.conversation_id;
            fetchSidebarHistory();
        }

        conversationHistory.push({ role: 'assistant', content: data.response });

        typingIndicator.style.display = 'none';
        addMessage(data.response, 'ai');
        chatMessages.scrollTop = chatMessages.scrollHeight;

    } catch (error) {
        console.error('Chat error:', error);
        typingIndicator.style.display = 'none';
        addMessage('Sorry, I encountered an error connecting to the server. Please check that the backend is running.', 'ai');
        showToast('Backend connection error', 'error');
    }
}

function addMessage(content, sender, scroll = true) {
    const div = document.createElement('div');
    div.className = `message ${sender}-message fade-in`;

    const contentDiv = document.createElement('div');
    contentDiv.className = 'message-content';
    contentDiv.innerHTML = formatMessageContent(content);

    const ts = document.createElement('div');
    ts.className = 'message-timestamp';
    ts.textContent = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });

    div.appendChild(contentDiv);
    div.appendChild(ts);
    chatMessages.appendChild(div);

    if (scroll) chatMessages.scrollTop = chatMessages.scrollHeight;
}

function formatMessageContent(text) {
    if (!text) return '';
    // Simple markdown-like formatting
    return text
        .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\n\n/g, '</p><p>')
        .replace(/\n/g, '<br>')
        .replace(/^/, '<p>')
        .replace(/$/, '</p>')
        .replace(/<p><\/p>/g, '');
}

// ============================================
// CHAT HISTORY PAGE
// ============================================

async function loadChatHistoryPage() {
    if (!currentUser) return;
    const historyList = document.getElementById('historyList');
    const emptyState = document.getElementById('historyEmpty');

    historyList.innerHTML = '<div style="color:var(--color-text-secondary);font-size:0.9rem;padding:20px 0;">Loading…</div>';

    try {
        const { data, error } = await supabaseClient
            .from('conversations')
            .select('id, title, created_at, document_id, documents(name, pages)')
            .eq('user_id', currentUser.id)
            .order('created_at', { ascending: false });

        if (error) throw error;

        historyList.innerHTML = '';
        if (!data || data.length === 0) {
            emptyState.style.display = 'block';
            return;
        }

        emptyState.style.display = 'none';
        data.forEach(conv => {
            const card = document.createElement('div');
            card.className = 'history-card glass-card';
            card.innerHTML = `
                <div class="history-card-left">
                    <div class="history-card-title">${conv.title || 'Untitled Chat'}</div>
                    <div class="history-card-meta">
                        📄 ${conv.documents?.name || 'Unknown document'} &nbsp;·&nbsp;
                        🗓 ${formatDate(conv.created_at)}
                    </div>
                </div>
                <span class="history-card-arrow">→</span>`;
            card.addEventListener('click', () => loadConversation(conv.id));
            historyList.appendChild(card);
        });
    } catch (err) {
        console.error('loadChatHistoryPage error:', err);
        historyList.innerHTML = '<div style="color:#ff6b6b;padding:20px 0;">Failed to load chat history</div>';
    }
}

document.getElementById('refreshHistoryBtn').addEventListener('click', loadChatHistoryPage);

// ============================================
// DOCUMENTS PAGE
// ============================================

async function loadDocumentsPage() {
    if (!currentUser) return;
    const grid = document.getElementById('documentsGrid');
    const emptyState = document.getElementById('docsEmpty');

    grid.innerHTML = '<div style="color:var(--color-text-secondary);font-size:0.9rem;padding:20px 0;">Loading…</div>';

    try {
        const { data, error } = await supabaseClient
            .from('documents')
            .select('id, name, pages, words, file_size, created_at')
            .eq('user_id', currentUser.id)
            .order('created_at', { ascending: false });

        if (error) throw error;

        grid.innerHTML = '';
        if (!data || data.length === 0) {
            emptyState.style.display = 'block';
            return;
        }

        emptyState.style.display = 'none';
        data.forEach(doc => {
            const card = document.createElement('div');
            card.className = 'doc-card glass-card';
            card.innerHTML = `
                <div class="doc-card-icon">📄</div>
                <div class="doc-card-name">${doc.name}</div>
                <div class="doc-card-meta">
                    <span>📖 ${doc.pages || '?'} pages</span>
                    <span>📅 ${formatDate(doc.created_at)}</span>
                </div>
                ${doc.file_size ? `<div class="doc-card-meta"><span>${formatFileSize(doc.file_size)}</span></div>` : ''}
                <div class="doc-card-actions">
                    <button class="btn-xs btn-xs-primary" data-id="${doc.id}" data-name="${doc.name}" data-action="open">Open & Chat</button>
                    <button class="btn-xs btn-xs-danger" data-id="${doc.id}" data-name="${doc.name}" data-action="delete">Delete</button>
                </div>`;
            grid.appendChild(card);
        });

        // Event delegation
        grid.querySelectorAll('.btn-xs').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const { id, name, action } = btn.dataset;
                if (action === 'open') {
                    currentDocument = { id, name };
                    initializeChatPage();
                    navigateToPage('chatPage');
                } else if (action === 'delete') {
                    const ok = await showConfirm('Delete Document', `Delete "${name}"? All associated chats will also be removed.`);
                    if (!ok) return;
                    await deleteDocument(id);
                }
            });
        });

    } catch (err) {
        console.error('loadDocumentsPage error:', err);
        grid.innerHTML = '<div style="color:#ff6b6b;padding:20px 0;">Failed to load documents</div>';
    }
}

async function deleteDocument(docId) {
    try {
        const response = await fetch(`${BACKEND_URL}/api/documents/${docId}`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user_id: currentUser.id })
        });
        if (!response.ok) throw new Error('Delete failed');
        showToast('Document deleted', 'success');
        loadDocumentsPage();
        fetchSidebarHistory();
    } catch (err) {
        // Fallback: try deleting directly from supabase
        try {
            await supabaseClient.from('documents').delete().eq('id', docId).eq('user_id', currentUser.id);
            showToast('Document deleted', 'success');
            loadDocumentsPage();
        } catch (e2) {
            showToast('Failed to delete document', 'error');
        }
    }
}

// ============================================
// SETTINGS PAGE
// ============================================

function loadSettingsPage() {
    document.getElementById('backendUrlInput').value = BACKEND_URL;
    document.getElementById('settingsEmail').textContent = currentUser?.email || '—';
    document.getElementById('darkModeToggle').checked = document.body.getAttribute('data-theme') === 'dark';
    document.getElementById('fullContextToggle').checked = settings.fullContext;
}

document.getElementById('saveBackendUrl').addEventListener('click', async () => {
    const url = document.getElementById('backendUrlInput').value.trim().replace(/\/$/, '');
    if (!url) { showToast('Please enter a valid URL', 'error'); return; }
    BACKEND_URL = url;
    localStorage.setItem('backendUrl', url);
    showToast('Backend URL saved. Testing connection…', 'info');
    await checkBackendStatus();
});

document.getElementById('darkModeToggle').addEventListener('change', e => {
    applyTheme(e.target.checked ? 'dark' : 'light');
});

document.getElementById('fullContextToggle').addEventListener('change', e => {
    settings.fullContext = e.target.checked;
    localStorage.setItem('fullContext', e.target.checked);
    showToast(`Full context mode ${e.target.checked ? 'enabled' : 'disabled'}`, 'info');
});

document.getElementById('settingsLogout').addEventListener('click', handleLogout);

// ============================================
// CLOUD UPLOAD MODAL
// ============================================

document.getElementById('cloudUploadBtn').addEventListener('click', () => {
    document.getElementById('cloudModal').style.display = 'flex';
    document.getElementById('modalOverlay').style.display = 'block';
});

document.getElementById('closeCloudModal').addEventListener('click', closeCloudModal);
document.getElementById('modalOverlay').addEventListener('click', closeCloudModal);

function closeCloudModal() {
    document.getElementById('cloudModal').style.display = 'none';
    document.getElementById('modalOverlay').style.display = 'none';
}

['connectGDrive', 'connectDropbox', 'connectOneDrive'].forEach(id => {
    document.getElementById(id).addEventListener('click', () => {
        showToast('Cloud integration coming soon! Please use device upload for now.', 'info', 4000);
        closeCloudModal();
    });
});

// ============================================
// INIT
// ============================================

document.addEventListener('DOMContentLoaded', () => {
    navigateToPage('landingPage');

    // Staggered fade-in
    document.querySelectorAll('.fade-in[style*="animation-delay"]').forEach(el => {
        el.style.opacity = '0';
        setTimeout(() => { el.style.opacity = ''; }, parseInt(el.style.animationDelay) * 1000 + 100);
    });

    // Check backend every 30 seconds if user is logged in
    setInterval(() => { if (currentUser) checkBackendStatus(); }, 30000);

    // Recommended Questions Cards – click to populate search bar
    document.querySelectorAll('.recommended-q-card').forEach(card => {
        card.addEventListener('click', () => {
            const question = card.getAttribute('data-question');
            if (question) {
                const input = document.getElementById('chatInput');
                input.value = question;
                input.focus();
                input.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
        });
    });
});
