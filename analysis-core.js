(function attachMonkeyAssistantCore(root, factory) {
  'use strict';

  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MonkeyAssistantCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createMonkeyAssistantCore() {
  'use strict';

  const CORE_VERSION = '0.4.0';
  const MAX_FACTS = 160;
  const MAX_SHINGLES = 384;
  const MAX_SHINGLE_WINDOWS = 8192;
  const operationKeySets = new WeakMap();

  const ACTION_LABELS = Object.freeze({
    read: '읽음',
    write: '바꿈',
    remove: '지움',
    listen: '지켜봄',
    block: '기본 동작을 막음',
    call: '사용함',
    patch: '가로챔',
    delete: '삭제함',
    watch: '반복해서 확인함'
  });

  const RELATIONSHIP_LABELS = Object.freeze({
    exact_duplicate: '완전히 같은 복사본',
    older_version: '같은 계열의 구버전',
    same_version_variant: '버전 번호는 같지만 내용이 다른 복사본',
    functional_fork: '같은 뿌리에서 기능이 갈라진 변형판',
    same_family: '같은 계열',
    unrelated: '서로 다른 스크립트'
  });

  function unique(values) {
    return [...new Set((values || []).filter(value => value !== '' && value != null))].sort();
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function round(value, digits = 3) {
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
  }

  function fnv1a(text) {
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  }

  function fnv1aTokenWindow(tokens, start, width) {
    let hash = 0x811c9dc5;
    for (let offset = 0; offset < width; offset += 1) {
      const token = tokens[start + offset];
      if (offset) {
        hash ^= 1; // same separator as tokens.join('\u0001')
        hash = Math.imul(hash, 0x01000193);
      }
      for (let index = 0; index < token.length; index += 1) {
        hash ^= token.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
      }
    }
    return hash >>> 0;
  }

  function normalizeLineEndings(text) {
    return String(text || '').replace(/\r\n?/g, '\n');
  }

  function removeMetadataBlock(code) {
    return normalizeLineEndings(code).replace(
      /^\s*\/\/\s*==UserScript==[\s\S]*?^\s*\/\/\s*==\/UserScript==\s*/im,
      ''
    );
  }

  // A deliberately small scanner. It retains quoted strings and regular expressions so
  // patterns such as /[/*]/ are never mistaken for a block comment.
  function stripComments(code) {
    const source = normalizeLineEndings(code);
    const chunks = [];
    let buffer = '';
    const append = value => {
      buffer += value;
      if (buffer.length >= 8192) {
        chunks.push(buffer);
        buffer = '';
      }
    };
    let state = 'code';
    let escaped = false;
    let regexClass = false;
    let lastSignificant = '';

    for (let index = 0; index < source.length; index += 1) {
      const char = source[index];
      const next = source[index + 1];

      if (state === 'line-comment') {
        if (char === '\n') {
          append('\n');
          state = 'code';
        }
        continue;
      }

      if (state === 'block-comment') {
        if (char === '*' && next === '/') {
          index += 1;
          state = 'code';
        } else if (char === '\n') {
          append('\n');
        }
        continue;
      }

      if (state === 'single' || state === 'double' || state === 'template') {
        append(char);
        if (escaped) {
          escaped = false;
          continue;
        }
        if (char === '\\') {
          escaped = true;
          continue;
        }
        if ((state === 'single' && char === "'") ||
            (state === 'double' && char === '"') ||
            (state === 'template' && char === '`')) {
          state = 'code';
        }
        continue;
      }

      if (state === 'regex') {
        append(char);
        if (escaped) {
          escaped = false;
          continue;
        }
        if (char === '\\') {
          escaped = true;
          continue;
        }
        if (char === '[') regexClass = true;
        else if (char === ']') regexClass = false;
        else if (char === '/' && !regexClass) {
          while (/[a-z]/i.test(source[index + 1] || '')) append(source[index += 1]);
          state = 'code';
          lastSignificant = source[index] || '/';
        } else if (char === '\n') {
          state = 'code';
          regexClass = false;
        }
        continue;
      }

      if (char === '/' && next === '/') {
        state = 'line-comment';
        index += 1;
        continue;
      }
      if (char === '/' && next === '*') {
        state = 'block-comment';
        index += 1;
        continue;
      }
      if (char === '/') {
        const previous = lastSignificant;
        const keywordContext = /(?:^|[^\w$])(return|throw|case|delete|typeof|void|new|instanceof|in|of|yield|await)\s*$/.test(
          source.slice(Math.max(0, index - 64), index)
        );
        if (!previous || /[({[=,:;!?&|+\-*%^~<>]/.test(previous) || keywordContext || next === '[') {
          state = 'regex';
          regexClass = false;
          append(char);
          lastSignificant = char;
          continue;
        }
      }
      if (char === "'") state = 'single';
      if (char === '"') state = 'double';
      if (char === '`') state = 'template';
      append(char);
      if (char !== ' ' && char !== '\t' && char !== '\n' && char !== '\r' && char !== '\f') {
        lastSignificant = char;
      }
    }
    if (buffer) chunks.push(buffer);
    return chunks.join('');
  }

  function canonicalSource(code) {
    return normalizeLineEndings(removeMetadataBlock(code))
      .split('\n')
      .map(line => line.replace(/[ \t]+$/g, ''))
      .join('\n')
      .trim();
  }

  function tokenize(code) {
    const source = stripComments(removeMetadataBlock(code));
    return source.match(/[A-Za-z_$][\w$]*|\d+(?:\.\d+)?|===|!==|=>|==|!=|<=|>=|&&|\|\||\?\?|\?\.|[{}()[\].,:;+*%<>=!?&|/-]/g) || [];
  }

  function tokenShingles(code, width = 5) {
    const tokens = tokenize(code);
    if (!tokens.length) return [];
    if (tokens.length <= width) return [fnv1a(tokens.join('\u0001'))];

    // Keep the same deterministic smallest-hash sample as the former
    // unique(hashes).sort().slice(0, MAX_SHINGLES), without retaining every
    // shingle from multi-megabyte scripts. `heap[0]` is the current largest
    // value among the smallest MAX_SHINGLES values seen so far.
    const heap = [];
    const selected = new Set();
    const swap = (left, right) => { [heap[left], heap[right]] = [heap[right], heap[left]]; };
    const siftUp = index => {
      while (index > 0) {
        const parent = Math.floor((index - 1) / 2);
        if (heap[parent] >= heap[index]) break;
        swap(parent, index);
        index = parent;
      }
    };
    const siftDown = index => {
      while (true) {
        const left = index * 2 + 1;
        const right = left + 1;
        let largest = index;
        if (left < heap.length && heap[left] > heap[largest]) largest = left;
        if (right < heap.length && heap[right] > heap[largest]) largest = right;
        if (largest === index) break;
        swap(index, largest);
        index = largest;
      }
    };
    const windowCount = tokens.length - width + 1;
    const sampledWindows = Math.min(windowCount, MAX_SHINGLE_WINDOWS);
    for (let sample = 0; sample < sampledWindows; sample += 1) {
      const index = sampledWindows === windowCount
        ? sample
        : Math.floor(sample * (windowCount - 1) / (sampledWindows - 1));
      const hash = fnv1aTokenWindow(tokens, index, width);
      if (selected.has(hash)) continue;
      if (heap.length < MAX_SHINGLES) {
        heap.push(hash);
        selected.add(hash);
        siftUp(heap.length - 1);
      } else if (hash < heap[0]) {
        selected.delete(heap[0]);
        heap[0] = hash;
        selected.add(hash);
        siftDown(0);
      }
    }
    return heap
      .sort((left, right) => left - right)
      .map(hash => hash.toString(16).padStart(8, '0'));
  }

  function jaccard(left, right) {
    const a = new Set(left || []);
    const b = new Set(right || []);
    // "둘 다 관찰된 행동이 없음"은 닮았다는 증거가 아니다.
    if (!a.size && !b.size) return 0;
    if (!a.size || !b.size) return 0;
    let shared = 0;
    for (const value of a) if (b.has(value)) shared += 1;
    return shared / (a.size + b.size - shared);
  }

  function parseMetadata(code) {
    const block = normalizeLineEndings(code).match(
      /\/\/\s*==UserScript==([\s\S]*?)\/\/\s*==\/UserScript==/i
    )?.[1] || '';
    const all = {};
    for (const line of block.split('\n')) {
      const match = line.match(/^\s*\/\/\s*@([^\s]+)\s*(.*?)\s*$/);
      if (!match) continue;
      const key = match[1];
      (all[key] ||= []).push(match[2]);
    }
    const first = key => all[key]?.[0] || '';
    const canonicalName = first('name') || first('name:ko-KR') || first('name:ko') || '이름 없는 스크립트';
    const displayName = first('name:ko-KR') || first('name:ko') || canonicalName;
    return {
      all,
      // name은 기존 UI 호환용 표시 이름이다. 계열 판정에는 canonicalName만 사용한다.
      name: displayName,
      displayName,
      canonicalName,
      namespace: first('namespace'),
      version: first('version') || '버전 미표기',
      description: first('description:ko-KR') || first('description:ko') || first('description'),
      author: first('author'),
      matches: unique([...(all.match || []), ...(all.include || [])]),
      excludes: unique([...(all.exclude || []), ...(all['exclude-match'] || [])]),
      grants: unique(all.grant || []),
      requires: unique(all.require || []),
      connects: unique(all.connect || []),
      runAt: first('run-at') || 'document-idle',
      updateURL: first('updateURL') || first('update-url'),
      downloadURL: first('downloadURL') || first('download-url'),
      homepageURL: first('homepageURL') || first('homepage') || first('website') || first('source')
    };
  }

  function normalizeMetadata(provided, code) {
    const parsed = parseMetadata(code);
    if (!provided || typeof provided !== 'object' || Array.isArray(provided)) return parsed;
    const incoming = provided;
    const hasCanonicalInCode = Boolean(parsed.all?.name?.[0]);
    const canonicalName = String(
      incoming.canonicalName ||
      (hasCanonicalInCode ? parsed.canonicalName : '') ||
      incoming.name || incoming.displayName || parsed.canonicalName
    );
    const displayName = String(incoming.displayName || incoming.name || parsed.displayName || canonicalName);
    const list = key => unique(Array.isArray(incoming[key]) ? incoming[key].map(String) : parsed[key]);
    const string = key => String(incoming[key] == null ? parsed[key] : incoming[key]);
    return {
      ...parsed,
      ...incoming,
      all: incoming.all && typeof incoming.all === 'object' && !Array.isArray(incoming.all)
        ? { ...parsed.all, ...incoming.all }
        : parsed.all,
      name: displayName,
      displayName,
      canonicalName,
      namespace: string('namespace'),
      version: string('version'),
      description: string('description'),
      author: string('author'),
      matches: list('matches'),
      excludes: list('excludes'),
      grants: list('grants'),
      requires: list('requires'),
      connects: list('connects'),
      runAt: string('runAt'),
      updateURL: string('updateURL'),
      downloadURL: string('downloadURL'),
      homepageURL: string('homepageURL')
    };
  }

  function normalizeName(name) {
    return String(name || '')
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[\u{1F000}-\u{1FAFF}\u2600-\u27BF]/gu, ' ')
      .replace(/\b(?:ver(?:sion)?|v)\s*\d+(?:\.\d+){0,4}(?:[-+][\w.-]+)?\b/gi, ' ')
      .replace(/\s*[([]\s*(?:copy|복사본|구버전|old)\s*[)\]]\s*/gi, ' ')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim()
      .replace(/\s+/g, ' ');
  }

  function normalizeUrl(value) {
    const text = String(value || '').trim();
    if (!text) return '';
    try {
      const url = new URL(text);
      url.hash = '';
      // URL 경로는 대소문자를 구분할 수 있고 쿼리는 서로 다른 배포 채널일 수 있다.
      // 브라우저가 안전하게 정규화하는 scheme/host/default port만 맡기고 fragment만 뺀다.
      return url.toString();
    } catch {
      return text.replace(/#.*$/, '');
    }
  }

  function parseVersion(value) {
    const raw = String(value || '').trim();
    if (!raw || /미표기/.test(raw)) return { raw, valid: false, numbers: [], prerelease: [], build: [] };
    const cleaned = raw.replace(/^[vV]\s*/, '');
    const match = cleaned.match(/^(\d+(?:\.\d+)*)(?:-([0-9A-Za-z][0-9A-Za-z.-]*))?(?:\+([0-9A-Za-z][0-9A-Za-z.-]*))?$/);
    if (!match) return { raw, valid: false, numbers: [], prerelease: [], build: [] };
    return {
      raw,
      valid: true,
      numbers: match[1].split('.').map(part => Number(part)),
      prerelease: match[2] ? match[2].toLowerCase().split('.').filter(Boolean) : [],
      build: match[3] ? match[3].split('.').filter(Boolean) : []
    };
  }

  function comparePrereleaseIdentifier(left, right) {
    if (left === right) return 0;
    const numericA = /^\d+$/.test(left);
    const numericB = /^\d+$/.test(right);
    if (numericA && numericB) {
      const a = BigInt(left);
      const b = BigInt(right);
      return a === b ? 0 : a < b ? -1 : 1;
    }
    if (numericA !== numericB) return numericA ? -1 : 1;

    // 흔한 beta10 같은 표기도 사람이 기대하는 숫자 순서로 비교한다.
    const chunksA = left.match(/\d+|\D+/g) || [left];
    const chunksB = right.match(/\d+|\D+/g) || [right];
    const length = Math.max(chunksA.length, chunksB.length);
    for (let index = 0; index < length; index += 1) {
      if (chunksA[index] == null) return -1;
      if (chunksB[index] == null) return 1;
      if (chunksA[index] === chunksB[index]) continue;
      const aNumber = /^\d+$/.test(chunksA[index]);
      const bNumber = /^\d+$/.test(chunksB[index]);
      if (aNumber && bNumber) {
        const a = BigInt(chunksA[index]);
        const b = BigInt(chunksB[index]);
        if (a !== b) return a < b ? -1 : 1;
      } else {
        return chunksA[index] < chunksB[index] ? -1 : 1;
      }
    }
    return 0;
  }

  function compareVersions(left, right) {
    const a = parseVersion(left);
    const b = parseVersion(right);
    if (a.valid && b.valid) {
      const length = Math.max(a.numbers.length, b.numbers.length);
      for (let index = 0; index < length; index += 1) {
        const difference = (a.numbers[index] || 0) - (b.numbers[index] || 0);
        if (difference) return difference < 0 ? -1 : 1;
      }
      if (!a.prerelease.length && b.prerelease.length) return 1;
      if (a.prerelease.length && !b.prerelease.length) return -1;
      const prereleaseLength = Math.max(a.prerelease.length, b.prerelease.length);
      for (let index = 0; index < prereleaseLength; index += 1) {
        if (a.prerelease[index] == null) return -1;
        if (b.prerelease[index] == null) return 1;
        const difference = comparePrereleaseIdentifier(a.prerelease[index], b.prerelease[index]);
        if (difference) return difference;
      }
      return 0;
    }
    // 해석할 수 없는 버전은 억지로 사전순 최신 판정을 하지 않는다.
    return a.raw === b.raw ? 0 : null;
  }

  function parseMatchPattern(raw) {
    const value = String(raw || '').trim();
    if (!value) return { raw: value, valid: false };
    if (value === '<all_urls>') {
      return { raw: value, valid: true, all: true, scheme: '*', host: '*', path: '/*' };
    }
    const match = value.match(/^([*a-z][\w+.-]*):\/\/([^/]+)(\/.*)?$/i);
    if (!match) return { raw: value, valid: false };
    return {
      raw: value,
      valid: true,
      all: false,
      scheme: match[1].toLowerCase(),
      host: match[2].toLowerCase(),
      path: match[3] || '/*'
    };
  }

  function hostPatternsOverlap(left, right) {
    if (left === '*' || right === '*') return true;
    const a = left.replace(/^\*\./, '');
    const b = right.replace(/^\*\./, '');
    if (a === b) return true;
    if (left.startsWith('*.') && (b === a || b.endsWith(`.${a}`))) return true;
    if (right.startsWith('*.') && (a === b || a.endsWith(`.${b}`))) return true;
    return false;
  }

  function pathPatternsOverlap(left, right) {
    const prefix = value => String(value || '/*').split('*')[0];
    const a = prefix(left);
    const b = prefix(right);
    return a.startsWith(b) || b.startsWith(a);
  }

  function matchPatternsOverlap(left, right) {
    const scheme = left.scheme === '*' || right.scheme === '*' || left.scheme === right.scheme;
    return scheme && hostPatternsOverlap(left.host, right.host) && pathPatternsOverlap(left.path, right.path);
  }

  // Returns true only when every URL covered by `target` is definitely covered by
  // `container`. False means "not proven", not necessarily "never covered".
  function patternCovers(container, target) {
    if (!container?.valid || !target?.valid) return false;
    if (container.all) return true;
    if (target.all && !container.all) return false;
    if (container.scheme !== '*' && container.scheme !== target.scheme) return false;

    const hostCovered = (() => {
      if (container.host === '*') return true;
      if (container.host === target.host) return true;
      if (!container.host.startsWith('*.')) return false;
      const base = container.host.slice(2);
      if (target.host.startsWith('*.')) {
        const targetBase = target.host.slice(2);
        return targetBase === base || targetBase.endsWith(`.${base}`);
      }
      return target.host === base || target.host.endsWith(`.${base}`);
    })();
    if (!hostCovered) return false;

    const containerPath = String(container.path || '/*');
    const targetPath = String(target.path || '/*');
    if (containerPath === '/*' || containerPath === '*') return true;
    if (containerPath === targetPath) return true;
    const stars = (containerPath.match(/\*/g) || []).length;
    if (stars !== 1 || !containerPath.endsWith('*')) return false;
    const prefix = containerPath.slice(0, -1);
    const targetPrefix = targetPath.split('*')[0];
    return targetPrefix.startsWith(prefix);
  }

  function scopesOverlap(left, right) {
    const metaA = left?.meta || left || {};
    const metaB = right?.meta || right || {};
    const rawPatternsA = Array.isArray(metaA.matches) ? metaA.matches : [];
    const rawPatternsB = Array.isArray(metaB.matches) ? metaB.matches : [];
    const parsedPatternsA = rawPatternsA.map(parseMatchPattern);
    const parsedPatternsB = rawPatternsB.map(parseMatchPattern);
    const patternsA = parsedPatternsA.filter(item => item.valid);
    const patternsB = parsedPatternsB.filter(item => item.valid);
    const excludesA = (Array.isArray(metaA.excludes) ? metaA.excludes : []).map(parseMatchPattern).filter(item => item.valid);
    const excludesB = (Array.isArray(metaB.excludes) ? metaB.excludes : []).map(parseMatchPattern).filter(item => item.valid);
    const hasUnknownMatches = parsedPatternsA.some(item => !item.valid) || parsedPatternsB.some(item => !item.valid);
    if (!patternsA.length || !patternsB.length) {
      return {
        overlap: null,
        confidence: 0.25,
        label: '적용 사이트를 확실히 알 수 없음',
        evidence: ['한쪽 이상에 @match/@include가 없거나 해석할 수 없습니다.']
      };
    }
    const hits = [];
    const excludedHits = [];
    for (const a of patternsA) {
      for (const b of patternsB) {
        if (!matchPatternsOverlap(a, b)) continue;
        const excludedByA = excludesA.some(exclude => patternCovers(exclude, b));
        const excludedByB = excludesB.some(exclude => patternCovers(exclude, a));
        if (excludedByA || excludedByB) excludedHits.push(`${a.raw} ↔ ${b.raw}`);
        else hits.push(`${a.raw} ↔ ${b.raw}`);
      }
    }
    if (hits.length) {
      return {
        overlap: true,
        confidence: hasUnknownMatches ? 0.82 : 0.96,
        label: '같은 페이지에서 실행될 수 있음',
        evidence: hits.slice(0, 6)
      };
    }
    if (hasUnknownMatches) {
      return {
        overlap: null,
        confidence: 0.36,
        label: '일부 실행 범위를 확실히 해석할 수 없음',
        evidence: ['해석할 수 없는 @include/@match가 있어 겹치지 않는다고 단정하지 않습니다.']
      };
    }
    if (excludedHits.length) {
      return {
        overlap: false,
        confidence: 0.9,
        label: '@exclude가 겹치는 범위를 제외함',
        evidence: excludedHits.slice(0, 6).map(value => `${value} (제외됨)`)
      };
    }
    return {
      overlap: false,
      confidence: 0.94,
      label: '실행되는 사이트가 다름',
      evidence: ['@match/@include 범위가 겹치지 않습니다.']
    };
  }

  function captureAll(source, regex, mapper = match => match[1], limit = MAX_FACTS) {
    const output = [];
    const expression = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : `${regex.flags}g`);
    let match;
    while ((match = expression.exec(source)) && output.length < limit) {
      const value = mapper(match);
      if (Array.isArray(value)) output.push(...value.slice(0, limit - output.length));
      else if (value != null) output.push(value);
      if (match[0] === '') expression.lastIndex += 1;
    }
    return output;
  }

  function normalizeSelector(selector) {
    return String(selector || '').trim().replace(/\s+/g, ' ').slice(0, 220);
  }

  function literalSelectorFrom(method, value) {
    const text = String(value || '').trim();
    if (!text) return '';
    if (/getElementById/i.test(method)) return `#${text}`;
    if (/getElementsByClassName/i.test(method)) return `.${text.split(/\s+/).filter(Boolean).join('.')}`;
    if (/getElementsByTagName/i.test(method)) return text.toLowerCase();
    return normalizeSelector(text);
  }

  function emptyFacts() {
    return {
      dom: { read: [], write: [], remove: [], listen: [] },
      storage: {
        local: { read: [], write: [], delete: [] },
        session: { read: [], write: [], delete: [] },
        gm: { read: [], write: [], delete: [], isolatedPerScript: true }
      },
      events: {
        listen: [],
        listenTargets: [],
        block: [],
        blockTargets: [],
        blockingMethods: [],
        blockUncertain: false
      },
      network: {
        fetch: { call: false, patch: false, endpointHints: [], changesRequest: false, changesResponse: false, replacesResult: false },
        xhr: { call: false, patch: false, endpointHints: [], changesRequest: false, changesResponse: false, replacesResult: false },
        websocket: { call: false, patch: false, endpointHints: [], changesRequest: false, changesResponse: false, replacesResult: false },
        history: { call: [], patch: [], listen: [] }
      },
      performance: {
        rapidIntervals: [],
        broadObservers: [],
        animationLoop: false,
        frequentEvents: [],
        repeatedDomScan: false,
        riskScore: 0
      },
      css: { selectors: [], properties: { read: [], write: [] }, writes: [] },
      operations: []
    };
  }

  function addOperation(facts, operation) {
    const key = [operation.kind, operation.channel || '', operation.action, operation.resource || ''].join('|');
    let keys = operationKeySets.get(facts);
    if (!keys) {
      keys = new Set((facts.operations || []).map(item => item.key));
      operationKeySets.set(facts, keys);
    }
    if (keys.has(key)) return;
    keys.add(key);
    facts.operations.push({ key, confidence: operation.confidence || 'high', ...operation });
  }

  function extractVariableTargets(source) {
    const variables = new Map();
    const selectorCalls = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:document\s*\.\s*)?(querySelector(?:All)?|getElementById|getElementsByClassName|getElementsByTagName)\s*\(\s*(['"`])([^'"`]{1,220})\3\s*\)/g;
    let match;
    while ((match = selectorCalls.exec(source))) {
      variables.set(match[1], literalSelectorFrom(match[2], match[4]));
      if (variables.size >= MAX_FACTS) break;
    }
    return variables;
  }

  function extractCssFacts(source, facts) {
    if (!source.includes('GM_addStyle') && !source.includes('textContent') &&
        !source.includes('innerHTML') && !source.includes('.style') &&
        !source.includes('getComputedStyle') && !source.includes('getPropertyValue')) return;
    const cssTexts = [];
    const argumentPattern = /\bGM_addStyle\s*\(\s*(['"`])([\s\S]*?)\1\s*\)/g;
    cssTexts.push(...captureAll(source, argumentPattern, match => match[2], 30));
    const textContentPattern = /\.\s*(?:textContent|innerHTML)\s*=\s*(['"`])([\s\S]{0,12000}?)\1/g;
    if (cssTexts.length < 30) {
      cssTexts.push(...captureAll(
        source,
        textContentPattern,
        match => /[{][^}]*[:;]/.test(match[2]) ? match[2] : null,
        30 - cssTexts.length
      ));
    }

    cssRules: for (const cssText of cssTexts) {
      const rulePattern = /([^{}]+)\{([^{}]*)\}/g;
      let rule;
      while ((rule = rulePattern.exec(cssText))) {
        if (facts.css.writes.length >= MAX_FACTS) break cssRules;
        const selectorPart = rule[1].trim();
        if (!selectorPart || selectorPart.startsWith('@')) continue;
        const remaining = MAX_FACTS - facts.css.writes.length;
        const selectors = selectorPart.split(',').slice(0, remaining).map(normalizeSelector).filter(Boolean);
        const declarations = captureAll(
          rule[2],
          /(?:^|;)\s*([--\w]+)\s*:\s*([^;}{]+)/g,
          match => ({
            property: match[1].toLowerCase(),
            value: match[2].trim().replace(/\s+/g, ' ').slice(0, 300)
          }),
          remaining
        );
        for (const selector of selectors) {
          for (const declaration of declarations) {
            if (facts.css.writes.length >= MAX_FACTS) break cssRules;
            facts.css.selectors.push(selector);
            facts.css.properties.write.push(declaration.property);
            facts.css.writes.push({ selector, property: declaration.property, value: declaration.value });
            addOperation(facts, {
              kind: 'css',
              channel: 'page',
              action: 'write',
              resource: `${selector}::${declaration.property}=${declaration.value}`
            });
          }
        }
      }
    }

    const propertyAssignments = captureAll(
      source,
      /\.style\.([A-Za-z_$][\w$]*)\s*=|\.style\.setProperty\s*\(\s*(['"`])([\w-]{1,80})\2/g,
      match => (match[1] || match[3] || '').replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)
    );
    facts.css.properties.write.push(...propertyAssignments);
    const propertyReads = captureAll(
      source,
      /(?:getComputedStyle\s*\([^)]*\)\s*\.\s*([A-Za-z_$][\w$]*)|getPropertyValue\s*\(\s*(['"`])([\w-]{1,80})\2)/g,
      match => match[1] || match[3]
    );
    facts.css.properties.read.push(...propertyReads);
  }

  function extractStorageFacts(source, facts) {
    if (!source.includes('Storage') && !source.includes('GM')) return;
    const specs = [
      ['local', 'read', /(?:window\s*\.\s*)?localStorage\s*\.\s*getItem\s*\(\s*(['"`])([^'"`]{1,180})\1/g],
      ['local', 'write', /(?:window\s*\.\s*)?localStorage\s*\.\s*setItem\s*\(\s*(['"`])([^'"`]{1,180})\1/g],
      ['local', 'delete', /(?:window\s*\.\s*)?localStorage\s*\.\s*removeItem\s*\(\s*(['"`])([^'"`]{1,180})\1/g],
      ['session', 'read', /(?:window\s*\.\s*)?sessionStorage\s*\.\s*getItem\s*\(\s*(['"`])([^'"`]{1,180})\1/g],
      ['session', 'write', /(?:window\s*\.\s*)?sessionStorage\s*\.\s*setItem\s*\(\s*(['"`])([^'"`]{1,180})\1/g],
      ['session', 'delete', /(?:window\s*\.\s*)?sessionStorage\s*\.\s*removeItem\s*\(\s*(['"`])([^'"`]{1,180})\1/g],
      ['gm', 'read', /\b(?:GM_getValue|GM\s*\.\s*getValue)\s*\(\s*(['"`])([^'"`]{1,180})\1/g],
      ['gm', 'write', /\b(?:GM_setValue|GM\s*\.\s*setValue)\s*\(\s*(['"`])([^'"`]{1,180})\1/g],
      ['gm', 'delete', /\b(?:GM_deleteValue|GM\s*\.\s*deleteValue)\s*\(\s*(['"`])([^'"`]{1,180})\1/g]
    ];
    for (const [channel, action, pattern] of specs) {
      const keys = captureAll(source, pattern, match => match[2]);
      facts.storage[channel][action].push(...keys);
      for (const key of keys) addOperation(facts, { kind: 'storage', channel, action, resource: key });
    }
  }

  function findMatchingDelimiter(source, openIndex, openChar, closeChar) {
    let depth = 0;
    let quote = '';
    let escaped = false;
    for (let index = openIndex; index < source.length; index += 1) {
      const char = source[index];
      if (quote) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === quote) quote = '';
        continue;
      }
      if (char === "'" || char === '"' || char === '`') {
        quote = char;
        continue;
      }
      if (char === openChar) depth += 1;
      else if (char === closeChar) {
        depth -= 1;
        if (depth === 0) return index;
      }
    }
    return -1;
  }

  function inlineCallbackSlice(source, startIndex) {
    const tail = source.slice(startIndex);
    const functionHead = tail.match(/^(?:async\s+)?function(?:\s+[A-Za-z_$][\w$]*)?\s*\([^)]*\)\s*\{/);
    if (functionHead) {
      const open = startIndex + functionHead[0].lastIndexOf('{');
      const close = findMatchingDelimiter(source, open, '{', '}');
      return close >= 0 ? source.slice(open + 1, close) : '';
    }
    const arrowHead = tail.match(/^(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*/);
    if (!arrowHead) return '';
    const bodyStart = startIndex + arrowHead[0].length;
    if (source[bodyStart] === '{') {
      const close = findMatchingDelimiter(source, bodyStart, '{', '}');
      return close >= 0 ? source.slice(bodyStart + 1, close) : '';
    }

    // Expression-bodied arrow: stop at the first top-level comma or listener call end.
    let paren = 0;
    let bracket = 0;
    let brace = 0;
    let quote = '';
    let escaped = false;
    for (let index = bodyStart; index < source.length; index += 1) {
      const char = source[index];
      if (quote) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === quote) quote = '';
        continue;
      }
      if (char === "'" || char === '"' || char === '`') { quote = char; continue; }
      if (char === '(') paren += 1;
      else if (char === ')') {
        if (!paren && !bracket && !brace) return source.slice(bodyStart, index);
        paren = Math.max(0, paren - 1);
      } else if (char === '[') bracket += 1;
      else if (char === ']') bracket = Math.max(0, bracket - 1);
      else if (char === '{') brace += 1;
      else if (char === '}') brace = Math.max(0, brace - 1);
      else if (char === ',' && !paren && !bracket && !brace) return source.slice(bodyStart, index);
    }
    return '';
  }

  function staticListenerTarget(source, dotIndex, variableTargets) {
    const prefix = source.slice(Math.max(0, dotIndex - 420), dotIndex);
    const globalTarget = prefix.match(/\b(document|window)\s*$/);
    if (globalTarget) return `@${globalTarget[1]}`;
    const directTarget = prefix.match(/(?:document\s*\.\s*)?(querySelector(?:All)?|getElementById|getElementsByClassName|getElementsByTagName)\s*\(\s*(['"`])([^'"`]{1,220})\2\s*\)\s*\?*$/);
    if (directTarget) return literalSelectorFrom(directTarget[1], directTarget[3]);
    const variableTarget = prefix.match(/\b([A-Za-z_$][\w$]*)\s*\?*$/);
    return variableTarget ? (variableTargets.get(variableTarget[1]) || '') : '';
  }

  function extractInlineBlockingEvents(source, variableTargets) {
    const blocked = [];
    const uncertain = [];
    const listener = /\.\s*addEventListener\s*\(\s*(['"`])([^'"`]{1,80})\1\s*,\s*/g;
    let match;
    while ((match = listener.exec(source)) && blocked.length + uncertain.length < MAX_FACTS) {
      const callback = inlineCallbackSlice(source, listener.lastIndex);
      if (/\.\s*(?:preventDefault|stopPropagation|stopImmediatePropagation)\s*\(/.test(callback)) {
        const target = staticListenerTarget(source, match.index, variableTargets);
        if (target) blocked.push(`${target}::${match[2]}`);
        else uncertain.push(match[2]);
      }
    }
    return { blocked: unique(blocked), uncertain: unique(uncertain) };
  }

  function extractDomFacts(source, facts) {
    const hasSelectors = source.includes('querySelector') || source.includes('getElementById') ||
      source.includes('getElementsByClassName') || source.includes('getElementsByTagName') ||
      source.includes('.matches') || source.includes('.closest');
    const hasListeners = source.includes('addEventListener');
    const hasCreatedMarkers = source.includes('.id') || source.includes('.className');
    if (!hasSelectors && !hasListeners && !hasCreatedMarkers) return;
    const variableTargets = extractVariableTargets(source);
    const selectorPattern = /\b(querySelector(?:All)?|getElementById|getElementsByClassName|getElementsByTagName|matches|closest)\s*\(\s*(['"`])([^'"`]{1,220})\2\s*\)/g;
    const reads = captureAll(source, selectorPattern, match => literalSelectorFrom(match[1], match[3]));
    facts.dom.read.push(...reads);
    for (const selector of reads) addOperation(facts, { kind: 'dom', channel: 'page', action: 'read', resource: selector });

    const directBase = "(?:document\\s*\\.\\s*)?(querySelector(?:All)?|getElementById|getElementsByClassName|getElementsByTagName)\\s*\\(\\s*(['\"`])([^'\"`]{1,220})\\2\\s*\\)";
    const directRemove = new RegExp(`${directBase}\\s*\\?*\\.\\s*remove\\s*\\(`, 'g');
    const directListen = new RegExp(`${directBase}\\s*\\?*\\.\\s*addEventListener\\s*\\(\\s*(['\"\\x60])([^'\"\\x60]{1,80})\\4`, 'g');
    const directWrite = new RegExp(`${directBase}\\s*\\?*\\.\\s*(?:textContent|innerHTML|outerHTML|value|className|id|disabled|hidden|checked|src|href|style(?:\\.[\\w$]+)?)\\s*=`, 'g');
    const directMutator = new RegExp(`${directBase}\\s*\\?*\\.\\s*(?:setAttribute|removeAttribute|append|appendChild|prepend|before|after|replaceWith|replaceChildren|insertAdjacent(?:HTML|Element|Text)|classList\\.(?:add|remove|toggle|replace))\\s*\\(`, 'g');

    const removed = captureAll(source, directRemove, match => literalSelectorFrom(match[1], match[3]));
    const listened = captureAll(source, directListen, match => ({ selector: literalSelectorFrom(match[1], match[3]), event: match[5] }));
    const written = [
      ...captureAll(source, directWrite, match => literalSelectorFrom(match[1], match[3])),
      ...captureAll(source, directMutator, match => literalSelectorFrom(match[1], match[3]))
    ];

    // Scan each use shape once. The previous implementation built several RegExp
    // objects and rescanned the full source for every selector variable (O(V × N)).
    const variableRemove = /\b([A-Za-z_$][\w$]*)\s*\?*\.\s*remove\s*\(/g;
    const variableWrite = /\b([A-Za-z_$][\w$]*)\s*\?*\.\s*(?:textContent|innerHTML|outerHTML|value|className|id|disabled|hidden|checked|src|href|style(?:\.[\w$]+)?)\s*=|\b([A-Za-z_$][\w$]*)\s*\?*\.\s*(?:setAttribute|removeAttribute|append|appendChild|prepend|before|after|replaceWith|replaceChildren|insertAdjacent(?:HTML|Element|Text)|classList\.(?:add|remove|toggle|replace))\s*\(/g;
    const variableListen = /\b([A-Za-z_$][\w$]*)\s*\?*\.\s*addEventListener\s*\(\s*(['"`])([^'"`]{1,80})\2/g;
    removed.push(...captureAll(source, variableRemove, match => variableTargets.get(match[1]) || null));
    written.push(...captureAll(source, variableWrite, match => variableTargets.get(match[1] || match[2]) || null));
    listened.push(...captureAll(source, variableListen, match => {
      const selector = variableTargets.get(match[1]);
      return selector ? { selector, event: match[3] } : null;
    }));

    const globalListenPattern = /\b(document|window)\s*\.\s*addEventListener\s*\(\s*(['"`])([^'"`]{1,80})\2/g;
    listened.push(...captureAll(source, globalListenPattern, match => ({ selector: `@${match[1]}`, event: match[3] })));

    const createdIds = captureAll(source, /\.\s*id\s*=\s*(['"`])([A-Za-z][\w:.-]{0,120})\1/g, match => `#${match[2]}`);
    const createdClasses = captureAll(source, /\.\s*className\s*=\s*(['"`])([^'"`]{1,180})\1/g, match => match[2].split(/\s+/).filter(Boolean).map(name => `.${name}`));
    written.push(...createdIds, ...createdClasses);

    facts.dom.remove.push(...removed);
    facts.dom.write.push(...written);
    facts.dom.listen.push(...listened.map(item => `${item.selector}::${item.event}`));
    facts.events.listen.push(...listened.map(item => item.event));
    facts.events.listenTargets.push(...listened.map(item => `${item.selector}::${item.event}`));
    for (const selector of removed) addOperation(facts, { kind: 'dom', channel: 'page', action: 'remove', resource: selector });
    for (const selector of written) addOperation(facts, { kind: 'dom', channel: 'page', action: 'write', resource: selector });
    for (const item of listened) addOperation(facts, { kind: 'dom', channel: item.event, action: 'listen', resource: item.selector });

    const blockingMethods = unique(captureAll(source, /\.\s*(preventDefault|stopPropagation|stopImmediatePropagation)\s*\(/g));
    facts.events.blockingMethods.push(...blockingMethods);
    const localBlocking = blockingMethods.length
      ? extractInlineBlockingEvents(source, variableTargets)
      : { blocked: [], uncertain: [] };
    facts.events.blockTargets.push(...localBlocking.blocked);
    facts.events.block.push(...localBlocking.blocked.map(value => value.slice(value.lastIndexOf('::') + 2)));
    facts.events.blockUncertain = blockingMethods.length > 0 &&
      (!localBlocking.blocked.length || localBlocking.uncertain.length > 0);
    if (localBlocking.blocked.length) {
      for (const targetEvent of localBlocking.blocked) {
        const split = targetEvent.lastIndexOf('::');
        const target = targetEvent.slice(0, split);
        const event = targetEvent.slice(split + 2);
        addOperation(facts, { kind: 'event', channel: event, action: 'block', resource: target, confidence: 'medium' });
      }
    }
  }

  function extractNetworkEndpointHints(source) {
    return unique(captureAll(
      source,
      /(['"`])((?:https?:\/\/[^'"`\s]{3,220}|\/(?:api|v\d+|graphql|chat|message|messages|conversation|conversations|completion|generate|generation|room|rooms|character|characters|log|logs)(?:\/[^'"`\s]*)?))\1/gi,
      match => match[2].replace(/[?#].*$/, '').replace(/\/$/, ''),
      80
    ));
  }

  function extractNetworkFacts(source, facts) {
    if (!source.includes('fetch') && !source.includes('XMLHttpRequest') &&
        !source.includes('WebSocket') && !source.includes('history') &&
        !source.includes('popstate') && !source.includes('hashchange')) return;
    const network = facts.network;
    network.fetch.patch = /\b(?:window|unsafeWindow|globalThis)\s*\.\s*fetch\s*=|Object\.defineProperty\s*\(\s*(?:window|unsafeWindow|globalThis)\s*,\s*['"`]fetch['"`]/.test(source);
    network.fetch.call = /(?:^|[^.\w$])fetch\s*\(/m.test(source) || /\b(?:window|unsafeWindow|globalThis)\s*\.\s*fetch\s*\(/.test(source);
    network.xhr.patch = /XMLHttpRequest\s*\.\s*prototype\s*\.\s*(?:open|send|setRequestHeader)\s*=|Object\.defineProperty\s*\(\s*XMLHttpRequest\s*\.\s*prototype/.test(source);
    network.xhr.call = /new\s+XMLHttpRequest\s*\(/.test(source);
    network.websocket.patch = /WebSocket\s*\.\s*prototype\s*\.\s*(?:send|close|addEventListener)\s*=|\b(?:window|unsafeWindow|globalThis)\s*\.\s*WebSocket\s*=/.test(source);
    network.websocket.call = /new\s+(?:window\s*\.\s*)?WebSocket\s*\(/.test(source);
    const endpointHints = extractNetworkEndpointHints(source);
    const changesRequest = /\bheaders?\s*\.\s*(?:set|append|delete)\s*\(|\b(?:args|arguments)\s*\[\s*[01]\s*\]\s*=(?!=)|\b(?:init|options|request)\s*\.\s*(?:body|headers|method|url)\s*=(?!=)|\bnew\s+Request\s*\(/i.test(source);
    const changesResponse = /\bnew\s+Response\s*\(|\bresponse(?:Text)?\s*=|\.\s*(?:json|text)\s*=\s*(?:async\s*)?(?:function|\()/i.test(source);
    const replacesResult = /\breturn\s+(?:Promise\s*\.\s*resolve\s*\(\s*)?new\s+Response\s*\(/i.test(source);
    for (const channel of ['fetch', 'xhr', 'websocket']) {
      if (!network[channel].call && !network[channel].patch) continue;
      network[channel].endpointHints.push(...endpointHints);
      network[channel].changesRequest = changesRequest;
      network[channel].changesResponse = changesResponse;
      network[channel].replacesResult = replacesResult;
    }
    network.history.call.push(...captureAll(source, /\bhistory\s*\.\s*(pushState|replaceState|back|forward|go)\s*\(/g));
    network.history.patch.push(...captureAll(source, /\bhistory\s*\.\s*(pushState|replaceState)\s*=|Object\.defineProperty\s*\(\s*history\s*,\s*(['"`])(pushState|replaceState)\2/g, match => match[1] || match[3]));
    network.history.listen.push(...captureAll(source, /addEventListener\s*\(\s*(['"`])(popstate|hashchange)\1/g, match => match[2]));

    for (const channel of ['fetch', 'xhr', 'websocket']) {
      network[channel].endpointHints = unique(network[channel].endpointHints).slice(0, MAX_FACTS);
      if (network[channel].call) addOperation(facts, { kind: 'network', channel, action: 'call', resource: channel });
      if (network[channel].patch) addOperation(facts, { kind: 'network', channel, action: 'patch', resource: channel });
    }
    for (const method of network.history.call) addOperation(facts, { kind: 'network', channel: 'history', action: 'call', resource: method });
    for (const method of network.history.patch) addOperation(facts, { kind: 'network', channel: 'history', action: 'patch', resource: method });
    for (const event of network.history.listen) addOperation(facts, { kind: 'network', channel: 'history', action: 'listen', resource: event });
  }

  function extractPerformanceFacts(source, facts) {
    const performance = facts.performance;
    const delays = captureAll(
      source,
      /\bsetInterval\s*\([\s\S]{0,800}?,\s*(\d{1,7})\s*\)/g,
      match => Number(match[1]),
      24
    ).filter(delay => Number.isFinite(delay) && delay > 0 && delay <= 250);
    performance.rapidIntervals.push(...delays);

    const observerCount = (source.match(/\bnew\s+MutationObserver\s*\(/g) || []).length;
    const observesWideTarget = /\.\s*observe\s*\(\s*(?:document(?:\s*[,)]|\s*\.\s*(?:body|documentElement))|document\s*\.\s*querySelector\s*\(\s*['"](?:body|html)['"]\s*\))/i.test(source);
    const observesSubtree = /\.\s*observe\s*\([\s\S]{0,1200}?\bsubtree\s*:\s*true/i.test(source);
    if (observerCount && observesWideTarget && observesSubtree) {
      performance.broadObservers.push('문서 전체 하위 변경 감시');
    }

    const animationCalls = (source.match(/\brequestAnimationFrame\s*\(/g) || []).length;
    performance.animationLoop = animationCalls >= 2;
    const frequentEvents = (facts.events.listenTargets || [])
      .map(value => String(value).slice(String(value).lastIndexOf('::') + 2))
      .filter(event => ['scroll', 'resize', 'mousemove', 'pointermove', 'touchmove', 'wheel', 'input'].includes(event));
    performance.frequentEvents.push(...frequentEvents);

    const scansManyElements = /\b(?:querySelectorAll|getElementsByClassName|getElementsByTagName|getClientRects|getBoundingClientRect)\s*\(/.test(source);
    const repeatsWork = delays.length || performance.broadObservers.length || performance.animationLoop || frequentEvents.length;
    performance.repeatedDomScan = Boolean(scansManyElements && repeatsWork);
    performance.riskScore = Math.min(10,
      Math.min(4, delays.length * 2) +
      Math.min(4, performance.broadObservers.length * 3) +
      (performance.animationLoop ? 1 : 0) +
      Math.min(2, frequentEvents.length) +
      (performance.repeatedDomScan ? 2 : 0)
    );

    for (const delay of delays) {
      addOperation(facts, { kind: 'performance', channel: 'timer', action: 'watch', resource: `setInterval ${delay}ms`, confidence: 'medium' });
    }
    for (const observer of performance.broadObservers) {
      addOperation(facts, { kind: 'performance', channel: 'dom', action: 'watch', resource: observer, confidence: 'medium' });
    }
    if (performance.animationLoop) {
      addOperation(facts, { kind: 'performance', channel: 'frame', action: 'watch', resource: 'requestAnimationFrame 반복', confidence: 'medium' });
    }
    for (const event of frequentEvents) {
      addOperation(facts, { kind: 'performance', channel: 'event', action: 'watch', resource: `${event} 반복 입력`, confidence: 'medium' });
    }
  }

  function finalizeFacts(facts) {
    for (const action of ['read', 'write', 'remove']) facts.dom[action] = unique(facts.dom[action]).slice(0, MAX_FACTS);
    facts.dom.listen = unique(facts.dom.listen).slice(0, MAX_FACTS);
    for (const channel of ['local', 'session', 'gm']) {
      for (const action of ['read', 'write', 'delete']) {
        facts.storage[channel][action] = unique(facts.storage[channel][action]).slice(0, MAX_FACTS);
      }
    }
    facts.events.listen = unique(facts.events.listen).slice(0, MAX_FACTS);
    facts.events.listenTargets = unique(facts.events.listenTargets).slice(0, MAX_FACTS);
    facts.events.block = unique(facts.events.block).slice(0, MAX_FACTS);
    facts.events.blockTargets = unique(facts.events.blockTargets).slice(0, MAX_FACTS);
    facts.events.blockingMethods = unique(facts.events.blockingMethods).slice(0, MAX_FACTS);
    facts.network.history.call = unique(facts.network.history.call).slice(0, MAX_FACTS);
    facts.network.history.patch = unique(facts.network.history.patch).slice(0, MAX_FACTS);
    facts.network.history.listen = unique(facts.network.history.listen).slice(0, MAX_FACTS);
    facts.performance.rapidIntervals = unique(facts.performance.rapidIntervals).sort((a, b) => a - b).slice(0, MAX_FACTS);
    facts.performance.broadObservers = unique(facts.performance.broadObservers).slice(0, MAX_FACTS);
    facts.performance.frequentEvents = unique(facts.performance.frequentEvents).slice(0, MAX_FACTS);
    facts.css.selectors = unique(facts.css.selectors).slice(0, MAX_FACTS);
    facts.css.properties.read = unique(facts.css.properties.read).slice(0, MAX_FACTS);
    facts.css.properties.write = unique(facts.css.properties.write).slice(0, MAX_FACTS);
    const seenWrites = new Set();
    facts.css.writes = facts.css.writes.filter(item => {
      const key = `${item.selector}::${item.property}=${item.value || ''}`;
      if (seenWrites.has(key)) return false;
      seenWrites.add(key);
      return true;
    }).slice(0, MAX_FACTS);
    facts.operations.sort((a, b) => a.key.localeCompare(b.key));
    return facts;
  }

  function extractFacts(code) {
    const source = stripComments(removeMetadataBlock(code));
    const facts = emptyFacts();
    extractDomFacts(source, facts);
    extractStorageFacts(source, facts);
    extractNetworkFacts(source, facts);
    extractPerformanceFacts(source, facts);
    extractCssFacts(source, facts);
    return finalizeFacts(facts);
  }

  function factsSignature(facts) {
    return unique((facts?.operations || []).map(item => item.key));
  }

  function analyzeScript(input, options = {}) {
    const data = typeof input === 'string' ? { code: input } : (input || {});
    const code = String(data.code || '');
    const meta = normalizeMetadata(data.meta, code);
    const canonical = canonicalSource(code);
    const shingles = tokenShingles(code, options.shingleWidth || 5);
    const facts = extractFacts(code);
    const sourceHash = fnv1a(normalizeLineEndings(code).trim());
    const bodyHash = fnv1a(canonical);
    const canonicalNameKey = normalizeName(meta.canonicalName);
    const identitySeed = [meta.namespace, meta.canonicalName, meta.updateURL || meta.downloadURL, bodyHash].join('\u0000');
    return {
      id: data.id || fnv1a(`${data.fileName || ''}\u0000${identitySeed}`),
      fileName: data.fileName || '',
      enabled: data.enabled == null ? null : Boolean(data.enabled),
      code,
      meta,
      nameKey: canonicalNameKey,
      displayNameKey: normalizeName(meta.displayName),
      identityKey: `${String(meta.namespace || '').toLowerCase()}\u0000${canonicalNameKey}`,
      scopes: meta.matches.map(parseMatchPattern),
      facts,
      fingerprints: {
        source: sourceHash,
        body: bodyHash,
        token: fnv1a(shingles.join(',')),
        shingles
      }
    };
  }

  function ensureAnalyzed(value) {
    return value && value.facts && value.fingerprints ? value : analyzeScript(value);
  }

  function sameOrigin(left, right) {
    const urlsA = unique([left.meta.updateURL, left.meta.downloadURL].map(normalizeUrl));
    const urlsB = unique([right.meta.updateURL, right.meta.downloadURL].map(normalizeUrl));
    return urlsA.some(url => url && urlsB.includes(url));
  }

  function familyAssessment(left, right, scope, codeSimilarity) {
    const evidence = [];
    let score = 0;
    const leftNamespace = String(left.meta.namespace || '').trim().toLowerCase();
    const rightNamespace = String(right.meta.namespace || '').trim().toLowerCase();
    const sameNamespaceName = Boolean(
      leftNamespace && rightNamespace && leftNamespace === rightNamespace &&
      left.nameKey && left.nameKey === right.nameKey
    );
    const originMatch = sameOrigin(left, right);
    const exactName = left.nameKey && left.nameKey === right.nameKey;

    if (originMatch) {
      score += 0.66;
      evidence.push('업데이트 주소가 같습니다.');
    }
    if (sameNamespaceName) {
      score += 0.58;
      evidence.push('@namespace와 이름이 같습니다.');
    } else if (exactName && scope.overlap !== false) {
      score += 0.38;
      evidence.push('정리한 이름과 실행 사이트가 같습니다.');
    }
    if (codeSimilarity >= 0.82) {
      score += 0.24;
      evidence.push(`코드 뼈대가 ${Math.round(codeSimilarity * 100)}% 비슷합니다.`);
    } else if (codeSimilarity >= 0.58 && exactName) {
      score += 0.12;
      evidence.push(`코드 뼈대가 ${Math.round(codeSimilarity * 100)}% 비슷합니다.`);
    }
    return {
      sameFamily: score >= 0.5,
      confidence: round(clamp(score, 0, 0.99)),
      scopeOverlap: scope.overlap,
      sameNamespaceName,
      sameOrigin: originMatch,
      sameName: exactName,
      evidence
    };
  }

  function intersect(left, right) {
    const b = new Set(right || []);
    return unique((left || []).filter(value => b.has(value)));
  }

  function storageConflicts(left, right, family) {
    const conflicts = [];
    for (const channel of ['local', 'session', 'gm']) {
      if (channel === 'gm' && !family.sameNamespaceName) continue;
      const a = left.facts.storage[channel];
      const b = right.facts.storage[channel];
      const aMutates = unique([...a.write, ...a.delete]);
      const bMutates = unique([...b.write, ...b.delete]);
      const aTouches = unique([...a.read, ...a.write, ...a.delete]);
      const bTouches = unique([...b.read, ...b.write, ...b.delete]);
      const keys = unique([...intersect(aMutates, bTouches), ...intersect(bMutates, aTouches)]);
      if (keys.length) conflicts.push({ channel, keys });
    }
    return conflicts;
  }

  function selectorConflicts(left, right) {
    const a = left.facts.dom;
    const b = right.facts.dom;
    const results = [];
    const push = (kind, values, severity) => {
      if (values.length) results.push({ kind, values, severity });
    };
    push('remove_vs_touch', unique([
      ...intersect(a.remove, [...b.read, ...b.write, ...b.listen.map(value => value.split('::')[0])]),
      ...intersect(b.remove, [...a.read, ...a.write, ...a.listen.map(value => value.split('::')[0])])
    ]), 'high');
    push('write_vs_write', intersect(a.write, b.write), 'medium');
    return results;
  }

  function cssConflicts(left, right) {
    const byProperty = writes => {
      const output = new Map();
      for (const item of writes || []) {
        const key = `${item.selector}::${item.property}`;
        if (!output.has(key)) output.set(key, new Set());
        output.get(key).add(String(item.value || ''));
      }
      return output;
    };
    const a = byProperty(left.facts.css.writes);
    const b = byProperty(right.facts.css.writes);
    const conflicts = [];
    for (const [key, valuesA] of a.entries()) {
      const valuesB = b.get(key);
      if (!valuesB) continue;
      const sameValues = valuesA.size === valuesB.size && [...valuesA].every(value => valuesB.has(value));
      if (!sameValues) conflicts.push(key);
    }
    return unique(conflicts);
  }

  function cssPlacementConflicts(left, right) {
    const collect = writes => {
      const bySelector = new Map();
      for (const item of writes || []) {
        if (!bySelector.has(item.selector)) bySelector.set(item.selector, {});
        bySelector.get(item.selector)[String(item.property || '').toLowerCase()] = String(item.value || '').trim().toLowerCase();
      }
      return [...bySelector.entries()]
        .map(([selector, properties]) => ({ selector, properties }))
        .filter(item => item.properties.position === 'fixed');
    };
    const leftPlacements = collect(left.facts.css.writes);
    const rightPlacements = collect(right.facts.css.writes);
    const results = [];
    for (const a of leftPlacements) {
      for (const b of rightPlacements) {
        if (a.selector === b.selector) continue;
        const horizontal = ['left', 'right'].filter(property =>
          a.properties[property] && a.properties[property] === b.properties[property]
        );
        const vertical = ['top', 'bottom'].filter(property =>
          a.properties[property] && a.properties[property] === b.properties[property]
        );
        if (!horizontal.length || !vertical.length) continue;
        results.push({
          leftSelector: a.selector,
          rightSelector: b.selector,
          anchors: [...horizontal, ...vertical].map(property => `${property}:${a.properties[property]}`)
        });
      }
    }
    return results.slice(0, MAX_FACTS);
  }

  function networkConflicts(left, right) {
    const results = [];
    for (const channel of ['fetch', 'xhr', 'websocket']) {
      const a = left.facts.network[channel];
      const b = right.facts.network[channel];
      const sharedEndpoints = intersect(a.endpointHints, b.endpointHints);
      const changesData = Boolean(
        (a.changesRequest || a.changesResponse || a.replacesResult) &&
        (b.changesRequest || b.changesResponse || b.replacesResult)
      );
      if (a.patch && b.patch) {
        results.push({
          channel,
          kind: sharedEndpoints.length && changesData ? 'same_endpoint_change' : 'patch_patch',
          severity: sharedEndpoints.length && changesData ? 'high' : 'notice',
          sharedEndpoints
        });
      }
      else if ((a.patch && b.call) || (b.patch && a.call)) results.push({ channel, kind: 'patch_call', severity: 'medium' });
    }
    const historyA = left.facts.network.history;
    const historyB = right.facts.network.history;
    if (historyA.patch.length && historyB.patch.length) results.push({ channel: 'history', kind: 'patch_patch', severity: 'high' });
    else if ((historyA.patch.length && historyB.call.length) || (historyB.patch.length && historyA.call.length)) {
      results.push({ channel: 'history', kind: 'patch_call', severity: 'medium' });
    }
    return results;
  }

  function performanceConflicts(left, right) {
    const a = left.facts.performance || { riskScore: 0 };
    const b = right.facts.performance || { riskScore: 0 };
    if ((a.riskScore || 0) < 3 || (b.riskScore || 0) < 3) return [];
    const signals = [];
    if (a.rapidIntervals?.length && b.rapidIntervals?.length) signals.push('양쪽 모두 250ms 이하 반복 타이머 사용');
    if (a.broadObservers?.length && b.broadObservers?.length) signals.push('양쪽 모두 문서 전체 변경 감시');
    if (a.repeatedDomScan && b.repeatedDomScan) signals.push('양쪽 모두 반복 작업 안에서 여러 화면 요소 검색');
    if (a.animationLoop && b.animationLoop) signals.push('양쪽 모두 화면 프레임마다 반복 작업');
    if (a.frequentEvents?.length && b.frequentEvents?.length) signals.push('양쪽 모두 자주 발생하는 화면 입력 감시');
    const combinedScore = (a.riskScore || 0) + (b.riskScore || 0);
    return [{
      kind: 'combined_load',
      severity: combinedScore >= 8 || signals.length >= 2 ? 'medium' : 'notice',
      signals: signals.length ? signals : ['두 스크립트에 반복 작업이 함께 발견됨']
    }];
  }

  function eventConflicts(left, right) {
    const splitTargetEvent = value => {
      const index = String(value || '').lastIndexOf('::');
      return index < 0
        ? { target: '', event: String(value || '') }
        : { target: value.slice(0, index), event: value.slice(index + 2) };
    };
    const listenersA = (left.facts.events.listenTargets || left.facts.dom.listen || []).map(splitTargetEvent);
    const listenersB = (right.facts.events.listenTargets || right.facts.dom.listen || []).map(splitTargetEvent);
    const blockersA = (left.facts.events.blockTargets || []).map(splitTargetEvent);
    const blockersB = (right.facts.events.blockTargets || []).map(splitTargetEvent);
    const conflicts = [];
    const collect = (blockers, listeners) => {
      for (const blocker of blockers) {
        if (!blocker.target || !blocker.event) continue;
        const globalBlocker = blocker.target === '@document' || blocker.target === '@window';
        for (const listener of listeners) {
          if (blocker.event !== listener.event) continue;
          if (globalBlocker || blocker.target === listener.target) {
            conflicts.push(`${blocker.target}::${blocker.event}`);
            break;
          }
        }
      }
    };
    collect(blockersA, listenersB);
    collect(blockersB, listenersA);
    return unique(conflicts);
  }

  function classifyRelationship(left, right, family, codeSimilarity, operationSimilarity) {
    const comparison = compareVersions(left.meta.version, right.meta.version);
    const versionsKnown = parseVersion(left.meta.version).valid && parseVersion(right.meta.version).valid;
    // Hashes are only a fast prefilter. A collision must never authorize a delete recommendation.
    const sameBody = left.fingerprints.body === right.fingerprints.body &&
      canonicalSource(left.code) === canonicalSource(right.code);
    const exactSource = Boolean(left.code && right.code) &&
      left.fingerprints.source === right.fingerprints.source &&
      String(left.code) === String(right.code);
    const differentOrigins = Boolean(
      normalizeUrl(left.meta.updateURL || left.meta.downloadURL) &&
      normalizeUrl(right.meta.updateURL || right.meta.downloadURL) &&
      !sameOrigin(left, right)
    );
    const operationallyDiverged = operationSimilarity < 0.58 && codeSimilarity < 0.72;
    const forkEvidence = family.sameFamily && !family.sameOrigin && operationallyDiverged &&
      (differentOrigins || (!family.sameNamespaceName && family.sameName));

    let type = 'unrelated';
    if (exactSource) type = 'exact_duplicate';
    else if (family.sameFamily && comparison === 0) type = 'same_version_variant';
    else if (forkEvidence) type = 'functional_fork';
    else if (family.sameFamily && versionsKnown && comparison !== 0) type = 'older_version';
    else if (family.sameFamily) type = 'same_family';

    const newer = comparison > 0 ? left : comparison < 0 ? right : null;
    const older = comparison > 0 ? right : comparison < 0 ? left : null;
    return {
      type,
      label: RELATIONSHIP_LABELS[type],
      sameFamily: family.sameFamily,
      confidence: family.confidence,
      codeSimilarity: round(codeSimilarity),
      operationSimilarity: round(operationSimilarity),
      sameBody,
      exactSource,
      functionalDivergence: operationallyDiverged,
      version: {
        comparison,
        newerId: newer?.id || null,
        olderId: older?.id || null,
        newerVersion: newer?.meta.version || null,
        olderVersion: older?.meta.version || null
      },
      evidence: family.evidence
    };
  }

  function buildUserImpacts(conflicts) {
    const impacts = [];
    const seen = new Set();
    const push = (type, severity, text) => {
      if (seen.has(type)) return;
      seen.add(type);
      impacts.push({ type, severity, text });
    };

    for (const conflict of conflicts.selectors || []) {
      if (conflict.kind === 'remove_vs_touch') {
        push('missing_control', 'high', '버튼이나 메뉴가 사라지거나 눌러도 반응하지 않을 수 있습니다.');
      } else {
        push('screen_override', 'medium', '버튼 위치나 화면 내용이 서로 덮여 한쪽 기능을 쓰기 어려울 수 있습니다.');
      }
    }
    if ((conflicts.placements || []).length) {
      push('placement_overlap', 'medium', '버튼이나 창이 같은 위치에 겹쳐 한쪽을 누르기 어려울 수 있습니다.');
    }
    if ((conflicts.css || []).length) {
      const properties = conflicts.css.map(value => String(value).slice(String(value).lastIndexOf('::') + 2));
      if (properties.some(property => ['display', 'visibility', 'opacity', 'z-index'].includes(property))) {
        push('hidden_screen', 'medium', '버튼이나 창이 가려지거나 보이지 않을 수 있습니다.');
      } else if (properties.some(property => ['position', 'top', 'right', 'bottom', 'left', 'transform', 'width', 'height'].includes(property))) {
        push('placement_overlap', 'medium', '버튼이나 창의 위치가 바뀌거나 서로 겹칠 수 있습니다.');
      } else {
        push('appearance_override', 'notice', '글자나 버튼의 모양이 서로 덮여 화면이 보기 어려울 수 있습니다.');
      }
    }
    if ((conflicts.storage || []).length) {
      push('settings_changed', 'medium', '설정이 풀리거나 다른 값으로 바뀌어 기능이 예상과 다르게 작동할 수 있습니다.');
    }
    for (const conflict of conflicts.network || []) {
      if (conflict.channel === 'history') {
        push('navigation_failure', 'medium', '페이지를 옮긴 뒤 버튼이나 기능이 사라질 수 있습니다.');
      } else {
        push('feature_failure', conflict.severity === 'high' ? 'high' : 'notice', '전송하거나 불러오는 기능이 늦게 반응하거나, 두 확장 프로그램 중 한쪽 기능이 작동하지 않을 수 있습니다.');
      }
    }
    if ((conflicts.events || []).length) {
      push('input_blocked', 'medium', '버튼을 눌러도 반응하지 않거나 단축키가 작동하지 않을 수 있습니다.');
    }
    if ((conflicts.performance || []).length) {
      push('slow_page', 'medium', '둘을 함께 켜면 화면 반응이 느려지거나 스크롤이 끊길 수 있습니다.');
    }

    const severityRank = { high: 0, medium: 1, notice: 2 };
    return impacts.sort((a, b) => (severityRank[a.severity] ?? 3) - (severityRank[b.severity] ?? 3));
  }

  function buildLimitations(conflicts) {
    const limitations = ['코드를 실행하지 않고 살펴본 결과이므로 실제 문제가 반드시 생긴다는 뜻은 아닙니다.'];
    const structuralNetwork = (conflicts.network || []).some(conflict =>
      ['patch_patch', 'patch_call'].includes(conflict.kind)
    );
    if (structuralNetwork) limitations.push('같은 요청이나 응답을 실제로 변경하는지는 확인되지 않았습니다.');
    if ((conflicts.performance || []).length) limitations.push('실제 느려짐 정도는 기기 성능과 열린 페이지 상태에 따라 달라질 수 있습니다.');
    return limitations;
  }

  function buildCompatibility(left, right, scope, relationship, conflicts) {
    const reasons = [];
    const impacts = buildUserImpacts(conflicts);
    const limitations = buildLimitations(conflicts);
    let score = 0;

    // 소스 전체가 정말 같은 복사본이 아닌 한, 실행 범위가 겹치지 않는 두 파일은
    // 버전·계열 관계나 우연히 같은 선택자만으로 충돌/비활성화 대상으로 만들지 않는다.
    if (scope.overlap === false && !relationship.exactSource) {
      reasons.push({ type: 'scope', severity: 'safe', text: '실행되는 사이트가 달라 서로 부딪히지 않습니다.', evidence: scope.evidence });
      return {
        level: 'safe',
        verdict: 'can_run_together',
        score: 0,
        confidence: round(clamp((scope.confidence + relationship.confidence + 0.85) / 3, 0.2, 0.98)),
        reasons,
        impacts: [],
        limitations: [],
        gmStorageNote: 'GM 저장값은 스크립트별로 격리됩니다. 이름과 namespace가 같은 계열일 때만 저장 키 충돌 후보로 셉니다.'
      };
    }
    if (relationship.type === 'exact_duplicate') {
      score = Math.max(score, 90);
      reasons.push({ type: 'duplicate', severity: 'high', text: '같은 기능이 두 번 실행될 수 있는 완전 중복입니다.', evidence: [] });
    } else if (relationship.type === 'older_version') {
      score = Math.max(score, 78);
      reasons.push({ type: 'version', severity: 'high', text: '같은 계열의 새 버전과 구버전이 함께 있습니다.', evidence: [] });
    } else if (relationship.type === 'same_version_variant') {
      score = Math.max(score, 82);
      reasons.push({ type: 'variant', severity: 'high', text: '버전 번호는 같은데 코드가 달라 자동으로 최신본을 고를 수 없습니다.', evidence: [] });
    } else if (relationship.type === 'functional_fork') {
      score = Math.max(score, 66);
      reasons.push({ type: 'fork', severity: 'medium', text: '같은 뿌리로 보이지만 기능이 갈라진 변형판일 수 있습니다.', evidence: [] });
    }

    for (const conflict of conflicts.selectors) {
      score += conflict.severity === 'high' ? 55 : 32;
      reasons.push({
        type: 'dom',
        severity: conflict.severity,
        text: conflict.kind === 'remove_vs_touch'
          ? `한 스크립트가 지우는 화면 요소를 다른 스크립트가 사용합니다: ${conflict.values.slice(0, 4).join(', ')}`
          : `둘 다 같은 화면 요소를 바꿉니다: ${conflict.values.slice(0, 4).join(', ')}`,
        evidence: conflict.values
      });
    }
    for (const conflict of conflicts.storage) {
      score += conflict.channel === 'gm' ? 34 : 50;
      const channelLabel = conflict.channel === 'local' ? '사이트 저장공간' : conflict.channel === 'session' ? '탭 저장공간' : '같은 계열의 전용 저장공간';
      reasons.push({ type: 'storage', severity: 'medium', text: `둘 다 같은 ${channelLabel} 값을 바꾸거나 지웁니다: ${conflict.keys.slice(0, 4).join(', ')}`, evidence: conflict.keys });
    }
    for (const conflict of conflicts.network) {
      const sameEndpointChange = conflict.kind === 'same_endpoint_change';
      const patchVsPatch = conflict.kind === 'patch_patch';
      score += sameEndpointChange ? 78 : patchVsPatch ? 24 : 18;
      reasons.push({
        type: 'network',
        severity: sameEndpointChange ? 'high' : 'notice',
        text: sameEndpointChange
          ? `둘 다 ${conflict.channel}에서 같은 통신 주소의 요청이나 응답을 변경합니다: ${conflict.sharedEndpoints.slice(0, 4).join(', ')}`
          : patchVsPatch
            ? `둘 다 ${conflict.channel} 동작을 가로채는 코드가 감지되었습니다.`
            : `한쪽이 ${conflict.channel} 동작을 감싸고 다른 쪽이 사용합니다.`,
        evidence: [conflict.channel, conflict.kind, ...(conflict.sharedEndpoints || [])]
      });
    }
    if (conflicts.events.length) {
      score += 26;
      reasons.push({ type: 'event', severity: 'notice', text: `같은 대상의 입력을 듣고 한쪽이 기본 동작을 막습니다: ${conflicts.events.join(', ')}`, evidence: conflicts.events });
    }
    if (conflicts.css.length) {
      score += 25;
      reasons.push({ type: 'css', severity: 'medium', text: `같은 요소의 같은 모양 속성을 둘 다 바꿉니다: ${conflicts.css.slice(0, 4).join(', ')}`, evidence: conflicts.css });
    }
    if (conflicts.placements.length) {
      score += 48;
      const placementEvidence = conflicts.placements.slice(0, 4).map(conflict =>
        `${conflict.leftSelector} ↔ ${conflict.rightSelector} (${conflict.anchors.join(', ')})`
      );
      reasons.push({ type: 'placement', severity: 'medium', text: `서로 다른 고정 화면 요소가 같은 위치를 사용합니다: ${placementEvidence.join(' · ')}`, evidence: placementEvidence });
    }
    for (const conflict of conflicts.performance) {
      score += conflict.severity === 'medium' ? 48 : 24;
      reasons.push({ type: 'performance', severity: conflict.severity, text: `두 스크립트의 반복 작업이 함께 실행됩니다: ${conflict.signals.join(', ')}`, evidence: conflict.signals });
    }

    score = clamp(score, 0, 100);
    let level = 'safe';
    let verdict = 'can_run_together';
    if (score >= 75) { level = 'high'; verdict = 'avoid_together'; }
    else if (score >= 45) { level = 'caution'; verdict = 'test_one_by_one'; }
    else if (score >= 15) { level = 'notice'; verdict = 'probably_compatible'; }
    return {
      level,
      verdict,
      score,
      confidence: round(clamp((scope.confidence + relationship.confidence + (reasons.length ? 0.75 : 0.45)) / 3, 0.2, 0.98)),
      reasons,
      impacts,
      limitations,
      gmStorageNote: 'GM 저장값은 스크립트별로 격리됩니다. 이름과 namespace가 같은 계열일 때만 저장 키 충돌 후보로 셉니다.'
    };
  }

  function displayName(script) {
    return `“${script.meta.name}” ${script.meta.version}`;
  }

  function buildRecommendation(left, right, relationship, compatibility) {
    const impactSummary = (compatibility.impacts || []).slice(0, 2).map(impact => impact.text).join(' ');
    const base = {
      action: 'keep_both',
      headline: '둘 다 켜도 됩니다',
      summary: '확실한 충돌 근거를 찾지 못했습니다.',
      steps: [],
      keepIds: [left.id, right.id],
      disableIds: [],
      deleteIds: [],
      caution: '정적 분석은 실행 중에 만들어지는 코드까지 모두 볼 수는 없습니다.'
    };

    if (relationship.type === 'exact_duplicate') {
      const keep = left.enabled === true && right.enabled !== true
        ? left
        : right.enabled === true && left.enabled !== true ? right : left;
      const remove = keep === left ? right : left;
      return {
        ...base,
        action: 'keep_one',
        headline: '둘 중 하나만 남기세요',
        summary: '내용이 같은 복사본이라 둘 다 켤 이유가 없습니다.',
        steps: ['설정이 들어 있는 쪽 하나를 고릅니다.', '다른 쪽을 먼저 끕니다.', '사이트가 잘 작동하면 꺼 둔 복사본은 삭제해도 됩니다.'],
        keepIds: [keep.id],
        disableIds: [remove.id],
        deleteIds: [remove.id]
      };
    }
    if (compatibility.reasons.some(reason => reason.type === 'scope' && reason.severity === 'safe')) {
      return {
        ...base,
        headline: '실행되는 사이트가 달라 둘 다 켜도 됩니다',
        summary: '같은 계열이나 다른 버전으로 보여도 실제 실행 범위가 겹치지 않아 서로 충돌하지 않습니다.',
        steps: ['두 파일이 각각 필요한 사이트에서 작동한다면 그대로 둡니다.'],
        caution: '나중에 @match나 @include 실행 범위를 바꾸면 다시 확인하세요.'
      };
    }
    if (relationship.type === 'older_version') {
      const newer = relationship.version.newerId === left.id ? left : right;
      const older = newer === left ? right : left;
      if (relationship.functionalDivergence) {
        return {
          ...base,
          action: 'review_fork',
          headline: '버전은 다르지만 기능도 달라서 바로 지우면 안 됩니다',
          summary: `${displayName(newer)}이 더 새 버전이지만 두 파일의 기능 구성이 꽤 다릅니다.`,
          steps: ['두 파일을 모두 백업합니다.', `${displayName(older)}을 먼저 끄고 새 버전의 필요한 기능을 확인합니다.`, '빠진 기능이 있으면 두 파일을 하나씩 켜서 비교합니다.'],
          keepIds: [], disableIds: [], deleteIds: [],
          caution: '필요한 기능이 모두 남았다고 확인하기 전에는 구버전을 삭제하지 마세요.'
        };
      }
      return {
        ...base,
        action: 'keep_newer',
        headline: '구버전은 끄고 최신 버전만 켜세요',
        summary: `${displayName(newer)}이 더 새 버전입니다.`,
        steps: [`${displayName(older)}을 먼저 끕니다.`, `${displayName(newer)}만 켠 채로 자주 쓰는 기능을 확인합니다.`, '문제가 없을 때만 구버전을 삭제합니다.'],
        keepIds: [newer.id],
        disableIds: [older.id],
        deleteIds: [],
        caution: relationship.functionalDivergence ? '두 파일의 기능 차이가 커 보입니다. 구버전을 바로 지우지 말고 먼저 비활성화해 두세요.' : base.caution
      };
    }
    if (relationship.type === 'same_version_variant') {
      return {
        ...base,
        action: 'choose_one',
        headline: '둘을 동시에 켜지 말고 하나씩 시험하세요',
        summary: '버전 번호만 같고 실제 내용은 달라서 어느 쪽이 최신인지 자동으로 정할 수 없습니다.',
        steps: ['둘 중 하나를 끕니다.', '남은 쪽의 주요 기능을 확인합니다.', '반대로 바꿔 켜서 비교한 뒤 더 잘 맞는 하나만 남깁니다.'],
        keepIds: [],
        disableIds: [],
        deleteIds: [],
        caution: '비교가 끝나기 전에는 어느 파일도 삭제하지 마세요.'
      };
    }
    if (relationship.type === 'functional_fork') {
      return {
        ...base,
        action: 'review_fork',
        headline: '비슷해 보여도 다른 판입니다. 하나씩 켜서 고르세요',
        summary: '같은 뿌리의 변형판으로 보이며 기능 구성이 달라 단순히 버전 숫자만 보고 지우면 안 됩니다.',
        steps: ['두 스크립트를 모두 끈 뒤 하나만 켭니다.', '필요한 기능이 되는지 확인합니다.', '다른 하나도 같은 방식으로 시험하고 원하는 쪽을 고릅니다.'],
        keepIds: [], disableIds: [], deleteIds: [],
        caution: '기능 비교 전에는 삭제하지 마세요.'
      };
    }
    if (compatibility.verdict === 'avoid_together') {
      return {
        ...base,
        action: 'disable_one',
        headline: '둘 중 하나를 꺼 두는 편이 안전합니다',
        summary: impactSummary || '함께 켜면 한쪽 기능이 제대로 작동하지 않을 수 있습니다.',
        steps: ['문제가 생기는 페이지에서 둘 중 하나를 끕니다.', '새로고침한 뒤 문제가 사라지는지 확인합니다.', '필요하면 반대로 바꿔서 더 필요한 쪽을 남깁니다.'],
        keepIds: [], disableIds: [], deleteIds: [],
        caution: '자동으로 삭제할 만큼 같은 파일이라는 뜻은 아닙니다.'
      };
    }
    if (compatibility.verdict === 'test_one_by_one') {
      return {
        ...base,
        action: 'test_together',
        headline: '같이 쓸 수 있지만 이상하면 하나씩 꺼 보세요',
        summary: impactSummary || '함께 사용할 때 일부 기능이 예상과 다르게 작동할 수 있습니다.',
        steps: ['지금 잘 작동한다면 그대로 써도 됩니다.', '위와 같은 증상이 생기면 둘 중 하나를 잠시 끕니다.', '새로고침해서 문제가 사라지는지 확인합니다.'],
        caution: '실제 문제가 확인된 것은 아니므로 증상이 없으면 당장 끌 필요는 없습니다.'
      };
    }
    if (compatibility.verdict === 'probably_compatible' && impactSummary) {
      return {
        ...base,
        action: 'test_together',
        headline: '같이 쓸 수 있지만 해당 기능을 확인해 보세요',
        summary: impactSummary,
        steps: ['지금 잘 작동한다면 그대로 써도 됩니다.', '위와 같은 증상이 생기면 둘 중 하나를 잠시 끄고 새로고침합니다.'],
        caution: '코드에서 가능성을 찾은 것이며 실제 문제가 확인된 것은 아닙니다.'
      };
    }
    return base;
  }

  function compareScripts(leftInput, rightInput) {
    const left = ensureAnalyzed(leftInput);
    const right = ensureAnalyzed(rightInput);
    const scope = scopesOverlap(left, right);
    const codeSimilarity = jaccard(left.fingerprints.shingles, right.fingerprints.shingles);
    const operationSimilarity = jaccard(factsSignature(left.facts), factsSignature(right.facts));
    const family = familyAssessment(left, right, scope, codeSimilarity);
    const relationship = classifyRelationship(left, right, family, codeSimilarity, operationSimilarity);
    const conflicts = {
      selectors: selectorConflicts(left, right),
      storage: storageConflicts(left, right, family),
      network: networkConflicts(left, right),
      events: eventConflicts(left, right),
      css: cssConflicts(left, right),
      placements: cssPlacementConflicts(left, right),
      performance: performanceConflicts(left, right)
    };
    const compatibility = buildCompatibility(left, right, scope, relationship, conflicts);
    const recommendation = buildRecommendation(left, right, relationship, compatibility);
    return {
      leftId: left.id,
      rightId: right.id,
      classification: relationship.type,
      scope,
      relationship,
      conflicts,
      compatibility,
      recommendation
    };
  }

  function planDirectVersionFamily(scriptsInput, pairRecords) {
    const scripts = unique((scriptsInput || []).map(script => script?.id))
      .map(id => (scriptsInput || []).find(script => script?.id === id))
      .filter(Boolean);
    if (scripts.length < 3) return null;

    const sorted = scripts.slice().sort((left, right) => {
      const comparison = compareVersions(right.meta?.version, left.meta?.version);
      return comparison == null ? 0 : comparison;
    });
    const newest = sorted[0];
    if (!newest || !parseVersion(newest.meta?.version).valid) return null;
    const newestPeers = sorted.filter(script => compareVersions(script.meta?.version, newest.meta?.version) === 0);
    // 최고 버전 후보가 여럿이면 자동으로 대표 하나를 고르지 않는다.
    if (newestPeers.length !== 1) return null;

    const older = sorted.filter(script => script.id !== newest.id);
    const hasDirectNewerRelation = olderScript => (pairRecords || []).some(record => {
      const ids = record?.scripts || [record?.leftId, record?.rightId];
      const relation = record?.relationship || record;
      return ids.includes(newest.id) && ids.includes(olderScript.id) &&
        record?.scope?.overlap !== false &&
        record?.recommendation?.action === 'keep_newer' &&
        relation?.type === 'older_version' &&
        relation.version?.newerId === newest.id &&
        relation.functionalDivergence !== true;
    });
    if (!older.every(hasDirectNewerRelation)) return null;
    return { newestId: newest.id, olderIds: older.map(script => script.id) };
  }

  function analyzeCollection(inputs, options = {}) {
    const scripts = (inputs || []).map(input => ensureAnalyzed(input));
    const pairs = [];
    for (let left = 0; left < scripts.length; left += 1) {
      for (let right = left + 1; right < scripts.length; right += 1) {
        const result = compareScripts(scripts[left], scripts[right]);
        if (options.includeUnrelated || result.classification !== 'unrelated' || result.compatibility.level !== 'safe') {
          pairs.push(result);
        }
      }
    }
    const rank = { high: 0, caution: 1, notice: 2, safe: 3 };
    pairs.sort((a, b) => (rank[a.compatibility.level] - rank[b.compatibility.level]) || b.compatibility.score - a.compatibility.score);
    return {
      coreVersion: CORE_VERSION,
      scripts,
      pairs,
      summary: {
        scripts: scripts.length,
        pairs: pairs.length,
        high: pairs.filter(pair => pair.compatibility.level === 'high').length,
        caution: pairs.filter(pair => pair.compatibility.level === 'caution').length,
        outdated: pairs.filter(pair => pair.classification === 'older_version').length,
        variants: pairs.filter(pair => pair.classification === 'same_version_variant').length
      }
    };
  }

  return Object.freeze({
    version: CORE_VERSION,
    ACTION_LABELS,
    RELATIONSHIP_LABELS,
    parseMetadata,
    normalizeMetadata,
    parseVersion,
    compareVersions,
    normalizeUrl,
    parseMatchPattern,
    scopesOverlap,
    extractFacts,
    factsSignature,
    analyzeScript,
    assessPair: compareScripts,
    compareScripts,
    planDirectVersionFamily,
    analyzeCollection,
    normalizeName,
    canonicalSource
  });
});
