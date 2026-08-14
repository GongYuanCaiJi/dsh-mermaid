/**
 * dsh-mermaid 客户端插件：浏览器半边。
 *
 * 在 conversation.chat.turnTail 槽挂一个渲染区，把 host 端
 * （lib/index.js 的 /dsh-mermaid/api 路由）为该 turn 渲染好的
 * Mermaid SVG 图显示在会话流里。
 *
 * - 数据源：host 在 session/event（user/message、assistant/message）里
 *   拦截 ```mermaid 围栏，渲染 SVG 后按 (session, turn) 存起来；本组件
 *   用 sessionId + turn 号从同源路由拉取；
 * - 显示：每个结果一张 SVG 图（data URI <img>，避免内联 SVG 的脚本面），
 *   带源码折叠（<details>）与 parser 警告/错误行；
 * - 无结果 / 未渲染时渲染 null，不占位。
 * 全部 UI 文案走 locale 服务（dsh-mermaid 命名空间，zh/en 双语）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-mermaid',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require('react');
    var createElement = React.createElement;

    var NS = 'dsh-mermaid';
    var ROUTE = '/dsh-mermaid/api';

    var ZH = {
      'mermaid.label': 'Mermaid 图',
      'mermaid.source': '查看源码',
      'mermaid.hideSource': '收起源码',
      'mermaid.loadFailed': '加载 Mermaid 图失败',
      'mermaid.renderFailed': '渲染失败',
      'mermaid.block': 'Mermaid 图（第 %d 块）',
    };
    var EN = {
      'mermaid.label': 'Mermaid',
      'mermaid.source': 'Show source',
      'mermaid.hideSource': 'Hide source',
      'mermaid.loadFailed': 'Failed to load Mermaid diagram',
      'mermaid.renderFailed': 'Render failed',
      'mermaid.block': 'Mermaid diagram (block %d)',
    };

    var CSS = [
      '.dsh_mermaid_root{margin:8px 0 4px;display:flex;flex-direction:column;gap:8px}',
      '.dsh_mermaid_block{border:1px solid var(--dsw-alias-border-l2,#e5e5e5);border-radius:10px;overflow:hidden;background:var(--dsw-alias-bg-base,#fff)}',
      '.dsh_mermaid_label{padding:6px 12px;font-size:12px;font-weight:600;color:var(--dsw-alias-text-tertiary,#8a8a8e);border-bottom:1px solid var(--dsw-alias-border-l1,#f0f0f0)}',
      '.dsh_mermaid_canvas{padding:12px;overflow-x:auto}',
      '.dsh_mermaid_canvas img{max-width:100%;height:auto;display:block}',
      '.dsh_mermaid_issues{padding:6px 12px;font-size:12px;color:var(--dsw-alias-text-danger,#d4380d);border-top:1px solid var(--dsw-alias-border-l1,#f0f0f0);white-space:pre-wrap}',
      '.dsh_mermaid_source summary{cursor:pointer;padding:6px 12px;font-size:12px;color:var(--dsw-alias-text-secondary,#555)}',
      '.dsh_mermaid_source pre{margin:0;padding:8px 12px;font-size:12px;line-height:1.5;white-space:pre;overflow-x:auto;background:var(--dsw-alias-bg-subtle,#f7f7f8)}',
      '.dsh_mermaid_error{padding:12px;font-size:13px;color:var(--dsw-alias-text-danger,#d4380d)}',
    ].join('');

    function injectCss() {
      if (document.getElementById('dsh-mermaid-style')) return;
      var style = document.createElement('style');
      style.id = 'dsh-mermaid-style';
      style.textContent = CSS;
      document.head.appendChild(style);
    }

    function svgDataUri(svg) {
      var encoded = encodeURIComponent(svg)
        .replace(/'/g, '%27')
        .replace(/"/g, '%22');
      return 'data:image/svg+xml;charset=utf-8,' + encoded;
    }

    /**
     * Turn-tail 渲染组件。props 由槽系统注入：
     *   turn: TurnLocation（含 turn 编号与 step 数据）
     *   seq / openFile: TurnTailOwnerProps 其余成员
     *   sessionId: SessionStandardProps（框架注入）
     *   t: locale 绑定函数
     */
    function MermaidTail(props) {
      var turnNo = props.turn && typeof props.turn === 'object' ? props.turn.turn : props.turn;
      var sessionId = props.sessionId;
      var t = props.t || function (key) { return key; };
      var useState = React.useState;
      var useEffect = React.useEffect;

      var state = useState(null);
      var results = state[0];
      var setResults = state[1];

      useEffect(function () {
        var cancelled = false;
        setResults(null);
        if (!sessionId || turnNo === undefined) return undefined;
        fetch(ROUTE, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session: sessionId, turn: turnNo }),
        })
          .then(function (res) { return res.json(); })
          .then(function (body) {
            if (!cancelled && body && body.ok === true && Array.isArray(body.value)) {
              setResults(body.value);
            } else if (!cancelled) {
              setResults([]);
            }
          })
          .catch(function () {
            if (!cancelled) setResults([]);
          });
        return function () { cancelled = true; };
      }, [sessionId, turnNo]);

      if (results === null) return null;
      if (results.length === 0) return null;

      var children = results.map(function (item, index) {
        var blocks = [];
        blocks.push(createElement(
          'div', { className: 'dsh_mermaid_label', key: 'label' },
          t('mermaid.block').replace('%d', String(index + 1)),
        ));
        if (item.svg) {
          blocks.push(createElement(
            'div', { className: 'dsh_mermaid_canvas', key: 'canvas' },
            createElement('img', { src: svgDataUri(item.svg), alt: 'Mermaid diagram' }),
          ));
        } else {
          blocks.push(createElement(
            'div', { className: 'dsh_mermaid_error', key: 'error' },
            t('mermaid.renderFailed'),
          ));
        }
        if (item.issues && item.issues.length > 0) {
          blocks.push(createElement(
            'div', { className: 'dsh_mermaid_issues', key: 'issues' },
            item.issues.map(function (issue) { return issue.message; }).join('\n'),
          ));
        }
        if (item.source) {
          blocks.push(createElement(
            'details', { className: 'dsh_mermaid_source', key: 'source' },
            createElement('summary', null, t('mermaid.source')),
            createElement('pre', null, item.source),
          ));
        }
        return createElement('div', { className: 'dsh_mermaid_block', key: item.hash || index }, blocks);
      });

      return createElement('div', { className: 'dsh_mermaid_root' }, children);
    }

    var inject = ['slots', 'locale'];

    function apply(ctx) {
      injectCss();
      ctx.effect(function () {
        var offZh = ctx.locale.register(NS, 'zh', ZH);
        var offEn = ctx.locale.register(NS, 'en', EN);
        return function () { offZh(); offEn(); };
      }, 'dsh-mermaid: locale dictionaries');

      ctx.slots.inject('conversation.chat.turnTail', function () {
        return ctx.slots.register({
          name: 'conversation.chat.turnTail',
          select: function (owner) { return owner; },
          id: 'mermaid',
          order: 90,
          locale: NS,
          inject: function () { return {}; },
        }, MermaidTail);
      });
    }

    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  },
});
