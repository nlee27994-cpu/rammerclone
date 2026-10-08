(() => {
    'use strict';

    const STORAGE_KEY = 'rammerclone.sessions';
    const ACTIVE_KEY = 'rammerclone.active';

    const $ = id => document.getElementById(id);
    const els = {
        notice: $('notice'),
        session: $('session'),
        newSession: $('new-session'),
        deleteSession: $('delete-session'),
        passwordRow: $('password-row'),
        password: $('password'),
        form: $('go-form'),
        url: $('url'),
        sessionId: $('session-id'),
        copyId: $('copy-id'),
        importId: $('import-id'),
        importBtn: $('import'),
    };

    function load(key, fallback) {
        try {
            const value = localStorage.getItem(key);
            return value ? JSON.parse(value) : fallback;
        }
        catch {
            return fallback;
        }
    }

    function store(key, value) {
        try {
            localStorage.setItem(key, JSON.stringify(value));
        }
        catch {
            // storage unavailable (private mode etc.) - sessions just won't be remembered
        }
    }

    let sessions = load(STORAGE_KEY, []);
    let active = load(ACTIVE_KEY, null);

    function notify(message, ok = false) {
        els.notice.textContent = message;
        els.notice.classList.toggle('ok', ok);
        els.notice.hidden = !message;
    }

    function render() {
        els.session.innerHTML = '';

        if (!sessions.length) {
            const opt = document.createElement('option');
            opt.textContent = 'No sessions yet - one will be created';
            opt.value = '';
            els.session.appendChild(opt);
        }

        for (const s of sessions) {
            const opt = document.createElement('option');
            opt.value = s.id;
            opt.textContent = `${s.name} (${s.id.slice(0, 8)})`;
            els.session.appendChild(opt);
        }

        if (active && sessions.some(s => s.id === active))
            els.session.value = active;
        else if (sessions.length)
            active = sessions[0].id;

        els.sessionId.value = active || '';
        store(ACTIVE_KEY, active);
        store(STORAGE_KEY, sessions);
    }

    function addSession(id) {
        if (!sessions.some(s => s.id === id))
            sessions.push({ id, name: `Session ${sessions.length + 1}` });

        active = id;
        render();
    }

    async function api(method, path, body) {
        const res = await fetch(path, {
            method,
            headers: body ? { 'content-type': 'application/json' } : undefined,
            body: body ? JSON.stringify(body) : undefined,
        });
        const data = await res.json().catch(() => ({}));

        if (!res.ok)
            throw new Error(data.error || `Request failed (${res.status})`);

        return data;
    }

    async function createSession() {
        const { id } = await api('POST', '/api/sessions', { password: els.password.value });

        addSession(id);

        return id;
    }

    async function ensureSession() {
        if (active) {
            const { exists } = await api('GET', `/api/sessions/${active}`);

            if (exists)
                return active;

            sessions = sessions.filter(s => s.id !== active);
            active = null;
            notify('Your previous session expired, so a new one was created.');
        }

        return createSession();
    }

    function toUrl(input) {
        input = input.trim();

        if (!input)
            return null;

        if (/^https?:\/\//i.test(input))
            return input;

        // Looks like a domain (has a dot, no spaces) -> treat as URL
        if (/^[^\s]+\.[^\s]{2,}$/.test(input) || /^localhost(:\d+)?(\/|$)/i.test(input))
            return 'https://' + input;

        return 'https://duckduckgo.com/?q=' + encodeURIComponent(input);
    }

    async function go(input) {
        const url = toUrl(input);

        if (!url)
            return;

        try {
            const id = await ensureSession();

            location.href = `/${id}/${url}`;
        }
        catch (err) {
            notify(err.message);
        }
    }

    els.form.addEventListener('submit', e => {
        e.preventDefault();
        go(els.url.value);
    });

    document.querySelectorAll('.shortcuts button').forEach(btn => {
        btn.addEventListener('click', () => go(btn.dataset.url));
    });

    els.session.addEventListener('change', () => {
        active = els.session.value || null;
        render();
    });

    els.newSession.addEventListener('click', async () => {
        try {
            await createSession();
            notify('New session created.', true);
        }
        catch (err) {
            notify(err.message);
        }
    });

    els.deleteSession.addEventListener('click', async () => {
        if (!active || !confirm('Delete this session and all its cookies?'))
            return;

        await api('DELETE', `/api/sessions/${active}`).catch(() => {});
        sessions = sessions.filter(s => s.id !== active);
        active = null;
        render();
        notify('Session deleted.', true);
    });

    els.copyId.addEventListener('click', () => {
        els.sessionId.select();
        navigator.clipboard?.writeText(els.sessionId.value).catch(() => {});
    });

    els.importBtn.addEventListener('click', async () => {
        const id = els.importId.value.trim().toLowerCase();

        if (!/^[a-f0-9]{32}$/.test(id))
            return notify('That is not a valid session ID.');

        const { exists } = await api('GET', `/api/sessions/${id}`).catch(() => ({ exists: false }));

        if (!exists)
            return notify('That session does not exist on this server.');

        addSession(id);
        els.importId.value = '';
        notify('Session imported.', true);
    });

    if (new URLSearchParams(location.search).has('expired'))
        notify('That session no longer exists. Pick or create another one.');

    api('GET', '/api/config')
        .then(cfg => { els.passwordRow.hidden = !cfg.passwordRequired; })
        .catch(() => {});

    render();
})();
