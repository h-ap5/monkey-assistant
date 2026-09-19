'use strict';

const assert = require('node:assert/strict');
const core = require('../analysis-core.js');

const tests = [];
const test = (name, run) => tests.push({ name, run });

function script({
  name = '테스트 도구',
  namespace = 'https://example.test/tools',
  version = '1.0.0',
  match = '*://example.com/*',
  updateURL = '',
  extraMeta = '',
  body = ''
} = {}) {
  return [
    '// ==UserScript==',
    `// @name ${name}`,
    `// @namespace ${namespace}`,
    `// @version ${version}`,
    `// @match ${match}`,
    updateURL ? `// @updateURL ${updateURL}` : '',
    extraMeta,
    '// ==/UserScript==',
    "'use strict';",
    body
  ].filter(Boolean).join('\n');
}

function analyzed(options, fileName = '') {
  return core.analyzeScript({ code: script(options), fileName });
}

test('CommonJS와 browser global이 같은 API를 가리킨다', () => {
  assert.equal(globalThis.MonkeyAssistantCore, core);
  assert.equal(typeof core.assessPair, 'function');
});

test('유저스크립트 메타데이터와 다중 @match를 읽는다', () => {
  const code = script({
    name: '한국어 이름',
    version: '2.4.1',
    match: '*://example.com/*',
    extraMeta: '// @match https://sub.example.org/chat/*\n// @grant GM_getValue'
  });
  const meta = core.parseMetadata(code);
  assert.equal(meta.name, '한국어 이름');
  assert.equal(meta.version, '2.4.1');
  assert.deepEqual(meta.matches, ['*://example.com/*', 'https://sub.example.org/chat/*']);
  assert.deepEqual(meta.grants, ['GM_getValue']);
});

test('표시용 번역 이름과 계열 판정용 원본 이름을 분리한다', () => {
  const meta = core.parseMetadata(script({
    name: 'Canonical Tool',
    extraMeta: '// @name:ko 한국어 도구'
  }));
  assert.equal(meta.name, '한국어 도구');
  assert.equal(meta.displayName, '한국어 도구');
  assert.equal(meta.canonicalName, 'Canonical Tool');
});

test('일부만 들어온 meta도 코드의 안전한 기본값과 합친다', () => {
  const result = core.analyzeScript({
    code: script({ name: 'Base Tool', match: 'https://example.com/*' }),
    meta: { version: '9.0.0' }
  });
  assert.equal(result.meta.canonicalName, 'Base Tool');
  assert.equal(result.meta.version, '9.0.0');
  assert.deepEqual(result.meta.matches, ['https://example.com/*']);
  assert.deepEqual(result.meta.excludes, []);
});

test('버전 1.10을 1.2보다 새 버전으로 판단한다', () => {
  assert.equal(core.compareVersions('1.2', '1.10'), -1);
  assert.equal(core.compareVersions('1.10', '1.2'), 1);
});

test('정식판을 같은 숫자의 prerelease보다 새 버전으로 판단한다', () => {
  assert.equal(core.compareVersions('2.0.0', '2.0.0-beta.2'), 1);
  assert.equal(core.compareVersions('v2.0.0-rc.1', '2.0.0'), -1);
});

test('prerelease 숫자를 문자열이 아니라 숫자로 비교하고 build 표시는 무시한다', () => {
  assert.equal(core.compareVersions('2.0.0-beta.10', '2.0.0-beta.2'), 1);
  assert.equal(core.compareVersions('2.0.0-beta10', '2.0.0-beta2'), 1);
  assert.equal(core.compareVersions('2.0.0+build.1', '2.0.0+build.99'), 0);
  assert.equal(core.compareVersions('날짜판', 'nightly'), null);
});

test('업데이트 URL 정규화는 fragment만 버리고 query와 path 대소문자를 보존한다', () => {
  assert.equal(
    core.normalizeUrl('HTTPS://Example.COM/Release/Tool.user.js?channel=A#readme'),
    'https://example.com/Release/Tool.user.js?channel=A'
  );
  assert.notEqual(
    core.normalizeUrl('https://example.com/Release/Tool.user.js?channel=A'),
    core.normalizeUrl('https://example.com/release/Tool.user.js?channel=B')
  );
});

test('겹치는 서브도메인과 경로의 실행 범위를 찾는다', () => {
  const a = analyzed({ match: '*://*.example.com/chat/*' });
  const b = analyzed({ match: 'https://app.example.com/chat/room/*' });
  const scope = core.scopesOverlap(a, b);
  assert.equal(scope.overlap, true);
  assert.ok(scope.evidence.length > 0);
});

test('서로 다른 도메인의 실행 범위를 분리한다', () => {
  const a = analyzed({ match: 'https://one.example/*' });
  const b = analyzed({ match: 'https://two.example/*' });
  assert.equal(core.scopesOverlap(a, b).overlap, false);
});

test('@exclude와 @exclude-match가 겹치는 후보 범위를 완전히 빼면 분리한다', () => {
  const a = analyzed({
    match: 'https://example.com/*',
    extraMeta: '// @exclude https://example.com/chat/*'
  });
  const b = analyzed({ match: 'https://example.com/chat/*' });
  const scope = core.scopesOverlap(a, b);
  assert.equal(scope.overlap, false);
  assert.match(scope.label, /exclude/);

  const c = analyzed({
    match: 'https://example.com/*',
    extraMeta: '// @exclude-match https://example.com/chat/*'
  });
  assert.equal(core.scopesOverlap(c, b).overlap, false);
});

test('해석 못 하는 include가 섞이면 겹치지 않는다고 단정하지 않는다', () => {
  const a = analyzed({ match: 'https://one.example/*', extraMeta: '// @include /^https:\\/\\/mystery\\./' });
  const b = analyzed({ match: 'https://two.example/*' });
  assert.equal(core.scopesOverlap(a, b).overlap, null);
});

test('DOM 읽기·쓰기·삭제·이벤트 듣기를 행동별로 나눈다', () => {
  const result = analyzed({ body: [
    "const box = document.querySelector('#box');",
    "box.textContent = '새 값';",
    "document.querySelector('.ad')?.remove();",
    "document.querySelector('#send').addEventListener('click', () => {});"
  ].join('\n') });
  assert.ok(result.facts.dom.read.includes('#box'));
  assert.ok(result.facts.dom.write.includes('#box'));
  assert.ok(result.facts.dom.remove.includes('.ad'));
  assert.ok(result.facts.dom.listen.includes('#send::click'));
});

test('local/session/GM 저장소 행동과 GM 격리 정보를 나눈다', () => {
  const result = analyzed({ body: [
    "localStorage.getItem('theme');",
    "localStorage.setItem('theme', 'dark');",
    "sessionStorage.removeItem('draft');",
    "GM_getValue('prefs');",
    "GM.setValue('prefs', {});"
  ].join('\n') });
  assert.deepEqual(result.facts.storage.local.read, ['theme']);
  assert.deepEqual(result.facts.storage.local.write, ['theme']);
  assert.deepEqual(result.facts.storage.session.delete, ['draft']);
  assert.deepEqual(result.facts.storage.gm.read, ['prefs']);
  assert.deepEqual(result.facts.storage.gm.write, ['prefs']);
  assert.equal(result.facts.storage.gm.isolatedPerScript, true);
});

test('완전히 같은 소스는 완전 중복으로 분류한다', () => {
  const code = script({ body: "document.querySelector('#x');" });
  const pair = core.assessPair(
    core.analyzeScript({ code, fileName: 'a.user.js' }),
    core.analyzeScript({ code, fileName: 'b.user.js' })
  );
  assert.equal(pair.classification, 'exact_duplicate');
  assert.equal(pair.recommendation.action, 'keep_one');
  assert.match(pair.recommendation.headline, /하나만/);
});

test('본문이 같아도 메타데이터가 다르면 삭제 가능한 완전 중복으로 보지 않는다', () => {
  const body = "document.querySelector('#x').textContent = 'ok';";
  const a = analyzed({ body }, 'a.user.js');
  const b = analyzed({ body, extraMeta: '// @match https://other.example/*\n// @grant GM_setValue' }, 'b.user.js');
  const pair = core.assessPair(a, b);
  assert.equal(pair.relationship.sameBody, true);
  assert.equal(pair.classification, 'same_version_variant');
  assert.equal(pair.recommendation.action, 'choose_one');
  assert.deepEqual(pair.recommendation.deleteIds, []);
});

test('저장 과정에서 원본 코드가 빠진 분석은 해시만으로 삭제 후보가 되지 않는다', () => {
  const a = analyzed({ body: "document.querySelector('#x');" }, 'a.user.js');
  const b = analyzed({ body: "document.querySelector('#x');" }, 'b.user.js');
  a.code = '';
  b.code = '';
  const pair = core.assessPair(a, b);
  assert.notEqual(pair.classification, 'exact_duplicate');
  assert.deepEqual(pair.recommendation.deleteIds, []);
});

test('해시가 같게 위조되어도 실제 문자열이 다르면 완전 중복으로 보지 않는다', () => {
  const a = analyzed({ version: '1.0.0', body: "const value = 'A B';" }, 'a.user.js');
  const b = analyzed({ version: '1.0.0', body: "const value = 'AB';" }, 'b.user.js');
  b.fingerprints.source = a.fingerprints.source;
  b.fingerprints.body = a.fingerprints.body;
  const pair = core.assessPair(a, b);
  assert.notEqual(pair.classification, 'exact_duplicate');
  assert.deepEqual(pair.recommendation.deleteIds, []);
});

test('관찰된 행동이 둘 다 없을 때 행동 유사도를 100%로 부풀리지 않는다', () => {
  const a = analyzed({ name: '빈 도구 A', namespace: 'a', body: "console.log('a');" });
  const b = analyzed({ name: '빈 도구 B', namespace: 'b', body: "console.log('b');" });
  assert.equal(core.assessPair(a, b).relationship.operationSimilarity, 0);
});

test('번역 이름이 달라도 원본 name과 namespace가 같으면 같은 계열로 본다', () => {
  const base = options => script({
    name: 'Canonical Tool',
    namespace: 'same-space',
    version: options.version,
    extraMeta: `// @name:ko ${options.localized}`,
    body: "document.querySelector('#same');"
  });
  const a = core.analyzeScript({ code: base({ version: '1.0.0', localized: '한국어 구판' }) });
  const b = core.analyzeScript({ code: base({ version: '1.1.0', localized: '한국어 신판' }) });
  assert.equal(core.assessPair(a, b).classification, 'older_version');
});

test('namespace가 둘 다 비어 있다는 이유만으로 같은 이름을 같은 계열로 묶지 않는다', () => {
  const a = analyzed({
    name: 'Helper', namespace: '', version: '1.0.0', match: 'https://one.example/*',
    body: "document.querySelector('#one')?.remove();"
  }, 'one.user.js');
  const b = analyzed({
    name: 'Helper', namespace: '', version: '2.0.0', match: 'https://two.example/*',
    body: "localStorage.setItem('other-tool', 'on');"
  }, 'two.user.js');
  const pair = core.assessPair(a, b);
  assert.equal(pair.relationship.sameFamily, false);
  assert.equal(pair.classification, 'unrelated');
  assert.equal(pair.relationship.evidence.includes('@namespace와 이름이 같습니다.'), false);
});

test('namespace가 없어도 같은 사이트의 충분히 비슷한 코드는 같은 계열 후보가 될 수 있다', () => {
  const a = analyzed({
    name: 'Helper', namespace: '', version: '1.0.0',
    body: "document.querySelector('#tool')?.classList.add('ready');"
  }, 'old-no-namespace.user.js');
  const b = analyzed({
    name: 'Helper', namespace: '', version: '1.1.0',
    body: "document.querySelector('#tool')?.classList.add('ready'); console.log('updated');"
  }, 'new-no-namespace.user.js');
  const pair = core.assessPair(a, b);
  assert.equal(pair.relationship.sameFamily, true);
  assert.equal(pair.classification, 'older_version');
});

test('같은 계열의 다른 버전이어도 실행 사이트가 다르면 끄기 권고를 하지 않는다', () => {
  const a = analyzed({
    name: '공용 도구', namespace: 'same-family', version: '1.0.0', match: 'https://one.example/*',
    body: "document.querySelector('#tool')?.classList.add('ready');"
  }, 'one-old.user.js');
  const b = analyzed({
    name: '공용 도구', namespace: 'same-family', version: '2.0.0', match: 'https://two.example/*',
    body: "document.querySelector('#tool')?.classList.add('ready'); console.log('v2');"
  }, 'two-new.user.js');
  const pair = core.assessPair(a, b);
  assert.equal(pair.scope.overlap, false);
  assert.equal(pair.classification, 'older_version');
  assert.equal(pair.compatibility.level, 'safe');
  assert.equal(pair.recommendation.action, 'keep_both');
  assert.deepEqual(pair.recommendation.disableIds, []);
  assert.match(pair.recommendation.headline, /둘 다 켜도/);
});

test('실행 사이트가 다른 같은 몸통은 완전 중복 삭제 후보로 만들지 않는다', () => {
  const body = "document.querySelector('#tool')?.classList.add('ready');";
  const a = analyzed({ name: '공용 도구', namespace: 'same-family', version: '1.0.0', match: 'https://one.example/*', body });
  const b = analyzed({ name: '공용 도구', namespace: 'same-family', version: '1.0.0', match: 'https://two.example/*', body });
  const pair = core.assessPair(a, b);
  assert.notEqual(pair.classification, 'exact_duplicate');
  assert.deepEqual(pair.recommendation.deleteIds, []);
  assert.deepEqual(pair.recommendation.disableIds, []);
});

test('버전 묶음은 최고 버전과 모든 구버전의 직접 관계가 있어야 만든다', () => {
  const scripts = [
    { id: 'a', meta: { version: '1.0.0' } },
    { id: 'b', meta: { version: '2.0.0' } },
    { id: 'c', meta: { version: '3.0.0' } }
  ];
  const relation = newerId => ({
    type: 'older_version', functionalDivergence: false, version: { newerId }
  });
  const edge = (scripts, newerId, overlap = true, action = 'keep_newer') => ({
    scripts,
    scope: { overlap },
    recommendation: { action },
    relationship: relation(newerId)
  });
  const chainOnly = [
    edge(['a', 'b'], 'b'),
    edge(['b', 'c'], 'c')
  ];
  assert.equal(core.planDirectVersionFamily(scripts, chainOnly), null);

  const directStar = [
    ...chainOnly,
    edge(['a', 'c'], 'c')
  ];
  assert.deepEqual(core.planDirectVersionFamily(scripts, directStar), {
    newestId: 'c', olderIds: ['b', 'a']
  });

  const disjointSites = [
    edge(['a', 'c'], 'c', false, 'keep_both'),
    edge(['b', 'c'], 'c', false, 'keep_both')
  ];
  assert.equal(core.planDirectVersionFamily(scripts, disjointSites), null);
});

test('같은 계열의 1.2와 1.10에서 구버전을 정확히 고른다', () => {
  const a = analyzed({ version: '1.2', body: "document.querySelector('#x');" }, 'old.user.js');
  const b = analyzed({ version: '1.10', body: "document.querySelector('#x');" }, 'new.user.js');
  const pair = core.assessPair(a, b);
  assert.equal(pair.classification, 'older_version');
  assert.equal(pair.relationship.version.newerId, b.id);
  assert.deepEqual(pair.recommendation.disableIds, [a.id]);
});

test('같은 버전인데 코드가 다르면 변형본으로 분류하고 삭제를 보류한다', () => {
  const a = analyzed({ version: '3.0.0', body: "document.querySelector('#a').remove();" }, 'a.user.js');
  const b = analyzed({ version: '3.0.0', body: "document.querySelector('#b').textContent = 'b';" }, 'b.user.js');
  const pair = core.assessPair(a, b);
  assert.equal(pair.classification, 'same_version_variant');
  assert.equal(pair.recommendation.action, 'choose_one');
  assert.deepEqual(pair.recommendation.deleteIds, []);
});

test('같은 요소를 둘 다 읽기만 하면 충돌로 세지 않는다', () => {
  const a = analyzed({ name: '읽기 A', namespace: 'a', body: "document.querySelector('#status');" });
  const b = analyzed({ name: '읽기 B', namespace: 'b', body: "document.querySelector('#status');" });
  const pair = core.assessPair(a, b);
  assert.deepEqual(pair.conflicts.selectors, []);
  assert.equal(pair.compatibility.level, 'safe');
  assert.equal(pair.recommendation.action, 'keep_both');
});

test('한쪽이 지우고 다른 쪽이 같은 요소를 듣는 경우 충돌 후보로 잡는다', () => {
  const a = analyzed({ name: '삭제 도구', namespace: 'a', body: "document.querySelector('#send').remove();" });
  const b = analyzed({ name: '전송 도구', namespace: 'b', body: "document.querySelector('#send').addEventListener('click', send);" });
  const pair = core.assessPair(a, b);
  assert.ok(pair.conflicts.selectors.some(item => item.kind === 'remove_vs_touch'));
  assert.ok(['caution', 'high'].includes(pair.compatibility.level));
});

test('같은 localStorage 키를 쓰고 읽으면 저장 충돌 후보로 잡는다', () => {
  const a = analyzed({ name: '저장 A', namespace: 'a', body: "localStorage.setItem('profile', '{}');" });
  const b = analyzed({ name: '저장 B', namespace: 'b', body: "localStorage.getItem('profile');" });
  const pair = core.assessPair(a, b);
  assert.deepEqual(pair.conflicts.storage[0], { channel: 'local', keys: ['profile'] });
  assert.ok(['caution', 'high'].includes(pair.compatibility.level));
});

test('같은 키라도 localStorage와 GM 저장소는 서로 충돌하지 않는다', () => {
  const a = analyzed({ name: '사이트 저장', namespace: 'a', body: "localStorage.setItem('prefs', '{}');" });
  const b = analyzed({ name: '전용 저장', namespace: 'b', body: "GM_getValue('prefs');" });
  assert.deepEqual(core.assessPair(a, b).conflicts.storage, []);
});

test('서로 다른 스크립트의 GM 저장소는 같은 키여도 격리한다', () => {
  const a = analyzed({ name: 'GM A', namespace: 'a', body: "GM_setValue('prefs', {});" });
  const b = analyzed({ name: 'GM B', namespace: 'b', body: "GM_getValue('prefs');" });
  assert.deepEqual(core.assessPair(a, b).conflicts.storage, []);
});

test('같은 name/namespace 계열의 GM 저장소 쓰기와 읽기는 검토 대상으로 둔다', () => {
  const a = analyzed({ version: '1.0.0', body: "GM_setValue('prefs', {});" });
  const b = analyzed({ version: '1.1.0', body: "GM_getValue('prefs');" });
  const pair = core.assessPair(a, b);
  assert.ok(pair.conflicts.storage.some(item => item.channel === 'gm' && item.keys.includes('prefs')));
});

test('fetch를 둘 다 호출만 하면 후킹 충돌로 세지 않는다', () => {
  const a = analyzed({ name: '호출 A', namespace: 'a', body: "fetch('/api/a');" });
  const b = analyzed({ name: '호출 B', namespace: 'b', body: "window.fetch('/api/b');" });
  const pair = core.assessPair(a, b);
  assert.equal(a.facts.network.fetch.call, true);
  assert.equal(b.facts.network.fetch.call, true);
  assert.deepEqual(pair.conflicts.network, []);
});

test('fetch 패치와 fetch 호출을 구분해 충돌 후보로 잡는다', () => {
  const a = analyzed({ name: '가로채기', namespace: 'a', body: "const oldFetch = window.fetch; window.fetch = (...args) => oldFetch(...args);" });
  const b = analyzed({ name: 'API 호출', namespace: 'b', body: "fetch('/api/data');" });
  const pair = core.assessPair(a, b);
  assert.equal(a.facts.network.fetch.patch, true);
  assert.ok(pair.conflicts.network.some(item => item.channel === 'fetch' && item.kind === 'patch_call'));
  assert.equal(pair.compatibility.level, 'notice');
  assert.ok(pair.compatibility.reasons.some(item => item.type === 'network' && item.severity === 'notice'));
});

test('같은 네트워크 함수를 둘 다 패치하면 높은 충돌 후보로 둔다', () => {
  const a = analyzed({ name: '패치 A', namespace: 'a', body: 'window.fetch = async (...args) => originalA(...args);' });
  const b = analyzed({ name: '패치 B', namespace: 'b', body: 'globalThis.fetch = async (...args) => originalB(...args);' });
  const pair = core.assessPair(a, b);
  assert.ok(pair.conflicts.network.some(item => item.channel === 'fetch' && item.kind === 'patch_patch'));
  assert.equal(pair.compatibility.level, 'high');
});

test('XHR prototype 패치와 XHR 생성을 구분한다', () => {
  const a = analyzed({ name: 'XHR 패치', namespace: 'a', body: 'XMLHttpRequest.prototype.open = function() {};' });
  const b = analyzed({ name: 'XHR 호출', namespace: 'b', body: 'const req = new XMLHttpRequest();' });
  assert.ok(core.assessPair(a, b).conflicts.network.some(item => item.channel === 'xhr'));
});

test('WebSocket prototype 패치와 WebSocket 생성을 구분한다', () => {
  const a = analyzed({ name: '소켓 패치', namespace: 'a', body: 'WebSocket.prototype.send = function(data) {};' });
  const b = analyzed({ name: '소켓 연결', namespace: 'b', body: "const ws = new WebSocket('wss://example.com/ws');" });
  assert.ok(core.assessPair(a, b).conflicts.network.some(item => item.channel === 'websocket'));
});

test('history 호출끼리는 안전하고 패치 대 호출은 후보로 잡는다', () => {
  const callA = analyzed({ name: '이동 A', namespace: 'a', body: "history.pushState({}, '', '/a');" });
  const callB = analyzed({ name: '이동 B', namespace: 'b', body: "history.replaceState({}, '', '/b');" });
  assert.deepEqual(core.assessPair(callA, callB).conflicts.network, []);
  const patch = analyzed({ name: '이동 패치', namespace: 'c', body: 'history.pushState = function() {};' });
  assert.ok(core.assessPair(patch, callA).conflicts.network.some(item => item.channel === 'history'));
});

test('같은 이벤트에서 preventDefault를 쓰면 이벤트 차단 후보로 잡는다', () => {
  const a = analyzed({ name: '키 차단', namespace: 'a', body: "document.addEventListener('keydown', e => e.preventDefault());" });
  const b = analyzed({ name: '키 단축키', namespace: 'b', body: "window.addEventListener('keydown', onKey);" });
  const pair = core.assessPair(a, b);
  assert.deepEqual(pair.conflicts.events, ['@document::keydown']);
  assert.equal(pair.compatibility.level, 'notice');
});

test('서로 다른 요소의 같은 click은 한쪽이 막아도 자동 충돌로 세지 않는다', () => {
  const a = analyzed({ name: '버튼 A', namespace: 'a', body: "const a = document.querySelector('#a'); a.addEventListener('click', e => e.preventDefault());" });
  const b = analyzed({ name: '버튼 B', namespace: 'b', body: "const b = document.querySelector('#b'); b.addEventListener('click', onClick);" });
  assert.deepEqual(core.assessPair(a, b).conflicts.events, []);
});

test('같은 요소의 같은 click 차단은 근거로 남기되 단독으로는 알림 단계다', () => {
  const a = analyzed({ name: '버튼 차단', namespace: 'a', body: "const a = document.querySelector('#send'); a.addEventListener('click', e => e.preventDefault());" });
  const b = analyzed({ name: '버튼 기능', namespace: 'b', body: "const b = document.querySelector('#send'); b.addEventListener('click', onClick);" });
  const pair = core.assessPair(a, b);
  assert.deepEqual(pair.conflicts.events, ['#send::click']);
  assert.equal(pair.compatibility.level, 'notice');
});

test('document 전역 차단은 같은 이벤트를 듣는 요소에도 영향을 줄 수 있다', () => {
  const a = analyzed({ name: '전역 차단', namespace: 'a', body: "document.addEventListener('click', e => e.preventDefault());" });
  const b = analyzed({ name: '요소 기능', namespace: 'b', body: "document.querySelector('#send').addEventListener('click', onClick);" });
  assert.deepEqual(core.assessPair(a, b).conflicts.events, ['@document::click']);
});

test('정적으로 알 수 없는 이벤트 대상은 불확실성만 남기고 충돌로 만들지 않는다', () => {
  const a = analyzed({ name: '동적 대상', namespace: 'a', body: "getTarget().addEventListener('click', e => e.preventDefault());" });
  const b = analyzed({ name: '요소 기능', namespace: 'b', body: "document.querySelector('#send').addEventListener('click', onClick);" });
  const pair = core.assessPair(a, b);
  assert.deepEqual(a.facts.events.blockTargets, []);
  assert.equal(a.facts.events.blockUncertain, true);
  assert.deepEqual(pair.conflicts.events, []);
});

test('다른 콜백의 preventDefault를 모든 이벤트에 잘못 붙이지 않는다', () => {
  const a = analyzed({
    name: '이벤트 A',
    namespace: 'a',
    body: [
      "document.addEventListener('click', e => e.preventDefault());",
      "document.addEventListener('keydown', onKey);"
    ].join('\n')
  });
  const b = analyzed({ name: '이벤트 B', namespace: 'b', body: "window.addEventListener('keydown', onKeyTwo);" });
  assert.deepEqual(a.facts.events.block, ['click']);
  assert.deepEqual(core.assessPair(a, b).conflicts.events, []);
});

test('이름으로 넘긴 동적 콜백의 차단 여부는 추측하지 않고 불확실성만 남긴다', () => {
  const a = analyzed({
    body: "function stop(e) { e.preventDefault(); } document.addEventListener('click', stop);"
  });
  assert.deepEqual(a.facts.events.block, []);
  assert.equal(a.facts.events.blockUncertain, true);
});

test('같은 CSS selector/property 쓰기를 시각 충돌 후보로 잡는다', () => {
  const a = analyzed({ name: '색상 A', namespace: 'a', body: "GM_addStyle('#panel { color: red; }');" });
  const b = analyzed({ name: '색상 B', namespace: 'b', body: "GM_addStyle('#panel { color: blue; }');" });
  const pair = core.assessPair(a, b);
  assert.ok(pair.conflicts.css.includes('#panel::color'));
  assert.notEqual(pair.compatibility.level, 'safe');
});

test('같은 CSS 값을 두 번 넣는 것은 충돌로 세지 않고 DOM 쓰기로 중복 집계하지 않는다', () => {
  const a = analyzed({ name: '색상 A', namespace: 'a', body: "GM_addStyle('#panel { color: red; }');" });
  const b = analyzed({ name: '색상 B', namespace: 'b', body: "GM_addStyle('#panel { color: red; }');" });
  const pair = core.assessPair(a, b);
  assert.deepEqual(pair.conflicts.css, []);
  assert.ok(!a.facts.dom.write.includes('#panel'));
  assert.deepEqual(a.facts.css.writes, [{ selector: '#panel', property: 'color', value: 'red' }]);
});

test('같은 뿌리지만 주소와 기능이 갈라진 두 판은 기능 포크로 분류한다', () => {
  const a = analyzed({
    version: '2.0.0',
    updateURL: 'https://one.example/tool.user.js',
    body: "localStorage.setItem('tool-a', '1'); document.querySelector('#legacy').remove();"
  }, 'one.user.js');
  const b = analyzed({
    version: '3.0.0',
    updateURL: 'https://two.example/tool.user.js',
    body: "window.fetch = async (...args) => fetch(...args); new WebSocket('wss://example.com/ws');"
  }, 'two.user.js');
  const pair = core.assessPair(a, b);
  assert.equal(pair.classification, 'functional_fork');
  assert.equal(pair.recommendation.action, 'review_fork');
});

test('이름·출처·코드·기능이 다른 파일은 무관으로 분류한다', () => {
  const a = analyzed({ name: '배경 꾸미기', namespace: 'theme', body: "GM_addStyle('body { color: red; }');" });
  const b = analyzed({ name: '채팅 저장', namespace: 'archive', body: "indexedDB.open('logs');" });
  assert.equal(core.assessPair(a, b).classification, 'unrelated');
});

test('모음 분석은 위험도 순으로 pair와 초보자 권장을 반환한다', () => {
  const oldScript = analyzed({ version: '1.0.0', body: "document.querySelector('#x');" }, 'old.user.js');
  const newScript = analyzed({ version: '1.1.0', body: "document.querySelector('#x');" }, 'new.user.js');
  const other = analyzed({ name: '다른 도구', namespace: 'other', match: 'https://other.example/*', body: "console.log('ok');" });
  const report = core.analyzeCollection([oldScript, newScript, other]);
  assert.equal(report.summary.scripts, 3);
  assert.equal(report.summary.outdated, 1);
  assert.equal(report.pairs[0].recommendation.action, 'keep_newer');
});

test('큰 소스의 토큰 지문은 결정적으로 384개 이하만 보관한다', () => {
  const body = Array.from(
    { length: 2500 },
    (_, index) => `const node${index} = document.querySelector('#item-${index}'); node${index}.textContent = '${index}';`
  ).join('\n');
  const code = script({ name: '대형 지문', body });
  const first = core.analyzeScript({ code });
  const second = core.analyzeScript({ code });
  assert.ok(first.fingerprints.shingles.length <= 384);
  assert.deepEqual(first.fingerprints.shingles, second.fingerprints.shingles);
});

test('대량 추출 결과는 각 사실 범주 상한을 넘지 않는다', () => {
  const count = 260;
  const css = Array.from({ length: count }, (_, index) => `#item-${index} { color: rgb(${index % 255}, 0, 0); }`).join(' ');
  const body = [
    `GM_addStyle(${JSON.stringify(css)});`,
    ...Array.from({ length: count }, (_, index) => `document.querySelector('#item-${index}');`),
    ...Array.from({ length: count }, (_, index) => `localStorage.getItem('key-${index}');`),
    ...Array.from({ length: count }, (_, index) => `window.addEventListener('event-${index}', handler);`),
    ...Array.from({ length: count }, () => 'history.pushState({}, "", "/next");')
  ].join('\n');
  const facts = analyzed({ name: '상한 테스트', body }).facts;
  assert.ok(facts.css.writes.length <= 160);
  assert.ok(facts.css.selectors.length <= 160);
  assert.ok(facts.css.properties.write.length <= 160);
  assert.ok(facts.dom.read.length <= 160);
  assert.ok(facts.storage.local.read.length <= 160);
  assert.ok(facts.events.listen.length <= 160);
  assert.ok(facts.events.listenTargets.length <= 160);
  assert.ok(facts.network.history.call.length <= 160);
  assert.ok(facts.operations.filter(item => item.kind === 'css').length <= 160);
});

let passed = 0;
for (const item of tests) {
  try {
    item.run();
    passed += 1;
    process.stdout.write(`✓ ${item.name}\n`);
  } catch (error) {
    process.stderr.write(`✗ ${item.name}\n${error.stack}\n`);
    process.exitCode = 1;
  }
}

process.stdout.write(`\n${passed}/${tests.length} tests passed\n`);
