'use strict';
/**
 * Bolos Alley — server
 * السيرفر هو المصدر الوحيد للحقيقة: الحالة محفوظة في التخزين (Supabase أو data/)، والصفحة بس تعرض.
 * يشتغل على Vercel (بدون سيرفر دائم): الصفحات تسأل عن الحالة كل ثانيتين،
 * والطاولة اللي خلص وقتها تنقفل مع أول طلب يجي بعد انتهائها.
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { waitUntil } = require('@vercel/functions');

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
const SESSION_SECRET = process.env.SESSION_SECRET || '';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');

if (!STAFF_PIN) console.warn('⚠️  STAFF_PIN is not set — nobody will be able to control the tables.');
if (!IFTTT_KEY) console.warn('⚠️  IFTTT_KEY is not set — lights are disabled.');
if (!ADMIN_PASSWORD) console.warn('⚠️  ADMIN_PASSWORD is not set — master reset is disabled.');

// الطاولات المسموحة فقط (لازم تطابق الكروت في الصفحة)
const TABLE_LAYOUT = { pool: 5, pingpong: 2, foosball: 3, ps: 2, baloot: 2, karaoke: 1 };
const MAX_DURATION_MINUTES = 12 * 60; // أطول مدة مسموحة: 12 ساعة
const isValidDuration = (m) => Number.isInteger(m) && m >= 1 && m <= MAX_DURATION_MINUTES;
const ACTIVITY_PER_GAME = 20; // كل لعبة تحتفظ بآخر 20 حركة لها
// قائمة الانتظار: البولينج + كل ألعاب الطاولات
const WAIT_GAMES = ['bowl', ...Object.keys(TABLE_LAYOUT)];
const WAITLIST_LIMIT = 100;
const riyadhDay = (ms) => new Date(ms + 3 * 3600 * 1000).toISOString().slice(0, 10); // أرقام التذاكر ترجع 1 كل يوم
const activityBucket = (a) => (a.action === 'FREEZE' || a.action === 'RESUME_FROZEN') ? 'general' : a.type;
const EVENTS_LIMIT = 30;
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // دخول الموظف يبقى 30 يوم

// تقارير الإدارة
const REPORT_MAX_DAYS = 93;
// حدود تنبيهات "صحة الطاولات" — الطاولة تظهر بالتقرير لو وصلت الحد
const HEALTH_THRESHOLDS = {
    shortSessionSeconds: 5 * 60, // جلسة قصيرة = أقل من 5 دقائق وانتهت بتصفير
    shortSessionsFlag: 3,        // عدد الجلسات القصيرة
    movedAwayFlag: 3,            // عدد مرات نقل الزبائن من الطاولة
    manualLightsFlag: 5,         // تشغيل + إطفاء اللمبة يدوياً
};

const store = require('./lib/store')({ dataDir: DATA_DIR });
const reports = require('./lib/reports');

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
 * events = آخر الحركات (لرمش الكروت على كل الشاشات)
 * lights[key] = رقم آخر حركة لمبات — أي أمر جديد يغيره فتتوقف الحركة القديمة
 */
const tableKey = (type, number) => `${type}-${number}`;
const idleTable = (type, number) => ({ type, number, status: 'idle', mode: null });

function isValidTable(type, number) {
    return Object.prototype.hasOwnProperty.call(TABLE_LAYOUT, type)
        && Number.isInteger(number) && number >= 1 && number <= TABLE_LAYOUT[type];
}

function normalize(saved) {
    const state = {
        tables: saved.tables || {},
        frozen: Array.isArray(saved.frozen) ? saved.frozen : [],
        activity: Array.isArray(saved.activity) ? saved.activity : [],
        events: Array.isArray(saved.events) ? saved.events : [],
        lights: saved.lights || {},
        nextFrozenId: saved.nextFrozenId || 1,
        nextEventId: saved.nextEventId || 1,
        nextLightId: saved.nextLightId || 1,
        resetCount: saved.resetCount || 0,
        waitlist: Array.isArray(saved.waitlist) ? saved.waitlist : [],
        ticketDay: saved.ticketDay || '',
        ticketCounters: saved.ticketCounters || {},
        nextTicketId: saved.nextTicketId || 1,
    };
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
    return state;
}

function getTable(state, data) {
    if (!data || typeof data !== 'object') return null;
    const type = String(data.type || '');
    const number = Number(data.number);
    if (!isValidTable(type, number)) return null;
    return state.tables[tableKey(type, number)];
}

// ---------------------------------------------------------------------------
// تعديل الحالة بأمان
// ---------------------------------------------------------------------------
// fn يعدّل الحالة ويضيف "آثار" (جلسات للتقارير، حركات لمبات) في fx.
// الآثار ما تتنفذ إلا بعد ما ينحفظ التعديل — عشان إعادة المحاولة ما تكرر شيء.
async function mutate(fn) {
    for (let attempt = 0; attempt < 6; attempt++) {
        const { data, version } = await store.read();
        const state = normalize(data);
        const fx = { sessions: [], history: [], lights: [], archive: false };
        const now = Date.now();
        const settled = settleExpired(state, fx, now);
        const result = fn ? fn(state, fx, now) : undefined;
        if (result && result.error && !settled) return { state, result };
        if (!settled && result && result.unchanged) return { state, result };

        if (await store.write(state, version)) {
            await store.appendSessions(fx.sessions);
            await store.appendHistory(fx.history);
            if (fx.archive) await store.archiveSessions();
            for (const l of fx.lights) waitUntil(runLights(l));
            return { state, result };
        }
        await delay(50 + Math.random() * 150); // أحد ثاني عدّل بنفس اللحظة — نعيد من جديد
    }
    throw new Error('state_conflict');
}

async function readState() {
    const { data } = await store.read();
    const state = normalize(data);
    if (hasExpired(state, Date.now())) return (await mutate(null)).state;
    return state;
}

// ---------------------------------------------------------------------------
// IFTTT + حركات اللمبات
// ---------------------------------------------------------------------------
const delay = ms => new Promise(r => setTimeout(r, ms));

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

// أي أمر جديد على نفس الطاولة يلغي أي حركة رمش قديمة شغالة
function queueLights(state, fx, type, number, action) {
    const k = tableKey(type, number);
    const id = state.nextLightId++;
    state.lights[k] = id;
    fx.lights.push({ type, number, action, id });
}

async function runLights({ type, number, action, id }) {
    const k = tableKey(type, number);
    const isActive = async () => {
        try { return normalize((await store.read()).data).lights[k] === id; }
        catch (e) { console.error('[lights] state check failed:', e.message); return false; }
    };

    if (action === 'ON') {
        await sendAction(type, number, 'ON');
    } else if (action === 'OFF') {
        await sendAction(type, number, 'OFF');
    } else if (action === 'PAUSE') {
        // ترمش شوي وتظل شغالة
        await sendAction(type, number, 'OFF'); await delay(2000);
        if (await isActive()) await sendAction(type, number, 'ON');  await delay(2000);
        if (await isActive()) await sendAction(type, number, 'OFF'); await delay(2000);
        if (await isActive()) await sendAction(type, number, 'ON');
    } else if (action === 'END' || action === 'STOP') {
        // ترمش، تطفي 10 ثواني، ثم تشتغل (جاهزة للزبون الجاي)
        await sendAction(type, number, 'OFF'); await delay(2000);
        if (await isActive()) await sendAction(type, number, 'ON');  await delay(2000);
        if (await isActive()) await sendAction(type, number, 'OFF'); await delay(10000);
        if (await isActive()) await sendAction(type, number, 'ON');
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

function addActivity(state, action, type, number, extra = {}) {
    state.activity.unshift({ ts: Date.now(), action, type, number, ...extra });
    const seen = {};
    state.activity = state.activity.filter(a => {
        const b = activityBucket(a);
        seen[b] = (seen[b] || 0) + 1;
        return seen[b] <= ACTIVITY_PER_GAME;
    });
}

function addEvent(state, action, type, number, extra = {}) {
    state.events.unshift({ id: state.nextEventId++, ts: Date.now(), action, type, number, ...extra });
    if (state.events.length > EVENTS_LIMIT) state.events.length = EVENTS_LIMIT;
}

// سجل دائم للتقارير (تذاكر + لمبات يدوية) — بدون أسماء الزبائن
function addHistory(fx, now, kind, game, number = null, data = {}) {
    fx.history.push({ ts: new Date(now).toISOString(), kind, game, number, data });
}

function beginSession(t, { mode, durationMs = 0, elapsedMs = 0, source = 'new', bookedMinutes = null }, now) {
    Object.assign(t, {
        status: 'running', mode,
        endTime: mode === 'timed' ? now + durationMs : null,
        startTime: mode === 'open' ? now - elapsedMs : null,
        remainingMs: null, elapsedMs: null,
        sessionStart: now, pausedMs: 0, pausedAt: null,
        source, bookedMinutes, extendedMinutes: 0,
    });
}

// تنهي الجلسة وتسجلها للتقارير
function finishSession(state, fx, t, reason, endAt) {
    const pausedMs = (t.pausedMs || 0) + (t.status === 'paused' && t.pausedAt ? endAt - t.pausedAt : 0);
    fx.sessions.push({
        type: t.type,
        number: t.number,
        mode: t.mode,
        source: t.source || 'new',
        bookedMinutes: t.bookedMinutes ?? null,
        extendedMinutes: t.extendedMinutes || 0,
        start: new Date(t.sessionStart).toISOString(),
        end: new Date(endAt).toISOString(),
        playedSeconds: Math.max(0, Math.round((endAt - t.sessionStart - pausedMs) / 1000)),
        pausedSeconds: Math.max(0, Math.round(pausedMs / 1000)),
        endReason: reason,
    });
    state.tables[tableKey(t.type, t.number)] = idleTable(t.type, t.number);
}

const hasExpired = (state, now) => Object.values(state.tables)
    .some(t => t.status === 'running' && t.mode === 'timed' && now >= t.endTime);

// الطاولات اللي خلص وقتها: نقفلها بوقت انتهائها الحقيقي
function settleExpired(state, fx, now) {
    let changed = false;
    for (const t of Object.values(state.tables)) {
        if (t.status === 'running' && t.mode === 'timed' && now >= t.endTime) {
            const { type, number } = t;
            finishSession(state, fx, t, 'END', t.endTime);
            addActivity(state, 'END', type, number);
            addEvent(state, 'END', type, number);
            // لو خلصت من زمان (مثلاً ما كان فيه أحد فاتح الصفحة) لا ترمش اللمبات متأخر
            if (now - t.endTime < 5 * 60 * 1000) queueLights(state, fx, type, number, 'END');
            changed = true;
        }
    }
    return changed;
}

// ---------------------------------------------------------------------------
// أوامر التحكم (للموظفين فقط)
// ---------------------------------------------------------------------------
const actions = {
    // تشغيل الطاولة (30 / 60 / مفتوح)
    startTable(state, fx, now, data) {
        const t = getTable(state, data);
        if (!t) return { error: 'invalid' };
        const mins = data.durationMinutes;
        const isOpen = mins === 'open';
        if (!isOpen && !isValidDuration(Number(mins))) return { error: 'invalid' };

        if (t.status !== 'idle') finishSession(state, fx, t, 'RESTART', now); // الجلسة القديمة تنحفظ قبل ما تبدأ الجديدة
        const fresh = state.tables[tableKey(t.type, t.number)];
        beginSession(fresh, isOpen
            ? { mode: 'open' }
            : { mode: 'timed', durationMs: Number(mins) * 60000, bookedMinutes: Number(mins) }, now);

        queueLights(state, fx, t.type, t.number, 'ON');
        addActivity(state, 'START', t.type, t.number);
        addEvent(state, 'START', t.type, t.number);
    },

    // إيقاف مؤقت
    pauseTable(state, fx, now, data) {
        const t = getTable(state, data);
        if (!t || t.status !== 'running') return { unchanged: true };
        if (t.mode === 'timed') t.remainingMs = Math.max(0, t.endTime - now);
        else t.elapsedMs = now - t.startTime;
        t.status = 'paused';
        t.pausedAt = now;

        queueLights(state, fx, t.type, t.number, 'PAUSE');
        addActivity(state, 'PAUSE', t.type, t.number);
        addEvent(state, 'PAUSE', t.type, t.number);
    },

    // استئناف
    resumeTable(state, fx, now, data) {
        const t = getTable(state, data);
        if (!t || t.status !== 'paused') return { unchanged: true };
        t.pausedMs = (t.pausedMs || 0) + (now - t.pausedAt);
        t.pausedAt = null;
        if (t.mode === 'timed') { t.endTime = now + t.remainingMs; t.remainingMs = null; }
        else { t.startTime = now - t.elapsedMs; t.elapsedMs = null; }
        t.status = 'running';

        queueLights(state, fx, t.type, t.number, 'ON');
        addActivity(state, 'RESUME', t.type, t.number);
        addEvent(state, 'RESUME', t.type, t.number);
    },

    // تصفير
    stopTable(state, fx, now, data) {
        const t = getTable(state, data);
        if (!t) return { error: 'invalid' };
        const { type, number } = t;
        if (t.status !== 'idle') {
            finishSession(state, fx, t, 'STOP', now);
            addActivity(state, 'STOP', type, number);
        }
        queueLights(state, fx, type, number, 'STOP'); // نفس السلوك القديم: تصفير = حركة اللمبة دايماً
        addEvent(state, 'STOP', type, number);
    },

    // تمديد: يضيف وقت لطاولة شغالة أو موقفة مؤقتاً بدون ما يعيد الجلسة
    extendTable(state, fx, now, data) {
        const t = getTable(state, data);
        if (!t) return { error: 'invalid' };
        const mins = Number(data.minutes);
        if (!Number.isInteger(mins) || mins < 1) return { error: 'invalid' };
        if (t.mode !== 'timed' || (t.status !== 'running' && t.status !== 'paused')) return { error: 'cannot_extend' };
        const remainingMs = t.status === 'running' ? t.endTime - now : t.remainingMs;
        if (remainingMs <= 0) return { error: 'cannot_extend' };
        if (remainingMs + mins * 60000 > MAX_DURATION_MINUTES * 60000) return { error: 'too_long' };
        if (t.status === 'running') t.endTime += mins * 60000;
        else t.remainingMs += mins * 60000;
        t.bookedMinutes = (t.bookedMinutes || 0) + mins;
        t.extendedMinutes = (t.extendedMinutes || 0) + mins;
        addActivity(state, 'EXTEND', t.type, t.number, { minutes: mins });
        addEvent(state, 'EXTEND', t.type, t.number);
    },

    // نقل: الوقت المتبقي (أو المنقضي) ينتقل لطاولة فاضية من نفس اللعبة
    moveTable(state, fx, now, data) {
        const from = getTable(state, data);
        const to = getTable(state, { type: data.type, number: data.toNumber });
        if (!from || !to || from === to || from.status === 'idle') return { error: 'invalid' };
        if (to.status !== 'idle') return { error: 'table_busy' };
        const { type, mode, status } = from;
        const running = status === 'running';
        const remainingMs = mode === 'timed' ? (running ? from.endTime - now : from.remainingMs) : 0;
        const elapsedMs = mode === 'open' ? (running ? now - from.startTime : from.elapsedMs) : 0;
        if (mode === 'timed' && remainingMs <= 0) return { error: 'invalid' };
        finishSession(state, fx, from, 'MOVE', now);
        const target = state.tables[tableKey(type, to.number)];
        beginSession(target, mode === 'open'
            ? { mode: 'open', elapsedMs, source: 'move' }
            : { mode: 'timed', durationMs: remainingMs, source: 'move' }, now);
        if (!running) {
            if (mode === 'timed') { target.remainingMs = remainingMs; target.endTime = null; }
            else { target.elapsedMs = elapsedMs; target.startTime = null; }
            target.status = 'paused';
            target.pausedAt = now;
        }
        queueLights(state, fx, type, from.number, 'STOP');
        queueLights(state, fx, type, to.number, 'ON');
        addActivity(state, 'MOVE', type, from.number, { toNumber: to.number });
        addEvent(state, 'MOVE', type, from.number, { toNumber: to.number });
    },

    // تشغيل/إطفاء اللمبة يدوياً — ما يأثر على العداد
    setLight(state, fx, now, data) {
        const t = getTable(state, data);
        if (!t || typeof data.on !== 'boolean') return { error: 'invalid' };
        const action = data.on ? 'LIGHT_ON' : 'LIGHT_OFF';
        queueLights(state, fx, t.type, t.number, data.on ? 'ON' : 'OFF');
        addActivity(state, action, t.type, t.number);
        addEvent(state, action, t.type, t.number);
        addHistory(fx, now, action, t.type, t.number);
    },

    // تجميد: يوقف الطاولة ويحفظ الوقت باسم الزبون
    freezeTable(state, fx, now, data) {
        const t = getTable(state, data);
        if (!t || t.status === 'idle') return { unchanged: true };
        const customer = String(data.customer || '').trim().slice(0, 40);
        if (!customer) return { error: 'invalid' };
        const seconds = secondsFor(t, now);
        if (t.mode === 'timed' && seconds <= 0) return { unchanged: true };

        const { type, number, mode } = t;
        state.frozen.push({ id: state.nextFrozenId++, type, number, mode, seconds, customer, createdAt: now });
        finishSession(state, fx, t, 'FREEZE', now);
        addActivity(state, 'FREEZE', type, number, { customer });
        queueLights(state, fx, type, number, 'STOP');
        addEvent(state, 'STOP', type, number);
    },

    // استرجاع رصيد مجمد (على نفس الطاولة)
    resumeFrozen(state, fx, now, data) {
        const idx = state.frozen.findIndex(f => f.id === Number(data.id));
        if (idx === -1) return { error: 'invalid' };
        const f = state.frozen[idx];
        const target = data.toNumber !== undefined ? Number(data.toNumber) : f.number;
        if (!isValidTable(f.type, target)) return { error: 'invalid' };
        const t = state.tables[tableKey(f.type, target)];
        if (t.status !== 'idle') return { error: 'table_busy' };

        // الرصيد المفتوح يكمل العد من حيث وقف، والمحدد يكمل العد التنازلي
        beginSession(t, f.mode === 'open'
            ? { mode: 'open', elapsedMs: f.seconds * 1000, source: 'frozen' }
            : { mode: 'timed', durationMs: f.seconds * 1000, source: 'frozen' }, now);
        state.frozen.splice(idx, 1);

        queueLights(state, fx, t.type, t.number, 'ON');
        addActivity(state, 'RESUME_FROZEN', t.type, t.number, { customer: f.customer });
        addEvent(state, 'START', t.type, t.number);
    },

    addTicket(state, fx, now, data) {
        const name = String(data.name || '').trim().slice(0, 30);
        const game = String(data.game || '');
        if (!name || !WAIT_GAMES.includes(game)) return { error: 'invalid' };
        let players = null;
        if (game === 'bowl') {
            players = Number(data.players);
            if (!Number.isInteger(players) || players < 1 || players > 6) return { error: 'invalid' };
        }
        if (state.waitlist.length >= WAITLIST_LIMIT) return { error: 'invalid' };
        const day = riyadhDay(now);
        if (state.ticketDay !== day) { state.ticketDay = day; state.ticketCounters = {}; }
        const num = (state.ticketCounters[game] || 0) + 1;
        state.ticketCounters[game] = num;
        const id = state.nextTicketId++;
        state.waitlist.push({ id, game, name, players, num, createdAt: now });
        addHistory(fx, now, 'TICKET_ADD', game, null, { ticketId: id });
    },

    // reason: 'turn' = جاء دورهم، 'delete' = انحذفت (الزبون مشى)
    removeTicket(state, fx, now, data) {
        const idx = state.waitlist.findIndex(w => w.id === Number(data.id));
        if (idx === -1) return { unchanged: true };
        const [w] = state.waitlist.splice(idx, 1);
        addHistory(fx, now, data.reason === 'turn' ? 'TICKET_TURN' : 'TICKET_REMOVE', w.game, null, { ticketId: w.id });
    },

    // مسح البيانات — كلمة مرور الإدارة تتفحص قبل ما نوصل هنا
    resetData(state, fx) {
        fx.archive = true; // ما نحذف السجل نهائياً — نأرشفه
        state.activity = [];
        state.frozen = [];
        state.resetCount++;
    },
};

// ---------------------------------------------------------------------------
// تسجيل دخول الموظفين
// ---------------------------------------------------------------------------
const MAX_FAILS = 5, LOCK_MS = 5 * 60 * 1000;

function safeEqual(a, b) {
    const ha = crypto.createHash('sha256').update(String(a)).digest();
    const hb = crypto.createHash('sha256').update(String(b)).digest();
    return crypto.timingSafeEqual(ha, hb);
}

// التوكن يتوقع بالرقم السري: لو غيرت STAFF_PIN كل الأجهزة تطلع تلقائياً
const tokenKey = () => `${SESSION_SECRET || ADMIN_PASSWORD}|${STAFF_PIN}`;
const sign = (exp) => crypto.createHmac('sha256', tokenKey()).update(`staff.${exp}`).digest('base64url');

function makeToken() {
    const exp = Date.now() + TOKEN_TTL_MS;
    return `${exp}.${sign(exp)}`;
}

function isStaff(req) {
    if (!STAFF_PIN) return false;
    const m = String(req.headers.authorization || '').match(/^Bearer (\d+)\.([\w-]+)$/);
    if (!m || Number(m[1]) < Date.now()) return false;
    return safeEqual(m[2], sign(m[1]));
}

async function checkPin(ip, pin) {
    const now = Date.now();
    let rec = await store.getFailure(ip);
    if (rec && rec.until > now) return 'locked';
    if (rec && rec.until && rec.until <= now) rec = null; // انتهى الحظر، نبدأ من جديد
    if (STAFF_PIN && safeEqual(pin, STAFF_PIN)) { if (rec) await store.clearFailure(ip); return 'ok'; }
    const count = (rec ? rec.count : 0) + 1;
    await store.setFailure(ip, { count, until: count >= MAX_FAILS ? now + LOCK_MS : 0 });
    return count >= MAX_FAILS ? 'locked' : 'wrong';
}

// ---------------------------------------------------------------------------
// اللي تشوفه الصفحة
// ---------------------------------------------------------------------------
function view(state, staff, now = Date.now()) {
    const tables = {};
    for (const [k, t] of Object.entries(state.tables)) {
        tables[k] = { status: t.status, mode: t.mode, seconds: secondsFor(t, now) };
    }
    const out = { role: staff ? 'staff' : 'viewer', tables, events: state.events, resetCount: state.resetCount };
    if (staff) { out.frozen = state.frozen; out.activity = state.activity; out.waitlist = state.waitlist; }
    return out;
}

// ---------------------------------------------------------------------------
// السيرفر
// ---------------------------------------------------------------------------
const app = express();
app.set('trust proxy', true);
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '10kb' }));
app.use('/api', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

const route = (handler) => async (req, res) => {
    try { await handler(req, res); }
    catch (e) { console.error(`[${req.method} ${req.path}]`, e); res.status(500).json({ error: 'server_error' }); }
};

app.get('/healthz', (_req, res) => res.json({ ok: true, store: store.kind }));

app.get('/api/state', route(async (req, res) => {
    res.json(view(await readState(), isStaff(req)));
}));

app.post('/api/login', route(async (req, res) => {
    const pin = String((req.body && req.body.pin) || '');
    if (!pin) return res.status(400).json({ error: 'wrong' });
    const result = await checkPin(req.ip || '', pin);
    if (result !== 'ok') return res.status(401).json({ error: result });
    res.json({ token: makeToken() });
}));

// تقارير الإدارة: ?from=YYYY-MM-DD&to=YYYY-MM-DD (يشمل الطرفين، أيام عمل بتوقيت السعودية)
app.get('/api/reports', route(async (req, res) => {
    if (!isStaff(req)) return res.status(401).json({ error: 'not_authorized' });
    const range = reports.parseRange(String(req.query.from || ''), String(req.query.to || ''), REPORT_MAX_DAYS);
    if (!range) return res.status(400).json({ error: 'bad_range' });
    const [sessions, history] = await Promise.all([
        store.readSessions(range.start, range.end),
        store.readHistory(range.start, range.end),
    ]);
    res.json(reports.computeReport({ range, sessions, history, layout: TABLE_LAYOUT, thresholds: HEALTH_THRESHOLDS, now: Date.now() }));
}));

// كل أوامر التحكم تمر من هنا: الزوار مرفوضين
app.post('/api/action', route(async (req, res) => {
    if (!isStaff(req)) return res.status(401).json({ error: 'not_authorized' });
    const data = req.body || {};
    const handler = Object.prototype.hasOwnProperty.call(actions, data.action) && actions[data.action];
    if (!handler) return res.status(400).json({ error: 'invalid' });
    if (data.action === 'resetData' && (!ADMIN_PASSWORD || !safeEqual(data.password || '', ADMIN_PASSWORD))) {
        return res.status(403).json({ error: 'bad_password' });
    }
    const { state, result } = await mutate((s, fx, now) => handler(s, fx, now, data));
    if (result && result.error) return res.status(400).json({ error: result.error, state: view(state, true) });
    res.json({ state: view(state, true) });
}));

// ---------------------------------------------------------------------------
// التشغيل (على Vercel نفس الشي — Vercel يلتقط server.listen)
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
    console.log(`Bolos Alley System is ONLINE on port ${PORT} (storage: ${store.kind})`);
});
