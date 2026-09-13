// 审计：每个后台页面里「调用但未定义」的函数
const http = require('http');

function get(path) {
  return new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port: 8091, path }, r => {
      let b = '';
      r.on('data', d => (b += d));
      r.on('end', () => res(b));
    }).on('error', rej);
  });
}

(async () => {
  const slug = process.argv[2] || '';
  const pages = {
    '首页 /': '/',
    '标签管理 /tags': '/tags',
    '网盘链接 /links': '/links',
    '批量导入 /batch': '/batch',
    '编辑页 /edit': '/edit?slug=' + encodeURIComponent(slug),
  };
  // 浏览器/JS 内建，不需要定义
  const builtins = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'function',
    'fetch', 'parseInt', 'parseFloat', 'setTimeout', 'setInterval', 'clearTimeout', 'alert', 'confirm',
    'prompt', 'String', 'Number', 'Boolean', 'Array', 'Object', 'JSON', 'Date', 'Math', 'URLSearchParams',
    'FormData', 'FileReader', 'Image', 'XMLHttpRequest', 'requestAnimationFrame', 'encodeURIComponent',
    'decodeURIComponent', 'isNaN', 'RegExp', 'Promise', 'Set', 'Map', 'Error', 'do', 'else', 'new']);

  for (const [name, path] of Object.entries(pages)) {
    const html = await get(path);
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');
    const defined = new Set([...scripts.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(/g)].map(m => m[1]));
    // 变量形式的函数（const f = () => / = function）
    for (const m of scripts.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:function|\(|[A-Za-z_$][\w$]*\s*=>)/g)) defined.add(m[1]);
    const called = new Set();
    for (const m of scripts.matchAll(/(?:onclick|onchange|oninput|onsubmit)="([^"]*)"/g)) {
      for (const c of m[1].matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)) called.add(c[1]);
    }
    for (const m of scripts.matchAll(/(?:^|[^\w.$"'])([A-Za-z_$][\w$]*)\s*\(/g)) called.add(m[1]);
    const missing = [...called].filter(f => !defined.has(f) && !builtins.has(f));
    console.log(`${missing.length ? '❌' : '✅'} ${name}：${missing.length ? '调用但未定义 → ' + missing.join(', ') : '所有调用的函数都已定义'}`);
  }
})();
