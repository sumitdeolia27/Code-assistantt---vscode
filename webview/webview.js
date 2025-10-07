// webview/webview.js
// Adapted from your popup.js (calls the backend). Works inside VS Code Webview.

(() => {
  const isVsCode = typeof acquireVsCodeApi === 'function';
  const vscode = isVsCode ? acquireVsCodeApi() : null;

  // helpers
  function $(id){ return document.getElementById(id); }
  function uniqueId(){ return 'id_' + Date.now() + Math.random().toString(16).slice(2); }

  const pending = {};

  // Receive messages from extension host
  window.addEventListener('message', (ev) => {
    const msg = ev.data;
    if (!msg || !msg.command) return;

    if (msg.command === 'selectedCode') {
      // Fill active textarea(s)
      const text = msg.code || '';
      const textareas = document.querySelectorAll('textarea[id$="Input"]');
      textareas.forEach(t => { t.value = text; const e = new Event('input'); t.dispatchEvent(e); });
    } else if (msg.command === 'backendResult' && msg.id && pending[msg.id]) {
      pending[msg.id].resolve(msg.data);
      delete pending[msg.id];
    } else if (msg.command === 'backendError' && msg.id && pending[msg.id]) {
      pending[msg.id].reject(new Error(msg.error || 'Backend error'));
      delete pending[msg.id];
    }
  });

  // Ask extension host for selected code (used on load)
  function requestSelectedCodeFromHost() {
    if (!vscode) return;
    vscode.postMessage({ command: 'requestSelectedCode' });
  }

  // Try to call backend directly from webview (fast), fallback to extension host if CORS/network error
  async function callBackend(body) {
    const url = "https://api-sand-two-62.vercel.app/api/ask";
    try {
      // Try direct fetch (requires backend to allow CORS for webview origin)
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (!resp.ok) throw new Error('HTTP '+resp.status);
      return await resp.json();
    } catch (err) {
      // fallback: ask extension to perform fetch (avoids CORS)
      if (!vscode) throw err;
      const id = uniqueId();
      const p = new Promise((resolve, reject) => { pending[id] = { resolve, reject }; });
      vscode.postMessage({ command: 'callBackend', id, url, body });
      return p;
    }
  }

  // Auto-run a compact set of analyses and populate result sections
  async function runAutoAnalyses(code) {
    const types = ['hints','errorfixing','explanation'];
    showLoading(true);
    try {
      for (const type of types) {
        const prompts = {
          hints: `Provide concise hints for this code. Focus on key concepts and best practices only:\n\n${code}`,
          errorfixing: `Fix the errors in this code. Return only the corrected code without explanations:\n\n${code}`,
          explanation: `Explain this code briefly and clearly:\n\n${code}`
        };
        const body = { question: prompts[type] || code, mode: type };
        const data = await callBackend(body);
        const result = data.result || data.optimizedCode || JSON.stringify(data);
        showResult(result, type);
      }
    } catch (e) {
      showError('Auto analysis failed: ' + (e.message || e));
    } finally {
      showLoading(false);
    }
  }

  // Build UI behavior (adapted from popup.js)
  function setupEventListeners() {
    // Tab switching (same markup as popup.html)
    document.querySelectorAll('.tab-button').forEach(btn => {
      btn.addEventListener('click', (e) => {
        document.querySelectorAll('.tab-button').forEach(b=>b.classList.remove('active'));
        document.querySelectorAll('.tab-panel').forEach(p=>p.classList.remove('active'));
        btn.classList.add('active');
        const tab = btn.dataset.tab;
        document.getElementById(tab).classList.add('active');
      });
    });

    // Register analyze buttons
    const analyzeButtons = [
      { id: 'hintsBtn', type: 'hints' },
      { id: 'suggestionsBtn', type: 'suggestions' },
      { id: 'explanationBtn', type: 'explanation' },
      { id: 'cleancodeBtn', type: 'cleancode' },
      { id: 'solutionsBtn', type: 'solutions' },
      { id: 'errorfixingBtn', type: 'errorfixing' }
    ];
    analyzeButtons.forEach(cfg => {
      const el = $(cfg.id);
      if (!el) return;
      el.addEventListener('click', async () => {
        const activeTab = document.querySelector('.tab-panel.active');
        const textarea = document.getElementById(`${activeTab.id}Input`) || $(activeTab.id+'Input') || $('hintsInput');
        const code = (textarea && textarea.value) ? textarea.value.trim() : '';
        if (!code) {
          showError('Please enter some code to analyze.');
          return;
        }
        showLoading(true);
        try {
          // Build prompt same as popup.js
          const prompts = {
            hints: `Provide concise hints for this code. Focus on key concepts and best practices only:\n\n${code}`,
            suggestions: `Give optimized code improvements. Return only the improved code without explanations:\n\n${code}`,
            explanation: `Explain this code briefly and clearly:\n\n${code}`,
            cleancode: `Provide clean, optimized code. Return only the refactored code without comments or explanations:\n\n${code}`,
            solutions: `Provide a complete, working solution code. Return only the full working code without comments or explanations. Make sure the code is complete and functional:\n\n${code}`,
            errorfixing: `Fix the errors in this code. Return only the corrected code without explanations:\n\n${code}`
          };
          const body = { question: prompts[cfg.type] || code, mode: cfg.type };
          const data = await callBackend(body);
          const result = data.result || data.optimizedCode || JSON.stringify(data);
          showResult(result, cfg.type);
        } catch (err) {
          showError('Error: ' + (err.message || err));
        } finally {
          showLoading(false);
        }
      });
    });

    // clear buttons
    document.querySelectorAll('.clear-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const inputId = btn.id.replace('clear', '').replace('Btn','') + 'Input';
        const ta = document.getElementById(inputId);
        if (ta) { ta.value = ''; ta.focus(); }
      });
    });
  }

  // Minimal UI helpers (copy of popup showResult logic)
  function showLoading(show) {
    const loading = $('loading');
    if (!loading) return;
    loading.style.display = show ? 'block' : 'none';
  }
  function showError(msg) {
    const activeTab = document.querySelector('.tab-panel.active');
    const resultDiv = activeTab ? document.getElementById(activeTab.id + 'Result') : null;
    if (resultDiv) resultDiv.innerHTML = `<p style="color:red;text-align:center;">❌ ${msg}</p>`;
  }

  function showResult(result, type) {
    const resultDiv = document.getElementById(`${type}Result`);
    if (!resultDiv) return;
    // Format simple: if code-like show pre, else plain
    let formatted = '';
    if (result.includes('```') || /function|class|return|var|let|const/.test(result.slice(0,200))) {
      const clean = result.replace(/```[\w]*\n?/g, '').replace(/```/g, '').trim();
      formatted = `
        <div class="code-container">
          <div class="code-header">
            <span class="code-lang">Code</span>
            <button class="copy-code-btn" id="copy-${type}">📋</button>
          </div>
          <pre class="code-block"><code id="code-${type}">${escapeHtml(clean)}</code></pre>
        </div>
      `;
    } else {
      formatted = `<div class="text-content">${escapeHtml(result)}</div>`;
    }

    // Add apply button so user can replace editor selection
    formatted = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
        <h3 style="color:#333;margin:0;">${getTypeTitle(type)}</h3>
        <div style="display:flex;gap:8px;">
          <button id="apply-${type}" class="copy-btn">Apply to Editor</button>
        </div>
      </div>
      ${formatted}
    `;
    resultDiv.innerHTML = formatted;

    // wire copy & apply
    const copyBtn = document.getElementById(`copy-${type}`);
    if (copyBtn) copyBtn.addEventListener('click', async () => {
      const codeEl = document.getElementById(`code-${type}`);
      if (!codeEl) return;
      try { await navigator.clipboard.writeText(codeEl.textContent); copyBtn.textContent = '✅'; setTimeout(()=>copyBtn.textContent='📋',1500);} catch(e){ copyBtn.textContent='❌'; setTimeout(()=>copyBtn.textContent='📋',1500); }
    });

    const applyBtn = document.getElementById(`apply-${type}`);
    if (applyBtn) applyBtn.addEventListener('click', () => {
      // send message to extension host to replace selection
      const codeEl = document.getElementById(`code-${type}`);
      const raw = codeEl ? codeEl.textContent : result;
      if (vscode) {
        vscode.postMessage({ command: 'replaceSelection', content: raw, mode: type });
      } else {
        alert('Replace selection works only inside VS Code.');
      }
    });
  }

  // small helpers
  function escapeHtml(s){ return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'\n'); }
  function getTypeTitle(type) {
    return ({ hints: '💡 Code Hints', suggestions: '💭 Improvement Suggestions', explanation: '📚 Code Explanation', cleancode: '✨ Clean Code Suggestions', solutions: '🎯 Solution Approaches', errorfixing: '🐛 Error Fixing' })[type] || 'Result';
  }

  // init
  document.addEventListener('DOMContentLoaded', () => {
    try {
      setupEventListeners();
      // Ask the extension host to give us the current selection (so UI is pre-filled)
      requestSelectedCodeFromHost();
    } catch (e) {
      console.error(e);
    }
  });

})();
