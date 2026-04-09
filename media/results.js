(function () {
    const vscode = acquireVsCodeApi();
    const resultsList = document.getElementById('resultsList');
    const resultCount = document.getElementById('resultCount');
    const btnClearHighlights = document.getElementById('btnClearHighlights');
    const hoverPreview = document.getElementById('hoverPreview');

    let allEntries = [];
    let hoverTimer = null;
    let hoverRow = null;
    let isMouseInPreview = false;
    let manualHighlights = [];
    const HIGHLIGHT_COLORS = [];
    let highlightBoxMode = true;
    let contextMenu = null;

    btnClearHighlights.addEventListener('click', () => {
        manualHighlights = [];
        rerenderContent();
        vscode.postMessage({ command: 'clearAllHighlights' });
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
                if (text) {
                    // 检查是否已经高亮
                    const existingIndex = manualHighlights.findIndex(h => h.text === text);
                    if (existingIndex >= 0) {
                        // 已高亮，移除
                        manualHighlights.splice(existingIndex, 1);
                    } else {
                        // 未高亮，添加
                        manualHighlights.push({ text, colorIndex: manualHighlights.length });
                    }
                    rerenderContent();
                }
                break;
            }
        }
    });

    function rerenderContent() {
        resultsList.innerHTML = '';
        resultCount.textContent = allEntries.length + ' results';

        for (const entry of allEntries) {
            const row = document.createElement('div');
            row.className = 'result-line';
            row.dataset.index = String(entry.globalIndex);
            row.dataset.file = entry.filePath;
            row.dataset.line = String(entry.lineNumber);

            const jumpBtn = document.createElement('span');
            jumpBtn.className = 'jump-btn';
            jumpBtn.textContent = '\u2197';
            jumpBtn.title = 'Jump to source';
            jumpBtn.addEventListener('click', () => {
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

            row.addEventListener('mouseenter', function (e) {
                hoverRow = row;
                isMouseInPreview = false;
                hoverTimer = setTimeout(() => {
                    vscode.postMessage({
                        command: 'requestPreview',
                        filePath: entry.filePath,
                        lineNumber: entry.lineNumber,
                    });
                }, 500);
            });
            row.addEventListener('mouseleave', () => {
                hoverRow = null;
                clearTimeout(hoverTimer);
                setTimeout(() => {
                    if (!isMouseInPreview && !hoverRow) {
                        hoverPreview.style.display = 'none';
                    }
                }, 100);
            });

            resultsList.appendChild(row);
        }
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

    function highlightNavEntry(index) {
        document.querySelectorAll('.result-line.nav-active').forEach(function (el) {
            el.classList.remove('nav-active');
        });
        var row = document.querySelector('.result-line[data-index="' + index + '"]');
        if (row) {
            row.classList.add('nav-active');
            row.scrollIntoView({ behavior: 'smooth', block: 'center' });
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
                codeSpan.innerHTML = line.html;
                div.appendChild(codeSpan);
            } else {
                div.appendChild(document.createTextNode(line.content));
            }
            hoverPreview.appendChild(div);
            if (line.num === data.lineNumber) {
                targetLineElement = div;
            }
        }

        // 定位在触发行附近（上方或下方），类似 VS Code 原生 hover
        hoverPreview.style.display = 'block';
        hoverPreview.style.top = '0px';
        hoverPreview.style.left = '0px';

        var previewRect = hoverPreview.getBoundingClientRect();
        var viewH = window.innerHeight;
        var viewW = window.innerWidth;
        var top, left;

        if (hoverRow) {
            var rowRect = hoverRow.getBoundingClientRect();
            // 优先显示在行上方
            if (rowRect.top > previewRect.height + 4) {
                top = rowRect.top - previewRect.height - 4;
            } else {
                // 空间不够则显示在行下方
                top = rowRect.bottom + 4;
            }
            left = rowRect.left;
        } else {
            top = viewH / 2 - previewRect.height / 2;
            left = viewW / 2 - previewRect.width / 2;
        }

        // 边界约束
        if (top + previewRect.height > viewH) { top = viewH - previewRect.height - 4; }
        if (top < 0) { top = 4; }
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
            if (existingIndex >= 0) {
                manualHighlights.splice(existingIndex, 1);
            } else {
                manualHighlights.push({ text: text, colorIndex: manualHighlights.length });
            }
            rerenderContent();
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
