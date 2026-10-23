const express = require('express');
const fs = require('fs');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
app.use(express.json());
const server = http.createServer(app);
const io = new Server(server);

// إعدادات IFTTT الخاصة بصالتك
const IFTTT_KEY = 'h-FI8PhUTY-ACz4pZhC7B'; 
const DATA_FILE = './reports.json'; 
const PORT = 3000; 

app.use(express.static('public')); 

let activeTables = {}; 
let tableSequence = {}; // نظام حماية عشان ما تتداخل أوامر اللمبات لو ضغطت الأزرار بسرعة

// دالة التأخير الزمني بين الأوامر (عشان اللمبات ترمش براحتها ولا يعلق IFTTT)
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function sendAction(type, number, status) {
    let eventName = (type === 'pool') 
        ? `Pool${number}_${status.toUpperCase()}` 
        : `${type}${number}_${status.toLowerCase()}`;
    try {
        await fetch(`https://maker.ifttt.com/trigger/${eventName}/with/key/${IFTTT_KEY}`, { method: 'POST' });
        console.log(`[Bolos IFTTT] ${eventName} -> ${status}`);
    } catch (e) { console.error("Error connecting to IFTTT"); }
}

// دالة الحركات السينمائية للمبات
async function executeLightSequence(type, number, actionType) {
    let key = `${type}-${number}`;
    let seqId = Date.now();
    tableSequence[key] = seqId; // نحفظ رقم تسلسلي للعملية الحالية
    
    // هذي الدالة تتأكد إنك ما ضغطت زر ثاني يكسر الحركة (مثلاً لو صفرت وشغلت على طول)
    const isActive = () => tableSequence[key] === seqId;

    if (actionType === 'PAUSE') {
        // الإيقاف المؤقت: ترمش شويا وتظل شغالة
        if(isActive()) await sendAction(type, number, 'OFF');
        await delay(2000); 
        if(isActive()) await sendAction(type, number, 'ON');
        await delay(2000);
        if(isActive()) await sendAction(type, number, 'OFF');
        await delay(2000);
        if(isActive()) await sendAction(type, number, 'ON'); // تستقر شغالة
    } 
    else if (actionType === 'END' || actionType === 'STOP') {
        // التصفير أو انتهاء الوقت: ترمش، ثم تطفي 10 ثواني، ثم تشتغل
        if(isActive()) await sendAction(type, number, 'OFF');
        await delay(2000);
        if(isActive()) await sendAction(type, number, 'ON');
        await delay(2000);
        if(isActive()) await sendAction(type, number, 'OFF');
        
        // تطفي لمدة 10 ثواني (تطفي شوي زي ما طلبت) عشان الزبون ينتبه إن وقته خلص
        await delay(10000); 
        
        if(isActive()) await sendAction(type, number, 'ON'); // تشتغل دلالة إنها فاضية وجاهزة
    }
}

io.on('connection', (socket) => {
    
    // تشغيل الطاولة
    socket.on('startTable', (data) => {
        const { type, number, durationMinutes } = data;
        let key = `${type}-${number}`;
        
        if (activeTables[key] && activeTables[key].interval) {
            clearInterval(activeTables[key].interval);
        }
        
        tableSequence[key] = Date.now(); // نلغي أي حركة رمش قديمة قاعدة تصير
        sendAction(type, number, 'ON'); // تشغيل طبيعي ومباشر
        
        if (durationMinutes === 'open') {
            let startTime = Date.now(); 
            activeTables[key] = { isOpen: true, startTime: startTime };
            activeTables[key].interval = setInterval(() => {
                let secondsElapsed = Math.floor((Date.now() - activeTables[key].startTime) / 1000);
                io.emit('tickOpen', { type, number, secondsElapsed });
            }, 1000);
        } 
        else {
            let durationMs = durationMinutes * 60 * 1000;
            let endTime = Date.now() + durationMs; 
            
            activeTables[key] = { isOpen: false, endTime: endTime };
            activeTables[key].interval = setInterval(() => {
                let remaining = Math.floor((activeTables[key].endTime - Date.now()) / 1000);
                
                if (remaining <= 0) {
                    clearInterval(activeTables[key].interval);
                    delete activeTables[key];
                    io.emit('tick', { type, number, secondsLeft: 0 });
                    
                    // استدعاء حركة انتهاء الوقت
                    executeLightSequence(type, number, 'END');
                } else {
                    io.emit('tick', { type, number, secondsLeft: remaining });
                }
            }, 1000);
        }
    });

    // الإيقاف المؤقت (Pause)
    socket.on('pauseTable', (data) => {
        let key = `${data.type}-${data.number}`;
        if (activeTables[key] && activeTables[key].interval) {
            clearInterval(activeTables[key].interval);
            activeTables[key].interval = null; // علامة التوقف
            if (activeTables[key].isOpen) {
                activeTables[key].savedElapsed = Date.now() - activeTables[key].startTime;
            } else {
                activeTables[key].savedRemaining = activeTables[key].endTime - Date.now();
            }
            
            // استدعاء حركة الإيقاف المؤقت
            executeLightSequence(data.type, data.number, 'PAUSE');
        }
    });

    // الاستئناف (Resume)
    socket.on('resumeTable', (data) => {
        let key = `${data.type}-${data.number}`;
        if (activeTables[key] && activeTables[key].interval === null) {
            tableSequence[key] = Date.now(); // نلغي أي رمش كان يصير
            sendAction(data.type, data.number, 'ON'); 
            
            if (activeTables[key].isOpen) {
                activeTables[key].startTime = Date.now() - activeTables[key].savedElapsed;
                activeTables[key].interval = setInterval(() => {
                    let secondsElapsed = Math.floor((Date.now() - activeTables[key].startTime) / 1000);
                    io.emit('tickOpen', { type: data.type, number: data.number, secondsElapsed });
                }, 1000);
            } else {
                activeTables[key].endTime = Date.now() + activeTables[key].savedRemaining;
                activeTables[key].interval = setInterval(() => {
                    let remaining = Math.floor((activeTables[key].endTime - Date.now()) / 1000);
                    if (remaining <= 0) {
                        clearInterval(activeTables[key].interval);
                        delete activeTables[key];
                        io.emit('tick', { type: data.type, number: data.number, secondsLeft: 0 });
                        
                        // حركة انتهاء الوقت
                        executeLightSequence(data.type, data.number, 'END');
                    } else {
                        io.emit('tick', { type: data.type, number: data.number, secondsLeft: remaining });
                    }
                }, 1000);
            }
        }
    });

    // التصفير أو الإيقاف النهائي
    socket.on('stopTable', (data) => {
        let key = `${data.type}-${data.number}`;
        if (activeTables[key]) {
            clearInterval(activeTables[key].interval);
            delete activeTables[key];
        }
        
        // استدعاء حركة الإنهاء اليدوي
        executeLightSequence(data.type, data.number, 'STOP');
        io.emit('tick', { type: data.type, number: data.number, secondsLeft: 0 }); 
    });

    socket.on('resetData', (data) => {
        if (data.password === "1234") {
            if (fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, JSON.stringify([])); 
            io.emit('systemResetDone');
        }
    });
});

server.listen(PORT, () => {
    console.log(`Bolos Alley System is ONLINE (With Smart Light Sequences)!`); 
});