(function () {
    const vscode = acquireVsCodeApi();
    const resultsList = document.getElementById('resultsList');
    const hoverPreview = document.getElementById('hoverPreview');

    let allEntries = [];
    // 改为"点击触发预览":以前 hoverTimer/hoverRow 是 hover 触发的状态,
    // 现在 anchorRow 代表预览锚定的那一行 (用于定位计算),预览一直显示到被显式关闭。
    let anchorRow = null;
    let manualHighlights = [];
    const HIGHLIGHT_COLORS = [];
    let highlightBoxMode = true;
    let contextMenu = null;

    // Pagination state (M4.4): webview consumes totalCount/loadedCount from the
    // extension so the "scroll to bottom -> loadMore" loop knows when to stop.
    let loadingMore = false;
    let loadedCount = 0;
    let totalCount = 0;
    const paginationLabel = document.getElementById('pagination-label');

    function updatePaginationLabel() {
        if (!paginationLabel) { return; }
        if (totalCount <= 0) {
            paginationLabel.textContent = '';
        } else if (totalCount <= loadedCount) {
            paginationLabel.textContent = loadedCount + ' results';
        } else {
            paginationLabel.textContent = loadedCount + ' / ' + totalCount;
        }
    }

    // Scroll container is actually <body> (see media/results.css: body
    // has overflow-y:auto, #resultsList has no overflow). So 所有 scroll /
    // scrollTop / scrollHeight readings must go through the scrolling root,
    // not through #resultsList.
    const scrollRoot = document.scrollingElement || document.documentElement;

    // ── In-panel find (Ctrl+F) ────────────────────────────────────────
    // 查找作用于 allEntries(当前已加载的结果),不回后端、不跨页重算。
    // 命中记录为 entry 在 allEntries 里的下标数组 find.hits;find.activeHit 指向
    // 当前聚焦的那个下标。navigation 把 scrollRoot 滚动到 hitIndex*rowHeight,
    // 虚拟滚动会把该行渲染出来,createRow 里按 entry.globalIndex 决定加
    // find-hit / find-active 样式。
    //
    // 三个 toggle 与 VS Code 原生 find widget 语义一致:
    //   matchCase  — 区分大小写
    //   wholeWord  — 只匹配完整单词(\b 边界)
    //   regex      — 把 query 当 JavaScript 正则解释
    const find = {
        visible: false,
        query: '',
        matchCase: false,
        wholeWord: false,
        regex: false,
        hits: [],            // indices into allEntries
        hitSet: new Set(),   // same, for O(1) row lookup in createRow
        activeHit: -1,       // index into find.hits
        regexInvalid: false, // true when user's regex pattern has a syntax error
    };
    const findWidget = document.getElementById('find-widget');
    const findInput = document.getElementById('find-input');
    const findCount = document.getElementById('find-count');
    const findPrevBtn = document.getElementById('find-prev');
    const findNextBtn = document.getElementById('find-next');
    const findCaseBtn = document.getElementById('find-case');
    const findWordBtn = document.getElementById('find-word');
    const findRegexBtn = document.getElementById('find-regex');
    const findCloseBtn = document.getElementById('find-close');

    function escapeRegex(s) {
        return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    // Build a matcher function for the current find state. Returns null when
    // the query is empty or (regex mode) unparseable; caller treats null as
    // "no hits".
    function buildFindMatcher() {
        find.regexInvalid = false;
        if (!find.query) { return null; }
        let pattern;
        if (find.regex) {
            pattern = find.query;
        } else {
            pattern = escapeRegex(find.query);
            if (find.wholeWord) { pattern = '\\b' + pattern + '\\b'; }
        }
        // In non-regex mode without wholeWord, a literal substring check is
        // slightly cheaper than a RegExp. But the branch complexity isn't
        // worth it — 200-row scans are trivial either way.
        const flags = find.matchCase ? 'g' : 'gi';
        try {
            const re = new RegExp(pattern, flags);
            return (hay) => { re.lastIndex = 0; return re.test(hay); };
        } catch (e) {
            find.regexInvalid = true;
            return null;
        }
    }

    function matchEntry(entry, matcher) {
        // Search against lineContent + relativePath (the two columns the user
        // actually sees in each row).
        const hay = (entry.lineContent || '') + '\n' + (entry.relativePath || '');
        return matcher(hay);
    }

    function recomputeFindHits() {
        find.hits = [];
        find.hitSet = new Set();
        const matcher = buildFindMatcher();
        if (!matcher) {
            find.activeHit = -1;
            updateFindCount();
            return;
        }
        for (let i = 0; i < allEntries.length; i++) {
            if (matchEntry(allEntries[i], matcher)) {
                find.hits.push(i);
                find.hitSet.add(i);
            }
        }
        find.activeHit = find.hits.length > 0 ? 0 : -1;
        updateFindCount();
    }

    function updateFindCount() {
        if (!findCount) { return; }
        findCount.classList.remove('find-count-no-results');
        if (find.regexInvalid) {
            findCount.textContent = 'Invalid regex';
            findCount.classList.add('find-count-no-results');
        } else if (!find.query) {
            findCount.textContent = 'No results';
        } else if (find.hits.length === 0) {
            findCount.textContent = 'No results';
            findCount.classList.add('find-count-no-results');
        } else {
            findCount.textContent = (find.activeHit + 1) + ' of ' + find.hits.length;
        }
    }

    function scrollToActiveHit() {
        if (find.activeHit < 0 || find.activeHit >= find.hits.length) { return; }
        const entryIdx = find.hits[find.activeHit];
        const rowTop = entryIdx * VS.rowHeight;
        const viewportH = window.innerHeight || 600;
        // Keep the hit near the middle so surrounding context is visible.
        const target = Math.max(0, rowTop - Math.floor(viewportH / 2) + VS.rowHeight);
        window.scrollTo({ top: target, behavior: 'auto' });
        requestAnimationFrame(rerenderContent);
    }

    function navigateHit(delta) {
        if (find.hits.length === 0) { return; }
        find.activeHit = (find.activeHit + delta + find.hits.length) % find.hits.length;
        updateFindCount();
        scrollToActiveHit();
    }

    function toggleFindOption(key, button) {
        find[key] = !find[key];
        if (button) {
            button.setAttribute('aria-checked', find[key] ? 'true' : 'false');
            button.classList.toggle('active', find[key]);
        }
        recomputeFindHits();
        rerenderContent();
    }

    function showFindWidget() {
        if (!findWidget) { return; }
        find.visible = true;
        findWidget.hidden = false;
        // Pre-fill with selected text if any, else keep previous query.
        const sel = window.getSelection && window.getSelection().toString().trim();
        if (sel) {
            findInput.value = sel;
            find.query = sel;
            recomputeFindHits();
        }
        findInput.focus();
        findInput.select();
        rerenderContent();
    }

    function hideFindWidget() {
        if (!findWidget) { return; }
        find.visible = false;
        findWidget.hidden = true;
        // 清掉高亮,但保留 query/hits(再次 Ctrl+F 可继续)。
        rerenderContent();
    }

    if (findInput) {
        findInput.addEventListener('input', () => {
            find.query = findInput.value;
            recomputeFindHits();
            scrollToActiveHit();
        });
        findInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                navigateHit(e.shiftKey ? -1 : 1);
                return;
            }
            if (e.key === 'Escape') {
                e.preventDefault();
                hideFindWidget();
                return;
            }
            // Alt+C / Alt+W / Alt+R — toggle shortcuts for the three options,
            // matching VS Code's editor find widget.
            if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
                const k = e.key.toLowerCase();
                if (k === 'c') { e.preventDefault(); toggleFindOption('matchCase', findCaseBtn); return; }
                if (k === 'w') { e.preventDefault(); toggleFindOption('wholeWord', findWordBtn); return; }
                if (k === 'r') { e.preventDefault(); toggleFindOption('regex', findRegexBtn); return; }
            }
        });
    }
    if (findPrevBtn) { findPrevBtn.addEventListener('click', () => navigateHit(-1)); }
    if (findNextBtn) { findNextBtn.addEventListener('click', () => navigateHit(1)); }
    if (findCloseBtn) { findCloseBtn.addEventListener('click', hideFindWidget); }
    if (findCaseBtn) { findCaseBtn.addEventListener('click', () => toggleFindOption('matchCase', findCaseBtn)); }
    if (findWordBtn) { findWordBtn.addEventListener('click', () => toggleFindOption('wholeWord', findWordBtn)); }
    if (findRegexBtn) { findRegexBtn.addEventListener('click', () => toggleFindOption('regex', findRegexBtn)); }
    // Keyboard-activate toggles/buttons that are tabindex focusable (Space / Enter).
    [findCaseBtn, findWordBtn, findRegexBtn, findPrevBtn, findNextBtn, findCloseBtn].forEach((btn) => {
        if (!btn) { return; }
        btn.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                btn.click();
            }
        });
    });

    function maybeLoadMore() {
        if (loadingMore) { return; }
        if (totalCount <= 0 || loadedCount >= totalCount) { return; }
        const viewportBottom = scrollRoot.scrollTop + window.innerHeight;
        const viewportBottomRow = Math.ceil(viewportBottom / VS.rowHeight);
        const prefetchMargin = VS.overscan * 2;
        const shouldLoad = viewportBottomRow + prefetchMargin >= loadedCount;
        if (shouldLoad) {
            loadingMore = true;
            vscode.postMessage({ command: 'loadMore' });
        }
    }

    function hidePreview() {
        anchorRow = null;
        hoverPreview.style.display = 'none';
    }

    // Virtual scroll state
    const VS = {
        rowHeight: 28,
        overscan: 8,
    };

    // Scroll 发生在 body,不在 #resultsList — 监听 window/document 才对。
    // 保留原 resultsList scroll 监听(实际永远不 fire)作为降级,但主要逻辑
    // 通过 window scroll 驱动。
    window.addEventListener('scroll', () => {
        requestAnimationFrame(rerenderContent);
        requestAnimationFrame(maybeLoadMore);
    }, { passive: true });
    resultsList.addEventListener('scroll', () => {
        requestAnimationFrame(rerenderContent);
        // M4.4: piggyback on the same rAF-driven scroll handler so we don't
        // add a third listener (there's already a second one below for hiding
        // the preview). Keep both rAFs separate so cancellation is independent.
        requestAnimationFrame(maybeLoadMore);
    });

    window.addEventListener('message', (event) => {
        const msg = event.data;
        switch (msg.command) {
            case 'showResults':
                allEntries = msg.results;
                HIGHLIGHT_COLORS.length = 0;
                if (msg.highlightColors) { HIGHLIGHT_COLORS.push(...msg.highlightColors); }
                if (msg.highlightBox !== undefined) { highlightBoxMode = msg.highlightBox; }
                manualHighlights = [];
                loadedCount = (msg.loadedCount !== undefined && msg.loadedCount !== null)
                    ? msg.loadedCount : msg.results.length;
                totalCount = (msg.totalCount !== undefined && msg.totalCount !== null)
                    ? msg.totalCount : msg.results.length;
                loadingMore = false;
                // 真实的 scroll container 是 window/body,不是 #resultsList
                window.scrollTo(0, 0);
                updatePaginationLabel();
                // 新一轮搜索,清掉 find 状态(input 清空、关窗、hits 重置)。
                if (findInput) { findInput.value = ''; }
                find.query = '';
                find.hits = [];
                find.hitSet = new Set();
                find.activeHit = -1;
                hideFindWidget();
                rerenderContent();
                break;
            case 'appendResults':
                allEntries = allEntries.concat(msg.results);
                if (msg.loadedCount !== undefined && msg.loadedCount !== null) {
                    loadedCount = msg.loadedCount;
                } else {
                    loadedCount = allEntries.length;
                }
                if (msg.totalCount !== undefined && msg.totalCount !== null) {
                    totalCount = msg.totalCount;
                }
                loadingMore = false;
                updatePaginationLabel();
                // 有新 entries 并且 find 正开着 → 把新范围也扫一遍补进 hits。
                if (find.visible && find.query) {
                    recomputeFindHits();
                }
                rerenderContent();
                break;
            case 'highlightEntry':
                highlightNavEntry(msg.index);
                break;
            case 'previewData':
                showPreviewPopup(msg);
                break;
            case 'setHighlightColors':
                HIGHLIGHT_COLORS.length = 0;
                HIGHLIGHT_COLORS.push(...msg.colors);
                if (msg.box !== undefined) { highlightBoxMode = msg.box; }
                rerenderContent();
                break;
            case 'doHighlightSelection': {
                const sel = window.getSelection();
                const text = sel ? sel.toString().trim() : '';
                if (text) { toggleHighlight(text); }
                break;
            }
            case 'toggleHighlightText': {
                if (msg.text) { toggleHighlight(msg.text); }
                break;
            }
            case 'clearHighlights': {
                manualHighlights = [];
                rerenderContent();
                syncHighlightsToExtension();
                break;
            }
            case 'openFind': {
                // Extension-triggered Ctrl+F route (keybinding bound to
                // siSearch.findInResults when this panel has focus).
                showFindWidget();
                break;
            }
        }
    });

    function toggleHighlight(text) {
        const existingIndex = manualHighlights.findIndex(h => h.text === text);
        if (existingIndex >= 0) {
            manualHighlights.splice(existingIndex, 1);
        } else {
            manualHighlights.push({ text: text, colorIndex: manualHighlights.length });
        }
        rerenderContent();
        syncHighlightsToExtension();
    }

    function syncHighlightsToExtension() {
        vscode.postMessage({
            command: 'syncManualHighlights',
            highlights: manualHighlights.map(function (h) {
                var colorIdx = h.colorIndex % (HIGHLIGHT_COLORS.length || 1);
                return { text: h.text, color: HIGHLIGHT_COLORS[colorIdx] || '#FFEB3B' };
            }),
            boxMode: highlightBoxMode,
        });
    }

    function createRow(entry) {
        const row = document.createElement('div');
        row.className = 'result-line';
        row.dataset.index = String(entry.globalIndex);
        row.dataset.file = entry.filePath;
        row.dataset.line = String(entry.lineNumber);

        // Find 高亮:只在 find widget 可见时标记。activeHit 拿强调色,其余 hit 拿浅色。
        // entry.globalIndex 与 allEntries 下标同值(按顺序 append),find.hits 存的是
        // allEntries 下标,所以直接比较即可,不必 indexOf 扫数组。
        if (find.visible && find.hits.length > 0) {
            const entryPos = entry.globalIndex;
            const activeEntryIdx = find.activeHit >= 0 ? find.hits[find.activeHit] : -1;
            if (entryPos === activeEntryIdx) {
                row.classList.add('find-active');
            } else if (find.hitSet && find.hitSet.has(entryPos)) {
                row.classList.add('find-hit');
            }
        }

        const jumpBtn = document.createElement('span');
        jumpBtn.className = 'jump-btn';
        jumpBtn.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 1.5h5.5L13 5v9.5H4z"/><path d="M9.5 1.5V5H13"/><line x1="1" y1="8.5" x2="7" y2="8.5"/><polyline points="5 6.5 7 8.5 5 10.5"/></svg>';
        jumpBtn.title = 'Jump to source';
        jumpBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            hidePreview();
            vscode.postMessage({
                command: 'jumpToFile',
                filePath: entry.filePath,
                lineNumber: entry.lineNumber,
            });
        });

        const pathSpan = document.createElement('span');
        pathSpan.className = 'file-path';
        pathSpan.textContent = entry.relativePath;

        const lineSpan = document.createElement('span');
        lineSpan.className = 'line-num';
        lineSpan.textContent = '<Line ' + entry.lineNumber + '>:';

        const contentSpan = document.createElement('span');
        contentSpan.className = 'line-content';
        contentSpan.innerHTML = highlightContent(entry.lineContent);

        row.appendChild(jumpBtn);
        row.appendChild(pathSpan);
        row.appendChild(lineSpan);
        row.appendChild(contentSpan);

        // 点击代码部分 (左键) 触发预览;hover 不再触发 —— 以前 hover 会遮挡下方结果,
        // 用户滑动浏览时非常烦。改成显式点击后,预览会一直显示到 hidePreview() 被调用
        // (见下方全局 keydown / contextmenu / 滚动等监听器)。
        contentSpan.addEventListener('click', (e) => {
            // 左键 (button 0);不要拦截 Ctrl/Shift 这种选区扩展,让用户还能选择文本。
            if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey) { return; }
            // 如果用户其实在做文本选择 (按下-拖动-松开) 就别触发预览。
            const sel = window.getSelection();
            if (sel && sel.toString().length > 0) { return; }

            anchorRow = contentSpan;
            // 设置导航高亮 —— 方便之后 Alt+J 找到"当前结果"。
            const idx = Number(row.dataset.index);
            if (!Number.isNaN(idx)) {
                document.querySelectorAll('.result-line.nav-active').forEach(function (el) {
                    el.classList.remove('nav-active');
                });
                row.classList.add('nav-active');
            }

            vscode.postMessage({
                command: 'requestPreview',
                filePath: entry.filePath,
                lineNumber: entry.lineNumber,
            });
        });

        return row;
    }

    function rerenderContent() {
        const loaded = allEntries.length;
        // 滚动条总高度按 totalCount 算,未加载段保留为占位空白,避免
        // 用户看到"滚条到底但只有 200 条"的假象。loadedCount < totalCount
        // 时未加载段是 (totalCount - loadedCount) × rowHeight 的占位空白;
        // 滚动进该区间会触发 loadMore 追加真实行。
        const total = Math.max(totalCount, loaded);
        // scroll 发生在 body,通过 window/documentElement 读
        const scrollTop = scrollRoot.scrollTop;
        const viewportHeight = window.innerHeight || 600;
        const visibleCount = Math.ceil(viewportHeight / VS.rowHeight);

        const start = Math.max(0, Math.floor(scrollTop / VS.rowHeight) - VS.overscan);
        // 只渲染已加载区间;start 之后超过 loadedCount 的部分不渲染实行。
        const renderEnd = Math.min(loaded, start + visibleCount + VS.overscan * 2);

        const spacerTopPx = start * VS.rowHeight;
        // 底部 spacer 要覆盖"已渲染之后到全量底"的所有空间(占位 + 未加载)。
        const spacerBottomPx = Math.max(0, (total - renderEnd) * VS.rowHeight);

        const fragment = document.createDocumentFragment();

        const topSpacer = document.createElement('div');
        topSpacer.style.height = spacerTopPx + 'px';
        fragment.appendChild(topSpacer);

        for (let i = start; i < renderEnd; i++) {
            fragment.appendChild(createRow(allEntries[i]));
        }

        const bottomSpacer = document.createElement('div');
        bottomSpacer.style.height = spacerBottomPx + 'px';
        fragment.appendChild(bottomSpacer);

        resultsList.innerHTML = '';
        resultsList.appendChild(fragment);
    }

    function highlightContent(text) {
        let html = escapeHtml(text);

        for (let i = manualHighlights.length - 1; i >= 0; i--) {
            const h = manualHighlights[i];
            const colorIdx = h.colorIndex % (HIGHLIGHT_COLORS.length || 1);
            const color = HIGHLIGHT_COLORS[colorIdx] || '#FFEB3B';
            const escaped = escapeHtml(h.text);
            const regex = new RegExp(escapeRegex(escaped), 'gi');
            var style = highlightBoxMode
                ? 'border-color:' + color + ';background:inherit;color:inherit'
                : 'background:' + color + ';color:#1e1e1e;border-color:transparent';
            html = html.replace(regex, '<span class="manual-highlight" style="' + style + '">' + escaped + '</span>');
        }

        return html;
    }

    function escapeHtml(text) {
        return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function escapeRegex(str) {
        return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    // 对已有语法高亮 HTML 叠加手动高亮
    // 只替换 HTML 标签之外的文本部分，避免破坏 <span> 标签
    function applyManualHighlightsToHtml(html) {
        if (manualHighlights.length === 0) { return html; }

        for (let i = manualHighlights.length - 1; i >= 0; i--) {
            const h = manualHighlights[i];
            const colorIdx = h.colorIndex % (HIGHLIGHT_COLORS.length || 1);
            const color = HIGHLIGHT_COLORS[colorIdx] || '#FFEB3B';
            const escaped = escapeHtml(h.text);
            var style = highlightBoxMode
                ? 'border-color:' + color + ';background:inherit;color:inherit'
                : 'background:' + color + ';color:#1e1e1e;border-color:transparent';
            var wrapStart = '<span class="manual-highlight" style="' + style + '">';
            var wrapEnd = '</span>';

            // 分离 HTML 标签和文本节点
            // 只在文本节点中做替换
            var regex = new RegExp(escapeRegex(escaped), 'gi');
            html = html.replace(/(<[^>]*>)|([^<]+)/g, function (match, tag, text) {
                if (tag) { return tag; }
                return text.replace(regex, wrapStart + '$&' + wrapEnd);
            });
        }
        return html;
    }

    function highlightNavEntry(index) {
        // With virtual scrolling, first scroll so the target row enters the viewport,
        // then rerender, then find and highlight the DOM element.
        const targetScrollTop = Math.max(0, index * VS.rowHeight - window.innerHeight / 2);
        window.scrollTo(0, targetScrollTop);
        rerenderContent();

        document.querySelectorAll('.result-line.nav-active').forEach(function (el) {
            el.classList.remove('nav-active');
        });
        var row = document.querySelector('.result-line[data-index="' + index + '"]');
        if (row) {
            row.classList.add('nav-active');
        }
    }

    // 关闭预览的各种触发路径:
    //   - 任意键盘键 (最自然的"让它消失"的操作)
    //   - 右键 (用户原本就用右键做上下文菜单,点右键意味着"我不想看这个了")
    //   - 滚动搜索结果列表 (继续浏览意图)
    //   - 点击预览框之外的任何地方 (也可能是左键点击别处)
    document.addEventListener('keydown', (e) => {
        // Ctrl+F / Cmd+F:打开 in-panel find widget。webview 默认不提供原生 find,
        // 我们自己接管。焦点在 find input 里时让 input 自己处理 Enter/Esc。
        if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === 'f' || e.key === 'F')) {
            e.preventDefault();
            e.stopPropagation();
            showFindWidget();
            return;
        }
        // F3 / Shift+F3:在 find 可见时循环命中项,跟 VS Code 编辑器一致。
        if (find.visible && e.key === 'F3') {
            e.preventDefault();
            e.stopPropagation();
            navigateHit(e.shiftKey ? -1 : 1);
            return;
        }
        // Esc:关 find(但 input 内自己的 Esc 处理器先跑,这里是 document 级兜底)
        if (find.visible && e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            hideFindWidget();
            return;
        }
        // Alt+J:在搜索结果面板里跳到"当前选中行"对应的源代码位置。
        // 双向跳转的"来"方向:编辑器里按 Alt+J 跳到面板 (在 package.json 里绑的 editorTextFocus 时的快捷键);
        // 这里是"去"方向:面板里按 Alt+J 跳回编辑器。
        if (e.altKey && (e.key === 'j' || e.key === 'J')) {
            e.preventDefault();
            const active = document.querySelector('.result-line.nav-active');
            if (active) {
                const filePath = active.dataset.file;
                const lineNumber = Number(active.dataset.line);
                if (filePath && !Number.isNaN(lineNumber)) {
                    hidePreview();
                    vscode.postMessage({ command: 'jumpToFile', filePath, lineNumber });
                }
            }
            return;
        }
        // 其他任意按键:关预览。但如果焦点在 find input 里,不要关 — 用户
        // 在输框里打字跟"看预览"无关,关掉反而会让 preview 闪烁。
        if (hoverPreview.style.display !== 'none' && document.activeElement !== findInput) {
            hidePreview();
        }
    }, true); // capture 阶段,确保先于其他处理

    document.addEventListener('mousedown', (e) => {
        // 右键:关预览 (但 contextmenu 菜单的显示走的是 contextmenu 事件,下方已有处理)
        if (e.button === 2) { hidePreview(); return; }
        // 左键点击在预览框之外:关预览
        if (e.button === 0 && !hoverPreview.contains(e.target)) {
            // 不过,如果点的就是另一个 content-span (即要显示新预览),让它自己覆盖,别关旧的闪一下。
            // 判断方法:目标是否属于某个 .line-content。
            const isContent = e.target && e.target.closest && e.target.closest('.line-content');
            if (!isContent) { hidePreview(); }
        }
    }, true);

    resultsList.addEventListener('scroll', () => {
        // 滚动就关,避免遮挡下方结果 —— 这是用户反馈的核心诉求。
        hidePreview();
    });

    function showPreviewPopup(data) {
        hoverPreview.innerHTML = '';
        if (data.bg) {
            hoverPreview.style.background = data.bg;
        } else {
            hoverPreview.style.background = '';
        }
        var ts = data.tabSize || 8;
        hoverPreview.style.tabSize = ts;
        hoverPreview.style.MozTabSize = ts;
        let targetLineElement = null;
        for (var i = 0; i < data.lines.length; i++) {
            var line = data.lines[i];
            var div = document.createElement('div');
            div.className = 'preview-line' + (line.num === data.lineNumber ? ' current' : '');
            var numSpan = document.createElement('span');
            numSpan.className = 'preview-line-num';
            numSpan.textContent = String(line.num);
            div.appendChild(numSpan);
            if (line.html) {
                var codeSpan = document.createElement('span');
                codeSpan.className = 'preview-line-code';
                codeSpan.innerHTML = applyManualHighlightsToHtml(line.html);
                div.appendChild(codeSpan);
            } else {
                var codeSpan2 = document.createElement('span');
                codeSpan2.className = 'preview-line-code';
                codeSpan2.innerHTML = highlightContent(line.content);
                div.appendChild(codeSpan2);
            }
            hoverPreview.appendChild(div);
            if (line.num === data.lineNumber) {
                targetLineElement = div;
            }
        }

        hoverPreview.style.display = 'block';
        hoverPreview.style.maxHeight = '300px';
        hoverPreview.style.top = '0px';
        hoverPreview.style.left = '0px';

        var previewRect = hoverPreview.getBoundingClientRect();
        var viewH = window.innerHeight;
        var viewW = window.innerWidth;
        var top, left;

        if (anchorRow) {
            var rowRect = anchorRow.getBoundingClientRect();
            var spaceAbove = rowRect.top;
            var spaceBelow = viewH - rowRect.bottom;

            if (spaceAbove >= previewRect.height + 4) {
                // 上方空间足够，紧贴悬停行上方
                top = rowRect.top - previewRect.height - 4;
            } else if (spaceBelow >= previewRect.height + 4) {
                // 下方空间足够，紧贴悬停行下方
                top = rowRect.bottom + 4;
            } else if (spaceAbove > spaceBelow) {
                // 都不够，选大的一边，限制预览高度
                top = 4;
                hoverPreview.style.maxHeight = (spaceAbove - 8) + 'px';
            } else {
                top = rowRect.bottom + 4;
                hoverPreview.style.maxHeight = (spaceBelow - 8) + 'px';
            }
            left = rowRect.left;
        } else {
            top = viewH / 2 - previewRect.height / 2;
            left = viewW / 2 - previewRect.width / 2;
        }

        // 水平边界约束
        if (left + previewRect.width > viewW) { left = viewW - previewRect.width - 4; }
        if (left < 0) { left = 4; }

        hoverPreview.style.top = top + 'px';
        hoverPreview.style.left = left + 'px';

        // 滚动到目标行，使其居中显示
        if (targetLineElement) {
            setTimeout(() => {
                var containerHeight = hoverPreview.clientHeight;
                var elementTop = targetLineElement.offsetTop;
                var elementHeight = targetLineElement.offsetHeight;
                var scrollTop = elementTop - (containerHeight / 2) + (elementHeight / 2);
                hoverPreview.scrollTop = Math.max(0, scrollTop);
            }, 0);
        }
    }

    // Context menu for manual highlight
    document.addEventListener('contextmenu', function (e) {
        var sel = window.getSelection();
        var text = sel ? sel.toString().trim() : '';
        if (!text) { return; }

        e.preventDefault();
        removeContextMenu();

        contextMenu = document.createElement('div');
        contextMenu.className = 'context-menu';

        var highlightItem = document.createElement('div');
        highlightItem.className = 'context-menu-item';

        // 检查是否已高亮
        var existingIndex = manualHighlights.findIndex(function(h) { return h.text === text; });
        if (existingIndex >= 0) {
            highlightItem.textContent = 'Remove Highlight';
        } else {
            highlightItem.textContent = 'Highlight Selection';
        }

        highlightItem.addEventListener('click', function () {
            toggleHighlight(text);
            removeContextMenu();
        });

        contextMenu.appendChild(highlightItem);
        contextMenu.style.left = e.clientX + 'px';
        contextMenu.style.top = e.clientY + 'px';
        document.body.appendChild(contextMenu);
    });

    document.addEventListener('click', function () { removeContextMenu(); });

    function removeContextMenu() {
        if (contextMenu) {
            contextMenu.remove();
            contextMenu = null;
        }
    }
})();
