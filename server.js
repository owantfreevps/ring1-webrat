const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Хранилища
const users = new Map();
const tasks = new Map();
let stats = { totalRequests: 0, successRequests: 0, activeProxies: 0, queueTasks: 0 };

// Прокси для обхода капчи
let proxies = [
    { address: '45.76.125.154:3128', status: 'online', lastCheck: Date.now() },
    { address: '103.152.112.120:80', status: 'online', lastCheck: Date.now() },
    { address: '20.111.54.16:8080', status: 'online', lastCheck: Date.now() },
    { address: '188.166.56.178:3128', status: 'online', lastCheck: Date.now() },
    { address: '51.159.75.147:3128', status: 'online', lastCheck: Date.now() },
    { address: '157.245.109.191:3128', status: 'online', lastCheck: Date.now() }
];

users.set('admin', {
    password: crypto.createHash('sha256').update('webrat2024').digest('hex'),
    token: null
});

function generateToken() {
    return crypto.randomBytes(64).toString('hex');
}

function authMiddleware(req, res, next) {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Требуется авторизация' });
    
    let valid = false;
    for (let [username, userData] of users) {
        if (userData.token === token) {
            req.username = username;
            valid = true;
            break;
        }
    }
    if (!valid) return res.status(401).json({ error: 'Недействительный токен' });
    next();
}

async function requestWithProxy(url, method = 'GET', body = null) {
    const activeProxies = proxies.filter(p => p.status === 'online');
    const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
        'Accept-Encoding': 'gzip, deflate, br',
        'DNT': '1',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1'
    };
    
    if (activeProxies.length === 0) {
        return await axios({ method, url, data: body, headers, timeout: 30000, maxRedirects: 5, validateStatus: () => true });
    }
    
    const proxy = activeProxies[Math.floor(Math.random() * activeProxies.length)];
    const [host, port] = proxy.address.split(':');
    return await axios({ method, url, data: body, proxy: { host, port: parseInt(port) }, headers, timeout: 30000, maxRedirects: 5, validateStatus: () => true });
}

// API
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    const hashedPassword = crypto.createHash('sha256').update(password).digest('hex');
    const user = users.get(username);
    if (user && user.password === hashedPassword) {
        const token = generateToken();
        user.token = token;
        res.json({ success: true, token });
    } else {
        res.status(401).json({ success: false, message: 'Неверный логин или пароль' });
    }
});

app.get('/api/stats', authMiddleware, (req, res) => {
    stats.activeProxies = proxies.filter(p => p.status === 'online').length;
    stats.queueTasks = tasks.size;
    res.json(stats);
});

app.get('/api/proxies', authMiddleware, (req, res) => {
    res.json(proxies);
});

app.post('/api/request', authMiddleware, async (req, res) => {
    const { url, method = 'GET', body = null } = req.body;
    if (!url) return res.json({ success: false, error: 'URL обязателен' });
    
    stats.totalRequests++;
    try {
        const response = await requestWithProxy(url, method, body);
        stats.successRequests++;
        res.json({
            success: true,
            statusCode: response.status,
            size: Buffer.byteLength(typeof response.data === 'string' ? response.data : JSON.stringify(response.data)),
            preview: typeof response.data === 'string' ? response.data.substring(0, 500) : JSON.stringify(response.data).substring(0, 500)
        });
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

app.post('/api/bulk', authMiddleware, async (req, res) => {
    const { urls, method = 'GET' } = req.body;
    const taskId = crypto.randomBytes(16).toString('hex');
    tasks.set(taskId, { urls, method, results: [], completed: false });
    
    (async () => {
        const task = tasks.get(taskId);
        for (const url of task.urls) {
            stats.totalRequests++;
            try {
                const response = await requestWithProxy(url, task.method);
                stats.successRequests++;
                task.results.push({ url, success: true, statusCode: response.status });
            } catch (error) {
                task.results.push({ url, success: false, error: error.message });
            }
            await new Promise(r => setTimeout(r, 500));
        }
        task.completed = true;
    })();
    
    res.json({ taskId });
});

app.get('/api/task/:taskId', authMiddleware, (req, res) => {
    const task = tasks.get(req.params.taskId);
    if (!task) return res.status(404).json({ error: 'Задача не найдена' });
    res.json({ completed: task.completed, results: task.results, total: task.urls.length, processed: task.results.length });
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Проверка прокси
setInterval(async () => {
    for (let proxy of proxies) {
        try {
            await axios.get('http://httpbin.org/ip', {
                proxy: { host: proxy.address.split(':')[0], port: parseInt(proxy.address.split(':')[1]) },
                timeout: 5000
            });
            proxy.status = 'online';
        } catch (error) {
            proxy.status = 'offline';
        }
    }
}, 60000);

app.listen(PORT, '0.0.0.0', () => {
    console.log(`RING-1 WebRat запущен на порту ${PORT}`);
    console.log(`Логин: admin | Пароль: webrat2024`);
});
