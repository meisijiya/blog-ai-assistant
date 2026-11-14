/*
 * 清单：任务与待办是同一张表，用 kind 区分。
 *
 * 形状：
 *   { id, kind: 'task'|'todo', title, url?, categories?, durationMs?,
 *     accumulatedMs, status: 'todo'|'running'|'done'|'pending',
 *     source: 'ai'|'me', createdAt }
 * 待办（kind='todo'）不带链接与分类。
 *
 * 状态流转：待确认 → 待办 → 计时中 → 已完成，可回退。
 *   pending → todo → running → done，每一步都能退回上一档。
 *
 * 没有删除能力给模型：工具面只给「列出 / 批量添加 / 标记完成」。
 * 面板里访客可以删自己写的条目（不可撤销），AI 排的条目不提供删除。
 *
 * 存储键 ai-assistant.tasks。
 */
(function () {
    'use strict';

    var AI = window.AIAssistant = window.AIAssistant || {};

    var STORAGE_KEY = 'ai-assistant.tasks';

    var items = [];
    var subscribers = [];

    /* 允许的状态迁移：向后一档可进，向前可回 */
    var ALLOWED = {
        pending: ['todo', 'done'],
        todo: ['pending', 'running', 'done'],
        running: ['todo', 'done'],
        done: ['running', 'todo']
    };

    /* ------------------------------------------------------------ 基础 */

    function yyyymmdd(ts) {
        var d = new Date(ts === undefined ? Date.now() : ts);
        var m = String(d.getMonth() + 1);
        var day = String(d.getDate());
        if (m.length < 2) m = '0' + m;
        if (day.length < 2) day = '0' + day;
        return String(d.getFullYear()) + m + day;
    }

    /* 标题转标识片段：中文与字母数字留下，其余换成短横 */
    function slugify(title) {
        var raw = String(title || '').trim().toLowerCase();
        var slug = raw.replace(/[^\w\u4e00-\u9fa5]+/g, '-').replace(/^-+|-+$/g, '');
        if (!slug) slug = 'item';
        if (slug.length > 12) slug = slug.slice(0, 12);
        return slug;
    }

    function now() {
        return Date.now();
    }

    /* ------------------------------------------------------------ 存储 */

    function normalize(raw) {
        if (!raw || typeof raw !== 'object') return null;
        var title = String(raw.title || '').trim();
        if (!title) return null;
        var kind = raw.kind === 'todo' ? 'todo' : 'task';
        var status = ['pending', 'todo', 'running', 'done'].indexOf(raw.status) >= 0 ? raw.status : 'todo';
        var item = {
            id: typeof raw.id === 'string' && raw.id ? raw.id : '',
            kind: kind,
            title: title,
            accumulatedMs: typeof raw.accumulatedMs === 'number' && isFinite(raw.accumulatedMs) && raw.accumulatedMs > 0
                ? Math.floor(raw.accumulatedMs)
                : 0,
            status: status,
            source: raw.source === 'ai' ? 'ai' : 'me',
            createdAt: typeof raw.createdAt === 'number' && isFinite(raw.createdAt) ? raw.createdAt : now()
        };
        /* 待办不带链接与分类 */
        if (kind === 'task') {
            if (typeof raw.url === 'string' && raw.url) item.url = raw.url;
            if (Array.isArray(raw.categories)) item.categories = raw.categories.slice();
            if (typeof raw.durationMs === 'number' && isFinite(raw.durationMs) && raw.durationMs > 0) {
                item.durationMs = Math.floor(raw.durationMs);
            }
        }
        if (!item.id) item.id = makeId(item);
        return item;
    }

    function readStorage() {
        try {
            var raw = window.localStorage.getItem(STORAGE_KEY);
            if (!raw) return [];
            var parsed = JSON.parse(raw);
            if (!Array.isArray(parsed)) return [];
            var list = [];
            for (var i = 0; i < parsed.length; i++) {
                var item = normalize(parsed[i]);
                if (item) list.push(item);
            }
            return list;
        } catch (e) {
            /* 存储不可用或 JSON 坏掉：按空清单处理，不抛给页面 */
            return [];
        }
    }

    function writeStorage() {
        try {
            window.localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
        } catch (e) {
            /* 配额满或隐私模式：清单继续留在内存里 */
        }
    }

    /* ------------------------------------------------------------ 标识 */

    function idTaken(id) {
        for (var i = 0; i < items.length; i++) {
            if (items[i].id === id) return true;
        }
        return false;
    }

    function makeId(item) {
        var stamp = yyyymmdd(item.createdAt);
        var base;
        if (item.kind === 'todo') {
            /* 待办按当天序号排：todo_<yyyymmdd>_<序号> */
            var seq = 1;
            base = 'todo_' + stamp + '_' + seq;
            while (idTaken(base)) {
                seq += 1;
                base = 'todo_' + stamp + '_' + seq;
            }
            return base;
        }
        /* 任务按标题片段：task_<slug>_<yyyymmdd> */
        base = 'task_' + slugify(item.title) + '_' + stamp;
        var suffix = 2;
        while (idTaken(base)) {
            base = 'task_' + slugify(item.title) + '_' + stamp + '-' + suffix;
            suffix += 1;
        }
        return base;
    }

    /* ------------------------------------------------------------ 读写 */

    function sortList(list) {
        var rank = { pending: 0, running: 1, todo: 2, done: 3 };
        return list.slice().sort(function (a, b) {
            var ra = rank[a.status] === undefined ? 9 : rank[a.status];
            var rb = rank[b.status] === undefined ? 9 : rank[b.status];
            if (ra !== rb) return ra - rb;
            return b.createdAt - a.createdAt;
        });
    }

    function list(filter) {
        var f = filter || {};
        var out = [];
        for (var i = 0; i < items.length; i++) {
            var item = items[i];
            if (f.kind && item.kind !== f.kind) continue;
            if (f.status && item.status !== f.status) continue;
            if (f.source && item.source !== f.source) continue;
            out.push(item);
        }
        return sortList(out);
    }

    function get(id) {
        for (var i = 0; i < items.length; i++) {
            if (items[i].id === id) return items[i];
        }
        return null;
    }

    function emit() {
        for (var i = 0; i < subscribers.length; i++) {
            try {
                subscribers[i](list());
            } catch (e) {
                /* 单个订阅者画错不该拖垮清单 */
            }
        }
    }

    function commit() {
        writeStorage();
        emit();
    }

    /*
     * 添加一条。kind 缺省按「待办」处理，source 缺省按「我写的」处理：
     * 模型加进来的阅读任务会显式给 kind='task' 与 source='ai'。
     */
    function add(raw) {
        var input = raw || {};
        var item = normalize({
            kind: input.kind === 'task' ? 'task' : 'todo',
            title: input.title,
            url: input.url,
            categories: input.categories,
            durationMs: input.durationMs,
            status: input.status,
            source: input.source,
            createdAt: input.createdAt === undefined ? now() : input.createdAt
        });
        if (!item) return null;
        item.id = makeId(item);
        items.push(item);
        commit();
        return item;
    }

    /* 批量添加：逐条独立成功，一条不合格不影响别的 */
    function addMany(rawItems, source) {
        var out = [];
        var ids = [];
        var input = Array.isArray(rawItems) ? rawItems : [];
        for (var i = 0; i < input.length; i++) {
            var row = input[i] || {};
            var item = add({
                /* 工具加的默认是阅读任务（kind 默认 task），显式给 todo 才是待办 */
                kind: row.kind === 'todo' ? 'todo' : 'task',
                title: row.title,
                url: row.url,
                categories: row.categories,
                durationMs: row.durationMs,
                status: row.status,
                source: source || row.source
            });
            if (item) {
                out.push(item);
                ids.push(item.id);
            }
        }
        return { added: out.length, ids: ids };
    }

    function setStatus(id, status) {
        var item = get(id);
        if (!item) return null;
        if (item.status === status) return item;
        var allowed = ALLOWED[item.status] || [];
        if (allowed.indexOf(status) < 0) return null;
        item.status = status;
        commit();
        return item;
    }

    /* 标记完成 / 撤销完成：done 可回到 todo；标完成时若正在计时先把时长折进条目 */
    function complete(id, done) {
        var item = get(id);
        if (!item) return null;
        if (done && runningId === id) endTiming(id);
        /* 撤销只对已完成有意义：没完成的条目传 false 是空操作，不推进状态 */
        if (!done && item.status !== 'done') return item;
        if (item.status === 'done' && !done) {
            item.status = 'todo';
            commit();
            return item;
        }
        return setStatus(id, 'done');
    }

    /* ------------------------------------------------------------ 计时 */

    /* 计时真相在 55-timer.js；这里只记「哪一条在计时」与已跑时长 */
    var runningSince = {};
    var runningId = null;

    function beginTiming(id) {
        var item = get(id);
        if (!item) return null;
        if (item.status === 'done') return null;
        if (runningId && runningId !== id) endTiming(runningId);
        runningId = id;
        runningSince[id] = now();
        if (item.status !== 'running') return setStatus(id, 'running');
        return item;
    }

    function endTiming(id) {
        var item = get(id);
        if (!item) return null;
        var since = runningSince[id];
        if (since) {
            var delta = now() - since;
            if (delta > 0) item.accumulatedMs += delta;
            delete runningSince[id];
        }
        if (runningId === id) runningId = null;
        if (item.status === 'running') return setStatus(id, 'todo');
        return item;
    }

    function elapsedOf(item, at) {
        if (!item) return 0;
        var base = item.accumulatedMs || 0;
        var since = runningSince[item.id];
        if (!since) return base;
        var current = at === undefined ? now() : at;
        var delta = current - since;
        return base + (delta > 0 ? delta : 0);
    }

    /* ------------------------------------------------------------ 删除 */

    /*
     * 删除只给访客自己写的条目，且只在面板里用；模型没有对应工具。
     * AI 排的条目一律不删（source === 'ai' 直接拒绝）。
     */
    function remove(id) {
        for (var i = 0; i < items.length; i++) {
            if (items[i].id !== id) continue;
            if (items[i].source === 'ai') return null;
            items.splice(i, 1);
            delete runningSince[id];
            if (runningId === id) runningId = null;
            commit();
            return true;
        }
        return null;
    }

    /* ------------------------------------------------------------ 订阅 */

    function subscribe(fn) {
        if (typeof fn !== 'function') return function () {};
        subscribers.push(fn);
        return function () {
            for (var i = 0; i < subscribers.length; i++) {
                if (subscribers[i] === fn) {
                    subscribers.splice(i, 1);
                    return;
                }
            }
        };
    }

    // 跨标签页：清单是全量列表，读到新值直接换掉
    if (window.addEventListener) {
        window.addEventListener('storage', function (event) {
            if (event.key !== STORAGE_KEY && event.key !== null) return;
            items = readStorage();
            emit();
        });
    }

    items = readStorage();

    AI.tasks = {
        STORAGE_KEY: STORAGE_KEY,
        list: list,
        get: get,
        add: add,
        addMany: addMany,
        setStatus: setStatus,
        complete: complete,
        beginTiming: beginTiming,
        endTiming: endTiming,
        elapsedOf: elapsedOf,
        remove: remove,
        subscribe: subscribe,
        makeId: makeId,
        yyyymmdd: yyyymmdd
    };
})();
