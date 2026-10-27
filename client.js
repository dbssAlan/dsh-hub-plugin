/**
 * dsh-hub-plugin —— 浏览器半：「设置 → 远程访问」页。
 *
 * v0.3：通过宿主同源路由 /dsh-hub/* 读写配置（无 CORS、无跨端口依赖）。
 * 保存后宿主会重启反代子进程，无需重启 DSH。
 */
window.__ModuleLoader__.load({
  id: 'dsh-hub-plugin',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useCallback } = React;

    const muted = { color: 'var(--dsw-alias-label-tertiary,#8b93a1)', fontSize: 12, lineHeight: 1.7 };
    const label = { fontSize: 12, color: 'var(--dsw-alias-label-secondary,#5b6472)', marginBottom: 4, display: 'block' };
    const input = {
      width: '100%',
      boxSizing: 'border-box',
      background: 'var(--dsw-alias-bg-layer-1,#fff)',
      color: 'inherit',
      border: '1px solid var(--dsw-alias-border-l2,#d1d5db)',
      borderRadius: 8,
      padding: '8px 10px',
      fontSize: 13,
    };
    const primary = {
      font: 'inherit',
      cursor: 'pointer',
      border: 'none',
      background: 'var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary,#4f6ef7))',
      color: 'var(--dsw-alias-label-primary-foreground,#fff)',
      height: 34,
      padding: '0 16px',
      borderRadius: 999,
      fontSize: 13,
    };
    const ghost = {
      font: 'inherit',
      cursor: 'pointer',
      border: '1px solid var(--dsw-alias-border-l2,#d1d5db)',
      background: 'transparent',
      color: 'inherit',
      height: 34,
      padding: '0 14px',
      borderRadius: 999,
      fontSize: 13,
    };

    function Row({ children }) {
      return h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 } }, children);
    }
    function Field({ title, hint, children }) {
      return h('div', null,
        h('label', { style: label }, title),
        children,
        hint ? h('div', { style: { ...muted, marginTop: 4 } }, hint) : null);
    }

    function HubSettings() {
      const [cfg, setCfg] = useState(null);
      const [status, setStatus] = useState(null);
      const [sessions, setSessions] = useState([]);
      const [audit, setAudit] = useState([]);
      const [password, setPassword] = useState('');
      const [error, setError] = useState('');
      const [notice, setNotice] = useState('');
      const [busy, setBusy] = useState(false);

      const load = useCallback(async () => {
        setError('');
        try {
          const [c, s] = await Promise.all([
            fetch('/dsh-hub/config', { cache: 'no-store' }).then((r) => {
              if (!r.ok) throw new Error(`/dsh-hub/config ${r.status}`);
              return r.json();
            }),
            fetch('/dsh-hub/status', { cache: 'no-store' }).then((r) => {
              if (!r.ok) throw new Error(`/dsh-hub/status ${r.status}`);
              return r.json();
            }),
          ]);
          setCfg(c);
          setStatus(s);
          fetch('/dsh-hub/sessions', { cache: 'no-store' })
            .then((r) => (r.ok ? r.json() : { sessions: [] }))
            .then((j) => setSessions(j.sessions ?? []))
            .catch(() => {});
          fetch('/dsh-hub/audit', { cache: 'no-store' })
            .then((r) => (r.ok ? r.json() : { entries: [] }))
            .then((j) => setAudit(j.entries ?? []))
            .catch(() => {});
        } catch (e) {
          setError(`连不上宿主管理路由：${e.message}。请确认插件已启用，并重启过桌面版。`);
        }
      }, []);

      const revokeSession = async (id) => {
        try {
          await fetch('/dsh-hub/sessions/revoke', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id }),
          });
          await load();
        } catch {}
      };
      const revokeAll = async () => {
        try {
          await fetch('/dsh-hub/sessions/revoke-all', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          });
          await load();
        } catch {}
      };

      useEffect(() => { load(); }, []);

      const patch = (k, v) => setCfg((prev) => ({ ...prev, [k]: v }));

      const save = async () => {
        setError('');
        setNotice('');
        setBusy(true);
        try {
          const body = {
            enabled: !!cfg.enabled,
            listenPort: Number(cfg.listenPort) || 19388,
            tunnel: cfg.tunnel,
            publicUrl: cfg.publicUrl || '',
            targetPort: Number(cfg.targetPort) || 0,
          };
          if (password) body.password = password;
          if (cfg._newToken) body.tunnelToken = cfg._newToken;
          const r = await fetch('/dsh-hub/config', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-dsh-hub': '1' },
            body: JSON.stringify(body),
          });
          const j = await r.json();
          if (!r.ok || !j.ok) throw new Error(j.error || `HTTP ${r.status}`);
          setNotice('已保存，反代正在按新配置重启…');
          setPassword('');
          // 子进程重启需要 1-3 秒，轮询直到状态恢复
          for (let i = 0; i < 20; i += 1) {
            await new Promise((r) => setTimeout(r, 500));
            try {
              const st = await fetch('/dsh-hub/status', { cache: 'no-store' });
              if (st.ok) { await load(); break; }
            } catch {}
            if (i === 19) setNotice('已保存；状态刷新超时，请点「刷新」。');
          }
        } catch (e) {
          setError(`保存失败：${e.message}`);
        } finally {
          setBusy(false);
        }
      };

      const copy = async (text) => {
        try { await navigator.clipboard.writeText(text); setNotice('已复制'); } catch { setNotice('复制失败，请手动选择'); }
      };

      if (!cfg) {
        return h('div', { style: { maxWidth: 560 } },
          h('h3', { style: { margin: '0 0 8px', fontSize: 15 } }, 'DSH Hub 远程访问'),
          error ? h('p', { style: { color: '#f87171', fontSize: 13 } }, error) : h('p', { style: muted }, '正在读取…'));
      }

      const pub = status?.publicUrl || '';
      const origin = typeof location !== 'undefined' ? location.origin : `http://127.0.0.1:${status?.listenPort || 19388}`;
      const devices = `${(pub || origin).replace(/\/$/, '')}/_devices`;

      return h('div', { style: { maxWidth: 620, padding: '4px 0' } },
        h('h3', { style: { margin: '0 0 4px', fontSize: 15 } }, 'DSH Hub 远程访问'),
        h('p', { style: { ...muted, margin: '0 0 14px' } },
          '把 DSH 发布到局域网/公网。手机打开地址后输入访问密码；URL 本身不含密码。'),

        h('div', {
          style: {
            display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderRadius: 10, marginBottom: 14,
            background: 'var(--dsw-alias-bg-layer-2,#f5f7fa)', border: '1px solid var(--dsw-alias-border-l2,#e5e7eb)', fontSize: 12,
          },
        },
          h('span', { style: { width: 8, height: 8, borderRadius: 99, background: status?.enabled ? '#22c55e' : '#9ca3af', display: 'inline-block' } }),
          h('span', null, status?.enabled ? '已启用' : '未启用'),
          h('span', { style: muted }, '·'),
          h('span', null, `隧道：${status?.tunnel || 'off'}`),
          h('span', { style: muted }, '·'),
          h('span', null, `端口：${status?.listenPort || cfg.listenPort}`),
          h('span', { style: { flex: 1 } }),
          h('button', { style: ghost, onClick: load }, '刷新')),

        pub
          ? h('div', { style: { marginBottom: 12 } },
              h('div', { style: label }, '公网地址'),
              h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
                h('code', { style: { ...input, padding: '6px 8px', wordBreak: 'break-all' } }, pub),
                h('button', { style: ghost, onClick: () => copy(pub) }, '复制')))
          : h('p', { style: { ...muted, marginBottom: 12 } }, '公网地址尚未就绪（快速隧道建立中，或模式为 off）。'),

        h('div', { style: { display: 'flex', gap: 16, alignItems: 'center', marginBottom: 16, flexWrap: 'wrap' } },
          h('img', {
            src: `/dsh-hub/qr?data=${encodeURIComponent(pub || origin)}`,
            width: 150, height: 150, alt: '扫码访问',
            style: { background: '#fff', padding: 6, borderRadius: 10 },
          }),
          h('div', { style: { fontSize: 12, lineHeight: 1.8, color: 'var(--dsw-alias-label-tertiary,#8b93a1)' } },
            h('div', null, '手机扫码直接打开当前地址'),
            h('div', null, '登录后浏览器菜单里可「添加到主屏幕」'))),

        h('div', { style: { borderTop: '1px solid var(--dsw-alias-border-l2,#e5e7eb)', paddingTop: 14, marginBottom: 14 } },
          h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 } },
            h('div', { style: { ...label, marginBottom: 0 } }, '设备会话'),
            h('button', { style: ghost, onClick: revokeAll }, '撤销全部')),
          sessions.length
            ? h('div', { style: { fontSize: 12 } },
                sessions.map((s) => h('div', {
                  key: s.fullId || s.id,
                  style: { display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0', borderBottom: '1px solid var(--dsw-alias-border-l3,#eee)' },
                },
                  h('span', { style: { minWidth: 110 } }, s.name),
                  h('span', { style: { ...muted, flex: 1 } }, s.ip || '-'),
                  h('span', { style: { ...muted, minWidth: 140 } }, s.revokedAt ? '已撤销' : new Date(s.lastSeenAt).toLocaleString()),
                  h('button', { style: ghost, onClick: () => revokeSession(s.fullId || s.id) }, '撤销'))))
            : h('p', { style: muted }, '暂无活跃会话'),

          h('div', { style: { ...label, marginTop: 12 } }, '最近登录审计'),
          audit.length
            ? h('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary,#8b93a1)', maxHeight: 120, overflow: 'auto' } },
                audit.slice(0, 10).map((e, i) => h('div', { key: i, style: { padding: '2px 0' } },
                  `${new Date(e.at).toLocaleString()} · ${e.event}${e.name ? ` · ${e.name}` : ''}${e.ip ? ` · ${e.ip}` : ''}`)))
            : null),

        h('div', { style: { marginBottom: 16, display: 'flex', gap: 10, flexWrap: 'wrap' } },
          h('a', { href: devices, target: '_blank', rel: 'noreferrer', style: { ...primary, textDecoration: 'none', display: 'inline-flex', alignItems: 'center' } }, '打开设备导航页'),
          h('a', { href: pub || origin, target: '_blank', rel: 'noreferrer', style: { ...ghost, textDecoration: 'none', display: 'inline-flex', alignItems: 'center' } }, '打开登录页')),

        h('div', { style: { borderTop: '1px solid var(--dsw-alias-border-l2,#e5e7eb)', paddingTop: 14 } },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 } },
            h('input', { type: 'checkbox', checked: !!cfg.enabled, onChange: (e) => patch('enabled', e.target.checked) }),
            h('span', { style: { fontSize: 13 } }, '启用远程访问')),

          h(Row, null,
            h(Field, { title: '本机端口', hint: '默认 19388；保存后自动重启' },
              h('input', { style: input, type: 'number', value: cfg.listenPort ?? 19388, onChange: (e) => patch('listenPort', e.target.value) })),
            h(Field, { title: '隧道模式', hint: 'off / quick / named' },
              h('select', { style: input, value: cfg.tunnel ?? 'quick', onChange: (e) => patch('tunnel', e.target.value) },
                h('option', { value: 'off' }, 'off（仅局域网）'),
                h('option', { value: 'quick' }, 'quick（免费随机域名）'),
                h('option', { value: 'named' }, 'named（固定域名）')))),

          h(Row, null,
            h(Field, { title: '访问密码', hint: cfg.passwordSet ? '已设置；留空表示不修改' : '至少 8 位' },
              h('input', { style: input, type: 'password', value: password, onChange: (e) => setPassword(e.target.value), placeholder: cfg.passwordSet ? '••••••••' : '设置访问密码' })),
            h(Field, { title: '目标宿主端口', hint: '0 = 自动（当前 DSH 宿主）' },
              h('input', { style: input, type: 'number', value: cfg.targetPort ?? 0, onChange: (e) => patch('targetPort', e.target.value) }))),

          cfg.tunnel === 'named'
            ? h(Row, null,
                h(Field, { title: '命名隧道 Token', hint: cfg.tunnelTokenSet ? '已设置；留空表示不修改' : 'Cloudflare Zero Trust → Tunnels' },
                  h('input', { style: input, type: 'password', value: cfg._newToken ?? '', onChange: (e) => patch('_newToken', e.target.value) })),
                h(Field, { title: '对外地址', hint: '如 https://dsh.example.com' },
                  h('input', { style: input, value: cfg.publicUrl ?? '', onChange: (e) => patch('publicUrl', e.target.value) })))
            : null,

          h('div', { style: { display: 'flex', gap: 10, marginTop: 8 } },
            h('button', { style: primary, disabled: busy, onClick: save }, busy ? '保存中…' : '保存并重启'),
            h('button', { style: ghost, disabled: busy, onClick: load }, '重新读取')),

          error ? h('p', { style: { color: '#f87171', fontSize: 12, marginTop: 10 } }, error) : null,
          notice ? h('p', { style: { color: '#16a34a', fontSize: 12, marginTop: 10 } }, notice) : null,

          h('p', { style: { ...muted, marginTop: 12 } },
            '配置保存在 %USERPROFILE%\\.dsh\\dsh-hub-plugin\\config.json；保存后宿主会自动重建反代，无需重启 DSH。')));
    }

    return {
      name: 'dsh-hub-plugin',
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            { name: 'settings.section', id: 'dsh-hub', order: 3, label: () => '远程访问', inject: () => ({}) },
            HubSettings,
          ),
        );
      },
    };
  },
});
