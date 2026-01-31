'use strict';

const fs = require('fs');
const path = require('path');

const f = path.join(process.cwd(), 'jarvis_runner.js');
if (!fs.existsSync(f)) {
  console.error('FILE_NOT_FOUND=' + f);
  process.exit(1);
}

let s = fs.readFileSync(f, 'utf8');

// backup
const bak = f + '.bak_' + new Date().toISOString().replace(/[:.]/g, '-');
fs.writeFileSync(bak, s, 'utf8');

// 1) require memory_store (real newline, not literal \n)
if (!s.includes('require("./memory_store")')) {
  s = s.replace(
    'const OpenAI = require("openai");',
    'const OpenAI = require("openai");\nconst memory = require("./memory_store");'
  );
}

// 2) token caps (high defaults via env; still bounded by model/context)
if (!s.includes('JARVIS_MAX_OUTPUT_TOKENS_CHAT')) {
  s = s.replace(
    'const MAX_SEARCH_RAW_CHARS = 14000;',
    'const MAX_SEARCH_RAW_CHARS = 14000;\n\n' +
    '  // Output token caps (NOT unlimited; bounded by model+context)\n' +
    '  const MAX_OUT_CHAT  = parseInt(process.env.JARVIS_MAX_OUTPUT_TOKENS_CHAT  || "25000", 10);\n' +
    '  const MAX_OUT_WEB   = parseInt(process.env.JARVIS_MAX_OUTPUT_TOKENS_WEB   || "25000", 10);\n' +
    '  const MAX_OUT_TAURI = parseInt(process.env.JARVIS_MAX_OUTPUT_TOKENS_TAURI || "25000", 10);'
  );
}

// 3) local recall: append MEMORY_CONTEXT into ctx once, before any OpenAI call
if (!s.includes('// --- MEMORY (local recall) ---')) {
  s = s.replace(
    '\n  // Audit header',
    '\n  // --- MEMORY (local recall) ---\n' +
    '  const memDbPath = path.join(appDataRoot(), "memory", "jarvis_memory.db");\n' +
    '  let memoryContext = "";\n' +
    '  try {\n' +
    '    memory.init(memDbPath);\n' +
    '    memoryContext = memory.buildContext(taskText, { limitRuns: 6, maxChars: 2500 });\n' +
    '    if (memoryContext) ctx = `${ctx}${memoryContext}\\n\\n`;\n' +
    '  } catch (_) { memoryContext = ""; }\n\n' +
    '  // Audit header'
  );
}

// 4) replace output caps
s = s.replace(/max_output_tokens:\s*800,/g, 'max_output_tokens: MAX_OUT_TAURI,');
s = s.replace(/max_output_tokens:\s*520,/g, 'max_output_tokens: MAX_OUT_WEB,');
s = s.replace(/max_output_tokens:\s*420,/g, 'max_output_tokens: MAX_OUT_WEB,');
s = s.replace(/max_output_tokens:\s*320,/g, 'max_output_tokens: MAX_OUT_CHAT,');

// 5) write-back on successful runs (before onLog("DONE.");)
if (!s.includes('// --- MEMORY write-back ---')) {
  const wbLines = [
    '// --- MEMORY write-back ---',
    'try {',
    '  const dbPath = path.join(appDataRoot(), "memory", "jarvis_memory.db");',
    '  memory.init(dbPath);',
    '  const ft = (typeof proofObj === "object" && proofObj && proofObj.feature_tag) ? proofObj.feature_tag : "CHAT";',
    '  memory.addItem({ runId, role: "user", content: taskText, proofJsonPath, meta: { feature_tag: ft, at: nowISO(), perms } });',
    '  memory.addItem({ runId, role: "assistant", content: clip(outText, 12000), proofJsonPath, meta: { feature_tag: ft, at: nowISO(), perms } });',
    '} catch (_) {}',
  ];

  s = s.replace(/^(\s*)onLog\("DONE\."\);\s*$/gm, (m, indent) => {
    const block = wbLines.map(line => indent + line).join('\n');
    return block + '\n' + indent + 'onLog("DONE.");';
  });
}

// write file
fs.writeFileSync(f, s, 'utf8');

console.log('OK_PATCH');
console.log('BACKUP=' + bak);
