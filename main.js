// 会话总览（session-overview）—— CC GUI 插件 v0.1.0
// 跨工作区统一查看会话状态：需确认 / 进行中 / 未查看 / 已完成，点击直达对话。
// 双入口：右侧面板（窄栏双行卡）+ 中央页签（宽视图）；宿主事件钩子探针用于后续接一手状态。
// 单文件 ESM，禁止任何 import；组件用 ctx.react.createElement 构建。

export default function activate(ctx) {
  const { createElement: h, useState, useEffect, useMemo } = ctx.react;

  // ---------- 常量 ----------
  const POLL_MS = 5000;          // 轮询间隔
  const RUN_WINDOW_S = 20;       // 转录 mtime 在该窗口内 = 进行中
  const CONFIRM_WINDOW_S = 60;   // 悬空 tool_use 静默超过该窗口 = 需确认
  const DEAD_WINDOW_S = 900;     // 尾条是 user 但静默超过该窗口 = 视为中断（回落已完成）
  const LOOKBACK_DAYS = 7;       // 「7天」视图的回看窗口
  const EXEC_TIMEOUT_MS = 15000;

  // ---------- 已读状态 ----------
  const keyOf = (s) => s.engine + "|" + s.sessionId;
  let viewedAt = new Map(); // key -> 时间戳；updatedAt > 该值 = 未查看
  let vmin = 0;             // viewedAt 的最小正值；updatedAt <= vmin 的必然已读
  let seeded = false;
  let saveTimer = null;

  function recomputeVmin() {
    let m = Infinity;
    viewedAt.forEach((v) => { if (typeof v === "number" && v > 0 && v < m) m = v; });
    vmin = m === Infinity ? 0 : m;
  }

  function persistViewed() {
    recomputeVmin();
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      const obj = {};
      viewedAt.forEach((v, k) => { obj[k] = v; });
      void ctx.storage.set("viewedAt", obj).catch(() => {});
    }, 400);
  }

  function markViewed(key, ts) {
    viewedAt.set(key, ts || Date.now());
    persistViewed();
    store.set({ vv: (store.get().vv || 0) + 1 }); // 让 React 感知已读状态变化
  }

  // ---------- 简单 store ----------
  const store = (() => {
    let state = { loading: true, error: null, dbMissing: false, sessions: [], lastUpdate: 0, vv: 0 };
    const subs = new Set();
    return {
      get: () => state,
      subscribe(f) { subs.add(f); return () => { subs.delete(f); }; },
      set(patch) { state = Object.assign({}, state, patch); subs.forEach((f) => f()); },
    };
  })();

  function useStore() {
    const [, force] = useState(0);
    useEffect(() => store.subscribe(() => force((x) => x + 1)), []);
    return store.get();
  }

  // ---------- 钩子探针 ----------
  // SDK 0.3.20 提供了 registerSessionHooks / registerTurnHooks，但回调形状无文档。
  // 传入 Proxy，宿主注册时读取哪些键名会被记录下来（写进 storage 并在面板「诊断」区展示），
  // 摸清形状后即可在下一版用宿主事件做一手状态信号。
  const probe = { reads: [], calls: [], errors: [], ok: [] };
  let probeTimer = null;

  function persistProbe() {
    if (probeTimer) clearTimeout(probeTimer);
    probeTimer = setTimeout(() => {
      probeTimer = null;
      void ctx.storage.set("probe", {
        v: ctx.version, // 版本标记：升级后丢弃旧探针数据，避免残留错误误导
        reads: probe.reads.slice(0, 100),
        calls: probe.calls.slice(-12),
        errors: probe.errors.slice(0, 10),
        ok: probe.ok.slice(0, 10),
      }).catch(() => {});
    }, 800);
  }

  function makeProbeProxy(label) {
    return new Proxy({}, {
      get(_t, prop) {
        if (typeof prop !== "string") return undefined;
        const name = label + "." + prop;
        if (probe.reads.indexOf(name) < 0 && probe.reads.length < 100) {
          probe.reads.push(name);
          persistProbe();
        }
        return function () {
          const args = Array.prototype.map.call(arguments, (a) => {
            try {
              const j = JSON.stringify(a);
              if (j === undefined) return "undefined";
              return j.length > 1200 ? j.slice(0, 1200) + "…" : j;
            } catch (e) { return String(a); }
          });
          probe.calls.push(name + "(" + args.join(", ") + ")");
          if (probe.calls.length > 12) probe.calls.shift();
          persistProbe();
        };
      },
      has() { return true; },
      ownKeys() { return []; },
    });
  }

  function tryHook(name, label) {
    try {
      const hs = ctx.hooks;
      if (hs && typeof hs[name] === "function") {
        hs[name](makeProbeProxy(label));
        probe.ok.push(name + " ✓");
      } else {
        probe.errors.push(name + ": 宿主未提供该方法");
      }
    } catch (e) {
      probe.errors.push(name + ": " + String((e && e.message) || e));
    }
    persistProbe();
  }

  // ---------- 内嵌 python 扫描脚本 ----------
  // 只读宿主 app.db 的 sessions 表做目录；状态推导：
  //   mtime 新鲜 -> 进行中；悬空 tool_use -> 需确认（静默久）；
  //   尾条是 user/tool_result -> 引擎必然在生成 -> 进行中（Claude 确定性信号）。
  const PY = [
    "import sqlite3, os, sys, json, time",
    "RUN = float(sys.argv[1]) if len(sys.argv) > 1 else 20.0",
    "CONFIRM = float(sys.argv[2]) if len(sys.argv) > 2 else 60.0",
    "DEAD = float(sys.argv[3]) if len(sys.argv) > 3 else 900.0",
    "DAYS = float(sys.argv[4]) if len(sys.argv) > 4 else 7.0",
    "VMIN = float(sys.argv[5]) if len(sys.argv) > 5 else 0.0",
    "HORIZON = 48.0 * 3600.0",
    "home = os.path.expanduser('~')",
    "db = os.path.join(home, '.ccgui-next', 'app.db')",
    "if not os.path.exists(db):",
    "    print(json.dumps({'db': False, 'sessions': []}))",
    "    raise SystemExit",
    "con = sqlite3.connect('file:%s?mode=ro' % db, uri=True, timeout=2.0)",
    "now_ms = time.time() * 1000.0",
    "cutoff_days = (time.time() - DAYS * 86400.0) * 1000.0 if DAYS > 0 else 0",
    "sql = ('SELECT s.engine, s.session_id, s.workspace_path, s.title, s.preview, '",
    "       's.updated_at, s.message_count, s.file_path, s.file_mtime_ms '",
    "       'FROM sessions s WHERE s.message_count > 0 AND NOT EXISTS '",
    "       '(SELECT 1 FROM session_archives a WHERE a.engine=s.engine AND a.session_id=s.session_id)')",
    "sql += ' AND (COALESCE(s.updated_at, s.file_mtime_ms, 0) >= ? OR COALESCE(s.updated_at, s.file_mtime_ms, 0) >= ?)'",
    "sql += ' ORDER BY COALESCE(s.updated_at, s.file_mtime_ms, 0) DESC LIMIT 300'",
    "try:",
    "    rows = con.execute(sql, (cutoff_days, VMIN)).fetchall()",
    "finally:",
    "    con.close()",
    "def analyze_tail(path):",
    "    pend = False; last_user = False; q = ''; a = ''",
    "    try:",
    "        size = os.path.getsize(path)",
    "        with open(path, 'rb') as f:",
    "            if size > 98304: f.seek(-98304, 2)",
    "            data = f.read().decode('utf-8', 'replace')",
    "        lines = data.split('\\n')",
    "        if size > 98304 and lines: lines = lines[1:]",
    "        for line in lines:",
    "            line = line.strip()",
    "            if not line: continue",
    "            try: d = json.loads(line)",
    "            except Exception: continue",
    "            t = d.get('type')",
    "            if t == 'assistant':",
    "                last_user = False",
    "                content = (d.get('message') or {}).get('content')",
    "                if isinstance(content, list):",
    "                    for c in content:",
    "                        if not isinstance(c, dict): continue",
    "                        if c.get('type') == 'tool_use' and c.get('id'):",
    "                            pend = True",
    "                        elif c.get('type') == 'text' and c.get('text'):",
    "                            txt = ' '.join(str(c['text']).split())",
    "                            if txt and not txt.startswith('<'): a = txt[:200]",
    "            elif t == 'user':",
    "                last_user = True",
    "                content = (d.get('message') or {}).get('content')",
    "                if isinstance(content, str):",
    "                    txt = ' '.join(content.split())",
    "                    if txt and not txt.startswith('<'): q = txt[:200]",
    "                elif isinstance(content, list):",
    "                    for c in content:",
    "                        if isinstance(c, dict) and c.get('type') == 'tool_result':",
    "                            pend = False",
    "                        elif isinstance(c, dict) and c.get('type') == 'text' and c.get('text'):",
    "                            txt = ' '.join(str(c['text']).split())",
    "                            if txt and not txt.startswith('<'): q = txt[:200]",
    "            elif t == 'response_item':",
    "                p = d.get('payload') or {}",
    "                if p.get('type') == 'message':",
    "                    role = p.get('role')",
    "                    for c in (p.get('content') or []):",
    "                        if isinstance(c, dict) and c.get('text'):",
    "                            txt = ' '.join(str(c['text']).split())",
    "                            if txt and not txt.startswith('<'):",
    "                                if role == 'assistant': a = txt[:200]",
    "                                elif role == 'user': q = txt[:200]",
    "    except Exception:",
    "        pass",
    "    return pend, last_user, q, a",
    "out = []",
    "live_max = 0; db_max = 0",
    "for engine, sid, ws, title, preview, updated_at, mc, fp, mtime in rows:",
    "    db_mtime = mtime or updated_at or 0",
    "    if db_mtime > db_max: db_max = db_mtime",
    "    live_ms = 0",
    "    if fp and os.path.exists(fp):",
    "        try: live_ms = int(os.path.getmtime(fp) * 1000)",
    "        except Exception: live_ms = 0",
    "    if live_ms > live_max: live_max = live_ms",
    "    mtime = max(db_mtime, live_ms)  # 宿主快照可能落后（仅重聚焦时重扫），状态以转录文件实时 mtime 为准",
    "    age = (now_ms - mtime) / 1000.0",
    "    pend = False; last_user = False; q = ''; a = ''",
    "    if fp and engine in ('claude', 'codex') and age <= HORIZON and os.path.exists(fp):",
    "        pend, last_user, q, a = analyze_tail(fp)",
    "    if age <= RUN:",
    "        status = 'running'",
    "    elif pend:",
    "        status = 'confirm' if age > CONFIRM else 'running'",
    "    elif last_user and age <= DEAD:",
    "        status = 'running'",
    "    else:",
    "        status = 'idle'",
    "    t = title or preview or ''",
    "    t = ' '.join(t.split())[:80] or '(无标题)'",
    "    out.append({'engine': engine, 'sessionId': sid, 'workspacePath': ws or '',",
    "                'title': t, 'updatedAt': mtime, 'messageCount': mc, 'status': status,",
    "                'q': q, 'a': a})",
    "print(json.dumps({'db': True, 'liveMax': live_max, 'dbMax': db_max, 'sessions': out}, separators=(',', ':')))",
  ].join("\n");

  // ---------- 轮询扫描 ----------
  let timer = null;
  let inFlight = false;
  let disposed = false;
  let lastHostRefresh = 0;

  async function poll() {
    if (inFlight || disposed) return;
    inFlight = true;
    try {
      const r = await ctx.bridge.invoke("plugin_exec_run", {
        bin: "python3",
        args: ["-c", PY, String(RUN_WINDOW_S), String(CONFIRM_WINDOW_S),
               String(DEAD_WINDOW_S), String(LOOKBACK_DAYS), String(vmin)],
        timeoutMs: EXEC_TIMEOUT_MS,
      });
      if (disposed) return;
      if (r && r.code === 0) {
        let data;
        try {
          data = JSON.parse(r.stdout);
        } catch (pe) {
          store.set({ loading: false, error: "扫描输出解析失败（" + String((pe && pe.message) || pe) + "）" });
          return;
        }
        const sessions = Array.isArray(data.sessions) ? data.sessions : [];
        if (!seeded) {
          // 首次安装：把存量会话全部标记为已读，避免一打开全是"未查看"
          seeded = true;
          const seed = {};
          sessions.forEach((s) => { seed[keyOf(s)] = s.updatedAt || 0; });
          viewedAt = new Map(Object.entries(seed));
          void ctx.storage.set("viewedAt", Object.fromEntries(viewedAt)).catch(() => {});
          void ctx.storage.set("seeded", true).catch(() => {});
          recomputeVmin();
        }
        store.set({ loading: false, error: null, dbMissing: data.db === false, sessions, lastUpdate: Date.now() });
        // 宿主快照落后（转录文件比 DB 记录新 ≥5s）时礼貌触发宿主重扫，
        // 让标题/预览也跟上；限频 45s，重活交给宿主的 SCAN_RUNNING 去重。
        if (!disposed && data.liveMax && data.liveMax > (data.dbMax || 0) + 5000
            && Date.now() - lastHostRefresh > 45000) {
          lastHostRefresh = Date.now();
          void ctx.sessions.refresh().catch(() => {});
        }
      } else {
        const err = ((r && r.stderr) || "扫描失败").toString().slice(0, 300);
        store.set({ loading: false, error: err });
      }
    } catch (e) {
      if (!disposed) store.set({ loading: false, error: String((e && e.message) || e) });
    } finally {
      inFlight = false;
    }
  }

  // full=true 时连宿主会话目录一起刷新（标题/新增会话），再扫转录状态
  function refresh(full) {
    if (full && !disposed) {
      lastHostRefresh = Date.now();
      void ctx.sessions.refresh().catch(() => {});
    }
    void poll();
  }

  // ---------- 状态推导与公共逻辑 ----------
  const STATUS_ORDER = { confirm: 0, running: 1, unviewed: 2, idle: 3 };

  function displayStatus(s) {
    if (s.status === "running") return "running";
    if (s.status === "confirm") return "confirm";
    return (s.updatedAt || 0) > (viewedAt.get(keyOf(s)) || 0) ? "unviewed" : "idle";
  }

  function sortByUrgency(list) {
    return list.slice().sort((a, b) =>
      STATUS_ORDER[a.st] - STATUS_ORDER[b.st] || (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  function relTime(ts) {
    if (!ts) return "";
    const diff = Math.max(0, Date.now() - ts) / 1000;
    if (diff < 60) return "刚刚";
    if (diff < 3600) return Math.floor(diff / 60) + " 分钟前";
    if (diff < 86400) return Math.floor(diff / 3600) + " 小时前";
    return Math.floor(diff / 86400) + " 天前";
  }

  function baseName(p) {
    if (!p) return "(未知工作区)";
    const parts = p.replace(/[\\/]+$/, "").split(/[\\/]/);
    return parts[parts.length - 1] || p;
  }

  function openSession(s) {
    markViewed(keyOf(s));
    ctx.sessions
      .selectSession(s.engine, s.sessionId, s.workspacePath)
      .catch((e) => store.set({ error: "打开会话失败: " + String((e && e.message) || e) }));
  }

  function markAllViewed(list) {
    const now = Date.now();
    list.forEach((s) => viewedAt.set(keyOf(s), now));
    persistViewed();
  }

  /** 视图过滤：attention = 需确认+进行中+未查看；recent = 近 7 天；all = 全部 */
  function applyView(list, view) {
    if (view === "attention") return list.filter((s) => s.st !== "idle");
    if (view === "recent") {
      const cutoff = Date.now() - LOOKBACK_DAYS * 86400000;
      return list.filter((s) => (s.updatedAt || 0) >= cutoff);
    }
    return list;
  }

  // ---------- 图标 ----------
  function Icon({ className }) {
    return h("svg", {
      className: className,
      viewBox: "0 0 16 16", width: 14, height: 14, fill: "none",
      stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round",
    },
      h("rect", { x: 1.5, y: 2.5, width: 13, height: 11, rx: 2 }),
      h("path", { d: "M4.5 6.5H9M4.5 9.5H11.5" }),
      h("circle", { cx: 12, cy: 5.4, r: 1.5, fill: "currentColor", stroke: "none" }));
  }

  function QIcon() {
    return h("svg", {
      viewBox: "0 0 16 16", width: 10, height: 10, fill: "none",
      stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round", strokeLinejoin: "round",
    },
      h("path", { d: "M13.5 8a5.5 5.5 0 1 1-2.2-4.4L13.5 3l-.4 2.6c.25.74.4 1.55.4 2.4Z" }));
  }

  function AIcon() {
    return h("svg", {
      viewBox: "0 0 16 16", width: 10, height: 10, fill: "none",
      stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round", strokeLinejoin: "round",
    },
      h("path", { d: "M13 4v3a2 2 0 0 1-2 2H3.5" }),
      h("path", { d: "M6.5 12.5 3.5 9.5l3-3" }));
  }

  function SearchIcon() {
    return h("svg", {
      viewBox: "0 0 16 16", width: 13, height: 13, fill: "none",
      stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round",
    },
      h("circle", { cx: 7, cy: 7, r: 4.2 }),
      h("path", { d: "M10.2 10.2 L13.5 13.5" }));
  }

  function RefreshIcon() {
    return h("svg", {
      viewBox: "0 0 16 16", width: 13, height: 13, fill: "none",
      stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round", strokeLinejoin: "round",
    },
      h("path", { d: "M13.2 8a5.2 5.2 0 1 1-1.5-3.7" }),
      h("path", { d: "M13.4 2.6v3h-3" }));
  }

  // ---------- 右侧面板（窄栏双行卡） ----------
  function PanelOverview() {
    const st = useStore();
    const [view, setView] = useState("attention");
    const [searchOpen, setSearchOpen] = useState(false);
    const [query, setQuery] = useState("");

    const cards = useMemo(() => {
      const withSt = st.sessions.map((s) => Object.assign({}, s, { st: displayStatus(s) }));
      let list = sortByUrgency(applyView(withSt, view));
      const q = query.trim().toLowerCase();
      if (q) list = list.filter((s) =>
        (s.title || "").toLowerCase().includes(q) || (s.workspacePath || "").toLowerCase().includes(q));
      return list;
    }, [st.sessions, st.vv, view, query]); // eslint-disable-line

    const attentionCount = useMemo(() => {
      let n = 0;
      st.sessions.forEach((s) => { if (displayStatus(s) !== "idle") n += 1; });
      return n;
    }, [st.sessions, st.vv]);

    return h("div", { className: "sov-root sov-panel" },
      h("div", { className: "sov-ptool" },
        h("div", { className: "sov-seg" },
          h("button", {
            className: "sov-segbtn" + (view === "attention" ? " is-active" : ""),
            onClick: () => setView("attention"),
          }, "关注 " + attentionCount),
          h("button", {
            className: "sov-segbtn" + (view === "recent" ? " is-active" : ""),
            onClick: () => setView("recent"),
          }, "7天")),
        h("button", {
          className: "sov-iconbtn" + (searchOpen ? " is-active" : ""),
          title: "搜索",
          onClick: () => { setSearchOpen(!searchOpen); if (searchOpen) setQuery(""); },
        }, h(SearchIcon, null)),
        h("button", {
          className: "sov-iconbtn", title: "立即刷新（每 5 秒自动刷新，并同步宿主会话目录）",
          onClick: () => refresh(true),
        }, h(RefreshIcon, null))),
      searchOpen
        ? h("input", {
            className: "sov-search", type: "search", autoFocus: true,
            placeholder: "标题或工作区…", value: query,
            onChange: (e) => setQuery(e.target.value),
          })
        : null,
      st.error ? h("div", { className: "sov-err" }, "⚠ " + st.error) : null,
      st.loading && cards.length === 0
        ? h("div", { className: "sov-empty" }, "正在扫描…") : null,
      !st.loading && !st.dbMissing && cards.length === 0
        ? h("div", { className: "sov-empty" },
            view === "attention" ? "没有需要关注的会话 ✓" : "没有匹配的会话。")
        : null,
      h("div", { className: "sov-cards" },
        cards.map((s) =>
          h("div", {
            key: keyOf(s),
            className: "sov-card sov-st-" + s.st,
            title: s.title + "\n" + s.workspacePath,
            onClick: () => openSession(s),
          },
            h("div", { className: "sov-card-top" },
              h("span", { className: "sov-dot" }),
              h("span", { className: "sov-card-title" + (s.st === "unviewed" ? " is-unread" : "") }, s.title),
              s.st === "confirm" ? h("span", { className: "sov-confirm-text" }, "需确认") : null,
              (s.st === "unviewed" || s.st === "confirm")
                ? h("button", {
                    className: "sov-readbtn", title: "标为已读",
                    onClick: (e) => { e.stopPropagation(); markViewed(keyOf(s)); },
                  }, "✓")
                : null),
            s.q ? h("div", { className: "sov-card-qa", title: s.q }, h(QIcon, null), s.q) : null,
            (s.a && s.st !== "running") ? h("div", { className: "sov-card-qa sov-qa-ans", title: s.a }, h(AIcon, null), s.a) : null,
            h("div", { className: "sov-card-sub" },
              h("span", { className: "sov-card-ws", title: s.workspacePath }, baseName(s.workspacePath)),
              h("span", null, s.engine),
              h("span", null, relTime(s.updatedAt)))))));
  }

  // ---------- 中央页签（宽视图） ----------
  function CenterOverview() {
    const st = useStore();
    const [view, setView] = useState("attention");
    const [query, setQuery] = useState("");
    const [collapsed, setCollapsed] = useState(() => new Set());

    const rows = useMemo(() => {
      const withSt = st.sessions.map((s) => Object.assign({}, s, { st: displayStatus(s) }));
      let list = sortByUrgency(applyView(withSt, view));
      const q = query.trim().toLowerCase();
      if (q) list = list.filter((s) =>
        (s.title || "").toLowerCase().includes(q) || (s.workspacePath || "").toLowerCase().includes(q));
      return list;
    }, [st.sessions, st.vv, view, query]); // eslint-disable-line

    const counts = useMemo(() => {
      const c = { attention: 0, recent: 0, all: 0, confirm: 0, running: 0, unviewed: 0 };
      const cutoff = Date.now() - LOOKBACK_DAYS * 86400000;
      st.sessions.forEach((s) => {
        const k = displayStatus(s);
        c.all += 1;
        if (k !== "idle") c.attention += 1;
        if ((s.updatedAt || 0) >= cutoff) c.recent += 1;
        if (k in c) c[k] += 1;
      });
      return c;
    }, [st.sessions, st.vv]);

    const groups = useMemo(() => {
      const m = new Map();
      rows.forEach((s) => {
        if (!m.has(s.workspacePath)) m.set(s.workspacePath, []);
        m.get(s.workspacePath).push(s);
      });
      return Array.from(m.entries());
    }, [rows]);

    function toggleGroup(ws) {
      setCollapsed((prev) => {
        const next = new Set(prev);
        if (next.has(ws)) next.delete(ws); else next.add(ws);
        return next;
      });
    }

    const VIEW_LABEL = { attention: "关注", recent: "7天", all: "全部" };

    return h("div", { className: "sov-root" },
      h("div", { className: "sov-toolbar" },
        h("div", { className: "sov-seg" },
          ["attention", "recent", "all"].map((v) =>
            h("button", {
              key: v,
              className: "sov-segbtn" + (view === v ? " is-active" : ""),
              onClick: () => setView(v),
            }, VIEW_LABEL[v] + " " + counts[v]))),
        counts.confirm + counts.running > 0
          ? h("span", { className: "sov-live" },
              counts.running + " 运行" + (counts.confirm ? " · " + counts.confirm + " 需确认" : ""))
          : null,
        h("input", {
          className: "sov-search", type: "search",
          placeholder: "搜索标题或工作区…", value: query,
          onChange: (e) => setQuery(e.target.value),
        }),
        h("button", {
          className: "sov-segbtn", title: "把当前列表全部标为已读",
          onClick: () => markAllViewed(rows),
        }, "全部已读"),
        h("button", { className: "sov-segbtn", title: "立即刷新（并同步宿主会话目录）", onClick: () => refresh(true) }, "刷新")),
      st.error ? h("div", { className: "sov-err" }, "⚠ " + st.error) : null,
      st.loading && st.sessions.length === 0
        ? h("div", { className: "sov-empty" }, "正在扫描会话目录…") : null,
      !st.loading && st.dbMissing
        ? h("div", { className: "sov-empty" }, "未找到宿主会话目录（app.db），请确认 CC GUI 已在本机登录使用过。") : null,
      !st.loading && !st.dbMissing && rows.length === 0
        ? h("div", { className: "sov-empty" },
            view === "attention" ? "没有需要关注的会话 ✓" : "没有匹配的会话。") : null,
      groups.map(([ws, list]) => {
        const isCollapsed = collapsed.has(ws);
        return h("div", { className: "sov-group", key: ws || "unknown" },
          h("div", { className: "sov-group-h", title: ws, onClick: () => toggleGroup(ws) },
            h("span", { className: "sov-caret" }, isCollapsed ? "▸" : "▾"),
            h("span", { className: "sov-group-name" }, baseName(ws)),
            h("span", { className: "sov-group-count" }, list.length + " 个会话")),
          !isCollapsed && list.map((s) =>
            h("div", {
              key: keyOf(s),
              className: "sov-row sov-st-" + s.st,
              title: s.title + "\n" + s.workspacePath,
              onClick: () => openSession(s),
            },
              h("div", { className: "sov-row-main" },
                h("span", { className: "sov-dot" }),
                h("span", { className: "sov-row-title" + (s.st === "unviewed" ? " is-unread" : "") }, s.title),
                s.st === "confirm" ? h("span", { className: "sov-confirm-text" }, "需确认") : null,
                h("span", { className: "sov-ws", title: s.workspacePath }, baseName(s.workspacePath)),
                h("span", { className: "sov-badge" }, s.engine),
                h("span", { className: "sov-meta" }, relTime(s.updatedAt))),
              s.q ? h("div", { className: "sov-row-qa", title: s.q }, h(QIcon, null), s.q) : null,
              (s.a && s.st !== "running") ? h("div", { className: "sov-row-qa sov-qa-ans", title: s.a }, h(AIcon, null), s.a) : null)));
      }),
      h("details", { className: "sov-diag" },
        h("summary", null, "诊断信息"),
        h("div", { className: "sov-diag-body" },
          h("div", null, "host " + ctx.host.appVersion + " · sdk " + ctx.host.sdkVersion + " · 插件 " + ctx.version),
          h("div", null, "钩子注册：" + (probe.ok.length ? probe.ok.join("、") : "（无）")),
          h("div", null, "钩子键名读取：" + (probe.reads.length ? probe.reads.join(", ") : "（尚未捕获，重启应用后再看）")),
          probe.calls.length
            ? probe.calls.slice(-6).map((c, i) => h("div", { key: i }, c))
            : h("div", null, "（暂无事件——跑一轮对话后再回来看）"),
          probe.errors.map((e, i) => h("div", { key: "e" + i, className: "sov-err" }, e)))));
  }

  // ---------- 状态栏 chip ----------
  function StatusChip() {
    const st = useStore();
    let confirm = 0, running = 0, unviewed = 0;
    st.sessions.forEach((s) => {
      const k = displayStatus(s);
      if (k === "confirm") confirm += 1;
      else if (k === "running") running += 1;
      else if (k === "unviewed") unviewed += 1;
    });
    return h("button", {
      className: "sov-statusbar-chip",
      title: "会话总览" + (st.lastUpdate ? "（更新于 " + relTime(st.lastUpdate) + "）" : ""),
      onClick: () => ctx.ui.openCenterTab("overview"),
    },
      h(Icon, null),
      confirm + running + unviewed > 0
        ? h("span", { className: "sov-chip-parts" },
            confirm ? h("span", { className: "sov-chip-confirm", key: "c" }, confirm + " 确认") : null,
            running ? h("span", { className: "sov-chip-running", key: "r" }, running + " 运行") : null,
            unviewed ? h("span", { className: "sov-chip-unviewed", key: "u" }, unviewed + " 未看") : null)
        : h("span", null, "会话"));
  }

  // ---------- 注册扩展点 ----------
  ctx.ui.registerPanelTab({ key: "overview", label: () => "会话总览", icon: Icon, component: PanelOverview });
  ctx.ui.registerCenterTab({ key: "overview", title: () => "会话总览", icon: Icon, component: CenterOverview });
  ctx.ui.registerSidebarNav({
    key: "overview", label: () => "会话总览", icon: Icon, order: 50,
    onOpen: () => ctx.ui.openCenterTab("overview"),
  });
  ctx.ui.registerStatusBarItem({ key: "chip", component: StatusChip, order: 50, zone: "end" });
  ctx.ui.registerCommand({
    key: "open-overview", title: () => "打开会话总览",
    keywords: () => ["会话", "状态", "session", "overview"],
    run: () => ctx.ui.openCenterTab("overview"),
  });

  const cssDisposer = ctx.theme.injectCss(CSS);

  // ---------- 钩子探针注册（失败不影响功能） ----------
  tryHook("registerSessionHooks", "session");
  tryHook("registerTurnHooks", "turn");
  tryHook("registerRuntimeSwitchHooks", "switch");

  // ---------- 启动 ----------
  void (async () => {
    try {
      const v = await ctx.storage.get("viewedAt");
      if (!disposed && v && typeof v === "object") viewedAt = new Map(Object.entries(v));
      const s = await ctx.storage.get("seeded");
      if (!disposed && s) seeded = true;
      const p = await ctx.storage.get("probe");
      if (!disposed && p && typeof p === "object" && p.v === ctx.version) {
        if (Array.isArray(p.reads)) probe.reads = p.reads;
        if (Array.isArray(p.calls)) probe.calls = p.calls;
        if (Array.isArray(p.errors)) probe.errors = p.errors;
        if (Array.isArray(p.ok)) probe.ok = p.ok;
      }
      recomputeVmin();
    } catch (e) { /* 存储不可用时按未读处理 */ }
    refresh();
  })();

  timer = setInterval(refresh, POLL_MS);

  // 卸载清理
  return function deactivate() {
    disposed = true;
    if (timer) clearInterval(timer);
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    if (probeTimer) { clearTimeout(probeTimer); probeTimer = null; }
    void cssDisposer; // 宿主按注册逆序自动回收，这里仅兜底引用
  };
}

// ---------- 样式（自包含；宿主语义 token + 回退值，深浅色自动适配） ----------
const CSS = `
.sov-root { display:flex; flex-direction:column; gap:6px; padding:10px 12px; height:100%; overflow-y:auto; box-sizing:border-box; font-size:12.5px; }
.sov-panel { padding:8px 8px; }

/* 工具栏 */
.sov-toolbar { display:flex; align-items:center; gap:6px; flex-wrap:wrap; position:sticky; top:0; z-index:2; background:var(--color-background-primary-default, inherit); padding-bottom:4px; }
.sov-ptool { display:flex; align-items:center; gap:6px; }
.sov-seg { display:inline-flex; border:1px solid var(--color-border-button-default, rgba(128,128,128,.3)); border-radius:7px; overflow:hidden; }
.sov-segbtn { border:none; background:transparent; color:var(--color-text-secondary, #888); padding:2.5px 10px; font-size:12px; cursor:pointer; line-height:1.5; }
.sov-segbtn + .sov-segbtn { border-left:1px solid var(--color-border-button-default, rgba(128,128,128,.25)); }
.sov-segbtn:hover { background:var(--color-background-primary-hover, rgba(128,128,128,.1)); color:var(--color-text-primary, inherit); }
.sov-segbtn.is-active { background:var(--color-background-secondary-default, rgba(128,128,128,.14)); color:var(--color-text-primary, inherit); font-weight:600; }
.sov-live { font-size:11.5px; color:var(--color-status-streaming, #2f80ed); }
.sov-iconbtn { border:none; background:transparent; color:var(--color-text-secondary, #888); cursor:pointer; padding:3px 6px; border-radius:6px; display:inline-flex; }
.sov-iconbtn:hover, .sov-iconbtn.is-active { background:var(--color-background-primary-hover, rgba(128,128,128,.1)); color:var(--color-text-primary, inherit); }
.sov-search { flex:none; width:100%; box-sizing:border-box; border:1px solid var(--color-border-button-default, rgba(128,128,128,.3)); border-radius:7px; background:transparent; color:inherit; padding:3px 8px; font-size:12px; outline:none; }
.sov-toolbar .sov-search { flex:1 1 120px; width:auto; }
.sov-search:focus { border-color:var(--color-accent-500, #3b82f6); }

/* 状态点（克制档：形状差异优先于颜色数量） */
.sov-dot { width:7px; height:7px; border-radius:50%; flex:none; background:var(--color-text-tertiary, rgba(128,128,128,.5)); }
.sov-st-running .sov-dot { background:var(--color-status-streaming, #2f80ed); animation:sov-pulse 1.6s infinite; }
.sov-st-confirm .sov-dot { background:var(--color-text-warning-primary, #b45309); }
.sov-st-unviewed .sov-dot { background:var(--color-status-unseen, #22c55e); }
@keyframes sov-pulse { 0% { box-shadow:0 0 0 0 rgba(47,128,237,.4);} 70% { box-shadow:0 0 0 5px rgba(47,128,237,0);} 100% { box-shadow:0 0 0 0 rgba(47,128,237,0);} }
.sov-confirm-text { flex:none; font-size:11px; color:var(--color-text-warning-primary, #b45309); }

/* 右侧面板：双行紧凑卡 */
.sov-cards { display:flex; flex-direction:column; gap:3px; }
.sov-card { display:flex; flex-direction:column; gap:2px; padding:7px 9px; border-radius:8px; cursor:pointer; }
.sov-card:hover { background:var(--color-background-primary-hover, rgba(128,128,128,.1)); }
.sov-card-top { display:flex; align-items:center; gap:7px; min-width:0; }
.sov-card-title { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:500; }
.sov-card-title.is-unread { font-weight:700; }
.sov-card-sub { display:flex; align-items:center; gap:8px; padding-left:14px; font-size:11px; color:var(--color-text-tertiary, #999); }
.sov-card-qa, .sov-row-qa {
  position:relative; padding-left:20px; font-size:11px; line-height:1.5;
  color:var(--color-text-secondary, #aaa);
  display:-webkit-box; -webkit-box-orient:vertical; -webkit-line-clamp:2; overflow:hidden;
}
.sov-card-qa svg, .sov-row-qa svg { position:absolute; left:2px; top:3px; opacity:.7; }
.sov-qa-ans { color:var(--color-text-tertiary, #999); }
.sov-card-ws { max-width:45%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.sov-readbtn { flex:none; border:none; background:transparent; color:var(--color-text-tertiary, #999); cursor:pointer; font-size:11px; padding:0 3px; border-radius:4px; opacity:0; }
.sov-card:hover .sov-readbtn { opacity:1; }
.sov-readbtn:hover { color:var(--color-status-unseen, #22c55e); background:var(--color-background-secondary-default, rgba(128,128,128,.14)); }

/* 中央页签：分组宽列表 */
.sov-group { display:flex; flex-direction:column; }
.sov-group-h { display:flex; align-items:center; gap:6px; padding:6px 2px 3px; cursor:pointer; user-select:none; color:var(--color-text-tertiary, #999); font-weight:600; font-size:12px; }
.sov-caret { width:10px; display:inline-block; }
.sov-group-name { color:var(--color-text-primary, inherit); }
.sov-group-count { font-weight:400; font-size:11px; }
.sov-row { display:flex; flex-direction:column; gap:2px; padding:5px 8px; border-radius:7px; cursor:pointer; }
.sov-row:hover { background:var(--color-background-primary-hover, rgba(128,128,128,.1)); }
.sov-row-main { display:flex; align-items:center; gap:8px; min-width:0; }
.sov-row-qa { padding-left:20px; }
.sov-row-title { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:500; }
.sov-row-title.is-unread { font-weight:700; }
.sov-ws { flex:none; max-width:120px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:11px; color:var(--color-text-tertiary, #999); direction:rtl; text-align:left; }
.sov-badge { flex:none; font-size:10px; border:1px solid var(--color-border-button-default, rgba(128,128,128,.3)); border-radius:4px; padding:0 4px; color:var(--color-text-tertiary, #999); }
.sov-meta { flex:none; font-size:11px; color:var(--color-text-tertiary, #999); }

/* 空态 / 错误 / 诊断 */
.sov-empty, .sov-err { padding:12px 4px; color:var(--color-text-secondary, #888); }
.sov-err { color:var(--color-text-danger-primary, #dc2626); font-size:12px; }
.sov-diag { margin-top:14px; color:var(--color-text-tertiary, #999); font-size:11px; }
.sov-diag summary { cursor:pointer; user-select:none; }
.sov-diag-body { padding:6px 2px; display:flex; flex-direction:column; gap:3px; word-break:break-all; }

/* 状态栏 chip */
.sov-statusbar-chip { display:inline-flex; align-items:center; gap:5px; border:none; background:transparent; color:var(--color-text-secondary, #888); font-size:11.5px; cursor:pointer; padding:2px 6px; border-radius:6px; }
.sov-statusbar-chip:hover { background:var(--color-background-primary-hover, rgba(128,128,128,.1)); color:var(--color-text-primary, inherit); }
.sov-chip-parts { display:inline-flex; gap:6px; }
.sov-chip-confirm { color:var(--color-text-warning-primary, #b45309); font-weight:600; }
.sov-chip-running { color:var(--color-status-streaming, #2f80ed); font-weight:600; }
.sov-chip-unviewed { color:var(--color-status-unseen, #22c55e); font-weight:600; }
`;
