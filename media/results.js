(function () {
    const vscode = acquireVsCodeApi();
    const resultsList = document.getElementById('resultsList');
    const hoverPreview = document.getElementById('hoverPreview');

    let allEntries = [];
    let hoverTimer = null;
    let hoverRow = null;
    let isMouseInPreview = false;
    let manualHighlights = [];
    const HIGHLIGHT_COLORS = [];
    let highlightBoxMode = true;
    let contextMenu = null;

    // Virtual scroll state
    const VS = {
        rowHeight: 28,
        overscan: 8,
    };

    resultsList.addEventListener('scroll', () => {
        requestAnimationFrame(rerenderContent);
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
                rerenderContent();
                break;
            case 'appendResults':
                allEntries = allEntries.concat(msg.results);
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

        const jumpBtn = document.createElement('span');
        jumpBtn.className = 'jump-btn';
        jumpBtn.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 1.5h5.5L13 5v9.5H4z"/><path d="M9.5 1.5V5H13"/><line x1="1" y1="8.5" x2="7" y2="8.5"/><polyline points="5 6.5 7 8.5 5 10.5"/></svg>';
        jumpBtn.title = 'Jump to source';
        jumpBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            clearTimeout(hoverTimer);
            hoverPreview.style.display = 'none';
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

        // 只有悬停在代码部分才触发预览
        contentSpan.addEventListener('mouseenter', () => {
            hoverRow = contentSpan;
            isMouseInPreview = false;
            hoverTimer = setTimeout(() => {
                vscode.postMessage({
                    command: 'requestPreview',
                    filePath: entry.filePath,
                    lineNumber: entry.lineNumber,
                });
            }, 500);
        });
        contentSpan.addEventListener('mouseleave', () => {
            hoverRow = null;
            clearTimeout(hoverTimer);
            setTimeout(() => {
                if (!isMouseInPreview && !hoverRow) {
                    hoverPreview.style.display = 'none';
                }
            }, 100);
        });

        return row;
    }

    function rerenderContent() {
        const total = allEntries.length;
        const scrollTop = resultsList.scrollTop;
        const viewportHeight = resultsList.clientHeight || 600;
        const visibleCount = Math.ceil(viewportHeight / VS.rowHeight);

        const start = Math.max(0, Math.floor(scrollTop / VS.rowHeight) - VS.overscan);
        const end = Math.min(total, start + visibleCount + VS.overscan * 2);

        const spacerTopPx = start * VS.rowHeight;
        const spacerBottomPx = Math.max(0, (total - end) * VS.rowHeight);

        const fragment = document.createDocumentFragment();

        const topSpacer = document.createElement('div');
        topSpacer.style.height = spacerTopPx + 'px';
        fragment.appendChild(topSpacer);

        for (let i = start; i < end; i++) {
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
        const targetScrollTop = Math.max(0, index * VS.rowHeight - resultsList.clientHeight / 2);
        resultsList.scrollTop = targetScrollTop;
        rerenderContent();

        document.querySelectorAll('.result-line.nav-active').forEach(function (el) {
            el.classList.remove('nav-active');
        });
        var row = document.querySelector('.result-line[data-index="' + index + '"]');
        if (row) {
            row.classList.add('nav-active');
        }
    }

    hoverPreview.addEventListener('mouseenter', () => {
        isMouseInPreview = true;
    });
    hoverPreview.addEventListener('mouseleave', () => {
        isMouseInPreview = false;
        setTimeout(() => {
            if (!hoverRow) {
                hoverPreview.style.display = 'none';
            }
        }, 100);
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

        if (hoverRow) {
            var rowRect = hoverRow.getBoundingClientRect();
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
