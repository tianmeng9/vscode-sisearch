(function () {
    const vscode = acquireVsCodeApi();

    const searchInput = document.getElementById('searchInput');
    const optCase = document.getElementById('optCase');
    const optWord = document.getElementById('optWord');
    const optRegex = document.getElementById('optRegex');
    const toggleFilters = document.getElementById('toggleFilters');
    const filterSection = document.getElementById('filterSection');
    const filesToInclude = document.getElementById('filesToInclude');
    const filesToExclude = document.getElementById('filesToExclude');
    const historyList = document.getElementById('historyList');

    function setupToggle(btn) {
        btn.addEventListener('click', () => {
            btn.classList.toggle('active');
        });
    }
    setupToggle(optCase);
    setupToggle(optWord);
    setupToggle(optRegex);

    // Toggle filter section visibility
    toggleFilters.addEventListener('click', () => {
        toggleFilters.classList.toggle('active');
        filterSection.classList.toggle('hidden');
    });

    function getOptions() {
        return {
            caseSensitive: optCase.classList.contains('active'),
            wholeWord: optWord.classList.contains('active'),
            regex: optRegex.classList.contains('active'),
        };
    }

    function getFilterPatterns(input) {
        const val = input.value.trim();
        if (!val) { return []; }
        return val.split(',').map(s => s.trim()).filter(Boolean);
    }

    function doSearch(e) {
        if (e.key !== 'Enter') { return; }
        const query = searchInput.value.trim();
        if (!query) { return; }
        const mode = e.shiftKey ? 'append' : 'replace';
        const msg = { command: 'search', query, options: getOptions(), mode };
        const inc = getFilterPatterns(filesToInclude);
        const exc = getFilterPatterns(filesToExclude);
        if (inc.length) { msg.filesToInclude = inc; }
        if (exc.length) { msg.filesToExclude = exc; }
        vscode.postMessage(msg);
    }

    searchInput.addEventListener('keydown', doSearch);
    filesToInclude.addEventListener('keydown', doSearch);
    filesToExclude.addEventListener('keydown', doSearch);

    window.addEventListener('message', (event) => {
        const msg = event.data;
        switch (msg.command) {
            case 'searchStarted':
                searchInput.disabled = true;
                break;
            case 'searchComplete':
                searchInput.disabled = false;
                searchInput.focus();
                break;
            case 'updateHistory':
                renderHistory(msg.entries);
                break;
            case 'clearSearch':
                searchInput.value = '';
                break;
        }
    });

    function renderHistory(entries) {
        historyList.innerHTML = '';
        for (const entry of entries) {
            const div = document.createElement('div');
            div.className = 'history-item' + (entry.active ? ' active' : '');

            const querySpan = document.createElement('span');
            querySpan.className = 'history-query';
            querySpan.textContent = entry.query;

            const countSpan = document.createElement('span');
            countSpan.className = 'history-count';
            countSpan.textContent = String(entry.count);

            const deleteBtn = document.createElement('span');
            deleteBtn.className = 'history-delete';
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
