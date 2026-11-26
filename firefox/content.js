(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Общие константы
  // ---------------------------------------------------------------------------
  const LAUNCH_BUTTON_CLASS = 'okdesk-clearbat-launch-button';
  const INFO_BUTTON_CLASS = 'okdesk-clearbat-info-button';
  const PANEL_ID = 'okdesk-ticket-launcher-panel';
  const PANEL_COLLAPSED_KEY = 'okdesk-ticket-launcher-collapsed';
  const PANEL_COMPACT_KEY = 'okdesk-ticket-launcher-compact';
  const PANEL_ICON_LAYOUT_KEY = 'okdesk-ticket-launcher-icon-layout';
  const ACCESS_VALUE_SEPARATOR = '/';
  const IIKO_CREDENTIALS_PARAMETER_CODE = '0008';
  const WEB_LINK_PARAMETER_CODE = '1212';
  const INVALID_PLACEHOLDER_VALUES = new Set([
    '-', 'неуказано', '[неуказано]', 'нет', 'none', 'null',
    'да', 'yes', 'true', 'false', 'используется', 'используетсяда', 'используетсянет',
    'неиспользуется'
  ]);
  const MAX_EQUIPMENT_TO_FETCH = 8;
  const FETCH_TIMEOUT_MS = 15000;
  const EMPTY_RETRY_DELAYS_MS = [1000, 3000];

  const ACCESS_BUTTONS = [
    { parameterCode: 'AnyDesk', clearbatType: 'anydesk', displayName: 'AnyDesk', iconFile: 'anydesk.png', requirePassword: true },
    { parameterCode: 'AA', clearbatType: 'ammyy', displayName: 'АмиАдмин', iconFile: 'ammyadmin.png', requirePassword: false },
    { parameterCode: 'AC', clearbatType: 'assistant', displayName: 'Ассистент', iconFile: 'assistant.png', requirePassword: false },
    { parameterCode: 'rust', clearbatType: 'rustdesk', displayName: 'RustDesk', iconFile: 'rustdesk.ico', requirePassword: false }
  ];

  const SERVER_ACCESS_BUTTONS = [
    { parameterCode: 'srv_addr', displayName: 'iikoOffice', iconFile: 'iikoOffice_icon.ico' },
    { parameterCode: '0017', displayName: 'iikoChain', iconFile: 'iikoChain_icon.ico' }
  ];

  const TICKET_TOOLS = [
    {
      id: 'iikoOffice',
      displayName: 'iikoOffice',
      iconFile: 'iikoOffice_icon.ico',
      getUrl: function (access) { return access.iikoOffice; }
    },
    {
      id: 'iikoChain',
      displayName: 'iikoChain',
      iconFile: 'iikoChain_icon.ico',
      getUrl: function (access) { return access.iikoChain; }
    },
    {
      id: 'iikoWeb',
      displayName: 'iikoWeb',
      iconFile: 'iikoweb.png',
      launch: 'browser',
      getUrl: function (access) { return access.iikoWeb; }
    },
    {
      id: 'assistant',
      displayName: 'Ассистент',
      iconFile: 'assistant.png',
      getUrl: function (access) { return access.assistant; }
    },
    {
      id: 'rustdesk',
      displayName: 'RustDesk',
      iconFile: 'rustdesk.ico',
      getUrl: function (access) { return access.rustdesk; }
    },
    {
      id: 'anydesk',
      displayName: 'AnyDesk',
      iconFile: 'anydesk.png',
      getUrl: function (access) { return access.anydesk; }
    }
  ];

  const LABEL_ALIASES = {
    client: ['клиент', 'заказчик', 'компания'],
    object: ['объект обслуживания', 'объект', 'адрес объекта'],
    equipment: ['оборудование', 'оборудование на объекте']
  };

  const runtimeApi = (typeof chrome !== 'undefined' && chrome.runtime)
    ? chrome.runtime
    : (typeof browser !== 'undefined' && browser.runtime ? browser.runtime : null);

  let scanScheduled = false;
  let issueScanTimer = null;
  let lastIssueUrl = '';
  let entityCache = new Map();
  let emptyRetryTimer = null;
  const equipmentButtonUrls = new WeakMap();
  const issueState = {
    key: '',
    signature: '',
    panel: null,
    body: null,
    sources: [],
    context: null,
    requestToken: 0,
    emptyRetries: 0
  };

  // ---------------------------------------------------------------------------
  // Старое поведение: кнопки в карточке оборудования
  // ---------------------------------------------------------------------------
  function scheduleScanAccessParameters() {
    if (scanScheduled) {
      return;
    }

    scanScheduled = true;
    window.requestAnimationFrame(function () {
      scanScheduled = false;
      scanAccessParameters();
    });
  }

  function scanAccessParameters() {
    for (const accessButton of ACCESS_BUTTONS) {
      const items = document.querySelectorAll(`[data-role^="equipment-parameter-${accessButton.parameterCode}-"]`);

      for (const item of items) {
        addLaunchButton(item, accessButton);
      }
    }

    for (const accessButton of SERVER_ACCESS_BUTTONS) {
      const items = document.querySelectorAll(`[data-role^="equipment-parameter-${accessButton.parameterCode}-"]`);

      for (const item of items) {
        addServerLaunchButton(item);
      }
    }

    const webLinkItems = document.querySelectorAll(`[data-role^="equipment-parameter-${WEB_LINK_PARAMETER_CODE}-"]`);
    for (const item of webLinkItems) {
      makeWebLinkClickable(item);
    }
  }

  function addLaunchButton(item, accessButton) {
    const valueElement = item.querySelector('[data-role="bip-value"]');
    const labelElement = item.querySelector('dt');
    if (!valueElement) {
      return;
    }

    const credentials = parseAccessCredentials(valueElement.textContent, accessButton.requirePassword);
    if (credentials === null) {
      upsertLaunchControls(item, labelElement, valueElement, {
        clearbatUrl: '',
        displayName: accessButton.displayName,
        iconFile: accessButton.iconFile,
        isReady: false,
        message: getTerminalInvalidMessage(accessButton)
      });
      return;
    }

    upsertLaunchControls(item, labelElement, valueElement, {
      clearbatUrl: buildClearbatUrl(accessButton.clearbatType, credentials),
      displayName: accessButton.displayName,
      iconFile: accessButton.iconFile,
      isReady: true,
      message: getReadyMessage(accessButton.displayName)
    });
  }

  function addServerLaunchButton(item) {
    const valueElement = item.querySelector('[data-role="bip-value"]');
    const labelElement = item.querySelector('dt');
    if (!valueElement) {
      return;
    }

    const scope = item.closest('.custom-parameters-list') || document;
    const iikoCredentialsElement = scope.querySelector(`[data-role^="equipment-parameter-${IIKO_CREDENTIALS_PARAMETER_CODE}-"] [data-role="bip-value"]`);
    const iikoCredentials = parseAccessCredentials(iikoCredentialsElement ? iikoCredentialsElement.textContent : '', false);
    const serverAccess = parseServerAccess(valueElement.textContent);
    if (iikoCredentials === null || serverAccess === null) {
      upsertLaunchControls(item, labelElement, valueElement, {
        clearbatUrl: '',
        displayName: getServerDisplayName(item),
        iconFile: getServerIconFile(item),
        isReady: false,
        message: getServerInvalidMessage(iikoCredentials, serverAccess)
      });
      return;
    }

    const clearbatUrl = buildIikoClearbatUrl(serverAccess.address, {
      login: iikoCredentials.login,
      password: serverAccess.password || iikoCredentials.password
    });

    upsertLaunchControls(item, labelElement, valueElement, {
      clearbatUrl,
      displayName: getServerDisplayName(item),
      iconFile: getServerIconFile(item),
      isReady: true,
      message: getServerReadyMessage(getServerDisplayName(item))
    });
  }

  function upsertLaunchControls(item, labelElement, valueElement, options) {
    let button = item.querySelector(`.${LAUNCH_BUTTON_CLASS}`);
    if (!button) {
      button = createLaunchButton();
      appendControl(labelElement, valueElement, button);
    }

    updateLaunchButton(button, options);

    let infoButton = item.querySelector(`.${INFO_BUTTON_CLASS}`);
    if (!infoButton) {
      infoButton = createInfoButton();
      button.insertAdjacentElement('afterend', infoButton);
    }

    infoButton.title = options.message;
    infoButton.setAttribute('aria-label', options.message);
  }

  function appendControl(labelElement, valueElement, control) {
    if (labelElement) {
      labelElement.appendChild(control);
      return;
    }

    valueElement.insertAdjacentElement('afterend', control);
  }

  function createLaunchButton() {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = LAUNCH_BUTTON_CLASS;
    button.style.cssText = [
      'margin-left: 8px',
      'padding: 0',
      'border: 1px solid transparent',
      'border-radius: 4px',
      'width: 26px',
      'height: 26px',
      'min-width: 26px',
      'min-height: 26px',
      'cursor: pointer',
      'vertical-align: middle',
      'display: inline-flex',
      'align-items: center',
      'justify-content: center',
      'overflow: hidden'
    ].join(';');

    button.addEventListener('mouseenter', function () {
      applyLaunchButtonInteractiveState(button, true);
    });
    button.addEventListener('mouseleave', function () {
      applyLaunchButtonInteractiveState(button, false);
    });
    button.addEventListener('focus', function () {
      applyLaunchButtonInteractiveState(button, true);
    });
    button.addEventListener('blur', function () {
      applyLaunchButtonInteractiveState(button, false);
    });
    button.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      launchClearbatUrl(equipmentButtonUrls.get(button));
    });

    return button;
  }

  function updateLaunchButton(button, options) {
    button.title = options.isReady
      ? `Запустить ${options.displayName}`
      : options.message;
    button.setAttribute('aria-label', button.title);
    button.dataset.isReady = options.isReady ? 'true' : 'false';
    button.style.cursor = options.isReady ? 'pointer' : 'default';
    applyLaunchButtonInteractiveState(button, false);
    equipmentButtonUrls.set(button, options.clearbatUrl);

    let icon = button.querySelector('img');
    if (!icon) {
      icon = document.createElement('img');
      icon.style.cssText = [
        'display: block',
        'width: 100%',
        'height: 100%',
        'object-fit: contain',
        'box-sizing: border-box',
        'padding: 2px'
      ].join(';');
      button.appendChild(icon);
    }

    icon.src = getIconUrl(options.iconFile);
    icon.alt = options.displayName;
    icon.style.opacity = options.isReady ? '1' : '0.55';
    icon.style.filter = options.isReady ? '' : 'grayscale(1)';
  }

  function applyLaunchButtonInteractiveState(button, isActive) {
    if (button.dataset.isReady === 'true') {
      button.style.borderColor = isActive ? '#2f80ed' : 'transparent';
      button.style.background = 'transparent';
      return;
    }

    button.style.borderColor = isActive ? '#d93025' : '#b8bec7';
    button.style.background = isActive ? '#d93025' : '#f1f3f4';
  }

  function createInfoButton() {
    const infoButton = document.createElement('span');
    infoButton.className = INFO_BUTTON_CLASS;
    infoButton.textContent = '?';
    infoButton.tabIndex = 0;
    infoButton.style.cssText = [
      'display: inline-flex',
      'align-items: center',
      'justify-content: center',
      'width: 14px',
      'height: 14px',
      'margin-left: 4px',
      'border: 1px solid #8a8f98',
      'border-radius: 50%',
      'color: #555f6d',
      'background: #ffffff',
      'font: 10px Arial, sans-serif',
      'line-height: 14px',
      'cursor: help',
      'vertical-align: super'
    ].join(';');

    return infoButton;
  }

  function getTerminalInvalidMessage(accessButton) {
    if (accessButton.requirePassword) {
      return `Заполните поле ${accessButton.displayName} в формате: идентификатор / пароль. Также на ПК должен быть установлен и настроен CLEAR.bat для обработки ссылок clearbat.`;
    }

    return `Заполните поле ${accessButton.displayName}. Допустимый формат: идентификатор или идентификатор / пароль. Также на ПК должен быть установлен и настроен CLEAR.bat для обработки ссылок clearbat.`;
  }

  function getServerInvalidMessage(iikoCredentials, serverAccess) {
    if (iikoCredentials === null && serverAccess === null) {
      return 'Заполните адрес сервера и поле Iiko логин/пароль. Адрес указывается в формате host или host:port, а поле Iiko логин/пароль обязательно для запуска обычного сервера и iikoChain через CLEAR.bat.';
    }

    if (serverAccess === null) {
      return 'Заполните поле Адрес сервера в формате host или host:port. Для запуска также обязательно должно быть заполнено поле Iiko логин/пароль в формате login / password, а на ПК должен быть установлен и настроен CLEAR.bat.';
    }

    return 'Заполните поле Iiko логин/пароль в формате login / password. Эти данные обязательны для запуска подключения к серверу или iikoChain через CLEAR.bat.';
  }

  function getReadyMessage(displayName) {
    return `Кнопка запускает ${displayName} через ссылку clearbat. На ПК должен быть установлен и настроен CLEAR.bat, а браузер должен разрешить открытие внешнего приложения.`;
  }

  function getServerReadyMessage(displayName) {
    return `Кнопка запускает ${displayName} через ссылку clearbat. Для запуска используется поле Iiko логин/пароль, оно должно быть заполнено в формате login / password. На ПК должен быть установлен и настроен CLEAR.bat, а браузер должен разрешить открытие внешнего приложения.`;
  }

  function getServerDisplayName(item) {
    return getParameterCode(item) === '0017' ? 'iikoChain' : 'iikoOffice';
  }

  function getServerIconFile(item) {
    return getParameterCode(item) === '0017' ? 'iikoChain_icon.ico' : 'iikoOffice_icon.ico';
  }

  function getParameterCode(item) {
    const role = item.getAttribute('data-role') || '';
    const prefix = 'equipment-parameter-';
    if (!role.startsWith(prefix)) {
      return '';
    }

    const withoutPrefix = role.slice(prefix.length);
    const lastSeparatorIndex = withoutPrefix.lastIndexOf('-');
    return lastSeparatorIndex < 0 ? withoutPrefix : withoutPrefix.slice(0, lastSeparatorIndex);
  }

  // ---------------------------------------------------------------------------
  // Страница заявки: определение и поиск клиента / объекта / оборудования
  // ---------------------------------------------------------------------------
  function getIssueId() {
    const path = `${window.location.pathname}${window.location.hash}`;
    const urlMatch = path.match(/(?:issues?|tickets?)\/(\d+)/i);
    if (urlMatch) {
      return urlMatch[1];
    }

    const titleElement = document.querySelector('h1, h2, .issue-title, .b-issue-title, [data-role="issue-title"]');
    const titleMatch = titleElement ? titleElement.textContent.match(/заявк[аи]\s*№?\s*(\d+)/i) : null;
    return titleMatch ? titleMatch[1] : '';
  }

  function isIssuePage() {
    const path = `${window.location.pathname}${window.location.hash}`;
    if (/(?:issues?|tickets?)\/\d+/i.test(path)) {
      return true;
    }

    const titleElement = document.querySelector('h1, h2, .issue-title, .b-issue-title, [data-role="issue-title"]');
    return Boolean(titleElement && /заявк[аи]\s*№?\s*\d+/i.test(titleElement.textContent));
  }

  function isInsideChrome(element) {
    return Boolean(element.closest('nav, aside, header, .sidebar, .b-sidebar, #sidebar, .left-menu, #left-menu, .side-menu, .main-menu, .navigation, .topbar, .b-topbar, .navbar, .b-navbar, .menu'));
  }

  function normalizeLabel(value) {
    return String(value || '')
      .replace(/\s+/g, ' ')
      .replace(/[^\p{L}\p{N}\s]/gu, '')
      .trim()
      .toLowerCase();
  }

  function normalizeWhitespace(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  // Подпись и значение ищем только в полях заявки.
  const excludedIssueContent = [
    `#${PANEL_ID}`, '[class*="comment" i]', '[data-role*="comment" i]',
    '[class*="description" i]', '[data-role*="description" i]', '[contenteditable="true"]',
    '.trix-content', '.redactor-styles', 'blockquote', '.preview-dialog'
  ].join(',');
  const fieldRowSelector = [
    'tr', '.field', '.form-group', '.b-field', '.issue-field', '.b-issue-field',
    '.attribute', '.b-attribute', '[class*="field-row"]', '[class*="field_row"]',
    '[class*="attribute-row"]', '[data-role="issue-field"]'
  ].join(',');
  const fieldLabelSelector = [
      'dt',
      'label',
      '.field-label',
      '.control-label',
      '.b-field-label',
      '.issue-field-label',
      '.b-issue-field-label',
      '.b-attribute-title',
      '.attribute-title',
      '.custom-parameter-name',
      'th',
      '[data-role$="-label"]',
      '[class*="field-label"]',
      '[class*="field__label"]',
      '[class*="field-title"]',
      '[class*="field__title"]',
      '[class*="label-text"]',
      '[class*="attribute-label"]',
      '[class*="attribute-title"]',
      '[class*="param-label"]',
      '[class*="param__label"]'
  ].join(',');

  function findFieldLabel(kind) {
    const aliases = LABEL_ALIASES[kind];
    const roots = [
      document.querySelector('main'),
      document.querySelector('.b-content'),
      document.querySelector('#content'),
      document.querySelector('.content')
    ].filter(Boolean);

    const seenRoots = new Set();
    for (const root of roots) {
      if (seenRoots.has(root)) {
        continue;
      }

      seenRoots.add(root);
      const found = findLabelInElements(root.querySelectorAll(fieldLabelSelector), aliases);
      if (found) {
        return found;
      }
    }

    const foundInDocument = findLabelInElements(document.querySelectorAll(fieldLabelSelector), aliases);
    if (foundInDocument) {
      return foundInDocument;
    }

    const rows = document.querySelectorAll(fieldRowSelector);
    for (const row of rows) {
      const label = findLabelInElements(row.querySelectorAll(':scope > span, :scope > div'), aliases);
      if (label) {
        return label;
      }
    }
    return null;
  }

  function findIssueField(kind) {
    if (kind === 'equipment') {
      const markers = document.querySelectorAll('[data-category="issue_card"][data-position="equipments"]');
      for (const marker of markers) {
        if (marker.closest(excludedIssueContent)) {
          continue;
        }

        // Каждое привязанное устройство может занимать отдельный блок рядом с заголовком.
        const header = marker.closest('span')?.parentElement;
        const labelElement = header?.children[0];
        if (labelElement && LABEL_ALIASES.equipment.includes(normalizeLabel(labelElement.textContent))) {
          return { labelElement, container: header.parentElement };
        }
      }
    }

    const labelElement = findFieldLabel(kind);
    return { labelElement, container: findFieldContainer(labelElement) };
  }

  function findLabelInElements(elements, aliases) {
    for (const element of elements) {
      if (isInsideChrome(element) || element.closest(excludedIssueContent) || element.closest('a, button')) {
        continue;
      }

      const text = normalizeLabel(element.textContent);
      if (!text || text.length > 40) {
        continue;
      }

      const label = text.replace(/\s*\d+$/, '').trim();
      if (aliases.includes(label)) {
        return element;
      }
    }

    return null;
  }

  function findFieldContainer(labelElement) {
    if (!labelElement) {
      return null;
    }

    if (labelElement.matches('dt, th')) {
      const value = labelElement.nextElementSibling;
      const valueTag = labelElement.matches('dt') ? 'dd' : 'td';
      return value && value.matches(valueTag) ? value : null;
    }

    const row = labelElement.closest(fieldRowSelector);
    if (row) {
      // Общая строка с несколькими полями не определяет принадлежность ссылок.
      const labels = row.querySelectorAll(fieldLabelSelector);
      if (Array.from(labels).some(function (other) {
        return other !== labelElement && !other.contains(labelElement) && !labelElement.contains(other);
      })) {
        return null;
      }
      return row;
    }

    const sibling = labelElement.nextElementSibling;
    return sibling && !sibling.closest(excludedIssueContent)
      && sibling.matches('dd, td, a[href], [data-role*="value"], [class*="value"], [data-equipment-id], [data-company-id], [data-object-id]')
      && !sibling.matches(fieldLabelSelector)
      && !sibling.querySelector(fieldLabelSelector)
      && !sibling.matches(fieldRowSelector) ? sibling : null;
  }

  function isActionLink(anchor) {
    const href = anchor.getAttribute('href') || '';
    if (!href || href === '#' || /^javascript:/i.test(href) || /^mailto:/i.test(href) || /^tel:/i.test(href)) {
      return true;
    }

    const className = typeof anchor.className === 'string' ? anchor.className.toLowerCase() : '';
    if (/(?:^|\s)(?:edit|delete|remove|add|create|close|action|button|btn)(?:\s|$)/.test(className)) {
      return true;
    }

    if (anchor.querySelector('svg') && !normalizeWhitespace(anchor.textContent)) {
      return true;
    }

    const text = normalizeWhitespace(anchor.textContent || anchor.getAttribute('title') || anchor.getAttribute('aria-label'));
    return !text;
  }

  function toAbsoluteUrl(href) {
    try {
      const url = new URL(href, window.location.href);
      if (url.origin !== window.location.origin) {
        return '';
      }

      if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        return '';
      }

      return url.toString();
    } catch {
      return '';
    }
  }

  function buildCandidateEntityUrl(kind, id) {
    if (!id || !/^\d+$/.test(String(id))) {
      return '';
    }

    const prefix = kind === 'equipment' ? '/equipments/'
      : (kind === 'client' ? '/companies/' : '/objects/');
    return `${window.location.origin}${prefix}${id}`;
  }

  function isEquipmentCardUrl(urlValue) {
    try {
      const url = new URL(urlValue, window.location.href);
      return /^\/(?:equipments?|devices?|inventory|inventories)\/\d+\/?$/i.test(url.pathname);
    } catch {
      return false;
    }
  }

  function collectEquipmentAnchorLinks(container) {
    if (!container) {
      return [];
    }

    const links = [];
    const seen = new Set();
    const anchors = container.matches('a[href]') ? [container] : container.querySelectorAll('a[href]');
    for (const anchor of anchors) {
      if (anchor.closest(excludedIssueContent)) {
        continue;
      }
      const url = toAbsoluteUrl(anchor.getAttribute('href'));
      if (!url || !isEquipmentCardUrl(url) || seen.has(url)) {
        continue;
      }

      const text = cleanEquipmentName(anchor.textContent);
      if (!text || text.length > 260 || /информац|справк|подробн|help|support/i.test(text)
        || /^(просмотр|открыть|перейти|view|open|info)$/i.test(text)) {
        continue;
      }

      seen.add(url);
      links.push({ url, text });
    }

    return links;
  }

  function collectLinks(container, kind) {
    if (kind !== 'equipment') {
      return collectLinksFromContainer(container, kind);
    }

    const anchors = collectEquipmentAnchorLinks(container);
    const rows = collectEquipmentRowLinks(container);
    const cards = new Map();
    for (const link of [...anchors, ...rows]) {
      const id = new URL(link.url).pathname.match(/\/(\d+)\/?$/)[1];
      if (!cards.has(id)) {
        cards.set(id, link);
      }
    }
    return Array.from(cards.values());
  }

  function cleanEquipmentName(value) {
    return normalizeWhitespace(value)
      .replace(/\s+(?:RustDesk|AnyDesk|Ассистент|Assistant|Ammyy(?:\s+Admin)?)\s+Используется\s+(?:Да|Нет)$/i, '')
      .replace(/\s+Используется\s+(?:Да|Нет)$/i, '')
      .trim();
  }

  function findEquipmentCardUrl(element) {
    const anchors = [];
    if (element.matches && element.matches('a[href]')) {
      anchors.push(element);
    }

    anchors.push(...element.querySelectorAll('a[href]'));
    for (const anchor of anchors) {
      if (anchor.closest(excludedIssueContent)) {
        continue;
      }
      const href = anchor.getAttribute('href') || '';
      if (!href || href === '#' || /^javascript:/i.test(href)) {
        continue;
      }

      if (isEquipmentCardUrl(href)) {
        const url = toAbsoluteUrl(href);
        if (url) {
          return url;
        }
      }

      if (anchor.getAttribute('data-role') === 'preview-dialog-show-btn') {
        const url = toAbsoluteUrl(href);
        const preview = url && new URL(url).pathname.match(/^\/equipments\/(\d+)\/previews\/?$/);
        if (preview) {
          return buildCandidateEntityUrl('equipment', preview[1]);
        }
      }
    }

    const dataElements = [element, ...element.querySelectorAll('[data-url], [data-href], [data-path], [data-equipment-id], [onclick]')];
    for (const dataElement of dataElements) {
      if (dataElement.closest(excludedIssueContent)) {
        continue;
      }
      const dataUrl = dataElement.getAttribute('data-url')
        || dataElement.getAttribute('data-href')
        || dataElement.getAttribute('data-path');
      if (dataUrl && isEquipmentCardUrl(dataUrl)) {
        const url = toAbsoluteUrl(dataUrl);
        if (url) {
          return url;
        }
      }

      const equipmentId = dataElement.getAttribute('data-equipment-id');
      // У кнопки предпросмотра этот атрибут может отличаться от ID карточки в href.
      if (equipmentId && dataElement.getAttribute('data-role') !== 'preview-dialog-show-btn') {
        const url = buildCandidateEntityUrl('equipment', equipmentId);
        if (url) {
          return url;
        }
      }

      const onclick = dataElement.getAttribute('onclick') || '';
      const onclickMatch = onclick.match(/(?:equipments?|equipment)[\/"'\\]+(\d+)/i);
      if (onclickMatch) {
        return buildCandidateEntityUrl('equipment', onclickMatch[1]);
      }
    }

    return '';
  }

  function collectEquipmentRowLinks(container) {
    if (!container) {
      return [];
    }

    const candidates = new Set([container]);
    for (const child of container.children) {
      candidates.add(child);
      for (const grandchild of child.children) {
        candidates.add(grandchild);
      }
    }

    for (const element of container.querySelectorAll('li, tr, [data-equipment-id], [class*="equipment"]')) {
      if (element !== container) {
        candidates.add(element);
      }
    }

    const candidateList = Array.from(candidates);
    const prepared = candidateList.map(function (candidate) {
      return {
        element: candidate,
        text: cleanEquipmentName(candidate.textContent),
        url: findEquipmentCardUrl(candidate)
      };
    }).filter(function (item) {
      if (!item.url || item.text.length < 2 || item.text.length > 260) {
        return false;
      }

      if (/информац|справк|подробн|help|support/i.test(item.text)) {
        return false;
      }

      if (/^(просмотр|открыть|перейти|подробнее|view|open|info)$/i.test(item.text)) {
        return false;
      }

      return !/^оборудование\b/i.test(item.text);
    });

    const links = [];
    const seen = new Set();
    for (const item of prepared) {
      if (prepared.some(function (other) {
        return other.element !== item.element && item.element.contains(other.element) && Boolean(other.url);
      })) {
        continue;
      }

      if (seen.has(item.url)) {
        continue;
      }

      seen.add(item.url);
      links.push({ url: item.url, text: item.text });
    }

    return links;
  }

  function collectLinksFromContainer(container, kind) {
    if (!container) {
      return [];
    }

    const anchors = container.matches('a[href]') ? [container] : container.querySelectorAll('a[href]');

    const links = [];
    const seen = new Set();
    for (const anchor of anchors) {
      if (anchor.closest(excludedIssueContent) || isActionLink(anchor)) {
        continue;
      }

      const url = toAbsoluteUrl(anchor.getAttribute('href'));
      if (!url || seen.has(url)) {
        continue;
      }

      const text = normalizeWhitespace(anchor.textContent || anchor.getAttribute('title') || anchor.getAttribute('aria-label'));
      if (!text) {
        continue;
      }

      if (kind === 'client' && !/compan|client|contragent/i.test(url)) {
        continue;
      }

      if (kind === 'object' && !/object|maintenance|entity|address/i.test(url)) {
        continue;
      }

      seen.add(url);
      links.push({ url, text });
    }

    // Некоторые интерфейсы не дают ссылку на карточку, но хранят её в data-url.
    const dataSelector = '[data-url], [data-href], [data-path], [data-company-id], [data-object-id]';
    const dataElements = container.matches(dataSelector) ? [container, ...container.querySelectorAll(dataSelector)]
      : container.querySelectorAll(dataSelector);

    for (const element of dataElements) {
      if (element.closest('button') || element.closest(excludedIssueContent) || isInsideChrome(element)) {
        continue;
      }

      const parentAnchor = element.closest('a');
      if (parentAnchor && parentAnchor !== element) {
        continue;
      }

      let url = element.getAttribute('data-url') || element.getAttribute('data-href') || element.getAttribute('data-path');
      if (!url) {
        const idAttribute = kind === 'client' ? 'data-company-id' : 'data-object-id';
        const id = element.getAttribute(idAttribute);
        url = buildCandidateEntityUrl(kind, id);
      }

      const absoluteUrl = url ? toAbsoluteUrl(url) : '';
      const text = normalizeWhitespace(element.textContent);
      const cardPath = absoluteUrl && new URL(absoluteUrl).pathname;
      const expectedPath = kind === 'client' ? /compan|client|contragent/i : /object|maintenance|entity|address/i;
      if (cardPath && expectedPath.test(cardPath) && text && !seen.has(absoluteUrl)) {
        seen.add(absoluteUrl);
        links.push({ url: absoluteUrl, text });
      }
    }

    return rankEntityLinks(links);
  }

  function rankEntityLinks(links) {
    const scored = links.map(function (link) {
      let score = 0;
      try {
        const url = new URL(link.url);
        if (/\/\d+(?:[/?#]|$)/.test(url.pathname)) {
          score += 10;
        }

        if (/search|filter|query|lookup/i.test(`${url.pathname}${url.search}`)) {
          score -= 25;
        }
      } catch {
        score -= 5;
      }

      if (link.text.length > 20) {
        score += 1;
      }

      return { ...link, score };
    });

    scored.sort(function (left, right) {
      return right.score - left.score;
    });

    return scored.slice(0, 1);
  }

  function extractIssueContext() {
    const fields = {};
    for (const kind of Object.keys(LABEL_ALIASES)) {
      const { labelElement, container } = findIssueField(kind);
      fields[kind] = { labelElement, container, links: collectLinks(container, kind) };
    }

    const clientName = fields.client.links.length ? fields.client.links[0].text : '';
    const objectName = fields.object.links.length ? fields.object.links[0].text : '';
    return {
      id: getIssueId(),
      fields,
      clientName,
      objectName
    };
  }

  // ---------------------------------------------------------------------------
  // Чтение карточек: параметры оборудования / объекта / клиента
  // ---------------------------------------------------------------------------
  function getIconUrl(fileName) {
    if (runtimeApi && typeof runtimeApi.getURL === 'function') {
      return runtimeApi.getURL(`icons/${fileName}`);
    }

    return '';
  }

  function parseAccessCredentials(value, requirePassword) {
    const normalizedValue = String(value || '').replace(/\s+/g, '');
    if (!normalizedValue || INVALID_PLACEHOLDER_VALUES.has(normalizedValue.toLowerCase())) {
      return null;
    }

    const separatorIndex = normalizedValue.search(/[\/\\]/);
    if (separatorIndex < 0) {
      return requirePassword
        ? null
        : {
          login: normalizedValue,
          password: ''
        };
    }

    const login = normalizedValue.slice(0, separatorIndex);
    const password = normalizedValue.slice(separatorIndex + 1);
    if (login.length === 0 || (requirePassword && password.length === 0)) {
      return null;
    }

    return { login, password };
  }

  function buildClearbatUrl(clearbatType, credentials) {
    const payloadParts = [
      `?type=${clearbatType}`,
      `?login=${credentials.login}`
    ];

    if (credentials.password) {
      payloadParts.push(`?password=${credentials.password}`);
    }

    return `clearbat:/${toBase64Utf8(payloadParts.join(''))}?encode=full`;
  }

  function buildIikoClearbatUrl(address, credentials) {
    const payloadParts = [
      '?type=iiko',
      `?url=${address}`
    ];

    if (credentials.login) {
      payloadParts.push(`?login=${credentials.login}`);
    }

    if (credentials.password) {
      payloadParts.push(`?password=${credentials.password}`);
    }

    return `clearbat:/${toBase64Utf8(payloadParts.join(''))}?encode=full`;
  }

  function parseServerAccess(value) {
    const normalizedValue = String(value || '').trim();
    if (!isMeaningfulAccessValue(normalizedValue) || /\s/.test(normalizedValue)) {
      return null;
    }

    const parsedValue = splitServerAccessValue(normalizedValue);
    if (parsedValue === null || !isMeaningfulAccessValue(parsedValue.address)) {
      return null;
    }

    const address = ensureServerPort(parsedValue.address);
    if (!address) {
      return null;
    }

    return {
      address,
      password: parsedValue.password
    };
  }

  function splitServerAccessValue(value) {
    const protocolMatch = value.match(/^https?:\/\//i);
    const searchStartIndex = protocolMatch !== null ? protocolMatch[0].length : 0;
    const separatorIndex = value.indexOf(ACCESS_VALUE_SEPARATOR, searchStartIndex);
    if (separatorIndex < 0) {
      return {
        address: value,
        password: ''
      };
    }

    const address = value.slice(0, separatorIndex);
    const password = value.slice(separatorIndex + ACCESS_VALUE_SEPARATOR.length);
    if (!address || !password) {
      return null;
    }

    return { address, password };
  }

  function ensureServerPort(address) {
    const normalizedAddress = String(address || '').trim();
    if (!isMeaningfulAccessValue(normalizedAddress) || /\s/.test(normalizedAddress)) {
      return '';
    }

    if (/^https?:\/\//i.test(normalizedAddress)) {
      try {
        const url = new URL(normalizedAddress);
        if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname) {
          return '';
        }

        if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
          return '';
        }

        if (url.port) {
          return url.toString().replace(/\/$/, '');
        }

        url.port = '443';
        return url.toString().replace(/\/$/, '');
      } catch {
        return '';
      }
    }

    if (normalizedAddress.includes('://') || normalizedAddress.includes('?') || normalizedAddress.includes('#')) {
      return '';
    }

    if (hasExplicitPort(normalizedAddress)) {
      return normalizedAddress;
    }

    return `${normalizedAddress}:443`;
  }

  function hasExplicitPort(address) {
    if (!address) {
      return false;
    }

    const lastColonIndex = address.lastIndexOf(':');
    if (lastColonIndex < 0 || lastColonIndex === address.length - 1) {
      return false;
    }

    return /^\d+$/.test(address.slice(lastColonIndex + 1));
  }

  function makeWebLinkClickable(item) {
    const valueElement = item.querySelector('[data-role="bip-value"]');
    if (!valueElement) {
      return;
    }

    const linkUrl = normalizeEquipmentWebLink(valueElement.textContent);
    const existingLink = valueElement.querySelector('a[data-okdesk-clearbat-web-link="true"]');
    if (!linkUrl) {
      if (existingLink) {
        existingLink.replaceWith(document.createTextNode(existingLink.textContent));
      }

      return;
    }

    if (existingLink) {
      if (existingLink.href !== linkUrl) {
        existingLink.href = linkUrl;
      }

      if (existingLink.textContent !== linkUrl) {
        existingLink.textContent = linkUrl;
      }

      return;
    }

    valueElement.textContent = '';

    const link = document.createElement('a');
    link.href = linkUrl;
    link.textContent = linkUrl;
    link.target = '_blank';
    link.rel = 'noopener';
    link.dataset.okdeskClearbatWebLink = 'true';
    link.addEventListener('click', function (event) {
      event.stopPropagation();
    });
    valueElement.appendChild(link);
  }

  function normalizeEquipmentWebLink(value) {
    const normalizedValue = String(value || '').trim();
    if (!isMeaningfulAccessValue(normalizedValue) || /[\u0400-\u04FF]/u.test(normalizedValue) || /\s/.test(normalizedValue)) {
      return '';
    }

    const urlValue = /^https?:\/\//i.test(normalizedValue)
      ? normalizedValue
      : `https://${normalizedValue}`;

    try {
      const url = new URL(urlValue);
      if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname || /[^\x00-\x7F]/.test(url.hostname)) {
        return '';
      }

      return url.toString();
    } catch {
      return '';
    }
  }

  function isMeaningfulAccessValue(value) {
    const normalizedValue = String(value || '').trim();
    if (!normalizedValue) {
      return false;
    }

    return !INVALID_PLACEHOLDER_VALUES.has(normalizedValue.replace(/\s+/g, '').toLowerCase());
  }

  function toBase64Utf8(value) {
    const bytes = new TextEncoder().encode(String(value || ''));
    let binary = '';

    for (const byte of bytes) {
      binary += String.fromCharCode(byte);
    }

    return window.btoa(binary);
  }

  function launchClearbatUrl(clearbatUrl, displayName) {
    if (!clearbatUrl) {
      return;
    }

    if (issueState.panel) {
      issueState.panel.dataset.lastLaunchAt = String(Date.now());
      showLaunchStatus(displayName);
    }

    window.location.assign(clearbatUrl);
  }

  function launchBrowserUrl(url, displayName) {
    if (!url) {
      return;
    }

    if (issueState.panel) {
      issueState.panel.dataset.lastLaunchAt = String(Date.now());
      showLaunchStatus(displayName, `Открываю ${displayName || 'iikoWeb'} в браузере`);
    }

    const link = document.createElement('a');
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    window.setTimeout(function () {
      link.remove();
    }, 1000);
  }

  function showLaunchStatus(displayName, message) {
    const panel = issueState.panel;
    if (!panel) {
      return;
    }

    let status = panel.querySelector('.okdesk-tl-launch-status');
    if (!status) {
      status = document.createElement('div');
      status.className = 'okdesk-tl-launch-status';
      const header = panel.querySelector('.okdesk-tl-header');
      if (header && header.nextSibling) {
        panel.insertBefore(status, header.nextSibling);
      } else {
        panel.appendChild(status);
      }
    }

    status.textContent = message || `Запуск ${displayName || 'приложения'} передан в CLEAR.bat`;
    window.clearTimeout(showLaunchStatus.timer);
    showLaunchStatus.timer = window.setTimeout(function () {
      status.remove();
    }, 2500);
  }

  // ---------------------------------------------------------------------------
  // Разбор ответа карточки (HTML или JSON)
  // ---------------------------------------------------------------------------
  function extractParameterCodeFromRole(role) {
    const match = String(role || '').match(/parameter-(.+)$/i);
    if (!match) {
      return '';
    }

    return match[1].replace(/-\d+$/, '');
  }

  function readElementValue(element) {
    if (!element) {
      return '';
    }

    const valueElement = element.querySelector('[data-role="bip-value"], .bip-value, dd, .value');
    if (valueElement) {
      return normalizeWhitespace(valueElement.textContent);
    }

    return normalizeWhitespace(element.textContent);
  }

  function parseParameterDocument(doc) {
    const params = new Map();
    const labels = new Map();

    for (const element of doc.querySelectorAll('[data-role]')) {
      const role = element.getAttribute('data-role') || '';
      if (!/parameter/i.test(role)) {
        continue;
      }

      const code = extractParameterCodeFromRole(role);
      if (!code) {
        continue;
      }

      const value = readElementValue(element);
      if (isMeaningfulAccessValue(value)) {
        params.set(code.toLowerCase(), value);
      }
    }

    for (const element of doc.querySelectorAll('[data-parameter-code], [data-code]')) {
      const code = element.getAttribute('data-parameter-code') || element.getAttribute('data-code');
      if (!code) {
        continue;
      }

      const value = readElementValue(element) || normalizeWhitespace(element.getAttribute('data-value'));
      if (isMeaningfulAccessValue(value)) {
        params.set(code.toLowerCase(), value);
      }
    }

    const labelElements = doc.querySelectorAll('dt, .b-attribute-title, .attribute-title, .custom-parameter-name, .field-label');
    for (const labelElement of labelElements) {
      const label = normalizeLabel(labelElement.textContent);
      if (!label) {
        continue;
      }

      let valueElement = labelElement.nextElementSibling;
      if (!valueElement && labelElement.parentElement) {
        valueElement = labelElement.parentElement.querySelector('dd, .b-attribute-value, .value, .field-value');
      }

      if (!valueElement) {
        continue;
      }

      const value = normalizeWhitespace(valueElement.textContent);
      if (isMeaningfulAccessValue(value) && value.length <= 500) {
        labels.set(label, value);
      }
    }

    for (const script of doc.querySelectorAll('script:not([src])')) {
      const text = script.textContent ? script.textContent.trim() : '';
      if (text.length < 20 || text.length > 2000000 || !/parameter|anydesk|rustdesk|iiko/i.test(text)) {
        continue;
      }

      try {
        const data = JSON.parse(text);
        collectJsonParameters(data, params, 0);
      } catch {
        // Это не JSON, пропускаем.
      }
    }

    return { params, labels };
  }

  function collectJsonParameters(value, params, depth) {
    if (depth > 8 || value === null || value === undefined) {
      return;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        collectJsonParameters(item, params, depth + 1);
      }

      return;
    }

    if (typeof value !== 'object') {
      return;
    }

    const code = value.code || value.parameter_code || value.attribute_code || value.attr_code;
    const parameterValue = value.value !== undefined
      ? value.value
      : (value.parameter_value !== undefined ? value.parameter_value : value.attribute_value);

    if (typeof code === 'string' && parameterValue !== undefined && parameterValue !== null) {
      const normalizedValue = normalizeWhitespace(parameterValue);
      if (isMeaningfulAccessValue(normalizedValue) && normalizedValue.length <= 500) {
        params.set(code.toLowerCase(), normalizedValue);
      }
    }

    for (const nested of Object.values(value)) {
      if (nested && typeof nested === 'object') {
        collectJsonParameters(nested, params, depth + 1);
      }
    }
  }

  function pickParameter(params, labels, codes, labelHints) {
    for (const code of codes) {
      const normalizedCode = String(code).toLowerCase();
      const value = params.get(normalizedCode);
      if (isMeaningfulAccessValue(value)) {
        return String(value).trim();
      }

      if (normalizedCode.length >= 4) {
        for (const [key, candidate] of params.entries()) {
          if ((key.startsWith(`${normalizedCode}_`) || key.startsWith(`${normalizedCode}-`)
            || key.endsWith(`_${normalizedCode}`) || key.endsWith(`-${normalizedCode}`))
            && isMeaningfulAccessValue(candidate)) {
            return String(candidate).trim();
          }
        }
      }
    }

    for (const [label, value] of labels.entries()) {
      for (const hint of labelHints) {
        const normalizedHint = normalizeLabel(hint);
        if (!normalizedHint) {
          continue;
        }

        if (label === normalizedHint || label.startsWith(`${normalizedHint} `) || label.includes(normalizedHint)) {
          return value;
        }
      }
    }

    return '';
  }

  function extractIikoCredentials(params, labels) {
    const combined = pickParameter(
      params,
      labels,
      ['0008'],
      ['iiko логин пароль', 'iiko login password', 'логин пароль iiko', 'iiko учетные данные']
    );

    const separateLogin = pickParameter(
      params,
      labels,
      ['iiko_login', 'login_iiko', 'iiko_user'],
      ['iiko логин', 'логин iiko', 'iiko login', 'пользователь iiko']
    );
    const separatePassword = pickParameter(
      params,
      labels,
      ['iiko_password', 'password_iiko', 'iiko_pass'],
      ['iiko пароль', 'пароль iiko', 'iiko password']
    );

    if (combined) {
      const parsed = parseAccessCredentials(combined, false);
      if (parsed) {
        return {
          login: parsed.login || separateLogin,
          password: parsed.password || separatePassword || ''
        };
      }
    }

    if (separateLogin) {
      return { login: separateLogin, password: separatePassword || '' };
    }

    return { login: '', password: '' };
  }

  function normalizeIikoWebUrl(value) {
    let rawValue = String(value || '').trim();
    if (!isMeaningfulAccessValue(rawValue)) {
      return '';
    }

    const hrefMatch = rawValue.match(/https?:\/\/[^\s"'<>]+/i);
    if (hrefMatch) {
      rawValue = hrefMatch[0];
    } else {
      rawValue = rawValue.split(/[\s,;]+/)[0];
    }

    if (/^\/\//.test(rawValue)) {
      rawValue = `https:${rawValue}`;
    } else if (!/^https?:\/\//i.test(rawValue)) {
      rawValue = `https://${rawValue}`;
    }

    try {
      const url = new URL(rawValue);
      if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname) {
        return '';
      }

      return url.toString();
    } catch {
      return '';
    }
  }

  function buildAccessFromParameters(params, labels) {
    const iikoOfficeServerRaw = pickParameter(
      params,
      labels,
      ['srv_addr', 'iikooffice', 'iiko_office', 'server_addr'],
      ['адрес сервера', 'сервер iiko', 'iiko office', 'iikooffice']
    );
    const iikoChainServerRaw = pickParameter(
      params,
      labels,
      ['0017', 'iikochain', 'iiko_chain', 'chain_addr'],
      ['iiko chain', 'iikochain', 'чейн', 'chain']
    );
    const iikoWebRaw = pickParameter(
      params,
      labels,
      ['iiko_web', 'iikoweb', 'iiko_web_link', 'iiko_web_url', 'link_iiko_web', 'web_iiko', 'iiko_web_address'],
      ['ссылка на iiko web', 'iiko web', 'iiko web ссылка', 'ссылка iiko web', 'iiko web link', 'ссылка на iikoweb', 'iikoweb']
    );

    const anydeskRaw = pickParameter(params, labels, ['anydesk', 'any_desk'], ['anydesk', 'any desk']);
    const assistantRaw = pickParameter(params, labels, ['ac', 'assistant'], ['ассистент', 'assistant']);
    const rustdeskRaw = pickParameter(params, labels, ['rust', 'rustdesk', 'rust_desk'], ['rustdesk', 'rust desk', 'растдеск']);

    return {
      iikoOfficeServer: parseServerAccess(iikoOfficeServerRaw),
      iikoChainServer: parseServerAccess(iikoChainServerRaw),
      iikoWebRaw,
      credentials: extractIikoCredentials(params, labels),
      anydeskRaw,
      assistantRaw,
      rustdeskRaw
    };
  }

  function makeAccessUrls(rawAccess, fallback, sharedCredentials) {
    const credentials = rawAccess.credentials.login ? rawAccess.credentials : (fallback.credentials || { login: '', password: '' });
    const effectiveCredentials = credentials.login ? credentials : (sharedCredentials || { login: '', password: '' });
    const officeServer = rawAccess.iikoOfficeServer || fallback.iikoOfficeServer || null;
    const chainServer = rawAccess.iikoChainServer || fallback.iikoChainServer || null;

    function buildIiko(server) {
      if (!server || !effectiveCredentials.login) {
        return '';
      }

      return buildIikoClearbatUrl(server.address, {
        login: effectiveCredentials.login,
        password: server.password || effectiveCredentials.password
      });
    }

    function buildRemote(rawValue, type, requirePassword) {
      const parsed = parseAccessCredentials(rawValue, requirePassword);
      return parsed ? buildClearbatUrl(type, parsed) : '';
    }

    return {
      iikoOffice: buildIiko(officeServer),
      iikoChain: buildIiko(chainServer),
      iikoWeb: normalizeIikoWebUrl(rawAccess.iikoWebRaw),
      assistant: buildRemote(rawAccess.assistantRaw, 'assistant', false),
      rustdesk: buildRemote(rawAccess.rustdeskRaw, 'rustdesk', false),
      anydesk: buildRemote(rawAccess.anydeskRaw, 'anydesk', true)
    };
  }

  async function fetchTextWithTimeout(url) {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(function () {
      controller.abort();
    }, FETCH_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        method: 'GET',
        credentials: 'same-origin',
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          'Accept': 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8'
        }
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const contentType = response.headers.get('content-type') || '';
      const text = await response.text();
      return { text, contentType };
    } finally {
      window.clearTimeout(timeoutId);
    }
  }

  function parseEntityPayload(payload, kind, name, url) {
    const params = new Map();
    const labels = new Map();

    if (/application\/json/i.test(payload.contentType)) {
      try {
        collectJsonParameters(JSON.parse(payload.text), params, 0);
      } catch {
        // Некорректный JSON — ниже попробуем HTML.
      }
    }

    if (!params.size || !/application\/json/i.test(payload.contentType)) {
      const doc = new DOMParser().parseFromString(payload.text, 'text/html');
      const parsed = parseParameterDocument(doc);
      for (const [code, value] of parsed.params.entries()) {
        if (!params.has(code)) {
          params.set(code, value);
        }
      }

      for (const [label, value] of parsed.labels.entries()) {
        if (!labels.has(label)) {
          labels.set(label, value);
        }
      }
    }

    return {
      kind,
      name,
      url,
      params,
      labels,
      rawAccess: buildAccessFromParameters(params, labels),
      error: ''
    };
  }

  function buildEntityUrlCandidates(link, kind) {
    const candidates = [link.url];
    try {
      const url = new URL(link.url);
      const idMatch = url.pathname.match(/\/(\d+)(?:\/|$)/);
      if (idMatch) {
        const id = idMatch[1];
        const routes = kind === 'equipment'
          ? [`/equipments/${id}`, `/equipment/${id}`]
          : (kind === 'client'
            ? [`/companies/${id}`, `/clients/${id}`]
            : [`/objects/${id}`, `/maintenance_entities/${id}`, `/maintenance-entities/${id}`]);
        for (const route of routes) {
          candidates.push(`${url.origin}${route}`);
        }
      }
    } catch {
      // Некорректный URL — используем только исходный.
    }

    return Array.from(new Set(candidates));
  }

  async function fetchEntity(link, kind) {
    // Незавершённое чтение пишет только в кэш той заявки, где оно началось.
    const cache = entityCache;
    const cacheKey = `${kind}:${link.url}`;
    if (cache.has(cacheKey)) {
      return cache.get(cacheKey);
    }

    const candidates = buildEntityUrlCandidates(link, kind);
    let bestSource = null;
    let lastError = '';

    for (const url of candidates) {
      try {
        const payload = await fetchTextWithTimeout(url);
        const source = parseEntityPayload(payload, kind, link.text, url);
        if (hasRawAccess(source.rawAccess) || source.params.size) {
          if (hasRawAccess(source.rawAccess)) {
            cache.set(cacheKey, source);
          }
          return source;
        }

        if (!bestSource || source.labels.size > bestSource.labels.size) {
          bestSource = source;
        }
      } catch (error) {
        lastError = error && error.name === 'AbortError'
          ? 'Превышено время ожидания'
          : String(error && error.message ? error.message : error);
      }
    }

    if (bestSource) {
      return bestSource;
    }

    const source = {
      kind,
      name: link.text,
      url: link.url,
      params: new Map(),
      labels: new Map(),
      rawAccess: buildAccessFromParameters(new Map(), new Map()),
      error: lastError || 'Не удалось прочитать карточку'
    };
    return source;
  }

  async function loadIssueSources(context, local, localRawAccess) {
    const sources = [];
    const requests = [];

    if (context.fields.client.links.length) {
      requests.push(fetchEntity(context.fields.client.links[0], 'client').then(function (source) {
        source.order = 20;
        sources.push(source);
      }));
    }

    if (context.fields.object.links.length) {
      requests.push(fetchEntity(context.fields.object.links[0], 'object').then(function (source) {
        source.order = 10;
        sources.push(source);
      }));
    }

    const equipmentLinks = context.fields.equipment.links.slice(0, MAX_EQUIPMENT_TO_FETCH);
    equipmentLinks.forEach(function (link, index) {
      requests.push(fetchEntity(link, 'equipment').then(function (source) {
        source.order = index;
        sources.push(source);
      }));
    });

    if (local.params.size || hasRawAccess(localRawAccess)) {
      sources.push({
        kind: 'issue',
        name: 'Текущая заявка',
        url: window.location.href,
        params: local.params,
        labels: local.labels,
        rawAccess: localRawAccess,
        order: 30,
        error: ''
      });
    }

    await Promise.all(requests);
    return sources;
  }

  function hasRawAccess(rawAccess) {
    if (!rawAccess) {
      return false;
    }

    return Boolean(
      rawAccess.iikoOfficeServer
      || rawAccess.iikoChainServer
      || rawAccess.iikoWebRaw
      || rawAccess.credentials.login
      || rawAccess.anydeskRaw
      || rawAccess.assistantRaw
      || rawAccess.rustdeskRaw
    );
  }

  function orderSources(sources) {
    return sources.slice().sort(function (left, right) {
      const leftOrder = typeof left.order === 'number' ? left.order : 90;
      const rightOrder = typeof right.order === 'number' ? right.order : 90;
      if (leftOrder !== rightOrder) {
        return leftOrder - rightOrder;
      }

      return String(left.name || '').localeCompare(String(right.name || ''), 'ru');
    });
  }

  function finalizeSources(sources) {
    const ordered = orderSources(sources);
    const objectSource = ordered.find(function (source) { return source.kind === 'object'; });
    const clientSource = ordered.find(function (source) { return source.kind === 'client'; });

    const sharedCredentials = (function () {
      for (const source of ordered) {
        if (source.rawAccess.credentials.login) {
          return source.rawAccess.credentials;
        }
      }

      return { login: '', password: '' };
    }());

    for (const source of ordered) {
      let fallback = {};
      if (source.kind === 'equipment') {
        fallback = {
          iikoOfficeServer: null,
          iikoChainServer: null,
          credentials: (objectSource && objectSource.rawAccess.credentials.login)
            ? objectSource.rawAccess.credentials
            : (clientSource ? clientSource.rawAccess.credentials : { login: '', password: '' })
        };
      } else if (source.kind === 'object') {
        fallback = {
          iikoOfficeServer: null,
          iikoChainServer: null,
          credentials: clientSource ? clientSource.rawAccess.credentials : { login: '', password: '' }
        };
      } else if (source.kind === 'client') {
        fallback = {
          iikoOfficeServer: null,
          iikoChainServer: null,
          credentials: { login: '', password: '' }
        };
      } else {
        fallback = {
          iikoOfficeServer: null,
          iikoChainServer: null,
          credentials: sharedCredentials
        };
      }

      source.access = makeAccessUrls(source.rawAccess, fallback, sharedCredentials);
    }

    return ordered;
  }

  // ---------------------------------------------------------------------------
  // Панель быстрого запуска
  // ---------------------------------------------------------------------------
  function createPanel(context) {
    const panel = document.createElement('section');
    panel.id = PANEL_ID;
    panel.className = 'okdesk-tl-panel';
    panel.setAttribute('data-okdesk-ticket-launcher', 'true');

    const header = document.createElement('div');
    header.className = 'okdesk-tl-header';

    const titleWrap = document.createElement('div');
    titleWrap.className = 'okdesk-tl-title-wrap';

    const title = document.createElement('span');
    title.className = 'okdesk-tl-title';
    title.textContent = 'Быстрый запуск';

    const contextElement = document.createElement('span');
    contextElement.className = 'okdesk-tl-context';

    const actions = document.createElement('div');
    actions.className = 'okdesk-tl-actions';

    const compactButton = document.createElement('button');
    compactButton.type = 'button';
    compactButton.className = 'okdesk-tl-action okdesk-tl-compact-toggle';
    compactButton.textContent = '▤';
    compactButton.title = 'Компактный вид';
    compactButton.setAttribute('aria-label', 'Компактный вид');
    compactButton.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      toggleCompactMode(panel);
    });

    const settingsButton = document.createElement('button');
    settingsButton.type = 'button';
    settingsButton.className = 'okdesk-tl-action okdesk-tl-settings-toggle';
    settingsButton.textContent = '⚙';
    settingsButton.title = 'Настройки отображения';
    settingsButton.setAttribute('aria-label', 'Настройки отображения');
    settingsButton.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      toggleSettings(panel);
    });

    const diagnosticsButton = document.createElement('button');
    diagnosticsButton.type = 'button';
    diagnosticsButton.className = 'okdesk-tl-action';
    diagnosticsButton.title = 'Диагностика: какие поля и карточки найдены';
    diagnosticsButton.setAttribute('aria-label', 'Диагностика');
    diagnosticsButton.textContent = '?';
    diagnosticsButton.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      toggleDiagnostics(panel);
    });

    const refreshButton = document.createElement('button');
    refreshButton.type = 'button';
    refreshButton.className = 'okdesk-tl-action';
    refreshButton.title = 'Обновить данные из карточек';
    refreshButton.setAttribute('aria-label', 'Обновить данные из карточек');
    refreshButton.textContent = '⟳';
    refreshButton.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      issueState.emptyRetries = 0;
      refreshIssuePanel(true);
    });

    const collapseButton = document.createElement('button');
    collapseButton.type = 'button';
    collapseButton.className = 'okdesk-tl-action okdesk-tl-collapse';
    collapseButton.title = 'Свернуть панель';
    collapseButton.setAttribute('aria-label', 'Свернуть панель');
    collapseButton.textContent = '−';
    collapseButton.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      togglePanelCollapsed(panel);
    });

    actions.appendChild(settingsButton);
    actions.appendChild(compactButton);
    actions.appendChild(diagnosticsButton);
    actions.appendChild(refreshButton);
    actions.appendChild(collapseButton);
    titleWrap.appendChild(title);
    titleWrap.appendChild(contextElement);
    header.appendChild(titleWrap);
    header.appendChild(actions);

    const settings = document.createElement('div');
    settings.className = 'okdesk-tl-settings';
    settings.hidden = true;

    const settingsLabel = document.createElement('label');
    settingsLabel.className = 'okdesk-tl-settings-label';
    settingsLabel.textContent = 'Иконки:';

    const iconLayoutSelect = document.createElement('select');
    iconLayoutSelect.className = 'okdesk-tl-icon-layout';
    for (const optionDefinition of [
      { value: 'auto', label: 'Авто (по названию)' },
      { value: 'right', label: 'Всегда справа' },
      { value: 'bottom', label: 'Всегда снизу' }
    ]) {
      const option = document.createElement('option');
      option.value = optionDefinition.value;
      option.textContent = optionDefinition.label;
      iconLayoutSelect.appendChild(option);
    }

    iconLayoutSelect.addEventListener('change', function (event) {
      event.stopPropagation();
      const layout = normalizeIconLayout(iconLayoutSelect.value);
      writeIconLayout(layout);
      applyIconLayout(panel, layout);
      clampPanelToViewport(panel);
    });

    settingsLabel.appendChild(iconLayoutSelect);
    settings.appendChild(settingsLabel);

    const body = document.createElement('div');
    body.className = 'okdesk-tl-body';

    panel.appendChild(header);
    panel.appendChild(settings);
    panel.appendChild(body);
    panel.addEventListener('click', function (event) {
      event.stopPropagation();
    });

    if (readCollapsedState()) {
      panel.classList.add('okdesk-tl-collapsed');
      collapseButton.textContent = '+';
      collapseButton.title = 'Развернуть панель';
    }

    applyCompactState(panel, readCompactState());
    applyIconLayout(panel, readIconLayout());

    return { panel, body, contextElement, collapseButton };
  }

  function readCompactState() {
    try {
      const saved = window.localStorage.getItem(PANEL_COMPACT_KEY);
      return saved === null ? true : saved === '1';
    } catch {
      return true;
    }
  }

  function writeCompactState(compact) {
    try {
      window.localStorage.setItem(PANEL_COMPACT_KEY, compact ? '1' : '0');
    } catch {
      // localStorage может быть недоступен.
    }
  }

  function applyCompactState(panel, compact) {
    panel.classList.toggle('okdesk-tl-compact', compact);
    const button = panel.querySelector('.okdesk-tl-compact-toggle');
    if (button) {
      button.textContent = compact ? '▥' : '▤';
      button.title = compact ? 'Обычный вид' : 'Компактный вид';
      button.setAttribute('aria-label', button.title);
    }
  }

  function toggleCompactMode(panel) {
    const compact = !panel.classList.contains('okdesk-tl-compact');
    applyCompactState(panel, compact);
    writeCompactState(compact);
    clampPanelToViewport(panel);
  }

  function normalizeIconLayout(value) {
    return value === 'right' || value === 'bottom' ? value : 'auto';
  }

  function readIconLayout() {
    try {
      return normalizeIconLayout(window.localStorage.getItem(PANEL_ICON_LAYOUT_KEY));
    } catch {
      return 'auto';
    }
  }

  function writeIconLayout(layout) {
    try {
      window.localStorage.setItem(PANEL_ICON_LAYOUT_KEY, normalizeIconLayout(layout));
    } catch {
      // localStorage может быть недоступен.
    }
  }

  function applyIconLayout(panel, layout) {
    const normalizedLayout = normalizeIconLayout(layout);
    panel.classList.remove('okdesk-tl-icons-auto', 'okdesk-tl-icons-right', 'okdesk-tl-icons-bottom');
    panel.classList.add(`okdesk-tl-icons-${normalizedLayout}`);
    const select = panel.querySelector('.okdesk-tl-icon-layout');
    if (select) {
      select.value = normalizedLayout;
    }
  }

  function toggleSettings(panel) {
    const settings = panel.querySelector('.okdesk-tl-settings');
    if (!settings) {
      return;
    }

    settings.hidden = !settings.hidden;
    if (!settings.hidden) {
      const select = settings.querySelector('.okdesk-tl-icon-layout');
      if (select) {
        select.focus();
      }
    }
  }

  function clampPanelToViewport(panel) {
    if (!panel.isConnected) {
      return;
    }

    const rect = panel.getBoundingClientRect();
    if (rect.right > window.innerWidth - 4) {
      panel.style.left = `${Math.max(4, window.innerWidth - rect.width - 4)}px`;
      panel.style.right = 'auto';
    }

    if (rect.bottom > window.innerHeight - 4) {
      panel.style.top = `${Math.max(4, window.innerHeight - Math.min(rect.height, 120) - 4)}px`;
    }
  }

  function readCollapsedState() {
    try {
      return window.localStorage.getItem(PANEL_COLLAPSED_KEY) === '1';
    } catch {
      return false;
    }
  }

  function writeCollapsedState(collapsed) {
    try {
      window.localStorage.setItem(PANEL_COLLAPSED_KEY, collapsed ? '1' : '0');
    } catch {
      // localStorage может быть недоступен.
    }
  }

  function togglePanelCollapsed(panel) {
    const collapsed = panel.classList.toggle('okdesk-tl-collapsed');
    writeCollapsedState(collapsed);
    const button = panel.querySelector('.okdesk-tl-collapse');
    if (button) {
      button.textContent = collapsed ? '+' : '−';
      button.title = collapsed ? 'Развернуть панель' : 'Свернуть панель';
    }
  }

  function buildDiagnosticsReport() {
    const fields = {};
    const context = issueState.context;
    if (context) {
      for (const [kind, field] of Object.entries(context.fields)) {
        fields[kind] = {
          labelTag: field.labelElement ? field.labelElement.localName : null,
          valueTag: field.container ? field.container.localName : null,
          cardCount: field.links.length
        };
      }
    }

    const sources = issueState.sources.map(function (source) {
      let errorCode = null;
      if (source.error) {
        const http = /^HTTP (\d{3})$/.exec(source.error);
        errorCode = http ? `http_${http[1]}` : (source.error === 'Превышено время ожидания' ? 'timeout' : 'read_failed');
      }
      return { kind: source.kind, errorCode };
    });
    return JSON.stringify({ fields, sources }, null, 2);
  }

  function toggleDiagnostics(panel) {
    const existing = panel.querySelector('.okdesk-tl-diagnostics');
    if (existing) {
      existing.remove();
      return;
    }

    const wrapper = document.createElement('div');
    wrapper.className = 'okdesk-tl-diagnostics';

    const actions = document.createElement('div');
    actions.className = 'okdesk-tl-diagnostics-actions';

    const copyButton = document.createElement('button');
    copyButton.type = 'button';
    copyButton.className = 'okdesk-tl-diagnostics-button';
    copyButton.textContent = 'Копировать';
    copyButton.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      const report = buildDiagnosticsReport();
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(report).then(function () {
          copyButton.textContent = 'Скопировано';
          window.setTimeout(function () { copyButton.textContent = 'Копировать'; }, 1500);
        }).catch(function () {
          copyButton.textContent = 'Выделите текст';
        });
      }
    });

    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.className = 'okdesk-tl-diagnostics-button';
    closeButton.textContent = 'Закрыть';
    closeButton.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      wrapper.remove();
    });

    actions.appendChild(copyButton);
    actions.appendChild(closeButton);

    const pre = document.createElement('pre');
    pre.textContent = buildDiagnosticsReport();

    wrapper.appendChild(actions);
    wrapper.appendChild(pre);
    panel.appendChild(wrapper);
  }

  function mountPanel(panel, context) {
    if (!panel.isConnected) {
      panel.classList.add('okdesk-tl-floating');
      document.body.appendChild(panel);
      applySavedPanelPosition(panel);
      makePanelDraggable(panel);
    }

    const contextElement = panel.querySelector('.okdesk-tl-context');
    if (contextElement) {
      const parts = [];
      if (context.clientName) {
        parts.push(`Клиент: ${context.clientName}`);
      }

      if (context.objectName) {
        parts.push(`Объект: ${context.objectName}`);
      }

      const title = parts.join(' · ');
      if (contextElement.textContent !== title) {
        contextElement.textContent = title;
      }
      contextElement.title = parts.join('\n');
    }
  }

  function getPanelPositionKey() {
    return `okdesk-ticket-launcher-position:${window.location.hostname}`;
  }

  function applySavedPanelPosition(panel) {
    let position = null;
    try {
      position = JSON.parse(window.localStorage.getItem(getPanelPositionKey()) || 'null');
    } catch {
      position = null;
    }

    if (!position || typeof position.left !== 'number' || typeof position.top !== 'number') {
      return;
    }

    const maxLeft = Math.max(8, window.innerWidth - 120);
    const maxTop = Math.max(8, window.innerHeight - 80);
    panel.style.left = `${Math.min(Math.max(8, position.left), maxLeft)}px`;
    panel.style.top = `${Math.min(Math.max(8, position.top), maxTop)}px`;
    panel.style.right = 'auto';
  }

  function savePanelPosition(panel) {
    const rect = panel.getBoundingClientRect();
    try {
      window.localStorage.setItem(getPanelPositionKey(), JSON.stringify({
        left: Math.round(rect.left),
        top: Math.round(rect.top)
      }));
    } catch {
      // localStorage может быть недоступен.
    }
  }

  function makePanelDraggable(panel) {
    if (panel.dataset.okdeskTlDraggable === 'true') {
      return;
    }

    panel.dataset.okdeskTlDraggable = 'true';
    const header = panel.querySelector('.okdesk-tl-header');
    if (!header) {
      return;
    }

    header.addEventListener('dblclick', function (event) {
      if (event.target.closest('button')) {
        return;
      }

      panel.style.left = 'auto';
      panel.style.top = '96px';
      panel.style.right = '20px';
      try {
        window.localStorage.removeItem(getPanelPositionKey());
      } catch {
        // localStorage может быть недоступен.
      }
    });

    let dragState = null;
    header.addEventListener('pointerdown', function (event) {
      if (event.button !== 0 || event.target.closest('button')) {
        return;
      }

      const rect = panel.getBoundingClientRect();
      dragState = {
        pointerId: event.pointerId,
        offsetX: event.clientX - rect.left,
        offsetY: event.clientY - rect.top
      };
      header.setPointerCapture(event.pointerId);
      panel.classList.add('okdesk-tl-dragging');
      event.preventDefault();
    });

    header.addEventListener('pointermove', function (event) {
      if (!dragState || event.pointerId !== dragState.pointerId) {
        return;
      }

      const width = panel.offsetWidth;
      const height = panel.offsetHeight;
      const left = Math.min(Math.max(4, event.clientX - dragState.offsetX), Math.max(4, window.innerWidth - width - 4));
      const top = Math.min(Math.max(4, event.clientY - dragState.offsetY), Math.max(4, window.innerHeight - Math.min(height, 80) - 4));
      panel.style.left = `${left}px`;
      panel.style.top = `${top}px`;
      panel.style.right = 'auto';
    });

    function endDrag(event) {
      if (!dragState || (event.pointerId !== undefined && event.pointerId !== dragState.pointerId)) {
        return;
      }

      dragState = null;
      panel.classList.remove('okdesk-tl-dragging');
      savePanelPosition(panel);
    }

    header.addEventListener('pointerup', endDrag);
    header.addEventListener('pointercancel', endDrag);
  }

  function renderLoading() {
    if (!issueState.body) {
      return;
    }

    issueState.body.textContent = '';
    const loading = document.createElement('div');
    loading.className = 'okdesk-tl-loading';
    loading.textContent = 'Читаю карточки клиента, объекта и оборудования…';
    issueState.body.appendChild(loading);
  }

  function renderError(message) {
    if (!issueState.body) {
      return;
    }

    issueState.body.textContent = '';
    const error = document.createElement('div');
    error.className = 'okdesk-tl-message okdesk-tl-error';
    error.textContent = message;
    issueState.body.appendChild(error);

    const links = collectFallbackLinks();
    if (links.length) {
      const list = document.createElement('div');
      list.className = 'okdesk-tl-links';
      for (const link of links) {
        const anchor = document.createElement('a');
        anchor.href = link.url;
        anchor.textContent = link.text;
        anchor.target = '_blank';
        anchor.rel = 'noopener';
        list.appendChild(anchor);
      }

      issueState.body.appendChild(list);
    }
  }

  function collectFallbackLinks() {
    const context = issueState.context;
    if (!context) {
      return [];
    }

    const links = [];
    for (const kind of ['equipment', 'object', 'client']) {
      for (const link of context.fields[kind].links) {
        links.push({ url: link.url, text: `${kind === 'equipment' ? 'Оборудование' : (kind === 'object' ? 'Объект' : 'Клиент')}: ${link.text}` });
      }
    }

    return links.slice(0, 10);
  }

  function createToolButton(tool, source) {
    const url = tool.getUrl(source.access || {});
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `okdesk-tl-tool${url ? '' : ' okdesk-tl-tool-disabled'}`;
    button.dataset.tool = tool.id;
    button.disabled = !url;
    button.title = url
      ? (tool.launch === 'browser' ? `Открыть ${tool.displayName}` : `Запустить ${tool.displayName}`)
      : `${tool.displayName}: нет данных в карточке ${getSourceKindName(source.kind)}`;
    button.setAttribute('aria-label', button.title);

    const icon = document.createElement('img');
    icon.src = getIconUrl(tool.iconFile);
    icon.alt = tool.displayName;
    icon.className = 'okdesk-tl-tool-icon';
    button.appendChild(icon);

    if (url) {
      button.addEventListener('click', function (event) {
        event.preventDefault();
        event.stopPropagation();
        if (tool.launch === 'browser') {
          launchBrowserUrl(url, tool.displayName);
        } else {
          launchClearbatUrl(url, tool.displayName);
        }
      });
    }

    return button;
  }

  function getSourceKindName(kind) {
    if (kind === 'equipment') {
      return 'оборудования';
    }

    if (kind === 'object') {
      return 'объекта';
    }

    if (kind === 'client') {
      return 'клиента';
    }

    return 'заявки';
  }

  function hasAnyAccess(source) {
    return Boolean(source.access && (source.access.iikoOffice || source.access.iikoChain || source.access.iikoWeb
      || source.access.assistant || source.access.rustdesk || source.access.anydesk));
  }

  function createSourceRow(source) {
    const row = document.createElement('div');
    row.className = 'okdesk-tl-row';
    row.dataset.kind = source.kind;

    const info = document.createElement('div');
    info.className = 'okdesk-tl-row-info';

    const kind = document.createElement('span');
    kind.className = 'okdesk-tl-row-kind';
    kind.textContent = source.kind === 'equipment' ? 'Оборудование'
      : (source.kind === 'object' ? 'Объект' : (source.kind === 'client' ? 'Клиент' : 'Заявка'));

    const name = document.createElement('span');
    name.className = 'okdesk-tl-row-name';
    name.textContent = source.name || 'Без названия';
    name.title = source.url || '';

    info.appendChild(kind);
    info.appendChild(name);

    if (source.error) {
      const error = document.createElement('span');
      error.className = 'okdesk-tl-row-error';
      error.textContent = source.error;
      error.title = source.url ? `${source.error}\n${source.url}` : source.error;
      info.appendChild(error);
    } else if (!hasAnyAccess(source)) {
      const empty = document.createElement('span');
      empty.className = 'okdesk-tl-row-empty';
      empty.textContent = 'Доступы не заполнены';
      info.appendChild(empty);
    }

    if (source.url) {
      const cardLink = document.createElement('a');
      cardLink.className = 'okdesk-tl-row-card-link';
      cardLink.href = source.url;
      cardLink.target = '_blank';
      cardLink.rel = 'noopener';
      cardLink.textContent = 'открыть карточку';
      cardLink.title = source.url;
      cardLink.addEventListener('click', function (event) {
        event.stopPropagation();
      });
      info.appendChild(cardLink);
    }

    const tools = document.createElement('div');
    tools.className = 'okdesk-tl-tools';

    for (const tool of TICKET_TOOLS) {
      tools.appendChild(createToolButton(tool, source));
    }

    row.appendChild(info);
    row.appendChild(tools);
    return row;
  }

  function isVisibleSource(source) {
    return source.kind === 'equipment' || hasAnyAccess(source);
  }

  function renderSources(sources) {
    if (!issueState.body) {
      return;
    }

    issueState.body.textContent = '';
    const rows = sources.filter(isVisibleSource);

    if (!rows.length) {
      renderError('Доступы не найдены. Проверьте, что в карточке оборудования заполнены AnyDesk, RustDesk, Ассистент, iikoWeb, Адрес сервера и Iiko логин/пароль.');
      return;
    }

    for (const source of rows) {
      issueState.body.appendChild(createSourceRow(source));
    }

    const failed = sources.filter(function (source) { return source.error; });
    if (failed.length) {
      const warning = document.createElement('div');
      warning.className = 'okdesk-tl-message okdesk-tl-warning';
      warning.textContent = `Не удалось прочитать карточки: ${failed.length}. Подробности — в подсказке у строки.`;
      issueState.body.appendChild(warning);
    }
  }

  function ensurePanel(context) {
    issueState.context = context;
    if (issueState.panel) {
      mountPanel(issueState.panel, context);
      return;
    }

    const created = createPanel(context);
    issueState.panel = created.panel;
    issueState.body = created.body;
    issueState.contextElement = created.contextElement;
    mountPanel(issueState.panel, context);
  }

  async function refreshIssuePanel(force) {
    if (!isIssuePage()) {
      return;
    }

    const context = extractIssueContext();
    if (!context.id && !context.fields.equipment.links.length) {
      return;
    }

    issueState.context = context;
    ensurePanel(context);

    const local = parseParameterDocument(document);
    const localRawAccess = buildAccessFromParameters(local.params, local.labels);
    const signature = JSON.stringify({
      localRawAccess,
      client: context.fields.client.links.map(function (link) { return link.url; }),
      object: context.fields.object.links.map(function (link) { return link.url; }),
      equipment: context.fields.equipment.links.map(function (link) { return link.url; })
    });

    const key = context.id || window.location.pathname;
    const sameContext = issueState.key === key && issueState.signature === signature;
    if (!force && sameContext) {
      return;
    }

    window.clearTimeout(emptyRetryTimer);
    if (force || issueState.key !== key) {
      entityCache = new Map();
    }
    if (!sameContext) {
      issueState.emptyRetries = 0;
    }

    issueState.key = key;
    issueState.signature = signature;
    const token = issueState.requestToken + 1;
    issueState.requestToken = token;
    renderLoading();

    try {
      const loadedSources = await loadIssueSources(context, local, localRawAccess);
      if (token !== issueState.requestToken) {
        return;
      }

      const sources = finalizeSources(loadedSources);
      issueState.sources = sources;
      if (!sources.some(isVisibleSource)
        && issueState.emptyRetries < EMPTY_RETRY_DELAYS_MS.length) {
        const delay = EMPTY_RETRY_DELAYS_MS[issueState.emptyRetries++];
        emptyRetryTimer = window.setTimeout(function () {
          if (token === issueState.requestToken) {
            refreshIssuePanel(true);
          }
        }, delay);
        return;
      }
      renderSources(sources);
    } catch (error) {
      if (token !== issueState.requestToken) {
        return;
      }

      renderError(`Ошибка чтения карточек: ${error && error.message ? error.message : error}`);
    }
  }

  function scheduleIssueScan() {
    if (issueScanTimer !== null) {
      return;
    }

    issueScanTimer = window.setTimeout(function () {
      issueScanTimer = null;
      refreshIssuePanel(false);
    }, 250);
  }

  function handlePossibleNavigation() {
    const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (currentUrl === lastIssueUrl) {
      return;
    }

    lastIssueUrl = currentUrl;
    removeIssuePanel();
    if (!isIssuePage()) {
      return;
    }

    scheduleIssueScan();
  }

  function removeIssuePanel() {
    window.clearTimeout(emptyRetryTimer);
    window.clearTimeout(issueScanTimer);
    issueScanTimer = null;
    entityCache = new Map();
    if (issueState.panel) {
      issueState.panel.remove();
    }

    issueState.requestToken += 1;
    issueState.context = null;
    issueState.panel = null;
    issueState.body = null;
    issueState.key = '';
    issueState.signature = '';
    issueState.sources = [];
    issueState.emptyRetries = 0;
  }

  // ---------------------------------------------------------------------------
  // Запуск и наблюдатели
  // ---------------------------------------------------------------------------
  scanAccessParameters();

  const observer = new MutationObserver(function (mutations) {
    handlePossibleNavigation();

    let hasRelevantChanges = false;
    for (const mutation of mutations) {
      if (issueState.panel && issueState.panel.contains(mutation.target)) {
        continue;
      }
      if (mutation.type === 'attributes' || mutation.type === 'characterData'
        || (mutation.type === 'childList' && (mutation.addedNodes.length || mutation.removedNodes.length))) {
        hasRelevantChanges = true;
        break;
      }
    }

    if (hasRelevantChanges) {
      scheduleScanAccessParameters();
      if (isIssuePage()) {
        scheduleIssueScan();
      }
    }
  });

  observer.observe(document.documentElement, {
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['href', 'data-url', 'data-href', 'data-path', 'data-equipment-id', 'data-company-id',
      'data-object-id', 'onclick', 'data-role', 'data-category', 'data-position', 'data-parameter-code', 'data-code', 'data-value'],
    subtree: true
  });

  window.addEventListener('popstate', handlePossibleNavigation);
  window.addEventListener('hashchange', handlePossibleNavigation);
  document.addEventListener('turbo:load', handlePossibleNavigation);
  document.addEventListener('pjax:end', handlePossibleNavigation);

  lastIssueUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (isIssuePage()) {
    scheduleIssueScan();
  }

  window.setInterval(handlePossibleNavigation, 1500);
}());
