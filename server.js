'use strict';
/**
 * Bolos Alley — server
 * السيرفر هو المصدر الوحيد للحقيقة: كل المؤقتات تعيش هنا، والصفحة بس تعرض.
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { Server } = require('socket.io');

// ---------------------------------------------------------------------------
// تحميل ملف .env (لو موجود) — بدون مكتبات إضافية
// ---------------------------------------------------------------------------
(function loadEnv() {
    const envPath = path.join(__dirname, '.env');
    if (!fs.existsSync(envPath)) return;
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
        if (!m || line.trim().startsWith('#')) continue;
        if (process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
})();

// ---------------------------------------------------------------------------
// الإعدادات (كلها من متغيرات البيئة — لا أسرار داخل الكود)
// ---------------------------------------------------------------------------
const PORT = Number(process.env.PORT) || 3000;
const IFTTT_KEY = process.env.IFTTT_KEY || '';
const STAFF_PIN = process.env.STAFF_PIN || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');

if (!STAFF_PIN) console.warn('⚠️  STAFF_PIN is not set — nobody will be able to control the tables.');
if (!IFTTT_KEY) console.warn('⚠️  IFTTT_KEY is not set — lights are disabled.');
if (!ADMIN_PASSWORD) console.warn('⚠️  ADMIN_PASSWORD is not set — master reset is disabled.');

// الطاولات المسموحة فقط (لازم تطابق الكروت في الصفحة)
const TABLE_LAYOUT = { pool: 5, pingpong: 2, foosball: 2, ps: 2, baloot: 2, karaoke: 1 };
const ALLOWED_DURATIONS = [30, 60]; // بالدقائق
const ACTIVITY_LIMIT = 50;

fs.mkdirSync(DATA_DIR, { recursive: true });
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.jsonl');

// ---------------------------------------------------------------------------
// الحالة
// ---------------------------------------------------------------------------
/*
 * tables[key] = {
 *   type, number,
 *   status: 'idle' | 'running' | 'paused',
 *   mode: 'timed' | 'open',
 *   endTime      (timed + running)  وقت الانتهاء
 *   startTime    (open + running)   بداية العد (افتراضية، تتعدل بعد الاستئناف)
 *   remainingMs  (timed + paused)
 *   elapsedMs    (open + paused)
 *   sessionStart, pausedMs, pausedAt, source, bookedMinutes   ← للتقارير
 * }
 */
let state = { tables: {}, frozen: [], activity: [], nextFrozenId: 1 };

const tableKey = (type, number) => `${type}-${number}`;
const idleTable = (type, number) => ({ type, number, status: 'idle', mode: null });

function initTables() {
    for (const [type, count] of Object.entries(TABLE_LAYOUT)) {
        for (let n = 1; n <= count; n++) {
            const k = tableKey(type, n);
            if (!state.tables[k]) state.tables[k] = idleTable(type, n);
        }
    }
    // احذف أي طاولة قديمة مو موجودة في التخطيط الحالي
    for (const k of Object.keys(state.tables)) {
        const t = state.tables[k];
        if (!isValidTable(t.type, t.number)) delete state.tables[k];
    }
}

function isValidTable(type, number) {
    return Object.prototype.hasOwnProperty.call(TABLE_LAYOUT, type)
        && Number.isInteger(number) && number >= 1 && number <= TABLE_LAYOUT[type];
}

function getTable(data) {
    if (!data || typeof data !== 'object') return null;
    const type = String(data.type || '');
    const number = Number(data.number);
    if (!isValidTable(type, number)) return null;
    return state.tables[tableKey(type, number)];
}

// ---------------------------------------------------------------------------
// الحفظ على القرص (عشان إعادة تشغيل السيرفر ما تضيّع الجلسات)
// ---------------------------------------------------------------------------
function saveState() {
    try {
        const tmp = STATE_FILE + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(state));
        fs.renameSync(tmp, STATE_FILE);
    } catch (e) { console.error('[state] save failed:', e.message); }
}

function loadState() {
    try {
        if (!fs.existsSync(STATE_FILE)) return;
        const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        state.tables = saved.tables || {};
        state.frozen = Array.isArray(saved.frozen) ? saved.frozen : [];
        state.activity = Array.isArray(saved.activity) ? saved.activity : [];
        state.nextFrozenId = saved.nextFrozenId || 1;
    } catch (e) { console.error('[state] load failed, starting fresh:', e.message); }
}

function appendSession(record) {
    try { fs.appendFileSync(SESSIONS_FILE, JSON.stringify(record) + '\n'); }
    catch (e) { console.error('[sessions] write failed:', e.message); }
}

// ---------------------------------------------------------------------------
// IFTTT + حركات اللمبات
// ---------------------------------------------------------------------------
const delay = ms => new Promise(r => setTimeout(r, ms));
const lightSeq = {};
let seqCounter = 0;

// أي أمر جديد يلغي أي حركة رمش قديمة شغالة على نفس الطاولة
function cancelLights(k) { lightSeq[k] = ++seqCounter; return lightSeq[k]; }

async function sendAction(type, number, status) {
    if (!IFTTT_KEY) return;
    // نفس صيغة الأسماء القديمة بالضبط عشان أبلتات IFTTT الحالية تشتغل
    const eventName = type === 'pool'
        ? `Pool${number}_${status.toUpperCase()}`
        : `${type}${number}_${status.toLowerCase()}`;
    const url = `https://maker.ifttt.com/trigger/${encodeURIComponent(eventName)}/with/key/${encodeURIComponent(IFTTT_KEY)}`;
    try {
        const res = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(8000) });
        if (res.ok) console.log(`[IFTTT] ${eventName}`);
        else console.error(`[IFTTT] ${eventName} failed: HTTP ${res.status}`);
    } catch (e) {
        console.error(`[IFTTT] ${eventName} failed: ${e.message}`);
    }
}

function lightsOn(type, number) {
    cancelLights(tableKey(type, number));
    sendAction(type, number, 'ON');
}

async function executeLightSequence(type, number, actionType) {
    const k = tableKey(type, number);
    const id = cancelLights(k);
    const isActive = () => lightSeq[k] === id;

    if (actionType === 'PAUSE') {
        // ترمش شوي وتظل شغالة
        if (isActive()) await sendAction(type, number, 'OFF'); await delay(2000);
        if (isActive()) await sendAction(type, number, 'ON');  await delay(2000);
        if (isActive()) await sendAction(type, number, 'OFF'); await delay(2000);
        if (isActive()) await sendAction(type, number, 'ON');
    } else if (actionType === 'END' || actionType === 'STOP') {
        // ترمش، تطفي 10 ثواني، ثم تشتغل (جاهزة للزبون الجاي)
        if (isActive()) await sendAction(type, number, 'OFF'); await delay(2000);
        if (isActive()) await sendAction(type, number, 'ON');  await delay(2000);
        if (isActive()) await sendAction(type, number, 'OFF'); await delay(10000);
        if (isActive()) await sendAction(type, number, 'ON');
    }
}

// ---------------------------------------------------------------------------
// منطق الطاولات
// ---------------------------------------------------------------------------
function secondsFor(t, now) {
    if (t.status === 'running') {
        return t.mode === 'timed'
            ? Math.max(0, Math.ceil((t.endTime - now) / 1000))
            : Math.max(0, Math.floor((now - t.startTime) / 1000));
    }
    if (t.status === 'paused') {
        return t.mode === 'timed'
            ? Math.max(0, Math.ceil(t.remainingMs / 1000))
            : Math.max(0, Math.floor(t.elapsedMs / 1000));
    }
    return 0;
}

function snapshot(now = Date.now()) {
    const tables = {};
    for (const [k, t] of Object.entries(state.tables)) {
        tables[k] = { status: t.status, mode: t.mode, seconds: secondsFor(t, now) };
    }
    return { tables };
}

function addActivity(action, type, number, extra = {}) {
    state.activity.unshift({ ts: Date.now(), action, type, number, ...extra });
    if (state.activity.length > ACTIVITY_LIMIT) state.activity.length = ACTIVITY_LIMIT;
    io.to('staff').emit('activity', state.activity);
}

function beginSession(t, { mode, durationMs = 0, elapsedMs = 0, source = 'new', bookedMinutes = null }, now) {
    Object.assign(t, {
        status: 'running', mode,
        endTime: mode === 'timed' ? now + durationMs : null,
        startTime: mode === 'open' ? now - elapsedMs : null,
        remainingMs: null, elapsedMs: null,
        sessionStart: now, pausedMs: 0, pausedAt: null,
        source, bookedMinutes,
    });
}

// تنهي الجلسة وتسجلها في sessions.jsonl (هذا اللي بتعتمد عليه التقارير)
function finishSession(t, reason, endAt) {
    const pausedMs = (t.pausedMs || 0) + (t.status === 'paused' && t.pausedAt ? endAt - t.pausedAt : 0);
    appendSession({
        type: t.type,
        number: t.number,
        mode: t.mode,
        source: t.source || 'new',
        bookedMinutes: t.bookedMinutes ?? null,
        start: new Date(t.sessionStart).toISOString(),
        end: new Date(endAt).toISOString(),
        playedSeconds: Math.max(0, Math.round((endAt - t.sessionStart - pausedMs) / 1000)),
        pausedSeconds: Math.max(0, Math.round(pausedMs / 1000)),
        endReason: reason,
    });
    state.tables[tableKey(t.type, t.number)] = idleTable(t.type, t.number);
}

function emitTableEvent(action, type, number) {
    io.emit('tableEvent', { action, type, number });
}

function broadcastState() { io.emit('state', snapshot()); }

// ---------------------------------------------------------------------------
// المؤقت الرئيسي — واحد بس لكل الطاولات
// ---------------------------------------------------------------------------
function tick() {
    const now = Date.now();
    let changed = false;
    for (const t of Object.values(state.tables)) {
        if (t.status === 'running' && t.mode === 'timed' && now >= t.endTime) {
            const { type, number } = t;
            finishSession(t, 'END', t.endTime);
            addActivity('END', type, number);
            emitTableEvent('END', type, number);
            executeLightSequence(type, number, 'END');
            changed = true;
        }
    }
    if (changed) saveState();
    broadcastState();
}

// ---------------------------------------------------------------------------
// السيرفر
// ---------------------------------------------------------------------------
const app = express();
app.set('trust proxy', true);
app.use(express.static(path.join(__dirname, 'public')));
app.get('/healthz', (_req, res) => res.json({ ok: true }));

const server = http.createServer(app);
const io = new Server(server);

// ---- حماية الرقم السري من التخمين ----
const failedLogins = new Map(); // ip -> { count, until }
const MAX_FAILS = 5, LOCK_MS = 5 * 60 * 1000;

function clientIp(socket) {
    const fwd = socket.handshake.headers['x-forwarded-for'];
    return (fwd ? String(fwd).split(',')[0] : socket.handshake.address || '').trim();
}

function safeEqual(a, b) {
    const ha = crypto.createHash('sha256').update(String(a)).digest();
    const hb = crypto.createHash('sha256').update(String(b)).digest();
    return crypto.timingSafeEqual(ha, hb);
}

function checkPin(ip, pin) {
    const now = Date.now();
    let rec = failedLogins.get(ip);
    if (rec && rec.until > now) return 'locked';
    if (rec && rec.until && rec.until <= now) rec = null; // انتهى الحظر، نبدأ من جديد
    if (STAFF_PIN && safeEqual(pin, STAFF_PIN)) { failedLogins.delete(ip); return 'ok'; }
    const count = (rec ? rec.count : 0) + 1;
    failedLogins.set(ip, { count, until: count >= MAX_FAILS ? now + LOCK_MS : 0 });
    return count >= MAX_FAILS ? 'locked' : 'wrong';
}

io.on('connection', (socket) => {
    const ip = clientIp(socket);
    const pin = socket.handshake.auth && socket.handshake.auth.pin;
    socket.data.staff = false;

    if (pin) {
        const result = checkPin(ip, pin);
        if (result === 'ok') socket.data.staff = true;
        else socket.emit('authFailed', result);
    }

    socket.emit('role', socket.data.staff ? 'staff' : 'viewer');
    socket.emit('state', snapshot());
    if (socket.data.staff) {
        socket.join('staff');
        socket.emit('frozen', state.frozen);
        socket.emit('activity', state.activity);
    }

    // كل أوامر التحكم تمر من هنا: الزوار مرفوضين
    const staffOn = (event, handler) => socket.on(event, (data) => {
        if (!socket.data.staff) return socket.emit('actionError', 'not_authorized');
        try { handler(data || {}); }
        catch (e) { console.error(`[${event}]`, e); socket.emit('actionError', 'server_error'); }
    });

    // تشغيل الطاولة (30 / 60 / مفتوح)
    staffOn('startTable', (data) => {
        const t = getTable(data);
        if (!t) return socket.emit('actionError', 'invalid');
        const mins = data.durationMinutes;
        const isOpen = mins === 'open';
        if (!isOpen && !ALLOWED_DURATIONS.includes(Number(mins))) return socket.emit('actionError', 'invalid');

        const now = Date.now();
        if (t.status !== 'idle') finishSession(t, 'RESTART', now); // الجلسة القديمة تنحفظ قبل ما تبدأ الجديدة
        const fresh = state.tables[tableKey(t.type, t.number)];
        beginSession(fresh, isOpen
            ? { mode: 'open' }
            : { mode: 'timed', durationMs: Number(mins) * 60000, bookedMinutes: Number(mins) }, now);

        lightsOn(t.type, t.number);
        addActivity('START', t.type, t.number);
        emitTableEvent('START', t.type, t.number);
        saveState(); broadcastState();
    });

    // إيقاف مؤقت
    staffOn('pauseTable', (data) => {
        const t = getTable(data);
        if (!t || t.status !== 'running') return;
        const now = Date.now();
        if (t.mode === 'timed') t.remainingMs = Math.max(0, t.endTime - now);
        else t.elapsedMs = now - t.startTime;
        t.status = 'paused';
        t.pausedAt = now;

        executeLightSequence(t.type, t.number, 'PAUSE');
        addActivity('PAUSE', t.type, t.number);
        emitTableEvent('PAUSE', t.type, t.number);
        saveState(); broadcastState();
    });

    // استئناف
    staffOn('resumeTable', (data) => {
        const t = getTable(data);
        if (!t || t.status !== 'paused') return;
        const now = Date.now();
        t.pausedMs = (t.pausedMs || 0) + (now - t.pausedAt);
        t.pausedAt = null;
        if (t.mode === 'timed') { t.endTime = now + t.remainingMs; t.remainingMs = null; }
        else { t.startTime = now - t.elapsedMs; t.elapsedMs = null; }
        t.status = 'running';

        lightsOn(t.type, t.number);
        addActivity('RESUME', t.type, t.number);
        emitTableEvent('RESUME', t.type, t.number);
        saveState(); broadcastState();
    });

    // تصفير
    staffOn('stopTable', (data) => {
        const t = getTable(data);
        if (!t) return socket.emit('actionError', 'invalid');
        const { type, number } = t;
        const wasActive = t.status !== 'idle';
        if (wasActive) {
            finishSession(t, 'STOP', Date.now());
            addActivity('STOP', type, number);
        }
        executeLightSequence(type, number, 'STOP'); // نفس السلوك القديم: تصفير = حركة اللمبة دايماً
        emitTableEvent('STOP', type, number);
        saveState(); broadcastState();
    });

    // تجميد: يوقف الطاولة ويحفظ الوقت باسم الزبون
    staffOn('freezeTable', (data) => {
        const t = getTable(data);
        if (!t || t.status === 'idle') return;
        const customer = String(data.customer || '').trim().slice(0, 40);
        if (!customer) return socket.emit('actionError', 'invalid');
        const now = Date.now();
        const seconds = secondsFor(t, now);
        if (t.mode === 'timed' && seconds <= 0) return;

        const { type, number, mode } = t;
        state.frozen.push({ id: state.nextFrozenId++, type, number, mode, seconds, customer, createdAt: now });
        finishSession(t, 'FREEZE', now);
        addActivity('FREEZE', type, number, { customer });
        executeLightSequence(type, number, 'STOP');
        emitTableEvent('STOP', type, number);
        io.to('staff').emit('frozen', state.frozen);
        saveState(); broadcastState();
    });

    // استرجاع رصيد مجمد (على نفس الطاولة)
    staffOn('resumeFrozen', (data) => {
        const idx = state.frozen.findIndex(f => f.id === Number(data.id));
        if (idx === -1) return socket.emit('actionError', 'invalid');
        const f = state.frozen[idx];
        const t = state.tables[tableKey(f.type, f.number)];
        if (!t) return socket.emit('actionError', 'invalid');
        if (t.status !== 'idle') return socket.emit('actionError', 'table_busy');

        // الرصيد المفتوح يكمل العد من حيث وقف، والمحدد يكمل العد التنازلي
        beginSession(t, f.mode === 'open'
            ? { mode: 'open', elapsedMs: f.seconds * 1000, source: 'frozen' }
            : { mode: 'timed', durationMs: f.seconds * 1000, source: 'frozen' }, Date.now());
        state.frozen.splice(idx, 1);

        lightsOn(t.type, t.number);
        addActivity('RESUME_FROZEN', t.type, t.number, { customer: f.customer });
        emitTableEvent('START', t.type, t.number);
        io.to('staff').emit('frozen', state.frozen);
        saveState(); broadcastState();
    });

    // مسح البيانات — يحتاج كلمة مرور الإدارة (غير رقم الموظفين)
    staffOn('resetData', (data) => {
        if (!ADMIN_PASSWORD || !safeEqual(data.password || '', ADMIN_PASSWORD)) {
            return socket.emit('actionError', 'bad_password');
        }
        // ما نحذف السجل نهائياً — ننقله لملف احتياطي
        if (fs.existsSync(SESSIONS_FILE)) {
            const stamp = new Date().toISOString().replace(/[:.]/g, '-');
            fs.renameSync(SESSIONS_FILE, path.join(DATA_DIR, `sessions-backup-${stamp}.jsonl`));
        }
        state.activity = [];
        state.frozen = [];
        saveState();
        io.emit('systemResetDone');
    });
});

// ---------------------------------------------------------------------------
// التشغيل
// ---------------------------------------------------------------------------
loadState();
initTables();

// الطاولات اللي انتهى وقتها والسيرفر طافي: نقفلها بوقت انتهائها الحقيقي
(function settleExpired() {
    const now = Date.now();
    for (const t of Object.values(state.tables)) {
        if (t.status === 'running' && t.mode === 'timed' && t.endTime <= now) {
            const { type, number } = t;
            finishSession(t, 'END', t.endTime);
            addActivity('END', type, number);
        }
    }
    saveState();
})();

setInterval(tick, 1000);

process.on('SIGTERM', () => { saveState(); process.exit(0); });
process.on('SIGINT', () => { saveState(); process.exit(0); });

server.listen(PORT, () => {
    console.log(`Bolos Alley System is ONLINE on port ${PORT}`);
});
