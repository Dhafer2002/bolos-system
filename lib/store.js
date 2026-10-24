'use strict';
/**
 * التخزين — نسختين بنفس الواجهة:
 *  - Supabase (على Vercel): لما يكون SUPABASE_URL و SUPABASE_SECRET_KEY موجودين
 *  - ملفات محلية في data/ (للتشغيل على جهازك)
 *
 * read()                 → { data, version }
 * write(data, version)   → true لو انحفظ، false لو أحد ثاني عدّل قبلنا (نعيد المحاولة)
 * appendSessions(list)   يسجل الجلسات المنتهية (للتقارير)
 * archiveSessions()      مسح البيانات: يأرشف الجلسات بدل ما يحذفها
 * getFailure / setFailure / clearFailure   عداد محاولات الرقم السري الغلط
 */
const fs = require('fs');
const path = require('path');

function supabaseStore(url, key) {
    const base = url.replace(/\/+$/, '') + '/rest/v1';
    const headers = { apikey: key, 'Content-Type': 'application/json' };

    async function call(method, pathAndQuery, body, prefer) {
        const res = await fetch(base + pathAndQuery, {
            method,
            headers: prefer ? { ...headers, Prefer: prefer } : headers,
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) throw new Error(`[supabase] ${method} ${pathAndQuery.split('?')[0]} → HTTP ${res.status}: ${await res.text()}`);
        const text = await res.text();
        return text ? JSON.parse(text) : null;
    }

    return {
        kind: 'supabase',
        async read() {
            const rows = await call('GET', '/bolos_state?id=eq.1&select=data,version');
            if (!rows.length) throw new Error('[supabase] bolos_state row 1 is missing');
            return { data: rows[0].data || {}, version: Number(rows[0].version) };
        },
        async write(data, version) {
            const rows = await call('PATCH', `/bolos_state?id=eq.1&version=eq.${version}`,
                { data, version: version + 1, updated_at: new Date().toISOString() }, 'return=representation');
            return rows.length === 1;
        },
        async appendSessions(list) {
            if (!list.length) return;
            await call('POST', '/bolos_sessions', list.map(r => ({
                type: r.type, number: r.number, mode: r.mode, source: r.source,
                booked_minutes: r.bookedMinutes, start_at: r.start, end_at: r.end,
                played_seconds: r.playedSeconds, paused_seconds: r.pausedSeconds, end_reason: r.endReason,
            })), 'return=minimal');
        },
        async archiveSessions() {
            await call('PATCH', '/bolos_sessions?archived_at=is.null', { archived_at: new Date().toISOString() }, 'return=minimal');
        },
        async getFailure(ip) {
            const rows = await call('GET', `/bolos_login_failures?ip=eq.${encodeURIComponent(ip)}&select=count,until_ms`);
            return rows.length ? { count: rows[0].count, until: Number(rows[0].until_ms) } : null;
        },
        async setFailure(ip, rec) {
            await call('POST', '/bolos_login_failures?on_conflict=ip', { ip, count: rec.count, until_ms: rec.until },
                'resolution=merge-duplicates,return=minimal');
        },
        async clearFailure(ip) {
            await call('DELETE', `/bolos_login_failures?ip=eq.${encodeURIComponent(ip)}`);
        },
    };
}

function fileStore(dataDir) {
    fs.mkdirSync(dataDir, { recursive: true });
    const STATE_FILE = path.join(dataDir, 'state.json');
    const SESSIONS_FILE = path.join(dataDir, 'sessions.jsonl');
    const failures = new Map();
    let version = 0;

    return {
        kind: 'file',
        async read() {
            try {
                if (fs.existsSync(STATE_FILE)) return { data: JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')), version };
            } catch (e) { console.error('[state] load failed, starting fresh:', e.message); }
            return { data: {}, version };
        },
        async write(data, expected) {
            if (expected !== version) return false;
            const tmp = STATE_FILE + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify(data));
            fs.renameSync(tmp, STATE_FILE);
            version++;
            return true;
        },
        async appendSessions(list) {
            for (const r of list) fs.appendFileSync(SESSIONS_FILE, JSON.stringify(r) + '\n');
        },
        async archiveSessions() {
            // ما نحذف السجل نهائياً — ننقله لملف احتياطي
            if (!fs.existsSync(SESSIONS_FILE)) return;
            const stamp = new Date().toISOString().replace(/[:.]/g, '-');
            fs.renameSync(SESSIONS_FILE, path.join(dataDir, `sessions-backup-${stamp}.jsonl`));
        },
        async getFailure(ip) { return failures.get(ip) || null; },
        async setFailure(ip, rec) { failures.set(ip, rec); },
        async clearFailure(ip) { failures.delete(ip); },
    };
}

module.exports = function createStore({ dataDir }) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SECRET_KEY;
    if (url && key) return supabaseStore(url, key);
    if (process.env.VERCEL) {
        console.error('⚠️  SUPABASE_URL / SUPABASE_SECRET_KEY are not set — data cannot be saved on Vercel.');
        return fileStore(path.join(require('os').tmpdir(), 'bolos-data')); // مؤقت ويضيع — بس عشان ما يطيح السيرفر
    }
    return fileStore(dataDir);
};
