(function () {
    const vscode = acquireVsCodeApi();

    const searchInput = document.getElementById('searchInput');
    const optCase = document.getElementById('optCase');
    const optWord = document.getElementById('optWord');
    const optRegex = document.getElementById('optRegex');
    const btnAppend = document.getElementById('btnAppend');
    const btnReplace = document.getElementById('btnReplace');
    const historyList = document.getElementById('historyList');

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
})();
