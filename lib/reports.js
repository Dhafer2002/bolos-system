'use strict';
/**
 * تقارير الإدارة — كل الحسابات هنا، والصفحة تستلم النتائج بس.
 * الوقت بتوقيت السعودية (UTC+3). "يوم العمل" من 6 الصبح إلى 6 الصبح اليوم الثاني،
 * فالجلسة الساعة 1 بالليل تنحسب على اليوم اللي قبله.
 *
 * sessions: { type, number, mode, source, bookedMinutes, extendedMinutes, start, end, playedSeconds, endReason }  (start/end بالـ ms)
 * history:  { ts, kind, game, number, data }
 */
const HOUR = 3600 * 1000, DAY = 24 * HOUR;
const SAUDI_OFFSET = 3 * HOUR;
const DAY_START_HOUR = 6;

// بداية يوم العمل (06:00 بتوقيت السعودية) كـ UTC ms
const dayStartMs = (day) => Date.parse(day + 'T00:00:00Z') - SAUDI_OFFSET + DAY_START_HOUR * HOUR;
const businessDay = (ms) => new Date(ms + SAUDI_OFFSET - DAY_START_HOUR * HOUR).toISOString().slice(0, 10);
// 0 = السبت ... 6 = الجمعة
const weekdayOf = (day) => (new Date(day + 'T00:00:00Z').getUTCDay() + 1) % 7;

const avg = (xs) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
const round = (x, d = 1) => Math.round(x * 10 ** d) / 10 ** d;
// إزاحة من بداية يوم العمل ← دقيقة من اليوم (0..1439)
const clockMinutes = (offsetMs) => Math.round(DAY_START_HOUR * 60 + offsetMs / 60000) % 1440;

// from/to بصيغة YYYY-MM-DD (يشمل الطرفين). يرجع null لو غلط أو أطول من maxDays
function parseRange(from, to, maxDays) {
    const re = /^\d{4}-\d{2}-\d{2}$/;
    if (!re.test(from) || !re.test(to)) return null;
    const a = Date.parse(from + 'T00:00:00Z'), b = Date.parse(to + 'T00:00:00Z');
    if (isNaN(a) || isNaN(b) || b < a) return null;
    // 2026-02-31 يتحول لتاريخ ثاني — نرفضه
    if (new Date(a).toISOString().slice(0, 10) !== from || new Date(b).toISOString().slice(0, 10) !== to) return null;
    const n = Math.round((b - a) / DAY) + 1;
    if (n > maxDays) return null;
    const days = Array.from({ length: n }, (_, i) => new Date(a + i * DAY).toISOString().slice(0, 10));
    return { from, to, days, start: dayStartMs(from), end: dayStartMs(to) + DAY };
}

function mergeIntervals(list) {
    const sorted = list.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
    const out = [];
    for (const [a, b] of sorted) {
        const last = out[out.length - 1];
        if (last && a <= last[1]) last[1] = Math.max(last[1], b);
        else out.push([a, b]);
    }
    return out;
}

const overlap = (intervals, a, b) => intervals.reduce((sum, [x, y]) => sum + Math.max(0, Math.min(b, y) - Math.max(a, x)), 0);

function computeReport({ range, sessions, history, layout, thresholds, now }) {
    const games = Object.keys(layout);
    const tablesOf = (g) => Array.from({ length: layout[g] }, (_, i) => i + 1);
    const key = (g, n) => `${g}-${n}`;

    // فترات الانشغال لكل طاولة — الإيقاف المؤقت يُحسب مشغول لأن الطاولة محجوزة
    const busy = {};
    for (const g of games) for (const n of tablesOf(g)) busy[key(g, n)] = [];
    for (const s of sessions) if (busy[key(s.type, s.number)]) busy[key(s.type, s.number)].push([s.start, s.end]);
    for (const k of Object.keys(busy)) busy[k] = mergeIntervals(busy[k]);
    const allBusy = Object.values(busy);

    // ساعات التشغيل لكل يوم عمل: أول بداية جلسة ← آخر نهاية جلسة
    const windows = [];
    for (const day of range.days) {
        const ds = sessions.filter(s => businessDay(s.start) === day);
        if (!ds.length) continue;
        windows.push({
            day, weekday: weekdayOf(day), dayStart: dayStartMs(day),
            start: Math.min(...ds.map(s => s.start)), end: Math.max(...ds.map(s => s.end)),
        });
    }
    const openMs = windows.reduce((a, w) => a + (w.end - w.start), 0);

    // ---- نظرة عامة ----
    const totals = {
        sessions: sessions.filter(s => s.source !== 'move').length, // النقل يكمّل نفس جلسة الزبون
        playedHours: round(sessions.reduce((a, s) => a + s.playedSeconds, 0) / 3600),
        opening: windows.length ? {
            firstStart: clockMinutes(avg(windows.map(w => w.start - w.dayStart))),
            lastEnd: clockMinutes(avg(windows.map(w => w.end - w.dayStart))),
        } : null,
        peak: null,
    };
    const edges = [];
    for (const iv of allBusy) for (const [a, b] of iv) edges.push([a, 1], [b, -1]);
    edges.sort((x, y) => x[0] - y[0] || x[1] - y[1]); // النهاية قبل البداية بنفس اللحظة
    let current = 0;
    for (const [t, d] of edges) {
        current += d;
        if (current > 0 && (!totals.peak || current > totals.peak.count)) totals.peak = { count: current, at: t };
    }

    // ---- الاستخدام ----
    const usage = {};
    for (const g of games) {
        const tables = tablesOf(g).map(n => {
            const busyMs = windows.reduce((a, w) => a + overlap(busy[key(g, n)], w.start, w.end), 0);
            const played = sessions.filter(s => s.type === g && s.number === n).reduce((a, s) => a + s.playedSeconds, 0);
            return { number: n, pctRaw: openMs ? 100 * busyMs / openMs : 0, hours: round(played / 3600) };
        });
        usage[g] = {
            pct: Math.round(avg(tables.map(t => t.pctRaw))),
            tables: tables.map(t => ({ number: t.number, pct: Math.round(t.pctRaw), hours: t.hours })),
        };
    }

    // ---- خريطة الضغط: متوسط عدد الطاولات المشغولة لكل يوم × ساعة (ساعات التشغيل بس) ----
    const sum = Array.from({ length: 7 }, () => Array(24).fill(0));
    const active = Array(24).fill(false);
    const openDaysByWeekday = Array(7).fill(0);
    for (const w of windows) {
        openDaysByWeekday[w.weekday]++;
        for (let k = 0; k < 24; k++) {
            const a = w.dayStart + k * HOUR, b = a + HOUR;
            if (b <= w.start || a >= w.end) continue;
            const h = (DAY_START_HOUR + k) % 24;
            active[h] = true;
            sum[w.weekday][h] += allBusy.reduce((acc, iv) => acc + overlap(iv, a, b), 0) / HOUR;
        }
    }
    const heatmap = {
        hours: Array.from({ length: 24 }, (_, k) => (DAY_START_HOUR + k) % 24).filter(h => active[h]),
        rows: sum.map((row, wd) => row.map((v, h) => (active[h] && openDaysByWeekday[wd]) ? round(v / openDaysByWeekday[wd], 2) : null)),
    };

    // ---- الزبائن والانتظار ----
    const adds = history.filter(h => h.kind === 'TICKET_ADD');
    const closedBy = new Map();
    for (const h of history) {
        if ((h.kind === 'TICKET_TURN' || h.kind === 'TICKET_REMOVE') && h.data && !closedBy.has(h.data.ticketId)) closedBy.set(h.data.ticketId, h);
    }
    const addById = new Map(adds.map(a => [a.data && a.data.ticketId, a]));
    const customers = {};
    for (const g of ['bowl', ...games]) {
        const gameAdds = adds.filter(a => a.game === g);
        const waits = history.filter(h => h.kind === 'TICKET_TURN' && h.game === g)
            .map(t => ({ turn: t, add: addById.get(t.data && t.data.ticketId) })).filter(p => p.add)
            .map(p => (p.turn.ts - p.add.ts) / 60000);
        const c = {
            tickets: gameAdds.length,
            avgWaitMin: waits.length ? Math.round(avg(waits)) : null,
            lost: history.filter(h => h.kind === 'TICKET_REMOVE' && h.game === g).length,
            fullWithWaitingHours: null,
        };
        if (g !== 'bowl' && gameAdds.length) {
            // كل طاولات اللعبة مشغولة + فيه تذكرة منتظرة من نفس اللعبة
            const ev = [];
            for (const n of tablesOf(g)) for (const [a, b] of busy[key(g, n)]) ev.push([a, 'busy', 1], [b, 'busy', -1]);
            for (const a of gameAdds) {
                const closed = closedBy.get(a.data.ticketId);
                const end = closed ? closed.ts : Math.min(now, range.end);
                if (end > a.ts) ev.push([a.ts, 'wait', 1], [end, 'wait', -1]);
            }
            ev.sort((x, y) => x[0] - y[0]);
            let busyN = 0, waitN = 0, last = null, fullMs = 0;
            for (const [t, kind, d] of ev) {
                if (last !== null && busyN >= layout[g] && waitN > 0) fullMs += t - last;
                if (kind === 'busy') busyN += d; else waitN += d;
                last = t;
            }
            c.fullWithWaitingHours = round(fullMs / HOUR);
        }
        customers[g] = c;
    }

    // ---- أنماط الجلسات (الجلسات الجديدة بس) ----
    const fresh = sessions.filter(s => s.source === 'new');
    const patterns = { open: 0, m30: 0, m60: 0, custom: 0, total: fresh.length };
    for (const s of fresh) {
        if (s.mode === 'open') { patterns.open++; continue; }
        const initial = (s.bookedMinutes || 0) - (s.extendedMinutes || 0); // الحجز الأول قبل أي تمديد
        if (initial === 30) patterns.m30++; else if (initial === 60) patterns.m60++; else patterns.custom++;
    }
    const timed = fresh.filter(s => s.mode === 'timed');
    patterns.avgSessionMin = fresh.length ? Math.round(avg(fresh.map(s => s.playedSeconds / 60))) : null;
    patterns.extendedPct = timed.length ? Math.round(100 * timed.filter(s => s.extendedMinutes > 0).length / timed.length) : null;

    const perGame = {};
    for (const g of games) {
        const gs = sessions.filter(s => s.type === g);
        perGame[g] = { moves: gs.filter(s => s.endReason === 'MOVE').length, freezes: gs.filter(s => s.endReason === 'FREEZE').length };
    }

    // ---- صحة الطاولات: بس الطاولات اللي وصلت الحد ----
    const health = [];
    for (const g of games) for (const n of tablesOf(g)) {
        const ts = sessions.filter(s => s.type === g && s.number === n);
        const short = ts.filter(s => s.playedSeconds < thresholds.shortSessionSeconds && s.endReason === 'STOP').length;
        const moved = ts.filter(s => s.endReason === 'MOVE').length;
        const lights = history.filter(h => (h.kind === 'LIGHT_ON' || h.kind === 'LIGHT_OFF') && h.game === g && h.number === n).length;
        if (short >= thresholds.shortSessionsFlag) health.push({ type: g, number: n, kind: 'short', count: short });
        if (moved >= thresholds.movedAwayFlag) health.push({ type: g, number: n, kind: 'moved', count: moved });
        if (lights >= thresholds.manualLightsFlag) health.push({ type: g, number: n, kind: 'lights', count: lights });
    }

    return {
        from: range.from, to: range.to, days: range.days.length, openDays: windows.length,
        totals, usage, heatmap, customers, patterns, perGame, health,
        thresholds: { shortMinutes: Math.round(thresholds.shortSessionSeconds / 60) },
    };
}

module.exports = { parseRange, computeReport, businessDay, dayStartMs };
