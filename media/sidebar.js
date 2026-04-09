(function () {
    const vscode = acquireVsCodeApi();

    const searchInput = document.getElementById('searchInput');
    const optCase = document.getElementById('optCase');
    const optWord = document.getElementById('optWord');
    const optRegex = document.getElementById('optRegex');
    const btnAppend = document.getElementById('btnAppend');
    const btnReplace = document.getElementById('btnReplace');
    const historyList = document.getElementById('historyList');
    const highlightList = document.getElementById('highlightList');

    function getOptions() {
        return {
            caseSensitive: optCase.checked,
            wholeWord: optWord.checked,
            regex: optRegex.checked,
        };
    }

    function doSearch(mode) {
        const query = searchInput.value.trim();
        if (!query) { return; }
        vscode.postMessage({ command: 'search', query, options: getOptions(), mode });
    }

    btnAppend.addEventListener('click', () => doSearch('append'));
    btnReplace.addEventListener('click', () => doSearch('replace'));

    searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            doSearch('replace');
        }
    });

    window.addEventListener('message', (event) => {
        const msg = event.data;
        switch (msg.command) {
            case 'updateHistory':
                renderHistory(msg.entries);
                break;
            case 'searchStarted':
                btnAppend.disabled = true;
                btnReplace.disabled = true;
                break;
            case 'searchComplete':
                btnAppend.disabled = false;
                btnReplace.disabled = false;
                break;
            case 'updateHighlights':
                renderHighlights(msg.highlights);
                break;
        }
    });

    function renderHistory(entries) {
        historyList.innerHTML = '';
        for (const entry of entries) {
            const div = document.createElement('div');
            div.className = 'history-item' + (entry.active ? ' active' : '');

            const querySpan = document.createElement('span');
            querySpan.className = 'query';
            querySpan.textContent = '"' + entry.query + '"';

            const countSpan = document.createElement('span');
            countSpan.className = 'count';
            countSpan.textContent = '(' + entry.count + ')';

            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'delete-btn';
            deleteBtn.textContent = '\u00d7';
            deleteBtn.title = 'Delete';
            deleteBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                vscode.postMessage({ command: 'deleteHistory', id: entry.id });
            });

            div.appendChild(querySpan);
            div.appendChild(countSpan);
            div.appendChild(deleteBtn);

            div.addEventListener('click', () => {
                vscode.postMessage({ command: 'selectHistory', id: entry.id });
            });

            historyList.appendChild(div);
        }
    }

    function renderHighlights(highlights) {
        highlightList.innerHTML = '';
        if (!highlights || highlights.length === 0) {
            var empty = document.createElement('div');
            empty.className = 'highlight-empty';
            empty.textContent = 'No highlights';
            highlightList.appendChild(empty);
            return;
        }
        for (const h of highlights) {
            var div = document.createElement('div');
            div.className = 'highlight-item';

            var dot = document.createElement('span');
            dot.className = 'highlight-color-dot';
            dot.style.background = h.color;

            var text = document.createElement('span');
            text.className = 'highlight-text';
            text.textContent = h.text;

            div.appendChild(dot);
            div.appendChild(text);
            highlightList.appendChild(div);
        }
    }
})();
