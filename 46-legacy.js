/*
 * 旧独立计时页一次性迁移（Issue #66）
 *
 * 首次加载助手时，把旧页裸键 `tasks` / `todos` 搬进 `ai-assistant.tasks`，
 * 搬完删旧键。只迁一次（标记键 `ai-assistant.legacy-imported`）。
 * JSON 损坏时保留旧键不动，不静默丢数据；不读旧计时状态 `currentTaskId`。
 */
(function () {
    'use strict';

    function slugify(title) {
        var raw = String(title || '').trim().toLowerCase();
        var slug = raw.replace(/[^\w\u4e00-\u9fa5]+/g, '-').replace(/^-+|-+$/g, '');
        if (!slug) slug = 'item';
        if (slug.length > 12) slug = slug.slice(0, 12);
        return slug;
    }

    function yyyymmdd(ts) {
        var d = new Date(ts === undefined ? Date.now() : ts);
        var m = String(d.getMonth() + 1);
        var day = String(d.getDate());
        if (m.length < 2) m = '0' + m;
        if (day.length < 2) day = '0' + day;
        return String(d.getFullYear()) + m + day;
    }

    function parseDate(value) {
        if (typeof value === 'number' && isFinite(value)) return value;
        var t = Date.parse(value);
        return isFinite(t) ? t : Date.now();
    }

    function migrate() {
        var AI = window.AIAssistant;
        if (!AI || !AI.tasks) return;
        var ls = null;
        try { ls = window.localStorage; } catch (e) { return; }
        if (!ls) return;

        var MARKER = 'ai-assistant.legacy-imported';
        try {
            if (ls.getItem(MARKER)) return;
        } catch (e) { return; }

        var tasksRaw = null;
        var todosRaw = null;
        try { tasksRaw = ls.getItem('tasks'); } catch (e) {}
        try { todosRaw = ls.getItem('todos'); } catch (e) {}

        if (!tasksRaw && !todosRaw) {
            try { ls.setItem(MARKER, '1'); } catch (e) {}
            return;
        }

        var importItems = [];
        var tasksOk = !tasksRaw;
        var todosOk = !todosRaw;

        if (tasksRaw) {
            try {
                var tasksArr = JSON.parse(tasksRaw);
                if (Array.isArray(tasksArr)) {
                    for (var i = 0; i < tasksArr.length; i++) {
                        var t = tasksArr[i] || {};
                        var createdAt = parseDate(t.createdAt);
                        var totalSeconds = Number(t.totalSeconds) || 0;
                        var remainingTime = Number(t.remainingTime) || 0;
                        importItems.push({
                            id: 'task_' + slugify(t.name) + '_' + yyyymmdd(createdAt),
                            kind: 'task',
                            title: String(t.name || '').trim() || '未命名任务',
                            durationMs: totalSeconds * 1000,
                            accumulatedMs: Math.max(0, totalSeconds - remainingTime) * 1000,
                            status: t.completed ? 'done' : 'todo',
                            source: 'me',
                            createdAt: createdAt
                        });
                    }
                    ls.removeItem('tasks');
                    tasksOk = true;
                }
            } catch (e) {
                /* 坏 JSON：保留旧键不动 */
            }
        }

        if (todosRaw) {
            try {
                var todosArr = JSON.parse(todosRaw);
                if (Array.isArray(todosArr)) {
                    for (var j = 0; j < todosArr.length; j++) {
                        var td = todosArr[j] || {};
                        var cAt = parseDate(td.createdAt);
                        importItems.push({
                            id: 'todo_' + yyyymmdd(cAt) + '_' + (j + 1),
                            kind: 'todo',
                            title: String(td.content || '').trim() || '未命名待办',
                            status: td.completed ? 'done' : 'todo',
                            source: 'me',
                            createdAt: cAt
                        });
                    }
                    ls.removeItem('todos');
                    todosOk = true;
                }
            } catch (e) {
                /* 坏 JSON：保留旧键不动 */
            }
        }

        if (importItems.length) {
            try { AI.tasks.importMany(importItems); } catch (e) {}
        }

        if (tasksOk && todosOk) {
            try { ls.setItem(MARKER, '1'); } catch (e) {}
        }
    }

    /* 47-tasks.js 在 46 之后加载，延后到所有脚本就绪 */
    setTimeout(migrate, 0);
})();
