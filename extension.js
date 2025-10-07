// extension.js
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

// Keep a single floating panel instance
let currentPanel = null;
// Keep a reference to sidebar webview if resolved
let sidebarWebview = null;

function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('codeAssistant.openUI', () => {
      openWebview(context);
    })
  );

  // Quick optimize command
  context.subscriptions.push(
    vscode.commands.registerCommand('codeAssistant.optimizeSelection', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) { vscode.window.showInformationMessage('No active editor'); return; }
      const selection = editor.selection;
      const selectedText = editor.document.getText(selection);
      if (!selectedText) { vscode.window.showInformationMessage('No text selected'); return; }

      try {
        const result = await callBackendFromExtension({
          question: `Provide a clean, optimized version of this code and fix errors:\n\n${selectedText}`,
          mode: 'cleancode'
        });
        const optimized = result.result || result.optimizedCode || JSON.stringify(result);
        await editor.edit(edit => edit.replace(selection, optimized));
        vscode.window.showInformationMessage('Selection optimized (Code Assistant).');
      } catch (err) {
        vscode.window.showErrorMessage('Error optimizing: ' + (err.message || err));
      }
    })
  );

  // Sidebar (Activity Bar) view provider
  const provider = new CodeAssistantViewProvider(context.extensionPath);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('codeAssistantView', provider)
  );

  // Debounced selection listener: only send selection to existing UIs
  let selectionTimer = null;
  const selectionDisposable = vscode.window.onDidChangeTextEditorSelection((event) => {
    if (!event || !event.selections || event.selections.length === 0) return;
    const code = event.textEditor.document.getText(event.selections[0]) || '';
    if (selectionTimer) { clearTimeout(selectionTimer); }
    selectionTimer = setTimeout(() => {
      postSelectedCodeToUIs(code);
    }, 200);
  });
  context.subscriptions.push(selectionDisposable);
}

function deactivate() {}

/**
 * Floating panel webview (Command)
 */
async function openWebview(context) {
  if (currentPanel) {
    try { currentPanel.reveal(vscode.ViewColumn.Active); } catch(_) {}
    // refresh selection content
    const editor = vscode.window.activeTextEditor;
    const sel = editor ? editor.document.getText(editor.selection) : '';
    currentPanel.webview.postMessage({ command: 'selectedCode', code: sel });
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    'codeAssistant',
    'Code Assistant',
    vscode.ViewColumn.Beside,
    { enableScripts: true, retainContextWhenHidden: true }
  );
  currentPanel = panel;

  // Load VS Code webview UI
  const htmlPath = path.join(context.extensionPath, 'webview', 'panel.html');
  panel.webview.html = loadHtml(context.extensionPath, panel.webview);

  // Send selection to webview
  const editor = vscode.window.activeTextEditor;
  const sel = editor ? editor.document.getText(editor.selection) : '';
  panel.webview.postMessage({ command: 'selectedCode', code: sel });

  handleWebviewMessages(panel.webview);

  panel.onDidDispose(() => {
    currentPanel = null;
  });
}

/**
 * Sidebar view provider (Activity Bar)
 */
class CodeAssistantViewProvider {
  constructor(extensionPath) {
    this.extensionPath = extensionPath;
  }

  resolveWebviewView(webviewView) {
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = loadHtml(this.extensionPath, webviewView.webview);
    sidebarWebview = webviewView.webview;

    // Send selected text when opened
    const editor = vscode.window.activeTextEditor;
    const sel = editor ? editor.document.getText(editor.selection) : '';
    webviewView.webview.postMessage({ command: 'selectedCode', code: sel });

    handleWebviewMessages(webviewView.webview);
  }
}

/**
 * Utility: load HTML file and fix resource URIs
 */
function loadHtml(extensionPath, webview) {
  const htmlPath = path.join(extensionPath, 'webview', 'panel.html');
  let html = fs.readFileSync(htmlPath, 'utf8');
  html = html.replace(/(src|href)="([^"]+)"/g, (m, attr, url) => {
    if (/^https?:\/\//.test(url) || url.startsWith('data:')) return `${attr}="${url}"`;
    const resourcePath = vscode.Uri.file(path.join(extensionPath, 'webview', url));
    const webviewUri = webview.asWebviewUri(resourcePath);
    return `${attr}="${webviewUri}"`;
  });
  return html;
}

/**
 * Utility: handle messages from the webview
 */
function handleWebviewMessages(webview) {
  webview.onDidReceiveMessage(async (message) => {
    try {
      if (!message || !message.command) return;

      if (message.command === 'requestSelectedCode') {
        const editor = vscode.window.activeTextEditor;
        const sel = editor ? editor.document.getText(editor.selection) : '';
        webview.postMessage({ command: 'selectedCode', code: sel });
      } else if (message.command === 'replaceSelection') {
        const editor = vscode.window.activeTextEditor;
        if (!editor) { vscode.window.showWarningMessage('No active editor to apply code'); return; }
        await editor.edit(editBuilder => {
          editBuilder.replace(editor.selection, message.content || '');
        });
        vscode.window.showInformationMessage('Code Assistant: selection replaced');
        // Keep focus in editor; don't steal focus
        try { if (currentPanel) { currentPanel.reveal(vscode.ViewColumn.Beside, true); } } catch(_) {}
      } else if (message.command === 'callBackend') {
        try {
          const data = await callBackendFromExtension(message.body, message.url);
          webview.postMessage({ command: 'backendResult', id: message.id, data });
        } catch (err) {
          webview.postMessage({ command: 'backendError', id: message.id, error: err.message || String(err) });
        }
      }
    } catch (err) {
      console.error('Webview message handler error:', err);
    }
  });
}

/**
 * Utility: post currently selected code to any open assistant UIs
 */
function postSelectedCodeToUIs(code) {
  try {
    if (currentPanel && currentPanel.webview) {
      currentPanel.webview.postMessage({ command: 'selectedCode', code: code || '' });
    }
    if (sidebarWebview) {
      sidebarWebview.postMessage({ command: 'selectedCode', code: code || '' });
    }
  } catch (_) {}
}

/**
 * Utility: backend call
 */
async function callBackendFromExtension(body, url) {
  let fetchFn = global.fetch;
  if (!fetchFn) {
    try {
      fetchFn = require('node-fetch');
    } catch (e) {
      throw new Error('node-fetch not available - run `npm install node-fetch@2` in the extension folder');
    }
  }
  const endpoint = url || 'https://api-sand-two-62.vercel.app/api/ask';
  const resp = await fetchFn(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => resp.statusText);
    throw new Error(`API call failed: ${resp.status} ${text}`);
  }
  return await resp.json();
}

module.exports = { activate, deactivate };
