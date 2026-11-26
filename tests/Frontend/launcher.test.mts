import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const read = path => readFileSync(new URL('../../' + path, import.meta.url), 'utf8');
const source = read('chrome/content.js');

// Expose the private functions in an isolated VM. The production script still runs its
// normal startup on a blank document. All browser operations below use test doubles.
function loadLauncher(fetch = () => assert.fail('unexpected fetch')) {
  const document = {
    documentElement: {}, querySelector: () => null, querySelectorAll: () => [],
    addEventListener() {}, createElement: () => element()
  };
  const launches = [];
  let observer;
  let frameCount = 0;
  const window = {
    location: { pathname: '/', hash: '', search: '', href: 'https://example.test/', origin: 'https://example.test',
      assign(url) { launches.push(url); } },
    requestAnimationFrame() { frameCount++; }, addEventListener() {}, setInterval() {},
    btoa: value => Buffer.from(value, 'binary').toString('base64')
  };
  const env = { document, window, URL, TextEncoder, AbortController, fetch,
    MutationObserver: class { constructor(callback) { observer = callback; } observe() {} }
  };
  const closing = source.lastIndexOf('}());');
  assert.ok(closing > 0);
  const expose = 'globalThis.launcher = { collectLinks, extractIssueContext, createToolButton, ' +
    'buildDiagnosticsReport, finalizeSources, issueState, mountPanel, createLaunchButton, updateLaunchButton, refreshIssuePanel };';
  runInNewContext(source.slice(0, closing) + expose + source.slice(closing), env);
  return { api: env.launcher, document, window, launches, observer, frameCount: () => frameCount };
}

function element(tag = 'div', text = '', attrs = {}, children = []) {
  const events = new Map();
  const node = {
    localName: tag, textContent: text, children, dataset: {}, style: {}, parentElement: null,
    getAttribute: key => attrs[key] ?? null,
    setAttribute(key, value) { attrs[key] = value; },
    matches(selector) {
      return selector.split(',').map(part => part.trim()).some(part => {
        if (part === tag || (part === 'a[href]' && tag === 'a' && Boolean(attrs.href))) return true;
        if (part.startsWith('.')) return (attrs.class || '').split(/\s+/).includes(part.slice(1));
        if (!/^(?:\[[\w-]+(?:="[^"]*")?\])+$/.test(part)) return false;
        return Array.from(part.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)).every(([, key, value]) =>
          Object.hasOwn(attrs, key) && (value === undefined || attrs[key] === value));
      });
    },
    querySelectorAll(selector) {
      const descendants = children.flatMap(child => [child, ...child.querySelectorAll('*')]);
      if (selector === '*') return descendants;
      return descendants.filter(child => selector.split(',').some(part => child.matches(part.trim())));
    },
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; },
    closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) ?? null; },
    contains(other) { return this === other || children.some(child => child.contains(other)); },
    appendChild(child) { children.push(child); child.parentElement = this; },
    addEventListener(type, callback) { events.set(type, callback); },
    click() { events.get('click')?.({ preventDefault() {}, stopPropagation() {} }); }
  };
  children.forEach((child, index) => {
    child.parentElement = node;
    child.nextElementSibling = children[index + 1] ?? null;
  });
  return node;
}

test('Chrome and Firefox ship the same launcher and Firefox retains its update identity', () => {
  assert.equal(source, read('firefox/content.js'));
  assert.equal(JSON.parse(read('firefox/manifest.json')).browser_specific_settings.gecko.id,
    'okdesk-clearbat-launcher@ruffid.local');
});

test('only the bound equipment field supplies cards, including duplicate names and icon-only links', () => {
  const { api, document } = loadLauncher();
  const direct = element('a', 'Касса', { href: '/equipments/42' });
  const duplicate = element('a', 'Касса', { href: '/equipments/42/?view=short' });
  const icon = element('a', '', { href: '/equipments/43' });
  const magnifierRow = element('li', 'Касса', {}, [icon]);
  const value = element('dd', 'Касса Касса', {}, [direct, duplicate, magnifierRow]);
  const label = element('dt', 'Оборудование');
  label.nextElementSibling = value;
  const comment = element('a', 'Другая касса', { href: '/equipments/999' });
  let labels = [label];
  document.querySelectorAll = selector => selector.startsWith('dt,') ? labels :
    (selector === 'a[href]' ? [comment] : []);
  const equipment = () => Array.from(api.extractIssueContext().fields.equipment.links, link => [link.text, link.url]);
  assert.deepEqual(equipment(), [
    ['Касса', 'https://example.test/equipments/42'], ['Касса', 'https://example.test/equipments/43']
  ]);
  label.nextElementSibling = element('dd');
  assert.deepEqual(equipment(), []);
  labels = [];
  assert.deepEqual(equipment(), []);
});

test('a launch keeps the URL out of button attributes and passes it unchanged on click', () => {
  const { api, launches } = loadLauncher();
  const url = 'clearbat:/encoded-test-value?encode=full';
  const tool = { id: 'iikoOffice', displayName: 'iikoOffice', getUrl: access => access.office };
  const button = api.createToolButton(tool, { kind: 'equipment', access: { office: url } });
  assert.deepEqual(Object.keys(button.dataset), ['tool']);
  assert.deepEqual(launches, []);
  button.click();
  assert.deepEqual(launches, [url]);
});

test('the second linked device can still use shared iiko credentials', () => {
  const { api } = loadLauncher();
  const devices = [
    { kind: 'equipment', order: 0, rawAccess: { credentials: { login: 'shared', password: 'sample' } } },
    { kind: 'equipment', order: 1, rawAccess: { credentials: { login: '' },
      iikoOfficeServer: { address: 'host:443', password: '' } } }
  ];
  const url = api.finalizeSources(devices)[1].access.iikoOffice;
  const encoded = url.match(/^clearbat:\/([^?]+)\?encode=full$/)[1];
  assert.equal(Buffer.from(encoded, 'base64').toString(), '?type=iiko?url=host:443?login=shared?password=sample');
});

test('an existing equipment-card button uses the latest credentials and stops launching when cleared', () => {
  const { api, launches } = loadLauncher();
  const button = api.createLaunchButton();
  const options = { displayName: 'RustDesk', iconFile: 'rustdesk.ico', isReady: true };
  api.updateLaunchButton(button, { ...options, clearbatUrl: 'clearbat:/old' });
  api.updateLaunchButton(button, { ...options, clearbatUrl: 'clearbat:/current' });
  button.click();
  api.updateLaunchButton(button, { ...options, isReady: false, clearbatUrl: '' });
  button.click();
  assert.deepEqual(launches, ['clearbat:/current']);
  assert.deepEqual(Object.keys(button.dataset), ['isReady']);
});

test('diagnostics contain only field tags, counts, source kinds and bounded error codes', () => {
  const { api } = loadLauncher();
  api.issueState.context = { fields: { equipment: {
    labelElement: { localName: 'dt', textContent: 'secret' }, container: { localName: 'dd', outerHTML: 'secret' },
    links: [{ text: 'secret', url: 'https://private.test/' }]
  } } };
  api.issueState.sources = ['HTTP 403', 'Превышено время ожидания', 'secret', ''].map(error =>
    ({ kind: 'equipment', name: 'secret', error, access: { iikoOffice: 'secret' } }));
  assert.deepEqual(JSON.parse(api.buildDiagnosticsReport()), {
    fields: { equipment: { labelTag: 'dt', valueTag: 'dd', cardCount: 1 } },
    sources: ['http_403', 'timeout', 'read_failed', null].map(errorCode => ({ kind: 'equipment', errorCode }))
  });
});

test('panel mutations and unchanged header text do not trigger another scan', () => {
  const { api, observer, frameCount } = loadLauncher();
  const header = { textContent: 'Клиент: Тест', title: '' };
  Object.defineProperty(header, 'textContent', { get: () => 'Клиент: Тест', set() { assert.fail('redundant write'); } });
  const panel = { isConnected: true, querySelector: () => header, contains: target => target === header };
  api.issueState.panel = panel;
  api.mountPanel(panel, { clientName: 'Тест', objectName: '' });
  const mutation = target => ({ type: 'childList', target, addedNodes: [{}], removedNodes: [] });
  observer([mutation(header)]);
  assert.equal(frameCount(), 0);
  observer([mutation({})]);
  assert.equal(frameCount(), 1);
});

// Run scheduled scans with a synthetic issue, using explicit ticks instead of real delays.
function issuePage(fetch?) {
  const launcher = loadLauncher(fetch);
  const { api, window } = launcher;
  const timers = new Map();
  let id = 0;
  window.setTimeout = (callback, delay) => {
    timers.set(++id, { callback, delay });
    return id;
  };
  window.clearTimeout = key => timers.delete(key);
  window.location.pathname = '/issues/123';
  launcher.observer([]);
  api.issueState.panel = { isConnected: true, querySelector: () => null, contains: () => false, remove() {} };
  api.issueState.body = element();
  async function tick() {
    const next = [...timers.entries()].sort((a, b) => a[1].delay - b[1].delay)[0];
    assert.ok(next, 'expected a scheduled scan');
    timers.delete(next[0]);
    next[1].callback();
    await new Promise(resolve => setImmediate(resolve));
  }
  return { ...launcher, tick, timers };
}

test('late link attributes trigger a scan after the initial empty issue has settled', async () => {
  const page = issuePage(async () => ({
    ok: true, headers: { get: () => 'application/json' }, text: async () => '[{"code":"rustdesk","value":"314"}]'
  }));
  const { api, document, observer, tick, timers } = page;
  let href = '';
  const anchor = element('a', 'Касса');
  anchor.getAttribute = key => key === 'href' ? href : null;
  anchor.matches = selector => selector === 'a[href]' && Boolean(href);
  const label = element('dt', 'Оборудование');
  label.nextElementSibling = element('dd', 'Касса', {}, [anchor]);
  document.querySelectorAll = selector => selector.startsWith('dt,') ? [label] : [];
  for (let i = 0; timers.size && i < 8; i++) await tick();
  assert.equal(timers.size, 0, 'a genuinely empty issue stops retrying');
  assert.match(api.issueState.body.children.at(-1).textContent, /Доступы не найдены/);
  href = '/equipments/42';
  observer([{ type: 'attributes', attributeName: 'href', target: anchor }]);
  await tick();
  assert.ok(api.issueState.sources.some(item => item.kind === 'equipment' && item.access.rustdesk));
});

test('late local access is re-read when the linked card URLs stay the same', async () => {
  const { api, document, observer, tick } = issuePage();
  let value = 'pending';
  document.querySelectorAll = selector => selector === 'script:not([src])'
    ? [{ textContent: JSON.stringify([{ code: value === 'pending' ? 'other_parameter' : 'rustdesk', value }]) }] : [];
  await tick();
  assert.equal(api.issueState.sources.some(item => item.access.rustdesk), false);
  value = '314';
  observer([{ type: 'childList', target: {}, addedNodes: [{}], removedNodes: [] }]);
  await tick();
  assert.ok(api.issueState.sources.some(item => item.access.rustdesk));
});

test('an initially empty linked card is retried automatically and success stops retries', async () => {
  let reads = 0;
  const { api, document, tick, timers } = issuePage(async () => ({
    ok: true, headers: { get: () => 'application/json' },
    text: async () => JSON.stringify([++reads === 1 ? { code: 'note', value: 'pending' } : { code: 'rustdesk', value: '314' }])
  }));
  const label = element('dt', 'Клиент');
  label.nextElementSibling = element('dd', 'Компания', {}, [element('a', 'Компания', { href: '/companies/1' })]);
  document.querySelectorAll = selector => selector.startsWith('dt,') ? [label] : [];
  await tick();
  assert.equal(reads, 1);
  assert.doesNotMatch(api.issueState.body.children.at(-1).textContent, /Доступы не найдены/);
  await tick();
  assert.equal(reads, 2);
  assert.ok(api.issueState.sources.some(item => item.access.rustdesk));
  assert.equal(timers.size, 0);
});

test('changing issues cancels a pending empty retry and reloads the shared client card', async () => {
  let value = '';
  let reads = 0;
  const { api, document, window, observer, tick, timers } = issuePage(async () => {
    reads++;
    const param = value ? { code: 'rustdesk', value } : { code: 'note', value: 'pending' };
    return { ok: true, headers: { get: () => 'application/json' }, text: async () => JSON.stringify([param]) };
  });
  const label = element('dt', 'Клиент');
  label.nextElementSibling = element('dd', 'Компания', {}, [element('a', 'Компания', { href: '/companies/1' })]);
  document.querySelectorAll = selector => selector.startsWith('dt,') ? [label] : [];
  await tick();
  assert.equal(timers.size, 1);
  const panel = api.issueState.panel;
  const body = api.issueState.body;
  function navigate(id) {
    window.location.pathname = '/issues/' + id;
    observer([]);
    api.issueState.panel = panel;
    api.issueState.body = body;
  }
  value = '101';
  navigate(124);
  assert.equal(timers.size, 1, 'only the new issue scan is pending');
  await tick();
  assert.equal(api.issueState.sources[0].rawAccess.rustdeskRaw, '101');
  value = '202';
  navigate(125);
  await tick();
  assert.equal(api.issueState.sources[0].rawAccess.rustdeskRaw, '202');
  assert.equal(reads, 3);
  assert.equal(timers.size, 0);
});

// The marker sits inside the help icon in the heading. The equipment list is its sibling.
function equipmentField(...blocks) {
  const help = element('div', '', { 'data-category': 'issue_card', 'data-position': 'equipments' });
  const header = element('div', 'Оборудование:', {}, [
    element('div', 'Оборудование:'), element('span', '', {}, [help]),
    element('a', '', { href: '/issues/123/equipments/new', 'data-role': 'new-equipment' }), element('i')
  ]);
  return element('div', '', {}, [header, ...blocks.map(rows => element('div', '', {}, rows))]);
}

function equipmentRow(id, text, linkedName, previewId) {
  const name = linkedName ? element('a', text, { href: '/equipments/' + id }) : element('span', text);
  const preview = element('a', '', {
    href: '/equipments/' + id + '/previews?preview_dialog_id=test',
    'data-role': 'preview-dialog-show-btn', 'data-equipment-id': previewId,
    'data-preview_type': 'equipment', 'data-remote': 'true'
  }, [element('i')]);
  const dialog = element('div', '', { class: 'preview-dialog equipment-preview' });
  return element('div', text, {}, [element('div'), name, element('span', '', {}, [preview, dialog])]);
}

test('the collapsed issue card loads its equipment from the marked field before opening a preview', async () => {
  const requested = [];
  const { api, document, tick } = issuePage(async url => {
    requested.push(url);
    return { ok: true, headers: { get: () => 'application/json' },
      text: async () => '[{"code":"rustdesk","value":"314"}]' };
  });

  const comments = element('blockquote', '', {}, [equipmentField([equipmentRow('900', 'Из комментария', true, '901')])]);
  const root = element('main', '', {}, [comments, equipmentField([
    equipmentRow('4070', 'Сервер Iiko RMS', true, '974060'), equipmentRow('4080', 'Резервный сервер', false, '974070')
  ]), element('a', 'Другое оборудование', { href: '/equipments/999' })]);
  document.querySelectorAll = selector => root.querySelectorAll(selector);
  await tick();
  assert.deepEqual(requested, ['https://example.test/equipments/4070', 'https://example.test/equipments/4080']);
  assert.deepEqual(Array.from(api.issueState.sources.filter(item => item.kind === 'equipment'),
    item => [item.name, Boolean(item.access.rustdesk)]), [['Сервер Iiko RMS', true], ['Резервный сервер', true]]);
});

test('all equipment blocks under the issue field heading appear in the panel', async () => {
  const requested = [];
  const { api, document, tick } = issuePage(async url => {
    requested.push(url);
    return { ok: true, headers: { get: () => 'application/json' },
      text: async () => '[{"code":"rustdesk","value":"314"}]' };
  });
  const cashRegister = equipmentRow('6372', 'Касса Терминал 1 Этаж ГК RustDesk Используется Да', true, '1439409');
  const server = equipmentRow('16337', 'Сервер Iiko RMS Ресторан Итальяно', true, '3356878');
  const field = equipmentField([cashRegister], [server]);
  const outside = equipmentRow('999', 'Из соседнего поля', true, '777');
  const root = element('main', '', {}, [field, outside]);
  document.querySelectorAll = selector => root.querySelectorAll(selector);

  await tick();

  assert.deepEqual(requested, ['https://example.test/equipments/6372', 'https://example.test/equipments/16337']);
  const displayed = api.issueState.body.children.filter(child => child.dataset.kind === 'equipment');
  assert.deepEqual(displayed.map(row => row.children[0].children[1].textContent),
    ['Касса Терминал 1 Этаж ГК', 'Сервер Iiko RMS Ресторан Итальяно']);
});
