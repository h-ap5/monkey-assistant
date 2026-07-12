(() => {
  'use strict';

  const STORAGE_KEY = 'monkeyAssistantStateV2';
  const DB_NAME = 'monkey-assistant-web';
  const DB_STORE = 'state';
  const DEFAULT_SETTINGS = {
    tone: 'default', intensity: 'light', title: '', customEnding: '', theme: 'dark',
    ignoreDisabled: false, similarityThreshold: 52
  };

  const tonePresets = {
    default: '기본체', casual: '친근한 반말', polite: '정중한 존댓말',
    cat: '고양이체', court: '간신체', military: '군대체', maid: '메이드체',
    blunt: '무심한 전문가체', custom: '커스텀 말버릇'
  };

  const featureRules = [
    ['배경·테마 꾸미기', /background|theme|dark.?mode|light.?mode|blur|opacity|brightness|saturate|배경|테마|블러|투명도/i],
    ['이미지·갤러리 관리', /image|gallery|thumbnail|archive|lightbox|download.*image|이미지|갤러리|썸네일|보관함/i],
    ['채팅 입력창 개선', /ProseMirror|contenteditable|textarea|chat.?input|input.?box|입력창|글자.?수|maxLength/i],
    ['메시지 전송·통신 제어', /WebSocket|socket\.io|XMLHttpRequest|fetch\s*\(|send\s*\(|메시지.?전송|네트워크/i],
    ['복사·내보내기', /clipboard|copy|export|download|saveAs|복사|내보내기|다운로드/i],
    ['버튼·메뉴·도구막대 추가', /createElement\(['\"]button|GM_registerMenuCommand|toolbar|floating.?button|메뉴|도구막대/i],
    ['CSS·레이아웃 수정', /GM_addStyle|insertRule|style\.textContent|cssText|display\s*:|position\s*:|레이아웃/i],
    ['폰트·문장 표시 개선', /fontFamily|font-size|line-height|markdown|KaTeX|폰트|문단|가독성/i],
    ['기록·보관함 정리', /history|archive|log|indexedDB|기록|내역|보관/i],
    ['자동화·단축키', /keydown|keyup|hotkey|shortcut|setInterval|MutationObserver|자동|단축키/i],
    ['광고·추적 요소 정리', /adblock|advert|analytics|tracking|광고|추적/i],
    ['프롬프트·텍스트 가공', /prompt|template|replaceAll|rewrite|프롬프트|말투|텍스트.?변환/i],
    ['모바일 화면 보정', /mobile|touchstart|visualViewport|safe-area|모바일|터치/i],
    ['알림·상태 표시', /Notification|toast|badge|status|알림|상태.?표시/i]
  ];

  let state = {
    scripts: [], issues: [], importedAt: null,
    settings: { ...DEFAULT_SETTINGS }, chatHistory: []
  };

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const esc = (s = '') => String(s).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const uniq = arr => [...new Set(arr.filter(Boolean))];

  async function sha256(text) {
    if (globalThis.crypto?.subtle) {
      const bytes = new TextEncoder().encode(text);
      const hash = await crypto.subtle.digest('SHA-256', bytes);
      return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
    }
    // file:// 또는 제한된 미리보기 환경용 결정적 대체 해시입니다.
    let h1 = 0x811c9dc5, h2 = 0x9e3779b9, h3 = 0x85ebca6b, h4 = 0xc2b2ae35;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 0x01000193);
      h2 = Math.imul(h2 ^ c, 0x27d4eb2d);
      h3 = Math.imul(h3 ^ c, 0x165667b1);
      h4 = Math.imul(h4 ^ c, 0x85ebca77);
    }
    const words = [h1,h2,h3,h4,h1^h3,h2^h4,h1^h2^h4,h2^h3^h4];
    return words.map(n => (n >>> 0).toString(16).padStart(8,'0')).join('');
  }

  function normalizeCode(code) {
    return code.replace(/\r\n?/g, '\n').split('\n').map(line => line.replace(/[ \t]+$/g, '')).join('\n').trim();
  }

  function stripCommentsForSimilarity(code) {
    return code
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/^\s*\/\/.*$/gm, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function parseMetadata(code) {
    const block = code.match(/\/\/\s*==UserScript==([\s\S]*?)\/\/\s*==\/UserScript==/i)?.[1] || '';
    const meta = {};
    for (const line of block.split(/\r?\n/)) {
      const m = line.match(/^\s*\/\/\s*@([^\s]+)\s*(.*)$/);
      if (!m) continue;
      const key = m[1];
      const value = m[2].trim();
      (meta[key] ||= []).push(value);
    }
    const first = key => meta[key]?.[0] || '';
    return {
      all: meta,
      name: first('name:ko') || first('name:ko-KR') || first('name') || '이름 없는 스크립트',
      namespace: first('namespace'), version: first('version') || '버전 미표기',
      description: first('description:ko') || first('description:ko-KR') || first('description'),
      matches: uniq([...(meta.match || []), ...(meta.include || [])]),
      excludes: uniq(meta.exclude || []), grants: uniq(meta.grant || []),
      requires: uniq(meta.require || []), connects: uniq(meta.connect || []),
      runAt: first('run-at') || '기본값', author: first('author'),
      updateURL: first('updateURL') || first('downloadURL')
    };
  }

  function extractDomains(patterns) {
    const out = [];
    for (const raw of patterns) {
      if (raw === '<all_urls>') { out.push('* 모든 사이트'); continue; }
      try {
        const host = raw.match(/^[a-z*]+:\/\/([^/]+)/i)?.[1];
        if (host) out.push(host.replace(/^\*\./, ''));
        else if (/^[\w.-]+$/.test(raw)) out.push(raw);
      } catch { /* ignore malformed patterns */ }
    }
    return uniq(out.length ? out : ['사이트 미표기']);
  }

  function extractQuotedArgs(code, methodRegex) {
    const out = [];
    let m;
    const re = new RegExp(methodRegex.source, methodRegex.flags.includes('g') ? methodRegex.flags : methodRegex.flags + 'g');
    while ((m = re.exec(code)) && out.length < 120) out.push(m[1]);
    return uniq(out);
  }

  function analyzeSignals(code, meta) {
    const features = featureRules.filter(([, re]) => re.test(code + '\n' + meta.description + '\n' + meta.name)).map(([label]) => label);
    const selectors = uniq([
      ...extractQuotedArgs(code, /(?:querySelector(?:All)?|matches|closest)\s*\(\s*['"`]([^'"`]{1,180})['"`]/g),
      ...extractQuotedArgs(code, /getElementById\s*\(\s*['"`]([^'"`]{1,120})['"`]/g).map(x => `#${x}`),
      ...extractQuotedArgs(code, /getElementsByClassName\s*\(\s*['"`]([^'"`]{1,120})['"`]/g).map(x => `.${x}`)
    ]).slice(0, 80);
    const storageKeys = uniq([
      ...extractQuotedArgs(code, /(?:localStorage|sessionStorage)\.(?:getItem|setItem|removeItem)\s*\(\s*['"`]([^'"`]{1,140})['"`]/g),
      ...extractQuotedArgs(code, /GM_(?:getValue|setValue|deleteValue)\s*\(\s*['"`]([^'"`]{1,140})['"`]/g)
    ]).slice(0, 80);
    const events = extractQuotedArgs(code, /addEventListener\s*\(\s*['"`]([^'"`]{1,80})['"`]/g).slice(0, 50);
    const hooks = [];
    if (/WebSocket\.prototype|new\s+WebSocket|socket\.io|io\s*\(/i.test(code)) hooks.push('WebSocket/Socket.IO');
    if (/window\.fetch|fetch\s*=|fetch\s*\(/i.test(code)) hooks.push('fetch');
    if (/XMLHttpRequest\.prototype|new\s+XMLHttpRequest/i.test(code)) hooks.push('XHR');
    if (/MutationObserver/i.test(code)) hooks.push('DOM 감시');
    if (/history\.(?:pushState|replaceState)|popstate/i.test(code)) hooks.push('페이지 이동 감시');
    const gmApis = uniq([...code.matchAll(/\b(GM(?:_[A-Za-z]+|\.[A-Za-z]+))\b/g)].map(m => m[1])).slice(0, 40);
    return { features, selectors, storageKeys, events, hooks: uniq(hooks), gmApis };
  }

  function buildSummary(meta, signals) {
    const parts = [];
    if (meta.description) parts.push(meta.description.replace(/\s+/g, ' ').trim());
    if (signals.features.length) parts.push(signals.features.slice(0, 3).join(' · '));
    if (!parts.length && signals.hooks.length) parts.push(`${signals.hooks.join(', ')} 관련 동작을 포함합니다.`);
    if (!parts.length) parts.push('메타데이터가 부족해 코드 구조 위주로 분석된 스크립트입니다.');
    return parts.join(' — ').slice(0, 260);
  }

  function parseEnabledFromOptions(optionsText) {
    try {
      const obj = JSON.parse(optionsText);
      const candidate = obj.enabled ?? obj.options?.enabled ?? obj.settings?.enabled ?? obj.config?.enabled;
      return typeof candidate === 'boolean' ? candidate : null;
    } catch { return null; }
  }

  async function buildScript(fileName, code, enabled = null) {
    const meta = parseMetadata(code);
    const normalized = normalizeCode(code);
    const similarityCode = stripCommentsForSimilarity(code);
    const signals = analyzeSignals(code, meta);
    return {
      id: await sha256(fileName + '\n' + normalized), fileName, code,
      size: new Blob([code]).size, meta, enabled,
      domains: extractDomains(meta.matches), signals,
      summary: buildSummary(meta, signals),
      rawHash: await sha256(normalized),
      codeHash: await sha256(similarityCode),
      risks: []
    };
  }

  async function readInputFiles(fileList) {
    const all = [];
    for (const file of fileList) {
      if (/\.zip$/i.test(file.name)) {
        const zip = await JSZip.loadAsync(await file.arrayBuffer());
        const entries = Object.values(zip.files).filter(entry => !entry.dir);
        const optionMap = new Map();
        for (const entry of entries.filter(e => /(?:\.options\.json|options\.json)$/i.test(e.name))) {
          optionMap.set(entry.name.replace(/\.options\.json$/i, '').replace(/options\.json$/i, ''), await entry.async('string'));
        }
        for (const entry of entries.filter(e => /(?:\.user\.js|\.js)$/i.test(e.name))) {
          const code = await entry.async('string');
          if (!/==UserScript==/i.test(code)) continue;
          const base = entry.name.replace(/\.user\.js$/i, '').replace(/\.js$/i, '');
          const optionsText = [...optionMap.entries()].find(([key]) => key && (base.includes(key) || key.includes(base)))?.[1];
          all.push(await buildScript(entry.name, code, optionsText ? parseEnabledFromOptions(optionsText) : null));
        }
      } else {
        const code = await file.text();
        if (/==UserScript==/i.test(code)) all.push(await buildScript(file.name, code));
      }
    }
    return all;
  }

  function compareVersions(a, b) {
    const pa = String(a).match(/\d+/g)?.map(Number) || [0];
    const pb = String(b).match(/\d+/g)?.map(Number) || [0];
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const d = (pa[i] || 0) - (pb[i] || 0);
      if (d) return d;
    }
    return String(a).localeCompare(String(b));
  }

  function jaccard(a, b) {
    const A = new Set(a), B = new Set(b);
    if (!A.size && !B.size) return 0;
    let intersection = 0;
    for (const x of A) if (B.has(x)) intersection++;
    return intersection / (A.size + B.size - intersection || 1);
  }

  function domainsOverlap(a, b) {
    if (a.includes('* 모든 사이트') || b.includes('* 모든 사이트')) return .8;
    const A = a.filter(x => x !== '사이트 미표기'), B = b.filter(x => x !== '사이트 미표기');
    for (const x of A) for (const y of B) {
      if (x === y || x.endsWith('.' + y) || y.endsWith('.' + x)) return 1;
    }
    return 0;
  }

  function pairSimilarity(a, b) {
    const domain = domainsOverlap(a.domains, b.domains);
    if (!domain) return { score: 0, domain: 0, feature: 0, selector: 0, storage: 0, hook: 0 };
    const feature = jaccard(a.signals.features, b.signals.features);
    const selector = jaccard(a.signals.selectors, b.signals.selectors);
    const storage = jaccard(a.signals.storageKeys, b.signals.storageKeys);
    const hook = jaccard(a.signals.hooks, b.signals.hooks);
    const score = domain * .24 + feature * .34 + selector * .24 + storage * .11 + hook * .07;
    return { score, domain, feature, selector, storage, hook };
  }

  function addRisk(id, type) {
    const script = state.scripts.find(s => s.id === id);
    if (script && !script.risks.includes(type)) script.risks.push(type);
  }

  function analyzeAll() {
    state.scripts.forEach(s => { s.risks = []; });
    const candidates = state.settings.ignoreDisabled ? state.scripts.filter(s => s.enabled !== false) : state.scripts;
    const issues = [];

    const byRawHash = Map.groupBy ? Map.groupBy(candidates, s => s.rawHash) : groupBy(candidates, s => s.rawHash);
    for (const group of byRawHash.values()) {
      if (group.length < 2) continue;
      group.forEach(s => addRisk(s.id, 'exact'));
      issues.push({
        id: 'exact-' + group[0].rawHash.slice(0, 12), type: 'exact', severity: 'high', score: 1,
        title: `완전히 같은 스크립트가 ${group.length}개 있습니다`,
        scripts: group.map(s => s.id),
        detail: `${group.map(s => `“${s.meta.name}”`).join(', ')}의 코드가 동일합니다. 복사본 하나만 남기는 편이 안전합니다.`
      });
    }

    const byIdentity = groupBy(candidates, s => `${s.meta.namespace || '(namespace 없음)'}\u0000${s.meta.name}`.toLowerCase());
    for (const group of byIdentity.values()) {
      if (group.length < 2) continue;
      const versionGroups = groupBy(group, s => s.meta.version);
      for (const vg of versionGroups.values()) {
        if (vg.length >= 2 && new Set(vg.map(s => s.rawHash)).size > 1) {
          vg.forEach(s => addRisk(s.id, 'version'));
          issues.push({
            id: 'samever-' + vg.map(s => s.id).join('-'), type: 'version', severity: 'high', score: .96,
            title: `같은 이름과 버전인데 코드가 다른 복사본이 있습니다`, scripts: vg.map(s => s.id),
            detail: `“${vg[0].meta.name}” ${vg[0].meta.version}이 여러 개지만 내부 코드는 서로 다릅니다. 어느 파일이 최신 수정본인지 직접 확인하세요.`
          });
        }
      }
      const versions = uniq(group.map(s => s.meta.version));
      if (versions.length > 1) {
        const sorted = [...group].sort((a,b) => compareVersions(b.meta.version, a.meta.version));
        group.forEach(s => addRisk(s.id, 'version'));
        issues.push({
          id: 'versions-' + sorted.map(s => s.id).join('-'), type: 'version', severity: 'medium', score: .9,
          title: `“${group[0].meta.name}”의 여러 버전이 함께 있습니다`, scripts: group.map(s => s.id),
          detail: `확인된 버전은 ${versions.join(', ')}입니다. 일반적으로 ${sorted[0].meta.version}만 남기고 구버전을 비활성화하는 편이 좋습니다.`
        });
      }
    }

    const threshold = state.settings.similarityThreshold / 100;
    for (let i = 0; i < candidates.length; i++) {
      for (let j = i + 1; j < candidates.length; j++) {
        const a = candidates[i], b = candidates[j];
        if (a.rawHash === b.rawHash) continue;
        const sim = pairSimilarity(a, b);
        if (sim.score < threshold) continue;
        const sharedSelectors = a.signals.selectors.filter(x => b.signals.selectors.includes(x));
        const sharedStorage = a.signals.storageKeys.filter(x => b.signals.storageKeys.includes(x));
        const sharedHooks = a.signals.hooks.filter(x => b.signals.hooks.includes(x));
        const conflict = (sharedSelectors.length && sharedHooks.length) || sharedStorage.length || sim.selector >= .45;
        const type = conflict ? 'conflict' : 'overlap';
        addRisk(a.id, 'conflict'); addRisk(b.id, 'conflict');
        const sharedFeatures = a.signals.features.filter(x => b.signals.features.includes(x));
        const evidence = [];
        if (sharedFeatures.length) evidence.push(`공통 기능: ${sharedFeatures.slice(0,4).join(', ')}`);
        if (sharedSelectors.length) evidence.push(`같은 요소: ${sharedSelectors.slice(0,4).join(', ')}`);
        if (sharedStorage.length) evidence.push(`같은 저장 키: ${sharedStorage.slice(0,4).join(', ')}`);
        if (sharedHooks.length) evidence.push(`같은 후킹: ${sharedHooks.join(', ')}`);
        issues.push({
          id: `${type}-${a.id}-${b.id}`, type, severity: conflict ? 'medium' : 'low', score: sim.score,
          title: conflict ? `같은 요소를 건드리는 충돌 후보입니다` : `기능이 겹칠 가능성이 있습니다`,
          scripts: [a.id,b.id],
          detail: `“${a.meta.name}”와 “${b.meta.name}”의 유사도는 ${Math.round(sim.score*100)}%입니다. ${evidence.join(' · ') || '같은 사이트에서 비슷한 코드 신호가 발견되었습니다.'}`
        });
      }
    }

    state.issues = issues.sort((a,b) => b.score - a.score || severityRank(a.severity) - severityRank(b.severity));
    renderAll();
    saveState();
  }

  function groupBy(items, fn) {
    const map = new Map();
    for (const item of items) {
      const key = fn(item);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(item);
    }
    return map;
  }

  const severityRank = s => ({high:0,medium:1,low:2}[s] ?? 3);
  const getScript = id => state.scripts.find(s => s.id === id);

  function renderAll() {
    renderStats(); renderOverview(); renderScripts(); renderIssues(); renderFilters(); renderChatHistory();
    $('#exportBtn').disabled = !state.scripts.length;
    $('#dropZone').classList.toggle('has-data', state.scripts.length > 0);
  }

  function renderStats() {
    $('#statScripts').textContent = state.scripts.length;
    $('#statExact').textContent = state.issues.filter(i => i.type === 'exact').length;
    $('#statVersion').textContent = state.issues.filter(i => i.type === 'version').length;
    $('#statConflict').textContent = state.issues.filter(i => ['overlap','conflict'].includes(i.type)).length;
  }

  function riskBadges(script) {
    const labels = { exact:'완전 중복', version:'버전 확인', conflict:'중복·충돌 후보' };
    if (!script.risks.length) return '<span class="badge clean">특이사항 없음</span>';
    return script.risks.map(x => `<span class="badge ${x}">${labels[x]}</span>`).join('');
  }

  function scriptCardHtml(s) {
    return `<article class="script-card" data-script-id="${s.id}">
      <div class="script-name">${esc(s.meta.name)}</div>
      <div class="meta-line"><span class="badge">${esc(s.meta.version)}</span>${riskBadges(s)}</div>
      <p class="summary">${esc(s.summary)}</p>
    </article>`;
  }

  function renderOverview() {
    const priority = state.issues.slice(0,5);
    $('#priorityIssues').className = priority.length ? 'issue-list' : 'issue-list empty-message';
    $('#priorityIssues').innerHTML = priority.length ? priority.map(issueHtml).join('') : '현재 표시할 문제가 없습니다.';

    const counts = new Map();
    state.scripts.flatMap(s => s.domains).forEach(d => counts.set(d, (counts.get(d)||0)+1));
    const domainRows = [...counts.entries()].sort((a,b)=>b[1]-a[1]).slice(0,8);
    const max = domainRows[0]?.[1] || 1;
    $('#domainChart').className = domainRows.length ? 'bar-list' : 'bar-list empty-message';
    $('#domainChart').innerHTML = domainRows.length ? domainRows.map(([d,c]) => `<div class="bar-item"><span title="${esc(d)}">${esc(d)}</span><div class="bar-track"><div class="bar-fill" style="width:${Math.round(c/max*100)}%"></div></div><strong>${c}</strong></div>`).join('') : '데이터가 없습니다.';

    const recent = state.scripts.slice(-6).reverse();
    $('#recentScripts').className = recent.length ? 'script-grid' : 'script-grid empty-message';
    $('#recentScripts').innerHTML = recent.length ? recent.map(scriptCardHtml).join('') : '불러온 스크립트가 없습니다.';
  }

  function renderFilters() {
    const select = $('#domainFilter');
    const current = select.value;
    const domains = uniq(state.scripts.flatMap(s => s.domains)).sort();
    select.innerHTML = '<option value="">모든 사이트</option>' + domains.map(d => `<option value="${esc(d)}">${esc(d)}</option>`).join('');
    if (domains.includes(current)) select.value = current;
  }

  function renderScripts() {
    const q = $('#scriptSearch')?.value.trim().toLowerCase() || '';
    const domain = $('#domainFilter')?.value || '';
    const risk = $('#riskFilter')?.value || '';
    const rows = state.scripts.filter(s => {
      const hay = [s.meta.name,s.meta.description,s.fileName,...s.domains,...s.meta.grants,...s.signals.features,...s.signals.hooks].join(' ').toLowerCase();
      if (q && !hay.includes(q)) return false;
      if (domain && !s.domains.includes(domain)) return false;
      if (risk === 'clean' && s.risks.length) return false;
      if (risk && risk !== 'clean' && !s.risks.includes(risk)) return false;
      return true;
    });
    $('#scriptCountLabel').textContent = `${rows.length}개`;
    $('#scriptList').className = rows.length ? 'script-list' : 'script-list empty-message';
    $('#scriptList').innerHTML = rows.length ? rows.map(s => `<article class="script-row" data-script-id="${s.id}">
      <div><div class="script-name">${esc(s.meta.name)}</div><div class="meta-line"><span class="badge">${esc(s.meta.version)}</span>${s.enabled === false ? '<span class="badge">비활성</span>' : ''}${riskBadges(s)}</div></div>
      <p class="summary">${esc(s.summary)}</p>
      <div class="domains">${esc(s.domains.join(', '))}</div>
      <div class="count-label">${formatBytes(s.size)}</div>
    </article>`).join('') : '조건에 맞는 스크립트가 없습니다.';
  }

  function issueHtml(issue) {
    const names = issue.scripts.map(getScript).filter(Boolean).map(s => s.meta.name);
    return `<article class="issue-card ${issue.severity}">
      <div class="issue-title"><span>${esc(issue.title)}</span><span class="badge ${issue.type === 'exact' ? 'exact' : issue.type === 'version' ? 'version' : 'conflict'}">${Math.round(issue.score*100)}%</span></div>
      <p>${esc(issue.detail)}</p>
      <div class="meta-line">${names.map(n => `<span class="badge">${esc(n)}</span>`).join('')}</div>
    </article>`;
  }

  function renderIssues(filter = $('.issue-tab.active')?.dataset.issueFilter || 'all') {
    const items = state.issues.filter(i => filter === 'all' || i.type === filter);
    $('#issueList').className = items.length ? 'issue-list large' : 'issue-list large empty-message';
    $('#issueList').innerHTML = items.length ? items.map(issueHtml).join('') : '해당 유형의 문제를 찾지 못했습니다.';
  }

  function showScriptDialog(id) {
    const s = getScript(id); if (!s) return;
    $('#dialogTitle').textContent = s.meta.name;
    $('#dialogMeta').textContent = `${s.fileName} · ${s.meta.version} · ${formatBytes(s.size)}`;
    const related = state.issues.filter(i => i.scripts.includes(id));
    $('#dialogBody').innerHTML = `<div class="detail-grid">
      <section class="detail-box full"><h3>기능 요약</h3><p class="summary">${esc(s.summary)}</p><div class="meta-line">${riskBadges(s)}</div></section>
      <section class="detail-box"><h3>작동 사이트</h3><ul>${s.domains.map(x=>`<li>${esc(x)}</li>`).join('')}</ul></section>
      <section class="detail-box"><h3>권한과 실행 정보</h3><ul><li>실행 시점: ${esc(s.meta.runAt)}</li><li>권한: ${esc(s.meta.grants.join(', ') || '없음')}</li><li>활성 상태: ${s.enabled === null ? '백업에 정보 없음' : s.enabled ? '활성' : '비활성'}</li></ul></section>
      <section class="detail-box"><h3>감지한 기능</h3><ul>${(s.signals.features.length?s.signals.features:['뚜렷한 기능 키워드 없음']).map(x=>`<li>${esc(x)}</li>`).join('')}</ul></section>
      <section class="detail-box"><h3>코드 신호</h3><ul><li>후킹: ${esc(s.signals.hooks.join(', ') || '없음')}</li><li>이벤트: ${esc(s.signals.events.slice(0,8).join(', ') || '없음')}</li><li>저장 키: ${esc(s.signals.storageKeys.slice(0,8).join(', ') || '없음')}</li></ul></section>
      <section class="detail-box full"><h3>관련 중복·충돌</h3>${related.length ? related.map(issueHtml).join('') : '<p class="hint">관련 문제를 찾지 못했습니다.</p>'}</section>
      <section class="detail-box full"><h3>코드 미리보기</h3><pre class="code-preview">${esc(s.code.slice(0,30000))}</pre></section>
    </div>`;
    $('#scriptDialog').showModal();
  }

  function formatBytes(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024*1024) return `${(n/1024).toFixed(1)} KB`;
    return `${(n/1024/1024).toFixed(1)} MB`;
  }

  function answerQuestion(question) {
    if (!state.scripts.length) return '먼저 Tampermonkey 백업 ZIP이나 .user.js 파일을 불러와야 분석할 수 있습니다.';
    const q = question.trim().toLowerCase();
    const exact = state.issues.filter(i => i.type === 'exact');
    const versions = state.issues.filter(i => i.type === 'version');
    const conflicts = state.issues.filter(i => i.type === 'conflict');
    const overlaps = state.issues.filter(i => i.type === 'overlap');

    if (/뭐.*(꺼|지워|정리)|삭제|비활성.*추천/.test(q)) {
      const recs = [];
      for (const issue of exact.slice(0,3)) {
        const ss = issue.scripts.map(getScript).filter(Boolean);
        if (ss.length > 1) recs.push(`• ${ss.slice(1).map(s=>`“${s.meta.name}”`).join(', ')}: 완전히 같은 복사본입니다.`);
      }
      for (const issue of versions.slice(0,3)) {
        const ss = issue.scripts.map(getScript).filter(Boolean).sort((a,b)=>compareVersions(b.meta.version,a.meta.version));
        if (ss.length > 1) recs.push(`• “${ss[0].meta.name}”: ${ss[0].meta.version}을 남기고 ${ss.slice(1).map(s=>s.meta.version).join(', ')}을 먼저 비활성화해볼 수 있습니다.`);
      }
      return recs.length ? `우선 정리 후보는 다음과 같습니다.\n${recs.join('\n')}\n실제 삭제 전에는 하나씩 비활성화한 뒤 사용하는 페이지가 정상인지 확인하는 편이 안전합니다.` : '완전 중복이나 명확한 구버전은 찾지 못했습니다. 기능 중복 후보는 있지만 자동으로 삭제를 권할 정도로 확실하지 않습니다.';
    }

    if (/중복|똑같|복사본/.test(q)) {
      if (!exact.length && !overlaps.length) return '완전히 같은 코드나 높은 기능 중복 후보를 찾지 못했습니다.';
      const lines = [];
      exact.slice(0,5).forEach(i => lines.push(`• 완전 중복: ${i.scripts.map(getScript).filter(Boolean).map(s=>`“${s.meta.name}”`).join(' / ')}`));
      overlaps.slice(0,5).forEach(i => lines.push(`• 기능 중복 ${Math.round(i.score*100)}%: ${i.scripts.map(getScript).filter(Boolean).map(s=>`“${s.meta.name}”`).join(' / ')}`));
      return `확인된 중복 후보입니다.\n${lines.join('\n')}`;
    }

    if (/구버전|버전|최신/.test(q)) {
      if (!versions.length) return '같은 계열로 판단되는 여러 버전을 찾지 못했습니다.';
      return `버전 관련 확인 항목이 ${versions.length}건 있습니다.\n` + versions.slice(0,8).map(i=>`• ${i.detail}`).join('\n');
    }

    if (/충돌|위험|문제/.test(q)) {
      if (!conflicts.length) return '같은 저장 키나 선택자, 통신 후킹을 공유하는 뚜렷한 충돌 후보를 찾지 못했습니다.';
      return `충돌 가능성이 높은 항목은 ${conflicts.length}건입니다.\n` + conflicts.slice(0,8).map(i=>`• ${i.detail}`).join('\n');
    }

    const featureMatch = featureRules.find(([label, re]) => re.test(q) || q.includes(label.replace(/·/g,' ')));
    const domainMatches = uniq(state.scripts.flatMap(s=>s.domains)).filter(d => d !== '사이트 미표기' && q.includes(d.replace(/^\*\./,'')));
    const nameMatches = state.scripts.filter(s => q.includes(s.meta.name.toLowerCase()) || s.meta.name.toLowerCase().includes(q)).slice(0,8);
    let filtered = [];
    if (featureMatch) filtered = state.scripts.filter(s => s.signals.features.includes(featureMatch[0]));
    else if (domainMatches.length) filtered = state.scripts.filter(s => s.domains.some(d=>domainMatches.includes(d)));
    else if (nameMatches.length) filtered = nameMatches;
    else {
      const tokens = q.split(/\s+/).filter(x=>x.length>=2);
      filtered = state.scripts.filter(s => tokens.some(t => [s.meta.name,s.summary,...s.domains,...s.signals.features].join(' ').toLowerCase().includes(t))).slice(0,10);
    }
    if (filtered.length) return `관련 가능성이 높은 스크립트는 ${filtered.length}개입니다.\n` + filtered.slice(0,10).map(s=>`• ${s.meta.name} ${s.meta.version}: ${s.summary}`).join('\n');

    return `현재 ${state.scripts.length}개 스크립트에서 완전 중복 ${exact.length}건, 버전 문제 ${versions.length}건, 기능 중복·충돌 후보 ${overlaps.length + conflicts.length}건을 찾았습니다. “뭐가 중복이야?”, “충돌 위험 높은 것만 알려줘”, “배경 관련 스크립트 찾아줘”처럼 질문해보세요.`;
  }

  function applyTone(text, preset, intensity = 'light', title = '', customEnding = '') {
    if (!text) return '';
    const every = intensity === 'strong' ? 1 : intensity === 'medium' ? 1 : 2;
    let sentenceIndex = 0;
    const styled = text.split(/(\n+)/).map(part => {
      if (/^\n+$/.test(part)) return part;
      const lines = part.split(/(?<=[.!?。])\s+/);
      return lines.map(line => {
        if (!line.trim()) return line;
        sentenceIndex++;
        const active = sentenceIndex % every === 0 || intensity === 'strong';
        if (!active && !['casual','polite','blunt'].includes(preset)) return line;
        return transformSentence(line, preset, customEnding);
      }).join(' ');
    }).join('');
    const prefix = title.trim() ? `${title.trim()}, ` : preset === 'court' ? '전하, ' : preset === 'maid' ? '주인님, ' : '';
    return prefix + styled;
  }

  function transformSentence(line, preset, customEnding) {
    const preserveBullet = line.match(/^(\s*[•\-*]\s*)/i)?.[1] || '';
    let s = preserveBullet ? line.slice(preserveBullet.length) : line;
    const punctuation = s.match(/([.!?。]+)$/)?.[1] || '';
    s = s.replace(/[.!?。]+$/, '');
    if (preset === 'default') return line;
    if (preset === 'custom') return preserveBullet + s + (customEnding ? ` ${customEnding.replace(/^~/,'')}` : '') + (punctuation || '.');
    if (preset === 'casual') {
      s = s.replace(/합니다$/,'해').replace(/됩니다$/,'돼').replace(/입니다$/,'이야').replace(/있습니다$/,'있어').replace(/없습니다$/,'없어').replace(/하세요$/,'해봐').replace(/좋습니다$/,'좋아');
      return preserveBullet + s + (punctuation || '.');
    }
    if (preset === 'polite') {
      if (!/(요|니다|세요|십시오)$/.test(s)) s += '요';
      return preserveBullet + s + (punctuation || '.');
    }
    if (preset === 'cat') {
      s = s.replace(/합니다$/,'한다냥').replace(/됩니다$/,'된다냥').replace(/입니다$/,'이다냥').replace(/있습니다$/,'있다냥').replace(/없습니다$/,'없다냥').replace(/하세요$/,'해보라냥').replace(/좋습니다$/,'좋다냥');
      if (!/냥$/.test(s)) s += '냥';
      return preserveBullet + s + (punctuation || '.');
    }
    if (preset === 'court') {
      s = s.replace(/합니다$/,'하옵니다').replace(/됩니다$/,'되옵니다').replace(/입니다$/,'이옵니다').replace(/있습니다$/,'있사옵니다').replace(/없습니다$/,'없사옵니다').replace(/하세요$/,'하시옵소서').replace(/좋습니다$/,'훌륭하옵니다');
      if (!/(옵니다|사옵니다|옵소서|이옵니다)$/.test(s)) s += '이옵니다';
      return preserveBullet + s + (punctuation || '.');
    }
    if (preset === 'military') {
      s = s.replace(/합니다$/,'합니다').replace(/됩니다$/,'됩니다').replace(/입니다$/,'입니다').replace(/하세요$/,'하십시오');
      if (!/(니다|십시오)$/.test(s)) s += '입니다';
      return preserveBullet + s + (punctuation || '!');
    }
    if (preset === 'maid') {
      s = s.replace(/합니다$/,'해드릴게요').replace(/됩니다$/,'된답니다').replace(/입니다$/,'이에요').replace(/있습니다$/,'있어요').replace(/없습니다$/,'없어요').replace(/하세요$/,'해주세요');
      if (!/(요|니다)$/.test(s)) s += '예요';
      return preserveBullet + s + (punctuation || '.');
    }
    if (preset === 'blunt') {
      s = s.replace(/합니다$/,'한다').replace(/됩니다$/,'된다').replace(/입니다$/,'이다').replace(/있습니다$/,'있다').replace(/없습니다$/,'없다').replace(/하세요$/,'하면 된다');
      if (!/(다|된다)$/.test(s)) s += '다';
      return preserveBullet + s + (punctuation || '.');
    }
    return line;
  }

  function appendChat(role, text, persist = true) {
    const container = $('#chatMessages');
    const div = document.createElement('div');
    div.className = `message ${role}`;
    div.innerHTML = `<div class="bubble">${esc(text)}</div>`;
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
    if (persist) {
      state.chatHistory.push({role,text,at:Date.now()});
      state.chatHistory = state.chatHistory.slice(-40);
      saveState();
    }
  }

  function renderChatHistory() {
    const container = $('#chatMessages');
    container.innerHTML = '<div class="message assistant"><div class="bubble">안녕하세요. 파일을 불러온 뒤 “뭐가 중복이야?”, “크랙 배경 관련 스크립트 찾아줘”, “뭘 꺼도 돼?”처럼 물어보세요.</div></div>';
    for (const m of state.chatHistory || []) appendChat(m.role, m.text, false);
  }


  function openDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(DB_STORE)) request.result.createObjectStore(DB_STORE);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('IndexedDB를 열 수 없습니다.'));
    });
  }

  async function dbSet(key, value) {
    const db = await openDatabase();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, 'readwrite');
      tx.objectStore(DB_STORE).put(value, key);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error || new Error('저장하지 못했습니다.'));
    });
    db.close();
  }

  async function dbGet(key) {
    const db = await openDatabase();
    const value = await new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, 'readonly');
      const request = tx.objectStore(DB_STORE).get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('저장 데이터를 읽지 못했습니다.'));
    });
    db.close();
    return value;
  }

  async function dbDelete(key) {
    const db = await openDatabase();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, 'readwrite');
      tx.objectStore(DB_STORE).delete(key);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error || new Error('저장 데이터를 지우지 못했습니다.'));
    });
    db.close();
  }

  async function saveState() {
    try { await dbSet(STORAGE_KEY, state); }
    catch (e) { console.warn('저장 실패', e); toast('브라우저 저장 공간이 부족하거나 차단됐습니다.'); }
  }

  async function loadState() {
    try {
      const saved = await dbGet(STORAGE_KEY);
      if (saved) {
        state = saved;
        state.settings = {...DEFAULT_SETTINGS, ...(state.settings || {})};
        state.chatHistory ||= [];
        state.scripts ||= [];
        state.issues ||= [];
      }
    } catch (e) { console.warn('저장 데이터 불러오기 실패', e); }
  }

  async function importFiles(files) {
    if (!files?.length) return;
    toast('스크립트를 읽고 있습니다…');
    try {
      const incoming = await readInputFiles(files);
      if (!incoming.length) throw new Error('유저스크립트를 찾지 못했습니다.');
      const map = new Map(state.scripts.map(s => [s.id,s]));
      incoming.forEach(s => map.set(s.id,s));
      state.scripts = [...map.values()];
      state.importedAt = Date.now();
      analyzeAll();
      switchView('overview');
      toast(`${incoming.length}개 스크립트를 불러왔습니다.`);
    } catch (e) {
      console.error(e); toast(`불러오기 실패: ${e.message}`);
    }
  }

  function exportReport() {
    const now = new Date();
    const issueRows = state.issues.map(i => `<article><h3>${esc(i.title)}</h3><p>${esc(i.detail)}</p></article>`).join('');
    const scriptRows = state.scripts.map(s => `<article><h3>${esc(s.meta.name)} <small>${esc(s.meta.version)}</small></h3><p>${esc(s.summary)}</p><p><b>사이트:</b> ${esc(s.domains.join(', '))}</p><p><b>상태:</b> ${esc(s.risks.join(', ') || '특이사항 없음')}</p></article>`).join('');
    const html = `<!doctype html><html lang="ko"><meta charset="utf-8"><title>몽키 어시스턴트 분석 보고서</title><style>body{font:14px/1.7 system-ui;max-width:980px;margin:40px auto;padding:0 20px;color:#222}article{border:1px solid #ddd;border-radius:10px;padding:14px 16px;margin:10px 0}small{color:#777}h1,h2{margin-top:32px}</style><h1>몽키 어시스턴트 분석 보고서</h1><p>생성: ${now.toLocaleString('ko-KR')}</p><p>스크립트 ${state.scripts.length}개 · 문제 후보 ${state.issues.length}건</p><h2>중복·충돌</h2>${issueRows || '<p>특이사항 없음</p>'}<h2>스크립트</h2>${scriptRows}</html>`;
    const blob = new Blob([html], {type:'text/html;charset=utf-8'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `monkey-assistant-report-${now.toISOString().slice(0,10)}.html`; a.click();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
  }

  function switchView(name) {
    $$('.nav-item').forEach(b=>b.classList.toggle('active',b.dataset.view===name));
    $$('.view').forEach(v=>v.classList.toggle('active',v.dataset.viewPanel===name));
    const panel = $(`[data-view-panel="${name}"]`);
    if (panel) panel.scrollIntoView({behavior:'smooth', block:'start'});
    history.replaceState(null, '', `#${name}`);
  }

  function toast(message) {
    const el = $('#toast'); el.textContent = message; el.classList.add('show');
    clearTimeout(toast.timer); toast.timer = setTimeout(()=>el.classList.remove('show'),2700);
  }

  function initToneSelects() {
    const el = $('#assistantTone');
    el.innerHTML = Object.entries(tonePresets).map(([v,l])=>`<option value="${v}">${l}</option>`).join('');
  }

  function bindEvents() {
    $$('.nav-item').forEach(b=>b.addEventListener('click',()=>switchView(b.dataset.view)));
    $$('[data-jump]').forEach(b=>b.addEventListener('click',()=>switchView(b.dataset.jump)));
    const openPicker=()=>$('#fileInput').click();
    $('#importBtn').addEventListener('click',openPicker);
    $('#heroImportBtn').addEventListener('click',openPicker);
    $('#dropZone').addEventListener('click',openPicker);
    $('#dropZone').addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();openPicker();}});
    $('#fileInput').addEventListener('change',e=>{ importFiles([...e.target.files]); e.target.value=''; });
    $('#exportBtn').addEventListener('click',exportReport);
    const dz = $('#dropZone');
    ['dragenter','dragover'].forEach(ev=>dz.addEventListener(ev,e=>{e.preventDefault();dz.classList.add('dragover');}));
    ['dragleave','drop'].forEach(ev=>dz.addEventListener(ev,e=>{e.preventDefault();dz.classList.remove('dragover');}));
    dz.addEventListener('drop',e=>importFiles([...e.dataTransfer.files]));
    $('#scriptSearch').addEventListener('input',renderScripts);
    $('#domainFilter').addEventListener('change',renderScripts);
    $('#riskFilter').addEventListener('change',renderScripts);
    document.addEventListener('click',e=>{ const card=e.target.closest('[data-script-id]'); if(card) showScriptDialog(card.dataset.scriptId); });
    $('#dialogClose').addEventListener('click',()=>$('#scriptDialog').close());
    $('#scriptDialog').addEventListener('click',e=>{if(e.target===$('#scriptDialog'))$('#scriptDialog').close();});
    $$('.issue-tab').forEach(b=>b.addEventListener('click',()=>{ $$('.issue-tab').forEach(x=>x.classList.remove('active')); b.classList.add('active'); renderIssues(b.dataset.issueFilter); }));

    const widget=$('#chatWidget');
    const setChatOpen=open=>{widget.classList.toggle('open',open);widget.setAttribute('aria-hidden',String(!open));if(open)setTimeout(()=>$('#chatInput').focus(),80);};
    $('#chatLauncher').addEventListener('click',()=>setChatOpen(!widget.classList.contains('open')));
    $('#chatCloseBtn').addEventListener('click',()=>setChatOpen(false));
    $('#chatSettingsBtn').addEventListener('click',()=>{const box=$('#chatSettings');const open=!box.classList.contains('open');box.classList.toggle('open',open);box.setAttribute('aria-hidden',String(!open));});
    $('.quick-prompts').addEventListener('click',e=>{ if(e.target.tagName==='BUTTON'){ $('#chatInput').value=e.target.textContent; $('#chatForm').requestSubmit(); }});
    $('#chatForm').addEventListener('submit',e=>{
      e.preventDefault(); const q=$('#chatInput').value.trim(); if(!q)return;
      appendChat('user',q); $('#chatInput').value=''; $('#chatInput').style.height='auto';
      const base=answerQuestion(q);
      const styled=applyTone(base,$('#assistantTone').value,$('#assistantIntensity').value,$('#assistantTitle').value,$('#assistantCustomEnding').value);
      window.setTimeout(()=>appendChat('assistant',styled),120);
    });
    $('#chatInput').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();$('#chatForm').requestSubmit();}});
    $('#chatInput').addEventListener('input',e=>{e.target.style.height='auto';e.target.style.height=Math.min(e.target.scrollHeight,120)+'px';});
    for (const id of ['assistantTone','assistantIntensity','assistantTitle','assistantCustomEnding']) {
      $('#' + id).addEventListener(id.includes('Title')||id.includes('Ending')?'input':'change',()=>{
        state.settings.tone=$('#assistantTone').value;
        state.settings.intensity=$('#assistantIntensity').value;
        state.settings.title=$('#assistantTitle').value;
        state.settings.customEnding=$('#assistantCustomEnding').value;
        $('#customEndingRow').hidden=state.settings.tone !== 'custom';
        saveState();
      });
    }
    $('#ignoreDisabled').addEventListener('change',e=>{state.settings.ignoreDisabled=e.target.checked;saveState();});
    $('#similarityThreshold').addEventListener('input',e=>{$('#thresholdValue').textContent=`${e.target.value}%`;});
    $('#similarityThreshold').addEventListener('change',e=>{state.settings.similarityThreshold=Number(e.target.value);saveState();});
    $('#reanalyzeBtn').addEventListener('click',()=>{state.settings.ignoreDisabled=$('#ignoreDisabled').checked;state.settings.similarityThreshold=Number($('#similarityThreshold').value);analyzeAll();toast('현재 설정으로 다시 분석했습니다.');});
    $('#clearDataBtn').addEventListener('click',async()=>{if(!confirm('불러온 스크립트와 분석 결과를 모두 지울까요?'))return;state={scripts:[],issues:[],importedAt:null,settings:{...DEFAULT_SETTINGS},chatHistory:[]};await dbDelete(STORAGE_KEY);applySettingsToUI();renderAll();toast('로컬 데이터를 지웠습니다.');});
    $('#themeToggle').addEventListener('click',()=>{state.settings.theme=(document.documentElement.dataset.theme==='dark'?'light':'dark');applySettingsToUI();saveState();});
    document.addEventListener('keydown',e=>{if(e.key==='Escape'&&widget.classList.contains('open'))setChatOpen(false);});
  }

  function applySettingsToUI() {
    $('#assistantTone').value=state.settings.tone;
    $('#assistantIntensity').value=state.settings.intensity;
    $('#assistantTitle').value=state.settings.title;
    $('#assistantCustomEnding').value=state.settings.customEnding || '';
    $('#customEndingRow').hidden=state.settings.tone !== 'custom';
    $('#ignoreDisabled').checked=state.settings.ignoreDisabled;
    $('#similarityThreshold').value=state.settings.similarityThreshold;
    $('#thresholdValue').textContent=`${state.settings.similarityThreshold}%`;
    document.documentElement.dataset.theme=state.settings.theme || 'dark';
    $('.theme-icon').textContent=(state.settings.theme || 'dark') === 'dark' ? '☾' : '☀';
  }

  async function init() {
    initToneSelects(); bindEvents(); await loadState(); applySettingsToUI(); renderAll();
    const initial=location.hash.replace('#','');
    if (['overview','scripts','issues','settings'].includes(initial)) switchView(initial);
  }

  init().catch(e=>{console.error(e);toast('초기화 중 오류가 발생했습니다.');});
})();
